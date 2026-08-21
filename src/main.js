const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  DEFAULT_SEGMENT_SECONDS,
  exportClip,
  getEncodingCapabilities,
  resolveFfmpegPath,
  splitVideoIntoClips
} = require('./clipper');
const { autoTranslateMedia, getAutoTranslateStatus } = require('./autotranslate');
const {
  DOWNLOAD_FOLDER_NAME,
  downloadVideoFromUrl,
  resolveYtDlpCommand
} = require('./downloader');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#f4f3ee',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

function getVideoFilters() {
  return [
    {
      name: 'Videos',
      extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv']
    },
    { name: 'All Files', extensions: ['*'] }
  ];
}

function getSafeDefaultName(sourcePath) {
  const parsed = path.parse(sourcePath || 'clip');
  return `${parsed.name || 'clip'}-trimmed.mp4`;
}

function getDownloadRoot() {
  return path.join(app.getPath('videos'), DOWNLOAD_FOLDER_NAME);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('video:select', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Video',
    properties: ['openFile'],
    filters: getVideoFilters()
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  const stats = await fs.promises.stat(filePath);

  return {
    path: filePath,
    name: path.basename(filePath),
    url: pathToFileURL(filePath).href,
    size: stats.size
  };
});

ipcMain.handle('video:download-url', async (event, payload = {}) => {
  const result = await downloadVideoFromUrl({
    url: payload.url,
    downloadRoot: getDownloadRoot(),
    onProgress: (progress) => {
      event.sender.send('video:export-progress', { ...progress, operation: 'download' });
    }
  });

  return result;
});

ipcMain.handle('video:choose-export-path', async (_event, payload = {}) => {
  const sourcePath = typeof payload.sourcePath === 'string' ? payload.sourcePath : '';
  const defaultDirectory = sourcePath ? path.dirname(sourcePath) : app.getPath('videos');
  const defaultPath = path.join(defaultDirectory, getSafeDefaultName(sourcePath));

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export Clip',
    defaultPath,
    filters: [
      { name: 'MP4 Video', extensions: ['mp4'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  return result.filePath;
});

ipcMain.handle('video:export', async (event, payload = {}) => {
  const { inputPath, outputPath, startSeconds, durationSeconds, encodingMode } = payload;

  const result = await exportClip({
    inputPath,
    outputPath,
    startSeconds: Number(startSeconds),
    durationSeconds: Number(durationSeconds),
    encodingMode,
    onProgress: (progress) => {
      event.sender.send('video:export-progress', { ...progress, operation: 'export' });
    }
  });

  return result;
});

ipcMain.handle('video:split', async (event, payload = {}) => {
  const { inputPath, durationSeconds, encodingMode } = payload;

  const result = await splitVideoIntoClips({
    inputPath,
    durationSeconds: Number(durationSeconds),
    segmentSeconds: DEFAULT_SEGMENT_SECONDS,
    encodingMode,
    onProgress: (progress) => {
      event.sender.send('video:export-progress', { ...progress, operation: 'split' });
    }
  });

  return result;
});

ipcMain.handle('video:auto-translate', async (event, payload = {}) => {
  const inputPath = typeof payload.inputPath === 'string' ? payload.inputPath.trim() : '';
  const url = typeof payload.url === 'string' ? payload.url.trim() : '';
  if (!inputPath && !url) {
    throw new Error('Open a video or enter a video URL before starting AutoTranslate.');
  }

  const sendProgress = (progress) => {
    event.sender.send('video:export-progress', { ...progress, operation: 'autotranslate' });
  };
  let sourcePath = inputPath;
  let outputDirectory;
  let workerProgressStart = 0;

  if (url) {
    const download = await downloadVideoFromUrl({
      url,
      downloadRoot: getDownloadRoot(),
      onProgress: (progress) => {
        sendProgress({
          ...progress,
          ratio: progress.ratio * 0.08,
          status:
            progress.status === 'Downloading video'
              ? 'Downloading source video and audio'
              : progress.status || 'Downloading source video and audio'
        });
      }
    });
    sourcePath = download.path;
    outputDirectory = download.outputDirectory;
    workerProgressStart = 0.08;
  }

  return autoTranslateMedia({
    inputPath: sourcePath,
    outputDirectory,
    targetLanguage: payload.targetLanguage,
    chunkSeconds: payload.chunkSeconds,
    onProgress: (progress) => {
      sendProgress({
        ...progress,
        ratio: workerProgressStart + (1 - workerProgressStart) * progress.ratio
      });
    }
  });
});

ipcMain.handle('video:encoding-capabilities', async () => getEncodingCapabilities());

ipcMain.handle('video:auto-translate-status', async () => getAutoTranslateStatus());

ipcMain.handle('video:downloader-status', async () => {
  const command = await resolveYtDlpCommand();
  return {
    version: command.version,
    label: `yt-dlp ${command.version}`
  };
});

ipcMain.handle('video:show-output', async (_event, outputPath) => {
  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    return false;
  }

  shell.showItemInFolder(outputPath);
  return true;
});
