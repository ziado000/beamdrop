/* Beamdrop sender: file -> fountain packets -> animated aurora honeycombs. */
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

  let file = null;
  let fileBytes = null;
  let density = 1;
  let fps = 8;
  let tiles = 1;
  let encoder = null;
  let timer = null;
  let paused = false;
  let packetsSent = 0;

  function currentChunk() {
    return HexCodec.capacityFor(AURORA_COLS[density]) - 19;
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
  segInit('densitySeg', (v) => { density = Number(v); });
  segInit('speedSeg', (v) => { fps = Number(v); });
  segInit('tilesSeg', (v) => { tiles = Number(v); });

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
    const secs = Math.ceil(K / (fps * tiles));
    const rate = ((chunk * fps * tiles) / 1024).toFixed(1);
    estimate.textContent = `≈ ${K} pieces · about ${secs}s per pass at ${fps} fps × ${tiles} tile${tiles > 1 ? 's' : ''} (${rate} KB/s). ` +
      `Bigger files or Compact density mean longer scans — that's the tradeoff.`;
  }

  // ---- beaming ----
  startBtn.addEventListener('click', () => {
    encoder = Fountain.createEncoder(fileBytes, {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
    }, currentChunk());
    packetsSent = 0;
    paused = false;
    pauseBtn.textContent = 'Pause';
    const S = HexCodec.CANVAS;
    canvas.width = tiles >= 2 ? S * 2 : S;
    canvas.height = tiles === 4 ? S * 2 : S;
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

  const TILE_POS = { 1: [[0, 0]], 2: [[0, 0], [1, 0]], 4: [[0, 0], [1, 0], [0, 1], [1, 1]] };

  function drawNextFrame() {
    const S = HexCodec.CANVAS;
    for (const [tx, ty] of TILE_POS[tiles]) {
      const packet = encoder.nextPacket();
      packetsSent++;
      const buf = HexCodec.render(packet, AURORA_COLS[density], (packetsSent * 11) % 360);
      ctx.putImageData(new ImageData(buf, S, S), tx * S, ty * S);
    }

    const K = encoder.K;
    const pass = Math.floor((packetsSent - 1) / K) + 1;
    const inPass = ((packetsSent - 1) % K) + 1;
    cycleFill.style.width = ((inPass / K) * 100).toFixed(1) + '%';
    statLeft.textContent = `pass ${pass} · piece ${inPass}/${K}`;
    statRight.textContent = `${packetsSent} packets beamed`;
  }
})();
