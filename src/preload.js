const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vidClip', {
  selectVideo: () => ipcRenderer.invoke('video:select'),
  downloadVideoFromUrl: (payload) => ipcRenderer.invoke('video:download-url', payload),
  chooseExportPath: (payload) => ipcRenderer.invoke('video:choose-export-path', payload),
  exportClip: (payload) => ipcRenderer.invoke('video:export', payload),
  splitIntoClips: (payload) => ipcRenderer.invoke('video:split', payload),
  getEncodingCapabilities: () => ipcRenderer.invoke('video:encoding-capabilities'),
  getDownloaderStatus: () => ipcRenderer.invoke('video:downloader-status'),
  showOutput: (outputPath) => ipcRenderer.invoke('video:show-output', outputPath),
  onExportProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('video:export-progress', listener);
    return () => ipcRenderer.removeListener('video:export-progress', listener);
  }
});
