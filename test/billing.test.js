'use strict';
// Mensualidad por escuela: estados Prueba/Activa/Pausada, avisos, tolerancia, pausa automática,
// pagos/renovación, reactivación, migración de escuelas existentes y bloqueo de la caja de escritorio.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { openDatabase } = require('../src/core/db');
const { seedMinimal } = require('../src/core/seed');
const { createSyncClient } = require('../src/core/sync-client');
const { billingInfo, mxDate, addDays, addMonths, daysBetween } = require('../src/core/billing');

let S, srv, base;
async function api(p, { body, token, headers } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });
async function tok(identifier, password) { const r = await login(identifier, password); assert.ok(r.ok, `${identifier}: ${r.error}`); return r.data; }
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const sup = (m, body, token) => api('/api/super/' + m, { body: body || {}, token });
const TODAY = () => mxDate();
let Z, B_ID, A_ID;
const setEnd = (sid, end, extra = '') => S.db.run(`UPDATE schools SET status = CASE WHEN status = 'pausada' THEN 'activa' ELSE status END, period_start = ?, period_end = ?, billing_notice = NULL ${extra} WHERE id = ?`, [addDays(end, -30), end, sid]);

before(async () => {
  S = await createServer({ cardStock: false, jwtSecret: 'b'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, legacySync: true });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  Z = (await tok('zuki', 'zuki123')).access_token;
  A_ID = S.db.get("SELECT id FROM schools WHERE name = 'Colegio Morelos (demo)'").id;
  B_ID = S.db.get("SELECT id FROM schools WHERE name = 'Instituto Valladolid (demo)'").id;
});
after(() => srv.close());

test('fechas: calendario de la Ciudad de México, meses y etapas (aviso, tolerancia, vencida)', () => {
  // 03:00 UTC del 9 de octubre = 21:00 del 8 de octubre en CDMX (UTC-6)
  assert.equal(mxDate(new Date('2026-10-09T03:00:00Z')), '2026-10-08');
  assert.equal(mxDate(new Date('2026-10-09T07:00:00Z')), '2026-10-09');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addDays('2026-02-27', 2), '2026-03-01');
  assert.equal(daysBetween('2026-10-09', '2026-11-08'), 30);
  const s = (end, status = 'activa') => billingInfo({ status, period_start: '2026-09-01', period_end: end }, '2026-10-09');
  assert.equal(s('2026-10-13').stage, 'ok');
  assert.deepEqual([s('2026-10-12').stage, s('2026-10-12').days_left], ['aviso', 3]);
  assert.deepEqual([s('2026-10-09').stage, s('2026-10-09').days_left], ['aviso', 0]);
  assert.deepEqual([s('2026-10-08').stage, s('2026-10-08').grace_days_left], ['tolerancia', 2]);
  assert.deepEqual([s('2026-10-07').stage, s('2026-10-07').grace_days_left, s('2026-10-07').pause_on], ['tolerancia', 1, '2026-10-10']);
  assert.equal(s('2026-10-06').stage, 'vencida');
  assert.equal(s('2026-10-20', 'pausada').stage, 'pausada');
  assert.equal(s('2026-10-12', 'prueba').stage, 'aviso'); // la prueba también avisa y vence
});

test('escuela nueva: Prueba por 30 días desde hoy (o Activa por 1 mes)', async () => {
  const r = await sup('createSchool', { name: 'Escuela Nueva Mensualidad', admin_username: 'admin.nueva' }, Z);
  assert.ok(r.ok, r.error);
  assert.equal(r.data.school.status, 'prueba');
  assert.equal(r.data.school.period_start, TODAY());
  assert.equal(r.data.school.period_end, addDays(TODAY(), 30));
  assert.equal(r.data.school.billing.days_left, 30);
  const a = await sup('createSchool', { name: 'Escuela Pagada', status: 'activa', admin_username: 'admin.pagada' }, Z);
  assert.equal(a.data.school.period_end, addMonths(TODAY(), 1));
  assert.equal((await sup('createSchool', { name: 'Escuela Pausada', status: 'pausada', admin_username: 'admin.pz' }, Z)).status, 400);
});

test('aviso (3 días antes) y tolerancia (2 días después): banner para admin/cajero, no para tutores; alerta al superadmin', async () => {
  setEnd(B_ID, addDays(TODAY(), 2));
  const ad = (await tok('admin2', 'admin123')).access_token;
  let st = await rpc('securityStatus', {}, ad);
  assert.equal(st.data.billing.stage, 'aviso'); assert.equal(st.data.billing.days_left, 2);
  const caj = (await tok('cajero2', 'cajero123')).access_token;
  assert.equal((await rpc('securityStatus', {}, caj)).data.billing.stage, 'aviso');
  const maria = (await tok('maria', 'tutor123')).access_token;
  assert.equal((await rpc('securityStatus', {}, maria)).data.billing, null); // los padres no ven cobros
  const al = await sup('listAlerts', {}, Z);
  assert.ok(al.data.some((a) => a.kind === 'mensualidad_por_vencer' && a.school_id === B_ID));
  // no se repite la alerta en cada petición
  await rpc('securityStatus', {}, ad);
  assert.equal(S.db.get("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'mensualidad_por_vencer' AND school_id = ?", [B_ID]).n, 1);

  setEnd(B_ID, addDays(TODAY(), -1));
  st = await rpc('securityStatus', {}, ad);
  assert.equal(st.data.billing.stage, 'tolerancia'); assert.equal(st.data.billing.grace_days_left, 2);
  assert.equal(st.data.billing.pause_on, addDays(TODAY(), 2));
  assert.ok((await rpc('listChildren', {}, ad)).ok, 'en tolerancia se sigue trabajando');
  assert.ok((await sup('listAlerts', {}, Z)).data.some((a) => a.kind === 'mensualidad_tolerancia' && a.school_id === B_ID && a.severity === 'alta'));
  assert.ok((await sup('listAudit', { category: 'mensualidad' }, Z)).data.some((a) => a.action === 'mensualidad_tolerancia'));
  const ov = await sup('overview', {}, Z);
  const b = ov.data.schools.find((x) => x.id === B_ID);
  assert.equal(b.billing.stage, 'tolerancia');
  assert.ok(ov.data.totals.schools_attention >= 1);
});

test('fin de la tolerancia: pausa automática, sesiones cerradas, nadie de la escuela entra; datos intactos', async () => {
  // tutor que solo tiene hijos en la escuela B
  const kid = S.db.get("SELECT id FROM children WHERE school_id = ? AND tutor_id IS NULL AND active = 1 LIMIT 1", [B_ID])
    || { id: S.db.run("INSERT INTO children (school_id, full_name, created_at) VALUES (?, 'Alumno Solo B', datetime('now'))", [B_ID]).lastId };
  const inv = await sup('generateInvitations', { school_id: B_ID, child_ids: [kid.id] }, Z);
  const reg = await api('/api/auth/register', { body: { code: inv.data[0].code, full_name: 'Papá Solo B', email: 'papa.b@example.com', password: 'PapaSoloB2026' } });
  assert.ok(reg.ok, reg.error);
  const tutorB = reg.data;
  const ad = await tok('admin2', 'admin123');
  const maria = (await tok('maria', 'tutor123')).access_token;
  const counts = () => ['children', 'cards', 'transactions', 'products'].map((t) => S.db.get(`SELECT COUNT(*) AS n FROM ${t} WHERE school_id = ?`, [B_ID]).n);
  const before = counts();
  // caja de escritorio vinculada a B
  const dev = S.sync.registerDevice({ id: S.db.get("SELECT id FROM users WHERE username = 'admin2'").id, role: 'admin', school_id: B_ID }, { device_id: 'ab'.repeat(16), name: 'Caja B' });
  assert.equal((await api('/api/sync/status', { headers: { 'X-Device-Token': dev.device_token } })).status, 200);

  setEnd(B_ID, addDays(TODAY(), -3)); // venció hace 3 días: terminó la tolerancia de 2 días
  const r = await rpc('listChildren', {}, ad.access_token);
  assert.equal(r.status, 403); assert.equal(r.code, 'ESCUELA_PAUSADA'); assert.equal(r.error, 'Servicio pausado. Contacte a la administración.');
  const sc = S.db.get('SELECT * FROM schools WHERE id = ?', [B_ID]);
  assert.equal(sc.status, 'pausada'); assert.equal(sc.pause_reason, 'falta_pago');
  // nadie de la escuela entra (admin, cajero, tutor solo de B); el refresh tampoco renueva
  for (const [u, p] of [['admin2', 'admin123'], ['cajero2', 'cajero123'], ['papa.b@example.com', 'PapaSoloB2026']]) {
    const l = await login(u, p);
    assert.equal(l.status, 403, u); assert.equal(l.code, 'ESCUELA_PAUSADA', u);
  }
  assert.equal((await login('admin2', 'malapass')).code, 'NO_AUTENTICADO', 'con contraseña incorrecta no revela el estado');
  assert.equal((await api('/api/auth/refresh', { body: { refresh_token: ad.refresh_token } })).code, 'ESCUELA_PAUSADA');
  assert.equal((await rpc('listChildren', {}, tutorB.access_token)).code, 'ESCUELA_PAUSADA');
  // la tutora con hijos también en otra escuela activa sigue entrando
  assert.ok((await rpc('listChildren', {}, maria)).ok);
  // la caja deja de sincronizar
  const ds = await api('/api/sync/status', { headers: { 'X-Device-Token': dev.device_token } });
  assert.equal(ds.status, 403); assert.equal(ds.code, 'ESCUELA_PAUSADA');
  // la escuela A no se ve afectada
  assert.ok((await tok('admin', 'admin123')).access_token);
  assert.deepEqual(counts(), before, 'datos conservados');
  assert.ok((await sup('listAlerts', {}, Z)).data.some((a) => a.kind === 'mensualidad_pausada' && a.school_id === B_ID));
  assert.ok((await sup('listAudit', { category: 'mensualidad' }, Z)).data.some((a) => a.action === 'escuela_pausada_auto'));

  // Registrar pago: reactiva, el mes empieza hoy (estaba pausada) y queda en el historial
  const pay = await sup('registerPayment', { school_id: B_ID, amount_cents: 150000, note: 'Transferencia' }, Z);
  assert.ok(pay.ok, pay.error);
  assert.equal(pay.data.reactivated, true);
  assert.equal(pay.data.period_start, TODAY()); assert.equal(pay.data.period_end, addMonths(TODAY(), 1));
  assert.equal(S.db.get('SELECT status FROM schools WHERE id = ?', [B_ID]).status, 'activa');
  assert.ok((await login('admin2', 'admin123')).ok);
  assert.ok((await login('papa.b@example.com', 'PapaSoloB2026')).ok);
  assert.equal((await api('/api/sync/status', { headers: { 'X-Device-Token': dev.device_token } })).status, 200);
  // Segundo pago: extiende un mes desde el fin anterior
  const pay2 = await sup('registerPayment', { school_id: B_ID, paid_at: TODAY() }, Z);
  assert.equal(pay2.data.period_start, addDays(pay.data.period_end, 1));
  assert.equal(pay2.data.period_end, addMonths(pay.data.period_end, 1));
  const det = await sup('schoolDetail', { id: B_ID }, Z);
  assert.equal(det.data.payments.length, 2);
  assert.equal(det.data.payments[1].amount_cents, 150000); assert.equal(det.data.payments[1].note, 'Transferencia');
  assert.equal(det.data.school.billing.status, 'activa');
  assert.ok((await sup('listAudit', { category: 'mensualidad' }, Z)).data.filter((a) => a.action === 'mensualidad_pago').length >= 2);
});

test('pausar ahora y reactivar (superadmin); validaciones y permisos', async () => {
  const ad = await tok('admin2', 'admin123');
  const p = await sup('pauseSchool', { school_id: B_ID }, Z);
  assert.ok(p.ok, p.error); assert.ok(p.data.sessions_closed >= 2);
  assert.equal((await rpc('listChildren', {}, ad.access_token)).code, 'ESCUELA_PAUSADA');
  assert.equal((await sup('pauseSchool', { school_id: B_ID }, Z)).status, 400);
  const end = S.db.get('SELECT period_end FROM schools WHERE id = ?', [B_ID]).period_end;
  const r = await sup('reactivateSchool', { school_id: B_ID }, Z);
  assert.ok(r.ok, r.error);
  assert.equal(r.data.school.status, 'activa'); assert.equal(r.data.school.period_end, end, 'periodo vigente: se conserva');
  assert.ok((await login('admin2', 'admin123')).ok);
  // reactivar con el periodo ya vencido da 7 días por omisión
  await sup('pauseSchool', { school_id: B_ID }, Z);
  S.db.run('UPDATE schools SET period_end = ? WHERE id = ?', [addDays(TODAY(), -10), B_ID]);
  const r2 = await sup('reactivateSchool', { school_id: B_ID, status: 'prueba' }, Z);
  assert.equal(r2.data.school.period_end, addDays(TODAY(), 7)); assert.equal(r2.data.school.status, 'prueba');
  assert.equal((await sup('reactivateSchool', { school_id: B_ID, period_end: addDays(TODAY(), -1) }, Z)).status, 400);
  // cambiar fechas a mano
  assert.equal((await sup('setBillingPeriod', { school_id: B_ID, status: 'activa', period_start: '2026-05-10', period_end: '2026-05-01' }, Z)).status, 400);
  assert.equal((await sup('setBillingPeriod', { school_id: B_ID, status: 'activa', period_start: TODAY(), period_end: '2026-13-01' }, Z)).status, 400);
  const sp = await sup('setBillingPeriod', { school_id: B_ID, status: 'activa', period_start: TODAY(), period_end: addDays(TODAY(), 45) }, Z);
  assert.ok(sp.ok, sp.error); assert.equal(sp.data.school.stage, 'ok'); assert.equal(sp.data.school.days_left, 45);
  // solo el superadministrador
  assert.equal((await sup('registerPayment', { school_id: B_ID }, (await tok('admin2', 'admin123')).access_token)).status, 403);
  assert.equal((await rpc('registerPayment', { school_id: B_ID }, (await tok('admin2', 'admin123')).access_token)).ok, false);
  // updateSchool con estado (compatibilidad): pausada / activa
  assert.ok((await sup('updateSchool', { id: B_ID, status: 'pausada' }, Z)).ok);
  assert.equal(S.db.get('SELECT status FROM schools WHERE id = ?', [B_ID]).status, 'pausada');
  assert.ok((await sup('updateSchool', { id: B_ID, status: 'activa' }, Z)).ok);
  assert.ok((await login('admin2', 'admin123')).ok);
  const acc = await sup('listAccounts', { school_id: B_ID }, Z);
  assert.ok(acc.data.every((u) => 'school_status' in u));
});

test('revisión periódica: pausa escuelas vencidas aunque nadie entre', async () => {
  setEnd(A_ID, addDays(TODAY(), -5));
  const out = S.billing.sweep();
  assert.equal(out.find((x) => x.id === A_ID).stage, 'pausada');
  assert.equal(S.db.get('SELECT status FROM schools WHERE id = ?', [A_ID]).status, 'pausada');
  await sup('reactivateSchool', { school_id: A_ID, status: 'activa', period_end: addDays(TODAY(), 20) }, Z);
  assert.ok((await login('admin', 'admin123')).ok);
});

test('caja de escritorio: al sincronizar con la escuela pausada queda marcada como pausada (la caja bloquea ventas y recargas); al reactivar vuelve', async () => {
  const sid = (await sup('createSchool', { name: 'Escuela Caja', status: 'activa', admin_username: 'admin.caja' }, Z)).data;
  const pw = sid.admin.temporary_password; const SID = sid.school.id;
  const desk = await openDatabase(null, { syncOutbox: true }); seedMinimal(desk);
  let cfg = {};
  const c = createSyncClient({ db: desk, getConfig: () => cfg });
  const l = await c.linkDevice({ serverUrl: base, username: 'admin.caja', password: pw, name: 'Caja' });
  cfg = { serverUrl: base, deviceToken: l.deviceToken };
  let st = await c.syncNow();
  assert.equal(st.state, 'ok', st.last_error); assert.equal(c.isPaused(), false);
  // aviso de vencimiento llega a la caja
  setEnd(SID, addDays(TODAY(), 1));
  await c.syncNow();
  assert.equal(c.billingNotice().stage, 'aviso'); assert.equal(c.billingNotice().days_left, 1);
  // se pausa en el servidor → la caja lo sabe en la siguiente sincronización
  await sup('pauseSchool', { school_id: SID }, Z);
  st = await c.syncNow();
  assert.equal(st.state, 'pausado'); assert.equal(st.paused, true); assert.equal(c.isPaused(), true);
  assert.match(st.last_error, /Servicio pausado/);
  // sin conexión conserva el estado (sigue bloqueada hasta que una sincronización diga lo contrario)
  const off = createSyncClient({ db: desk, getConfig: () => ({ serverUrl: 'http://127.0.0.1:1', deviceToken: 'x' }), timeoutMs: 500 });
  assert.equal((await off.syncNow()).state, 'sin_conexion'); assert.equal(off.isPaused(), true);
  await sup('reactivateSchool', { school_id: SID }, Z);
  st = await c.syncNow();
  assert.equal(st.state, 'ok', st.last_error); assert.equal(c.isPaused(), false);
});

test('migración: escuelas existentes pasan a Prueba 30 días desde hoy; las suspendidas quedan pausadas; datos intactos', async () => {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')) });
  const old = new SQL.Database();
  old.exec(`CREATE TABLE schools (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('activa','prueba','suspendida')),
      plan_note TEXT, contact_name TEXT, contact_phone TEXT, contact_email TEXT, primary_device_id TEXT, created_at TEXT NOT NULL);
    INSERT INTO schools (uuid, name, status, plan_note, primary_device_id, created_at) VALUES ('u1', 'Escuela Uno', 'activa', 'Plan $1,500', 'dev1', '2025-01-01 10:00:00'),
      ('u2', 'Escuela Dos', 'prueba', NULL, NULL, '2025-02-01 10:00:00'), ('u3', 'Escuela Tres', 'suspendida', NULL, NULL, '2025-03-01 10:00:00');
    CREATE TABLE children (id INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, school_id INTEGER REFERENCES schools(id), tutor_id INTEGER, full_name TEXT NOT NULL, grade TEXT, photo TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    INSERT INTO children (school_id, full_name, created_at) VALUES (1, 'Ana', '2025-01-02'), (3, 'Beto', '2025-03-02');`);
  const f = path.join(os.tmpdir(), `coop-billing-mig-${process.pid}.db`);
  fs.writeFileSync(f, Buffer.from(old.export())); old.close();
  let db = await openDatabase(f);
  const rows = db.all('SELECT * FROM schools ORDER BY id');
  assert.deepEqual(rows.map((r) => r.status), ['prueba', 'prueba', 'pausada']);
  assert.deepEqual(rows.map((r) => r.uuid), ['u1', 'u2', 'u3']);
  assert.equal(rows[0].plan_note, 'Plan $1,500'); assert.equal(rows[0].primary_device_id, 'dev1'); assert.equal(rows[0].created_at, '2025-01-01 10:00:00');
  assert.equal(rows[0].period_start, TODAY()); assert.equal(rows[0].period_end, addDays(TODAY(), 30));
  assert.equal(rows[2].period_end, null); assert.equal(rows[2].pause_reason, 'manual');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM children').n, 2);
  assert.equal(db.get("SELECT school_id FROM children WHERE full_name = 'Beto'").school_id, 3);
  assert.ok(db.get("SELECT 1 AS x FROM sqlite_master WHERE name = 'school_payments'"));
  // Volver a abrir no vuelve a migrar (no reinicia periodos ya ajustados)
  db.run("UPDATE schools SET status = 'activa', period_end = '2030-01-01' WHERE id = 1"); db.close();
  db = await openDatabase(f);
  assert.deepEqual([db.get('SELECT status, period_end FROM schools WHERE id = 1').status, db.get('SELECT period_end FROM schools WHERE id = 1').period_end], ['activa', '2030-01-01']);
  db.close(); fs.unlinkSync(f);
});
