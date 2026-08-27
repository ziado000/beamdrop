/* Beamdrop sender: file -> fountain packets -> animated color-shifting code. */
(function () {
  'use strict';

  const drop = document.getElementById('drop');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fName = document.getElementById('fName');
  const fMeta = document.getElementById('fMeta');
  const estimate = document.getElementById('estimate');
  const startBtn = document.getElementById('startBtn');
  const setup = document.getElementById('setup');
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('beam');
  const ctx = canvas.getContext('2d');
  const cycleFill = document.getElementById('cycleFill');
  const statLeft = document.getElementById('statLeft');
  const statRight = document.getElementById('statRight');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');

  const AURORA_COLS = [26, 34, 42];
  const CLASSIC_CHUNK = [200, 450, 800];

  let file = null;
  let fileBytes = null;
  let mode = 'aurora';
  let density = 1;
  let fps = 8;
  let encoder = null;
  let timer = null;
  let paused = false;
  let framesSent = 0;

  function currentChunk() {
    if (mode === 'aurora') return HexCodec.capacityFor(AURORA_COLS[density]) - 19;
    return CLASSIC_CHUNK[density];
  }

  // ---- setup UI ----
  function segInit(id, onPick) {
    const seg = document.getElementById(id);
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      seg.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      onPick(btn.dataset.v);
      updateEstimate();
    });
  }
  segInit('modeSeg', (v) => { mode = v; });
  segInit('densitySeg', (v) => { density = Number(v); });
  segInit('speedSeg', (v) => { fps = Number(v); });

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files[0]) pickFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) pickFile(fileInput.files[0]); });

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  async function pickFile(f) {
    file = f;
    fileBytes = new Uint8Array(await f.arrayBuffer());
    fName.textContent = f.name;
    fMeta.textContent = fmtSize(f.size) + (f.type ? ' · ' + f.type : '');
    fileInfo.classList.remove('hidden');
    startBtn.disabled = false;
    updateEstimate();
  }

  function updateEstimate() {
    if (!fileBytes) { estimate.textContent = ''; return; }
    const chunk = currentChunk();
    const K = Math.max(1, Math.ceil((fileBytes.length + 100) / chunk));
    const secs = Math.ceil(K / fps);
    const rate = ((chunk * fps) / 1024).toFixed(1);
    estimate.textContent = `≈ ${K} frames per pass · about ${secs}s per pass at ${fps} fps (${rate} KB/s). ` +
      `Bigger files or Compact density mean longer scans — that's the tradeoff.`;
  }

  // ---- beaming ----
  startBtn.addEventListener('click', () => {
    encoder = Fountain.createEncoder(fileBytes, {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
    }, currentChunk());
    framesSent = 0;
    paused = false;
    pauseBtn.textContent = 'Pause';
    setup.classList.add('hidden');
    stage.classList.remove('hidden');
    schedule();
  });

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) schedule();
  });

  stopBtn.addEventListener('click', () => {
    clearTimeout(timer);
    encoder = null;
    stage.classList.add('hidden');
    setup.classList.remove('hidden');
  });

  function schedule() {
    clearTimeout(timer);
    if (!encoder || paused) return;
    drawNextFrame();
    timer = setTimeout(schedule, 1000 / fps);
  }

  function bytesToLatin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 4096) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
    }
    return s;
  }

  function drawNextFrame() {
    const packet = encoder.nextPacket();
    framesSent++;

    if (mode === 'aurora') {
      const buf = HexCodec.render(packet, AURORA_COLS[density], (framesSent * 11) % 360);
      ctx.putImageData(new ImageData(buf, HexCodec.CANVAS, HexCodec.CANVAS), 0, 0);
    } else {
      const qr = qrcode(0, 'L');
      qr.addData(bytesToLatin1(packet), 'Byte');
      qr.make();
      renderArtFrame(qr, framesSent);
    }

    const K = encoder.K;
    const pass = Math.floor((framesSent - 1) / K) + 1;
    const inPass = ((framesSent - 1) % K) + 1;
    cycleFill.style.width = ((inPass / K) * 100).toFixed(1) + '%';
    statLeft.textContent = `pass ${pass} · frame ${inPass}/${K}`;
    statRight.textContent = `${framesSent} frames beamed`;
  }

  /*
   * The art pass: each frame gets its own hue, data modules are drawn as soft
   * rounded dots, and a progress ring orbits the code. Dark/light luminance is
   * pinned (16% vs 95%) so every hue stays decodable.
   */
  function renderArtFrame(qr, frameNo) {
    const n = qr.getModuleCount();
    const hue = (frameNo * 47) % 360;
    const size = canvas.width;
    const quiet = 5; // quiet-zone modules
    const cell = size / (n + quiet * 2);
    const origin = quiet * cell;

    const light = `hsl(${hue}, 55%, 95%)`;
    const light2 = `hsl(${(hue + 40) % 360}, 60%, 92%)`;
    const dark = `hsl(${hue}, 65%, 16%)`;

    // background: a soft two-tone gradient in this frame's hue
    const bg = ctx.createLinearGradient(0, 0, size, size);
    bg.addColorStop(0, light);
    bg.addColorStop(1, light2);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, size, size);

    // finder patterns drawn solid (decoders lock onto these — keep them crisp)
    ctx.fillStyle = dark;
    const inFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        const x = origin + c * cell;
        const y = origin + r * cell;
        if (inFinder(r, c)) {
          ctx.fillRect(x - 0.5, y - 0.5, cell + 1, cell + 1);
        } else {
          // data modules as rounded dots, slightly inset for the woven look
          const pad = cell * 0.08;
          roundRect(x + pad, y + pad, cell - pad * 2, cell - pad * 2, cell * 0.32);
        }
      }
    }

    // orbiting progress ring in the quiet zone's outer edge
    const K = encoder.K;
    const frac = (((frameNo - 1) % K) + 1) / K;
    ctx.lineWidth = cell * 0.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = `hsla(${hue}, 70%, 45%, 0.35)`;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - cell * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `hsl(${(hue + 180) % 360}, 75%, 45%)`;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - cell * 0.6, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fill();
  }
})();
