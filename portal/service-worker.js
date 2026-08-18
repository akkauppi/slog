// CI verifies this value against the content of every APP_SHELL entry. A new
// worker must never populate the cache still owned by an active transaction.
const APP_SHELL_REVISION = "b2612fe95cb4";
const CACHE_NAME = `sauna-commissioning-${APP_SHELL_REVISION}`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app.js",
  "./js/commissioning.js",
  "./js/protocol.js",
  "./js/serial-transport.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
];

const scopedUrl = (path) => new URL(path, self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL.map(scopedUrl))),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("sauna-commissioning-") && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      let response;
      try {
        response = await fetch(request);
      } catch {
        const cached = await cache.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          return cache.match(scopedUrl("./index.html"));
        }
        throw new Error(`No offline response for ${request.url}`);
      }
      if (response.ok) {
        try {
          await cache.put(request, response.clone());
        } catch {
          // A full/disabled cache must never replace a good network response.
        }
      }
      return response;
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});
