'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { openDatabase } = require('../src/core/db');
const { createService } = require('../src/core/service');
const { seed } = require('../src/core/seed');
const { createSyncClient } = require('../src/core/sync-client');

let srv, base, S, desk, dsvc, client, cfg;
const ADMIN = { username: 'admin', password: 'ServidorAdmin1' };

async function api(path, { body, token, method } = {}) {
  const r = await fetch(base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
async function serverToken(identifier, password) {
  const r = await api('/api/auth/login', { body: { identifier, password } });
  if (r.data.must_change_password) {
    const c = await api('/api/auth/change-password', { body: { current: password, next: password + 'x' }, token: r.data.access_token });
    return c.data.access_token;
  }
  return r.data.access_token;
}

beforeEach(async () => {
  // Servidor vacío (como en producción) con admin inicial
  S = await createServer({ jwtSecret: 's'.repeat(40), mailer: consoleMailer(() => {}), seed: false, bootstrapAdmin: ADMIN, legacySync: true }); // modo temporal LEGACY_SYNC=1 (cajas viejas)
  S.db.run('UPDATE users SET must_change_password = 0');
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  // Escritorio con datos demo y cola de sincronización
  desk = await openDatabase(null, { syncOutbox: true });
  seed(desk);
  dsvc = createService(desk);
  cfg = {};
  client = createSyncClient({ db: desk, getConfig: () => cfg });
  const link = await client.linkDevice({ serverUrl: base, ...ADMIN, name: 'Caja 1' });
  cfg = { serverUrl: link.serverUrl, deviceToken: link.deviceToken };
});
afterEach(() => srv.close());

const count = (db, sql, p) => db.get(sql, p).n;
const deskAdmin = () => dsvc.login('admin', 'admin123');
const deskCajero = () => dsvc.login('cajero', 'cajero123');
const prodId = (db, name) => db.get('SELECT id FROM products WHERE name = ?', [name]).id;

test('push inicial completo, saldos iguales e idempotencia', async () => {
  const st = await client.syncNow();
  assert.equal(st.state, 'ok', st.last_error);
  assert.equal(st.pending, 0);
  for (const t of ['products', 'categories', 'children', 'cards', 'transactions', 'transaction_items']) {
    assert.equal(count(S.db, `SELECT COUNT(*) AS n FROM ${t}`), count(desk, `SELECT COUNT(*) AS n FROM ${t}`), t);
  }
  const bal = (db) => db.all('SELECT uuid, balance_cents FROM cards ORDER BY uuid');
  assert.deepEqual(bal(S.db), bal(desk));
  assert.equal(count(S.db, "SELECT COUNT(*) AS n FROM transactions WHERE status = 'rechazado'"), 2); // también los rechazos
  // Reenviar exactamente el mismo lote no duplica nada
  desk.run("UPDATE meta SET value = '0' WHERE key = 'sync_full_push_done'");
  const again = await client.syncNow();
  assert.equal(again.last_stats.transactions, 0);
  assert.ok(again.last_stats.duplicates > 0);
  assert.equal(count(S.db, 'SELECT COUNT(*) AS n FROM transactions'), count(desk, 'SELECT COUNT(*) AS n FROM transactions'));
  // Una venta nueva se envía sola y el saldo del servidor refleja al escritorio
  const r = dsvc.purchase(deskCajero(), { uid: '04C3D4E5F6A7B8', items: [{ product_id: prodId(desk, 'Manzana'), qty: 1 }] });
  assert.equal(r.ok, true);
  assert.ok(client.pendingCount() > 0);
  await client.syncNow();
  assert.equal(S.db.get("SELECT balance_cents AS b FROM cards WHERE uid = '04C3D4E5F6A7B8'").b, r.balance_cents);
  assert.equal(client.pendingCount(), 0);
});

test('el tutor cambia límites/prohibiciones/bloqueo en el servidor y afecta la siguiente venta del escritorio', async () => {
  await client.syncNow();
  const admin = await serverToken(ADMIN.username, ADMIN.password);
  const vale = S.db.get("SELECT id FROM children WHERE full_name = 'Valentina Pérez'");
  // Padre se registra con código de invitación
  const inv = await api('/api/admin/invitations', { body: { child_id: vale.id }, token: admin });
  const reg = await api('/api/auth/register', { body: { code: inv.data.code, full_name: 'Juana Pérez', email: 'juana@example.com', password: 'ClaveJuana1' } });
  const tutor = reg.data.access_token;
  const papas = S.db.get("SELECT id FROM products WHERE name = 'Papas fritas'").id;
  assert.equal((await api('/api/rpc/setProhibitions', { body: { child_id: vale.id, product_ids: [papas] }, token: tutor })).status, 200);
  assert.equal((await api('/api/rpc/setLimits', { body: { child_id: vale.id, per_transaction_cents: 1000 }, token: tutor })).status, 200);
  await client.syncNow();
  // vínculo tutor-alumno descargado
  const dv = desk.get("SELECT c.id, u.full_name FROM children c JOIN users u ON u.id = c.tutor_id WHERE c.full_name = 'Valentina Pérez'");
  assert.equal(dv.full_name, 'Juana Pérez');
  const p1 = dsvc.purchase(deskCajero(), { uid: '04C3D4E5F6A7B8', items: [{ product_id: prodId(desk, 'Papas fritas'), qty: 1 }] });
  assert.equal(p1.ok, false); assert.equal(p1.reason, 'Producto prohibido por el tutor: Papas fritas');
  const p2 = dsvc.purchase(deskCajero(), { uid: '04C3D4E5F6A7B8', items: [{ product_id: prodId(desk, 'Sándwich de jamón'), qty: 1 }] });
  assert.equal(p2.ok, false); assert.match(p2.reason, /límite por compra/);
  // bloqueo temporal desde el celular
  const card = S.db.get("SELECT id FROM cards WHERE uid = '04C3D4E5F6A7B8'").id;
  assert.equal((await api('/api/rpc/setCardStatus', { body: { card_id: card, status: 'bloqueada' }, token: tutor })).status, 200);
  await client.syncNow();
  const p3 = dsvc.purchase(deskCajero(), { uid: '04C3D4E5F6A7B8', items: [{ product_id: prodId(desk, 'Manzana'), qty: 1 }] });
  assert.equal(p3.ok, false); assert.match(p3.reason, /bloqueada temporalmente por el tutor/);
  // los intentos rechazados llegan al servidor y el tutor los ve en su historial
  await client.syncNow();
  const hist = await api('/api/rpc/listMovements', { body: { status: 'rechazado' }, token: tutor });
  assert.ok(hist.data.some((m) => m.reason === 'Producto prohibido por el tutor: Papas fritas'));
  assert.ok(hist.data.some((m) => /bloqueada/.test(m.reason)));
  // el servidor no se sobreescribe con el estado viejo de la tarjeta
  assert.equal(S.db.get('SELECT status FROM cards WHERE id = ?', [card]).status, 'bloqueada');
});

test('el servidor gana: cambio del tutor posterior al último pull prevalece sobre el del escritorio', async () => {
  await client.syncNow();
  const admin = await serverToken(ADMIN.username, ADMIN.password);
  const sofiaS = S.db.get("SELECT id FROM children WHERE full_name = 'Sofía Hernández'").id;
  const sofiaD = desk.get("SELECT id FROM children WHERE full_name = 'Sofía Hernández'").id;
  // ambos cambian el límite diario sin sincronizar entre medio
  // (solo el tutor configura límites: en la caja vieja, la mamá; en el servidor, el tutor vinculado)
  dsvc.setLimits(dsvc.login('maria', 'tutor123'), sofiaD, { per_day_cents: 9900 });
  const inv = await api('/api/admin/invitations', { body: { child_id: sofiaS }, token: admin });
  const tutor = (await api('/api/auth/register', { body: { code: inv.data.code, full_name: 'María H.', email: 'mariah@example.com', password: 'ClaveMaria1' } })).data.access_token;
  assert.equal((await api('/api/rpc/setLimits', { body: { child_id: sofiaS, per_day_cents: 2000 }, token: admin })).status, 403);
  assert.equal((await api('/api/rpc/setLimits', { body: { child_id: sofiaS, per_day_cents: 2000 }, token: tutor })).status, 200);
  await client.syncNow();
  assert.equal(S.db.get('SELECT per_day_cents AS v FROM limits WHERE child_id = ?', [sofiaS]).v, 2000);
  assert.equal(desk.get('SELECT per_day_cents AS v FROM limits WHERE child_id = ?', [sofiaD]).v, 2000);
});

test('sin conexión: la cola se guarda y se envía al volver internet', async () => {
  await client.syncNow();
  const good = cfg.serverUrl;
  cfg = { ...cfg, serverUrl: 'http://127.0.0.1:9' }; // servidor inalcanzable
  const caj = deskCajero();
  dsvc.recharge(caj, { uid: '04A1B2C3D4E5F6', amount_cents: 5000 });
  const sale = dsvc.purchase(caj, { uid: '04A1B2C3D4E5F6', items: [{ product_id: prodId(desk, 'Yogur'), qty: 2 }] });
  assert.equal(sale.ok, true); // la caja sigue vendiendo
  const off = await client.syncNow();
  assert.equal(off.state, 'sin_conexion');
  assert.ok(off.pending >= 3);
  const before = count(S.db, 'SELECT COUNT(*) AS n FROM transactions');
  cfg = { ...cfg, serverUrl: good };
  const on = await client.syncNow();
  assert.equal(on.state, 'ok'); assert.equal(on.pending, 0);
  assert.equal(count(S.db, 'SELECT COUNT(*) AS n FROM transactions'), before + 2);
  assert.equal(S.db.get("SELECT balance_cents AS b FROM cards WHERE uid = '04A1B2C3D4E5F6'").b, sale.balance_cents);
});

test('varios equipos: solo el principal envía; el servidor bloquea ventas en línea; autenticación requerida', async () => {
  await client.syncNow();
  const desk2 = await openDatabase(null, { syncOutbox: true }); seed(desk2);
  let cfg2 = {};
  const c2 = createSyncClient({ db: desk2, getConfig: () => cfg2 });
  const l2 = await c2.linkDevice({ serverUrl: base, ...ADMIN, name: 'Caja 2' });
  cfg2 = { serverUrl: base, deviceToken: l2.deviceToken };
  const st2 = await c2.syncNow();
  assert.equal(st2.state, 'solo_lectura'); // descarga ajustes pero no envía
  // forzar push desde el equipo 2 -> 409
  const r = await fetch(base + '/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Token': l2.deviceToken }, body: JSON.stringify({ entities: {} }) });
  assert.equal(r.status, 409);
  // sin token
  assert.equal((await api('/api/sync/pull')).status, 401);
  assert.equal((await fetch(base + '/api/sync/pull', { headers: { 'X-Device-Token': 'falso' } })).status, 401);
  // con servidor sincronizado, las ventas/recargas en línea se rechazan (la caja es la fuente de verdad)
  const admin = await serverToken(ADMIN.username, ADMIN.password);
  const rec = await api('/api/rpc/recharge', { body: { uid: '04A1B2C3D4E5F6', amount_cents: 100 }, token: admin });
  assert.equal(rec.status, 409); assert.equal(rec.code, 'SOLO_ESCRITORIO');
  // un tutor/cajero no puede vincular equipos
  assert.equal((await api('/api/sync/devices', { body: { device_id: 'a'.repeat(32) } })).status, 401);
  // el admin puede transferir el rol de principal
  await c2.makePrimary({ serverUrl: base, ...ADMIN });
  assert.equal((await c2.syncNow()).state, 'ok');
});
