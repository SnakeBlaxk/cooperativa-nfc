'use strict';
// Sistema SOLO EN LÍNEA: sin operación sin internet, sin cola de ventas, sin datos en caché.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { normalizeServerUrl, resolveServerUrl, checkServer, isAllowedUrl, DEFAULT_SERVER_URL } = require('../src/main/online');

let S, srv, base;
before(async () => {
  S = await createServer({ cardStock: false, jwtSecret: 'o'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise((r) => srv.close(r)));
async function api(p, { body, token, headers } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, headers: r.headers, ...(await r.json()) };
}
const login = async (u, p) => (await api('/api/auth/login', { body: { identifier: u, password: p } })).data.access_token;

test('servidor: el envío de ventas sin conexión de cajas viejas se rechaza (410 VERSION_OBSOLETA)', async () => {
  const admin = await login('admin', 'admin123');
  const dev = await api('/api/sync/devices', { body: { device_id: 'a'.repeat(32), name: 'Caja vieja' }, token: admin });
  assert.equal(dev.ok, true);
  const r = await api('/api/sync/push', { body: { entities: { transactions: [] } }, headers: { 'X-Device-Token': dev.data.device_token } });
  assert.equal(r.status, 410); assert.equal(r.code, 'VERSION_OBSOLETA'); assert.match(r.error, /solo con internet/);
});

test('servidor: aunque la escuela tuviera una caja vieja "principal", se cobra y recarga en línea', async () => {
  const sid = S.db.get("SELECT school_id FROM users WHERE username = 'admin'").school_id;
  S.db.run("UPDATE schools SET primary_device_id = 'b' || '' WHERE id = ?", [sid]);
  const caj = await login('cajero', 'cajero123');
  const before = S.db.get("SELECT balance_cents AS b FROM cards WHERE uid = '04A1B2C3D4E5F6'").b;
  const rec = await api('/api/rpc/recharge', { body: { uid: '04A1B2C3D4E5F6', amount_cents: 1000 }, token: caj });
  assert.equal(rec.ok, true, rec.error);
  const prod = S.db.get('SELECT id, price_cents FROM products WHERE school_id = ? AND active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1', [sid]);
  const sale = await api('/api/rpc/purchase', { body: { uid: '04A1B2C3D4E5F6', items: [{ product_id: prod.id, qty: 1 }] }, token: caj });
  assert.equal(sale.ok, true, sale.error); assert.equal(sale.data.ok, true);
  assert.equal(S.db.get("SELECT balance_cents AS b FROM cards WHERE uid = '04A1B2C3D4E5F6'").b, before + 1000 - prod.price_cents);
  S.db.run('UPDATE schools SET primary_device_id = NULL WHERE id = ?', [sid]);
});

test('servidor: las respuestas de la API nunca se guardan en caché', async () => {
  const r = await api('/api/health');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('servidor: hoja de códigos para padres en línea (Programar tarjetas → paso 3)', async () => {
  const admin = await login('admin', 'admin123');
  const sid = S.db.get("SELECT school_id FROM users WHERE username = 'admin'").school_id;
  const kids = S.db.all('SELECT id, tutor_id FROM children WHERE school_id = ?', [sid]);
  const other = S.db.get('SELECT id FROM children WHERE school_id <> ? LIMIT 1', [sid]);
  const r = await api('/api/admin/invitation-sheet', { body: { child_ids: [...kids.map((k) => k.id), other.id], include_linked: true }, token: admin });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.codes.length, kids.length); // el alumno de otra escuela se ignora
  assert.ok(r.data.codes.every((c) => c.code && c.child_id));
  const caj = await login('cajero', 'cajero123');
  assert.equal((await api('/api/admin/invitation-sheet', { body: { child_ids: [] }, token: caj })).status, 403);
});

// ----- adaptador web (coop-web.js) en un entorno simulado -----
function loadAdapter({ online = true, fetchImpl }) {
  const calls = [];
  const listeners = {};
  const body = { classList: { toggle() {} }, appendChild() {} };
  const el = () => ({ setAttribute() {}, appendChild() {}, append() {}, addEventListener() {}, classList: { toggle() {} } });
  const ctx = {
    navigator: { onLine: online },
    localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; }, removeItem(k) { delete this._d[k]; } },
    document: { readyState: 'complete', body, createElement: el, addEventListener() {} },
    fetch: async (url, opts) => { calls.push({ url, opts }); return fetchImpl(url, opts); },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; }, clearTimeout,
    AbortController, URL, console, location: { protocol: 'file:' },
  };
  ctx.window = ctx; ctx.addEventListener = (n, cb) => { listeners[n] = cb; };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'coop-web.js'), 'utf8'), ctx);
  return { coop: ctx.window.coop, calls, ctx, listeners };
}
const okJson = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, data }) });

test('web: sin internet (navigator.onLine = false) no se envía ninguna venta ni recarga y se avisa', async () => {
  const { coop, calls } = loadAdapter({ online: false, fetchImpl: async () => okJson({}) });
  for (const m of ['purchase', 'recharge']) {
    const r = await coop.call(m, { uid: 'X', amount_cents: 100 });
    assert.equal(r.ok, false); assert.equal(r.code, 'SIN_CONEXION');
    assert.equal(r.error, 'Sin conexión a internet. No se puede cobrar hasta que regrese la conexión.');
  }
  assert.equal(calls.filter((c) => c.url.startsWith('/api/rpc/')).length, 0);
  assert.equal(coop.connection.isOnline(), false);
});

test('web: si el servidor no responde, la operación falla (sin cola) y se pide revisar Movimientos; al volver se recupera', async () => {
  let up = true;
  const { coop, calls } = loadAdapter({ fetchImpl: async (url) => { if (!up) throw new TypeError('Failed to fetch'); return okJson(url === '/api/health' ? { status: 'ok' } : { access_token: 'a', refresh_token: 'r', user: { id: 1 } }); } });
  await coop.connection.check();
  assert.equal(coop.connection.isOnline(), true);
  assert.equal((await coop.call('login', { username: 'cajero', password: 'x' })).ok, true);
  const changes = []; coop.connection.onChange((v) => changes.push(v));
  up = false;
  const r = await coop.call('purchase', { uid: 'X', items: [] });
  assert.equal(r.code, 'SIN_CONEXION'); assert.match(r.error, /NO se pudo confirmar/);
  assert.equal(coop.connection.isOnline(), false);
  const n = calls.length;
  assert.equal((await coop.call('recharge', { uid: 'X', amount_cents: 1 })).code, 'SIN_CONEXION');
  assert.equal(calls.filter((c, i) => i >= n && c.url.startsWith('/api/rpc/')).length, 0); // bloqueado sin intentar
  assert.equal(await coop.connection.check(), false); // reintento automático: sigue sin conexión
  up = true;
  assert.equal(await coop.connection.check(), true);
  assert.deepEqual(changes, [false, true]);
  assert.equal((await coop.call('recharge', { uid: 'X', amount_cents: 1 })).ok, true);
  // nada se reenvió solo: cada llamada a la API corresponde a una acción del usuario
  assert.equal(calls.filter((c) => c.url === '/api/rpc/purchase').length, 1);
});

test('web: el evento "offline" del navegador bloquea de inmediato', async () => {
  const { coop, listeners } = loadAdapter({ fetchImpl: async () => okJson({ status: 'ok' }) });
  await coop.connection.check();
  listeners.offline();
  assert.equal(coop.connection.isOnline(), false);
});

// ----- service worker -----
function loadSW() {
  const handlers = {}; const cache = new Map(); let net = true;
  const ctx = {
    self: { addEventListener: (n, h) => { handlers[n] = h; }, skipWaiting() {}, clients: { claim() {} }, location: { origin: 'https://x.test' } },
    caches: { open: async () => ({ addAll: async () => {}, put: async (k, r) => { cache.set(k, r); } }), match: async (k) => cache.get(k), keys: async () => [], delete: async () => true },
    fetch: async (req) => { if (!net) throw new TypeError('offline'); return { ok: true, clone() { return { from: 'net-copy', url: req.url }; }, from: 'net', url: req.url }; },
    Request: function (u) { this.url = u; }, Response: { error: () => ({ error: true }) }, URL,
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'sw.js'), 'utf8'), ctx);
  const fire = (url, { method = 'GET', mode = 'cors' } = {}) => { let p = null; handlers.fetch({ request: { url, method, mode }, respondWith: (x) => { p = x; } }); return p; };
  return { fire, cache, setNet: (v) => { net = v; } };
}

test('service worker: nunca responde datos de la API ni guarda archivos que no son la interfaz', async () => {
  const { fire, cache, setNet } = loadSW();
  assert.equal(fire('https://x.test/api/rpc/listCards'), null); // va directo a la red
  assert.equal(fire('https://x.test/api/rpc/purchase', { method: 'POST' }), null);
  assert.equal(fire('https://x.test/otra-cosa.json'), null);
  const r = await fire('https://x.test/app.js'); // red primero
  assert.equal(r.from, 'net');
  await new Promise((x) => setImmediate(x));
  assert.ok(cache.has('/app.js'));
  assert.ok([...cache.keys()].every((k) => !k.startsWith('/api/')));
  setNet(false); // sin red: solo la interfaz guardada (para mostrar el aviso de sin conexión)
  assert.equal((await fire('https://x.test/app.js')).from, 'net-copy');
  assert.equal(fire('https://x.test/api/rpc/listCards'), null);
});

// ----- caja de escritorio (cliente en línea) -----
test('escritorio: dirección del servidor configurable con la de Render por defecto', async () => {
  assert.equal(DEFAULT_SERVER_URL, 'https://cooperativa-nfc.onrender.com');
  assert.equal(resolveServerUrl({}, {}), DEFAULT_SERVER_URL);
  assert.equal(resolveServerUrl({}, { serverUrl: 'mi-servidor.mx/' }), 'https://mi-servidor.mx');
  assert.equal(resolveServerUrl({ COOP_SERVER_URL: 'http://127.0.0.1:3000/x' }, { serverUrl: 'https://a.mx' }), 'http://127.0.0.1:3000');
  assert.equal(resolveServerUrl({}, { serverUrl: 'ftp://malo' }), DEFAULT_SERVER_URL);
  assert.throws(() => normalizeServerUrl('javascript:alert(1)'));
  assert.throws(() => normalizeServerUrl(''));
  assert.equal(isAllowedUrl('https://cooperativa-nfc.onrender.com/?x=1', DEFAULT_SERVER_URL), true);
  assert.equal(isAllowedUrl('https://evil.example/', DEFAULT_SERVER_URL), false);
});

test('escritorio: comprueba el servidor real y detecta cuando no responde', async () => {
  assert.deepEqual(await checkServer(base), { ok: true });
  const down = await checkServer('http://127.0.0.1:1');
  assert.equal(down.ok, false); assert.match(down.error, /Sin conexión/);
  const slow = await checkServer(base, { timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) });
  assert.match(slow.error, /no respondió a tiempo/);
});

test('escritorio: ya no usa base local ni cola de ventas sin conexión', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.doesNotMatch(main, /require\('\.\.\/core\/(db|sync-client|service)'\)/);
  assert.match(main, /loadURL/);
});
