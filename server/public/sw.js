// Service worker — el sistema funciona SOLO CON INTERNET.
// * Solo se guarda la "cáscara" estática de la interfaz (HTML, CSS, JS e íconos) para poder mostrar el aviso
//   "Sin conexión a internet" aunque no haya red. Nunca se guardan datos.
// * Siempre se pide primero a la red (la interfaz guardada solo se usa si no hay conexión).
// * Las llamadas a /api/ nunca pasan por la caché: sin conexión fallan y la interfaz bloquea cobros y recargas.
//   No hay cola de operaciones sin conexión.
const CACHE = 'coop-v9';
const SHELL = ['/', '/index.html', '/styles.css', '/web.css', '/app.js', '/coop-web.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/favicon.ico', '/logo-zukipay.png', '/logo-zukipay-blanco.png'];
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

// ----- Notificaciones push (padres): compras, compras rechazadas y saldo bajo -----
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Cooperativa', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Cooperativa', {
    body: d.body || '', tag: d.tag || undefined, icon: '/icon-192.png', badge: '/icon-192.png', lang: 'es-MX', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
  }));
});
// El navegador cambió la suscripción: se avisa a la app la próxima vez que se abra (se vuelve a registrar sola)
self.addEventListener('pushsubscriptionchange', () => {});
