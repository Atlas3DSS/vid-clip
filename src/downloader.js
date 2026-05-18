const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DOWNLOAD_FOLDER_NAME = 'Vid Clip Downloads';
const PROBE_TIMEOUT_MS = 6000;
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.wmv']);

const commandCache = {
  value: null
};

function trimUrlCandidate(candidate) {
  let value = candidate.trim().replace(/^["'`]+|["'`]+$/g, '');
  value = value.replace(/[.,;]+$/g, '');

  while (/[)\]}]$/.test(value)) {
    const lastCharacter = value.at(-1);
    const matchingOpen = lastCharacter === ')' ? '(' : lastCharacter === ']' ? '[' : '{';
    const openCount = [...value].filter((character) => character === matchingOpen).length;
    const closeCount = [...value].filter((character) => character === lastCharacter).length;

    if (closeCount <= openCount) {
      break;
    }

    value = value.slice(0, -1);
  }

  return value;
}

function extractHttpUrl(rawInput) {
  if (typeof rawInput !== 'string' || rawInput.trim() === '') {
    throw new Error('URL is required.');
  }

  const directCandidate = trimUrlCandidate(rawInput);
  let parsed;
  try {
    parsed = new URL(directCandidate);
  } catch (error) {
    const match = rawInput.match(/https?:\/\/[^\s"'<>]+/i);
    if (!match) {
      throw new Error('Paste a valid http or https video URL.');
    }

    parsed = new URL(trimUrlCandidate(match[0]));
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are supported.');
  }

  return parsed.href;
}

function runProbe(command, args) {
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
      resolve({ code: null, stdout, stderr: `${stderr}\nTimed out.` });
    }, PROBE_TIMEOUT_MS);

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
      resolve({ code: null, stdout, stderr: error.message });
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

async function resolveYtDlpCommand() {
  if (commandCache.value) {
    return commandCache.value;
  }

  const candidates = [
    { command: 'yt-dlp', prefixArgs: [] },
    { command: process.env.PYTHON || 'python', prefixArgs: ['-m', 'yt_dlp'] },
    { command: 'py', prefixArgs: ['-m', 'yt_dlp'] }
  ];

  for (const candidate of candidates) {
    const result = await runProbe(candidate.command, [...candidate.prefixArgs, '--version']);
    if (result.code === 0) {
      commandCache.value = {
        ...candidate,
        version: result.stdout.trim()
      };
      return commandCache.value;
    }
  }

  throw new Error('yt-dlp is not installed. Run: python -m pip install --user -U yt-dlp');
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

function buildDownloadDirectoryName() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `download-${timestamp}`;
}

function buildYtDlpArgs({ url, outputDirectory }) {
  return [
    '--newline',
    '--no-playlist',
    '--merge-output-format',
    'mp4',
    '-f',
    'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '-P',
    outputDirectory,
    '-o',
    '%(title).180B [%(id)s].%(ext)s',
    '--',
    url
  ];
}

function parseYtDlpProgress(line) {
  const percentMatch = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
  if (percentMatch) {
    return {
      ratio: Math.min(Number(percentMatch[1]) / 100, 0.99),
      status: 'Downloading video'
    };
  }

  if (line.includes('[Merger]')) {
    return {
      ratio: 0.99,
      status: 'Merging video and audio'
    };
  }

  if (line.includes('[download] Destination:')) {
    return {
      ratio: 0,
      status: 'Starting download'
    };
  }

  return null;
}

function getYtDlpFailureMessage({ code, output, requestedUrl }) {
  const detail = output.trim().split(/\r?\n/).slice(-8).join('\n');

  if (/Unsupported URL:\s*--/i.test(output)) {
    return [
      `yt-dlp rejected the URL argument while downloading ${requestedUrl}.`,
      'Paste the page/share URL itself, or a command/text snippet that contains a single http/https URL.'
    ].join('\n');
  }

  if (/Unsupported URL:/i.test(output)) {
    return [
      `yt-dlp does not support this page directly: ${requestedUrl}`,
      'Try a public/share URL from the same video, a direct media URL, or update yt-dlp.'
    ].join('\n');
  }

  return `yt-dlp failed with exit code ${code}.${detail ? `\n${detail}` : ''}`;
}

async function findDownloadedVideo(outputDirectory) {
  const entries = await fs.promises.readdir(outputDirectory, { withFileTypes: true });
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const filePath = path.join(outputDirectory, entry.name);
    const extension = path.extname(entry.name).toLowerCase();
    if (!MEDIA_EXTENSIONS.has(extension) || entry.name.endsWith('.part')) {
      continue;
    }

    const stats = await fs.promises.stat(filePath);
    candidates.push({ filePath, stats });
  }

  candidates.sort((left, right) => right.stats.size - left.stats.size);

  if (candidates.length === 0) {
    throw new Error('Download finished, but no video file was found.');
  }

  return candidates[0];
}

async function downloadVideoFromUrl({ url, downloadRoot, onProgress }) {
  const normalizedUrl = extractHttpUrl(url);
  const ytDlp = await resolveYtDlpCommand();
  const outputDirectory = await createUniqueDirectory(downloadRoot, buildDownloadDirectoryName());
  const args = [...ytDlp.prefixArgs, ...buildYtDlpArgs({ url: normalizedUrl, outputDirectory })];

  return new Promise((resolve, reject) => {
    const child = spawn(ytDlp.command, args, { windowsHide: true });
    let output = '';

    const handleOutput = (chunk) => {
      const text = chunk.toString();
      output += text;

      for (const line of text.split(/\r?\n/)) {
        const progress = parseYtDlpProgress(line);
        if (progress && typeof onProgress === 'function') {
          onProgress({
            ...progress,
            outputDirectory,
            downloader: `yt-dlp ${ytDlp.version}`
          });
        }
      }
    };

    child.stdout.on('data', handleOutput);
    child.stderr.on('data', handleOutput);

    child.on('error', (error) => {
      reject(new Error(`Could not start yt-dlp: ${error.message}`));
    });

    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(getYtDlpFailureMessage({ code, output, requestedUrl: normalizedUrl })));
        return;
      }

      try {
        const downloaded = await findDownloadedVideo(outputDirectory);
        if (typeof onProgress === 'function') {
          onProgress({ ratio: 1, status: 'Download complete', outputDirectory });
        }

        resolve({
          path: downloaded.filePath,
          name: path.basename(downloaded.filePath),
          url: pathToFileURL(downloaded.filePath).href,
          size: downloaded.stats.size,
          outputDirectory,
          downloadedFrom: normalizedUrl,
          downloader: `yt-dlp ${ytDlp.version}`
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = {
  DOWNLOAD_FOLDER_NAME,
  buildYtDlpArgs,
  downloadVideoFromUrl,
  extractHttpUrl,
  getYtDlpFailureMessage,
  parseYtDlpProgress,
  resolveYtDlpCommand
};
