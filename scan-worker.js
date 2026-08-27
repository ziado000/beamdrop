/* Beamdrop scan worker — decodes camera frames off the main thread so the
 * video preview never stutters and every frame gets processed. */
importScripts('hexcodec.js');

self.onmessage = (e) => {
  const { buf, W, H } = e.data;
  const data = new Uint8ClampedArray(buf);
  let packets = [];
  try {
    packets = HexCodec.decodeFrames(data, W, H, 4);
  } catch (err) {
    packets = [];
  }
  const buffers = packets.map((p) => p.buffer);
  self.postMessage({ packets: buffers }, buffers);
};
