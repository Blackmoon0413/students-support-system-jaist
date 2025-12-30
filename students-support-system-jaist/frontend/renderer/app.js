const pdfInput = document.getElementById('pdfInput');
const pdfCanvas = document.getElementById('pdfCanvas');
const heatmapCanvas = document.getElementById('heatmapCanvas');
const explanation = document.getElementById('explanation');
const startCamBtn = document.getElementById('startCam');
const calibrateBtn = document.getElementById('calibrateBtn');
const clearHeatmapBtn = document.getElementById('clearHeatmapBtn');
const exportHeatmapBtn = document.getElementById('exportHeatmapBtn');
const ocrBtn = document.getElementById('ocrBtn');
const ocrText = document.getElementById('ocrText');
const calibrationDot = document.getElementById('calibrationDot');
const calibrationText = document.getElementById('calibrationText');
const calibrationProgress = document.getElementById('calibrationProgress');

const pdfCtx = pdfCanvas.getContext('2d');
const heatCtx = heatmapCanvas.getContext('2d');

let pdfDoc = null;
let currentPage = 1;
let viewportScale = 1.2;
let gazeTimer = null;
let polling = false;
let pollDelay = 200;
let failureCount = 0;
let heatRenderTimer = null;
let lastGaze = { x: 0.5, y: 0.4 };
let ocrTimer = null;
let ocrInFlight = false;

const heatPoints = [];
const maxHeatPoints = 250;
const decayDurationMs = 5000;
const ocrIntervalMs = 2000;
const ocrRegion = { width: 240, height: 140 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(message, isError = false) {
  explanation.textContent = message;
  explanation.classList.toggle('error', isError);
}

function resetHeatmap() {
  heatCtx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height);
  heatPoints.length = 0;
}

async function renderPage(pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: viewportScale });

  pdfCanvas.width = viewport.width;
  pdfCanvas.height = viewport.height;
  heatmapCanvas.width = viewport.width;
  heatmapCanvas.height = viewport.height;

  const renderContext = {
    canvasContext: pdfCtx,
    viewport
  };

  await page.render(renderContext).promise;
  resetHeatmap();
  drawHeatPoint(viewport.width * lastGaze.x, viewport.height * lastGaze.y, true);
  ensureHeatmapRenderLoop();
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function drawHeatPoint(x, y, clear = false) {
  if (heatmapCanvas.width === 0 || heatmapCanvas.height === 0) {
    return;
  }

  if (clear) {
    resetHeatmap();
  }

  heatPoints.push({ x, y, t: Date.now() });
  if (heatPoints.length > maxHeatPoints) {
    heatPoints.shift();
  }

  renderHeatmap();
}

function renderHeatmap() {
  if (heatmapCanvas.width === 0 || heatmapCanvas.height === 0) {
    return;
  }

  const now = Date.now();
  heatCtx.clearRect(0, 0, heatmapCanvas.width, heatmapCanvas.height);

  for (let i = heatPoints.length - 1; i >= 0; i -= 1) {
    const point = heatPoints[i];
    const age = now - point.t;
    if (age > decayDurationMs) {
      heatPoints.splice(i, 1);
      continue;
    }

    const decay = 1 - age / decayDurationMs;
    const alpha = 0.4 * decay;
    const radius = 60 * (0.6 + 0.4 * decay);
    const gradient = heatCtx.createRadialGradient(point.x, point.y, 5, point.x, point.y, radius);
    gradient.addColorStop(0, `rgba(255, 0, 0, ${alpha})`);
    gradient.addColorStop(1, 'rgba(255, 0, 0, 0)');
    heatCtx.fillStyle = gradient;
    heatCtx.beginPath();
    heatCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    heatCtx.fill();
  }
}

function ensureHeatmapRenderLoop() {
  if (heatRenderTimer) {
    return;
  }

  heatRenderTimer = setInterval(renderHeatmap, 120);
}

function updateCalibrationProgress(samples, total = 5) {
  const safeSamples = Math.min(samples, total);
  calibrationText.textContent = `${safeSamples}/${total}`;
  calibrationProgress.style.width = `${(safeSamples / total) * 100}%`;
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function exportHeatmapSnapshot() {
  if (!pdfCanvas.width || !pdfCanvas.height) {
    setStatus('Load a PDF before exporting.', true);
    return;
  }

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = pdfCanvas.width;
  exportCanvas.height = pdfCanvas.height;
  const exportCtx = exportCanvas.getContext('2d');

  exportCtx.drawImage(pdfCanvas, 0, 0);
  exportCtx.drawImage(heatmapCanvas, 0, 0);

  const dataUrl = exportCanvas.toDataURL('image/png');
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = `heatmap-${formatTimestamp(new Date())}.png`;
  link.click();

  setStatus('Heatmap exported.');
}

function getFocusRect() {
  const width = ocrRegion.width;
  const height = ocrRegion.height;
  const centerX = heatmapCanvas.width * lastGaze.x;
  const centerY = heatmapCanvas.height * lastGaze.y;

  const x = clamp(Math.round(centerX - width / 2), 0, heatmapCanvas.width - width);
  const y = clamp(Math.round(centerY - height / 2), 0, heatmapCanvas.height - height);

  return { x, y, width, height };
}

function captureFocusRegion() {
  if (!pdfCanvas.width || !pdfCanvas.height) {
    return null;
  }

  const rect = getFocusRect();
  const offscreen = document.createElement('canvas');
  offscreen.width = rect.width;
  offscreen.height = rect.height;
  const ctx = offscreen.getContext('2d');
  ctx.drawImage(
    pdfCanvas,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    rect.width,
    rect.height
  );

  return offscreen.toDataURL('image/png');
}

async function requestOcr() {
  if (ocrInFlight) {
    return;
  }

  const dataUrl = captureFocusRegion();
  if (!dataUrl) {
    ocrText.textContent = 'Load a PDF before OCR.';
    return;
  }

  ocrInFlight = true;
  try {
    const response = await fetch('http://127.0.0.1:8000/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: dataUrl })
    });

    if (!response.ok) {
      throw new Error('OCR backend error');
    }

    const data = await response.json();
    const text = (data.text || '').trim();
    ocrText.textContent = text ? text : 'No text detected.';
  } catch (error) {
    ocrText.textContent = 'OCR failed. Check backend and Tesseract install.';
  } finally {
    ocrInFlight = false;
  }
}

function startOcrLoop() {
  if (ocrTimer) {
    return;
  }

  ocrTimer = setInterval(requestOcr, ocrIntervalMs);
}

function stopOcrLoop() {
  if (!ocrTimer) {
    return;
  }

  clearInterval(ocrTimer);
  ocrTimer = null;
}

async function fetchGazePoint() {
  try {
    const response = await fetch('http://127.0.0.1:8000/gaze');
    if (!response.ok) {
      throw new Error('Backend error');
    }

    const data = await response.json();
    const x = typeof data.x === 'number' ? data.x : lastGaze.x;
    const y = typeof data.y === 'number' ? data.y : lastGaze.y;

    lastGaze = {
      x: clamp(x, 0, 1),
      y: clamp(y, 0, 1)
    };

    drawHeatPoint(heatmapCanvas.width * lastGaze.x, heatmapCanvas.height * lastGaze.y);

    const calStatus = data.calibrated ? 'calibrated' : 'uncalibrated';
    setStatus(`Gaze: x=${lastGaze.x.toFixed(2)}, y=${lastGaze.y.toFixed(2)} (${calStatus})`);

    failureCount = 0;
    pollDelay = 200;
  } catch (error) {
    failureCount += 1;
    pollDelay = Math.min(1000 + failureCount * 200, 2000);
    setStatus('Backend not reachable: http://127.0.0.1:8000/gaze', true);
  }
}

async function pollGazeLoop() {
  if (!polling) {
    return;
  }

  await fetchGazePoint();
  gazeTimer = setTimeout(pollGazeLoop, pollDelay);
}

function startGazePolling() {
  if (polling) {
    return;
  }

  polling = true;
  setStatus('Connecting to backend...');
  pollGazeLoop();
  startCamBtn.textContent = 'Stop Camera';
  startOcrLoop();
}

function stopGazePolling() {
  if (!polling) {
    return;
  }

  polling = false;
  if (gazeTimer) {
    clearTimeout(gazeTimer);
    gazeTimer = null;
  }

  startCamBtn.textContent = 'Start Camera';
  setStatus('Camera polling stopped.');
  stopOcrLoop();
}

function setCalibrationDot(x, y, visible) {
  if (!visible) {
    calibrationDot.style.display = 'none';
    return;
  }

  calibrationDot.style.display = 'block';
  calibrationDot.style.left = `${x}px`;
  calibrationDot.style.top = `${y}px`;
}

async function runCalibration() {
  if (!heatmapCanvas.width || !heatmapCanvas.height) {
    setStatus('Load a PDF before calibration.', true);
    return;
  }

  try {
    const startResp = await fetch('http://127.0.0.1:8000/calibrate/start', {
      method: 'POST'
    });

    if (!startResp.ok) {
      throw new Error('Calibration start failed');
    }

    const points = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.5, y: 0.5 },
      { x: 0.1, y: 0.9 },
      { x: 0.9, y: 0.9 }
    ];

    updateCalibrationProgress(0);
    setStatus('Calibration started. Please look at each dot.');

    let captured = 0;

    for (const point of points) {
      const px = heatmapCanvas.width * point.x;
      const py = heatmapCanvas.height * point.y;
      setCalibrationDot(px, py, true);
      await sleep(700);

      const resp = await fetch('http://127.0.0.1:8000/calibrate/point', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(point)
      });

      if (!resp.ok) {
        throw new Error('Calibration point failed');
      }

      captured += 1;
      updateCalibrationProgress(captured);
      await sleep(300);
    }

    setCalibrationDot(0, 0, false);
    setStatus('Calibration complete. You can start the camera.');
  } catch (error) {
    setCalibrationDot(0, 0, false);
    updateCalibrationProgress(0);
    setStatus('Calibration failed. Is the backend running?', true);
  }
}

clearHeatmapBtn.addEventListener('click', () => {
  resetHeatmap();
  setStatus('Heatmap cleared.');
});

exportHeatmapBtn.addEventListener('click', () => {
  exportHeatmapSnapshot();
});

ocrBtn.addEventListener('click', () => {
  requestOcr();
});

pdfInput.addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const data = new Uint8Array(await file.arrayBuffer());
  pdfDoc = await pdfjsLib.getDocument({ data }).promise;
  currentPage = 1;
  await renderPage(currentPage);
});

startCamBtn.addEventListener('click', () => {
  if (polling) {
    stopGazePolling();
  } else {
    startGazePolling();
  }
});

calibrateBtn.addEventListener('click', () => {
  runCalibration();
});
