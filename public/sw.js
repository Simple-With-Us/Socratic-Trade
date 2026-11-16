/* PWA retired (owner 2026-08-16/17).
 * If an older build ever registered a worker at this URL, this file replaces
 * it, drops Cache Storage, and unregisters so the site is a normal website.
 */
self.addEventListener("install", function (event) {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    (async function () {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (key) { return caches.delete(key); }));
      await self.registration.unregister();
      var clients = await self.clients.matchAll({ type: "window" });
      await Promise.all(
        clients.map(function (client) {
          if (client.url && "navigate" in client) return client.navigate(client.url);
          return undefined;
        })
      );
    })()
  );
});
