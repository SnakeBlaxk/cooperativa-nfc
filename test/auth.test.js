'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer, createAuth } = require('../src/core/auth');
const { openDatabase } = require('../src/core/db');
const { createService } = require('../src/core/service');
const { seed } = require('../src/core/seed');
const { remoteLogin } = require('../src/main/remote-auth');

let server, base, mailer, ctx;
before(async () => {
  mailer = consoleMailer(() => {}); // silencioso
  ctx = await createServer({ cardStock: false, jwtSecret: 'x'.repeat(40), mailer, appUrl: 'http://test' });
  await new Promise((r) => { server = ctx.app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function api(path, { body, token, method } = {}) {
  const r = await fetch(base + path, { method: method || (body !== undefined ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });

test('login por usuario, correo y teléfono; /me; contraseña incorrecta', async () => {
  const a = await login('admin', 'admin123');
  assert.equal(a.status, 200); assert.ok(a.data.access_token); assert.ok(a.data.refresh_token);
  assert.equal((await login('maria@example.com', 'tutor123')).data.user.username, 'maria');
  assert.equal((await login('443-123-4567', 'tutor123')).data.user.username, 'maria');
  const me = await api('/api/auth/me', { token: a.data.access_token });
  assert.equal(me.data.role, 'admin');
  assert.equal((await login('admin', 'mala')).status, 401);
  assert.equal((await api('/api/auth/me')).status, 401);
  assert.equal((await api('/api/auth/me', { token: 'basura' })).status, 401);
});

test('límite de intentos de login (5 fallos -> 429 aunque la contraseña sea correcta)', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login('juan', 'incorrecta')).status, 401);
  const r = await login('juan', 'tutor123');
  assert.equal(r.status, 429); assert.equal(r.code, 'LIMITE_INTENTOS');
});

test('refresh rota el token; reutilizar uno viejo revoca la familia; logout revoca', async () => {
  const a = (await login('cajero', 'cajero123')).data;
  const r1 = await api('/api/auth/refresh', { body: { refresh_token: a.refresh_token } });
  assert.equal(r1.status, 200); assert.notEqual(r1.data.refresh_token, a.refresh_token);
  const reuse = await api('/api/auth/refresh', { body: { refresh_token: a.refresh_token } });
  assert.equal(reuse.status, 401);
  // la familia quedó revocada: el token nuevo tampoco sirve
  assert.equal((await api('/api/auth/refresh', { body: { refresh_token: r1.data.refresh_token } })).status, 401);
  const b = (await login('cajero', 'cajero123')).data;
  await api('/api/auth/logout', { body: { refresh_token: b.refresh_token } });
  assert.equal((await api('/api/auth/refresh', { body: { refresh_token: b.refresh_token } })).status, 401);
});

test('expiración de sesión: access token vence y refresh vencido se rechaza', async () => {
  const db = await openDatabase(null); seed(db, { withSamples: false });
  let t = Date.now();
  const auth = createAuth(db, createService(db), { jwtSecret: 'y'.repeat(40), nowMs: () => t, accessTtlSec: 60, refreshTtlMs: 3600e3, mailer: consoleMailer(() => {}) });
  const s = auth.login('admin', 'admin123');
  assert.equal(auth.verifyAccess(s.access_token).username, 'admin');
  t += 61e3;
  assert.throws(() => auth.verifyAccess(s.access_token), /expiró/);
  const s2 = auth.refresh(s.refresh_token);
  assert.equal(auth.verifyAccess(s2.access_token).username, 'admin');
  t += 3601e3;
  assert.throws(() => auth.refresh(s2.refresh_token), /expiró/);
});

test('admin crea tutor con contraseña generada; nadie salvo el superadmin puede cambiar contraseñas', async () => {
  const admin = (await login('admin', 'admin123')).data.access_token;
  const kids = (await api('/api/rpc/listChildren', { body: {}, token: admin })).data;
  const vale = kids.find((k) => k.full_name.startsWith('Valentina'));
  const r = await api('/api/admin/tutors', { body: { full_name: 'Laura Gómez', email: 'laura@example.com', child_ids: [] }, token: admin });
  assert.equal(r.status, 200);
  const temp = r.data.temporary_password;
  assert.ok(mailer.outbox.at(-1).text.includes(temp));
  const l = await login('laura@example.com', temp);
  assert.equal(l.data.must_change_password, false); // ya no se obliga (no podría cambiarla)
  const ok = await api('/api/rpc/listChildren', { body: {}, token: l.data.access_token });
  assert.equal(ok.status, 200); assert.equal(ok.data.length, 0);
  // tutor, cajero y admin NO pueden cambiar contraseñas (ni la suya ni la de otros)
  for (const [u, p] of [['laura@example.com', temp], ['cajero', 'cajero123'], ['admin', 'admin123']]) {
    const t = (await login(u, p)).data.access_token;
    const ch = await api('/api/auth/change-password', { body: { current: p, next: 'NuevaClave2026xx' }, token: t });
    assert.equal(ch.status, 403, u); assert.equal(ch.code, 'PROHIBIDO');
    assert.equal((await api('/api/rpc/changePassword', { body: { current: p, next: 'NuevaClave2026xx' }, token: t })).status, 403);
  }
  const lauraId = (await api('/api/rpc/listUsers', { body: { role: 'tutor' }, token: admin })).data.find((u) => u.email === 'laura@example.com').id;
  const up = await api('/api/rpc/updateUser', { body: { id: lauraId, password: 'OtraClave2026' }, token: admin });
  assert.equal(up.status, 403);
  assert.equal((await login('laura@example.com', temp)).status, 200); // sigue igual
  // no puede ver al alumno de otro tutor
  assert.equal((await api('/api/rpc/childSummary', { body: { child_id: vale.id }, token: l.data.access_token })).status, 403);
});

test('invitación por alumno: autoregistro del padre, código de un solo uso y vinculación de otro hijo', async () => {
  const admin = (await login('admin', 'admin123')).data.access_token;
  const c1 = (await api('/api/rpc/createChild', { body: { full_name: 'Mateo Ruiz', grade: '1° A' }, token: admin })).data;
  const c2 = (await api('/api/rpc/createChild', { body: { full_name: 'Lucía Ruiz', grade: '3° B' }, token: admin })).data;
  assert.equal(c1.tutor_id, null);
  await api('/api/rpc/registerCard', { body: { uid: '04EE11223344', child_id: c1.id }, token: admin });
  const inv1 = (await api('/api/admin/invitations', { body: { child_id: c1.id }, token: admin })).data;
  assert.match(inv1.code, /^COOP-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  const reg = await api('/api/auth/register', { body: { code: inv1.code.toLowerCase(), full_name: 'Pedro Ruiz', phone: '4431112233', password: 'ClaveSegura1' } });
  assert.equal(reg.status, 200);
  const tok = reg.data.access_token;
  const mine = (await api('/api/rpc/listChildren', { body: {}, token: tok })).data;
  assert.deepEqual(mine.map((k) => k.full_name), ['Mateo Ruiz']);
  assert.equal(mine[0].card.uid, '04EE11223344');
  // código ya usado
  assert.equal((await api('/api/auth/register', { body: { code: inv1.code, full_name: 'X', email: 'x@x.com', password: 'ClaveSegura1' } })).status, 400);
  // segundo hijo con código
  const inv2 = (await api('/api/admin/invitations', { body: { child_id: c2.id }, token: admin })).data;
  assert.equal((await api('/api/auth/redeem', { body: { code: inv2.code }, token: tok })).status, 200);
  assert.equal((await api('/api/rpc/listChildren', { body: {}, token: tok })).data.length, 2);
  // listado de invitaciones solo admin
  assert.equal((await api('/api/admin/invitations', { token: tok })).status, 403);
  const list = (await api('/api/admin/invitations', { token: admin })).data;
  assert.ok(list.some((i) => i.code === inv1.code && i.status === 'usado'));
});

test('recuperación por correo desactivada: solo el superadmin asigna contraseñas', async () => {
  const before = mailer.outbox.length;
  const r = await api('/api/auth/forgot', { body: { identifier: 'juan@example.com' } });
  assert.equal(r.status, 403); assert.equal(mailer.outbox.length, before);
  assert.equal((await api('/api/auth/reset', { body: { token: 'inventado', password: 'OtraMas99' } })).status, 403);
});

test('roles en cada endpoint', async () => {
  const tutor = (await login('maria', 'tutor123')).data.access_token;
  const caj = (await login('cajero', 'cajero123')).data.access_token;
  assert.equal((await api('/api/rpc/dashboard', { body: {}, token: tutor })).status, 403);
  assert.equal((await api('/api/rpc/purchase', { body: { uid: '04A1B2C3D4E5F6', items: [{ product_id: 1, qty: 1 }] }, token: tutor })).status, 403);
  assert.equal((await api('/api/rpc/recharge', { body: { uid: '04A1B2C3D4E5F6', amount_cents: 100 }, token: tutor })).status, 403);
  assert.equal((await api('/api/admin/tutors', { body: { full_name: 'X', email: 'z@z.com' }, token: caj })).status, 403);
  assert.equal((await api('/api/admin/invitations', { body: { child_id: 1 }, token: caj })).status, 403);
  assert.equal((await api('/api/rpc/dashboard', { body: {}, token: caj })).status, 403);
  assert.equal((await api('/api/rpc/recharge', { body: { uid: '04A1B2C3D4E5F6', amount_cents: 100 }, token: caj })).status, 200);
  assert.equal((await api('/api/rpc/listCards', { body: {} })).status, 401);
  assert.equal((await api('/api/rpc/login', { body: {}, token: caj })).status, 400);
});

test('escritorio: login contra el servidor, respaldo sin conexión y rechazo', async () => {
  const db = await openDatabase(null);
  // cuenta que solo existe en el servidor
  const admin = (await login('admin', 'admin123')).data.access_token;
  await api('/api/rpc/createUser', { body: { role: 'cajero', username: 'cajero9', password: 'caja2026', full_name: 'Cajero Dos' }, token: admin });
  const ok = await remoteLogin({ serverUrl: base, username: 'cajero9', password: 'caja2026', db });
  assert.equal(ok.status, 'ok'); assert.ok(ok.tokens.access_token);
  const svc = createService(db);
  assert.equal(svc.login('cajero9', 'caja2026').role, 'cajero'); // quedó guardada para modo sin conexión
  const bad = await remoteLogin({ serverUrl: base, username: 'cajero9', password: 'mala', db });
  assert.equal(bad.status, 'rejected');
  const off = await remoteLogin({ serverUrl: 'http://127.0.0.1:9', username: 'cajero9', password: 'caja2026', db, timeoutMs: 1500 });
  assert.equal(off.status, 'offline');
  assert.equal(svc.login('cajero9', 'caja2026').username, 'cajero9'); // login local sigue funcionando
  const tut = await remoteLogin({ serverUrl: base, username: 'maria', password: 'tutor123', db });
  assert.equal(tut.status, 'local-only');
});
