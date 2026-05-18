const MIN_CLIP_SECONDS = 0.05;

const elements = {
  currentTime: document.querySelector('#currentTime'),
  downloadButton: document.querySelector('#downloadButton'),
  durationTime: document.querySelector('#durationTime'),
  emptyState: document.querySelector('#emptyState'),
  encodingInfo: document.querySelector('#encodingInfo'),
  encodingSelect: document.querySelector('#encodingSelect'),
  endInput: document.querySelector('#endInput'),
  endSlider: document.querySelector('#endSlider'),
  exportButton: document.querySelector('#exportButton'),
  exportProgress: document.querySelector('#exportProgress'),
  lengthInput: document.querySelector('#lengthInput'),
  openButton: document.querySelector('#openButton'),
  previewButton: document.querySelector('#previewButton'),
  progressLabel: document.querySelector('#progressLabel'),
  selectionLabel: document.querySelector('#selectionLabel'),
  setEndButton: document.querySelector('#setEndButton'),
  setStartButton: document.querySelector('#setStartButton'),
  showOutputButton: document.querySelector('#showOutputButton'),
  splitButton: document.querySelector('#splitButton'),
  sourceName: document.querySelector('#sourceName'),
  startInput: document.querySelector('#startInput'),
  startSlider: document.querySelector('#startSlider'),
  statusLine: document.querySelector('#statusLine'),
  urlForm: document.querySelector('#urlForm'),
  urlInput: document.querySelector('#urlInput'),
  video: document.querySelector('#video')
};

const state = {
  duration: 0,
  end: 0,
  exportPath: '',
  file: null,
  isBusy: false,
  isExporting: false,
  isPreviewingSelection: false,
  start: 0
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatTime(totalSeconds) {
  const safeSeconds = Math.max(totalSeconds, 0);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`;
}

function setStatus(message) {
  elements.statusLine.textContent = message;
}

function setControlsEnabled(enabled) {
  [
    elements.startSlider,
    elements.endSlider,
    elements.startInput,
    elements.endInput,
    elements.lengthInput,
    elements.previewButton,
    elements.setStartButton,
    elements.setEndButton,
    elements.splitButton
  ].forEach((element) => {
    element.disabled = !enabled || state.isBusy;
  });

  elements.exportButton.disabled = !enabled || state.isBusy;
  elements.encodingSelect.disabled = state.isBusy;
}

function setBusy(isBusy, operation = '') {
  state.isBusy = isBusy;
  state.isExporting = isBusy;
  setControlsEnabled(Boolean(state.file && state.duration));
  elements.openButton.disabled = isBusy;
  elements.downloadButton.disabled = isBusy;
  elements.urlInput.disabled = isBusy;
  elements.downloadButton.textContent = isBusy && operation === 'download' ? 'Downloading...' : 'Download URL';
  elements.exportButton.textContent = isBusy && operation === 'export' ? 'Exporting...' : 'Export Clip';
  elements.splitButton.textContent = isBusy && operation === 'split' ? 'Splitting...' : 'Split Into 15s Clips';
}

function syncControlBounds() {
  [elements.startSlider, elements.endSlider, elements.startInput, elements.endInput].forEach((element) => {
    element.max = state.duration.toFixed(2);
  });

  elements.lengthInput.max = state.duration.toFixed(2);
}

function updateSelection(nextStart, nextEnd) {
  if (!state.duration) {
    state.start = 0;
    state.end = 0;
  } else {
    const maxStart = Math.max(state.duration - MIN_CLIP_SECONDS, 0);
    const start = clamp(nextStart, 0, maxStart);
    const end = clamp(nextEnd, start + MIN_CLIP_SECONDS, state.duration);
    state.start = start;
    state.end = end;
  }

  const length = Math.max(state.end - state.start, 0);

  elements.startSlider.value = state.start.toFixed(2);
  elements.endSlider.value = state.end.toFixed(2);
  elements.startInput.value = state.start.toFixed(2);
  elements.endInput.value = state.end.toFixed(2);
  elements.lengthInput.value = length.toFixed(2);
  elements.selectionLabel.textContent = `${formatTime(state.start)} - ${formatTime(state.end)}`;
}

function resetProgress() {
  elements.exportProgress.value = 0;
  elements.progressLabel.textContent = 'Idle';
}

function getEncodingMode() {
  return elements.encodingSelect.value === 'cpu' ? 'cpu' : 'gpu-auto';
}

function getEncodingSummary(result) {
  if (!result || !result.encoding) {
    return '';
  }

  if (result.fallbackFrom) {
    return ` using ${result.encoding.label} after ${result.fallbackFrom.label} failed`;
  }

  return ` using ${result.encoding.label}`;
}

async function loadEncodingCapabilities() {
  try {
    const capabilities = await window.vidClip.getEncodingCapabilities();
    const hardwareLabels = capabilities.hardwareEncoders.map((encoder) => encoder.label);

    if (hardwareLabels.length > 0) {
      elements.encodingInfo.textContent = `GPU encoder: ${hardwareLabels[0]}`;
      return;
    }

    elements.encodingInfo.textContent = 'No working GPU encoder found; auto uses CPU';
  } catch (error) {
    elements.encodingInfo.textContent = 'Could not check GPU encoder';
  }
}

async function loadDownloaderStatus() {
  try {
    const status = await window.vidClip.getDownloaderStatus();
    if (!state.file) {
      setStatus(`${status.label} ready`);
    }
  } catch (error) {
    setStatus('yt-dlp is not installed');
  }
}

function loadVideoFile(file, statusMessage = 'Loading video') {
  if (!file) {
    return;
  }

  state.file = file;
  state.duration = 0;
  state.start = 0;
  state.end = 0;
  state.exportPath = '';

  elements.showOutputButton.hidden = true;
  elements.video.src = file.url;
  elements.video.load();
  elements.emptyState.hidden = true;
  elements.sourceName.textContent = file.name;
  resetProgress();
  setStatus(statusMessage);
  setControlsEnabled(false);
}

async function openVideo() {
  const file = await window.vidClip.selectVideo();
  loadVideoFile(file);
}

function handleMetadataLoaded() {
  const duration = elements.video.duration;

  if (!Number.isFinite(duration) || duration <= MIN_CLIP_SECONDS) {
    state.duration = 0;
    updateSelection(0, 0);
    setControlsEnabled(false);
    setStatus('Video is too short or cannot be read');
    return;
  }

  state.duration = duration;
  syncControlBounds();
  elements.durationTime.textContent = formatTime(duration);
  updateSelection(0, duration);
  setControlsEnabled(true);
  setStatus('Ready');
}

function handleTimeUpdate() {
  elements.currentTime.textContent = formatTime(elements.video.currentTime || 0);

  if (state.isPreviewingSelection && elements.video.currentTime >= state.end - 0.025) {
    elements.video.pause();
    elements.video.currentTime = state.end;
    state.isPreviewingSelection = false;
  }
}

function setStartFromValue(value) {
  const nextStart = toNumber(value, state.start);
  const length = Math.max(state.end - state.start, MIN_CLIP_SECONDS);
  const start = clamp(nextStart, 0, Math.max(state.duration - MIN_CLIP_SECONDS, 0));
  const end = state.end > start ? state.end : Math.min(start + length, state.duration);
  updateSelection(start, end);
}

function setEndFromValue(value) {
  const nextEnd = toNumber(value, state.end);
  updateSelection(state.start, nextEnd);
}

function setLengthFromValue(value) {
  const nextLength = clamp(toNumber(value, MIN_CLIP_SECONDS), MIN_CLIP_SECONDS, state.duration);
  let start = state.start;
  let end = start + nextLength;

  if (end > state.duration) {
    end = state.duration;
    start = Math.max(end - nextLength, 0);
  }

  updateSelection(start, end);
}

function setStartToCurrentTime() {
  setStartFromValue(elements.video.currentTime || 0);
}

function setEndToCurrentTime() {
  setEndFromValue(elements.video.currentTime || state.end);
}

async function previewSelection() {
  if (!state.file || !state.duration) {
    return;
  }

  state.isPreviewingSelection = true;
  elements.video.currentTime = state.start;
  await elements.video.play();
}

function updateProgress(progress) {
  const percent = Math.round(clamp(progress.ratio || 0, 0, 1) * 100);
  elements.exportProgress.value = percent;

  if (progress.status) {
    setStatus(progress.status);
  }

  if (progress.currentClip && progress.clipCount) {
    elements.progressLabel.textContent = `${percent}% (${progress.currentClip}/${progress.clipCount})`;
    return;
  }

  elements.progressLabel.textContent = `${percent}%`;
}

async function downloadFromUrl(event) {
  event.preventDefault();

  if (state.isBusy) {
    return;
  }

  const url = elements.urlInput.value.trim();
  if (!url) {
    setStatus('Enter a video URL');
    return;
  }

  const removeProgressListener = window.vidClip.onExportProgress(updateProgress);

  try {
    setBusy(true, 'download');
    elements.showOutputButton.hidden = true;
    elements.exportProgress.value = 0;
    elements.progressLabel.textContent = '0%';
    setStatus('Starting URL download');

    const file = await window.vidClip.downloadVideoFromUrl({ url });
    loadVideoFile(file, 'Loading downloaded video');
    state.exportPath = file.outputDirectory;
    updateProgress({ ratio: 1 });
    elements.showOutputButton.hidden = false;
  } catch (error) {
    setStatus(error.message || 'Download failed');
    elements.progressLabel.textContent = 'Failed';
  } finally {
    removeProgressListener();
    setBusy(false);
  }
}

async function exportSelection() {
  if (!state.file || !state.duration || state.isBusy) {
    return;
  }

  const durationSeconds = state.end - state.start;
  if (durationSeconds < MIN_CLIP_SECONDS) {
    setStatus('Selection is too short');
    return;
  }

  const outputPath = await window.vidClip.chooseExportPath({ sourcePath: state.file.path });
  if (!outputPath) {
    return;
  }

  const removeProgressListener = window.vidClip.onExportProgress(updateProgress);

  try {
    setBusy(true, 'export');
    elements.showOutputButton.hidden = true;
    elements.exportProgress.value = 0;
    elements.progressLabel.textContent = '0%';
    setStatus('Exporting clip');

    const result = await window.vidClip.exportClip({
      inputPath: state.file.path,
      outputPath,
      startSeconds: state.start,
      durationSeconds,
      encodingMode: getEncodingMode()
    });

    state.exportPath = result.outputPath;
    updateProgress({ ratio: 1 });
    setStatus(`Export complete${getEncodingSummary(result)}`);
    elements.showOutputButton.hidden = false;
  } catch (error) {
    setStatus(error.message || 'Export failed');
    elements.progressLabel.textContent = 'Failed';
  } finally {
    removeProgressListener();
    setBusy(false);
  }
}

async function splitIntoClips() {
  if (!state.file || !state.duration || state.isBusy) {
    return;
  }

  const removeProgressListener = window.vidClip.onExportProgress(updateProgress);

  try {
    setBusy(true, 'split');
    elements.showOutputButton.hidden = true;
    elements.exportProgress.value = 0;
    elements.progressLabel.textContent = '0%';
    setStatus('Splitting into 15s clips');

    const result = await window.vidClip.splitIntoClips({
      inputPath: state.file.path,
      durationSeconds: state.duration,
      encodingMode: getEncodingMode()
    });

    state.exportPath = result.outputDirectory;
    updateProgress({ ratio: 1 });
    setStatus(`Created ${result.clipCount} clips${getEncodingSummary(result)}`);
    elements.showOutputButton.hidden = false;
  } catch (error) {
    setStatus(error.message || 'Split failed');
    elements.progressLabel.textContent = 'Failed';
  } finally {
    removeProgressListener();
    setBusy(false);
  }
}

function bindEvents() {
  elements.openButton.addEventListener('click', openVideo);
  elements.urlForm.addEventListener('submit', downloadFromUrl);
  elements.exportButton.addEventListener('click', exportSelection);
  elements.splitButton.addEventListener('click', splitIntoClips);
  elements.previewButton.addEventListener('click', previewSelection);
  elements.setStartButton.addEventListener('click', setStartToCurrentTime);
  elements.setEndButton.addEventListener('click', setEndToCurrentTime);
  elements.showOutputButton.addEventListener('click', () => {
    if (state.exportPath) {
      window.vidClip.showOutput(state.exportPath);
    }
  });

  elements.startSlider.addEventListener('input', (event) => setStartFromValue(event.target.value));
  elements.endSlider.addEventListener('input', (event) => setEndFromValue(event.target.value));
  elements.startInput.addEventListener('change', (event) => setStartFromValue(event.target.value));
  elements.endInput.addEventListener('change', (event) => setEndFromValue(event.target.value));
  elements.lengthInput.addEventListener('change', (event) => setLengthFromValue(event.target.value));

  elements.video.addEventListener('loadedmetadata', handleMetadataLoaded);
  elements.video.addEventListener('timeupdate', handleTimeUpdate);
  elements.video.addEventListener('error', () => {
    setStatus('Video preview failed');
    setControlsEnabled(false);
  });
}

bindEvents();
resetProgress();
setControlsEnabled(false);
loadEncodingCapabilities();
loadDownloaderStatus();
