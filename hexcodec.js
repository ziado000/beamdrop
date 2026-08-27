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
  const MARGIN = 26;
  const FINDER = 84;              // finder box edge (7 units of 12px)
  const FC = MARGIN + FINDER / 2; // finder center offset: 68
  const ALIGN = CANVAS - FC;      // 652: align disk sits at the parallelogram point
  const ALIGN_R = 15;
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
    const inner = MARGIN + 8;
    const usable = CANVAS - inner * 2;
    const colSpacing = usable / cols;
    const R = colSpacing / Math.sqrt(3);
    const rowSpacing = 1.5 * R;
    const rows = Math.floor((usable - R) / rowSpacing);

    const pad = 10;
    const zones = [
      [MARGIN - pad, MARGIN - pad, MARGIN + FINDER + pad, MARGIN + FINDER + pad],
      [CANVAS - MARGIN - FINDER - pad, MARGIN - pad, CANVAS - MARGIN + pad, MARGIN + FINDER + pad],
      [MARGIN - pad, CANVAS - MARGIN - FINDER - pad, MARGIN + FINDER + pad, CANVAS - MARGIN + pad],
      [ALIGN - ALIGN_R - pad, ALIGN - ALIGN_R - pad, ALIGN + ALIGN_R + pad, ALIGN + ALIGN_R + pad],
    ];
    const blocked = (x, y) =>
      zones.some(([x0, y0, x1, y1]) => x > x0 - R && x < x1 + R && y > y0 - R && y < y1 + R);

    const cells = [];
    for (let row = 0; row < rows; row++) {
      const cy = inner + R + row * rowSpacing;
      const off = (row % 2) * (colSpacing / 2);
      for (let col = 0; col < cols; col++) {
        const cx = inner + colSpacing / 2 + off + col * colSpacing;
        if (cx + R * 0.8 > CANVAS - inner) continue;
        if (!blocked(cx, cy)) cells.push([cx, cy]);
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

  function fillDisk(buf, W, cx, cy, r, rgb) {
    for (let y = Math.ceil(cy - r); y <= cy + r; y++) {
      for (let x = Math.ceil(cx - r); x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= W || y >= W) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
          const o = (y * W + x) * 4;
          buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 255;
        }
      }
    }
  }

  function drawFinder(buf, W, x0, y0) {
    const u = FINDER / 7;
    const WHITE = [245, 246, 250];
    fillRect(buf, W, x0, y0, x0 + FINDER, y0 + FINDER, WHITE);
    fillRect(buf, W, x0 + u, y0 + u, x0 + FINDER - u, y0 + FINDER - u, BG);
    fillRect(buf, W, x0 + 2 * u, y0 + 2 * u, x0 + FINDER - 2 * u, y0 + FINDER - 2 * u, WHITE);
  }

  /*
   * Render one frame. cellValues[i] in 0..7 for each layout cell (calibration
   * cells included — pass their fixed values). Returns RGBA Uint8ClampedArray.
   */
  function render(packet, cols, hueShift) {
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
    drawFinder(buf, CANVAS, MARGIN, MARGIN);
    drawFinder(buf, CANVAS, CANVAS - MARGIN - FINDER, MARGIN);
    drawFinder(buf, CANVAS, MARGIN, CANVAS - MARGIN - FINDER);
    fillDisk(buf, CANVAS, ALIGN, ALIGN, ALIGN_R, [245, 246, 250]);

    const gap = 0.86;
    for (let i = 0; i < layout.cells.length; i++) {
      const [cx, cy] = layout.cells[i];
      fillHex(buf, CANVAS, cx, cy, layout.R * gap, pal[values[i]]);
    }
    return buf;
  }

  // Cell order note: calibration = first 8 + last 8 cells; data = cells[8..-8].
  function cellValueOrder(layout) {
    const idx = [];
    for (let i = 8; i < layout.cells.length - 8; i++) idx.push(i);
    return idx;
  }

  // ---------- detection ----------
  function luminance(data, W, x, y) {
    const o = (y * W + x) * 4;
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }

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

  function binarize(data, W, H) {
    const lum = new Uint8Array(W * H);
    const hist = new Uint32Array(256);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const l = luminance(data, W, x, y) | 0;
        lum[y * W + x] = l;
        hist[l]++;
      }
    }
    const t = otsuThreshold(hist, W * H);
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < lum.length; i++) bin[i] = lum[i] > t ? 1 : 0;
    return bin;
  }

  function ratioOK(runs) {
    // bright 1 : dark 1 : bright 3 : dark 1 : bright 1
    const unit = (runs[0] + runs[1] + runs[2] + runs[3] + runs[4]) / 7;
    if (unit < 1.5) return false;
    const tol = unit * 0.65;
    return Math.abs(runs[0] - unit) < tol && Math.abs(runs[1] - unit) < tol &&
      Math.abs(runs[2] - 3 * unit) < tol * 1.6 && Math.abs(runs[3] - unit) < tol &&
      Math.abs(runs[4] - unit) < tol;
  }

  function findFinderCandidates(bin, W, H) {
    const at = (x, y) => bin[y * W + x];
    const cands = [];
    for (let y = 0; y < H; y += 2) {
      const runs = []; // [value, length, startX]
      let x = 0;
      while (x < W) {
        const v = bin[y * W + x];
        let len = 0; const sx = x;
        while (x < W && bin[y * W + x] === v) { x++; len++; }
        runs.push([v, len, sx]);
      }
      for (let i = 0; i + 4 < runs.length; i++) {
        if (runs[i][0] !== 1) continue;
        const five = runs.slice(i, i + 5).map((r) => r[1]);
        if (!ratioOK(five)) continue;
        const cx = Math.floor(runs[i + 2][2] + runs[i + 2][1] / 2);
        // vertical verification: (cx, y) sits in the bright center square;
        // walk out to measure [outer, ring, center, ring, outer] runs.
        if (at(cx, y) !== 1) continue;
        let yy = y, upC = 0;
        while (yy >= 0 && at(cx, yy) === 1) { upC++; yy--; }
        let darkTop = 0; while (yy >= 0 && at(cx, yy) === 0) { darkTop++; yy--; }
        let brightTop = 0; while (yy >= 0 && at(cx, yy) === 1) { brightTop++; yy--; }
        yy = y + 1; let downC = 0;
        while (yy < H && at(cx, yy) === 1) { downC++; yy++; }
        let darkBot = 0; while (yy < H && at(cx, yy) === 0) { darkBot++; yy++; }
        let brightBot = 0; while (yy < H && at(cx, yy) === 1) { brightBot++; yy++; }
        const center = upC + downC;
        const vfive = [brightTop, darkTop, center, darkBot, brightBot];
        if (!ratioOK(vfive)) continue;
        const hUnit = five.reduce((a, b) => a + b, 0) / 7;
        const vUnit = vfive.reduce((a, b) => a + b, 0) / 7;
        if (hUnit / vUnit > 1.8 || vUnit / hUnit > 1.8) continue;
        const cy = y - upC + 1 + center / 2;
        cands.push([cx, cy, (hUnit + vUnit) / 2]);
      }
    }
    // cluster
    const clusters = [];
    for (const [x, y, u] of cands) {
      let hit = null;
      for (const c of clusters) {
        if (Math.abs(c.x / c.n - x) < 14 && Math.abs(c.y / c.n - y) < 14) { hit = c; break; }
      }
      if (hit) { hit.x += x; hit.y += y; hit.u += u; hit.n++; }
      else clusters.push({ x, y, u, n: 1 });
    }
    return clusters
      .filter((c) => c.n >= 2)
      .map((c) => ({ x: c.x / c.n, y: c.y / c.n, unit: c.u / c.n, n: c.n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
  }

  function pickTriple(cs) {
    let best = null;
    for (let a = 0; a < cs.length; a++) {
      for (let b = 0; b < cs.length; b++) {
        for (let c = b + 1; c < cs.length; c++) {
          if (a === b || a === c) continue;
          const v1 = [cs[b].x - cs[a].x, cs[b].y - cs[a].y];
          const v2 = [cs[c].x - cs[a].x, cs[c].y - cs[a].y];
          const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
          if (l1 < 40 || l2 < 40) continue;
          const ratio = l1 / l2;
          if (ratio < 0.65 || ratio > 1.55) continue;
          const cos = Math.abs((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2));
          if (cos > 0.3) continue;
          const score = cos + Math.abs(1 - ratio) * 0.3;
          if (!best || score < best.score) best = { score, corner: cs[a], p1: cs[b], p2: cs[c] };
        }
      }
    }
    if (!best) return null;
    // assign TR/BL by cross product sign (image y is down)
    const { corner, p1, p2 } = best;
    const cross = (p1.x - corner.x) * (p2.y - corner.y) - (p1.y - corner.y) * (p2.x - corner.x);
    return cross > 0 ? { tl: corner, tr: p1, bl: p2 } : { tl: corner, tr: p2, bl: p1 };
  }

  function refineAlign(data, W, H, px, py, radius) {
    // stage 1: brightest pixel in the search window (the white disk wins —
    // colored hexes never reach full white)
    let peak = 0, mx = px, my = py;
    const x0 = Math.max(0, px - radius | 0), x1 = Math.min(W - 1, px + radius | 0);
    const y0 = Math.max(0, py - radius | 0), y1 = Math.min(H - 1, py + radius | 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const l = luminance(data, W, x, y);
        if (l > peak) { peak = l; mx = x; my = y; }
      }
    }
    if (!peak) return null;
    void mx; void my;
    // stage 2: centroid of near-peak pixels across the window. Pure white sits
    // well above every palette color, so only disk pixels survive the cut.
    const cut = peak * 0.92;
    let sx = 0, sy = 0, sw = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const l = luminance(data, W, x, y);
        if (l > cut) { const w = l - cut; sx += x * w; sy += y * w; sw += w; }
      }
    }
    if (!sw) return null;
    return [sx / sw, sy / sw];
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
   * Decode a camera frame (RGBA data, W, H). Returns the fountain packet bytes
   * or null. Tries every density layout against the located code.
   */
  function decodeFrame(data, W, H) {
    const bin = binarize(data, W, H);
    const cands = findFinderCandidates(bin, W, H);
    if (cands.length < 3) return null;
    const triple = pickTriple(cands);
    if (!triple) return null;
    const { tl, tr, bl } = triple;
    const predicted = [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y];
    const armLen = Math.hypot(tr.x - tl.x, tr.y - tl.y);
    const align = refineAlign(data, W, H, predicted[0], predicted[1], Math.max(14, armLen * 0.09));
    if (!align) return null;
    const h = homography(
      [[FC, FC], [CANVAS - FC, FC], [FC, CANVAS - FC], [ALIGN, ALIGN]],
      [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], align]
    );
    if (!h) return null;

    for (const cols of LAYOUT_COLS) {
      const layout = layoutFor(cols);
      // calibration palette: average the two samples of each color
      const pal = [];
      let ok = true;
      for (let i = 0; i < 8; i++) {
        const a = layout.cells[i];
        const b = layout.cells[layout.cells.length - 8 + i];
        const pa = sampleRGB(data, W, H, ...project(h, a[0], a[1]));
        const pb = sampleRGB(data, W, H, ...project(h, b[0], b[1]));
        if (!pa || !pb) { ok = false; break; }
        pal.push([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2]);
      }
      if (!ok) continue;

      const order = cellValueOrder(layout);
      const bits = new Uint8Array(order.length * 3);
      let bp = 0;
      for (const idx of order) {
        const [cx, cy] = layout.cells[idx];
        const rgb = sampleRGB(data, W, H, ...project(h, cx, cy));
        if (!rgb) { bp = -1; break; }
        let bestI = 0, bestD = Infinity;
        for (let i = 0; i < 8; i++) {
          const d = (rgb[0] - pal[i][0]) ** 2 + (rgb[1] - pal[i][1]) ** 2 + (rgb[2] - pal[i][2]) ** 2;
          if (d < bestD) { bestD = d; bestI = i; }
        }
        bits[bp++] = (bestI >> 2) & 1;
        bits[bp++] = (bestI >> 1) & 1;
        bits[bp++] = bestI & 1;
      }
      if (bp < 0) continue;

      const totalBytes = layout.blocks.reduce((a, b) => a + b.total, 0);
      const stream = new Uint8Array(totalBytes);
      for (let i = 0; i < totalBytes * 8 && i < bits.length; i++) {
        stream[i >> 3] |= bits[i] << (7 - (i & 7));
      }
      const packet = decodeFrameBytes(stream, layout);
      if (packet) return packet;
    }
    return null;
  }

  return {
    CANVAS, LAYOUT_COLS,
    layoutFor, capacityFor, palette, render, decodeFrame,
    _internals: {
      rsEncode, rsDecode, crc32, encodeFrameBytes, decodeFrameBytes, homography, project, NSYM,
      binarize, findFinderCandidates, pickTriple, refineAlign, sampleRGB,
    },
  };
});
