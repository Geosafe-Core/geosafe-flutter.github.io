self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (e) {}
    try { await self.clients.claim(); } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    try {
      const cl = await self.clients.matchAll({ type: 'window' });
      cl.forEach(function (c) { c.navigate(c.url); });
    } catch (e) {}
  })());
});
self.addEventListener('fetch', function () {});
