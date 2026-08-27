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

Runs the full encode → render → scan → decode pipeline offline and verifies the
bytes come back identical.

## Stack

Zero build step, zero network dependencies at runtime. Vanilla JS + two vendored
libraries: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(encode) and [jsQR](https://github.com/cozmo/jsQR) (decode).

## License

[MIT](LICENSE) — use it, remix it, ship it. Contributions welcome via pull request.
