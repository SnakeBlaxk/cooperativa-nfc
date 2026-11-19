'use strict';
// Eliminar escuela definitivamente (solo superadministrador): confirmación con nombre + contraseña,
// respaldo JSON en deleted_schools, borrado completo en una transacción y sin tocar otras escuelas.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');

let S, srv, base, Z, A, C, T, A2;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const login = (u, p) => api('/api/auth/login', { body: { identifier: u, password: p } });
const tok = async (u, p) => { const r = await login(u, p); assert.ok(r.ok, u + ': ' + r.error); return r.data.access_token; };
const sup = (m, body, token = Z) => api('/api/super/' + m, { body: body || {}, token });
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const SCHOOL = 'Colegio Morelos (demo)';
// Foto de lo que hay por escuela en cada tabla con school_id
function perSchool(sid) {
  const out = {};
  for (const t of S.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name)) {
    if (t === 'audit_log' || !S.db.all(`PRAGMA table_info(${t})`).some((c) => c.name === 'school_id')) continue;
    out[t] = S.db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE school_id = ?`, [sid]).n;
  }
  return out;
}

before(async () => {
  S = await createServer({ jwtSecret: 'q'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, whatsappSweepMs: 0, env: {} });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  [Z, A, C, T, A2] = [await tok('zuki', 'zuki123'), await tok('admin', 'admin123'), await tok('cajero', 'cajero123'), await tok('juan', 'tutor123'), await tok('admin2', 'admin123')];
});
after(() => new Promise((r) => srv.close(r)));

test('solo el superadministrador puede eliminar una escuela', async () => {
  for (const t of [A, C, A2]) {
    const r = await sup('deleteSchool', { school_id: 1, confirm_name: SCHOOL, password: 'zuki123' }, t);
    assert.equal(r.status, 403);
    assert.equal((await rpc('deleteSchool', { school_id: 1, confirm_name: SCHOOL, password: 'zuki123' }, t)).ok, false);
  }
  assert.ok(S.db.get('SELECT id FROM schools WHERE id = 1'));
});

test('vista previa con lo que se va a borrar', async () => {
  const r = await sup('previewDeleteSchool', { school_id: 1 });
  assert.ok(r.ok, r.error);
  assert.equal(r.data.school.name, SCHOOL);
  assert.ok(r.data.counts.alumnos >= 3 && r.data.counts.movimientos >= 1 && r.data.counts.cuentas_personal === 2);
  assert.equal(r.data.counts.papas_tutores_conservados, 1); // María tiene una hija en otra escuela
});

test('nombre o contraseña incorrectos: no borra nada y queda en la bitácora', async () => {
  const before1 = perSchool(1);
  let r = await sup('deleteSchool', { school_id: 1, confirm_name: 'Colegio Morelos', password: 'zuki123' });
  assert.equal(r.status, 400); assert.match(r.error, /nombre de la escuela/);
  r = await sup('deleteSchool', { school_id: 1, confirm_name: SCHOOL, password: 'otra' });
  assert.equal(r.status, 400); assert.match(r.error, /Contraseña incorrecta/);
  r = await sup('deleteSchool', { school_id: 1, confirm_name: SCHOOL });
  assert.equal(r.status, 400);
  assert.deepEqual(perSchool(1), before1);
  assert.equal(S.db.get('SELECT COUNT(*) AS n FROM deleted_schools').n, 0);
  assert.ok(S.db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'escuela_eliminar_rechazada'").n >= 3);
});

test('eliminar: borra todo lo de la escuela, guarda respaldo, cierra sesiones y deja intacta la otra escuela', async () => {
  // Datos extra en la escuela 1 (avisos, seguridad, WhatsApp, cambios) para cubrir más tablas
  S.db.run("INSERT INTO school_notices (school_id, kind, message, created_at) VALUES (1, 'stock', 'Aviso de prueba', datetime('now'))");
  S.db.run('INSERT INTO school_security (school_id, freeze_sales) VALUES (1, 0)');
  S.db.run('INSERT INTO whatsapp_settings (school_id, enabled) VALUES (1, 1)');
  S.db.run("INSERT INTO whatsapp_broadcasts (school_id, body, created_at) VALUES (1, 'Hola', datetime('now'))");
  S.db.run("INSERT INTO school_payments (school_id, paid_at, created_at) VALUES (1, '2026-11-01', datetime('now'))");
  const kid1 = S.db.get('SELECT id FROM children WHERE school_id = 1 LIMIT 1').id;
  S.db.run('INSERT OR REPLACE INTO limits (child_id, per_day_cents) VALUES (?, 5000)', [kid1]);
  const juan = S.db.get("SELECT id FROM users WHERE username = 'juan'");
  const maria = S.db.get("SELECT id FROM users WHERE username = 'maria'");
  const school2 = perSchool(2);
  const s2users = S.db.all('SELECT id FROM users WHERE school_id = 2 ORDER BY id').map((r) => r.id);
  const stock1 = S.db.all('SELECT uid FROM card_stock WHERE school_id = 1').map((r) => r.uid);
  assert.ok(stock1.length);

  const r = await sup('deleteSchool', { school_id: 1, confirm_name: SCHOOL, password: 'zuki123' });
  assert.ok(r.ok, r.error);
  assert.equal(r.data.deleted, true); assert.ok(r.data.backup_id);

  // Nada queda de la escuela 1 (la bitácora audit_log se conserva a propósito)
  const left = perSchool(1);
  for (const [t, n] of Object.entries(left)) assert.equal(n, 0, `${t} todavía tiene ${n} fila(s)`);
  assert.equal(S.db.get('SELECT id FROM schools WHERE id = 1'), undefined);
  assert.equal(S.db.get('SELECT COUNT(*) AS n FROM users WHERE school_id = 1 OR deleted_school_id = 1').n, 0);
  assert.equal(S.db.get("SELECT COUNT(*) AS n FROM users WHERE username IN ('admin','cajero','juan')").n, 0);
  assert.equal(S.db.get('SELECT COUNT(*) AS n FROM limits WHERE child_id = ?', [kid1]).n, 0);
  assert.equal(S.db.all('PRAGMA foreign_key_check').length, 0);
  // María (hija en otra escuela) se conserva y pasa a la escuela 2
  assert.equal(S.db.get('SELECT school_id FROM users WHERE id = ?', [maria.id]).school_id, 2);
  // Tarjetas del inventario: bloqueadas y sin escuela
  for (const uid of stock1) {
    const k = S.db.get('SELECT status, school_id FROM card_stock WHERE uid = ?', [uid]);
    assert.equal(k.school_id, null); assert.ok(['bloqueada', 'danada'].includes(k.status));
  }
  // La otra escuela, intacta (María ahora cuenta como usuaria de la escuela 2)
  const after2 = perSchool(2);
  assert.deepEqual({ ...after2, users: after2.users - 1, alerts: 0 }, { ...school2, alerts: 0 });
  assert.deepEqual(S.db.all('SELECT id FROM users WHERE school_id = 2 ORDER BY id').map((x) => x.id), [...s2users, maria.id].sort((a, b) => a - b));
  assert.ok((await login('admin2', 'admin123')).ok);
  assert.ok((await rpc('listProducts', {}, A2)).ok);

  // Respaldo completo y restaurable a mano
  const row = S.db.get('SELECT * FROM deleted_schools WHERE id = ?', [r.data.backup_id]);
  assert.equal(row.original_school_id, 1); assert.equal(row.school_name, SCHOOL);
  const b = JSON.parse(row.data).data;
  assert.equal(b.schools[0].name, SCHOOL);
  assert.ok(b.children.length >= 3 && b.transactions.length >= 1 && b.transaction_items.length >= 1 && b.products.length >= 1);
  assert.ok(b.users.some((u) => u.username === 'admin') && b.users.some((u) => u.id === juan.id));
  assert.equal(b.school_notices.length, 1); assert.equal(b.whatsapp_settings.length, 1); assert.ok(b.limits.some((l) => l.child_id === kid1));
  assert.ok(!('refresh_tokens' in b));
  const list = await sup('listDeletedSchools');
  assert.ok(list.ok && list.data[0].school_name === SCHOOL);
  const dl = await sup('getDeletedSchoolBackup', { id: r.data.backup_id });
  assert.ok(dl.ok && dl.data.backup.data.schools[0].id === 1);

  // Bitácora del superadmin y alerta
  const au = S.db.get("SELECT * FROM audit_log WHERE action = 'escuela_eliminada'");
  assert.ok(au); assert.equal(au.severity, 'critica'); assert.match(au.details, /Colegio Morelos/);
  assert.ok(S.db.get("SELECT id FROM alerts WHERE kind = 'escuela_eliminada'"));
});

test('las cuentas de la escuela eliminada ya no entran y sus sesiones quedan cerradas', async () => {
  for (const [u, p] of [['admin', 'admin123'], ['cajero', 'cajero123'], ['juan', 'tutor123']]) assert.equal((await login(u, p)).ok, false, u);
  assert.equal((await rpc('listProducts', {}, A)).status, 401);
  assert.equal((await rpc('listProducts', {}, C)).status, 401);
  assert.equal((await api('/api/auth/me', { token: T })).status, 401);
  // María (con hija en la otra escuela) sigue entrando
  assert.ok((await login('maria', 'tutor123')).ok);
  // El superadministrador sigue entrando y la escuela ya no aparece
  const ov = await sup('overview');
  assert.ok(ov.ok); assert.ok(!ov.data.schools.some((s) => s.id === 1));
  assert.equal((await sup('previewDeleteSchool', { school_id: 1 })).status, 404);
});

test('la base persiste: el respaldo y el borrado se guardan en la copia exportada', async () => {
  const { openDatabase } = require('../src/core/db');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'del-')), 'x.db');
  fs.writeFileSync(f, S.db.exportBuffer());
  const db2 = await openDatabase(f);
  assert.equal(db2.get('SELECT id FROM schools WHERE id = 1'), undefined);
  assert.equal(db2.get('SELECT COUNT(*) AS n FROM deleted_schools').n, 1);
  db2.close();
});
