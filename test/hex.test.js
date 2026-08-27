/*
 * Aurora honeycomb codec tests:
 *  1. Reed-Solomon unit test (corrupt bytes, recover)
 *  2. Clean render -> decode for every density layout
 *  3. Camera simulation: perspective tilt + blur + white-balance tint + noise
 *  4. Full fountain file transfer through the simulated camera
 */
const path = require('path');
const HexCodec = require(path.join(__dirname, '..', 'hexcodec.js'));
const Fountain = require(path.join(__dirname, '..', 'fountain.js'));

const { rsEncode, rsDecode, homography, project, NSYM } = HexCodec._internals;

// ---------- 1. RS unit test ----------
(function testRS() {
  for (let trial = 0; trial < 20; trial++) {
    const msg = new Uint8Array(180);
    for (let i = 0; i < msg.length; i++) msg[i] = (Math.random() * 256) | 0;
    const cw = rsEncode(msg);
    const corrupted = cw.slice();
    const nerr = (Math.random() * (NSYM / 2)) | 0;
    const hit = new Set();
    while (hit.size < nerr) hit.add((Math.random() * corrupted.length) | 0);
    for (const p of hit) corrupted[p] ^= 1 + ((Math.random() * 255) | 0);
    const dec = rsDecode(corrupted);
    if (!dec) throw new Error(`RS: failed with ${nerr} errors`);
    for (let i = 0; i < msg.length; i++) {
      if (dec[i] !== msg[i]) throw new Error(`RS: wrong byte at ${i} (${nerr} errors)`);
    }
  }
  // beyond capacity must fail or return wrong-detected, never crash
  const msg = new Uint8Array(180).fill(7);
  const cw = rsEncode(msg);
  for (let p = 0; p < NSYM / 2 + 5; p++) cw[p] ^= 0xff;
  rsDecode(cw); // may be null; just must not throw
  console.log('PASS RS: recovers up to', NSYM / 2, 'byte errors per block');
})();

// ---------- camera simulation ----------
function simulateCamera(codeBuf, opts = {}) {
  const CW = opts.outW || 800, CH = opts.outH || 600;
  const S = opts.side || HexCodec.CANVAS;
  const quad = opts.quad || [[150, 60], [655, 85], [635, 555], [140, 530]];
  const H = homography([[0, 0], [S, 0], [S, S], [0, S]], quad);
  // invert: camera -> code
  const Hinv = homography(quad, [[0, 0], [S, 0], [S, S], [0, S]]);
  void H;
  const img = new Uint8ClampedArray(CW * CH * 4);
  const bg = [38, 39, 46];
  const gain = opts.gain || [1.02, 0.97, 1.05];
  for (let y = 0; y < CH; y++) {
    for (let x = 0; x < CW; x++) {
      const [sx, sy] = project(Hinv, x, y);
      const o = (y * CW + x) * 4;
      let r, g, b;
      if (sx < 0 || sy < 0 || sx >= S - 1 || sy >= S - 1) {
        [r, g, b] = bg;
      } else {
        // bilinear
        const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
        const idx = (yy, xx) => ((yy * S + xx) * 4);
        r = g = b = 0;
        for (const [dy, dx, w] of [[0, 0, (1 - fx) * (1 - fy)], [0, 1, fx * (1 - fy)], [1, 0, (1 - fx) * fy], [1, 1, fx * fy]]) {
          const o2 = idx(y0 + dy, x0 + dx);
          r += codeBuf[o2] * w; g += codeBuf[o2 + 1] * w; b += codeBuf[o2 + 2] * w;
        }
      }
      img[o] = r * gain[0]; img[o + 1] = g * gain[1]; img[o + 2] = b * gain[2]; img[o + 3] = 255;
    }
  }
  // box blur passes
  const passes = opts.blur == null ? 1 : opts.blur;
  let src = img;
  for (let p = 0; p < passes; p++) {
    const dst = new Uint8ClampedArray(src.length);
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const px = x + dx, py = y + dy;
            if (px < 0 || py < 0 || px >= CW || py >= CH) continue;
            const o = (py * CW + px) * 4;
            r += src[o]; g += src[o + 1]; b += src[o + 2]; n++;
          }
        }
        const o = (y * CW + x) * 4;
        dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n; dst[o + 3] = 255;
      }
    }
    src = dst;
  }
  // sensor noise
  const noise = opts.noise == null ? 5 : opts.noise;
  if (noise) {
    for (let i = 0; i < src.length; i += 4) {
      const n1 = (Math.random() - 0.5) * 2 * noise;
      src[i] += n1; src[i + 1] += (Math.random() - 0.5) * 2 * noise; src[i + 2] += (Math.random() - 0.5) * 2 * noise;
    }
  }
  return { data: src, W: CW, H: CH };
}

// ---------- 2 + 3: per-layout decode ----------
function frameRoundtrip(cols, distort) {
  const cap = HexCodec.capacityFor(cols);
  const chunk = cap - 19;
  const fileBytes = new Uint8Array(chunk * 2);
  for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 13 + 5) & 0xff;
  const enc = Fountain.createEncoder(fileBytes, { name: 'x', type: 'b', size: fileBytes.length }, chunk);
  const packet = enc.nextPacket();
  const buf = HexCodec.render(packet, cols, 137);
  let data, W, H;
  if (distort) ({ data, W, H } = simulateCamera(buf, distort));
  else { data = buf; W = HexCodec.CANVAS; H = HexCodec.CANVAS; }
  const out = HexCodec.decodeFrame(data, W, H);
  if (!out) return false;
  if (out.length !== packet.length) return false;
  for (let i = 0; i < out.length; i++) if (out[i] !== packet[i]) return false;
  return true;
}

for (const cols of HexCodec.LAYOUT_COLS) {
  const layout = HexCodec.layoutFor(cols);
  if (!frameRoundtrip(cols, null)) throw new Error(`clean decode failed for cols=${cols}`);
  console.log(`PASS clean decode cols=${cols}: ${layout.cells.length} cells, ${HexCodec.capacityFor(cols)}B/frame`);
}

for (const cols of HexCodec.LAYOUT_COLS) {
  let ok = 0;
  const N = 10;
  for (let t = 0; t < N; t++) {
    if (frameRoundtrip(cols, { blur: 1, noise: 5 })) ok++;
  }
  console.log(`${ok >= N * 0.6 ? 'PASS' : 'FAIL'} camera-sim cols=${cols}: ${ok}/${N} frames decoded`);
  if (ok < N * 0.6) throw new Error(`camera-sim decode rate too low for cols=${cols}`);
}

// ---------- 4: full transfer through simulated camera ----------
(function testTransfer() {
  const cols = HexCodec.LAYOUT_COLS[1];
  const cap = HexCodec.capacityFor(cols);
  const chunk = cap - 19;
  const size = 30 * 1024;
  const fileBytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) fileBytes[i] = (i * 31 + 7) & 0xff;
  const enc = Fountain.createEncoder(fileBytes, { name: 'aurora.bin', type: 'application/octet-stream', size }, chunk);
  const dec = Fountain.createDecoder();
  let frames = 0, caught = 0;
  const maxFrames = enc.K * 6 + 40;
  while (!dec.done && frames < maxFrames) {
    const packet = enc.nextPacket();
    frames++;
    const buf = HexCodec.render(packet, cols, (frames * 9) % 360);
    const { data, W, H } = simulateCamera(buf, { blur: 1, noise: 4 });
    const out = HexCodec.decodeFrame(data, W, H);
    if (out) { caught++; dec.addPacket(out); }
  }
  if (!dec.done) throw new Error(`transfer incomplete: ${dec.recovered}/${dec.K} after ${frames} frames`);
  const { meta, fileBytes: got } = dec.result();
  if (meta.name !== 'aurora.bin' || got.length !== size) throw new Error('transfer meta mismatch');
  for (let i = 0; i < size; i++) if (got[i] !== fileBytes[i]) throw new Error(`transfer byte mismatch @${i}`);
  console.log(`PASS transfer: 30KB in ${frames} frames shown, ${caught} decoded (K=${enc.K})`);
})();

// ---------- 5: tiled 2x2 multi-code decode ----------
(function testTiles() {
  const cols = HexCodec.LAYOUT_COLS[1];
  const S = HexCodec.CANVAS;
  const cap = HexCodec.capacityFor(cols);
  const chunk = cap - 19;
  const fileBytes = new Uint8Array(chunk * 8).map((_, i) => (i * 17 + 3) & 0xff);
  const enc = Fountain.createEncoder(fileBytes, { name: 't', type: 'b', size: fileBytes.length }, chunk);

  const composite = new Uint8ClampedArray(S * 2 * S * 2 * 4);
  const sent = [];
  const POS = [[0, 0], [1, 0], [0, 1], [1, 1]];
  POS.forEach(([tx, ty], i) => {
    const packet = enc.nextPacket();
    sent.push(packet);
    const buf = HexCodec.render(packet, cols, i * 90);
    for (let y = 0; y < S; y++) {
      const srcOff = y * S * 4;
      const dstOff = ((ty * S + y) * S * 2 + tx * S) * 4;
      composite.set(buf.subarray(srcOff, srcOff + S * 4), dstOff);
    }
  });

  const { data, W, H } = simulateCamera(composite, {
    side: S * 2, outW: 1000, outH: 750,
    quad: [[110, 40], [910, 60], [890, 700], [100, 680]],
    blur: 1, noise: 4,
  });
  const packets = HexCodec.decodeFrames(data, W, H, 4);
  const sentKeys = new Set(sent.map((p) => p.join(',')));
  const good = packets.filter((p) => sentKeys.has(Array.from(p).join(','))).length;
  console.log(`${good >= 3 ? 'PASS' : 'FAIL'} tiled 2x2: ${good}/4 codes decoded from one camera frame`);
  if (good < 3) throw new Error('tiled decode rate too low');
})();

// ---------- 6: decode speed benchmark ----------
(function benchmark() {
  const cols = HexCodec.LAYOUT_COLS[1];
  const chunk = HexCodec.capacityFor(cols) - 19;
  const fileBytes = new Uint8Array(chunk * 2).map((_, i) => (i * 7 + 1) & 0xff);
  const enc = Fountain.createEncoder(fileBytes, { name: 'b', type: 'b', size: fileBytes.length }, chunk);
  const buf = HexCodec.render(enc.nextPacket(), cols, 200);
  const { data, W, H } = simulateCamera(buf, { blur: 1, noise: 4 });
  HexCodec.decodeFrame(data, W, H); // warm caches
  const N = 20;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) HexCodec.decodeFrame(data, W, H);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`BENCH decode: ${ms.toFixed(1)} ms/frame (${(1000 / ms).toFixed(0)} fps ceiling) at ${W}x${H}`);
})();

console.log('All aurora codec tests passed.');
