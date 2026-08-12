(() => {
  const video = document.getElementById('video');
  const canvas = document.getElementById('output');
  const ctx = canvas.getContext('2d');
  const procCanvas = document.getElementById('proc');
  const procCtx = procCanvas.getContext('2d');
  const placeholder = document.getElementById('placeholder');
  const statusEl = document.getElementById('status');
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const demoBtn = document.getElementById('demoBtn');

  const PROC_W = 320;
  const PROC_H = 240;
  procCanvas.width = PROC_W;
  procCanvas.height = PROC_H;

  const REVEAL_MS = 3000; // how long the swapped card stays on screen
  const COOLDOWN_MS = 1500; // pause after a reveal before scanning resumes
  const HISTORY_SIZE = 10;
  const HITS_NEEDED = 7;

  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SUITS = [
    { symbol: '♠', color: '#111111' }, // spades
    { symbol: '♥', color: '#d21f3c' }, // hearts
    { symbol: '♦', color: '#d21f3c' }, // diamonds
    { symbol: '♣', color: '#111111' }, // clubs
  ];

  let stream = null;
  let cvReady = false;
  let running = false;
  let rafId = null;

  // 'scanning' | 'revealing' | 'cooldown'
  let state = 'scanning';
  let revealStart = 0;
  let cooldownStart = 0;
  let detectHistory = [];
  let currentOverlay = null;
  let overlayCardCanvas = null;

  function setStatus(msg) {
    statusEl.textContent = msg;
  }

  let cvLoadSettled = false;

  window.onOpenCvReady = function onOpenCvReady() {
    if (cvLoadSettled) return;
    cvLoadSettled = true;
    cvReady = true;
    startBtn.disabled = false;
    setStatus('Ready. Click "Start Camera" to begin.');
  };

  // If the OpenCV.js CDN is slow, blocked, or fails outright, don't leave the
  // page stuck with a disabled Start button forever — fall back to
  // camera-only mode where the "Trigger Effect (demo)" button still works.
  setTimeout(() => {
    if (cvLoadSettled) return;
    cvLoadSettled = true;
    cvReady = false;
    startBtn.disabled = false;
    setStatus('Auto-detection engine unavailable — camera still works (use the demo button for the effect).');
  }, 8000);

  startBtn.addEventListener('click', startCamera);
  stopBtn.addEventListener('click', stopCamera);
  demoBtn.addEventListener('click', () => {
    if (!running) return;
    const w = canvas.width * 0.35;
    const h = w * 1.4;
    triggerReveal(
      { x: canvas.width / 2 - w / 2, y: canvas.height / 2 - h / 2, w, h },
      performance.now()
    );
  });

  async function startCamera() {
    try {
      setStatus('Requesting camera access…');
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();

      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;

      placeholder.classList.add('hidden');
      running = true;
      state = 'scanning';
      detectHistory = [];
      startBtn.disabled = true;
      stopBtn.disabled = false;
      demoBtn.disabled = false;
      setStatus(
        cvReady
          ? 'Scanning for a poker card…'
          : 'Camera live. Auto-detection unavailable — use the demo button for the effect.'
      );
      rafId = requestAnimationFrame(loop);
    } catch (err) {
      setStatus('Camera error: ' + err.message);
    }
  }

  function stopCamera() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    state = 'scanning';
    currentOverlay = null;
    startBtn.disabled = !cvReady;
    stopBtn.disabled = true;
    demoBtn.disabled = true;
    placeholder.classList.remove('hidden');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setStatus('Camera stopped.');
  }

  function loop(ts) {
    if (!running) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    if (state === 'scanning' && cvReady) {
      const det = detectCard();
      handleDetection(det, ts);
    } else if (state === 'revealing') {
      drawOverlay(ts);
      if (ts - revealStart > REVEAL_MS) {
        state = 'cooldown';
        cooldownStart = ts;
        currentOverlay = null;
        setStatus('Effect finished. Back to normal camera…');
      }
    } else if (state === 'cooldown') {
      if (ts - cooldownStart > COOLDOWN_MS) {
        state = 'scanning';
        detectHistory = [];
        setStatus('Scanning for a poker card…');
      }
    }

    rafId = requestAnimationFrame(loop);
  }

  // Finds the most card-like quadrilateral in the current video frame.
  // Returns { x, y, w, h } in output-canvas coordinates, or null.
  function detectCard() {
    procCtx.drawImage(video, 0, 0, PROC_W, PROC_H);

    let src, gray, edges, kernel, contours, hierarchy;
    let best = null;

    try {
      src = cv.imread(procCanvas);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);

      edges = new cv.Mat();
      cv.Canny(gray, edges, 50, 150);
      kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.dilate(edges, edges, kernel);

      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      const frameArea = PROC_W * PROC_H;
      const minArea = frameArea * 0.03;
      const maxArea = frameArea * 0.65;
      let bestArea = 0;

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cv.contourArea(cnt);

        if (area > minArea && area < maxArea) {
          const approx = new cv.Mat();
          const peri = cv.arcLength(cnt, true);
          cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            const rect = cv.boundingRect(cnt);
            const ratio = Math.max(rect.width, rect.height) / Math.max(1, Math.min(rect.width, rect.height));
            // Standard poker card ratio is ~1.4 (either orientation).
            if (ratio > 1.15 && ratio < 1.9 && area > bestArea) {
              bestArea = area;
              best = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
            }
          }
          approx.delete();
        }
        cnt.delete();
      }
    } finally {
      if (src) src.delete();
      if (gray) gray.delete();
      if (edges) edges.delete();
      if (kernel) kernel.delete();
      if (contours) contours.delete();
      if (hierarchy) hierarchy.delete();
    }

    if (!best) return null;

    const scaleX = canvas.width / PROC_W;
    const scaleY = canvas.height / PROC_H;
    return {
      x: best.x * scaleX,
      y: best.y * scaleY,
      w: best.w * scaleX,
      h: best.h * scaleY,
    };
  }

  function handleDetection(det, ts) {
    detectHistory.push(det);
    if (detectHistory.length > HISTORY_SIZE) detectHistory.shift();

    const hits = detectHistory.filter(Boolean);
    if (hits.length < HITS_NEEDED) {
      setStatus('Scanning for a poker card…');
      return;
    }

    const centersX = hits.map((h) => h.x + h.w / 2);
    const centersY = hits.map((h) => h.y + h.h / 2);
    const spreadX = Math.max(...centersX) - Math.min(...centersX);
    const spreadY = Math.max(...centersY) - Math.min(...centersY);

    if (spreadX < canvas.width * 0.15 && spreadY < canvas.height * 0.15) {
      triggerReveal(hits[hits.length - 1], ts);
    } else {
      setStatus('Card detected — hold it steady…');
    }
  }

  function triggerReveal(rect, ts) {
    const rank = RANKS[Math.floor(Math.random() * RANKS.length)];
    const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
    overlayCardCanvas = renderCard(rank, suit);
    currentOverlay = rect;
    state = 'revealing';
    revealStart = ts;
    detectHistory = [];
    setStatus(`✨ It's now the ${rank}${suit.symbol}!`);
  }

  function drawOverlay(ts) {
    if (!currentOverlay || !overlayCardCanvas) return;
    const t = (ts - revealStart) / REVEAL_MS;
    let alpha = 1;
    if (t > 0.8) alpha = Math.max(0, 1 - (t - 0.8) / 0.2);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(255, 213, 74, 0.9)';
    ctx.shadowBlur = 25;
    ctx.drawImage(overlayCardCanvas, currentOverlay.x, currentOverlay.y, currentOverlay.w, currentOverlay.h);
    ctx.restore();
  }

  function renderCard(rank, suit) {
    const w = 240;
    const h = 336;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const cx = c.getContext('2d');

    roundRectPath(cx, 2, 2, w - 4, h - 4, 18);
    cx.fillStyle = '#fdfdfd';
    cx.fill();
    cx.lineWidth = 3;
    cx.strokeStyle = '#c9c9c9';
    cx.stroke();

    cx.fillStyle = suit.color;
    cx.textBaseline = 'top';
    cx.textAlign = 'left';
    cx.font = 'bold 30px sans-serif';
    cx.fillText(rank, 16, 12);
    cx.font = '26px sans-serif';
    cx.fillText(suit.symbol, 16, 48);

    cx.save();
    cx.translate(w - 16, h - 12);
    cx.rotate(Math.PI);
    cx.textAlign = 'left';
    cx.textBaseline = 'top';
    cx.font = 'bold 30px sans-serif';
    cx.fillText(rank, 0, 0);
    cx.font = '26px sans-serif';
    cx.fillText(suit.symbol, 0, 36);
    cx.restore();

    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.font = '140px sans-serif';
    cx.fillText(suit.symbol, w / 2, h / 2 + 12);

    return c;
  }

  function roundRectPath(cx, x, y, w, h, r) {
    cx.beginPath();
    cx.moveTo(x + r, y);
    cx.arcTo(x + w, y, x + w, y + h, r);
    cx.arcTo(x + w, y + h, x, y + h, r);
    cx.arcTo(x, y + h, x, y, r);
    cx.arcTo(x, y, x + w, y, r);
    cx.closePath();
  }
})();
