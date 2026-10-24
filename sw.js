// Shop app — minimal service worker.
// It only exists so phones treat the shop as an installable app.
// It does NOT cache anything, so customers always see the latest drop, sales and prices.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
