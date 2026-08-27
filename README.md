# 📡 Beamdrop

**Send files as light.** Any file — images, video, audio, zips — beamed from one screen
to another device's camera as a living, color-shifting code. **No internet, no cables,
no Bluetooth, no pairing.**

## How it works

1. **Sender** opens `send.html`, picks a file, and the screen starts animating: every
   frame is a new code in a new hue, with an orbiting progress ring.
2. **Receiver** opens `receive.html` and points a camera at the sender's screen.
   A progress bar fills as pieces arrive. When it hits 100%, the file downloads.

The transfer channel is literally light. Nothing else connects the two devices.

### The airgap test

Open the site on both devices once (the service worker caches everything), then put
**both devices in airplane mode**. Transfer still works perfectly — proof that no
network is involved.

## Why missed frames don't matter

Beamdrop uses a **fountain code** (Luby Transform, the same idea behind
[txqr](https://github.com/divan/txqr)). The file is split into K chunks; each displayed
frame is a random XOR-combination of chunks derived from a seed in the frame header.
The receiver can start watching at *any* moment, miss *any* frames, and still rebuild
the file once it has caught roughly K useful frames — the peeling decoder does the rest.
Our test suite verifies full recovery even when **50% of frames are dropped**.

- First pass is *systematic* (plain chunks in order) so an attentive receiver finishes in one pass.
- Every later frame is a fresh combination, so the progress bar only ever goes up.

## Tuning

| Setting | Options | Tradeoff |
|---|---|---|
| Density | Compact 200 B · Balanced 450 B · Dense 800 B per frame | Denser = fewer frames but harder to scan at distance |
| Speed | 4 · 7 · 12 fps | Faster = shorter transfer but needs a steadier camera |

A 100 KB photo at Balanced/Steady takes roughly 30–40 seconds. Bigger files scale linearly.

## Running locally

Any static server works (the camera needs HTTPS or localhost):

```sh
python -m http.server 8000
# or
npx serve
```

Then open `http://localhost:8000`. On GitHub Pages it just works (HTTPS included).

## Tests

```sh
node test/roundtrip.test.js
```

Runs the full pipeline offline: bytes → fountain encoder → rendered frames (with the
shifting color palette) → jsQR decode → fountain decoder → bytes, under simulated
frame loss up to 50%.

## Stack

Zero build step, zero network dependencies at runtime. Vanilla JS + two vendored
libraries: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(encode) and [jsQR](https://github.com/cozmo/jsQR) (decode). MIT-licensed.
