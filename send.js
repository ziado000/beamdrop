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

  let file = null;
  let fileBytes = null;
  let density = 1;
  let fps = 8;
  let encoder = null;
  let timer = null;
  let paused = false;
  let framesSent = 0;

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
    fMeta.textContent = fmtSize(f.size) + (f.type ? ' Â· ' + f.type : '');
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
    estimate.textContent = `â‰ˆ ${K} frames per pass Â· about ${secs}s per pass at ${fps} fps (${rate} KB/s). ` +
      `Bigger files or Compact density mean longer scans â€” that's the tradeoff.`;
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

  function drawNextFrame() {
    const packet = encoder.nextPacket();
    framesSent++;
    const buf = HexCodec.render(packet, AURORA_COLS[density], (framesSent * 11) % 360);
    ctx.putImageData(new ImageData(buf, HexCodec.CANVAS, HexCodec.CANVAS), 0, 0);

    const K = encoder.K;
    const pass = Math.floor((framesSent - 1) / K) + 1;
    const inPass = ((framesSent - 1) % K) + 1;
    cycleFill.style.width = ((inPass / K) * 100).toFixed(1) + '%';
    statLeft.textContent = `pass ${pass} Â· frame ${inPass}/${K}`;
    statRight.textContent = `${framesSent} frames beamed`;
  }

})();
