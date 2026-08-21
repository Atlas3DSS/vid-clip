#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf '%s\n' \
    'Usage: autotranslate-local.sh INPUT_MEDIA OUTPUT_DIR [TARGET_LANGUAGE] [CHUNK_SECONDS]' \
    '' \
    'Runs Vid Clip AutoTranslate with local Qwen models only.' \
    'Rerun the same command to resume from saved checkpoints.'
}

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  usage
  exit 0
fi

if [[ $# -lt 2 || $# -gt 4 ]]; then
  usage >&2
  exit 2
fi

input_media="$(realpath "$1")"
output_dir="$(realpath -m "$2")"
target_language="${3:-English}"
chunk_seconds="${4:-20}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
worker_path="$(realpath "$script_dir/../src/autotranslate_worker.py")"
asr_python="${VID_CLIP_ASR_PYTHON:-/home/orwel/dev_genius/vid_clip_ai/.venv/bin/python}"
tts_python="${VID_CLIP_TTS_PYTHON:-/home/orwel/dev_genius/vid_clip_ai/.tts-venv/bin/python}"

if [[ ! -f "$input_media" ]]; then
  printf 'Input media does not exist: %s\n' "$input_media" >&2
  exit 2
fi
if [[ ! -x "$asr_python" || ! -x "$tts_python" ]]; then
  printf '%s\n' 'The local Qwen ASR or TTS Python environment is not executable.' >&2
  exit 2
fi

mkdir -p "$output_dir"
request_path="$output_dir/autotranslate-request.json"
"$asr_python" - "$input_media" "$output_dir" "$target_language" "$chunk_seconds" "$request_path" <<'PY'
import json
import sys
from pathlib import Path

input_media, output_dir, target_language, chunk_seconds, request_path = sys.argv[1:]
languages = {
    "Chinese", "English", "French", "German", "Italian", "Japanese",
    "Korean", "Portuguese", "Russian", "Spanish",
}
if target_language not in languages:
    raise SystemExit("Unsupported target language: " + target_language)
try:
    chunk_seconds_value = float(chunk_seconds)
except ValueError as error:
    raise SystemExit("Chunk seconds must be a number.") from error
if not 8 <= chunk_seconds_value <= 30:
    raise SystemExit("Chunk seconds must be from 8 through 30.")

request = {
    "chunk_seconds": chunk_seconds_value,
    "input_path": input_media,
    "output_dir": output_dir,
    "target_language": target_language,
}
Path(request_path).write_text(
    json.dumps(request, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY

"$asr_python" "$worker_path" --phase transcribe --request "$request_path"
"$asr_python" "$worker_path" --phase translate --request "$request_path"
"$tts_python" "$worker_path" --phase synthesize --request "$request_path"

printf 'AutoTranslate complete: %s\n' "$output_dir/autotranslate-result.json"
