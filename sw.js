/* Offline support: keeps a copy of the app on the phone so it opens with no signal.
 * App files are served from the phone first and refreshed in the background, so a new
 * version you upload to GitHub shows up the next time the app is opened.
 * Calls to Google (sync) are never cached. */
const CACHE = "grid-downtime-v3";
const FONT_CACHE = "grid-downtime-fonts";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest",
  "assets/logo.png", "assets/logo-white.png", "assets/favicon.png", "assets/apple-touch-icon.png",
  "assets/icon-192.png", "assets/icon-512.png", "assets/icon-maskable-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function staleWhileRevalidate(req, cacheName, fallbackUrl) {
  return caches.open(cacheName).then(cache => cache.match(req, { ignoreSearch: true }).then(hit => {
    const fresh = fetch(req).then(res => { if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone()); return res; })
      .catch(() => hit || (fallbackUrl ? cache.match(fallbackUrl) : undefined));
    return hit || fresh;
  }));
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // Page loads (including links with #connect=…) always get the app page.
    if (req.mode === "navigate") { e.respondWith(staleWhileRevalidate(new Request(new URL("index.html", self.registration.scope)), CACHE, "index.html")); return; }
    e.respondWith(staleWhileRevalidate(req, CACHE));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") e.respondWith(staleWhileRevalidate(req, FONT_CACHE));
});
