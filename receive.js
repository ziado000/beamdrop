/* Beamdrop receiver: camera -> jsQR -> fountain decoder -> downloadable file. */
(function () {
  'use strict';

  const intro = document.getElementById('intro');
  const scan = document.getElementById('scan');
  const done = document.getElementById('done');
  const camBtn = document.getElementById('camBtn');
  const camError = document.getElementById('camError');
  const video = document.getElementById('cam');
  const grab = document.getElementById('grab');
  const gctx = grab.getContext('2d', { willReadFrequently: true });
  const rxFill = document.getElementById('rxFill');
  const rxLeft = document.getElementById('rxLeft');
  const rxRight = document.getElementById('rxRight');
  const cancelBtn = document.getElementById('cancelBtn');
  const doneName = document.getElementById('doneName');
  const doneMeta = document.getElementById('doneMeta');
  const preview = document.getElementById('preview');
  const dlBtn = document.getElementById('dlBtn');
  const againBtn = document.getElementById('againBtn');

  let stream = null;
  let decoder = null;
  let running = false;
  let packetsSeen = 0;
  let blobUrl = null;

  camBtn.addEventListener('click', start);
  cancelBtn.addEventListener('click', reset);
  againBtn.addEventListener('click', reset);

  async function start() {
    camError.textContent = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      camError.textContent = 'Camera unavailable: ' + err.message +
        ' — make sure you allowed camera access (needs HTTPS or localhost).';
      return;
    }
    video.srcObject = stream;
    await video.play();
    decoder = Fountain.createDecoder();
    packetsSeen = 0;
    running = true;
    intro.classList.add('hidden');
    done.classList.add('hidden');
    scan.classList.remove('hidden');
    requestAnimationFrame(tick);
  }

  function tick() {
    if (!running) return;
    if (video.readyState >= 2) {
      // Scan a downscaled frame — plenty for jsQR, much faster per frame.
      const scale = Math.min(1, 800 / video.videoWidth);
      const w = Math.round(video.videoWidth * scale);
      const h = Math.round(video.videoHeight * scale);
      if (grab.width !== w) { grab.width = w; grab.height = h; }
      gctx.drawImage(video, 0, 0, w, h);
      const img = gctx.getImageData(0, 0, w, h);
      // aurora honeycomb first; classic QR as fallback
      let packet = HexCodec.decodeFrame(img.data, w, h);
      if (!packet) {
        const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (code && code.binaryData && code.binaryData.length) packet = new Uint8Array(code.binaryData);
      }
      if (packet) {
        packetsSeen++;
        decoder.addPacket(packet);
        updateProgress();
        if (decoder.done) { finish(); return; }
      }
    }
    requestAnimationFrame(tick);
  }

  function updateProgress() {
    if (!decoder.K) return;
    const pct = (decoder.recovered / decoder.K) * 100;
    rxFill.style.width = pct.toFixed(1) + '%';
    rxLeft.textContent = `${decoder.recovered}/${decoder.K} pieces · ${pct.toFixed(0)}%`;
    rxRight.textContent = `${packetsSeen} frames caught`;
  }

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function finish() {
    running = false;
    stopCamera();
    const { meta, fileBytes } = decoder.result();
    const blob = new Blob([fileBytes], { type: meta.type || 'application/octet-stream' });
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(blob);

    doneName.textContent = meta.name;
    doneMeta.textContent = fmtSize(fileBytes.length) + (meta.type ? ' · ' + meta.type : '');
    dlBtn.href = blobUrl;
    dlBtn.download = meta.name;

    preview.innerHTML = '';
    if ((meta.type || '').startsWith('image/')) {
      const img = new Image();
      img.src = blobUrl;
      preview.appendChild(img);
    } else if ((meta.type || '').startsWith('video/')) {
      const v = document.createElement('video');
      v.src = blobUrl;
      v.controls = true;
      preview.appendChild(v);
    } else if ((meta.type || '').startsWith('audio/')) {
      const a = document.createElement('audio');
      a.src = blobUrl;
      a.controls = true;
      preview.appendChild(a);
    }

    scan.classList.add('hidden');
    done.classList.remove('hidden');
    dlBtn.click(); // auto-start the download; button stays for a retry
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    video.srcObject = null;
  }

  function reset() {
    running = false;
    stopCamera();
    decoder = null;
    rxFill.style.width = '0%';
    rxLeft.textContent = 'waiting for first frame…';
    rxRight.textContent = '';
    scan.classList.add('hidden');
    done.classList.add('hidden');
    intro.classList.remove('hidden');
  }
})();
