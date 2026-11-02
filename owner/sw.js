// Owner app — minimal service worker.
// It only exists so phones treat the owner page as its own installable app.
// It does NOT cache anything, so the owner always sees the latest settings.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
