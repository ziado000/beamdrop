/*
 * fountain.js — Luby Transform fountain code (encoder + peeling decoder).
 * Shared between the sender and receiver pages; also loadable in Node for tests.
 *
 * Packet layout (little-endian):
 *   0  magic   "CB"            2 bytes
 *   2  version 1               1 byte
 *   3  transferId              4 bytes  (random per transfer)
 *   7  seed                    4 bytes  (drives degree + chunk selection)
 *   11 K (chunk count)         2 bytes
 *   13 chunkSize               2 bytes
 *   15 payloadLen              4 bytes  (unpadded meta+file length)
 *   19 xor-payload             chunkSize bytes
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fountain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAGIC0 = 0x43, MAGIC1 = 0x42, VERSION = 1, HEADER_LEN = 19;

  // Deterministic PRNG so sender and receiver derive identical chunk sets from a seed.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Robust soliton degree distribution CDF for K chunks.
  function robustSolitonCDF(K, c = 0.03, delta = 0.5) {
    const S = c * Math.log(K / delta) * Math.sqrt(K);
    const pivot = Math.max(1, Math.min(K, Math.floor(K / S) || 1));
    const p = new Array(K + 1).fill(0);
    for (let d = 1; d <= K; d++) {
      const rho = d === 1 ? 1 / K : 1 / (d * (d - 1));
      let tau = 0;
      if (d < pivot) tau = S / (K * d);
      else if (d === pivot) tau = (S * Math.log(S / delta)) / K;
      p[d] = rho + tau;
    }
    let sum = 0;
    for (let d = 1; d <= K; d++) sum += p[d];
    const cdf = new Array(K + 1).fill(0);
    let acc = 0;
    for (let d = 1; d <= K; d++) { acc += p[d] / sum; cdf[d] = acc; }
    cdf[K] = 1;
    return cdf;
  }

  // Given a seed, pick which chunks this packet XORs together.
  function chunkIndicesForSeed(seed, K, cdf) {
    const rnd = mulberry32(seed);
    const r = rnd();
    let degree = 1;
    while (degree < K && cdf[degree] < r) degree++;
    const chosen = new Set();
    while (chosen.size < degree) chosen.add(Math.floor(rnd() * K));
    return chosen;
  }

  function xorInto(target, src) {
    for (let i = 0; i < target.length; i++) target[i] ^= src[i];
  }

  // ---- Payload framing: [metaLen u16][metaJSON][fileBytes] ----
  function buildPayload(fileBytes, meta) {
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    if (metaBytes.length > 0xffff) throw new Error('metadata too large');
    const payload = new Uint8Array(2 + metaBytes.length + fileBytes.length);
    payload[0] = metaBytes.length & 0xff;
    payload[1] = (metaBytes.length >> 8) & 0xff;
    payload.set(metaBytes, 2);
    payload.set(fileBytes, 2 + metaBytes.length);
    return payload;
  }

  function parsePayload(payload) {
    const metaLen = payload[0] | (payload[1] << 8);
    const meta = JSON.parse(new TextDecoder().decode(payload.subarray(2, 2 + metaLen)));
    const fileBytes = payload.subarray(2 + metaLen);
    return { meta, fileBytes };
  }

  // ---- Encoder ----
  function createEncoder(fileBytes, meta, chunkSize) {
    const payload = buildPayload(fileBytes, meta);
    const K = Math.max(1, Math.ceil(payload.length / chunkSize));
    if (K > 0xffff) throw new Error('file too large for this density — raise chunk size');
    const chunks = [];
    for (let i = 0; i < K; i++) {
      const chunk = new Uint8Array(chunkSize);
      chunk.set(payload.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, payload.length)));
      chunks.push(chunk);
    }
    const cdf = robustSolitonCDF(K);
    const transferId = (Math.random() * 0xffffffff) >>> 0;
    let counter = 0;

    return {
      K,
      transferId,
      payloadLen: payload.length,
      // Produce the next packet. First K packets are the plain chunks in order
      // (degree-1 systematic pass, fastest path for a receiver watching from the
      // start), then random fountain packets forever after.
      nextPacket() {
        const packet = new Uint8Array(HEADER_LEN + chunkSize);
        const seed = counter >>> 0;
        counter++;
        packet[0] = MAGIC0; packet[1] = MAGIC1; packet[2] = VERSION;
        writeU32(packet, 3, transferId);
        writeU32(packet, 7, seed);
        packet[11] = K & 0xff; packet[12] = (K >> 8) & 0xff;
        packet[13] = chunkSize & 0xff; packet[14] = (chunkSize >> 8) & 0xff;
        writeU32(packet, 15, payload.length);
        const body = packet.subarray(HEADER_LEN);
        for (const idx of packetIndices(seed, K, cdf)) xorInto(body, chunks[idx]);
        return packet;
      },
    };
  }

  // Seeds < K are systematic (packet = that single chunk); seeds >= K are LT-coded.
  function packetIndices(seed, K, cdf) {
    if (seed < K) return new Set([seed]);
    return chunkIndicesForSeed(seed, K, cdf);
  }

  function writeU32(buf, off, v) {
    buf[off] = v & 0xff; buf[off + 1] = (v >> 8) & 0xff;
    buf[off + 2] = (v >> 16) & 0xff; buf[off + 3] = (v >> 24) & 0xff;
  }
  function readU32(buf, off) {
    return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
  }

  // ---- Decoder (peeling / belief propagation) ----
  function createDecoder() {
    let transferId = null, K = 0, chunkSize = 0, payloadLen = 0, cdf = null;
    let chunks = [];        // recovered chunks by index
    let recoveredCount = 0;
    let pending = [];       // { indices:Set, data:Uint8Array }
    const seenSeeds = new Set();

    function reduce(entry) {
      for (const idx of [...entry.indices]) {
        if (chunks[idx]) { xorInto(entry.data, chunks[idx]); entry.indices.delete(idx); }
      }
    }

    function absorb(entry) {
      reduce(entry);
      if (entry.indices.size === 0) return;
      if (entry.indices.size === 1) {
        const idx = entry.indices.values().next().value;
        if (!chunks[idx]) {
          chunks[idx] = entry.data;
          recoveredCount++;
          // Peel: this new chunk may collapse other pending packets.
          const stillPending = [];
          const ready = [];
          for (const p of pending) {
            if (p.indices.has(idx)) {
              xorInto(p.data, entry.data); p.indices.delete(idx);
              if (p.indices.size === 1) ready.push(p);
              else if (p.indices.size > 1) stillPending.push(p);
            } else stillPending.push(p);
          }
          pending = stillPending;
          for (const r of ready) absorb(r);
        }
      } else {
        pending.push(entry);
      }
    }

    return {
      get K() { return K; },
      get recovered() { return recoveredCount; },
      get done() { return K > 0 && recoveredCount === K; },
      // Feed one raw packet (Uint8Array). Returns true if it was new/useful input.
      addPacket(packet) {
        if (packet.length < HEADER_LEN + 1) return false;
        if (packet[0] !== MAGIC0 || packet[1] !== MAGIC1 || packet[2] !== VERSION) return false;
        const tid = readU32(packet, 3);
        const seed = readU32(packet, 7);
        const k = packet[11] | (packet[12] << 8);
        const cs = packet[13] | (packet[14] << 8);
        const plen = readU32(packet, 15);
        if (packet.length !== HEADER_LEN + cs) return false;
        if (transferId === null) {
          transferId = tid; K = k; chunkSize = cs; payloadLen = plen;
          chunks = new Array(K).fill(null);
          cdf = robustSolitonCDF(K);
        } else if (tid !== transferId) {
          return false; // packet from a different transfer
        }
        if (this.done || seenSeeds.has(seed)) return false;
        seenSeeds.add(seed);
        absorb({ indices: new Set(packetIndices(seed, K, cdf)), data: packet.slice(HEADER_LEN) });
        return true;
      },
      // Once done: reassemble and return { meta, fileBytes }.
      result() {
        if (!this.done) return null;
        const payload = new Uint8Array(payloadLen);
        for (let i = 0; i < K; i++) {
          const end = Math.min((i + 1) * chunkSize, payloadLen);
          if (i * chunkSize < payloadLen) payload.set(chunks[i].subarray(0, end - i * chunkSize), i * chunkSize);
        }
        return parsePayload(payload);
      },
    };
  }

  return { createEncoder, createDecoder, HEADER_LEN };
});
