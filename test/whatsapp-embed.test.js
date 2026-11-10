'use strict';
// WhatsApp dentro del mismo servidor: vincular por QR/código desde la app, avisos generales,
// respaldo cifrado de la sesión y el supervisor que arranca Zuki Pay + WAHA.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { createWahaClient } = require('../src/core/waha');
const { createTursoStore } = require('../server/persist');
const { createSessionBackup, packDir, unpackTo, encrypt, decrypt, backupKey } = require('../server/waha-session-backup');

// ----- WAHA falso con estados -----
const W = { status: 'missing', calls: [], failSend: false };
async function wahaFetch(url, opts = {}) {
  const u = new URL(url);
  const body = opts.body ? JSON.parse(opts.body) : null;
  W.calls.push({ path: u.pathname + u.search, method: opts.method || 'GET', body, key: opts.headers && opts.headers['X-Api-Key'] });
  const ok = (data, status = 200) => ({ ok: true, status, text: async () => JSON.stringify(data) });
  const p = u.pathname;
  if (p === '/api/sessions/default' && (opts.method || 'GET') === 'GET') {
    if (W.status === 'missing') return { ok: false, status: 404, text: async () => '{"message":"not found"}' };
    return ok({ status: W.status, me: W.status === 'WORKING' ? { pushName: 'Cuitswimmer', id: '524431234567@c.us' } : null });
  }
  if (p === '/api/sessions' && opts.method === 'POST') { W.status = 'SCAN_QR_CODE'; return ok({ name: body.name, status: 'STARTING' }, 201); }
  if (p === '/api/sessions/default/start') { W.status = 'SCAN_QR_CODE'; return ok({ status: 'STARTING' }, 201); }
  if (p === '/api/sessions/default/logout') { W.status = 'STOPPED'; return ok({}, 201); }
  if (p === '/api/default/auth/qr') return ok({ mimetype: 'image/png', data: Buffer.from('PNGDATA').toString('base64') });
  if (p === '/api/default/auth/request-code') return ok({ code: 'ABCD-1234' });
  if (p === '/api/sendText') return W.failSend ? { ok: false, status: 500, text: async () => '{"message":"boom"}' } : ok({ id: 'M' + W.calls.length }, 201);
  return { ok: false, status: 404, text: async () => '{}' };
}

test('cliente WAHA: crear/arrancar sesión, QR, código y desvincular', async () => {
  W.status = 'missing'; W.calls.length = 0;
  const c = createWahaClient({ env: { WAHA_URL: 'http://127.0.0.1:3001', WAHA_API_KEY: 'k' }, fetchImpl: wahaFetch });
  const s = await c.startSession();
  assert.equal(s.ok, true);
  assert.deepEqual(W.calls.find((x) => x.path === '/api/sessions').body, { name: 'default', start: true });
  assert.ok(W.calls.every((x) => x.key === 'k'));
  const q = await c.getQr();
  assert.equal(q.ok, true);
  assert.equal(q.image, 'data:image/png;base64,' + Buffer.from('PNGDATA').toString('base64'));
  assert.equal(W.calls.at(-1).path, '/api/default/auth/qr?format=image');
  const code = await c.requestCode('+524431234567');
  assert.equal(code.code, 'ABCD-1234');
  assert.deepEqual(W.calls.at(-1).body, { phoneNumber: '524431234567' });
  W.status = 'STOPPED';
  await c.startSession();
  assert.equal(W.calls.at(-1).path, '/api/sessions/default/start');
  assert.equal((await c.logout()).ok, true);
  assert.equal(createWahaClient({ env: { WAHA_DASHBOARD_URL: 'http://inseguro' } }).dashboardUrl(), null);
});

let S, srv, base, NAT, ADMIN, CAJERO, Z;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const rpc = (m, token, body = {}) => api('/api/rpc/' + m, { token, body });
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });
const sends = () => W.calls.filter((c) => c.path === '/api/sendText');

before(async () => {
  S = await createServer({
    cardStock: false, jwtSecret: 'e'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, whatsappSweepMs: 0,
    env: { WAHA_URL: 'http://127.0.0.1:3001', WAHA_API_KEY: 'k' }, wahaFetch, wahaDelayMs: 0, pushSender: async () => {},
  });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  Z = (await login('zuki', 'zuki123')).data.access_token;
  const school = await api('/api/super/createSchool', { token: Z, body: { name: 'Cuitswimmer', status: 'prueba', account_type: 'natacion', admin_username: 'cuit.embed' } });
  assert.equal(school.ok, true, school.error);
  NAT = (await login('cuit.embed', school.data.admin.temporary_password)).data.access_token;
  ADMIN = (await login('admin', 'admin123')).data.access_token;
  CAJERO = (await login('cajero', 'cajero123')).data.access_token;
});
after(() => new Promise((r) => srv.close(r)));

test('vincular desde la app: QR y código; solo academia o superadministrador', async () => {
  W.status = 'missing';
  let st = await rpc('waStatus', NAT);
  assert.equal(st.ok, true, st.error);
  assert.equal(st.data.can_link, true);
  assert.equal(st.data.connection.status_label, 'Sin vincular');
  // Escuela normal (tiendita) y cajero no pueden tocar el número compartido
  assert.equal((await rpc('waStatus', ADMIN)).data.can_link, false);
  assert.equal((await rpc('waLink', ADMIN)).status, 403);
  assert.equal((await rpc('waLink', CAJERO)).status, 403);
  assert.equal((await rpc('waQr', NAT)).data.image, null); // todavía no hay sesión
  const l = await rpc('waLink', NAT);
  assert.equal(l.ok, true, l.error);
  const q = await rpc('waQr', NAT);
  assert.equal(q.data.status, 'SCAN_QR_CODE');
  assert.match(q.data.image, /^data:image\/png;base64,/);
  assert.equal((await rpc('waPairCode', NAT, { phone: '12' })).ok, false);
  const pc = await rpc('waPairCode', NAT, { phone: '443 123 4567' });
  assert.equal(pc.data.code, 'ABCD-1234');
  // Superadministrador por /api/super-wa
  const sw = await api('/api/super-wa/waSession', { token: Z, body: {} });
  assert.equal(sw.ok, true, sw.error);
  assert.equal(sw.data.can_link, true);
  assert.equal((await api('/api/super-wa/waBroadcast', { token: Z, body: {} })).status, 404);
  assert.equal((await api('/api/super-wa/waSession', { token: NAT, body: {} })).status, 403);
  W.status = 'WORKING';
  st = await rpc('waStatus', NAT);
  assert.equal(st.data.connection.status_label, 'Conectado');
  const un = await rpc('waUnlink', NAT);
  assert.equal(un.ok, true);
  assert.equal(W.status, 'STOPPED');
});

test('WAHA_LINK_SCHOOL_IDS decide qué escuela puede vincular', async () => {
  const S2 = await createServer({ cardStock: false, jwtSecret: 'f'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, whatsappSweepMs: 0,
    env: { WAHA_URL: 'http://127.0.0.1:3001', WAHA_API_KEY: 'k', WAHA_LINK_SCHOOL_IDS: '1' }, wahaFetch, wahaDelayMs: 0 });
  const admin = S2.db.get("SELECT id, role, school_id FROM users WHERE username = 'admin'");
  assert.equal(admin.school_id, 1);
  const r = await S2.whatsapp.methods.waSession({ ...admin });
  assert.equal(r.can_link, true);
});

test('aviso general: confirmación, uno por número, con nombre y registro', async () => {
  W.status = 'WORKING'; W.calls.length = 0;
  const t1 = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Lucía Ramos', phone: '4431002000' } });
  const t2 = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Pedro Solís', phone: '4431002001', whatsapp: '4431002002' } });
  const t3 = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Sin Teléfono', email: 'sintel@example.com' } });
  const t4 = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Mamá de Lucía', phone: '4431002010', whatsapp: '4431002000' } });
  for (const t of [t1, t2, t3, t4]) assert.equal(t.ok, true, t.error);
  const p = await rpc('waBroadcastPreview', NAT);
  assert.deepEqual({ con: p.data.con_telefono, sin: p.data.sin_telefono }, { con: 2, sin: 1 });
  assert.equal((await rpc('waBroadcast', CAJERO, { text: 'Hola a todos', confirm: true })).status, 403);
  assert.equal((await rpc('waBroadcast', NAT, { text: 'Sábado sin clases' })).ok, false); // sin confirmar
  assert.equal((await rpc('waBroadcast', NAT, { text: 'x', confirm: true })).ok, false);
  assert.equal((await rpc('waBroadcast', NAT, { text: 'y'.repeat(1001), confirm: true })).ok, false);
  W.status = 'SCAN_QR_CODE';
  assert.equal((await rpc('waBroadcast', NAT, { text: 'Sábado sin clases', confirm: true })).ok, false); // no conectado
  W.status = 'WORKING';
  const r = await rpc('waBroadcast', NAT, { text: 'Sábado sin clases por mantenimiento.', confirm: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.queued, 2);
  await S.whatsapp.idle();
  const s = sends();
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => x.body.chatId).sort(), ['524431002000@c.us', '524431002002@c.us']);
  assert.ok(s.some((x) => x.body.text === 'Hola Lucía. Sábado sin clases por mantenimiento.'));
  assert.ok(s.some((x) => x.body.text.startsWith('Hola Pedro. ')));
  assert.equal((await rpc('waBroadcast', NAT, { text: 'Sábado sin clases por mantenimiento.', confirm: true })).ok, false); // repetido
  W.failSend = true;
  const r2 = await rpc('waBroadcast', NAT, { text: 'Otro aviso distinto.', confirm: true });
  await S.whatsapp.idle();
  W.failSend = false;
  const st = await rpc('waStatus', NAT);
  const [last, first] = st.data.broadcasts;
  assert.equal(last.id, r2.data.broadcast_id);
  assert.deepEqual({ e: last.enviados, f: last.fallidos, t: last.total }, { e: 0, f: 2, t: 2 });
  assert.deepEqual({ e: first.enviados, f: first.fallidos, t: first.total }, { e: 2, f: 0, t: 2 });
  assert.ok(st.data.recent.some((x) => x.kind_label === 'Aviso general' && x.status === 'enviado'));
});

// ----- Respaldo de la sesión -----
function tmpdir(n) { return fs.mkdtempSync(path.join(os.tmpdir(), n)); }

test('respaldo de sesión: SQLite en uso, cifrado y restauración', async () => {
  const dir = tmpdir('sess-');
  fs.mkdirSync(path.join(dir, 'gows', 'default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gows', 'default', 'config.json'), '{"a":1}');
  const { DatabaseSync } = require('node:sqlite');
  const live = new DatabaseSync(path.join(dir, 'gows', 'default', 'store.sqlite3'));
  live.exec("PRAGMA journal_mode=WAL; CREATE TABLE k (v TEXT); INSERT INTO k VALUES ('llave-1');");
  live.exec("INSERT INTO k VALUES ('llave-2')"); // queda en el WAL, la base sigue abierta
  assert.ok(fs.existsSync(path.join(dir, 'gows', 'default', 'store.sqlite3-wal')));
  const gz = await packDir(dir);
  const env = { WAHA_API_KEY: 'secreto' };
  const blob = encrypt(gz, backupKey(env));
  assert.ok(!blob.includes(Buffer.from('llave-1')));
  assert.throws(() => decrypt(blob, backupKey({ WAHA_API_KEY: 'otra' })));
  const out = tmpdir('rest-');
  assert.equal(unpackTo(decrypt(blob, backupKey(env)), out), 2);
  assert.ok(!fs.existsSync(path.join(out, 'gows', 'default', 'store.sqlite3-wal')));
  const copy = new DatabaseSync(path.join(out, 'gows', 'default', 'store.sqlite3'));
  assert.deepEqual(copy.prepare('SELECT v FROM k ORDER BY v').all().map((r) => r.v), ['llave-1', 'llave-2']);
  copy.close(); live.close();
  assert.equal(fs.readFileSync(path.join(out, 'gows', 'default', 'config.json'), 'utf8'), '{"a":1}');
  // Ruta maliciosa dentro de la copia
  const zlib = require('zlib');
  const evil = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, files: [{ p: '../../x', d: '' }] })));
  assert.throws(() => unpackTo(evil, tmpdir('evil-')), /ruta inválida/);
  // Con una tienda en memoria: guarda y restaura solo si la carpeta está vacía
  let saved = null;
  const store = { save: async (b) => { saved = b; return { bytes: b.length }; }, load: async () => saved };
  const bk = createSessionBackup({ dir, store, env, log: { log() {}, error() {} } });
  assert.equal((await bk.save()).saved, true);
  const target = tmpdir('target-');
  const bk2 = createSessionBackup({ dir: target, store, env, log: { log() {}, error() {} } });
  assert.equal((await bk2.restore()).restored, true);
  assert.equal((await bk2.restore()).reason, 'ya_hay_sesion');
  assert.equal(createSessionBackup({ dir, store: null, env }).enabled, false);
  assert.equal(createSessionBackup({ dir, store, env: {} }).enabled, false);
});

test('Turso: la sesión usa sus propias tablas', async () => {
  const sqls = [];
  const fetchImpl = async (url, o) => {
    const reqs = JSON.parse(o.body).requests.filter((r) => r.type === 'execute');
    for (const r of reqs) sqls.push(r.stmt.sql);
    return { ok: true, json: async () => ({ results: reqs.map(() => ({ type: 'ok', response: { result: { cols: [{ name: 'gen' }], rows: [] } } })) }) };
  };
  const st = createTursoStore({ url: 'libsql://x.turso.io', token: 't', fetchImpl, prefix: 'waha_session' });
  await st.save(Buffer.from('hola'));
  assert.ok(sqls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS waha_session_chunks')));
  assert.ok(sqls.some((s) => s.includes('INSERT INTO waha_session_chunks')));
  assert.ok(!sqls.some((s) => s.includes('coop_snapshot')));
  const def = createTursoStore({ url: 'libsql://x.turso.io', token: 't', fetchImpl });
  assert.equal(def.prefix, 'coop_snapshot');
});

// ----- Supervisor (server/start.js) con un WAHA falso -----
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function startSupervisor(appPort, wahaPort, tmp, outFile, extra = {}) {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server', 'start.js')], {
    env: { PATH: process.env.PATH, PORT: String(appPort), WAHA_INTERNAL_PORT: String(wahaPort), WAHA_API_KEY: 'clave-prueba',
      WAHA_ENTRYPOINT: path.join(__dirname, 'fixtures', 'fake-waha.js'), WAHA_APP_DIR: tmp, WAHA_LOCAL_STORE_BASE_DIR: path.join(tmp, 'sessions'),
      DB_PATH: path.join(tmp, 'db', 'servidor.db'), JWT_SECRET: 'j'.repeat(40), SEED: '1', FAKE_WAHA_OUT: outFile, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
const waitUntil = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 200)); } throw new Error('tiempo agotado'); };

test('supervisor: Zuki Pay en PORT, WAHA solo en 127.0.0.1, reinicio de WAHA y apagado limpio', async () => {
  const [appPort, wahaPort] = [await freePort(), await freePort()];
  const tmp = tmpdir('sup-');
  const outFile = path.join(tmp, 'waha.jsonl');
  const child = startSupervisor(appPort, wahaPort, tmp, outFile);
  let logs = ''; child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  try {
    await waitUntil(async () => (await fetch(`http://127.0.0.1:${appPort}/api/health`).catch(() => null))?.ok);
    const first = await waitUntil(() => fs.existsSync(outFile) && JSON.parse(fs.readFileSync(outFile, 'utf8').trim().split('\n')[0]));
    assert.equal(first.port, String(wahaPort));
    assert.equal(first.address, '127.0.0.1');
    assert.equal(first.hasJwt, false);
    assert.equal(first.dashboard, 'false');
    assert.equal(first.engine, 'GOWS');
    assert.match(first.nodeOptions, /--max-old-space-size=160 --max-semi-space-size=1/);
    // La app habla con WAHA en 127.0.0.1 sin que se ponga WAHA_URL a mano
    const tok = (await (await fetch(`http://127.0.0.1:${appPort}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: 'admin', password: 'admin123' }) })).json()).data.access_token;
    const st = await (await fetch(`http://127.0.0.1:${appPort}/api/rpc/waStatus`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: '{}' })).json();
    assert.equal(st.data.connection.status, 'WORKING', JSON.stringify(st));
    // Si WAHA muere, se reinicia solo y Zuki Pay sigue arriba
    process.kill(first.pid, 'SIGKILL');
    const second = await waitUntil(() => { const l = fs.readFileSync(outFile, 'utf8').trim().split('\n'); return l.length >= 2 && JSON.parse(l[1]); }, 30000);
    assert.notEqual(second.pid, first.pid);
    assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok, true);
    const code = await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
    assert.equal(code, 0, logs);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('supervisor: si la memoria pasa el límite se reinicia solo WAHA', async () => {
  const [appPort, wahaPort] = [await freePort(), await freePort()];
  const tmp = tmpdir('mem-');
  const outFile = path.join(tmp, 'waha.jsonl');
  const child = startSupervisor(appPort, wahaPort, tmp, outFile, { WAHA_MEM_RESTART_MB: '1', MEM_CHECK_EVERY_MS: '700', WAHA_MEM_MIN_UPTIME_MS: '1000' });
  let logs = ''; child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  try {
    await waitUntil(() => fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').trim().split('\n').length >= 2, 30000);
    assert.match(logs, /se reinicia WAHA para proteger los cobros/);
    assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok, true);
    const code = await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
    assert.equal(code, 0, logs);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('supervisor: la vigilancia usa la memoria del cgroup (como Render), no la suma de RSS', async () => {
  const [appPort, wahaPort] = [await freePort(), await freePort()];
  const tmp = tmpdir('cg-');
  const outFile = path.join(tmp, 'waha.jsonl');
  const cg = path.join(tmp, 'cgroup'); fs.mkdirSync(cg);
  // 700 MB usados, 300 MB de caché inactiva → 400 MB reales: por debajo de 490, no reinicia.
  fs.writeFileSync(path.join(cg, 'memory.current'), String(700 * 1048576));
  fs.writeFileSync(path.join(cg, 'memory.stat'), `anon 1\ninactive_file ${300 * 1048576}\nactive_file 5\n`);
  const child = startSupervisor(appPort, wahaPort, tmp, outFile, { CGROUP_ROOT: cg, MEM_CHECK_EVERY_MS: '300', WAHA_MEM_MIN_UPTIME_MS: '500' });
  let logs = ''; child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  try {
    await waitUntil(() => /\[memoria\] Contenedor ≈ 400 MB .*cgroup/.test(logs), 30000);
    assert.doesNotMatch(logs, /se reinicia WAHA/);
    // Sin caché inactiva → 700 MB reales: ahora sí reinicia solo WAHA.
    fs.writeFileSync(path.join(cg, 'memory.stat'), 'inactive_file 0\n');
    await waitUntil(() => /700 MB > 490 MB: se reinicia WAHA/.test(logs), 30000);
    assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok, true);
    const code = await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
    assert.equal(code, 0, logs);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('supervisor: reinicio nocturno preventivo de WAHA (una vez por día, hora CDMX)', async () => {
  const [appPort, wahaPort] = [await freePort(), await freePort()];
  const tmp = tmpdir('night-');
  const outFile = path.join(tmp, 'waha.jsonl');
  const hour = String(Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mexico_City', hour: 'numeric', hourCycle: 'h23' }).format(new Date())));
  const child = startSupervisor(appPort, wahaPort, tmp, outFile, { WAHA_NIGHTLY_HOUR: hour, WAHA_NIGHTLY_MIN_UPTIME_MS: '1500', WAHA_SESSION_CHECK_MS: '400' });
  let logs = ''; child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  try {
    await waitUntil(() => fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').trim().split('\n').length >= 2, 30000);
    assert.match(logs, /Reinicio preventivo de WAHA \(mantenimiento nocturno/);
    assert.match(logs, /WAHA reiniciado \(mantenimiento nocturno\)/);
    // Solo una vez por día
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal(fs.readFileSync(outFile, 'utf8').trim().split('\n').length, 2);
    assert.equal((await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok, true);
    const code = await new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); });
    assert.equal(code, 0, logs);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('cliente WAHA: si WAHA no responde («fetch failed»), mensaje claro en español', async () => {
  const c = createWahaClient({ env: { WAHA_URL: 'http://127.0.0.1:3001', WAHA_API_KEY: 'k' }, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const r = await c.sendText('+524431112233', 'hola');
  assert.equal(r.ok, false);
  assert.match(r.error, /se está reiniciando/);
  assert.doesNotMatch(r.error, /fetch failed/);
  const st = await c.sessionStatus();
  assert.equal(st.status, 'unreachable');
});
