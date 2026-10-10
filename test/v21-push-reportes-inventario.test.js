'use strict';
// v2.1: notificaciones push a padres, reportes por rango (y corte del cajero) e inventario.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { openDatabase } = require('../src/core/db');
const { resolveVapid } = require('../src/core/push');

let S, srv, base, A, C, M, J; const sent = []; let failNext = null;
const sender = async (sub, payload) => {
  if (failNext && failNext.endpoint === sub.endpoint) { const code = failNext.code; failNext = null; throw Object.assign(new Error('fallo'), { statusCode: code }); }
  sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
};
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const tok = async (u, p) => (await api('/api/auth/login', { body: { identifier: u, password: p } })).data.access_token;
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const prod = (n, sid = 1) => S.db.get('SELECT * FROM products WHERE name = ? AND school_id = ?', [n, sid]);
const SOFIA = '04A1B2C3D4E5F6';
const sub = (n) => ({ endpoint: 'https://push.example.com/send/' + n, keys: { p256dh: 'BPk' + n + 'x'.repeat(60), auth: 'auth' + n + 'xxxxxxxx' } });
const flush = () => S.push.idle();

before(async () => {
  S = await createServer({ cardStock: false, jwtSecret: 'v'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, pushSender: sender, env: {} });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  [A, C, M, J] = [await tok('admin', 'admin123'), await tok('cajero', 'cajero123'), await tok('maria', 'tutor123'), await tok('juan', 'tutor123')];
  // sin límites de gasto para Sofía (las pruebas hacen muchas compras el mismo día)
  const sofia = S.db.get("SELECT id FROM children WHERE full_name = 'Sofía Hernández'");
  await rpc('setLimits', { child_id: sofia.id }, M);
});
after(() => new Promise((r) => srv.close(r)));

test('VAPID: sin variables se generan y guardan en la base (mismas tras reiniciar); con variables se usan esas', async () => {
  const k = await api('/api/push/key');
  assert.ok(k.data.publicKey && k.data.publicKey.length > 80);
  assert.equal(resolveVapid(S.db, {}).publicKey, k.data.publicKey, 'estables');
  const e = resolveVapid(S.db, { VAPID_PUBLIC_KEY: 'PUB', VAPID_PRIVATE_KEY: 'PRIV', VAPID_SUBJECT: 'mailto:a@b.mx' });
  assert.deepEqual([e.publicKey, e.privateKey, e.subject, e.source], ['PUB', 'PRIV', 'mailto:a@b.mx', 'env']);
});

test('push: suscribirse (solo tutor), preferencias con umbral por defecto $50, validaciones', async () => {
  assert.equal((await rpc('pushSubscribe', { subscription: sub(1) }, A)).status, 403);
  assert.equal((await rpc('pushSubscribe', { subscription: { endpoint: 'http://inseguro', keys: { p256dh: 'x', auth: 'y' } } }, M)).status, 400);
  let r = await rpc('pushSubscribe', { subscription: sub(1) }, M); assert.equal(r.ok, true, r.error);
  assert.equal(r.data.subscriptions, 1); assert.equal(r.data.low_balance_cents, 5000); assert.equal(r.data.purchases, true);
  r = await rpc('pushSubscribe', { subscription: sub(1) }, M); assert.equal(r.data.subscriptions, 1, 'no duplica');
  assert.equal((await rpc('setPushPrefs', { low_balance_cents: 5 }, M)).status, 400);
  const t = await api('/api/push/test', { body: {}, token: M }); assert.equal(t.data.sent, 1);
  assert.match(sent.pop().title, /activadas/);
});

test('push: compra aprobada (resumen, monto, saldo) y rechazada; respeta interruptores; solo al tutor del alumno', async () => {
  await rpc('pushSubscribe', { subscription: sub(9) }, J); sent.length = 0;
  const bal = S.db.get('SELECT balance_cents FROM cards WHERE uid = ?', [SOFIA]).balance_cents;
  let r = await rpc('purchase', { uid: SOFIA, items: [{ product_id: prod('Gomitas').id, qty: 2 }] }, C); assert.equal(r.data.ok, true, r.data.reason);
  await flush();
  const m1 = sent.filter((x) => x.kind === 'compra'); assert.equal(m1.length, 1);
  assert.equal(m1[0].endpoint, sub(1).endpoint, 'solo el teléfono de María');
  assert.match(m1[0].title, /Sofía compró \$20\.00/); assert.match(m1[0].body, /2× Gomitas/); assert.match(m1[0].body, new RegExp('\\$' + ((bal - 2000) / 100).toFixed(2).replace('.', '\\.')));
  sent.length = 0;
  r = await rpc('purchase', { uid: SOFIA, items: [{ product_id: prod('Coca-Cola 355 ml').id, qty: 1 }] }, C); assert.equal(r.data.ok, false);
  await flush(); assert.equal(sent.length, 1); assert.equal(sent[0].kind, 'rechazada'); assert.match(sent[0].body, /prohibido/i);
  // desactivar compras y rechazos
  await rpc('setPushPrefs', { purchases: false, rejected: false }, M); sent.length = 0;
  await rpc('purchase', { uid: SOFIA, items: [{ product_id: prod('Gomitas').id, qty: 1 }] }, C);
  await rpc('purchase', { uid: SOFIA, items: [{ product_id: prod('Coca-Cola 355 ml').id, qty: 1 }] }, C);
  await flush(); assert.equal(sent.filter((x) => x.kind !== 'saldo_bajo').length, 0);
  await rpc('setPushPrefs', { purchases: true, rejected: true }, M);
});

test('push: saldo bajo una sola vez por cruce del umbral; se rearma al recargar', async () => {
  await rpc('setPushPrefs', { low_balance_cents: 5000, purchases: false }, M);
  const card = S.db.get('SELECT * FROM cards WHERE uid = ?', [SOFIA]);
  // dejar el saldo en $60
  await rpc('adjust', { uid: SOFIA, amount_cents: 6000 - card.balance_cents, note: 'prueba' }, A); sent.length = 0;
  const g = prod('Gomitas').id; // $10
  await rpc('purchase', { uid: SOFIA, items: [{ product_id: g, qty: 1 }] }, C); await flush();
  assert.equal(sent.filter((x) => x.kind === 'saldo_bajo').length, 0, '$50 no es menor a $50');
  await rpc('purchase', { uid: SOFIA, items: [{ product_id: g, qty: 1 }] }, C); await flush();
  assert.equal(sent.filter((x) => x.kind === 'saldo_bajo').length, 1); assert.match(sent.find((x) => x.kind === 'saldo_bajo').body, /\$40\.00/);
  await rpc('purchase', { uid: SOFIA, items: [{ product_id: g, qty: 1 }] }, C); await flush();
  assert.equal(sent.filter((x) => x.kind === 'saldo_bajo').length, 1, 'no se repite');
  await rpc('recharge', { uid: SOFIA, amount_cents: 10000 }, C);
  await rpc('purchase', { uid: SOFIA, items: [{ product_id: g, qty: 10 }] }, C); await flush();
  assert.equal(sent.filter((x) => x.kind === 'saldo_bajo').length, 2, 'nuevo cruce');
  await rpc('setPushPrefs', { purchases: true }, M);
});

test('push: suscripciones vencidas (404/410) se borran; otros errores no', async () => {
  failNext = { endpoint: sub(1).endpoint, code: 500 };
  await S.push.test(S.svc.login('maria', 'tutor123').id);
  assert.ok(S.db.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [sub(1).endpoint]));
  failNext = { endpoint: sub(1).endpoint, code: 410 };
  await S.push.test(S.svc.login('maria', 'tutor123').id);
  assert.equal(S.db.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [sub(1).endpoint]), undefined);
  await rpc('pushSubscribe', { subscription: sub(2) }, M);
  const r = await rpc('pushUnsubscribe', { endpoint: sub(2).endpoint }, M); assert.equal(r.data.subscriptions, 0);
});

test('inventario: piezas y mínimo opcionales, descuento atómico, bloqueo en 0 (o permitir), entradas con bitácora, aviso por agotarse una vez', async () => {
  const p = prod('Mazapán');
  assert.equal(p.stock, null, 'sin control por defecto');
  let r = await rpc('updateProduct', { id: p.id, stock: 3, stock_min: 1 }, A); assert.equal(r.ok, true, r.error);
  assert.equal((await rpc('updateProduct', { id: p.id, stock: -2 }, A)).status, 400);
  await rpc('recharge', { uid: SOFIA, amount_cents: 20000 }, C);
  r = await rpc('purchase', { uid: SOFIA, items: [{ product_id: p.id, qty: 2 }] }, C); assert.equal(r.data.ok, true, r.data.reason);
  assert.equal(prod('Mazapán').stock, 1);
  let notes = (await rpc('listSchoolNotices', {}, A)).data.filter((n) => n.ref_id === p.id);
  assert.equal(notes.length, 1); assert.match(notes[0].message, /por agotarse/);
  assert.ok((await rpc('changeRequestsUnread', {}, A)).data.notices >= 1, 'insignia');
  let low = (await rpc('listProducts', { low: true }, A)).data; assert.ok(low.some((x) => x.id === p.id && x.low_stock));
  // bloqueo en 0
  r = await rpc('purchase', { uid: SOFIA, items: [{ product_id: p.id, qty: 2 }] }, C); assert.equal(r.data.ok, false); assert.match(r.data.reason, /Existencias insuficientes/);
  assert.equal(prod('Mazapán').stock, 1, 'no cambia al rechazar');
  r = await rpc('purchase', { uid: SOFIA, items: [{ product_id: p.id, qty: 1 }] }, C); assert.equal(r.data.ok, true);
  r = await rpc('purchase', { uid: SOFIA, items: [{ product_id: p.id, qty: 1 }] }, C); assert.match(r.data.reason, /Sin existencias/);
  notes = (await rpc('listSchoolNotices', {}, A)).data.filter((n) => n.ref_id === p.id); assert.equal(notes.length, 1, 'una vez por cruce');
  // permitir vender sin existencias
  assert.equal((await rpc('setInventorySettings', { block_at_zero: false }, C)).status, 403);
  await rpc('setInventorySettings', { block_at_zero: false }, A);
  r = await rpc('purchase', { uid: SOFIA, items: [{ product_id: p.id, qty: 1 }] }, C); assert.equal(r.data.ok, true); assert.equal(prod('Mazapán').stock, -1);
  await rpc('setInventorySettings', { block_at_zero: true }, A);
  // entrada
  assert.equal((await rpc('addStock', { product_id: p.id, qty: 10 }, C)).status, 403);
  assert.equal((await rpc('addStock', { product_id: p.id, qty: 0 }, A)).status, 400);
  r = await rpc('addStock', { product_id: p.id, qty: 10, note: 'Proveedor' }, A); assert.equal(r.data.stock, 9);
  assert.equal(prod('Mazapán').low_notified, 0, 'se rearma');
  const mv = (await rpc('listStockMoves', { product_id: p.id }, A)).data;
  assert.equal(mv[0].kind, 'entrada'); assert.equal(mv[0].qty, 10); assert.equal(mv[0].note, 'Proveedor');
  assert.ok(mv.some((m) => m.kind === 'venta' && m.qty === -2));
  assert.ok(S.db.get("SELECT id FROM audit_log WHERE action = 'inventario_entrada'"));
  // otra escuela no ve ni toca
  const A2 = await tok('admin2', 'admin123');
  assert.equal((await rpc('addStock', { product_id: p.id, qty: 1 }, A2)).status, 404);
  // tutor no ve existencias
  const tp = (await rpc('listProducts', {}, M)).data.find((x) => x.id === p.id); assert.equal(tp.stock, undefined);
  // cancelar venta: devuelve saldo y piezas
  const sale = await rpc('purchase', { uid: SOFIA, items: [{ product_id: p.id, qty: 3 }] }, C);
  const before = S.db.get('SELECT balance_cents FROM cards WHERE uid = ?', [SOFIA]).balance_cents;
  assert.equal((await rpc('reverseSale', { transaction_id: sale.data.transaction_id, reason: 'x' }, C)).status, 403);
  r = await rpc('reverseSale', { transaction_id: sale.data.transaction_id, reason: 'Cobro duplicado' }, A); assert.equal(r.ok, true, r.error);
  assert.equal(r.data.balance_cents, before + sale.data.total_cents); assert.equal(prod('Mazapán').stock, 9);
  assert.equal((await rpc('reverseSale', { transaction_id: sale.data.transaction_id, reason: 'x' }, A)).status, 409);
});

test('inventario: venta con varios productos es todo o nada (si uno no alcanza, nada se descuenta)', async () => {
  const a = prod('Chocolate'); const b = prod('Mazapán');
  await rpc('updateProduct', { id: a.id, stock: 5 }, A); await rpc('updateProduct', { id: b.id, stock: 1 }, A);
  const r = await rpc('purchase', { uid: SOFIA, items: [{ product_id: a.id, qty: 2 }, { product_id: b.id, qty: 2 }] }, C);
  assert.equal(r.data.ok, false); assert.equal(prod('Chocolate').stock, 5); assert.equal(prod('Mazapán').stock, 1);
});

test('reportes: totales por rango, por día, más vendidos, por cajero, rechazadas; cajero solo su corte de hoy', async () => {
  const today = new Date(); const p = (n) => String(n).padStart(2, '0'); const ymd = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
  const r = await rpc('report', { from: ymd, to: ymd }, A); assert.equal(r.ok, true, r.error);
  const d = r.data;
  const exp = S.db.get("SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM transactions WHERE school_id = 1 AND type='compra' AND status='aprobado' AND reversed_at IS NULL AND created_at >= ?", [ymd + ' 00:00:00']);
  assert.equal(d.sales_cents, exp.s); assert.equal(d.sales_count, exp.n); assert.equal(d.avg_ticket_cents, Math.round(exp.s / exp.n));
  assert.ok(d.recharges_cents > 0); assert.ok(d.rejected_count > 0); assert.ok(d.cancelled_count >= 1);
  assert.equal(d.sales_by_day.length, 1); assert.equal(d.sales_by_day[0].total_cents, exp.s);
  assert.ok(d.top_products.length > 0); assert.ok(d.by_cashier.some((x) => x.name === 'Cajera Rosa López'));
  assert.equal(d.school_name, S.db.get('SELECT name FROM schools WHERE id = 1').name);
  const wk = await rpc('report', { from: '2026-01-01', to: '2026-01-07' }, A); assert.equal(wk.data.sales_by_day.length, 7);
  assert.equal((await rpc('report', { from: '2026-02-10', to: '2026-02-01' }, A)).status, 400);
  assert.equal((await rpc('report', { from: 'ayer' }, A)).status, 400);
  // cajero: solo hoy y solo sus ventas
  const c = (await rpc('report', { from: '2020-01-01', to: '2030-01-01' }, C)).data;
  assert.equal(c.from, ymd); assert.equal(c.to, ymd); assert.equal(c.only_cashier, 'Cajera Rosa López');
  assert.ok(c.by_cashier.every((x) => x.name === 'Cajera Rosa López'));
  assert.equal((await rpc('report', {}, M)).status, 403);
  // otra escuela: sus propios datos
  const A2 = await tok('admin2', 'admin123');
  const o = (await rpc('report', { from: ymd, to: ymd }, A2)).data; assert.notEqual(o.school_name, d.school_name);
});

test('migración segura: base de versión anterior conserva productos y agrega columnas/tablas nuevas', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coop-v21-')), 'old.db');
  const db = await openDatabase(f);
  db.db.exec("INSERT INTO schools (name, created_at) VALUES ('Vieja', '2025-01-01'); INSERT INTO categories (school_id, name) VALUES (1, 'Dulces'); INSERT INTO products (school_id, name, category_id, price_cents, created_at) VALUES (1, 'Paleta', 1, 500, '2025-01-01');");
  // simula una base vieja: sin columnas ni tablas de v2.1
  db.db.exec('DROP TABLE push_subscriptions; DROP TABLE push_prefs; DROP TABLE stock_moves; DROP TABLE school_notices; DROP TABLE low_balance_state; ALTER TABLE products DROP COLUMN stock; ALTER TABLE products DROP COLUMN stock_min; ALTER TABLE products DROP COLUMN low_notified;');
  db.save(); db.close();
  const db2 = await openDatabase(f);
  const p = db2.get("SELECT * FROM products WHERE name = 'Paleta'");
  assert.equal(p.price_cents, 500); assert.equal(p.stock, null); assert.equal(p.stock_min, null);
  for (const t of ['push_subscriptions', 'push_prefs', 'stock_moves', 'school_notices', 'low_balance_state']) assert.ok(db2.get("SELECT name FROM sqlite_master WHERE name = ?", [t]), t);
  assert.equal(db2.get('SELECT stock_block_zero FROM schools').stock_block_zero, 1);
});

test('push: con las llaves VAPID del servidor se arma una notificación cifrada válida (web-push)', () => {
  const webpush = require('web-push'); const crypto = require('crypto');
  const v = resolveVapid(S.db, {});
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
  const d = webpush.generateRequestDetails(subscription, JSON.stringify({ title: 'x' }), { vapidDetails: { subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey } });
  assert.match(d.headers.Authorization, /^vapid t=.+, k=/); assert.equal(d.headers['Content-Encoding'], 'aes128gcm'); assert.ok(d.body.length > 0);
});
