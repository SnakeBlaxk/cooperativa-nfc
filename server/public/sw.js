// Service worker — el sistema funciona SOLO CON INTERNET.
// * Solo se guarda la "cáscara" estática de la interfaz (HTML, CSS, JS e íconos) para poder mostrar el aviso
//   "Sin conexión a internet" aunque no haya red. Nunca se guardan datos.
// * Siempre se pide primero a la red (la interfaz guardada solo se usa si no hay conexión).
// * Las llamadas a /api/ nunca pasan por la caché: sin conexión fallan y la interfaz bloquea cobros y recargas.
//   No hay cola de operaciones sin conexión.
const CACHE = 'coop-v7';
const SHELL = ['/', '/index.html', '/styles.css', '/web.css', '/app.js', '/coop-web.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.ico'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return; // datos: siempre a la red
  const isShell = req.mode === 'navigate' || SHELL.includes(url.pathname);
  if (!isShell) return; // otros archivos: red directa, sin guardar
  const key = req.mode === 'navigate' ? '/index.html' : url.pathname;
  e.respondWith(fetch(req).then((r) => {
    if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(key, copy)); }
    return r;
  }).catch(() => caches.match(key).then((r) => r || (req.mode === 'navigate' ? caches.match('/') : undefined)).then((r) => r || Response.error())));
});
