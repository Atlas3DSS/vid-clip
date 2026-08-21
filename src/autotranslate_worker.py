#!/usr/bin/env python3
"""Run the local Qwen speech translation phases for Vid Clip."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib import error as urlerror
from urllib import request as urlrequest


EVENT_PREFIX = "VIDCLIP_EVENT "
ASR_REPO_ID = "Qwen/Qwen3-ASR-1.7B"
TTS_REPO_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
TRANSLATOR_MODEL_ID = "Qwen/Qwen3.5-9B-Q8_0"
TRANSLATOR_MODEL = Path(
    os.environ.get(
        "VID_CLIP_TRANSLATOR_MODEL",
        "/home/orwel/dev_genius/models/gguf/"
        "Qwen3.5-9B-c2022362-exact/Qwen3.5-9B-Q8_0.gguf",
    )
)
FALLBACK_TRANSLATOR_MODEL_ID = "Qwen/Qwen3.8-27B-Q4_K_M"
FALLBACK_TRANSLATOR_MODEL = Path(
    os.environ.get(
        "VID_CLIP_TRANSLATOR_FALLBACK_MODEL",
        "/home/orwel/dev_genius/models/gguf/"
        "Qwen3.8-27B-Q4_K_M-0669b986/Qwen3.8-27B-Q4_K_M.gguf",
    )
)
TRANSLATOR_SERVER = Path(
    os.environ.get(
        "VID_CLIP_TRANSLATOR_SERVER",
        "/home/orwel/dev_genius/engines/llama.cpp-b10299/"
        "build-cuda-4090-r1/bin/llama-server",
    )
)
TRANSLATOR_LIBRARY_PATH = os.environ.get(
    "VID_CLIP_TRANSLATOR_LIBRARY_PATH",
    "/home/orwel/dev_genius/experiments/Llama.cpp/.build-venv/"
    "lib/python3.12/site-packages/nvidia/cu13/lib",
)
SAMPLE_RATE = 24_000
ASR_BATCH_SIZE = 3
TRANSLATION_BATCH_SIZE = 1
TRANSLATION_PIPELINE_VERSION = 2
TRANSLATION_REVIEW_VERSION = 1
TTS_BATCH_SIZE = max(1, min(int(os.environ.get("VID_CLIP_TTS_BATCH_SIZE", "4")), 4))
MIN_TIMING_SPEED = 0.65
MAX_TIMING_SPEED = 1.75


def emit(status: str, ratio: float, **details: Any) -> None:
    event = {"ratio": max(0.0, min(float(ratio), 1.0)), "status": status, **details}
    print(f"{EVENT_PREFIX}{json.dumps(event, ensure_ascii=False)}", flush=True)


def run(command: list[str], *, allow_failure: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, check=False, capture_output=True, text=True)
    if result.returncode != 0 and not allow_failure:
        detail = "\n".join((result.stderr or result.stdout).strip().splitlines()[-16:])
        raise RuntimeError(
            f"{command[0]} failed with exit code {result.returncode}."
            + (f"\n{detail}" if detail else "")
        )
    return result


def read_request(request_path: Path) -> dict[str, Any]:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    for key in ("input_path", "output_dir", "target_language", "chunk_seconds"):
        if key not in request:
            raise ValueError(f"AutoTranslate request is missing `{key}`.")
    return request


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_text(f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n", encoding="utf-8")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def cached_snapshot(repo_id: str) -> Path:
    repository = Path.home() / ".cache" / "huggingface" / "hub" / (
        "models--" + repo_id.replace("/", "--")
    )
    main_ref = repository / "refs" / "main"
    if main_ref.is_file():
        referenced = repository / "snapshots" / main_ref.read_text(encoding="utf-8").strip()
        if referenced.is_dir():
            return referenced

    snapshots = sorted(
        (path for path in (repository / "snapshots").glob("*") if path.is_dir()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    if not snapshots:
        raise FileNotFoundError(
            f"{repo_id} is not cached. Download the model with `hf download {repo_id}`."
        )
    return snapshots[0]


def media_duration(path: Path) -> float:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    duration = float(result.stdout.strip())
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError(f"Could not read audio duration from {path}.")
    return duration


def prepare_source_audio(input_path: Path, output_dir: Path) -> Path:
    source_audio = output_dir / "source-audio-24khz.wav"
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(source_audio),
        ]
    )
    return source_audio


def detect_pauses(audio_path: Path) -> list[tuple[float, float]]:
    result = run(
        [
            "ffmpeg",
            "-hide_banner",
            "-i",
            str(audio_path),
            "-af",
            "silencedetect=noise=-38dB:d=0.28",
            "-f",
            "null",
            "-",
        ],
        allow_failure=True,
    )
    pauses: list[tuple[float, float]] = []
    silence_start: float | None = None
    for line in result.stderr.splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match:
            silence_start = float(start_match.group(1))
            continue

        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end_match and silence_start is not None:
            silence_end = float(end_match.group(1))
            if silence_end > silence_start:
                pauses.append((silence_start, silence_end))
            silence_start = None
    return pauses


def choose_chunk_ranges(
    duration: float, chunk_seconds: float, pauses: list[tuple[float, float]]
) -> list[tuple[float, float]]:
    ranges: list[tuple[float, float]] = []
    start = 0.0
    minimum = max(5.0, chunk_seconds * 0.65)
    maximum = min(36.0, chunk_seconds * 1.4)

    while duration - start > 0.05:
        remaining = duration - start
        if remaining <= maximum:
            end = duration
        else:
            desired = start + chunk_seconds
            lower = start + minimum
            upper = min(start + maximum, duration)
            candidates = [
                (pause_start + pause_end) / 2
                for pause_start, pause_end in pauses
                if lower <= (pause_start + pause_end) / 2 <= upper
            ]
            end = min(candidates, key=lambda value: abs(value - desired)) if candidates else desired

        end = min(max(end, start + 0.05), duration)
        ranges.append((start, end))
        start = end
    return ranges


def extract_chunks(
    source_audio: Path, output_dir: Path, ranges: list[tuple[float, float]]
) -> list[dict[str, Any]]:
    chunks_dir = output_dir / "source-chunks"
    chunks_dir.mkdir(parents=True, exist_ok=True)
    digits = max(3, len(str(len(ranges))))
    chunks: list[dict[str, Any]] = []

    for index, (start, end) in enumerate(ranges, start=1):
        chunk_path = chunks_dir / f"source-{index:0{digits}d}.wav"
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                f"{start:.3f}",
                "-i",
                str(source_audio),
                "-t",
                f"{end - start:.3f}",
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-c:a",
                "pcm_s16le",
                str(chunk_path),
            ]
        )
        chunks.append(
            {
                "duration": round(end - start, 3),
                "end": round(end, 3),
                "index": index,
                "source_audio": str(chunk_path.relative_to(output_dir)),
                "source_language": "",
                "source_text": "",
                "start": round(start, 3),
                "translated_text": "",
            }
        )
        emit(
            f"Creating pause-aware audio chunks ({index}/{len(ranges)})",
            0.03 + 0.09 * index / len(ranges),
            chunkCount=len(ranges),
            currentChunk=index,
        )
    return chunks


def srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},{millis:03d}"


def write_srt(path: Path, chunks: list[dict[str, Any]], text_key: str) -> None:
    blocks = []
    for chunk in chunks:
        text = str(chunk.get(text_key, "")).strip()
        if not text:
            continue
        blocks.append(
            "\n".join(
                [
                    str(len(blocks) + 1),
                    f"{srt_timestamp(chunk['start'])} --> {srt_timestamp(chunk['end'])}",
                    text,
                ]
            )
        )
    path.write_text("\n\n".join(blocks) + ("\n" if blocks else ""), encoding="utf-8")


def transcribe(request: dict[str, Any]) -> None:
    import torch
    from qwen_asr import Qwen3ASRModel

    input_path = Path(request["input_path"])
    output_dir = Path(request["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    if not input_path.is_file():
        raise FileNotFoundError(f"Input media does not exist: {input_path}")

    emit("Extracting 24 kHz source audio", 0.01)
    source_audio = prepare_source_audio(input_path, output_dir)
    duration = media_duration(source_audio)
    pauses = detect_pauses(source_audio)
    ranges = choose_chunk_ranges(duration, float(request["chunk_seconds"]), pauses)
    chunks = extract_chunks(source_audio, output_dir, ranges)

    manifest = {
        "asr_model": ASR_REPO_ID,
        "chunk_seconds": request["chunk_seconds"],
        "chunks": chunks,
        "duration": round(duration, 3),
        "source_audio_file": source_audio.name,
        "target_language": request["target_language"],
        "translator_model": TRANSLATOR_MODEL_ID,
        "tts_model": TTS_REPO_ID,
    }
    transcript_path = output_dir / "autotranslate-transcript.json"
    write_json(transcript_path, manifest)

    emit("Loading Qwen3-ASR on the GPU", 0.13)
    model = Qwen3ASRModel.from_pretrained(
        str(cached_snapshot(ASR_REPO_ID)),
        dtype=torch.bfloat16,
        device_map="cuda:0",
        max_inference_batch_size=ASR_BATCH_SIZE,
        max_new_tokens=1024,
    )

    for batch_start in range(0, len(chunks), ASR_BATCH_SIZE):
        batch = chunks[batch_start : batch_start + ASR_BATCH_SIZE]
        paths = [str(output_dir / chunk["source_audio"]) for chunk in batch]
        source_results = model.transcribe(audio=paths, language=None)
        completed = batch_start + len(batch)
        emit(
            f"Transcribing source speech ({completed}/{len(chunks)})",
            0.15 + 0.19 * completed / len(chunks),
            chunkCount=len(chunks),
            currentChunk=completed,
        )
        for chunk, source_result in zip(batch, source_results):
            chunk["source_language"] = str(source_result.language or "")
            chunk["source_text"] = str(source_result.text or "").strip()
        write_json(transcript_path, manifest)

    write_srt(output_dir / "source.srt", chunks, "source_text")
    write_json(transcript_path, manifest)
    emit("Source transcription complete", 0.35)


def find_available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def http_json(url: str, payload: dict[str, Any] | None, timeout: float) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urlrequest.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="GET" if payload is None else "POST",
    )
    try:
        with urlrequest.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except (urlerror.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Qwen translator request failed: {error}") from error


def start_translator(
    output_dir: Path,
    *,
    model_path: Path = TRANSLATOR_MODEL,
    alias: str = "vid-clip-qwen-translator",
    log_name: str = "qwen-translator.log",
    context_size: int = 8192,
    batch_size: int = 2048,
    micro_batch_size: int = 512,
    fit: str = "off",
) -> tuple[subprocess.Popen[bytes], str, Any]:
    if not TRANSLATOR_SERVER.is_file() or not os.access(TRANSLATOR_SERVER, os.X_OK):
        raise FileNotFoundError(f"Qwen translator server is missing: {TRANSLATOR_SERVER}")
    if not model_path.is_file():
        raise FileNotFoundError(f"Qwen translator model is missing: {model_path}")

    port = find_available_port()
    base_url = f"http://127.0.0.1:{port}"
    server_log = (output_dir / log_name).open("wb")
    environment = os.environ.copy()
    environment["LD_LIBRARY_PATH"] = TRANSLATOR_LIBRARY_PATH
    command = [
        str(TRANSLATOR_SERVER),
        "-m",
        str(model_path),
        "--alias",
        alias,
        "-fa",
        "on",
        "-c",
        str(context_size),
        "-np",
        "1",
        "-b",
        str(batch_size),
        "-ub",
        str(micro_batch_size),
        "-ctk",
        "q8_0",
        "-ctv",
        "q8_0",
        "--threads",
        "8",
        "--threads-batch",
        "8",
        "--no-webui",
        "--reasoning-format",
        "none",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "-ngl",
        "999",
        "-fit",
        fit,
    ]
    server = subprocess.Popen(
        command,
        stdin=subprocess.DEVNULL,
        stdout=server_log,
        stderr=subprocess.STDOUT,
        env=environment,
        start_new_session=True,
    )
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        if server.poll() is not None:
            server_log.close()
            raise RuntimeError(f"Qwen translator exited while loading. See {log_name}.")
        try:
            health = http_json(f"{base_url}/health", None, 3)
            if str(health.get("status", "")).lower() in {"ok", "no slot available"}:
                return server, base_url, server_log
        except RuntimeError:
            pass
        time.sleep(1)

    server.terminate()
    server_log.close()
    raise RuntimeError("Qwen translator did not become ready within five minutes.")


def stop_translator(server: subprocess.Popen[bytes], server_log: Any) -> None:
    if server.poll() is None:
        server.terminate()
        try:
            server.wait(timeout=20)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=10)
    server_log.close()


def parse_translation_response(content: str, expected_count: int) -> list[str]:
    cleaned = content.strip()
    cleaned = re.sub(r"^<think>[\s\S]*?</think>\s*", "", cleaned, flags=re.IGNORECASE)
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"Qwen translator returned invalid JSON: {cleaned[:500]!r}"
        ) from error
    translations = payload.get("translations")
    if not isinstance(translations, list) or len(translations) != expected_count:
        raise RuntimeError("Qwen translator returned the wrong number of segments.")
    if not all(isinstance(item, str) for item in translations):
        raise RuntimeError("Qwen translator returned a non-text segment.")
    return [item.strip() for item in translations]


def translate_batch(base_url: str, batch: list[dict[str, Any]], target_language: str) -> list[str]:
    segments = [
        {
            "index": chunk["index"],
            "source_language": chunk["source_language"],
            "text": chunk["source_text"],
        }
        for chunk in batch
    ]
    response = http_json(
        f"{base_url}/v1/chat/completions",
        {
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a precise audiovisual translator. Translate every segment into "
                        f"{target_language}. Preserve names, acronyms, numbers, tone, and factual "
                        "meaning. Correct obvious ASR homophone errors from context without adding "
                        "facts. Keep each translation natural for spoken narration. Return only "
                        "a JSON object with one `translations` array. The array must contain exactly "
                        "one string per input segment in the original order. When the target is "
                        "English, translate every Chinese expression and emit no CJK characters."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {"target_language": target_language, "segments": segments},
                        ensure_ascii=False,
                    ),
                },
            ],
            "temperature": 0,
            "top_k": 1,
            "max_tokens": 2048,
            "stream": False,
            "chat_template_kwargs": {
                "enable_thinking": False,
                "preserve_thinking": False,
            },
            "reasoning_format": "none",
            "response_format": {"type": "json_object"},
        },
        300,
    )
    message = response["choices"][0]["message"]
    content = str(
        message.get("content")
        or message.get("reasoning_content")
        or message.get("reasoning")
        or ""
    )
    if not content.strip():
        raise RuntimeError(
            "Qwen translator returned no text. Response keys: "
            + ", ".join(sorted(str(key) for key in message))
        )
    return parse_translation_response(content, len(batch))


def translate_batch_resilient(
    base_url: str, batch: list[dict[str, Any]], target_language: str
) -> list[str]:
    try:
        return translate_batch(base_url, batch, target_language)
    except (RuntimeError, json.JSONDecodeError):
        if len(batch) == 1:
            raise
        midpoint = len(batch) // 2
        return translate_batch_resilient(
            base_url, batch[:midpoint], target_language
        ) + translate_batch_resilient(base_url, batch[midpoint:], target_language)


def review_translation_batch(
    base_url: str, batch: list[dict[str, Any]], target_language: str
) -> list[str | None]:
    pairs = [
        {
            "index": chunk["index"],
            "source_language": chunk["source_language"],
            "source_text": chunk["source_text"],
            "current_translation": chunk["translated_text"],
        }
        for chunk in batch
    ]
    response = http_json(
        f"{base_url}/v1/chat/completions",
        {
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are the final alignment reviewer for audiovisual translation. "
                        f"Review each source and {target_language} pair independently. A segment "
                        "may start or end with a sentence fragment. Mark it invalid only when the "
                        "translation omits substantial source meaning, adds meaning from a neighbor, "
                        "uses the wrong source segment, or contains untranslated source script. "
                        "For every invalid pair, provide a complete faithful replacement for that "
                        "source segment only. Return only a JSON object with one `reviews` array in "
                        "input order. Each item must contain `index`, boolean `valid`, and string "
                        "`translation`. Use an empty translation when valid."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {"target_language": target_language, "pairs": pairs},
                        ensure_ascii=False,
                    ),
                },
            ],
            "temperature": 0,
            "top_k": 1,
            "max_tokens": 2048,
            "stream": False,
            "chat_template_kwargs": {
                "enable_thinking": False,
                "preserve_thinking": False,
            },
            "reasoning_format": "none",
            "response_format": {"type": "json_object"},
        },
        300,
    )
    message = response["choices"][0]["message"]
    content = str(
        message.get("content")
        or message.get("reasoning_content")
        or message.get("reasoning")
        or ""
    ).strip()
    content = re.sub(r"^<think>[\s\S]*?</think>\s*", "", content, flags=re.IGNORECASE)
    if content.startswith("```"):
        content = re.sub(
            r"^```(?:json)?\s*|\s*```$", "", content, flags=re.IGNORECASE
        )
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            f"Qwen alignment reviewer returned invalid JSON: {content[:500]!r}"
        ) from error
    reviews = payload.get("reviews")
    if not isinstance(reviews, list) or len(reviews) != len(batch):
        raise RuntimeError("Qwen alignment reviewer returned the wrong number of segments.")
    corrections: list[str | None] = []
    for expected_chunk, review in zip(batch, reviews):
        if not isinstance(review, dict) or not isinstance(review.get("valid"), bool):
            raise RuntimeError("Qwen alignment reviewer returned an invalid decision.")
        if int(review.get("index", -1)) != int(expected_chunk["index"]):
            raise RuntimeError("Qwen alignment reviewer returned an incorrect segment index.")
        replacement = str(review.get("translation", "")).strip()
        if review["valid"]:
            corrections.append(None)
        elif replacement:
            corrections.append(replacement)
        else:
            raise RuntimeError("Qwen alignment reviewer omitted a required replacement.")
    return corrections


def review_translation_batch_resilient(
    base_url: str, batch: list[dict[str, Any]], target_language: str
) -> list[str | None]:
    try:
        return review_translation_batch(base_url, batch, target_language)
    except (RuntimeError, json.JSONDecodeError):
        if len(batch) == 1:
            raise
        midpoint = len(batch) // 2
        return review_translation_batch_resilient(
            base_url, batch[:midpoint], target_language
        ) + review_translation_batch_resilient(
            base_url, batch[midpoint:], target_language
        )


def translate(request: dict[str, Any]) -> None:
    output_dir = Path(request["output_dir"])
    transcript_path = output_dir / "autotranslate-transcript.json"
    if not transcript_path.is_file():
        raise FileNotFoundError("Run the AutoTranslate transcription phase first.")
    manifest = json.loads(transcript_path.read_text(encoding="utf-8"))
    manifest["translator_model"] = TRANSLATOR_MODEL_ID
    chunks = manifest["chunks"]
    target_language = str(manifest["target_language"])

    def invalidate_audio(chunk: dict[str, Any]) -> None:
        chunk.pop("translated_audio", None)
        chunk.pop("timing_speed", None)

    def set_translation(chunk: dict[str, Any], translated_text: str) -> None:
        value = translated_text.strip()
        if value != str(chunk.get("translated_text", "")).strip():
            invalidate_audio(chunk)
        chunk["translated_text"] = value

    if manifest.get("translation_pipeline_version") != TRANSLATION_PIPELINE_VERSION:
        for chunk in chunks:
            if (
                str(chunk.get("source_text", "")).strip()
                and str(chunk.get("source_language", "")).strip().lower()
                != target_language.lower()
            ):
                set_translation(chunk, "")
        manifest["translation_pipeline_version"] = TRANSLATION_PIPELINE_VERSION

    review_needed = (
        manifest.get("translation_review_version") != TRANSLATION_REVIEW_VERSION
    )

    def needs_translation(chunk: dict[str, Any]) -> bool:
        translated_text = str(chunk.get("translated_text", "")).strip()
        contains_cjk = bool(re.search(r"[\u3400-\u9fff]", translated_text))
        wrong_script = target_language.lower() == "english" and contains_cjk
        return not translated_text or wrong_script

    pending = [
        chunk
        for chunk in chunks
        if str(chunk.get("source_text", "")).strip()
        and str(chunk.get("source_language", "")).strip().lower() != target_language.lower()
        and needs_translation(chunk)
    ]
    for chunk in chunks:
        if not str(chunk.get("source_text", "")).strip():
            set_translation(chunk, "")
        elif str(chunk.get("source_language", "")).strip().lower() == target_language.lower():
            set_translation(chunk, str(chunk["source_text"]))

    if not pending and not review_needed:
        write_srt(
            output_dir / f"translated-{target_language.lower()}.srt",
            chunks,
            "translated_text",
        )
        write_json(transcript_path, manifest)
        emit("Translation validation complete", 0.55)
        return

    fallback_pending: list[dict[str, Any]] = []
    if pending:
        emit("Loading Qwen3.5 text translator on the GPU", 0.36)
        server, base_url, server_log = start_translator(output_dir)
        try:
            for batch_start in range(0, len(pending), TRANSLATION_BATCH_SIZE):
                batch = pending[batch_start : batch_start + TRANSLATION_BATCH_SIZE]
                translations = translate_batch_resilient(
                    base_url, batch, target_language
                )
                if target_language.lower() == "english":
                    for index, translated_text in enumerate(translations):
                        if re.search(r"[\u3400-\u9fff]", translated_text):
                            translations[index] = ""
                            fallback_pending.append(batch[index])
                for chunk, translated_text in zip(batch, translations):
                    if translated_text:
                        set_translation(chunk, translated_text)
                completed = batch_start + len(batch)
                write_json(transcript_path, manifest)
                emit(
                    f"Translating transcript to {target_language} ({completed}/{len(pending)})",
                    0.38 + 0.1 * completed / len(pending),
                    chunkCount=len(pending),
                    currentChunk=completed,
                )
        finally:
            stop_translator(server, server_log)

    if fallback_pending or review_needed:
        manifest["translator_fallback_model"] = FALLBACK_TRANSLATOR_MODEL_ID
        emit(
            "Loading local Qwen 27B alignment reviewer",
            0.49,
        )
        fallback_server, fallback_url, fallback_log = start_translator(
            output_dir,
            model_path=FALLBACK_TRANSLATOR_MODEL,
            alias="vid-clip-qwen-fallback",
            log_name="qwen-translator-fallback.log",
            context_size=4096,
            batch_size=1024,
            micro_batch_size=256,
            fit="on",
        )
        try:
            for batch_start in range(0, len(fallback_pending), 2):
                batch = fallback_pending[batch_start : batch_start + 2]
                translations = translate_batch_resilient(
                    fallback_url, batch, target_language
                )
                for index, translated_text in enumerate(translations):
                    if target_language.lower() == "english" and re.search(
                        r"[\u3400-\u9fff]", translated_text
                    ):
                        translated_text = translate_batch_resilient(
                            fallback_url, [batch[index]], target_language
                        )[0]
                    if target_language.lower() == "english" and re.search(
                        r"[\u3400-\u9fff]", translated_text
                    ):
                        raise RuntimeError(
                            "Local Qwen 27B could not remove source script from "
                            f"segment {batch[index]['index']}. Review the local transcript."
                        )
                    set_translation(batch[index], translated_text)
                write_json(transcript_path, manifest)

            if review_needed:
                review_candidates = [
                    chunk
                    for chunk in chunks
                    if str(chunk.get("source_text", "")).strip()
                    and str(chunk.get("source_language", "")).strip().lower()
                    != target_language.lower()
                ]
                for batch_start in range(0, len(review_candidates), 4):
                    batch = review_candidates[batch_start : batch_start + 4]
                    corrections = review_translation_batch_resilient(
                        fallback_url, batch, target_language
                    )
                    for chunk, correction in zip(batch, corrections):
                        if correction is not None:
                            if target_language.lower() == "english" and re.search(
                                r"[\u3400-\u9fff]", correction
                            ):
                                correction = translate_batch_resilient(
                                    fallback_url, [chunk], target_language
                                )[0]
                            if target_language.lower() == "english" and re.search(
                                r"[\u3400-\u9fff]", correction
                            ):
                                raise RuntimeError(
                                    "Local Qwen 27B left source script in reviewed segment "
                                    f"{chunk['index']}."
                                )
                            set_translation(chunk, correction)
                    completed = batch_start + len(batch)
                    write_json(transcript_path, manifest)
                    emit(
                        f"Reviewing transcript alignment ({completed}/{len(review_candidates)})",
                        0.49 + 0.06 * completed / max(1, len(review_candidates)),
                        chunkCount=len(review_candidates),
                        currentChunk=completed,
                    )
                manifest["translation_review_version"] = TRANSLATION_REVIEW_VERSION
        finally:
            stop_translator(fallback_server, fallback_log)

    write_srt(
        output_dir / f"translated-{target_language.lower()}.srt",
        chunks,
        "translated_text",
    )
    write_json(transcript_path, manifest)
    emit("Text translation complete", 0.55)


def atempo_filter(speed: float, target_duration: float) -> str:
    factors: list[float] = []
    remaining = max(speed, 0.01)
    while remaining > 2.0:
        factors.append(2.0)
        remaining /= 2.0
    while remaining < 0.5:
        factors.append(0.5)
        remaining /= 0.5
    factors.append(remaining)
    filters = [f"atempo={factor:.8f}" for factor in factors]
    filters.extend(["apad", f"atrim=0:{target_duration:.3f}"])
    return ",".join(filters)


def make_silence(path: Path, duration: float) -> None:
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"anullsrc=r={SAMPLE_RATE}:cl=mono",
            "-t",
            f"{duration:.3f}",
            "-c:a",
            "pcm_s16le",
            str(path),
        ]
    )


def fit_audio_to_duration(input_path: Path, output_path: Path, duration: float) -> float:
    generated_duration = media_duration(input_path)
    speed = generated_duration / duration
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(input_path),
            "-af",
            atempo_filter(speed, duration),
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(output_path),
        ]
    )
    return speed


def concat_audio(chunk_paths: list[Path], output_path: Path) -> None:
    concat_path = output_path.parent / "translated-chunks.txt"
    concat_path.write_text(
        "\n".join(
            f"file '{path.as_posix().replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'"
            for path in chunk_paths
        )
        + "\n",
        encoding="utf-8",
    )
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
            "-c",
            "copy",
            str(output_path),
        ]
    )


def has_stream(path: Path, stream_selector: str) -> bool:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            stream_selector,
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            str(path),
        ],
        allow_failure=True,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def stream_count(path: Path, stream_selector: str) -> int:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            stream_selector,
            "-show_entries",
            "stream=index",
            "-of",
            "csv=p=0",
            str(path),
        ]
    )
    return len([line for line in result.stdout.splitlines() if line.strip()])


def mux_translated_video(
    source_video: Path,
    translated_audio: Path,
    output_path: Path,
    target_language: str,
    source_language: str,
) -> None:
    language_codes = {
        "chinese": "zho",
        "english": "eng",
        "french": "fra",
        "german": "deu",
        "italian": "ita",
        "japanese": "jpn",
        "korean": "kor",
        "portuguese": "por",
        "russian": "rus",
        "spanish": "spa",
    }
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(source_video),
        "-i",
        str(translated_audio),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
    ]
    source_has_audio = has_stream(source_video, "a:0")
    if source_has_audio:
        command.extend(["-map", "0:a:0"])
    command.extend(
        [
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-metadata:s:a:0",
            f"language={language_codes.get(target_language.lower(), 'und')}",
            "-metadata:s:a:0",
            f"title={target_language} (AutoTranslate)",
            "-metadata:s:a:0",
            f"handler_name={target_language} (AutoTranslate)",
            "-disposition:a:0",
            "default",
        ]
    )
    if source_has_audio:
        command.extend(
            [
                "-metadata:s:a:1",
                f"language={language_codes.get(source_language.lower(), 'und')}",
                "-metadata:s:a:1",
                f"title={source_language} (Original)",
                "-metadata:s:a:1",
                f"handler_name={source_language} (Original)",
                "-disposition:a:1",
                "0",
            ]
        )
    command.extend(["-movflags", "+faststart", str(output_path)])
    run(command)


def synthesize(request: dict[str, Any]) -> None:
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel

    output_dir = Path(request["output_dir"])
    transcript_path = output_dir / "autotranslate-transcript.json"
    if not transcript_path.is_file():
        raise FileNotFoundError("Run the AutoTranslate transcription phase first.")
    manifest = json.loads(transcript_path.read_text(encoding="utf-8"))
    chunks = manifest["chunks"]
    target_language = str(manifest["target_language"])
    translated_dir = output_dir / "translated-chunks"
    translated_dir.mkdir(parents=True, exist_ok=True)

    emit("Loading Qwen3-TTS voice cloning on the GPU", 0.56)
    model = Qwen3TTSModel.from_pretrained(
        str(cached_snapshot(TTS_REPO_ID)),
        device_map="cuda:0",
        dtype=torch.bfloat16,
    )

    digits = max(3, len(str(len(chunks))))
    translated_paths = [
        translated_dir / f"translated-{index:0{digits}d}.wav"
        for index in range(1, len(chunks) + 1)
    ]
    pending: list[tuple[int, dict[str, Any]]] = []
    retry_counts: dict[int, int] = {}
    completed = 0
    for index, chunk in enumerate(chunks):
        relative_output = str(translated_paths[index].relative_to(output_dir))
        if (
            translated_paths[index].is_file()
            and chunk.get("translated_audio") == relative_output
            and MIN_TIMING_SPEED
            <= float(chunk.get("timing_speed", 0))
            <= MAX_TIMING_SPEED
        ):
            completed += 1
            continue
        if str(chunk.get("translated_text", "")).strip():
            pending.append((index, chunk))
            continue
        make_silence(translated_paths[index], float(chunk["duration"]))
        chunk["timing_speed"] = 1.0
        chunk["translated_audio"] = relative_output
        completed += 1

    batch_start = 0
    batch_size = TTS_BATCH_SIZE
    while batch_start < len(pending):
        batch = pending[batch_start : batch_start + batch_size]
        max_source_duration = max(float(chunk["duration"]) for _, chunk in batch)
        max_new_tokens = min(
            512, max(128, math.ceil(max_source_duration * 14) + 48)
        )
        try:
            wavs, sample_rate = model.generate_voice_clone(
                text=[str(chunk["translated_text"]).strip() for _, chunk in batch],
                language=[target_language] * len(batch),
                ref_audio=[str(output_dir / chunk["source_audio"]) for _, chunk in batch],
                ref_text=[
                    str(chunk.get("source_text", "")).strip() or None
                    for _, chunk in batch
                ],
                x_vector_only_mode=[
                    not bool(str(chunk.get("source_text", "")).strip())
                    for _, chunk in batch
                ],
                non_streaming_mode=True,
                max_new_tokens=max_new_tokens,
            )
        except torch.OutOfMemoryError:
            if batch_size == 1:
                raise
            batch_size = max(1, batch_size // 2)
            torch.cuda.empty_cache()
            emit(
                f"GPU memory was full; retrying with batch size {batch_size}",
                0.58 + 0.38 * completed / len(chunks),
            )
            continue
        if len(wavs) != len(batch):
            raise RuntimeError(
                "Qwen3-TTS returned the wrong number of audio chunks. "
                "Restart AutoTranslate to resume from the last checkpoint."
            )
        for (index, chunk), wav in zip(batch, wavs):
            raw_path = translated_dir / f"raw-{index + 1:0{digits}d}.wav"
            sf.write(raw_path, wav, sample_rate)
            timing_speed = round(
                fit_audio_to_duration(
                    raw_path, translated_paths[index], float(chunk["duration"])
                ),
                5,
            )
            raw_path.unlink(missing_ok=True)
            if not MIN_TIMING_SPEED <= timing_speed <= MAX_TIMING_SPEED:
                translated_paths[index].unlink(missing_ok=True)
                if retry_counts.get(index, 0) == 0:
                    retry_counts[index] = 1
                    pending.append((index, chunk))
                    emit(
                        f"Regenerating chunk {index + 1} after timing validation",
                        0.58 + 0.38 * completed / len(chunks),
                    )
                    continue
                raise RuntimeError(
                    f"Chunk {index + 1} failed timing validation twice "
                    f"with speed factor {timing_speed:.3f}."
                )
            chunk["timing_speed"] = timing_speed
            chunk["translated_audio"] = str(translated_paths[index].relative_to(output_dir))
            completed += 1

        write_json(transcript_path, manifest)
        emit(
            f"Cloning source voices in {target_language} ({completed}/{len(chunks)})",
            0.58 + 0.38 * completed / len(chunks),
            chunkCount=len(chunks),
            currentChunk=completed,
        )
        batch_start += len(batch)

    language_slug = target_language.lower()
    wav_output = output_dir / f"translated-{language_slug}.wav"
    mp3_output = output_dir / f"translated-{language_slug}.mp3"
    emit("Joining translated audio chunks", 0.97)
    concat_audio(translated_paths, wav_output)
    expected_duration = float(manifest["duration"])
    actual_duration = media_duration(wav_output)
    if abs(actual_duration - expected_duration) > 0.25:
        raise RuntimeError(
            "Translated audio failed the duration check: "
            f"expected {expected_duration:.3f}s, got {actual_duration:.3f}s."
        )
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(wav_output),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            str(mp3_output),
        ]
    )

    source_media = Path(request.get("video_path") or request["input_path"])
    video_output: Path | None = None
    if source_media.is_file() and has_stream(source_media, "v:0"):
        source_languages = [
            str(chunk.get("source_language", "")).strip()
            for chunk in chunks
            if str(chunk.get("source_language", "")).strip()
        ]
        source_language = (
            max(set(source_languages), key=source_languages.count)
            if source_languages
            else "Unknown"
        )
        video_output = output_dir / f"translated-{language_slug}.mp4"
        emit(f"Adding {target_language} and original audio tracks to the video", 0.99)
        mux_translated_video(
            source_media,
            wav_output,
            video_output,
            target_language,
            source_language,
        )
        expected_audio_streams = 2 if has_stream(source_media, "a:0") else 1
        if stream_count(video_output, "v") != 1 or stream_count(
            video_output, "a"
        ) != expected_audio_streams:
            raise RuntimeError(
                "Translated video failed the stream check. "
                "The expected video and audio tracks were not present."
            )

    result = {
        "audio_output_sha256": file_sha256(mp3_output),
        "chunk_count": len(chunks),
        "duration": manifest["duration"],
        "audio_output_file": mp3_output.name,
        "output_file": video_output.name if video_output else mp3_output.name,
        "output_sha256": file_sha256(video_output if video_output else mp3_output),
        "source_audio_file": manifest["source_audio_file"],
        "subtitles_file": f"translated-{language_slug}.srt",
        "subtitles_sha256": file_sha256(
            output_dir / f"translated-{language_slug}.srt"
        ),
        "target_language": target_language,
        "transcript_file": transcript_path.name,
        "wav_output_file": wav_output.name,
        "video_output_file": video_output.name if video_output else None,
        "voice_mode": "Qwen3-TTS source voice clone",
    }
    write_json(output_dir / "autotranslate-result.json", result)
    write_json(transcript_path, manifest)
    emit(
        "AutoTranslate video complete" if video_output else "AutoTranslate audio complete",
        1.0,
        outputFile=result["output_file"],
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--phase", choices=("transcribe", "translate", "synthesize"), required=True
    )
    parser.add_argument("--request", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    request = read_request(args.request)
    if args.phase == "transcribe":
        transcribe(request)
    elif args.phase == "translate":
        translate(request)
    else:
        synthesize(request)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit(f"AutoTranslate failed: {error}", 0.0, error=str(error))
        raise
