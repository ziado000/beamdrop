/* Beamdrop service worker â€” cache everything so the app works with internet cut. */
const CACHE = 'beamdrop-v6';
const ASSETS = [
  './',
  'index.html',
  'send.html',
  'receive.html',
  'style.css',
  'fountain.js',
  'hexcodec.js',
  'send.js',
  'receive.js',
  'scan-worker.js',
  'sw.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
