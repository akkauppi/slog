// CI verifies this value against the content of every APP_SHELL entry. A new
// worker must never populate the cache still owned by an active transaction.
const APP_SHELL_REVISION = "77d64e13de38";
const CACHE_NAME = `sauna-commissioning-${APP_SHELL_REVISION}`;
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./js/app.js",
  "./js/diagnostics.js",
  "./js/data-workspace.js",
  "./js/log-analysis.js",
  "./js/log-management.js",
  "./js/session-export.js",
  "./js/flash-ui.js",
  "./js/flashing.js",
  "./js/recovery-store.js",
  "./js/esptool-adapter.js",
  "./js/commissioning.js",
  "./js/protocol.js",
  "./js/serial-transport.js",
  "./vendor/esptool-js-0.6.0.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
];

const scopedUrl = (path) => new URL(path, self.registration.scope).href;
const FIRMWARE_ROOT = scopedUrl("./generated/firmware/");

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

  // Firmware has its own content-addressed durable recovery cache. Never put
  // the mutable release manifest in the app-shell cache or silently fall back
  // to an earlier release. Immutable package files can be fetched directly;
  // the install workflow validates and persists all four before writing.
  if (url.href.startsWith(FIRMWARE_ROOT)) {
    event.respondWith(fetch(request));
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        // APP_SHELL is populated during installation as one versioned set.
        // Never refresh individual entries in an active worker's cache: doing
        // so can combine modules from different releases if the server drops
        // out partway through a page load.
        return await fetch(request);
      } catch {
        if (request.mode === "navigate") {
          return cache.match(scopedUrl("./index.html"));
        }
        throw new Error(`No offline response for ${request.url}`);
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "ACTIVATE_UPDATE") self.skipWaiting();
});
