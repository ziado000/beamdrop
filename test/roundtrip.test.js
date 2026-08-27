/*
 * End-to-end offline pipeline test:
 *   bytes -> fountain encoder -> QR frame -> rasterized pixels (with the
 *   hue-shifting art palette) -> jsQR decode -> fountain decoder -> bytes.
 * Simulates a lossy camera by dropping frames at random.
 */
const path = require('path');
const qrcode = require(path.join(__dirname, '..', 'vendor', 'qrcode.js'));
const jsQR = require(path.join(__dirname, '..', 'vendor', 'jsQR.js'));
const Fountain = require(path.join(__dirname, '..', 'fountain.js'));

function bytesToLatin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 4096));
  }
  return s;
}

// Same hue math the browser renderer uses — verify every hue keeps enough
// contrast for the decoder.
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255].map(Math.round);
}

function rasterize(qr, hue, scale = 4, quiet = 4) {
  const n = qr.getModuleCount();
  const size = (n + quiet * 2) * scale;
  const dark = hslToRgb(hue, 65, 16);
  const light = hslToRgb(hue, 55, 95);
  const img = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mr = Math.floor(y / scale) - quiet;
      const mc = Math.floor(x / scale) - quiet;
      const isDark = mr >= 0 && mr < n && mc >= 0 && mc < n && qr.isDark(mr, mc);
      const [r, g, b] = isDark ? dark : light;
      const o = (y * size + x) * 4;
      img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = 255;
    }
  }
  return { img, size };
}

function run(fileSize, chunkSize, dropRate, label) {
  const fileBytes = new Uint8Array(fileSize);
  for (let i = 0; i < fileSize; i++) fileBytes[i] = (i * 31 + 7) & 0xff;
  const meta = { name: 'test.bin', type: 'application/octet-stream', size: fileSize };

  const enc = Fountain.createEncoder(fileBytes, meta, chunkSize);
  const dec = Fountain.createDecoder();
  let frames = 0;
  const maxFrames = enc.K * 30 + 100;

  while (!dec.done && frames < maxFrames) {
    const packet = enc.nextPacket();
    frames++;
    if (Math.random() < dropRate) continue; // camera missed this frame

    const qr = qrcode(0, 'L');
    qr.addData(bytesToLatin1(packet), 'Byte');
    qr.make();
    const hue = (frames * 47) % 360;
    const { img, size } = rasterize(qr, hue);
    const decoded = jsQR(img, size, size);
    if (!decoded) throw new Error(`${label}: jsQR failed to decode frame ${frames} (hue ${hue}, modules ${qr.getModuleCount()})`);
    dec.addPacket(new Uint8Array(decoded.binaryData));
  }

  if (!dec.done) throw new Error(`${label}: decoder not done after ${frames} frames (${dec.recovered}/${dec.K})`);
  const { meta: outMeta, fileBytes: outBytes } = dec.result();
  if (outMeta.name !== meta.name || outBytes.length !== fileSize) throw new Error(`${label}: metadata/size mismatch`);
  for (let i = 0; i < fileSize; i++) {
    if (outBytes[i] !== fileBytes[i]) throw new Error(`${label}: byte mismatch at ${i}`);
  }
  console.log(`PASS ${label}: ${fileSize}B file, K=${enc.K}, chunk=${chunkSize}B, drop=${dropRate}, frames shown=${frames}`);
}

run(500, 200, 0, 'tiny/no-loss');
run(20 * 1024, 300, 0.3, 'small/30% loss');
run(60 * 1024, 500, 0.5, 'medium/50% loss');
run(150 * 1024, 700, 0.2, 'large/20% loss');
console.log('All roundtrip tests passed.');
