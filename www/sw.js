/* Bornes VE — service worker. Cache l'app shell (offline). Les appels API
   (tabular-api.data.gouv.fr) ne sont PAS mis en cache : toujours du réseau. */
const CACHE = 'bornes-ve-v1.14';
const SHELL = [
  'index.html', 'styles.css', 'app.js', 'update-check.js',
  'manifest.webmanifest', 'img/icon-192.png', 'img/icon-512.png',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // API officielle : réseau uniquement (données fraîches), pas de cache.
  if (url.hostname.endsWith('data.gouv.fr') || url.hostname.includes('api.github.com')) return;
  // App shell : cache-first, repli réseau.
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
