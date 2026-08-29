/*
 * hexcodec.js — "Aurora" honeycomb visual codec.
 *
 * The data IS the color: a honeycomb of hexagonal cells, each carrying 3 bits
 * as one of 8 palette hues. The whole palette rotates a little every frame
 * (the aurora drift); 16 calibration cells drift with it so the receiver can
 * classify colors under any lighting.
 *
 * Frame anatomy (720x720 code space):
 *   - 3 QR-style bright finder rings (TL, TR, BL) for detection + orientation
 *   - 1 bright alignment disk (BR) to complete the perspective homography
 *   - 16 calibration hexes (palette 0..7 twice, first/last cells)
 *   - N data hexes: interleaved Reed-Solomon blocks over
 *       [fountain packet][crc32]
 *
 * Shared browser/Node (UMD). Rendering is pure-JS into an RGBA buffer so the
 * tested pixels are exactly the shipped pixels.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HexCodec = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CANVAS = 720;
  const MARGIN = 20;   // dark surround outside the frame
  const BORDER = 6;    // crisp light frame — the only structure the code shows
  const NSYM = 64;                // RS parity bytes per block (corrects 32)
  const CALIB = 16;               // calibration cells (8 colors x 2)
  const LAYOUT_COLS = [26, 34, 42];
  const BG = [11, 12, 20];

  // ---------- palette ----------
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

  function palette(hueShift) {
    const p = [];
    for (let i = 0; i < 8; i++) p.push(hslToRgb(hueShift + i * 45, 85, 55));
    return p;
  }

  // ---------- layout ----------
  const layoutCache = {};
  function layoutFor(cols) {
    if (layoutCache[cols]) return layoutCache[cols];
    // field sits flush against the frame — any dark gap would split the
    // binarized blob into frame + field and wreck corner detection
    const inner = MARGIN + BORDER;
    const usable = CANVAS - inner * 2;
    const colSpacing = usable / cols;
    const R = colSpacing / Math.sqrt(3);
    const rowSpacing = 1.5 * R;
    const rows = Math.floor((usable - R) / rowSpacing);

    // no reserved zones — the frame is the only structure, cells fill everything
    const cells = [];
    for (let row = 0; row < rows; row++) {
      const cy = inner + R + row * rowSpacing;
      const off = (row % 2) * (colSpacing / 2);
      for (let col = 0; col < cols; col++) {
        const cx = inner + colSpacing / 2 + off + col * colSpacing;
        if (cx + R * 0.8 > CANVAS - inner) continue;
        cells.push([cx, cy]);
      }
    }
    const layout = { cols, R, cells, dataCells: cells.length - CALIB };
    layout.bytes = Math.floor((layout.dataCells * 3) / 8);
    layout.blocks = blockPlan(layout.bytes);
    layout.dataCapacity = layout.blocks.reduce((a, b) => a + b.data, 0);
    layoutCache[cols] = layout;
    return layout;
  }

  function blockPlan(totalBytes) {
    const n = Math.ceil(totalBytes / 255);
    const plan = [];
    let rest = totalBytes;
    for (let i = 0; i < n; i++) {
      const len = Math.floor(rest / (n - i));
      plan.push({ total: len, data: len - NSYM });
      rest -= len;
    }
    return plan;
  }

  // Data bytes a frame can carry at this density (before the fountain header).
  function capacityFor(cols) {
    return layoutFor(cols).dataCapacity - 4; // minus CRC32
  }

  // ---------- CRC32 ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ---------- Reed-Solomon over GF(256), poly 0x11d ----------
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x; GF_LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
  })();
  const gmul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);
  const gdiv = (a, b) => (a ? GF_EXP[(GF_LOG[a] - GF_LOG[b] + 255) % 255] : 0);
  const ginv = (a) => GF_EXP[(255 - GF_LOG[a]) % 255];
  const gpow = (a, n) => GF_EXP[((GF_LOG[a] * n) % 255 + 255) % 255];

  function polyMul(p, q) {
    const r = new Uint8Array(p.length + q.length - 1);
    for (let j = 0; j < q.length; j++) {
      if (!q[j]) continue;
      for (let i = 0; i < p.length; i++) if (p[i]) r[i + j] ^= gmul(p[i], q[j]);
    }
    return r;
  }
  function polyEval(p, x) {
    let y = p[0];
    for (let i = 1; i < p.length; i++) y = gmul(y, x) ^ p[i];
    return y;
  }
  function polyScale(p, s) { return p.map((c) => gmul(c, s)); }
  function polyAdd(p, q) {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    for (let i = 0; i < p.length; i++) r[i + r.length - p.length] ^= p[i];
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }

  let GEN = null;
  function generator() {
    if (GEN) return GEN;
    let g = new Uint8Array([1]);
    for (let i = 0; i < NSYM; i++) g = polyMul(g, new Uint8Array([1, GF_EXP[i]]));
    GEN = g;
    return g;
  }

  function rsEncode(msg) {
    const gen = generator();
    const work = new Uint8Array(msg.length + NSYM);
    work.set(msg);
    for (let i = 0; i < msg.length; i++) {
      const coef = work[i];
      if (coef) for (let j = 1; j < gen.length; j++) work[i + j] ^= gmul(gen[j], coef);
    }
    const out = new Uint8Array(msg.length + NSYM);
    out.set(msg);
    out.set(work.subarray(msg.length), msg.length);
    return out;
  }

  function rsDecode(codeword) {
    const msg = Array.from(codeword);
    const synd = [];
    let clean = true;
    for (let i = 0; i < NSYM; i++) {
      const s = polyEval(msg, GF_EXP[i]);
      synd.push(s);
      if (s) clean = false;
    }
    if (clean) return codeword.slice(0, codeword.length - NSYM);

    // Berlekamp-Massey
    let errLoc = [1], oldLoc = [1];
    for (let i = 0; i < NSYM; i++) {
      let delta = synd[i];
      for (let j = 1; j < errLoc.length; j++) {
        delta ^= gmul(errLoc[errLoc.length - 1 - j], synd[i - j]);
      }
      oldLoc.push(0);
      if (delta !== 0) {
        if (oldLoc.length > errLoc.length) {
          const newLoc = polyScale(oldLoc, delta);
          oldLoc = polyScale(errLoc, ginv(delta));
          errLoc = newLoc;
        }
        errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
      }
    }
    while (errLoc.length > 1 && errLoc[0] === 0) errLoc.shift();
    const errCount = errLoc.length - 1;
    if (errCount === 0 || errCount * 2 > NSYM) return null;

    // Chien search: roots of the locator sit at inverse powers alpha^-c,
    // where c is the coefficient exponent of the error position.
    const positions = [];
    for (let c = 0; c < msg.length; c++) {
      if (polyEval(errLoc, GF_EXP[(255 - (c % 255)) % 255]) === 0) positions.push(msg.length - 1 - c);
    }
    if (positions.length !== errCount) return null;

    // Forney
    const syndRev = synd.slice().reverse();
    syndRev.push(0); // reedsolo pads syndromes with one zero
    let evalPoly = polyMul(syndRev, errLoc);
    evalPoly = evalPoly.slice(evalPoly.length - (NSYM + 1)); // mod x^(NSYM+1)
    const coefPos = positions.map((p) => msg.length - 1 - p);
    const X = coefPos.map((c) => gpow(2, c));
    for (let i = 0; i < X.length; i++) {
      const XiInv = ginv(X[i]);
      let locPrime = 1;
      for (let j = 0; j < X.length; j++) {
        if (j !== i) locPrime = gmul(locPrime, 1 ^ gmul(XiInv, X[j]));
      }
      if (locPrime === 0) return null;
      let y = polyEval(evalPoly, XiInv);
      y = gmul(gpow(X[i], 1), y);
      msg[positions[i]] ^= gdiv(y, locPrime);
    }
    for (let i = 0; i < NSYM; i++) if (polyEval(msg, GF_EXP[i]) !== 0) return null;
    return new Uint8Array(msg.slice(0, msg.length - NSYM));
  }

  // ---------- frame byte pipeline ----------
  function encodeFrameBytes(packet, layout) {
    // body = [packet][zero pad][crc32 at fixed tail], all inside RS protection
    if (packet.length > layout.dataCapacity - 4) throw new Error('packet too large for layout');
    const body = new Uint8Array(layout.dataCapacity);
    body.set(packet);
    const crc = crc32(packet);
    body[layout.dataCapacity - 4] = crc & 0xff;
    body[layout.dataCapacity - 3] = (crc >>> 8) & 0xff;
    body[layout.dataCapacity - 2] = (crc >>> 16) & 0xff;
    body[layout.dataCapacity - 1] = (crc >>> 24) & 0xff;

    // split into RS blocks, encode, interleave
    const codewords = [];
    let off = 0;
    for (const b of layout.blocks) {
      codewords.push(rsEncode(body.subarray(off, off + b.data)));
      off += b.data;
    }
    const total = codewords.reduce((a, c) => a + c.length, 0);
    const out = new Uint8Array(total);
    let k = 0;
    const maxLen = Math.max(...codewords.map((c) => c.length));
    for (let p = 0; p < maxLen; p++) {
      for (const cw of codewords) if (p < cw.length) out[k++] = cw[p];
    }
    return out;
  }

  function decodeFrameBytes(stream, layout) {
    const lengths = layout.blocks.map((b) => b.total);
    const codewords = lengths.map((l) => new Uint8Array(l));
    let k = 0;
    const maxLen = Math.max(...lengths);
    for (let p = 0; p < maxLen; p++) {
      for (let b = 0; b < codewords.length; b++) {
        if (p < lengths[b]) codewords[b][p] = stream[k++];
      }
    }
    const parts = [];
    for (const cw of codewords) {
      const d = rsDecode(cw);
      if (!d) return null;
      parts.push(d);
    }
    const body = new Uint8Array(layout.dataCapacity);
    let off = 0;
    for (const p of parts) { body.set(p, off); off += p.length; }
    const D = layout.dataCapacity;
    const crc = (body[D - 4] | (body[D - 3] << 8) | (body[D - 2] << 16) | (body[D - 1] << 24)) >>> 0;
    // packet length comes from the fountain header itself: chunkSize u16 at
    // offset 13, plus the 19-byte header.
    const chunkSize = body[13] | (body[14] << 8);
    const packetLen = 19 + chunkSize;
    if (packetLen > D - 4) return null;
    const packet = body.slice(0, packetLen);
    if (crc32(packet) !== crc) return null;
    return packet;
  }

  // ---------- rendering (pure JS RGBA buffer) ----------
  function fillRect(buf, W, x0, y0, x1, y1, rgb) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    x1 = Math.min(W, x1 | 0); y1 = Math.min(W, y1 | 0);
    for (let y = y0; y < y1; y++) {
      let o = (y * W + x0) * 4;
      for (let x = x0; x < x1; x++) {
        buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 255;
        o += 4;
      }
    }
  }

  function fillHex(buf, W, cx, cy, R, rgb) {
    const h = R;
    const w = (Math.sqrt(3) / 2) * R;
    for (let y = Math.ceil(cy - h); y <= cy + h; y++) {
      if (y < 0 || y >= W) continue;
      for (let x = Math.ceil(cx - w); x <= cx + w; x++) {
        if (x < 0 || x >= W) continue;
        const dx = Math.abs(x - cx), dy = Math.abs(y - cy);
        if (dx <= w && dy <= R - dx / Math.sqrt(3)) {
          const o = (y * W + x) * 4;
          buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 255;
        }
      }
    }
  }

  /*
   * The aurora look: fill the cells as a seamless mosaic, then melt it with a
   * separable box blur (run twice ≈ gaussian). Cell centers keep enough of
   * their own color for 3x3 center sampling + Reed-Solomon to classify.
   */
  let blurTmp = null;
  function boxBlur(buf, W, H, r) {
    if (!blurTmp || blurTmp.length !== buf.length) blurTmp = new Uint8ClampedArray(buf.length);
    const t = blurTmp;
    const div = 2 * r + 1;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let sr = 0, sg = 0, sb = 0;
      for (let x = -r; x <= r; x++) {
        const o = (row + Math.min(W - 1, Math.max(0, x))) * 4;
        sr += buf[o]; sg += buf[o + 1]; sb += buf[o + 2];
      }
      for (let x = 0; x < W; x++) {
        const o = (row + x) * 4;
        t[o] = sr / div; t[o + 1] = sg / div; t[o + 2] = sb / div; t[o + 3] = 255;
        const oa = (row + Math.min(W - 1, x + r + 1)) * 4;
        const ob = (row + Math.max(0, x - r)) * 4;
        sr += buf[oa] - buf[ob]; sg += buf[oa + 1] - buf[ob + 1]; sb += buf[oa + 2] - buf[ob + 2];
      }
    }
    for (let x = 0; x < W; x++) {
      let sr = 0, sg = 0, sb = 0;
      for (let y = -r; y <= r; y++) {
        const o = (Math.min(H - 1, Math.max(0, y)) * W + x) * 4;
        sr += t[o]; sg += t[o + 1]; sb += t[o + 2];
      }
      for (let y = 0; y < H; y++) {
        const o = (y * W + x) * 4;
        buf[o] = sr / div; buf[o + 1] = sg / div; buf[o + 2] = sb / div; buf[o + 3] = 255;
        const oa = (Math.min(H - 1, y + r + 1) * W + x) * 4;
        const ob = (Math.max(0, y - r) * W + x) * 4;
        sr += t[oa] - t[ob]; sg += t[oa + 1] - t[ob + 1]; sb += t[oa + 2] - t[ob + 2];
      }
    }
  }

  function drawBorderJS(buf, W) {
    const WHITE = [245, 246, 250];
    const a = MARGIN, b = CANVAS - MARGIN;
    fillRect(buf, W, a, a, b, a + BORDER, WHITE);
    fillRect(buf, W, a, b - BORDER, b, b, WHITE);
    fillRect(buf, W, a, a, a + BORDER, b, WHITE);
    fillRect(buf, W, b - BORDER, a, b, b, WHITE);
  }

  /*
   * Render one frame. cellValues[i] in 0..7 for each layout cell (calibration
   * cells included — pass their fixed values). Returns RGBA Uint8ClampedArray.
   */
  function render(packet, cols, hueShift, opts) {
    const layout = layoutFor(cols);
    const pal = palette(hueShift);
    const stream = encodeFrameBytes(packet, layout);

    // bytes -> 3-bit cell values
    const values = new Uint8Array(layout.cells.length);
    for (let i = 0; i < 8; i++) { values[i] = i; values[layout.cells.length - 8 + i] = i; }
    let bitPos = 0;
    for (let i = 0; i < layout.dataCells; i++) {
      let v = 0;
      for (let b = 0; b < 3; b++) {
        const byte = bitPos >> 3;
        const bit = byte < stream.length ? (stream[byte] >> (7 - (bitPos & 7))) & 1 : (i * 7 + b) & 1;
        v = (v << 1) | bit;
        bitPos++;
      }
      values[8 + i] = v;
    }

    const buf = new Uint8ClampedArray(CANVAS * CANVAS * 4);
    fillRect(buf, CANVAS, 0, 0, CANVAS, CANVAS, BG);
    // seamless mosaic (slight overlap kills the gaps), then melt it
    for (let i = 0; i < layout.cells.length; i++) {
      const [cx, cy] = layout.cells[i];
      fillHex(buf, CANVAS, cx, cy, layout.R * 1.08, pal[values[i]]);
    }
    // mosaicOnly: caller does the melt on the GPU (ctx.filter blur) and draws
    // the anchors itself — same picture, ~5x faster on the sender.
    if (opts && opts.mosaicOnly) return buf;
    const blurR = blurRadiusFor(cols);
    boxBlur(buf, CANVAS, CANVAS, blurR);
    boxBlur(buf, CANVAS, CANVAS, blurR);
    // the frame goes on top of the melted field so its edge stays crisp
    drawBorderJS(buf, CANVAS);
    return buf;
  }

  // Cell order note: calibration = first 8 + last 8 cells; data = cells[8..-8].
  function cellValueOrder(layout) {
    const idx = [];
    for (let i = 8; i < layout.cells.length - 8; i++) idx.push(i);
    return idx;
  }

  // ---------- detection ----------
  function otsuThreshold(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thresh = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thresh = i; }
    }
    return thresh;
  }

  // scratch buffers reused across frames (a camera feeds a fixed size)
  let lumCache = null, binCache = null, cacheSize = -1;
  function binarize(data, W, H) {
    const n = W * H;
    if (cacheSize !== n) {
      lumCache = new Uint8Array(n);
      binCache = new Uint8Array(n);
      cacheSize = n;
    }
    const lum = lumCache, bin = binCache;
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const l = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
      lum[i] = l;
      hist[l]++;
    }
    let t = otsuThreshold(hist, n);
    // Bright-scene guard: when most of the frame binarizes bright (lit wall,
    // light-mode page behind the code), re-split the bright class so only true
    // highlights — the white frame above all — stay bright.
    for (let pass = 0; pass < 2; pass++) {
      let brightCount = 0;
      for (let i = t + 1; i < 256; i++) brightCount += hist[i];
      if (brightCount <= n * 0.55) break;
      const sub = new Uint32Array(256);
      for (let i = t + 1; i < 256; i++) sub[i] = hist[i];
      const t2 = otsuThreshold(sub, brightCount);
      if (t2 <= t) break;
      t = t2;
    }
    for (let i = 0; i < n; i++) bin[i] = lum[i] > t ? 1 : 0;
    return bin;
  }

  /*
   * Find glowing quadrilaterals — framed aurora fields — in the binarized
   * image. Downsample 2x, label connected bright components, take each
   * component's convex extremes as its corners. The corners of a convex quad
   * are exactly its extreme points, so no marker is needed: the field's own
   * frame is the geometry.
   */
  let gridCache = null, labelCache = null, gridCacheSize = -1;
  function findBrightQuads(bin, W, H, maxQuads) {
    const DS = 2;
    const gw = Math.floor(W / DS), gh = Math.floor(H / DS);
    if (gridCacheSize !== gw * gh) {
      gridCache = new Uint8Array(gw * gh);
      labelCache = new Int32Array(gw * gh);
      gridCacheSize = gw * gh;
    }
    const g = gridCache, labels = labelCache;
    labels.fill(-1);
    for (let y = 0; y < gh; y++) {
      const row = y * DS * W;
      for (let x = 0; x < gw; x++) g[y * gw + x] = bin[row + x * DS];
    }
    // connected components tracked as per-row x-extents — no per-pixel arrays
    const comps = [];
    const stack = [];
    for (let i = 0; i < g.length; i++) {
      if (!g[i] || labels[i] !== -1) continue;
      const id = comps.length;
      const rows = new Map(); // y -> [minX, maxX]
      let count = 0;
      labels[i] = id; stack.push(i);
      while (stack.length) {
        const p = stack.pop();
        const px = p % gw, py = (p / gw) | 0;
        count++;
        const r = rows.get(py);
        if (!r) rows.set(py, [px, px]);
        else { if (px < r[0]) r[0] = px; if (px > r[1]) r[1] = px; }
        if (px > 0 && g[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; stack.push(p - 1); }
        if (px < gw - 1 && g[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; stack.push(p + 1); }
        if (py > 0 && g[p - gw] && labels[p - gw] === -1) { labels[p - gw] = id; stack.push(p - gw); }
        if (py < gh - 1 && g[p + gw] && labels[p + gw] === -1) { labels[p + gw] = id; stack.push(p + gw); }
      }
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [y, r] of rows) {
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (r[0] < x0) x0 = r[0]; if (r[1] > x1) x1 = r[1];
      }
      comps.push({ rows, count, x0, y0, x1, y1 });
    }
    // Merge nested components. Two safe cases: (1) frame ring + field with a
    // near-identical bbox (they binarized separately across a small gap), and
    // (2) a HOLLOW outer component (fill ratio << 1 — a frame ring) absorbing
    // anything inside it: interior blobs can't move a ring's extremes. A SOLID
    // bright surround (lit wall) must NOT swallow a code nested in its bbox —
    // the code stays its own candidate and RS/CRC rejects the wall's quad.
    comps.sort((a, b) => b.count - a.count);
    for (let i = 0; i < comps.length; i++) {
      if (!comps[i]) continue;
      const bi = comps[i];
      const areaI = (bi.x1 - bi.x0 + 1) * (bi.y1 - bi.y0 + 1);
      const hollowI = bi.count < areaI * 0.5;
      for (let j = i + 1; j < comps.length; j++) {
        if (!comps[j]) continue;
        const bj = comps[j];
        if (bj.x0 < bi.x0 - 6 || bj.x1 > bi.x1 + 6 || bj.y0 < bi.y0 - 6 || bj.y1 > bi.y1 + 6) continue;
        const areaJ = (bj.x1 - bj.x0 + 1) * (bj.y1 - bj.y0 + 1);
        if (!hollowI && areaJ < areaI * 0.6) continue; // solid surround: keep nested candidates
        for (const [y, r] of bj.rows) {
          const ri = bi.rows.get(y);
          if (!ri) bi.rows.set(y, [r[0], r[1]]);
          else { if (r[0] < ri[0]) ri[0] = r[0]; if (r[1] > ri[1]) ri[1] = r[1]; }
        }
        bi.count += bj.count;
        comps[j] = null;
      }
    }
    comps.sort((a, b) => (b ? b.count : 0) - (a ? a.count : 0));

    const minCount = 250; // absolute (~1000 image px) — independent of camera resolution
    const quads = [];
    for (const comp of comps) {
      if (!comp) continue;
      if (quads.length >= maxQuads + 4) break;
      if (comp.count < minCount) continue;
      // boundary points (2 per row) -> convex hull -> max-area inscribed quad.
      // The old "farthest point" heuristic broke on keystone trapezoids where
      // the farthest point from a corner is an ADJACENT corner.
      const boundary = [];
      for (const [y, r] of comp.rows) { boundary.push([r[0], y]); if (r[1] !== r[0]) boundary.push([r[1], y]); }
      if (boundary.length < 4) continue;
      const hull = convexHull(boundary);
      const verts = simplifyHull(hull, 16);
      if (verts.length < 4) continue;
      const four = maxAreaQuad(verts);
      if (!four) continue;
      let mx = 0, my = 0;
      for (const p of four) { mx += p[0]; my += p[1]; }
      mx = (mx / 4) * DS; my = (my / 4) * DS;
      const corners = four.map((p) =>
        refineCorner(bin, W, H, p[0] * DS + DS / 2, p[1] * DS + DS / 2, mx, my));
      // clockwise order (image y is down: ascending atan2 = clockwise on screen)
      corners.sort((p, q) => Math.atan2(p[1] - my, p[0] - mx) - Math.atan2(q[1] - my, q[0] - mx));
      let ok = true;
      for (let k = 0; k < 4; k++) {
        const p = corners[k], q = corners[(k + 1) % 4];
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) < 40) { ok = false; break; }
      }
      if (ok) quads.push({ corners, size: comp.count });
    }
    return quads;
  }

  function convexHull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [], upper = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  // Drop near-collinear hull vertices until at most maxVerts remain.
  function simplifyHull(hull, maxVerts) {
    const verts = hull.slice();
    const deviation = (i) => {
      const a = verts[(i + verts.length - 1) % verts.length];
      const b = verts[i];
      const c = verts[(i + 1) % verts.length];
      const num = Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1]));
      return num / (Math.hypot(c[0] - a[0], c[1] - a[1]) || 1);
    };
    while (verts.length > 4) {
      let minI = -1, minD = Infinity;
      for (let i = 0; i < verts.length; i++) {
        const d = deviation(i);
        if (d < minD) { minD = d; minI = i; }
      }
      if (verts.length <= maxVerts && minD > 1.5) break;
      verts.splice(minI, 1);
    }
    return verts;
  }

  // Max-area quadrilateral over a small convex polygon (indices in hull order).
  function maxAreaQuad(verts) {
    const n = verts.length;
    if (n === 4) return verts.slice();
    let best = null, bestArea = 0;
    for (let a = 0; a < n - 3; a++) {
      for (let b = a + 1; b < n - 2; b++) {
        for (let c = b + 1; c < n - 1; c++) {
          for (let d = c + 1; d < n; d++) {
            const q = [verts[a], verts[b], verts[c], verts[d]];
            let area = 0;
            for (let k = 0; k < 4; k++) {
              const p1 = q[k], p2 = q[(k + 1) % 4];
              area += p1[0] * p2[1] - p2[0] * p1[1];
            }
            area = Math.abs(area) / 2;
            if (area > bestArea) { bestArea = area; best = q; }
          }
        }
      }
    }
    return best;
  }

  // Recover full-resolution corner precision lost to the 2x downsample: the
  // bright pixel near the coarse corner that lies farthest from the centroid.
  function refineCorner(bin, W, H, x, y, cx, cy) {
    let best = null, bd = -1;
    const r = 5;
    const x0 = Math.max(0, (x | 0) - r), x1 = Math.min(W - 1, (x | 0) + r);
    const y0 = Math.max(0, (y | 0) - r), y1 = Math.min(H - 1, (y | 0) + r);
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (!bin[yy * W + xx]) continue;
        const d = (xx - cx) ** 2 + (yy - cy) ** 2;
        if (d > bd) { bd = d; best = [xx, yy]; }
      }
    }
    return best || [x, y];
  }

  // Solve homography H (code -> image) from 4 correspondences.
  function homography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [X, Y] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
    }
    // gaussian elimination on 8x9
    for (let col = 0; col < 8; col++) {
      let piv = col;
      for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-9) return null;
      [A[col], A[piv]] = [A[piv], A[col]];
      for (let r = 0; r < 8; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        for (let k = col; k < 9; k++) A[r][k] -= f * A[col][k];
      }
    }
    const h = [];
    for (let i = 0; i < 8; i++) h.push(A[i][8] / A[i][i]);
    h.push(1);
    return h;
  }

  function project(h, x, y) {
    const w = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  }

  function sampleRGB(data, W, H, x, y) {
    let r = 0, g = 0, b = 0, n = 0;
    const xi = Math.round(x), yi = Math.round(y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = xi + dx, py = yi + dy;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const o = (py * W + px) * 4;
        r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
      }
    }
    return n ? [r / n, g / n, b / n] : null;
  }

  /*
   * Decode every aurora field visible in a camera frame (RGBA data, W, H).
   * Returns an array of fountain packets (possibly empty). No orientation
   * marker exists: all 4 rotations are ranked by calibration self-consistency
   * (the two calibration runs must agree), then RS + CRC settle the truth.
   */
  let lastGoodCols = null;
  function decodeFrames(data, W, H, maxCodes = 4) {
    const bin = binarize(data, W, H);
    const quads = findBrightQuads(bin, W, H, maxCodes);
    const packets = [];
    for (const q of quads) {
      if (packets.length >= maxCodes) break;
      const p = decodeQuad(data, W, H, q.corners);
      if (p) packets.push(p);
    }
    return packets;
  }

  function decodeFrame(data, W, H) {
    return decodeFrames(data, W, H, 1)[0] || null;
  }

  function decodeQuad(data, W, H, corners) {
    const M = MARGIN;
    const src = [[M, M], [CANVAS - M, M], [CANVAS - M, CANVAS - M], [M, CANVAS - M]];
    // rank (winding, density) pairs by how well the two calibration runs agree;
    // 8 windings = 4 rotations plus their mirror images (flipped camera feeds)
    const cands = [];
    for (let w = 0; w < 8; w++) {
      const rot = w % 4;
      const dst = w < 4
        ? [corners[rot], corners[(rot + 1) % 4], corners[(rot + 2) % 4], corners[(rot + 3) % 4]]
        : [corners[rot], corners[(rot + 3) % 4], corners[(rot + 2) % 4], corners[(rot + 1) % 4]];
      const h = homography(src, dst);
      if (!h) continue;
      for (const cols of LAYOUT_COLS) {
        const layout = layoutFor(cols);
        const pal = [];
        let score = 0, ok = true;
        for (let i = 0; i < 8; i++) {
          const a = layout.cells[i];
          const b = layout.cells[layout.cells.length - 8 + i];
          const pa = sampleRGB(data, W, H, ...project(h, a[0], a[1]));
          const pb = sampleRGB(data, W, H, ...project(h, b[0], b[1]));
          if (!pa || !pb) { ok = false; break; }
          score += (pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2;
          pal.push([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]);
        }
        if (!ok) continue;
        if (cols === lastGoodCols) score *= 0.5; // a stream stays at one density
        cands.push({ h, layout, pal, cols, score });
      }
    }
    cands.sort((a, b) => a.score - b.score);
    for (const c of cands.slice(0, 10)) {
      const packet = sampleAndDecode(data, W, H, c.h, c.layout, c.pal);
      if (packet) { lastGoodCols = c.cols; return packet; }
    }
    return null;
  }

  function sampleAndDecode(data, W, H, h, layout, pal) {
    const order = cellValueOrder(layout);
    const bits = new Uint8Array(order.length * 3);
    let bp = 0;
    for (const idx of order) {
      const [cx, cy] = layout.cells[idx];
      const rgb = sampleRGB(data, W, H, ...project(h, cx, cy));
      if (!rgb) return null;
      let bestI = 0, bestD = Infinity;
      for (let i = 0; i < 8; i++) {
        const d = (rgb[0] - pal[i][0]) ** 2 + (rgb[1] - pal[i][1]) ** 2 + (rgb[2] - pal[i][2]) ** 2;
        if (d < bestD) { bestD = d; bestI = i; }
      }
      bits[bp++] = (bestI >> 2) & 1;
      bits[bp++] = (bestI >> 1) & 1;
      bits[bp++] = bestI & 1;
    }
    const totalBytes = layout.blocks.reduce((a, b) => a + b.total, 0);
    const stream = new Uint8Array(totalBytes);
    for (let i = 0; i < totalBytes * 8 && i < bits.length; i++) {
      stream[i >> 3] |= bits[i] << (7 - (i & 7));
    }
    return decodeFrameBytes(stream, layout);
  }

  function blurRadiusFor(cols) {
    return Math.max(2, Math.round(layoutFor(cols).R * 0.55));
  }

  return {
    CANVAS, LAYOUT_COLS,
    GEOM: { MARGIN, BORDER, BG },
    layoutFor, capacityFor, palette, render, decodeFrame, decodeFrames, blurRadiusFor,
    _internals: {
      rsEncode, rsDecode, crc32, encodeFrameBytes, decodeFrameBytes, homography, project, NSYM,
      binarize, findBrightQuads, sampleRGB,
    },
  };
});
