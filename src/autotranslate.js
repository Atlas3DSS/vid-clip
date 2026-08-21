const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ASR_PYTHON =
  process.env.VID_CLIP_ASR_PYTHON || '/home/orwel/dev_genius/vid_clip_ai/.venv/bin/python';
const DEFAULT_TTS_PYTHON =
  process.env.VID_CLIP_TTS_PYTHON || '/home/orwel/dev_genius/vid_clip_ai/.tts-venv/bin/python';
const DEFAULT_TRANSLATOR_MODEL =
  process.env.VID_CLIP_TRANSLATOR_MODEL ||
  '/home/orwel/dev_genius/models/gguf/Qwen3.5-9B-c2022362-exact/Qwen3.5-9B-Q8_0.gguf';
const DEFAULT_TRANSLATOR_SERVER =
  process.env.VID_CLIP_TRANSLATOR_SERVER ||
  '/home/orwel/dev_genius/engines/llama.cpp-b10299/build-cuda-4090-r1/bin/llama-server';
const DEFAULT_FALLBACK_TRANSLATOR_MODEL =
  process.env.VID_CLIP_TRANSLATOR_FALLBACK_MODEL ||
  '/home/orwel/dev_genius/models/gguf/Qwen3.8-27B-Q4_K_M-0669b986/Qwen3.8-27B-Q4_K_M.gguf';
const DEFAULT_CHUNK_SECONDS = 20;
const EVENT_PREFIX = 'VIDCLIP_EVENT ';
const SUPPORTED_TARGET_LANGUAGES = [
  'English',
  'Chinese',
  'Japanese',
  'Korean',
  'German',
  'French',
  'Russian',
  'Portuguese',
  'Spanish',
  'Italian'
];

function assertInput(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required.`);
  }
}

function normalizeTargetLanguage(value) {
  const match = SUPPORTED_TARGET_LANGUAGES.find(
    (language) => language.toLowerCase() === String(value || '').trim().toLowerCase()
  );

  if (!match) {
    throw new Error(`Target language must be one of: ${SUPPORTED_TARGET_LANGUAGES.join(', ')}.`);
  }

  return match;
}

function normalizeChunkSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_CHUNK_SECONDS;
  }

  return Math.min(Math.max(seconds, 8), 30);
}

function getWorkerPath(workerPath) {
  const candidate = workerPath || path.join(__dirname, 'autotranslate_worker.py');
  return candidate.includes('app.asar') ? candidate.replace('app.asar', 'app.asar.unpacked') : candidate;
}

function getOutputFolderName(inputPath, targetLanguage) {
  const baseName = path.parse(inputPath).name || 'audio';
  return `${baseName}-autotranslate-${targetLanguage.toLowerCase()}`;
}

async function createUniqueDirectory(parentDirectory, folderName) {
  await fs.promises.mkdir(parentDirectory, { recursive: true });
  let candidate = path.join(parentDirectory, folderName);
  let suffix = 2;

  while (fs.existsSync(candidate)) {
    candidate = path.join(parentDirectory, `${folderName}-${suffix}`);
    suffix += 1;
  }

  await fs.promises.mkdir(candidate, { recursive: false });
  return candidate;
}

function runProcess(command, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const consume = (chunk, streamName) => {
      const text = chunk.toString();
      if (streamName === 'stdout') {
        stdout += text;
        stdoutBuffer += text;
      } else {
        stderr += text;
        stderrBuffer += text;
      }

      let buffer = streamName === 'stdout' ? stdoutBuffer : stderrBuffer;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      if (streamName === 'stdout') {
        stdoutBuffer = buffer;
      } else {
        stderrBuffer = buffer;
      }

      if (typeof onLine === 'function') {
        for (const line of lines) {
          onLine(line, streamName);
        }
      }
    };

    child.stdout.on('data', (chunk) => consume(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => consume(chunk, 'stderr'));

    child.on('error', (error) => {
      reject(new Error(`Could not start ${command}: ${error.message}`));
    });

    child.on('close', (code) => {
      if (typeof onLine === 'function') {
        if (stdoutBuffer) {
          onLine(stdoutBuffer, 'stdout');
        }
        if (stderrBuffer) {
          onLine(stderrBuffer, 'stderr');
        }
      }

      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }

      const detail = `${stderr}\n${stdout}`.trim().split(/\r?\n/).slice(-16).join('\n');
      reject(new Error(`${command} failed with exit code ${code}.${detail ? `\n${detail}` : ''}`));
    });
  });
}

async function toLinuxPath(filePath) {
  if (process.platform !== 'win32') {
    return filePath;
  }

  const result = await runProcess('wsl.exe', ['--exec', 'wslpath', '-a', filePath]);
  const linuxPath = result.stdout.trim();
  if (!linuxPath) {
    throw new Error(`WSL could not resolve this path: ${filePath}`);
  }

  return linuxPath;
}

function parseWorkerEvent(line) {
  if (!line.startsWith(EVENT_PREFIX)) {
    return null;
  }

  try {
    return JSON.parse(line.slice(EVENT_PREFIX.length));
  } catch (error) {
    return null;
  }
}

async function runWorkerPhase({ pythonPath, workerPath, requestPath, phase, onProgress }) {
  const linuxWorkerPath = await toLinuxPath(workerPath);
  const linuxRequestPath = await toLinuxPath(requestPath);
  const workerArgs = [linuxWorkerPath, '--phase', phase, '--request', linuxRequestPath];
  const command = process.platform === 'win32' ? 'wsl.exe' : pythonPath;
  const args = process.platform === 'win32' ? ['--exec', pythonPath, ...workerArgs] : workerArgs;

  await runProcess(command, args, {
    onLine: (line) => {
      const event = parseWorkerEvent(line);
      if (event && typeof onProgress === 'function') {
        onProgress(event);
      }
    }
  });
}

async function autoTranslateMedia({
  inputPath,
  outputDirectory,
  targetLanguage = 'English',
  chunkSeconds = DEFAULT_CHUNK_SECONDS,
  workerPath,
  asrPython = DEFAULT_ASR_PYTHON,
  ttsPython = DEFAULT_TTS_PYTHON,
  onProgress
}) {
  assertInput(inputPath, 'Input path');
  if (!fs.existsSync(inputPath)) {
    throw new Error('Input media does not exist.');
  }

  const language = normalizeTargetLanguage(targetLanguage);
  const resolvedOutputDirectory = outputDirectory
    ? path.resolve(outputDirectory)
    : await createUniqueDirectory(path.dirname(inputPath), getOutputFolderName(inputPath, language));
  await fs.promises.mkdir(resolvedOutputDirectory, { recursive: true });

  const resolvedWorkerPath = getWorkerPath(workerPath);
  if (!fs.existsSync(resolvedWorkerPath)) {
    throw new Error(`AutoTranslate worker is missing: ${resolvedWorkerPath}`);
  }

  const requestPath = path.join(resolvedOutputDirectory, 'autotranslate-request.json');
  const request = {
    chunk_seconds: normalizeChunkSeconds(chunkSeconds),
    input_path: await toLinuxPath(path.resolve(inputPath)),
    output_dir: await toLinuxPath(resolvedOutputDirectory),
    target_language: language
  };
  await fs.promises.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');

  await runWorkerPhase({
    pythonPath: asrPython,
    workerPath: resolvedWorkerPath,
    requestPath,
    phase: 'transcribe',
    onProgress
  });
  await runWorkerPhase({
    pythonPath: asrPython,
    workerPath: resolvedWorkerPath,
    requestPath,
    phase: 'translate',
    onProgress
  });
  await runWorkerPhase({
    pythonPath: ttsPython,
    workerPath: resolvedWorkerPath,
    requestPath,
    phase: 'synthesize',
    onProgress
  });

  const resultPath = path.join(resolvedOutputDirectory, 'autotranslate-result.json');
  if (!fs.existsSync(resultPath)) {
    throw new Error('AutoTranslate finished without a result manifest.');
  }

  const result = JSON.parse(await fs.promises.readFile(resultPath, 'utf8'));
  return {
    ...result,
    audioOutputPath: result.audio_output_file
      ? path.join(resolvedOutputDirectory, result.audio_output_file)
      : null,
    outputDirectory: resolvedOutputDirectory,
    outputPath: path.join(resolvedOutputDirectory, result.output_file),
    sourceAudioPath: path.join(resolvedOutputDirectory, result.source_audio_file),
    transcriptPath: path.join(resolvedOutputDirectory, result.transcript_file),
    subtitlesPath: path.join(resolvedOutputDirectory, result.subtitles_file),
    videoOutputPath: result.video_output_file
      ? path.join(resolvedOutputDirectory, result.video_output_file)
      : null
  };
}

async function getAutoTranslateStatus({
  workerPath,
  asrPython = DEFAULT_ASR_PYTHON,
  ttsPython = DEFAULT_TTS_PYTHON
} = {}) {
  const resolvedWorkerPath = getWorkerPath(workerPath);
  if (!fs.existsSync(resolvedWorkerPath)) {
    throw new Error('AutoTranslate worker is not included with Vid Clip.');
  }

  if (process.platform === 'win32') {
    await runProcess('wsl.exe', [
      '--exec',
      'test',
      '-x',
      asrPython,
      '-a',
      '-x',
      ttsPython,
      '-a',
      '-x',
      DEFAULT_TRANSLATOR_SERVER,
      '-a',
      '-f',
      DEFAULT_TRANSLATOR_MODEL,
      '-a',
      '-f',
      DEFAULT_FALLBACK_TRANSLATOR_MODEL
    ]);
  } else if (
    !fs.existsSync(asrPython) ||
    !fs.existsSync(ttsPython) ||
    !fs.existsSync(DEFAULT_TRANSLATOR_SERVER) ||
    !fs.existsSync(DEFAULT_TRANSLATOR_MODEL) ||
    !fs.existsSync(DEFAULT_FALLBACK_TRANSLATOR_MODEL)
  ) {
    throw new Error('Install the local Qwen AutoTranslate runtimes and model files.');
  }

  return {
    asrPython,
    chunkSeconds: DEFAULT_CHUNK_SECONDS,
    label: 'Local Qwen ASR, 27B alignment review, and voice cloning ready',
    targetLanguages: [...SUPPORTED_TARGET_LANGUAGES],
    ttsPython
  };
}

module.exports = {
  DEFAULT_ASR_PYTHON,
  DEFAULT_CHUNK_SECONDS,
  DEFAULT_FALLBACK_TRANSLATOR_MODEL,
  DEFAULT_TRANSLATOR_MODEL,
  DEFAULT_TRANSLATOR_SERVER,
  DEFAULT_TTS_PYTHON,
  SUPPORTED_TARGET_LANGUAGES,
  autoTranslateMedia,
  getAutoTranslateStatus,
  getOutputFolderName,
  normalizeChunkSeconds,
  normalizeTargetLanguage,
  parseWorkerEvent,
  toLinuxPath
};
