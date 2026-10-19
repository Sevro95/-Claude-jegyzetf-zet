// Tervezői jegyzetfüzet – service worker (offline működés)
const VERSION = "jf-v2.0.0";
const SHELL = ["./", "./index.html", "./app.css", "./app.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png", "./icons/apple-180.png"];
const LIBS = "jf-libs-v1";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== LIBS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // betűkészlet (Google Fonts): első letöltés után offline is elérhető
  if (url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com") {
    e.respondWith(caches.open(LIBS).then(async c => {
      const hit = await c.match(e.request); if (hit) return hit;
      try { const res = await fetch(e.request); if (res.ok || res.type === "opaque") c.put(e.request, res.clone()); return res; }
      catch (err) { return hit || Response.error(); }
    }));
    return;
  }
  // Google-szolgáltatások: soha ne cache-eljük
  if (/googleapis\.com|accounts\.google\.com|gstatic\.com/.test(url.host)) return;
  // pdf.js, jsPDF a cdnjs-ről: első letöltés után offline is elérhető
  if (url.host === "cdnjs.cloudflare.com") {
    e.respondWith(caches.open(LIBS).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok || res.type === "opaque") c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin === location.origin) {
    // App-váz: hálózat először (friss verzió), offline esetén cache
    // a böngésző HTTP-gyorsítótárát megkerülve kérjük le, hogy egy frissítés azonnal megérkezzen
    e.respondWith(fetch(e.request.url, { cache: "no-cache", credentials: "same-origin" }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("./index.html"))));
  }
});
