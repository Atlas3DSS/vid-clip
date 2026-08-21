# Vid Clip

A small Electron app for choosing a local video, selecting a start/end range, and exporting the trimmed result as MP4.

It can download a video URL with `yt-dlp` and split the loaded video into 15-second MP4 clips. It can also translate speech with local Qwen models while preserving the source voice.

## Requirements

- Node.js
- FFmpeg installed and discoverable through `PATH`, `FFMPEG_PATH`, WinGet, Chocolatey, Scoop, or next to the app executable
- yt-dlp available as `yt-dlp` or `python -m yt_dlp`
- WSL with the isolated Qwen ASR and TTS environments described in the next section

Install or update `yt-dlp` on this machine with:

```powershell
python -m pip install --user -U yt-dlp
```

## Run

```powershell
npm install
npm start
```

## Verify Export

```powershell
npm run smoke
```

## GPU Encoding

The app defaults to `GPU Auto`. It probes FFmpeg hardware encoders at runtime, uses the first working H.264 GPU encoder, and falls back to CPU H.264 if no working GPU encoder is found.

## URL Downloads

Paste a video URL into the top bar and choose `Download URL`. Downloads are saved under your Videos folder in `Vid Clip Downloads`, then loaded automatically for trimming, splitting, or export.

## AutoTranslate

AutoTranslate accepts an opened video or a URL from the top bar. It performs these actions:

1. Download or extract a 24 kHz WAV source file.
2. Split speech into pause-aware chunks from 8 to 30 seconds.
3. Detect and transcribe the source language with `Qwen/Qwen3-ASR-1.7B`.
4. Translate each transcript chunk independently with local Qwen3.5-9B Q8.
5. Audit every source and translation pair with local Qwen3.8-27B Q4.
6. Clone each chunk's source voice with `Qwen/Qwen3-TTS-12Hz-1.7B-Base`.
7. Fit each generated chunk to its original time window and join the chunks.
8. Add the translated audio as the video's default track and retain the original track.

The output folder contains an MP4 with both audio tracks, standalone MP3 and WAV audio, source audio, source chunks, translated chunks, subtitles, and a JSON transcript. Audio-only input produces audio output without an MP4.

All runtime inference is local. AutoTranslate does not call Codex, a hosted LLM, or an external inference API. Each phase writes checkpoints. A restarted run resumes completed transcription, translation, and speech chunks.

Run the same pipeline without Electron when needed:

```bash
./scripts/autotranslate-local.sh input.mp4 output-directory English 20
```

This command uses the same worker, validation, checkpoints, local models, and adaptive TTS batching as the app.

The official ASR and TTS packages pin different `transformers` versions. Keep them in separate environments:

```bash
uv venv /home/orwel/dev_genius/vid_clip_ai/.venv --python 3.12
uv pip install --python /home/orwel/dev_genius/vid_clip_ai/.venv/bin/python qwen-asr

uv venv /home/orwel/dev_genius/vid_clip_ai/.tts-venv --python 3.12
uv pip install --python /home/orwel/dev_genius/vid_clip_ai/.tts-venv/bin/python qwen-tts
```

Set `VID_CLIP_ASR_PYTHON` or `VID_CLIP_TTS_PYTHON` before starting the app to use different WSL environments.

The text translation stage defaults to the local Qwen3.5-9B Q8 model and the CUDA llama.cpp server. It translates one source segment per request to prevent cross-segment drift. Local Qwen3.8-27B Q4 then reviews every pair and replaces mismatched or incomplete translations. Set `VID_CLIP_TRANSLATOR_MODEL`, `VID_CLIP_TRANSLATOR_FALLBACK_MODEL`, `VID_CLIP_TRANSLATOR_SERVER`, or `VID_CLIP_TRANSLATOR_LIBRARY_PATH` in WSL to use different local paths.
