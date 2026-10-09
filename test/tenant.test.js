'use strict';
// Multi-escuela: aislamiento estricto entre escuelas, tutores con hijos en varias escuelas,
// panel del superadministrador, suspensión, sincronización por escuela y migración de datos antiguos.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { openDatabase } = require('../src/core/db');
const { createService } = require('../src/core/service');
const { seed, seedMinimal } = require('../src/core/seed');
const { createSyncClient } = require('../src/core/sync-client');

let S, srv, base;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
async function tok(identifier, password) {
  const r = await api('/api/auth/login', { body: { identifier, password } });
  assert.ok(r.ok, `${identifier}: ${r.error}`);
  if (r.data.must_change_password) {
    const c = await api('/api/auth/change-password', { body: { current: password, next: password + 'X9' }, token: r.data.access_token });
    return c.data.access_token;
  }
  return r.data.access_token;
}
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const sup = (m, body, token) => api('/api/super/' + m, { body: body || {}, token });
const idOf = (table, col, val) => S.db.get(`SELECT id FROM ${table} WHERE ${col} = ?`, [val]).id;

async function start(opts) {
  S = await createServer({ jwtSecret: 't'.repeat(40), mailer: consoleMailer(() => {}), ...opts });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
}

// ---------- servidor demo: 2 escuelas ----------
let A, B, ZUKI, MARIA, JUAN;
before(async () => {
  await start({}); // seedPlatform
  A = await tok('admin', 'admin123'); B = await tok('admin2', 'admin123');
  ZUKI = await tok('zuki', 'zuki123'); MARIA = await tok('maria', 'tutor123'); JUAN = await tok('juan', 'tutor123');
});
after(() => srv.close());

test('aislamiento: el admin de la escuela A no ve ni toca datos de la escuela B (y viceversa)', async () => {
  const names = (r) => r.data.map((x) => x.full_name);
  const ca = await rpc('listChildren', {}, A);
  assert.deepEqual(names(ca).sort(), ['Diego Hernández', 'Sofía Hernández', 'Valentina Pérez']);
  const cb = await rpc('listChildren', {}, B);
  assert.deepEqual(names(cb).sort(), ['Lucía Hernández', 'Mateo Gómez']);
  assert.ok((await rpc('listCards', {}, A)).data.every((k) => k.uid.startsWith('04')));
  assert.ok((await rpc('listCards', {}, B)).data.every((k) => k.uid.startsWith('05')));
  assert.ok(!(await rpc('listProducts', {}, A)).data.some((p) => p.name === 'Tamal'));
  assert.ok((await rpc('listProducts', {}, B)).data.every((p) => ['Tamal', 'Torta de jamón', 'Agua de jamaica', 'Paleta'].includes(p.name)));
  assert.ok((await rpc('listCategories', {}, B)).data.some((c) => c.name === 'Bebidas'));
  assert.ok(!(await rpc('listCategories', {}, A)).data.some((c) => c.name === 'Bebidas'));
  const ma = (await rpc('listMovements', {}, A)).data;
  assert.ok(ma.length > 10 && ma.every((t) => t.card_uid.startsWith('04')));
  const mb = (await rpc('listMovements', {}, B)).data;
  assert.equal(mb.length, 4); assert.ok(mb.every((t) => t.card_uid.startsWith('05')));
  const usersA = (await rpc('listUsers', {}, A)).data.map((u) => u.username);
  assert.ok(usersA.includes('cajero') && !usersA.includes('cajero2') && !usersA.includes('admin2') && !usersA.includes('zuki'));
  const usersB = (await rpc('listUsers', {}, B)).data.map((u) => u.username);
  assert.ok(usersB.includes('maria'), 'María tiene una hija en B'); assert.ok(!usersB.includes('juan') && !usersB.includes('cajero'));
  // tablero: solo cifras propias
  const db = S.db;
  const recB = db.get("SELECT SUM(amount_cents) AS s FROM transactions WHERE school_id = 2 AND type = 'recarga'").s;
  const dB = (await rpc('dashboard', {}, B)).data;
  assert.equal(dB.recharges_total_cents, recB); assert.equal(dB.total_cards, 3); assert.equal(dB.school_name, 'Instituto Valladolid (demo)');
  // accesos directos por id/uid a datos de B desde A → "no encontrado"
  const lucia = idOf('children', 'full_name', 'Lucía Hernández');
  const cardB = idOf('cards', 'uid', '05A1A1A1A1A1A1');
  const tamal = idOf('products', 'name', 'Tamal');
  for (const [m, body] of [
    ['childSummary', { child_id: lucia }], ['updateChild', { id: lucia, full_name: 'X' }], ['setLimits', { child_id: lucia, per_day_cents: 100 }],
    ['getProhibitions', { child_id: lucia }], ['lookupCard', { uid: '05A1A1A1A1A1A1' }], ['recharge', { uid: '05A1A1A1A1A1A1', amount_cents: 1000 }],
    ['purchase', { uid: '05A1A1A1A1A1A1', items: [{ product_id: tamal, qty: 1 }] }], ['setCardStatus', { card_id: cardB, status: 'bloqueada' }],
    ['assignCard', { card_id: cardB, child_id: idOf('children', 'full_name', 'Sofía Hernández') }], ['updateProduct', { id: tamal, price_cents: 1 }],
    ['deleteProduct', { id: tamal }], ['updateUser', { id: idOf('users', 'username', 'cajero2'), active: false }],
  ]) {
    const r = await rpc(m, body, A);
    assert.equal(r.ok, false, m); assert.equal(r.status, 404, `${m}: ${r.status} ${r.error}`);
  }
  // producto de B con tarjeta de A: no se vende
  const p = await rpc('purchase', { uid: '04A1B2C3D4E5F6', items: [{ product_id: tamal, qty: 1 }] }, A);
  assert.equal(p.status, 404);
  // UID ya usado en otra escuela: rechazado (únicos en la plataforma)
  const dup = await rpc('registerCard', { uid: '05C3C3C3C3C3C3' }, A);
  assert.equal(dup.status, 409); assert.match(dup.error, /otra escuela/);
  // invitaciones y equipos
  assert.equal((await api('/api/admin/invitations', { body: { child_id: lucia }, token: A })).status, 404);
  const invB = await api('/api/admin/invitations', { body: { child_id: idOf('children', 'full_name', 'Mateo Gómez') }, token: B });
  assert.ok(invB.ok);
  assert.ok(!(await api('/api/admin/invitations', { token: A })).data.some((i) => i.child_name === 'Mateo Gómez'));
  assert.equal((await api('/api/admin/invitations', { token: B })).data.length, 1);
  // nada cambió en B
  assert.equal(db.get('SELECT full_name FROM children WHERE id = ?', [lucia]).full_name, 'Lucía Hernández');
  assert.equal(db.get('SELECT price_cents FROM products WHERE id = ?', [tamal]).price_cents, 2000);
  // y B tampoco ve a A
  assert.equal((await rpc('lookupCard', { uid: '04A1B2C3D4E5F6' }, B)).status, 404);
  assert.equal((await rpc('childSummary', { child_id: idOf('children', 'full_name', 'Sofía Hernández') }, B)).status, 404);
});

test('tutor: solo ve a sus hijos, aunque estén en escuelas distintas', async () => {
  const kids = (await rpc('listChildren', {}, MARIA)).data;
  assert.deepEqual(kids.map((k) => k.full_name).sort(), ['Diego Hernández', 'Lucía Hernández', 'Sofía Hernández']);
  assert.equal(kids.find((k) => k.full_name === 'Lucía Hernández').school_name, 'Instituto Valladolid (demo)');
  assert.equal(kids.find((k) => k.full_name === 'Sofía Hernández').school_name, 'Colegio Morelos (demo)');
  const lucia = kids.find((k) => k.full_name === 'Lucía Hernández');
  // catálogo de la escuela del hijo elegido
  const prods = (await rpc('listProducts', { child_id: lucia.id }, MARIA)).data.map((p) => p.name);
  assert.ok(prods.includes('Tamal') && !prods.includes('Chocolate'));
  const sum = await rpc('childSummary', { child_id: lucia.id }, MARIA);
  assert.ok(sum.ok); assert.ok(sum.data.movements.every((t) => t.card_uid === '05A1A1A1A1A1A1'));
  assert.ok((await rpc('setLimits', { child_id: lucia.id, per_day_cents: 5000 }, MARIA)).ok);
  // no puede prohibir un producto de otra escuela para Lucía
  const choc = idOf('products', 'name', 'Chocolate');
  assert.equal((await rpc('setProhibitions', { child_id: lucia.id, product_ids: [choc] }, MARIA)).status, 404);
  // movimientos: solo de sus hijos (ambas escuelas)
  const mv = (await rpc('listMovements', {}, MARIA)).data;
  assert.ok(mv.some((t) => t.card_uid.startsWith('05')) && mv.some((t) => t.card_uid.startsWith('04')));
  assert.ok(mv.every((t) => ['Sofía Hernández', 'Diego Hernández', 'Lucía Hernández'].includes(t.child_name)));
  // otro tutor no ve a Lucía
  assert.equal((await rpc('childSummary', { child_id: lucia.id }, JUAN)).status, 403);
  assert.equal((await rpc('listChildren', {}, JUAN)).data.length, 1);
});

test('superadmin: ve todas las escuelas y totales; solo él entra al panel', async () => {
  const o = await sup('overview', {}, ZUKI);
  assert.ok(o.ok);
  assert.equal(o.data.totals.schools, 2);
  const tx = S.db.get("SELECT SUM(amount_cents) AS s FROM transactions WHERE type = 'recarga' AND status = 'aprobado'").s;
  assert.equal(o.data.totals.recharges_total_cents, tx);
  assert.equal(o.data.totals.students, S.db.get('SELECT COUNT(*) AS n FROM children WHERE active = 1').n);
  const b = o.data.schools.find((s) => s.name.startsWith('Instituto'));
  assert.equal(b.status, 'prueba'); assert.equal(b.stats.students, 2); assert.equal(b.stats.active_cards, 2);
  for (const t of [A, B, MARIA]) assert.equal((await sup('overview', {}, t)).status, 403);
  assert.equal((await rpc('listChildren', {}, ZUKI)).status, 403); // el superadmin no opera como escuela
  // alta de escuela con administrador (contraseña temporal)
  const c = await sup('createSchool', { name: 'Escuela Nueva', status: 'prueba', plan_note: '$900/mes', admin_username: 'admin.nueva', admin_full_name: 'Directora Nueva' }, ZUKI);
  assert.ok(c.ok, c.error); assert.ok(c.data.admin.temporary_password.length >= 10);
  const l = await api('/api/auth/login', { body: { identifier: 'admin.nueva', password: c.data.admin.temporary_password } });
  assert.equal(l.data.must_change_password, false); // solo el superadmin cambia contraseñas: no se obliga
  const N = await tok('admin.nueva', c.data.admin.temporary_password);
  assert.deepEqual((await rpc('listChildren', {}, N)).data, []);
  assert.equal((await rpc('listCategories', {}, N)).data.length, 5);
  assert.ok((await rpc('createChild', { full_name: 'Primer Alumno' }, N)).ok);
  const det = await sup('schoolDetail', { id: c.data.school.id }, ZUKI);
  assert.equal(det.data.staff.length, 1); assert.equal(det.data.school.stats.students, 1);
  const inv = await sup('generateInvitations', { school_id: c.data.school.id }, ZUKI);
  assert.equal(inv.data.length, 1); assert.match(inv.data[0].code, /^COOP-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  // reutiliza el código pendiente
  assert.equal((await sup('generateInvitations', { school_id: c.data.school.id }, ZUKI)).data[0].code, inv.data[0].code);
  const st = await sup('createStaff', { school_id: c.data.school.id, role: 'cajero', username: 'caja.nueva', full_name: 'Caja Nueva' }, ZUKI);
  assert.ok(st.ok && st.data.temporary_password);
  const rp = await sup('resetStaffPassword', { user_id: st.data.user.id }, ZUKI);
  assert.ok(rp.data.temporary_password !== st.data.temporary_password);
  assert.equal((await sup('updateSchool', { id: c.data.school.id, status: 'otra' }, ZUKI)).status, 400);
});

test('escuela pausada: su personal no entra y su caja no sincroniza; el padre con hijos en otra escuela activa sí consulta', async () => {
  const sid = idOf('schools', 'name', 'Instituto Valladolid (demo)');
  const B2 = await tok('cajero2', 'cajero123');
  assert.ok((await sup('updateSchool', { id: sid, status: 'suspendida' }, ZUKI)).ok); // nombre anterior = pausada
  const closed = await rpc('listChildren', {}, B2);
  assert.equal(closed.status, 403); assert.equal(closed.code, 'ESCUELA_PAUSADA'); // sesión cerrada con mensaje claro
  const l = await api('/api/auth/login', { body: { identifier: 'admin2', password: 'admin123' } });
  assert.equal(l.status, 403); assert.equal(l.code, 'ESCUELA_PAUSADA'); assert.equal(l.error, 'Servicio pausado. Contacte a la administración.');
  // el padre sigue viendo a su hija
  assert.ok((await rpc('listChildren', {}, MARIA)).data.some((k) => k.full_name === 'Lucía Hernández'));
  // la escuela A no se ve afectada
  assert.ok((await rpc('listChildren', {}, A)).ok);
  assert.ok((await sup('updateSchool', { id: sid, status: 'activa' }, ZUKI)).ok);
  B = await tok('admin2', 'admin123');
  assert.ok((await rpc('listChildren', {}, B)).ok);
});

test('sincronización por escuela: cada caja solo envía/recibe su escuela y los UID no se repiten', async () => {
  srv.close();
  await start({ seed: false, bootstrapSuperadmin: { username: 'zuki', password: 'ZukiProd2026' } });
  const Z = await tok('zuki', 'ZukiProd2026');
  const sa = (await sup('createSchool', { name: 'Escuela A', status: 'activa', admin_username: 'adminA' }, Z)).data;
  const sb = (await sup('createSchool', { name: 'Escuela B', status: 'activa', admin_username: 'adminB' }, Z)).data;
  await tok('adminA', sa.admin.temporary_password); await tok('adminB', sb.admin.temporary_password);
  const pwA = sa.admin.temporary_password; const pwB = sb.admin.temporary_password;
  // Caja A: datos demo. Caja B: base limpia con una tarjeta repetida (UID de A) y otra propia
  const deskA = await openDatabase(null, { syncOutbox: true }); seed(deskA);
  const deskB = await openDatabase(null, { syncOutbox: true }); seedMinimal(deskB);
  deskB.run('UPDATE users SET must_change_password = 0');
  const sB = createService(deskB, { schoolId: 1, singleSchool: true });
  const adB = sB.login('admin', 'admin123');
  const kid = sB.createChild(adB, { full_name: 'Alumno B' });
  let cfgA = {}; let cfgB = {};
  const cA = createSyncClient({ db: deskA, getConfig: () => cfgA });
  const cB = createSyncClient({ db: deskB, getConfig: () => cfgB });
  const lA = await cA.linkDevice({ serverUrl: base, username: 'adminA', password: pwA, name: 'Caja A' });
  cfgA = { serverUrl: base, deviceToken: lA.deviceToken };
  assert.equal(lA.school_name, 'Escuela A');
  assert.equal((await cA.syncNow()).state, 'ok');
  sB.registerCard(adB, { uid: '04A1B2C3D4E5F6', child_id: kid.id }); // ¡mismo UID que Sofía en A!
  sB.registerCard(adB, { uid: '0BB0BB0BB0BB0B' });
  sB.recharge(adB, { uid: '04A1B2C3D4E5F6', amount_cents: 5000 });
  const lB = await cB.linkDevice({ serverUrl: base, username: 'adminB', password: pwB, name: 'Caja B' });
  cfgB = { serverUrl: base, deviceToken: lB.deviceToken };
  const stB = await cB.syncNow();
  assert.equal(stB.state, 'ok', stB.last_error);
  assert.match(stB.last_error, /otra escuela.*04A1B2C3D4E5F6/);
  assert.equal(stB.school_name, 'Escuela B');
  assert.equal(deskB.get('SELECT name FROM schools').name, 'Escuela B');
  const db = S.db; const A_ID = sa.school.id; const B_ID = sb.school.id;
  assert.equal(db.get('SELECT school_id FROM cards WHERE uid = ?', ['04A1B2C3D4E5F6']).school_id, A_ID);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM cards WHERE school_id = ?', [B_ID]).n, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM children WHERE school_id = ?', [B_ID]).n, 1);
  const rec = db.get("SELECT card_id, card_uid FROM transactions WHERE school_id = ? AND type = 'recarga'", [B_ID]);
  assert.equal(rec.card_id, null); assert.equal(rec.card_uid, '04A1B2C3D4E5F6'); // se guarda sin vincular a la tarjeta de A
  // un ajuste del tutor en A no llega a la caja B
  const sofia = db.get("SELECT id FROM children WHERE full_name = 'Sofía Hernández'").id;
  S.sync.recordChild('limits', sofia);
  const before = deskB.get("SELECT value FROM meta WHERE key = 'sync_pull_cursor'").value;
  await cB.syncNow();
  assert.equal(cB.getStatus().last_stats.pulled, 0, `cursor ${before}`);
  // cada escuela tiene su propio equipo principal
  assert.equal(db.get('SELECT primary_device_id AS p FROM schools WHERE id = ?', [A_ID]).p, cA.deviceId());
  assert.equal(db.get('SELECT primary_device_id AS p FROM schools WHERE id = ?', [B_ID]).p, cB.deviceId());
  // el admin de B no administra el equipo de A
  const TB = (await api('/api/auth/login', { body: { identifier: 'adminB', password: pwB } })).data.access_token;
  assert.equal((await api(`/api/sync/devices/${cA.deviceId()}/revoke`, { body: {}, token: TB })).status, 404);
  assert.deepEqual((await api('/api/sync/devices', { token: TB })).data.map((d) => d.name), ['Caja B']);
  // códigos para padres desde la caja: solo alumnos de su escuela
  const codesA = await cA.requestInvitations(deskA.all('SELECT id FROM children').map((r) => r.id), { includeLinked: true });
  assert.equal(codesA.filter((c) => c.code).length, 3);
  const foreign = await api('/api/sync/invitations', { body: { child_uuids: [deskA.get('SELECT uuid FROM children LIMIT 1').uuid] }, token: null });
  assert.equal(foreign.status, 401);
  const r = await fetch(base + '/api/sync/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Token': lB.deviceToken }, body: JSON.stringify({ child_uuids: [deskA.get('SELECT uuid FROM children LIMIT 1').uuid] }) });
  const jb = await r.json();
  assert.ok(jb.ok); assert.ok(!jb.data[0].code, 'B no obtiene códigos de alumnos de A');
  // Un padre se registra con el código impreso y queda vinculado
  const reg = await api('/api/auth/register', { body: { code: codesA[0].code, full_name: 'Papá Nuevo', email: 'papa@example.com', password: 'PapaNuevo2026' } });
  assert.ok(reg.ok, reg.error);
  // equipo de una escuela suspendida no sincroniza
  await sup('updateSchool', { id: B_ID, status: 'suspendida' }, Z);
  const susp = await cB.syncNow();
  assert.equal(susp.state, 'pausado'); assert.match(susp.last_error, /Servicio pausado/);
});

test('migración: una base de una sola escuela (versión anterior) queda en una escuela por defecto', async () => {
  const f = path.join(os.tmpdir(), `coop-mig-${process.pid}.db`);
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'v1-escritorio.db'), f);
  const raw = fs.readFileSync(f);
  const db = await openDatabase(f);
  const schools = db.all('SELECT * FROM schools');
  assert.equal(schools.length, 1); assert.equal(schools[0].name, 'Mi escuela'); assert.equal(schools[0].primary_device_id, 'abc');
  for (const t of ['children', 'cards', 'categories', 'products', 'transactions']) {
    assert.equal(db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE school_id IS NULL`).n, 0, t);
    assert.ok(db.get(`SELECT COUNT(*) AS n FROM ${t}`).n > 0, t);
  }
  assert.equal(db.get("SELECT COUNT(*) AS n FROM users WHERE role IN ('admin','cajero') AND school_id = 1").n, 2);
  assert.match(db.get("SELECT sql FROM sqlite_master WHERE name = 'users'").sql, /superadmin/);
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
  assert.ok(!db.get("SELECT 1 AS x FROM meta WHERE key = 'sync_primary_device'"));
  // la aplicación funciona igual con los datos migrados
  const svc = createService(db, { schoolId: 1, singleSchool: true });
  const admin = svc.login('admin', 'admin123');
  assert.equal(svc.listChildren(admin).length, 3);
  const d = svc.dashboard(admin); assert.equal(d.total_cards, 4);
  const caj = svc.login('cajero', 'cajero123');
  const p = db.get("SELECT id FROM products WHERE name = 'Manzana'").id;
  assert.equal(svc.purchase(caj, { uid: '04C3D4E5F6A7B8', items: [{ product_id: p, qty: 1 }] }).ok, true);
  // categorías únicas por escuela (otra escuela puede repetir el nombre)
  db.run("INSERT INTO schools (name, created_at) VALUES ('Otra', '2026-01-01')");
  db.run("INSERT INTO categories (school_id, name) VALUES (2, 'Dulces')");
  assert.throws(() => db.run("INSERT INTO categories (school_id, name) VALUES (1, 'Dulces')"));
  // reabrir no vuelve a migrar ni duplica
  const db2 = await openDatabase(f);
  assert.equal(db2.get('SELECT COUNT(*) AS n FROM schools').n, 2);
  assert.ok(raw.length > 0);
  fs.unlinkSync(f);
});
