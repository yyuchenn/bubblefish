// Retire the 0.3 web app's worker so its cached shell cannot mask later releases.
const legacyCaches = new Set(['index-cache', 'images-cache', 'wasm-cache', 'static-resources']);

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const scopeSuffix = `-${self.registration.scope}`;
        const names = await caches.keys();
        await Promise.allSettled(
          names
            .filter(
              (name) =>
                legacyCaches.has(name) ||
                (name.startsWith('workbox-precache-') && name.endsWith(scopeSuffix)),
            )
            .map((name) => caches.delete(name)),
        );
      } finally {
        // Existing editors stay open; later navigation loads directly from the network.
        await self.registration.unregister();
      }
    })(),
  );
});
