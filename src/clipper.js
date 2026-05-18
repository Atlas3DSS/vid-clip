const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const DEFAULT_SEGMENT_SECONDS = 15;
const HARDWARE_PROBE_TIMEOUT_MS = 8000;
const PROCESS_LIST_TIMEOUT_MS = 5000;
const FFMPEG_PROBE_TIMEOUT_MS = 5000;

const CPU_ENCODING_PLAN = {
  id: 'cpu',
  label: 'CPU H.264',
  isHardware: false,
  videoArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p']
};

const HARDWARE_ENCODER_CANDIDATES = [
  {
    id: 'h264_nvenc',
    label: 'NVIDIA NVENC',
    isHardware: true,
    videoArgs: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20', '-pix_fmt', 'yuv420p']
  },
  {
    id: 'h264_qsv',
    label: 'Intel Quick Sync',
    isHardware: true,
    videoArgs: ['-vf', 'format=nv12', '-c:v', 'h264_qsv', '-global_quality', '20']
  },
  {
    id: 'h264_amf',
    label: 'AMD AMF',
    isHardware: true,
    videoArgs: [
      '-c:v',
      'h264_amf',
      '-quality',
      'speed',
      '-rc',
      'cqp',
      '-qp_i',
      '20',
      '-qp_p',
      '22',
      '-pix_fmt',
      'yuv420p'
    ]
  }
];

const capabilitiesCache = new Map();
const ffmpegPathCache = new Map();

function assertFile(path, name) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`${name} is required.`);
  }
}

function assertSeconds(value, name, allowZero = true) {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number.`);
  }

  if (allowZero ? value < 0 : value <= 0) {
    throw new Error(`${name} must be ${allowZero ? 'zero or greater' : 'greater than zero'}.`);
  }
}

function formatSeconds(seconds) {
  return Number(seconds).toFixed(3);
}

function normalizeEncodingMode(encodingMode) {
  return encodingMode === 'cpu' ? 'cpu' : 'gpu-auto';
}

function getCpuEncodingPlan() {
  return {
    ...CPU_ENCODING_PLAN,
    videoArgs: [...CPU_ENCODING_PLAN.videoArgs]
  };
}

function serializeEncodingPlan(plan) {
  return {
    id: plan.id,
    label: plan.label,
    isHardware: plan.isHardware
  };
}

function buildFfmpegArgs({ inputPath, outputPath, startSeconds, durationSeconds, encodingPlan = CPU_ENCODING_PLAN }) {
  return [
    '-hide_banner',
    '-y',
    '-ss',
    formatSeconds(startSeconds),
    '-i',
    inputPath,
    '-t',
    formatSeconds(durationSeconds),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-sn',
    '-dn',
    ...encodingPlan.videoArgs,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    outputPath
  ];
}

function parseProgressSeconds(line) {
  const match = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(line);
  if (!match) {
    return null;
  }

  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function addCandidate(candidates, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    return;
  }

  const normalized = candidate.trim();
  if (!candidates.includes(normalized)) {
    candidates.push(normalized);
  }
}

function getEnvironmentPathEntries() {
  const rawPath = process.env.PATH || process.env.Path || '';
  return rawPath.split(path.delimiter).filter(Boolean);
}

function getExecutableSearchRoots() {
  const roots = [
    process.cwd(),
    __dirname,
    path.join(__dirname, '..'),
    process.resourcesPath,
    process.execPath ? path.dirname(process.execPath) : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
    process.env.ProgramData ? path.join(process.env.ProgramData, 'chocolatey', 'bin') : '',
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'scoop', 'shims') : '',
    process.env.ProgramData ? path.join(process.env.ProgramData, 'scoop', 'shims') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'ffmpeg', 'bin') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'ffmpeg', 'bin') : ''
  ];

  return roots.filter(Boolean);
}

function findNamedFile(rootDirectory, fileName, maxDepth) {
  if (!rootDirectory || maxDepth < 0 || !fs.existsSync(rootDirectory)) {
    return [];
  }

  const matches = [];
  let entries = [];

  try {
    entries = fs.readdirSync(rootDirectory, { withFileTypes: true });
  } catch (error) {
    return matches;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootDirectory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      matches.push(entryPath);
      continue;
    }

    if (entry.isDirectory() && maxDepth > 0) {
      matches.push(...findNamedFile(entryPath, fileName, maxDepth - 1));
    }
  }

  return matches;
}

function getWingetFfmpegCandidates() {
  const packagesRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : '';

  if (!packagesRoot || !fs.existsSync(packagesRoot)) {
    return [];
  }

  let entries = [];
  try {
    entries = fs.readdirSync(packagesRoot, { withFileTypes: true });
  } catch (error) {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && entry.name.toLowerCase().includes('ffmpeg'))
    .flatMap((entry) => findNamedFile(path.join(packagesRoot, entry.name), 'ffmpeg.exe', 5));
}

function buildFfmpegCandidates(ffmpegPath = DEFAULT_FFMPEG_PATH) {
  const candidates = [];
  const requestedPath = ffmpegPath || DEFAULT_FFMPEG_PATH;
  const requestedIsFilePath = path.isAbsolute(requestedPath) || requestedPath.includes('\\') || requestedPath.includes('/');

  addCandidate(candidates, process.env.FFMPEG_PATH);
  addCandidate(candidates, requestedPath);

  if (!requestedIsFilePath) {
    const executableName = requestedPath.toLowerCase().endsWith('.exe') ? requestedPath : `${requestedPath}.exe`;

    for (const pathEntry of getEnvironmentPathEntries()) {
      addCandidate(candidates, path.join(pathEntry, executableName));
    }

    for (const root of getExecutableSearchRoots()) {
      addCandidate(candidates, path.join(root, executableName));
      addCandidate(candidates, path.join(root, 'bin', executableName));
    }

    for (const wingetCandidate of getWingetFfmpegCandidates()) {
      addCandidate(candidates, wingetCandidate);
    }
  }

  return candidates;
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill('SIGKILL');
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}\nProcess timed out after ${timeoutMs}ms.`
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({
        code: null,
        stdout,
        stderr: error.message
      });
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

async function resolveFfmpegPath(ffmpegPath = DEFAULT_FFMPEG_PATH) {
  const cacheKey = ffmpegPath || DEFAULT_FFMPEG_PATH;
  if (ffmpegPathCache.has(cacheKey)) {
    return ffmpegPathCache.get(cacheKey);
  }

  const promise = (async () => {
    const candidates = buildFfmpegCandidates(ffmpegPath);

    for (const candidate of candidates) {
      const result = await runProcess(candidate, ['-hide_banner', '-version'], FFMPEG_PROBE_TIMEOUT_MS);
      if (result.code === 0) {
        return candidate;
      }
    }

    throw new Error(
      [
        'Could not find FFmpeg.',
        'Install FFmpeg, set FFMPEG_PATH, or put ffmpeg.exe next to Vid Clip.exe.'
      ].join(' ')
    );
  })();

  ffmpegPathCache.set(cacheKey, promise);
  return promise;
}

async function listAvailableEncoderNames(ffmpegPath = DEFAULT_FFMPEG_PATH) {
  const resolvedFfmpegPath = await resolveFfmpegPath(ffmpegPath);
  const result = await runProcess(resolvedFfmpegPath, ['-hide_banner', '-encoders'], PROCESS_LIST_TIMEOUT_MS);
  const output = `${result.stdout}\n${result.stderr}`;

  if (result.code !== 0) {
    return new Set();
  }

  const names = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[A-Z.]{6}\s+(\S+)/.exec(line);
    if (match) {
      names.add(match[1]);
    }
  }

  return names;
}

async function testHardwareEncoder(ffmpegPath, plan) {
  const resolvedFfmpegPath = await resolveFfmpegPath(ffmpegPath);
  const result = await runProcess(
    resolvedFfmpegPath,
    [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30:duration=0.3',
      '-an',
      ...plan.videoArgs,
      '-f',
      'null',
      '-'
    ],
    HARDWARE_PROBE_TIMEOUT_MS
  );

  return result.code === 0;
}

async function getEncodingCapabilities(ffmpegPath = DEFAULT_FFMPEG_PATH) {
  const resolvedFfmpegPath = await resolveFfmpegPath(ffmpegPath);
  if (capabilitiesCache.has(resolvedFfmpegPath)) {
    return capabilitiesCache.get(resolvedFfmpegPath);
  }

  const promise = (async () => {
    const availableNames = await listAvailableEncoderNames(resolvedFfmpegPath);
    const hardwareEncoders = [];

    for (const plan of HARDWARE_ENCODER_CANDIDATES) {
      if (!availableNames.has(plan.id)) {
        continue;
      }

      const works = await testHardwareEncoder(resolvedFfmpegPath, plan);
      if (works) {
        hardwareEncoders.push({
          ...plan,
          videoArgs: [...plan.videoArgs]
        });
      }
    }

    return {
      cpuEncoder: serializeEncodingPlan(CPU_ENCODING_PLAN),
      ffmpegPath: resolvedFfmpegPath,
      hardwareEncoders: hardwareEncoders.map(serializeEncodingPlan),
      preferredEncoder: hardwareEncoders.length > 0 ? serializeEncodingPlan(hardwareEncoders[0]) : serializeEncodingPlan(CPU_ENCODING_PLAN)
    };
  })();

  capabilitiesCache.set(resolvedFfmpegPath, promise);
  return promise;
}

async function resolveEncodingPlan({ encodingMode = 'gpu-auto', ffmpegPath = DEFAULT_FFMPEG_PATH } = {}) {
  const resolvedFfmpegPath = await resolveFfmpegPath(ffmpegPath);
  const normalizedMode = normalizeEncodingMode(encodingMode);
  if (normalizedMode === 'cpu') {
    return getCpuEncodingPlan();
  }

  const capabilities = await getEncodingCapabilities(resolvedFfmpegPath);
  const preferredHardware = HARDWARE_ENCODER_CANDIDATES.find((plan) =>
    capabilities.hardwareEncoders.some((encoder) => encoder.id === plan.id)
  );

  if (!preferredHardware) {
    return getCpuEncodingPlan();
  }

  return {
    ...preferredHardware,
    videoArgs: [...preferredHardware.videoArgs]
  };
}

function runFfmpeg(args, { ffmpegPath, durationSeconds, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;

      const progressSeconds = parseProgressSeconds(text);
      if (progressSeconds !== null && typeof onProgress === 'function') {
        onProgress({
          ratio: Math.min(progressSeconds / durationSeconds, 0.99),
          seconds: progressSeconds
        });
      }
    });

    child.on('error', (error) => {
      reject(new Error(`Could not start FFmpeg: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        if (typeof onProgress === 'function') {
          onProgress({ ratio: 1, seconds: durationSeconds });
        }
        resolve();
        return;
      }

      const detail = stderr.trim().split(/\r?\n/).slice(-8).join('\n');
      reject(new Error(`FFmpeg failed with exit code ${code}.${detail ? `\n${detail}` : ''}`));
    });
  });
}

async function exportWithPlan({ inputPath, outputPath, startSeconds, durationSeconds, ffmpegPath, onProgress, encodingPlan }) {
  const args = buildFfmpegArgs({ inputPath, outputPath, startSeconds, durationSeconds, encodingPlan });
  await runFfmpeg(args, { ffmpegPath, durationSeconds, onProgress });

  return {
    outputPath,
    encoding: serializeEncodingPlan(encodingPlan)
  };
}

async function exportClip({
  inputPath,
  outputPath,
  startSeconds,
  durationSeconds,
  ffmpegPath = DEFAULT_FFMPEG_PATH,
  encodingMode = 'gpu-auto',
  encodingPlan,
  onProgress
}) {
  assertFile(inputPath, 'Input path');
  assertFile(outputPath, 'Output path');
  assertSeconds(startSeconds, 'Start seconds');
  assertSeconds(durationSeconds, 'Duration seconds', false);

  if (!fs.existsSync(inputPath)) {
    throw new Error('Input video does not exist.');
  }

  const resolvedFfmpegPath = await resolveFfmpegPath(ffmpegPath);
  const normalizedMode = normalizeEncodingMode(encodingMode);
  const plan = encodingPlan || (await resolveEncodingPlan({ encodingMode: normalizedMode, ffmpegPath: resolvedFfmpegPath }));

  try {
    return await exportWithPlan({ inputPath, outputPath, startSeconds, durationSeconds, ffmpegPath: resolvedFfmpegPath, onProgress, encodingPlan: plan });
  } catch (error) {
    if (normalizedMode !== 'gpu-auto' || !plan.isHardware) {
      throw error;
    }

    const fallbackPlan = getCpuEncodingPlan();
    const result = await exportWithPlan({
      inputPath,
      outputPath,
      startSeconds,
      durationSeconds,
      ffmpegPath: resolvedFfmpegPath,
      onProgress,
      encodingPlan: fallbackPlan
    });
    result.fallbackFrom = serializeEncodingPlan(plan);
    return result;
  }
}

function getSplitFolderName(inputPath, segmentSeconds) {
  const baseName = path.parse(inputPath).name || 'clip';
  const secondsLabel = Number.isInteger(segmentSeconds) ? String(segmentSeconds) : String(segmentSeconds).replace('.', '-');
  return `${baseName}-${secondsLabel}s-clips`;
}

async function createUniqueDirectory(parentDirectory, folderName) {
  let candidate = path.join(parentDirectory, folderName);
  let suffix = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(parentDirectory, `${folderName}-${suffix}`);
    suffix += 1;
  }

  await fs.promises.mkdir(candidate, { recursive: false });
  return candidate;
}

function getSegmentOutputPath({ outputDirectory, inputPath, index, clipCount }) {
  const baseName = path.parse(inputPath).name || 'clip';
  const digits = String(clipCount).length;
  const clipNumber = String(index + 1).padStart(digits, '0');
  return path.join(outputDirectory, `${baseName}-part-${clipNumber}.mp4`);
}

async function splitVideoIntoClips({
  inputPath,
  durationSeconds,
  segmentSeconds = DEFAULT_SEGMENT_SECONDS,
  ffmpegPath = DEFAULT_FFMPEG_PATH,
  encodingMode = 'gpu-auto',
  onProgress
}) {
  assertFile(inputPath, 'Input path');
  assertSeconds(durationSeconds, 'Duration seconds', false);
  assertSeconds(segmentSeconds, 'Segment seconds', false);

  if (!fs.existsSync(inputPath)) {
    throw new Error('Input video does not exist.');
  }

  const resolvedFfmpegPath = await resolveFfmpegPath(ffmpegPath);
  const parentDirectory = path.dirname(inputPath);
  const outputDirectory = await createUniqueDirectory(parentDirectory, getSplitFolderName(inputPath, segmentSeconds));
  const clipCount = Math.ceil(durationSeconds / segmentSeconds);
  const outputs = [];
  const normalizedMode = normalizeEncodingMode(encodingMode);
  let plan = await resolveEncodingPlan({ encodingMode: normalizedMode, ffmpegPath: resolvedFfmpegPath });
  let fallbackFrom = null;
  let completedSeconds = 0;

  for (let index = 0; index < clipCount; index += 1) {
    const startSeconds = index * segmentSeconds;
    const clipDuration = Math.min(segmentSeconds, durationSeconds - startSeconds);
    const outputPath = getSegmentOutputPath({ outputDirectory, inputPath, index, clipCount });

    const progressHandler = (progress) => {
      if (typeof onProgress !== 'function') {
        return;
      }

      onProgress({
        ...progress,
        ratio: Math.min((completedSeconds + progress.ratio * clipDuration) / durationSeconds, 0.99),
        currentClip: index + 1,
        clipCount,
        outputDirectory,
        outputPath,
        encoding: serializeEncodingPlan(plan)
      });
    };

    try {
      const result = await exportClip({
        inputPath,
        outputPath,
        startSeconds,
        durationSeconds: clipDuration,
        ffmpegPath: resolvedFfmpegPath,
        encodingMode: normalizedMode,
        encodingPlan: plan,
        onProgress: progressHandler
      });
      outputs.push(result.outputPath);
    } catch (error) {
      if (normalizedMode !== 'gpu-auto' || !plan.isHardware) {
        throw error;
      }

      fallbackFrom = serializeEncodingPlan(plan);
      plan = getCpuEncodingPlan();
      const result = await exportClip({
        inputPath,
        outputPath,
        startSeconds,
        durationSeconds: clipDuration,
        ffmpegPath: resolvedFfmpegPath,
        encodingMode: 'cpu',
        encodingPlan: plan,
        onProgress: progressHandler
      });
      outputs.push(result.outputPath);
    }

    completedSeconds += clipDuration;
  }

  if (typeof onProgress === 'function') {
    onProgress({
      ratio: 1,
      currentClip: clipCount,
      clipCount,
      outputDirectory,
      encoding: serializeEncodingPlan(plan)
    });
  }

  return {
    outputDirectory,
    outputs,
    clipCount,
    segmentSeconds,
    encoding: serializeEncodingPlan(plan),
    fallbackFrom
  };
}

module.exports = {
  DEFAULT_FFMPEG_PATH,
  DEFAULT_SEGMENT_SECONDS,
  buildFfmpegArgs,
  exportClip,
  formatSeconds,
  getEncodingCapabilities,
  parseProgressSeconds,
  resolveFfmpegPath,
  resolveEncodingPlan,
  splitVideoIntoClips
};
