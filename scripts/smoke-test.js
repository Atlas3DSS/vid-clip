const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_FFMPEG_PATH, exportClip, getEncodingCapabilities, resolveFfmpegPath, splitVideoIntoClips } = require('../src/clipper');
const { buildYtDlpArgs, extractHttpUrl, getYtDlpFailureMessage, parseYtDlpProgress, resolveYtDlpCommand } = require('../src/downloader');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-clip-'));
const inputPath = path.join(tmpDir, 'input.mp4');
const outputPath = path.join(tmpDir, 'output.mp4');
const gpuAutoOutputPath = path.join(tmpDir, 'output-gpu-auto.mp4');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

async function main() {
  const originalPath = process.env.PATH;
  const originalWindowsPath = process.env.Path;
  let resolvedFfmpegPath;

  try {
    process.env.PATH = '';
    process.env.Path = '';
    resolvedFfmpegPath = await resolveFfmpegPath(DEFAULT_FFMPEG_PATH);
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }

    if (originalWindowsPath === undefined) {
      delete process.env.Path;
    } else {
      process.env.Path = originalWindowsPath;
    }
  }

  run(resolvedFfmpegPath, [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=320x180:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=44100',
    '-t',
    '4',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    inputPath
  ]);

  await exportClip({
    inputPath,
    outputPath,
    startSeconds: 1,
    durationSeconds: 1.75,
    encodingMode: 'cpu',
    onProgress: () => {}
  });

  const gpuAutoResult = await exportClip({
    inputPath,
    outputPath: gpuAutoOutputPath,
    startSeconds: 0,
    durationSeconds: 1,
    encodingMode: 'gpu-auto',
    onProgress: () => {}
  });

  const stats = fs.statSync(outputPath);
  if (stats.size <= 0) {
    throw new Error('Output file was empty.');
  }

  const gpuAutoStats = fs.statSync(gpuAutoOutputPath);
  if (gpuAutoStats.size <= 0) {
    throw new Error('GPU auto output file was empty.');
  }

  const probe = run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    outputPath
  ]);

  const duration = Number(probe.stdout.trim());
  if (!Number.isFinite(duration) || Math.abs(duration - 1.75) > 0.35) {
    throw new Error(`Unexpected output duration: ${probe.stdout.trim()}`);
  }

  const splitResult = await splitVideoIntoClips({
    inputPath,
    durationSeconds: 4,
    segmentSeconds: 1.5,
    encodingMode: 'cpu',
    onProgress: () => {}
  });

  if (splitResult.clipCount !== 3 || splitResult.outputs.length !== 3) {
    throw new Error(`Unexpected split output count: ${splitResult.outputs.length}`);
  }

  for (const splitOutputPath of splitResult.outputs) {
    if (!fs.existsSync(splitOutputPath) || fs.statSync(splitOutputPath).size <= 0) {
      throw new Error(`Missing split output: ${splitOutputPath}`);
    }
  }

  const capabilities = await getEncodingCapabilities();
  const gpuLabel = capabilities.hardwareEncoders.length > 0 ? capabilities.hardwareEncoders[0].label : 'CPU fallback';
  const ytDlp = await resolveYtDlpCommand();
  const parsedDownloadProgress = parseYtDlpProgress('[download]  42.5% of 10.00MiB at 1.00MiB/s ETA 00:05');
  const extractedUrl = extractHttpUrl('yt-dlp --no-playlist "https://example.com/watch?v=abc123"');
  const downloadArgs = buildYtDlpArgs({ url: extractedUrl, outputDirectory: tmpDir });
  const separatorIndex = downloadArgs.indexOf('--');
  const friendlyError = getYtDlpFailureMessage({
    code: 1,
    output: 'ERROR: Unsupported URL: --',
    requestedUrl: extractedUrl
  });

  if (!parsedDownloadProgress || Math.abs(parsedDownloadProgress.ratio - 0.425) > 0.001) {
    throw new Error('Could not parse yt-dlp download progress.');
  }

  if (extractedUrl !== 'https://example.com/watch?v=abc123') {
    throw new Error(`Unexpected extracted URL: ${extractedUrl}`);
  }

  if (separatorIndex === -1 || downloadArgs[separatorIndex + 1] !== extractedUrl) {
    throw new Error('yt-dlp args do not separate options from URL.');
  }

  if (!friendlyError.includes('Paste the page/share URL')) {
    throw new Error('Unsupported URL error was not made actionable.');
  }

  console.log(
    `Smoke test OK: ${duration.toFixed(2)}s clip exported, GPU auto used ${gpuAutoResult.encoding.label}, split wrote 3 clips, detected ${gpuLabel}, resolved FFmpeg at ${resolvedFfmpegPath}, found yt-dlp ${ytDlp.version}.`
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
