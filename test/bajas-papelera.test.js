'use strict';
// Bajas de alumnos y papás/tutores con Papelera: reembolso, tarjeta liberada, sesiones, permisos y borrado definitivo
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');

let S, srv, base, Z, A, C, A2;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const login = (u, p) => api('/api/auth/login', { body: { identifier: u, password: p } });
const tok = async (u, p) => { const r = await login(u, p); assert.ok(r.ok, u + ': ' + r.error); return r.data.access_token; };
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const sup = (m, body) => api('/api/super/' + m, { body: body || {}, token: Z });
const UID = '04D9E0F1A2B3C4'; // tarjeta libre de la escuela 1 (demo)
let tutor, k1, k2, T;

before(async () => {
  S = await createServer({ jwtSecret: 'b'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  [Z, A, C, A2] = [await tok('zuki', 'zuki123'), await tok('admin', 'admin123'), await tok('cajero', 'cajero123'), await tok('admin2', 'admin123')];
  tutor = (await rpc('createUser', { role: 'tutor', username: 'papabaja', password: 'tutor1234', full_name: 'Papá De Baja' }, A)).data;
  k1 = (await rpc('createChild', { full_name: 'Alumno Baja Uno', grade: '3A', tutor_id: tutor.id }, A)).data.id;
  k2 = (await rpc('createChild', { full_name: 'Alumno Baja Dos', grade: '4A', tutor_id: tutor.id }, A)).data.id;
  const r = await rpc('assignCardByUid', { uid: UID, child_id: k1 }, A); assert.ok(r.ok, r.error);
  assert.ok((await rpc('recharge', { uid: UID, amount_cents: 12345 }, C)).ok);
  T = await tok('papabaja', 'tutor1234');
});
after(() => new Promise((r) => srv.close(r)));

test('el cajero y el tutor no pueden dar de baja; otra escuela no ve al alumno', async () => {
  for (const t of [C, T]) {
    assert.equal((await rpc('deleteChild', { child_id: k1, refund: 'efectivo' }, t)).status, 403);
    assert.equal((await rpc('deleteTutor', { user_id: tutor.id }, t)).status, 403);
  }
  assert.equal((await rpc('deleteChild', { child_id: k1, refund: 'efectivo' }, A2)).status, 404);
  assert.equal((await rpc('purgeChild', { child_id: k1 }, A)).status, 403);
});

test('alumno con saldo: exige reembolso; al darlo de baja el saldo queda en $0, la tarjeta vuelve a libres y el historial se conserva', async () => {
  const pv = (await rpc('previewDeleteChild', { child_id: k1 }, A)).data;
  assert.equal(pv.balance_cents, 12345); assert.equal(pv.card.uid, UID); assert.equal(pv.tutor.other_children, 1);
  const r0 = await rpc('deleteChild', { child_id: k1 }, A);
  assert.equal(r0.status, 409); assert.equal(r0.code, 'SALDO_PENDIENTE');
  assert.equal(S.db.get('SELECT deleted_at FROM children WHERE id = ?', [k1]).deleted_at, null);
  const r = await rpc('deleteChild', { child_id: k1, refund: 'efectivo', delete_tutor: true }, A);
  assert.ok(r.ok, r.error); assert.equal(r.data.refunded_cents, 12345);
  assert.equal(r.data.tutor_deleted, null, 'tiene otro hijo: el tutor no se borra');
  const card = S.db.get('SELECT * FROM cards WHERE uid = ?', [UID]);
  assert.equal(card.child_id, null); assert.equal(card.status, 'sin_asignar'); assert.equal(card.balance_cents, 0);
  assert.equal(S.db.get('SELECT status FROM card_stock WHERE uid = ?', [UID]).status, 'entregada');
  const tx = S.db.get("SELECT * FROM transactions WHERE child_id = ? AND subtype = 'reembolso'", [k1]);
  assert.equal(tx.amount_cents, -12345); assert.equal(tx.balance_after_cents, 0);
  assert.ok(S.db.get("SELECT 1 AS x FROM transactions WHERE child_id = ? AND type = 'recarga'", [k1]));
  const kids = (await rpc('listChildren', {}, A)).data; assert.ok(!kids.some((c) => c.id === k1));
  assert.ok(!(await rpc('listChildren', {}, T)).data.some((c) => c.id === k1));
  const rep = (await rpc('report', {}, A)).data; assert.equal(rep.refunds_cents, 12345); assert.equal(rep.refunds_count, 1);
  const mv = (await rpc('listMovements', { child_id: k1 }, A)).data; assert.ok(mv.length >= 2);
  assert.ok(S.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'alumno_baja' AND target_id = ?", [String(k1)]));
  const trash = (await rpc('listRemoved', {}, A)).data; assert.ok(trash.children.some((c) => c.id === k1)); assert.equal(trash.can_purge, false);
  assert.equal((await rpc('listRemoved', {}, A2)).data.children.length, 0);
  // la tarjeta liberada se puede asignar a otro alumno
  assert.ok((await rpc('assignCardByUid', { uid: UID, child_id: k2 }, A)).ok);
});

test('restaurar alumno (admin) y volver a darlo de baja sin saldo', async () => {
  let r = await rpc('restoreChild', { child_id: k1 }, A); assert.ok(r.ok, r.error);
  assert.ok((await rpc('listChildren', {}, A)).data.some((c) => c.id === k1));
  r = await rpc('deleteChild', { child_id: k1 }, A); assert.ok(r.ok, r.error); assert.equal(r.data.refunded_cents, 0);
});

test('papá/tutor: baja invalida sesiones, no puede entrar, hijos siguen inscritos sin tutor; restaurar lo vuelve a vincular', async () => {
  const r = await rpc('deleteTutor', { user_id: tutor.id }, A); assert.ok(r.ok, r.error); assert.equal(r.data.unlinked_children, 1);
  assert.equal((await rpc('listChildren', {}, T)).status, 401);
  assert.equal((await login('papabaja', 'tutor1234')).ok, false);
  assert.equal(S.db.get('SELECT tutor_id, deleted_at FROM children WHERE id = ?', [k2]).tutor_id, null);
  assert.equal(S.db.get('SELECT deleted_at FROM children WHERE id = ?', [k2]).deleted_at, null);
  assert.ok(!(await rpc('listUsers', { role: 'tutor' }, A)).data.some((u) => u.id === tutor.id));
  assert.ok(!(await sup('listAccounts', {})).data.some((u) => u.id === tutor.id));
  assert.ok((await rpc('listRemoved', {}, A)).data.tutors.some((u) => u.id === tutor.id));
  assert.equal((await sup('setAccountActive', { user_id: tutor.id, active: true })).ok, false);
  const rr = await rpc('restoreTutor', { user_id: tutor.id }, A); assert.ok(rr.ok, rr.error); assert.equal(rr.data.relinked_children, 1);
  assert.equal((await login('papabaja', 'tutor1234')).ok, true);
});

test('baja de alumno con opción de borrar al tutor si no tiene más hijos (superadmin); borrado definitivo solo desde la Papelera', async () => {
  // k2 es el único hijo vigente del tutor
  assert.equal((await sup('purgeChild', { child_id: k2 })).status, 404, 'no está en la papelera');
  const r = await sup('deleteChild', { child_id: k2, delete_tutor: true });
  assert.ok(r.ok, r.error); assert.equal(r.data.tutor_deleted, tutor.id);
  const t = (await sup('listRemoved', { school_id: 1 })).data; assert.equal(t.can_purge, true);
  assert.ok(t.children.some((c) => c.id === k2)); assert.ok(t.tutors.some((u) => u.id === tutor.id));
  assert.ok((await sup('purgeChild', { child_id: k1 })).ok);
  assert.equal(S.db.get('SELECT id FROM children WHERE id = ?', [k1]), undefined);
  const tx = S.db.get("SELECT * FROM transactions WHERE subtype = 'reembolso' AND child_name = 'Alumno Baja Uno'"); assert.ok(tx, 'el historial se conserva con el nombre');
  assert.ok((await sup('purgeTutor', { user_id: tutor.id })).ok);
  assert.equal(S.db.get('SELECT id FROM users WHERE id = ?', [tutor.id]), undefined);
  assert.ok(S.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'tutor_eliminado_definitivo'"));
  assert.ok((await sup('restoreChild', { child_id: k2 })).ok);
  assert.equal(S.db.get('SELECT tutor_id FROM children WHERE id = ?', [k2]).tutor_id, null);
});
