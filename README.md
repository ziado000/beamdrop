# 📡 Beamdrop

**Send files as light.** Any file — images, video, audio, zips — beamed from one screen
to another device's camera as a living, color-shifting code. **No internet, no cables,
no Bluetooth, no pairing.**

## ✨ Try it now

| | |
|---|---|
| **Open the app** | **https://ziado000.github.io/beamdrop/** |
| Send a file | https://ziado000.github.io/beamdrop/send.html |
| Receive a file | https://ziado000.github.io/beamdrop/receive.html |

No install, no account — open it in any browser, on any device with a screen or a camera.

## How it works

1. **Sender** opens `send.html`, picks a file, and the screen starts animating: every
   frame is a new code in a new hue, with an orbiting progress ring.
2. **Receiver** opens `receive.html` and points a camera at the sender's screen.
   A progress bar fills as pieces arrive. When it hits 100%, the file downloads.

The transfer channel is literally light. Nothing else connects the two devices.
You can start watching mid-beam and the progress bar only ever goes up.

## The Aurora honeycomb

The code is a flowing field of melted color inside a thin light frame — no
markers, no squares, no dots, no grid. The frame's own edge is the geometry:
the receiver finds the glowing quadrilateral, takes its corners for the
perspective math, and tries all four rotations — error correction instantly
rejects the three wrong ones, so no orientation mark is needed either.

Underneath, the colors *are* the data: each point of the field carries 3 bits
as one of 8 hues, blurred into its neighbors for the look while staying pure
enough at its center to read. Calibration cells drift with the palette, so the
receiver re-learns the colors on every frame under any lighting, and
Reed-Solomon error correction shrugs off misread cells.

## Tuning

| Setting | Per frame | Tradeoff |
|---|---|---|
| Compact | 139 B | Easiest to scan at distance |
| Balanced | 339 B | Good default |
| Dense | 529 B | Fastest, hold the camera closer |
| Speed | 5 · 8 · 12 fps | Faster needs a steadier camera |
| Tiles | 1 · 2 · 4 honeycombs at once | More tiles = multiplied speed, closer camera |

Dense × Rapid × Quad moves ~25 KB/s — a 1 MB file in under a minute of clean
scanning. The receiver decodes in a Web Worker, so the camera preview never
stutters while it churns through frames.

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
node test/hex.test.js
```

Runs the full encode → render → scan → decode pipeline offline — including a
simulated camera (perspective tilt, blur, color tint, sensor noise) — and
verifies the bytes come back identical.

## Stack

Zero build step, zero dependencies, zero network at runtime. Every line —
the fountain code, the honeycomb codec, the Reed-Solomon error correction,
and the camera decoder — is vanilla JavaScript in this repo.

## License

[MIT](LICENSE) — use it, remix it, ship it. Contributions welcome via pull request.
