'use strict';
// Bajas de personal (administrador de escuela / cajero) por el superadministrador, con Papelera
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');

let S, srv, base, Z, A, C;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const login = (u, p) => api('/api/auth/login', { body: { identifier: u, password: p } });
const tok = async (u, p) => { const r = await login(u, p); assert.ok(r.ok, u + ': ' + r.error); return r.data.access_token; };
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const sup = (m, body) => api('/api/super/' + m, { body: body || {}, token: Z });
const userId = (u) => S.db.get('SELECT id FROM users WHERE username = ?', [u]).id;

before(async () => {
  S = await createServer({ jwtSecret: 'p'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  [Z, A, C] = [await tok('zuki', 'zuki123'), await tok('admin', 'admin123'), await tok('cajero', 'cajero123')];
});
after(() => new Promise((r) => srv.close(r)));

test('solo el superadministrador; el superadmin no se puede eliminar; tutores no son personal', async () => {
  const cid = userId('cajero');
  for (const t of [A, C]) {
    assert.equal((await rpc('deleteStaff', { user_id: cid, confirm: 'cajero' }, t)).status, 403);
    assert.equal((await rpc('purgeStaff', { user_id: cid }, t)).status, 403);
  }
  const zr = await sup('deleteStaff', { user_id: userId('zuki'), confirm: 'zuki' });
  assert.equal(zr.status, 403);
  const tu = (await rpc('createUser', { role: 'tutor', username: 'papapersonal', password: 'tutor1234', full_name: 'Papá X' }, A)).data;
  assert.equal((await sup('deleteStaff', { user_id: tu.id, confirm: 'papapersonal' })).status, 404);
});

test('baja de cajero: confirmación con usuario, sesiones cerradas, Papelera, historial intacto, restaurar y borrar definitivo', async () => {
  const cid = userId('cajero');
  const cname = S.db.get('SELECT full_name FROM users WHERE id = ?', [cid]).full_name;
  // Una venta/recarga hecha por el cajero
  const kid = (await rpc('createChild', { full_name: 'Alumno Personal', grade: '2B' }, A)).data.id;
  assert.ok((await rpc('assignCardByUid', { uid: '04D9E0F1A2B3C4', child_id: kid }, A)).ok);
  assert.ok((await rpc('recharge', { uid: '04D9E0F1A2B3C4', amount_cents: 5000 }, C)).ok);
  const nTx = S.db.get('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [cid]).n;
  assert.ok(nTx >= 1);

  const pv = await sup('previewDeleteStaff', { user_id: cid });
  assert.ok(pv.ok); assert.equal(pv.data.last_admin, false); assert.equal(pv.data.movements, nTx);
  assert.equal((await sup('deleteStaff', { user_id: cid, confirm: 'otro' })).status, 400);
  assert.equal((await sup('deleteStaff', { user_id: cid })).status, 400);
  const d = await sup('deleteStaff', { user_id: cid, confirm: 'cajero' });
  assert.ok(d.ok, d.error);

  // sesión existente invalidada y ya no puede entrar
  assert.equal((await rpc('listProducts', {}, C)).status, 401);
  assert.equal((await login('cajero', 'cajero123')).ok, false);
  // fuera de Cuentas y del detalle de escuela; en la Papelera del superadmin
  assert.ok(!(await sup('listAccounts', {})).data.some((u) => u.id === cid));
  const sid = S.db.get('SELECT deleted_school_id AS s FROM users WHERE id = ?', [cid]).s;
  const det = await sup('schoolDetail', { id: sid }); assert.ok(det.ok, det.error);
  assert.ok(det.data.staff.length >= 1 && !det.data.staff.some((u) => u.id === cid));
  const pap = await sup('listRemoved', {});
  assert.ok(pap.data.staff.some((u) => u.id === cid && u.type === 'personal'));
  // el admin de escuela no ve personal en su Papelera
  assert.deepEqual((await rpc('listRemoved', {}, A)).data.staff, []);
  // no se puede reactivar / editar mientras está en la Papelera
  assert.equal((await sup('setAccountActive', { user_id: cid, active: true })).status, 400);
  assert.equal((await sup('setStaffActive', { user_id: cid, active: true })).ok, false);
  // historial intacto
  assert.equal(S.db.get('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [cid]).n, nTx);
  // auditoría
  assert.ok(S.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'personal_baja' AND target_id = ?", [cid]));

  // restaurar
  const r = await sup('restoreStaff', { user_id: cid });
  assert.ok(r.ok, r.error);
  assert.ok((await login('cajero', 'cajero123')).ok);
  assert.equal(S.db.get('SELECT school_id FROM users WHERE id = ?', [cid]).school_id, sid);

  // de nuevo a la Papelera y eliminar definitivamente
  assert.equal((await sup('purgeStaff', { user_id: cid })).status, 404); // solo desde la Papelera
  assert.ok((await sup('deleteStaff', { user_id: cid, confirm: 'cajero' })).ok);
  const p = await sup('purgeStaff', { user_id: cid });
  assert.ok(p.ok, p.error);
  assert.equal(S.db.get('SELECT COUNT(*) AS n FROM users WHERE id = ?', [cid]).n, 0);
  const tx = S.db.all('SELECT user_id, processed_by_name FROM transactions WHERE processed_by_name IS NOT NULL AND user_id IS NULL');
  assert.ok(tx.length >= nTx);
  const rows = (await rpc('listMovements', {}, A)).data;
  assert.ok(rows.some((t) => t.user_name === cname && t.type === 'recarga'));
  assert.ok(S.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'personal_eliminado_definitivo' AND target_id = ?", [cid]));
  assert.equal(S.db.all('PRAGMA foreign_key_check').length, 0);
});

test('aviso al eliminar el último administrador de la escuela', async () => {
  const aid = userId('admin');
  const pv = await sup('previewDeleteStaff', { user_id: aid });
  assert.ok(pv.ok); assert.equal(pv.data.last_admin, true); assert.ok(pv.data.warning);
  const d = await sup('deleteStaff', { user_id: aid, confirm: 'admin' });
  assert.ok(d.ok); assert.equal(d.data.last_admin, true);
  assert.ok(S.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'personal_baja' AND target_id = ? AND severity = 'alta'", [aid]));
  assert.ok((await sup('restoreStaff', { user_id: aid })).ok);
  assert.ok((await login('admin', 'admin123')).ok);
});
