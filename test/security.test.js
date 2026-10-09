'use strict';
// Seguridad y emergencias: cuentas (solo el superadmin asigna contraseñas), bloqueo por intentos,
// recuperación de emergencia, congelar recargas/ventas, solo lectura, ALERTA ROJA, alertas de anomalías,
// reversión de recargas, bitácora, papelera, respaldo y persistencia en Turso (simulada).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { openDatabase } = require('../src/core/db');
const { evaluateFlags } = require('../src/core/security');
const { createTursoStore, createReplicator, persistenceMode } = require('../server/persist');

let S, srv, base;
async function api(p, { body, token, raw } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return r;
  return { status: r.status, ...(await r.json()) };
}
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });
async function tok(u, p) { const r = await login(u, p); assert.ok(r.ok, `${u}: ${r.error}`); return r.data.access_token; }
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const sup = (m, body, token) => api('/api/super/' + m, { body: body || {}, token });
const sid = (name) => S.db.get('SELECT id FROM schools WHERE name = ?', [name]).id;
async function start(opts = {}) {
  S = await createServer({ jwtSecret: 'k'.repeat(40), mailer: consoleMailer(() => {}), legacySync: true, ...opts });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
}
let Z;
before(async () => { await start(); Z = await tok('zuki', 'zuki123'); });
after(() => { srv.closeAllConnections(); srv.close(); });

test('cuentas: lista con jerarquía/escuela/estado; el superadmin asigna contraseñas y nadie más', async () => {
  const list = (await sup('listAccounts', {}, Z)).data;
  assert.equal(list[0].role, 'superadmin');
  const caj = list.find((u) => u.username === 'cajero');
  assert.equal(caj.school_name, 'Colegio Morelos (demo)'); assert.equal(caj.active, true); assert.ok(caj.created_at);
  assert.ok(list.find((u) => u.username === 'maria').school_name.includes('Instituto')); // tutora en 2 escuelas
  assert.ok((await sup('listAccounts', { role: 'cajero' }, Z)).data.every((u) => u.role === 'cajero'));
  const A = await tok('admin', 'admin123');
  assert.equal((await sup('listAccounts', {}, A)).status, 403);
  // contraseña generada: se muestra una vez, cierra sesiones anteriores
  const oldCaj = await tok('cajero', 'cajero123');
  const r = await sup('setPassword', { user_id: caj.id }, Z);
  assert.ok(r.ok); assert.ok(r.data.password.length >= 12);
  assert.equal((await rpc('listChildren', {}, oldCaj)).status, 401);
  assert.equal((await login('cajero', 'cajero123')).status, 401);
  const nc = await tok('cajero', r.data.password);
  assert.equal((await api('/api/auth/me', { token: nc })).data.must_change_password, false);
  // contraseña elegida
  assert.ok((await sup('setPassword', { user_id: caj.id, password: 'CajeroNueva2026' }, Z)).ok);
  await tok('cajero', 'CajeroNueva2026');
  assert.equal((await sup('setPassword', { user_id: caj.id, password: 'corta' }, Z)).status, 400);
  const after1 = (await sup('listAccounts', { q: 'cajero' }, Z)).data.find((u) => u.id === caj.id);
  assert.equal(after1.password_set_by, 'zuki'); assert.ok(after1.last_login_at);
  // bitácora de contraseñas
  const aud = (await sup('listAudit', { category: 'contrasenas' }, Z)).data;
  assert.ok(aud.some((a) => a.action === 'contrasena_asignada' && a.target_id === String(caj.id) && a.ip));
  assert.ok(!JSON.stringify(aud).includes('CajeroNueva2026')); // nunca se guarda la contraseña
  // cambio de rol y activación
  assert.equal((await sup('setAccountRole', { user_id: caj.id, role: 'admin' }, Z)).data.role, 'admin');
  assert.equal((await sup('setAccountRole', { user_id: caj.id, role: 'cajero' }, Z)).data.role, 'cajero');
  assert.ok((await sup('listAudit', { category: 'roles' }, Z)).data.some((a) => a.action === 'rol_cambiado'));
  assert.equal((await sup('setAccountActive', { user_id: caj.id, active: false }, Z)).data.active, false);
  assert.equal((await login('cajero', 'CajeroNueva2026')).status, 401);
  await sup('setAccountActive', { user_id: caj.id, active: true }, Z);
});

test('superadmin protegido: no se puede desactivar, degradar ni borrar', async () => {
  const me = S.db.get("SELECT id FROM users WHERE role = 'superadmin'").id;
  assert.equal((await sup('setAccountActive', { user_id: me, active: false }, Z)).status, 403);
  assert.equal((await sup('setAccountRole', { user_id: me, role: 'admin' }, Z)).status, 403);
  assert.throws(() => S.db.run('DELETE FROM users WHERE id = ?', [me]), /no se puede eliminar/);
  assert.throws(() => S.db.run("UPDATE users SET role = 'admin' WHERE id = ?", [me]), /no se puede degradar/);
  assert.throws(() => S.db.run('UPDATE users SET active = 0 WHERE id = ?', [me]), /no se puede desactivar/);
  const A = await tok('admin', 'admin123');
  assert.equal((await rpc('updateUser', { id: me, active: false }, A)).status, 404); // el admin ni lo ve
});

test('bloqueo por intentos fallidos del superadmin, alerta y recuperación de emergencia por variable', async () => {
  srv.close();
  await start({ seed: false, bootstrapSuperadmin: { username: 'dueno', password: 'DuenoInicial2026' }, authOptions: { maxLoginAttempts: 50 } });
  const ok = await login('dueno', 'DuenoInicial2026');
  assert.equal(ok.data.must_change_password, false); // la inicial viene de env: no se fuerza el cambio
  for (let i = 0; i < 5; i++) assert.equal((await login('dueno', 'mal' + i)).status, 401);
  const locked = await login('dueno', 'DuenoInicial2026');
  assert.equal(locked.status, 429); assert.match(locked.error, /bloqueada/);
  assert.ok(S.db.get("SELECT id FROM alerts WHERE kind = 'cuenta_bloqueada' AND severity = 'critica'"));
  assert.ok(S.db.get("SELECT id FROM alerts WHERE kind = 'intentos_fallidos'"));
  // reinicio con SUPERADMIN_RESET_PASSWORD sobre la misma base
  const db = S.db; srv.close();
  await start({ db, seed: false, superadminReset: { username: 'dueno', password: 'Recuperada2026!' }, authOptions: { maxLoginAttempts: 50 } });
  const t = await tok('dueno', 'Recuperada2026!');
  // se aplica una sola vez: tras cambiar la contraseña, un reinicio con la misma variable no la pisa
  const ch = await api('/api/auth/change-password', { body: { current: 'Recuperada2026!', next: 'MiClaveFinal2026' }, token: t });
  assert.ok(ch.ok, ch.error);
  srv.close();
  await start({ db, seed: false, superadminReset: { username: 'dueno', password: 'Recuperada2026!' } });
  assert.equal((await login('dueno', 'Recuperada2026!')).status, 401);
  await tok('dueno', 'MiClaveFinal2026');
  assert.ok(S.db.get("SELECT id FROM audit_log WHERE action = 'superadmin_recuperado'"));
  srv.close(); await start(); Z = await tok('zuki', 'zuki123');
});

test('congelar recargas (escuela y global), ventas, solo lectura y límite diario; la caja recibe las banderas', async () => {
  const A = await tok('admin', 'admin123'); const C = await tok('cajero', 'cajero123'); const B = await tok('admin2', 'admin123');
  const s1 = sid('Colegio Morelos (demo)');
  const recharge = (t, amt = 1000, uid = '04A1B2C3D4E5F6') => rpc('recharge', { uid, amount_cents: amt }, t);
  assert.ok((await recharge(C)).ok);
  await sup('setSchoolSecurity', { school_id: s1, freeze_recharges: true }, Z);
  let r = await recharge(C); assert.equal(r.status, 423); assert.match(r.error, /RECARGAS están congeladas/);
  assert.deepEqual((await rpc('securityStatus', {}, C)).data.freeze_recharges, true);
  assert.ok((await rpc('recharge', { uid: '05A1A1A1A1A1A1', amount_cents: 1000 }, B)).ok); // otra escuela no se afecta
  await sup('setSchoolSecurity', { school_id: s1, freeze_recharges: false }, Z);
  assert.ok((await recharge(C)).ok);
  await sup('setGlobalFreeze', { on: true }, Z);
  assert.equal((await rpc('recharge', { uid: '05A1A1A1A1A1A1', amount_cents: 1000 }, B)).status, 423);
  await sup('setGlobalFreeze', { on: false }, Z);
  // ventas
  const prod = (await rpc('listProducts', { onlyActive: true }, C)).data.find((p) => p.name === 'Manzana');
  await sup('setSchoolSecurity', { school_id: s1, freeze_sales: true }, Z);
  r = await rpc('purchase', { uid: '04C3D4E5F6A7B8', items: [{ product_id: prod.id, qty: 1 }] }, C);
  assert.equal(r.status, 423); assert.match(r.error, /VENTAS/);
  assert.ok((await recharge(C)).ok); // las recargas siguen
  await sup('setSchoolSecurity', { school_id: s1, freeze_sales: false, read_only: true }, Z);
  assert.equal((await rpc('createCategory', { name: 'Nueva' }, A)).status, 423);
  assert.ok((await rpc('listChildren', {}, A)).ok); // leer sí
  const maria = await tok('maria', 'tutor123');
  const sofia = (await rpc('listChildren', {}, maria)).data.find((k) => k.full_name === 'Sofía Hernández');
  assert.equal((await rpc('setLimits', { child_id: sofia.id, per_day_cents: 1000 }, maria)).status, 423); // también padres
  await sup('setSchoolSecurity', { school_id: s1, read_only: false, daily_recharge_limit_cents: 100000 }, Z);
  const today = S.db.get("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE school_id = ? AND type = 'recarga' AND created_at >= date('now','localtime')", [s1]).s;
  r = await recharge(C, 100000 - today + 100);
  assert.equal(r.status, 423); assert.match(r.error, /límite diario/);
  assert.ok(S.db.get("SELECT id FROM alerts WHERE kind = 'limite_diario'"));
  await sup('setSchoolSecurity', { school_id: s1, daily_recharge_limit_cents: null }, Z);
  const emer = (await sup('listAudit', { category: 'emergencia' }, Z)).data.map((a) => a.action);
  assert.ok(emer.includes('congelar_recargas') && emer.includes('congelar_ventas') && emer.includes('solo_lectura'));
  // evaluación en la caja (mismas reglas)
  assert.match(evaluateFlags({ freeze_recharges: true }, 'recharge', {}), /RECARGAS/);
  assert.equal(evaluateFlags({ freeze_recharges: true }, 'purchase', {}), null);
  assert.match(evaluateFlags({ lockdown: true }, 'purchase', {}), /ALERTA ROJA/);
  assert.equal(evaluateFlags({ lockdown: true }, 'listMovements', {}), null);
  assert.match(evaluateFlags({ daily_recharge_limit_cents: 5000 }, 'recharge', { amount_cents: 2000 }, { todayRechargesCents: 4000 }), /límite diario/);
});

test('bloquear admin de una escuela y cerrar sesiones (escuela y global)', async () => {
  const s2 = sid('Instituto Valladolid (demo)');
  const B = await tok('admin2', 'admin123'); const C2 = await tok('cajero2', 'cajero123'); const A = await tok('admin', 'admin123');
  const r = await sup('blockSchoolAdmins', { school_id: s2 }, Z);
  assert.equal(r.data.blocked, 1);
  assert.equal((await rpc('listChildren', {}, B)).status, 401);
  assert.equal((await rpc('listChildren', {}, C2)).status, 401); // sesiones de la escuela cerradas
  assert.equal((await login('admin2', 'admin123')).status, 401); // cuenta desactivada
  assert.ok((await rpc('listChildren', {}, A)).ok); // otra escuela intacta
  const adm2 = S.db.get("SELECT id FROM users WHERE username = 'admin2'").id;
  await sup('setAccountActive', { user_id: adm2, active: true }, Z);
  const all = await sup('logoutEveryone', {}, Z);
  assert.ok(all.data.sessions_closed > 3);
  assert.equal((await rpc('listChildren', {}, A)).status, 401);
  assert.ok((await sup('overview', {}, Z)).ok); // el superadmin sigue dentro
});

test('ALERTA ROJA: confirma, cierra sesiones, bloquea accesos (salvo superadmin) y se desbloquea', async () => {
  const A = await tok('admin', 'admin123'); const M = await tok('maria', 'tutor123');
  assert.equal((await sup('lockdown', { confirm: 'si' }, Z)).status, 400);
  assert.ok((await sup('lockdown', { confirm: 'alerta roja' }, Z)).ok);
  assert.equal((await rpc('listChildren', {}, A)).status, 401);
  assert.equal((await rpc('listChildren', {}, M)).status, 401);
  const l = await login('admin', 'admin123'); assert.equal(l.status, 403); assert.equal(l.code, 'SISTEMA_BLOQUEADO');
  assert.equal((await login('maria', 'tutor123')).code, 'SISTEMA_BLOQUEADO');
  const Z2 = await tok('zuki', 'zuki123');
  const ov = (await sup('securityOverview', {}, Z2)).data; assert.equal(ov.lockdown, true);
  assert.ok(ov.open_alerts >= 1);
  assert.ok((await sup('unlock', {}, Z2)).ok);
  await tok('admin', 'admin123');
  const acts = (await sup('listAudit', { category: 'emergencia' }, Z2)).data.map((a) => a.action);
  assert.ok(acts.includes('alerta_roja') && acts.includes('alerta_roja_fin'));
  Z = Z2;
});

test('alertas de anomalías: recarga grande, repetidas, fuera de horario y auto-recarga; marcar y revertir', async () => {
  const A = await tok('admin', 'admin123');
  const s1 = sid('Colegio Morelos (demo)');
  // cajera que es la misma persona que la tutora de Sofía (mismo nombre)
  assert.ok((await rpc('createUser', { role: 'cajero', username: 'caja.maria', full_name: 'María Hernández', password: 'CajaMaria2026' }, A)).ok);
  const CM = await tok('caja.maria', 'CajaMaria2026');
  await sup('setSchoolSecurity', { school_id: s1, hours_start: '23:58', hours_end: '23:59', large_recharge_cents: 50000 }, Z);
  const big = await rpc('recharge', { uid: '04A1B2C3D4E5F6', amount_cents: 60000 }, CM);
  assert.ok(big.ok);
  for (let i = 0; i < 2; i++) await rpc('recharge', { uid: '04A1B2C3D4E5F6', amount_cents: 1000 }, CM);
  const kinds = (await sup('listAlerts', {}, Z)).data.map((a) => a.kind);
  for (const k of ['recarga_grande', 'recargas_repetidas', 'fuera_de_horario', 'auto_recarga']) assert.ok(kinds.includes(k), k);
  const flagged = (await sup('listRecharges', { only_flagged: true, school_id: s1 }, Z)).data;
  assert.ok(flagged.some((t) => t.id === big.data.transaction_id && /auto_recarga/.test(t.alert_kinds)));
  assert.ok((await sup('flagRecharge', { tx_id: big.data.transaction_id, note: 'revisar' }, Z)).ok);
  const before = S.db.get("SELECT balance_cents FROM cards WHERE uid = '04A1B2C3D4E5F6'").balance_cents;
  assert.equal((await sup('reverseRecharge', { tx_id: big.data.transaction_id }, Z)).status, 400); // motivo obligatorio
  const rv = await sup('reverseRecharge', { tx_id: big.data.transaction_id, reason: 'Auto-recarga no autorizada' }, Z);
  assert.ok(rv.ok, rv.error); assert.equal(rv.data.reversed, true);
  assert.equal(S.db.get("SELECT balance_cents FROM cards WHERE uid = '04A1B2C3D4E5F6'").balance_cents, before - 60000);
  assert.equal(S.db.get('SELECT flag FROM transactions WHERE id = ?', [big.data.transaction_id]).flag, 'revertida');
  assert.equal((await sup('reverseRecharge', { tx_id: big.data.transaction_id, reason: 'otra vez' }, Z)).status, 400);
  // atender alertas
  const open = (await sup('listAlerts', {}, Z)).data.length;
  await sup('ackAlert', { id: (await sup('listAlerts', {}, Z)).data[0].id }, Z);
  assert.equal((await sup('listAlerts', {}, Z)).data.length, open - 1);
  await sup('ackAlert', { id: 0 }, Z);
  assert.equal((await sup('listAlerts', {}, Z)).data.length, 0);
  assert.ok((await sup('listAudit', { category: 'recargas', q: 'zuki' }, Z)).data.length >= 0);
  assert.ok((await sup('listAudit', { category: 'recargas' }, Z)).data.some((a) => a.action === 'recarga' && a.ip));
  await sup('setSchoolSecurity', { school_id: s1, hours_start: '', hours_end: '', large_recharge_cents: null }, Z);
});

test('papelera: borrar producto es lógico y se restaura; respaldo descargable', async () => {
  const A = await tok('admin', 'admin123');
  const p = (await rpc('listProducts', {}, A)).data.find((x) => x.name === 'Mazapán');
  const d = await rpc('deleteProduct', { id: p.id }, A);
  assert.ok(d.ok); assert.equal(d.data.soft, true);
  assert.ok(!(await rpc('listProducts', {}, A)).data.some((x) => x.id === p.id));
  assert.ok(S.db.get('SELECT id FROM products WHERE id = ?', [p.id])); // sigue en la base
  const trash = (await sup('listTrash', {}, Z)).data;
  assert.ok(trash.some((x) => x.id === p.id));
  assert.ok((await sup('listAlerts', {}, Z)).data.some((a) => a.kind === 'borrado'));
  assert.ok((await sup('listAudit', { category: 'borrados' }, Z)).data.some((a) => a.action === 'producto_borrado'));
  assert.ok((await sup('restoreProduct', { id: p.id }, Z)).ok);
  assert.ok((await rpc('listProducts', {}, A)).data.some((x) => x.id === p.id && x.active));
  // respaldo
  const r = await api('/api/super-backup', { token: Z, raw: true });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition'), /respaldo-cooperativa-.*\.db/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.slice(0, 15).toString(), 'SQLite format 3');
  const copy = await openDatabase(null); copy.db.close();
  assert.equal((await api('/api/super-backup', { token: await tok('admin', 'admin123'), raw: true })).status, 403);
});

test('persistencia: modo según entorno y copia en Turso (servidor simulado con SQLite real)', async (t) => {
  assert.equal(persistenceMode({}, '/tmp/servidor.db'), 'temporal');
  assert.equal(persistenceMode({}, '/var/data/servidor.db'), 'disco');
  assert.equal(persistenceMode({ TURSO_DATABASE_URL: 'libsql://x.turso.io', TURSO_AUTH_TOKEN: 't' }, '/tmp/s.db'), 'turso');
  // Servidor falso que implementa /v2/pipeline sobre sql.js
  const remote = await openDatabase(null);
  let calls = 0;
  const fake = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => {
      calls++;
      if (req.headers.authorization !== 'Bearer secreto') { res.writeHead(401); return res.end('no'); }
      const j = JSON.parse(body);
      const results = j.requests.map((r) => {
        if (r.type === 'close') return { type: 'ok', response: { type: 'close' } };
        try {
          const args = r.stmt.args.map((a) => (a.type === 'null' ? null : (a.type === 'integer' ? Number(a.value) : a.value)));
          const st = remote.db.prepare(r.stmt.sql); st.bind(args);
          const cols = st.getColumnNames(); const rows = [];
          while (st.step()) rows.push(st.get().map((v) => (v === null ? { type: 'null' } : (typeof v === 'number' ? { type: 'integer', value: String(v) } : { type: 'text', value: String(v) }))));
          st.free();
          return { type: 'ok', response: { type: 'execute', result: { cols: cols.map((name) => ({ name })), rows } } };
        } catch (e) { return { type: 'error', error: { message: e.message } }; }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ baton: null, results }));
    });
  });
  await new Promise((r) => fake.listen(0, r));
  t.after(() => { fake.closeAllConnections(); fake.close(); });
  const url = `http://127.0.0.1:${fake.address().port}`;
  const store = createTursoStore({ url, token: 'secreto' });
  assert.equal(await store.load(), null);
  const db = await openDatabase(null);
  db.run("INSERT INTO meta (key, value) VALUES ('prueba', ?)", ['x'.repeat(2000000)]); // ~2 MB → varias partes
  const rep = createReplicator(db, store, { debounceMs: 20, log: { error() {} } });
  await rep.flush();
  assert.ok(rep.state.last_ok_at); assert.equal(rep.state.last_error, null);
  db.run("INSERT INTO meta (key, value) VALUES ('otra', 'y')");
  for (let i = 0; i < 100 && (rep.pending() || rep.state.uploads < 2); i++) await new Promise((r) => setTimeout(r, 30));
  const buf = await store.load();
  const back = await openDatabase(null); back.db.close();
  const initSqlJs = require('sql.js'); const SQL = await initSqlJs();
  const restored = new SQL.Database(buf);
  assert.equal(restored.exec("SELECT value FROM meta WHERE key = 'otra'")[0].values[0][0], 'y');
  assert.equal(restored.exec("SELECT length(value) FROM meta WHERE key = 'prueba'")[0].values[0][0], 2000000);
  // solo se conservan la copia actual y la anterior
  assert.ok(remote.get('SELECT COUNT(DISTINCT gen) AS n FROM coop_snapshot_chunks').n <= 2);
  const bad = createTursoStore({ url, token: 'otro' });
  await assert.rejects(() => bad.load(), /401/);
  assert.ok(calls > 3);
});

test('caja sincronizada: recibe las banderas de seguridad y sus recargas generan alertas en el servidor', async () => {
  const { createSyncClient } = require('../src/core/sync-client');
  const { createService } = require('../src/core/service');
  const { seedMinimal } = require('../src/core/seed');
  const created = (await sup('createSchool', { name: 'Escuela Caja', status: 'activa', admin_username: 'admin.caja' }, Z)).data;
  const desk = await openDatabase(null, { syncOutbox: true }); seedMinimal(desk, { password: 'CajaLocal2026' });
  let cfg = {};
  const client = createSyncClient({ db: desk, getConfig: () => cfg });
  const l = await client.linkDevice({ serverUrl: base, username: 'admin.caja', password: created.admin.temporary_password, name: 'Caja 1' });
  cfg = { serverUrl: base, deviceToken: l.deviceToken };
  const svc = createService(desk, { schoolId: 1, singleSchool: true });
  const ad = svc.login('admin', 'CajaLocal2026');
  const kid = svc.createChild(ad, { full_name: 'Niño Caja' });
  svc.registerCard(ad, { uid: '0A0B0C0D0E', child_id: kid.id });
  svc.recharge(ad, { uid: '0A0B0C0D0E', amount_cents: 250000, note: 'grande' });
  await sup('setSchoolSecurity', { school_id: created.school.id, freeze_recharges: true }, Z);
  const st = await client.syncNow();
  assert.equal(st.state, 'ok', st.last_error);
  const flags = JSON.parse(desk.get("SELECT value FROM meta WHERE key = 'server_security'").value);
  assert.equal(flags.freeze_recharges, true);
  assert.match(evaluateFlags(flags, 'recharge', { amount_cents: 100 }), /RECARGAS/);
  const al = (await sup('listAlerts', { school_id: created.school.id }, Z)).data;
  assert.ok(al.some((a) => a.kind === 'recarga_grande'));
  // reversión en escuela con caja: se bloquea la tarjeta y se envía a la caja
  const tx = (await sup('listRecharges', { school_id: created.school.id }, Z)).data[0];
  const rv = await sup('reverseRecharge', { tx_id: tx.id, reason: 'prueba' }, Z);
  assert.equal(rv.data.card_blocked, true);
  await client.syncNow();
  assert.equal(desk.get("SELECT status FROM cards WHERE uid = '0A0B0C0D0E'").status, 'bloqueada');
});
