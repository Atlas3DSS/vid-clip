# Vid Clip

A small Electron app for choosing a local video, selecting a start/end range, and exporting the trimmed result as MP4.

It can also download a video URL with `yt-dlp` and split the loaded video into 15 second MP4 clips. Split clips are saved beside the source video in a folder named like `source-15s-clips`.

## Requirements

- Node.js
- FFmpeg installed and discoverable through `PATH`, `FFMPEG_PATH`, WinGet, Chocolatey, Scoop, or next to the app executable
- yt-dlp available as `yt-dlp` or `python -m yt_dlp`

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
