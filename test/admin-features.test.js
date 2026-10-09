'use strict';
// Límites/prohibidos solo del tutor · edición de cuentas por el superadministrador · asignar tarjetas por UID
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');

let S, srv, base, Z, A, C, M;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const tok = async (u, p) => { const r = await api('/api/auth/login', { body: { identifier: u, password: p } }); assert.ok(r.ok, u + ': ' + r.error); return r.data.access_token; };
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const sup = (m, body) => api('/api/super/' + m, { body: body || {}, token: Z });
const id = (sql, p = []) => S.db.get(sql, p).id;
before(async () => {
  S = await createServer({ jwtSecret: 'f'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  [Z, A, C, M] = [await tok('zuki', 'zuki123'), await tok('admin', 'admin123'), await tok('cajero', 'cajero123'), await tok('maria', 'tutor123')];
});
after(() => new Promise((r) => srv.close(r)));

// ---------- límites y prohibidos: solo el tutor ----------
test('límites y prohibidos: el admin y el cajero reciben 403; el tutor sí puede; la escuela solo consulta', async () => {
  const sofia = id("SELECT id FROM children WHERE full_name = 'Sofía Hernández'");
  const prod = id('SELECT id FROM products WHERE school_id = (SELECT school_id FROM children WHERE id = ?) LIMIT 1', [sofia]);
  for (const t of [A, C]) {
    const l = await rpc('setLimits', { child_id: sofia, per_day_cents: 100 }, t);
    assert.equal(l.status, 403); assert.match(l.error, /Solo el padre, madre o tutor/);
    assert.equal((await rpc('setProhibitions', { child_id: sofia, product_ids: [prod] }, t)).status, 403);
  }
  assert.equal((await rpc('setLimits', { child_id: sofia, per_day_cents: 5000 }, M)).ok, true);
  assert.equal((await rpc('setProhibitions', { child_id: sofia, product_ids: [prod] }, M)).ok, true);
  const s = await rpc('childSummary', { child_id: sofia }, A); // consulta (solo lectura) para la escuela
  assert.equal(s.data.limits.per_day_cents, 5000);
  assert.equal(s.data.prohibitions.products.length, 1);
  assert.equal((await rpc('getLimits', { child_id: sofia }, A)).data.per_day_cents, 5000);
});

// ---------- cuentas: editar (superadministrador) ----------
test('cuentas: el superadmin edita nombre, usuario, correo, teléfono, jerarquía y escuela; queda en la bitácora', async () => {
  const caj = id("SELECT id FROM users WHERE username = 'cajero2'");
  const s1 = id("SELECT id FROM schools WHERE id = (SELECT school_id FROM users WHERE username = 'admin')");
  const r = await sup('updateAccount', { user_id: caj, full_name: 'Pedro Ruiz Gómez', username: 'pedro.ruiz', email: 'pedro@example.com', phone: '443 555 0101', role: 'admin', school_id: s1 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.username, 'pedro.ruiz'); assert.equal(r.data.role, 'admin'); assert.equal(r.data.school_id, s1); assert.equal(r.data.phone, '4435550101');
  const log = S.db.get("SELECT * FROM audit_log WHERE action = 'cuenta_editada' ORDER BY id DESC LIMIT 1");
  assert.ok(log); const det = JSON.parse(log.details);
  assert.deepEqual(det.cambios.usuario, { antes: 'cajero2', ahora: 'pedro.ruiz' });
  assert.equal(det.cambios.rol.ahora, 'admin');
  // la sesión anterior se invalida (cambió usuario/jerarquía): entra con el usuario nuevo
  assert.equal((await api('/api/auth/login', { body: { identifier: 'cajero2', password: 'cajero123' } })).ok, false);
  assert.equal((await api('/api/auth/login', { body: { identifier: 'pedro.ruiz', password: 'cajero123' } })).ok, true);
});

test('cuentas: usuario, correo y teléfono únicos; validaciones; la cuenta del superadmin está protegida', async () => {
  const caj = id("SELECT id FROM users WHERE username = 'cajero'");
  const dup = await sup('updateAccount', { user_id: caj, username: 'admin' });
  assert.equal(dup.status, 409); assert.match(dup.error, /usuario ya existe/);
  assert.equal((await sup('updateAccount', { user_id: caj, email: 'maria@example.com' })).status, 409);
  assert.equal((await sup('updateAccount', { user_id: caj, username: 'con espacio' })).status, 400);
  assert.equal((await sup('updateAccount', { user_id: caj, role: 'superadmin' })).status, 400);
  assert.equal((await sup('updateAccount', { user_id: caj, school_id: null })).status, 400); // personal sin escuela
  const z = id("SELECT id FROM users WHERE role = 'superadmin'");
  assert.equal((await sup('updateAccount', { user_id: z, role: 'admin' })).status, 403);
  assert.equal((await sup('updateAccount', { user_id: z, username: 'otro' })).status, 403);
  const ok = await sup('updateAccount', { user_id: z, full_name: 'Zuki Company MX', phone: '4430000000' });
  assert.equal(ok.ok, true); assert.equal(ok.data.username, 'zuki'); assert.equal(ok.data.role, 'superadmin');
  // nadie más puede editar cuentas
  assert.equal((await api('/api/super/updateAccount', { body: { user_id: caj, full_name: 'X' }, token: A })).status, 403);
});

test('cuentas: alumnos vinculados de un padre/tutor (vincular, quitar) con bitácora', async () => {
  const juan = id("SELECT id FROM users WHERE username = 'juan'");
  const before = (await sup('getAccount', { user_id: juan })).data;
  assert.equal(before.role, 'tutor'); assert.ok(before.children.length >= 1);
  const lucia = id("SELECT id FROM children WHERE full_name = 'Lucía Hernández'");
  const found = await sup('searchChildren', { q: 'Lucía' });
  assert.ok(found.data.some((c) => c.id === lucia));
  const r = await sup('updateAccount', { user_id: juan, child_ids: [lucia] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.children.map((c) => c.id), [lucia]);
  for (const c of before.children) assert.equal(S.db.get('SELECT tutor_id FROM children WHERE id = ?', [c.id]).tutor_id, null);
  const det = JSON.parse(S.db.get("SELECT details FROM audit_log WHERE action = 'cuenta_editada' ORDER BY id DESC LIMIT 1").details);
  assert.deepEqual(det.alumnos_vinculados, ['Lucía Hernández']);
  assert.equal(det.alumnos_desvinculados.length, before.children.length);
  // un tutor con hijos no puede pasar a personal sin quitarlos primero
  assert.equal((await sup('updateAccount', { user_id: juan, role: 'cajero', school_id: 1 })).status, 400);
  assert.equal((await sup('updateAccount', { user_id: juan, child_ids: [999999] })).status, 404);
});

// ---------- tarjetas: asignar por UID (lector USB tipo teclado o a mano) ----------
test('tarjetas: asignar por UID registra la nueva, toma la del inventario y no permite duplicados', async () => {
  const sid = S.db.get("SELECT school_id FROM users WHERE username = 'admin'").school_id;
  const kid = (await rpc('createChild', { full_name: 'Alumno Nuevo', grade: '1° A' }, A)).data;
  // UID nuevo → se registra y se asigna (formato con separadores, como lo escriben algunos lectores)
  const r1 = await rpc('assignCardByUid', { uid: '0a:1b:2c:3d', child_id: kid.id }, A);
  assert.equal(r1.ok, true, r1.error); assert.equal(r1.data.uid, '0A1B2C3D'); assert.equal(r1.data.status, 'activa');
  // misma tarjeta otra vez → duplicado
  assert.equal((await rpc('assignCardByUid', { uid: '0A1B2C3D', child_id: kid.id }, A)).status, 409);
  // tarjeta de otro alumno → duplicado con nombre
  const other = await rpc('assignCardByUid', { uid: '04A1B2C3D4E5F6', child_id: kid.id }, A);
  assert.equal(other.status, 409); assert.match(other.error, /asignada a Sofía/);
  // el alumno ya tiene tarjeta → no se le asigna otra
  assert.equal((await rpc('assignCardByUid', { uid: '0011223344', child_id: kid.id }, A)).status, 400);
  // quitar (saldo $0) → regresa al inventario; luego se asigna la del inventario por UID
  const card = S.db.get("SELECT id FROM cards WHERE uid = '0A1B2C3D'").id;
  const un = await rpc('unassignCard', { card_id: card }, A);
  assert.equal(un.ok, true, un.error); assert.equal(un.data.status, 'sin_asignar');
  const inv = id("SELECT id FROM cards WHERE uid = '04D9E0F1A2B3C4'"); assert.ok(inv);
  const r2 = await rpc('assignCardByUid', { uid: '04D9E0F1A2B3C4', child_id: kid.id }, A);
  assert.equal(r2.ok, true, r2.error); assert.equal(r2.data.id, inv);
  // tarjeta con saldo no se puede quitar (se reemplaza)
  const sofiaCard = id("SELECT id FROM cards WHERE uid = '04A1B2C3D4E5F6'");
  assert.equal((await rpc('unassignCard', { card_id: sofiaCard }, A)).status, 400);
  // reemplazar: el UID nuevo no puede estar repetido
  assert.equal((await rpc('reportLostAndReplace', { card_id: sofiaCard, new_uid: '0A1B2C3D' }, A)).status, 409);
  // tarjeta de otra escuela → rechazada
  assert.equal((await rpc('assignCardByUid', { uid: '05A1A1A1A1A1A1', child_id: kid.id }, A)).status, 409);
  // el cajero no asigna tarjetas
  assert.equal((await rpc('assignCardByUid', { uid: 'ABCDEF12', child_id: kid.id }, C)).status, 403);
  // queda en la bitácora
  assert.ok(S.db.get("SELECT id FROM audit_log WHERE action = 'tarjeta_quitada' AND school_id = ?", [sid]));
  assert.ok(S.db.get("SELECT id FROM audit_log WHERE action = 'tarjeta_asignada' AND school_id = ?", [sid]));
});
