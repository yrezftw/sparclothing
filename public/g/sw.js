// spår gallery service worker: makes the app installable and keeps galleries
// viewable without signal (photos you've already opened stay on the phone).
const VERSION = "v1";
const SHELL = `spar-shell-${VERSION}`;
const PHOTOS = "spar-photos";
const DATA = "spar-data";
const SHELL_FILES = ["/g/", "/g/app.js", "/g/app.css", "/g/manifest.webmanifest", "/g/icon.svg", "/g/icon-192.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("spar-shell-") && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("message", e => {
  if (e.data?.type !== "forget" || !/^[0-9A-Z]{6}$/.test(e.data.id)) return;
  const prefix = `/api/g/${e.data.id}`;
  e.waitUntil(Promise.all([PHOTOS, DATA].map(async name => {
    const cache = await caches.open(name);
    for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith(prefix)) await cache.delete(req);
  })));
});

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(fallbackUrl || request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(fallbackUrl || request);
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(PHOTOS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  if (req.mode === "navigate" && p.startsWith("/g/")) return e.respondWith(networkFirst(req, SHELL, "/g/"));
  if (/^\/api\/g\/[0-9A-Z]{6}\/photos\/[0-9A-Z]+\/(full|thumb)$/.test(p)) return e.respondWith(cacheFirst(req));
  if (/^\/api\/g\/[0-9A-Z]{6}$/.test(p)) return e.respondWith(networkFirst(req, DATA));
  if (p.startsWith("/g/")) return e.respondWith(networkFirst(req, SHELL));
});
