// Guarda o app inteiro em cache para funcionar sem internet.
// A cada atualização do app, mude a versão abaixo.
const CACHE = "human-pace-v6";
const FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "manifest.json",
  "fonts/DSEG7Classic-Bold.woff2",
  "fonts/barlow-400.woff2",
  "fonts/barlow-600.woff2",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
