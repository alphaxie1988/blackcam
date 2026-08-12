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
    { symbol: '♠', color: '#1a1a1a' }, // spades
    { symbol: '♥', color: '#b3122b' }, // hearts
    { symbol: '♦', color: '#b3122b' }, // diamonds
    { symbol: '♣', color: '#1a1a1a' }, // clubs
  ];

  // Fractional (x, y) positions of pips for number cards, laid out roughly
  // like a real deck: top half upright, bottom half rotated 180deg.
  const PIP_LAYOUTS = {
    '2': [[0.5, 0.18], [0.5, 0.82]],
    '3': [[0.5, 0.18], [0.5, 0.5], [0.5, 0.82]],
    '4': [[0.3, 0.18], [0.7, 0.18], [0.3, 0.82], [0.7, 0.82]],
    '5': [[0.3, 0.18], [0.7, 0.18], [0.5, 0.5], [0.3, 0.82], [0.7, 0.82]],
    '6': [[0.3, 0.18], [0.7, 0.18], [0.3, 0.5], [0.7, 0.5], [0.3, 0.82], [0.7, 0.82]],
    '7': [[0.3, 0.18], [0.7, 0.18], [0.5, 0.34], [0.3, 0.5], [0.7, 0.5], [0.3, 0.82], [0.7, 0.82]],
    '8': [[0.3, 0.18], [0.7, 0.18], [0.5, 0.34], [0.3, 0.5], [0.7, 0.5], [0.5, 0.66], [0.3, 0.82], [0.7, 0.82]],
    '9': [[0.3, 0.16], [0.7, 0.16], [0.3, 0.38], [0.7, 0.38], [0.5, 0.5], [0.3, 0.62], [0.7, 0.62], [0.3, 0.84], [0.7, 0.84]],
    '10': [[0.3, 0.14], [0.7, 0.14], [0.5, 0.28], [0.3, 0.42], [0.7, 0.42], [0.3, 0.58], [0.7, 0.58], [0.5, 0.72], [0.3, 0.86], [0.7, 0.86]],
  };

  let stream = null;
  let cvReady = false;
  let running = false;
  let rafId = null;

  // 'scanning' | 'revealing' | 'cooldown'
  let state = 'scanning';
  let revealStart = 0;
  let cooldownStart = 0;
  let detectHistory = [];
  let currentOverlay = null; // { quad: [tl,tr,br,bl], tint }
  let overlayCardCanvas = null;
  let noisePatternCanvas = null;

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
    triggerReveal({ quad: makeDemoQuad() }, performance.now());
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
  // Returns { x, y, w, h, quad } in output-canvas coordinates, or null.
  // quad is the 4 detected corners (unordered), which lets the overlay be
  // warped to match the real card's tilt instead of sitting axis-aligned.
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
              const quad = [];
              for (let k = 0; k < 4; k++) {
                quad.push({ x: approx.data32S[k * 2], y: approx.data32S[k * 2 + 1] });
              }
              best = { x: rect.x, y: rect.y, w: rect.width, h: rect.height, quad };
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
      quad: best.quad.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })),
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

  // Builds a randomly-tilted rectangle for the demo button, so it also
  // shows off the perspective warp instead of always sitting flat.
  function makeDemoQuad() {
    const w = canvas.width * 0.3;
    const h = w * 1.4;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const angle = (Math.random() - 0.5) * 0.5; // up to ~±14 degrees
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [
      { x: -w / 2, y: -h / 2 },
      { x: w / 2, y: -h / 2 },
      { x: w / 2, y: h / 2 },
      { x: -w / 2, y: h / 2 },
    ].map((p) => ({
      x: cx + p.x * cos - p.y * sin,
      y: cy + p.x * sin + p.y * cos,
    }));
  }

  // Sorts 4 unordered points into [topLeft, topRight, bottomRight, bottomLeft]
  // using the standard sum/difference heuristic.
  function orderQuad(pts) {
    const sums = pts.map((p) => p.x + p.y);
    const diffs = pts.map((p) => p.y - p.x);
    const tl = pts[sums.indexOf(Math.min(...sums))];
    const br = pts[sums.indexOf(Math.max(...sums))];
    const tr = pts[diffs.indexOf(Math.min(...diffs))];
    const bl = pts[diffs.indexOf(Math.max(...diffs))];
    return [tl, tr, br, bl];
  }

  function rectToQuad(rect) {
    return [
      { x: rect.x, y: rect.y },
      { x: rect.x + rect.w, y: rect.y },
      { x: rect.x + rect.w, y: rect.y + rect.h },
      { x: rect.x, y: rect.y + rect.h },
    ];
  }

  // Samples the average color currently showing in the detected region so the
  // overlaid card can be tinted to match the room's lighting instead of
  // looking like a flat, evenly-lit sticker.
  function sampleAmbientTint(quad) {
    const xs = quad.map((p) => p.x);
    const ys = quad.map((p) => p.y);
    const minX = Math.max(0, Math.floor(Math.min(...xs)));
    const minY = Math.max(0, Math.floor(Math.min(...ys)));
    const maxX = Math.min(canvas.width, Math.ceil(Math.max(...xs)));
    const maxY = Math.min(canvas.height, Math.ceil(Math.max(...ys)));
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);

    try {
      const data = ctx.getImageData(minX, minY, w, h).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let count = 0;
      const stride = 4 * 5; // sample every 5th pixel for speed
      for (let i = 0; i < data.length; i += stride) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }
      if (!count) return null;
      return { r: r / count, g: g / count, b: b / count };
    } catch (err) {
      return null;
    }
  }

  function triggerReveal(det, ts) {
    const quad = orderQuad(det.quad || rectToQuad(det));
    const rank = RANKS[Math.floor(Math.random() * RANKS.length)];
    const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
    overlayCardCanvas = renderCard(rank, suit);
    currentOverlay = { quad, tint: sampleAmbientTint(quad) };
    state = 'revealing';
    revealStart = ts;
    detectHistory = [];
    setStatus(`✨ It's now the ${rank}${suit.symbol}!`);
  }

  function drawOverlay(ts) {
    if (!currentOverlay || !overlayCardCanvas) return;
    const quad = currentOverlay.quad;
    const t = (ts - revealStart) / REVEAL_MS;

    let alpha = 1;
    if (t > 0.88) alpha = Math.max(0, 1 - (t - 0.88) / 0.12);

    // Soft contact shadow so the card doesn't look like it's floating flat
    // above the scene.
    ctx.save();
    ctx.globalAlpha = alpha * 0.35;
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#000000';
    fillQuadPath(ctx, quad);
    ctx.restore();

    // The card itself, perspective-warped to the real card's corners and
    // tinted to match the ambient lighting sampled at trigger time.
    ctx.save();
    ctx.globalAlpha = alpha;
    drawWarpedImage(ctx, overlayCardCanvas, quad);
    if (currentOverlay.tint) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = `rgba(${currentOverlay.tint.r}, ${currentOverlay.tint.g}, ${currentOverlay.tint.b}, 0.32)`;
      fillQuadPath(ctx, quad);
    }
    ctx.restore();

    // A quick flash at swap-in and swap-out sells the "sleight of hand"
    // instead of a persistent glow that reads as an obvious overlay.
    const flashIn = Math.max(0, 1 - t / 0.12);
    const flashOut = t > 0.85 ? Math.max(0, (t - 0.85) / 0.15) : 0;
    const flash = Math.max(flashIn, flashOut * 0.6);
    if (flash > 0.01) {
      ctx.save();
      ctx.globalAlpha = flash * 0.8;
      ctx.fillStyle = '#ffffff';
      fillQuadPath(ctx, quad);
      ctx.restore();
    }
  }

  function fillQuadPath(c, quad) {
    c.beginPath();
    c.moveTo(quad[0].x, quad[0].y);
    c.lineTo(quad[1].x, quad[1].y);
    c.lineTo(quad[2].x, quad[2].y);
    c.lineTo(quad[3].x, quad[3].y);
    c.closePath();
    c.fill();
  }

  // Draws `img` warped onto the destination quad [tl, tr, br, bl] by
  // splitting it into two triangles and affine-mapping each — a good visual
  // approximation of a full perspective warp using only Canvas 2D.
  function drawWarpedImage(c, img, quad) {
    const [tl, tr, br, bl] = quad;
    const w = img.width;
    const h = img.height;
    const sTl = { x: 0, y: 0 };
    const sTr = { x: w, y: 0 };
    const sBr = { x: w, y: h };
    const sBl = { x: 0, y: h };

    drawTriangleWarp(c, img, tl, tr, bl, sTl, sTr, sBl);
    drawTriangleWarp(c, img, tr, br, bl, sTr, sBr, sBl);
  }

  function drawTriangleWarp(c, img, d0, d1, d2, s0, s1, s2) {
    c.save();
    c.beginPath();
    c.moveTo(d0.x, d0.y);
    c.lineTo(d1.x, d1.y);
    c.lineTo(d2.x, d2.y);
    c.closePath();
    c.clip();

    const denom = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
    if (Math.abs(denom) > 1e-6) {
      const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / denom;
      const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / denom;
      const cc = ((s1.x - s0.x) * (d2.x - d0.x) - (s2.x - s0.x) * (d1.x - d0.x)) / denom;
      const d = ((s1.x - s0.x) * (d2.y - d0.y) - (s2.x - s0.x) * (d1.y - d0.y)) / denom;
      const e = d0.x - a * s0.x - cc * s0.y;
      const f = d0.y - b * s0.x - d * s0.y;
      c.transform(a, b, cc, d, e, f);
      c.drawImage(img, 0, 0);
    }
    c.restore();
  }

  function renderCard(rank, suit) {
    const w = 480;
    const h = 672;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');

    roundRectPath(g, 3, 3, w - 6, h - 6, 32);
    g.fillStyle = '#fdfcf8';
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.stroke();

    // Subtle diagonal paper sheen.
    g.save();
    roundRectPath(g, 3, 3, w - 6, h - 6, 32);
    g.clip();
    const sheen = g.createLinearGradient(0, 0, w, h);
    sheen.addColorStop(0, 'rgba(255,255,255,0.35)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.05)');
    g.fillStyle = sheen;
    g.fillRect(0, 0, w, h);
    g.restore();

    drawCornerIndex(g, rank, suit, 36, 26, false);
    drawCornerIndex(g, rank, suit, w - 36, h - 26, true);

    if (rank === 'A') {
      g.fillStyle = suit.color;
      g.font = `${Math.round(h * 0.32)}px Georgia, "Times New Roman", serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(suit.symbol, w / 2, h / 2 + h * 0.01);
    } else if (PIP_LAYOUTS[rank]) {
      const pipSize = Math.round(w * 0.15);
      g.fillStyle = suit.color;
      g.font = `${pipSize}px Georgia, "Times New Roman", serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const [fx, fy] of PIP_LAYOUTS[rank]) {
        g.save();
        g.translate(fx * w, fy * h);
        if (fy > 0.5) g.rotate(Math.PI);
        g.fillText(suit.symbol, 0, 0);
        g.restore();
      }
    } else {
      drawFaceCard(g, rank, suit, w, h);
    }

    // Fine paper grain.
    g.save();
    roundRectPath(g, 3, 3, w - 6, h - 6, 32);
    g.clip();
    g.globalAlpha = 0.05;
    g.globalCompositeOperation = 'overlay';
    g.drawImage(getNoisePattern(), 0, 0, w, h);
    g.restore();

    return c;
  }

  function drawCornerIndex(g, rank, suit, x, y, flipped) {
    const rankSize = rank.length > 1 ? 40 : 50;
    g.save();
    g.translate(x, y);
    if (flipped) g.rotate(Math.PI);
    g.fillStyle = suit.color;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.font = `bold ${rankSize}px Georgia, "Times New Roman", serif`;
    g.fillText(rank, 0, 0);
    g.font = '38px Georgia, "Times New Roman", serif';
    g.fillText(suit.symbol, 0, 42);
    g.restore();
  }

  function drawFaceCard(g, rank, suit, w, h) {
    const marginX = w * 0.16;
    const marginY = h * 0.14;

    g.save();
    g.strokeStyle = suit.color;
    g.lineWidth = 4;
    roundRectPath(g, marginX, marginY, w - marginX * 2, h - marginY * 2, 20);
    g.stroke();

    roundRectPath(g, marginX + 10, marginY + 10, w - (marginX + 10) * 2, h - (marginY + 10) * 2, 14);
    g.lineWidth = 1.5;
    g.stroke();

    const grad = g.createLinearGradient(0, marginY, 0, h - marginY);
    grad.addColorStop(0, hexWithAlpha(suit.color, 0.12));
    grad.addColorStop(1, hexWithAlpha(suit.color, 0.04));
    roundRectPath(g, marginX + 10, marginY + 10, w - (marginX + 10) * 2, h - (marginY + 10) * 2, 14);
    g.fillStyle = grad;
    g.fill();
    g.restore();

    g.fillStyle = suit.color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${Math.round(h * 0.26)}px Georgia, "Times New Roman", serif`;
    g.fillText(rank, w / 2, h * 0.42);
    g.font = `${Math.round(h * 0.13)}px Georgia, "Times New Roman", serif`;
    g.fillText(suit.symbol, w / 2, h * 0.64);
  }

  function hexWithAlpha(hex, alpha) {
    const v = hex.replace('#', '');
    const r = parseInt(v.substring(0, 2), 16);
    const g = parseInt(v.substring(2, 4), 16);
    const b = parseInt(v.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function getNoisePattern() {
    if (noisePatternCanvas) return noisePatternCanvas;
    const size = 128;
    const n = document.createElement('canvas');
    n.width = size;
    n.height = size;
    const nctx = n.getContext('2d');
    const imgData = nctx.createImageData(size, size);
    for (let i = 0; i < imgData.data.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 60;
      imgData.data[i] = v;
      imgData.data[i + 1] = v;
      imgData.data[i + 2] = v;
      imgData.data[i + 3] = 255;
    }
    nctx.putImageData(imgData, 0, 0);
    noisePatternCanvas = n;
    return n;
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
