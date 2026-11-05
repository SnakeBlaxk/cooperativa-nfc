'use strict';
// WhatsApp por WAHA (no Meta): cliente, ajustes, recordatorios de mensualidad, copia de avisos y teléfono del tutor.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { toE164Mx, chatIdFor, paceMs, createWahaClient } = require('../src/core/waha');
const { reminderText, mxParts } = require('../src/core/whatsapp');

const AT_9 = new Date('2026-11-05T15:10:00Z'); // 09:10 en America/Mexico_City
const AT_8 = new Date('2026-11-05T14:10:00Z'); // 08:10

test('E.164 México, chatId 52+10 y pausa entre envíos', () => {
  assert.equal(toE164Mx('443 111 2233'), '+524431112233');
  assert.equal(toE164Mx('+52 443 111 2233'), '+524431112233');
  assert.equal(toE164Mx('5214431112233'), '+524431112233');
  assert.equal(toE164Mx('12'), null);
  assert.equal(toE164Mx('04431112233'), null);
  assert.equal(chatIdFor('+524431112233', {}), '524431112233@c.us');
  assert.equal(chatIdFor('+524431112233', { WAHA_MX_PREFIX: '521' }), '5214431112233@c.us');
  assert.equal(paceMs({}), 30000);
  assert.equal(paceMs({ WAHA_SEND_DELAY_MS: '5000' }), 20000);
  assert.equal(paceMs({ WAHA_SEND_DELAY_MS: '90000' }), 60000);
  assert.equal(paceMs({}, 0), 0);
  assert.equal(mxParts(AT_9).date, '2026-11-05');
  assert.equal(mxParts(AT_9).hour, 9);
  assert.equal(mxParts(AT_8).hour, 8);
  const txt = reminderText({ tutorName: 'Lucía Ramos', childName: 'Ana Ramos', amountCents: 47000, nextDue: '2026-10-01', status: 'vencida', daysLeft: -35, schoolName: 'Cuitswimmer' });
  assert.match(txt, /Lucía/); assert.match(txt, /Ana Ramos/); assert.match(txt, /\$470\.00 MXN/); assert.match(txt, /01\/10\/2026/);
  const otro = reminderText({ tutorName: 'Pedro Solís', childName: 'Leo Solís', amountCents: 33000, nextDue: '2026-11-05', status: 'por_vencer', daysLeft: 0, schoolName: 'Cuitswimmer' });
  assert.notEqual(txt, otro);
});

test('sin WAHA configurado no llama a la red', async () => {
  let called = false;
  const client = createWahaClient({ env: {}, fetchImpl: () => { called = true; } });
  const r = await client.sendText('+524431112233', 'hola');
  assert.equal(r.skipped, true);
  assert.equal(called, false);
  const st = await client.sessionStatus();
  assert.equal(st.status, 'not_configured');
  const S = await createServer({ cardStock: false, jwtSecret: 'z'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, whatsappSweepMs: 0, env: {}, wahaFetch: () => { throw new Error('no debe llamarse'); } });
  const out = await S.whatsapp.runReminders(AT_9);
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'not_configured');
  assert.deepEqual(S.whatsapp.mirrorNotice({ userId: 1, schoolId: 1, kind: 'compra', tag: 'compra-1', title: 't', body: 'b', dedupe: 'compra-1' }), { skipped: true, reason: 'not_configured' });
});

const calls = [];
let sessionStatus = 'WORKING';
let failSend = false;
const env = { WAHA_URL: 'http://waha.internal:3000', WAHA_API_KEY: 'test-key', WAHA_SESSION: 'cuitswimmer', WAHA_DASHBOARD_URL: 'https://waha.example.com/dashboard' };
async function wahaFetch(url, opts) {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url, method: opts && opts.method, headers: opts && opts.headers, body });
  if (String(url).includes('/api/sessions/')) {
    if (sessionStatus === 'missing') return { ok: false, status: 404, text: async () => JSON.stringify({ message: 'no session' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: sessionStatus, me: { pushName: 'Cuitswimmer' } }) };
  }
  if (failSend) return { ok: false, status: 500, text: async () => JSON.stringify({ message: 'session not ready' }) };
  return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'MSG1' }) };
}
let S, srv, base, NAT, ADMIN, CAJERO, MARIA;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const rpc = (m, token, body = {}) => api('/api/rpc/' + m, { token, body });
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });
const sends = () => calls.filter((c) => String(c.url).includes('/api/sendText'));

before(async () => {
  S = await createServer({
    cardStock: false, jwtSecret: 'w'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, whatsappSweepMs: 0,
    env, wahaFetch, wahaDelayMs: 0, pushSender: async () => {},
  });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  const z = (await login('zuki', 'zuki123')).data.access_token;
  const school = await api('/api/super/createSchool', { token: z, body: { name: 'Cuitswimmer Prueba', status: 'prueba', account_type: 'natacion', admin_username: 'cuit.wa' } });
  assert.equal(school.ok, true, school.error);
  NAT = (await login('cuit.wa', school.data.admin.temporary_password)).data.access_token;
  ADMIN = (await login('admin', 'admin123')).data.access_token;
  CAJERO = (await login('cajero', 'cajero123')).data.access_token;
  MARIA = (await login('maria', 'tutor123')).data.access_token;
});
after(() => new Promise((r) => srv.close(r)));

test('ajustes: solo el administrador, hora y pausa', async () => {
  assert.equal((await rpc('waGetSettings', CAJERO)).status, 403);
  let s = await rpc('waGetSettings', NAT);
  assert.equal(s.ok, true, s.error);
  assert.equal(s.data.enabled, false);
  assert.equal(s.data.send_hour, 9);
  assert.equal(s.data.account_type, 'natacion');
  assert.equal(s.data.configured, true);
  assert.equal(s.data.dashboard_url, 'https://waha.example.com/dashboard');
  assert.equal((await rpc('waSetSettings', NAT, { send_hour: 24 })).ok, false);
  s = await rpc('waSetSettings', NAT, { enabled: true, send_hour: 18 });
  assert.equal(s.data.enabled, true); assert.equal(s.data.send_hour, 18);
  const st = await rpc('waStatus', NAT);
  assert.equal(st.data.connection.status, 'WORKING');
  assert.equal(st.data.connection.status_label, 'Conectado');
  assert.ok(st.data.instructions.length >= 5);
  await rpc('waSetSettings', NAT, { enabled: false, send_hour: 9 });
});

test('teléfono del tutor en el perfil del nadador: México, 10 dígitos', async () => {
  const tutor = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Lucía Ramos', phone: '4431002000' } });
  assert.equal(tutor.ok, true, tutor.error);
  const sin = await rpc('createChild', NAT, { full_name: 'Sin Tutor WA', tutor_phone: '4431002099' });
  assert.equal(sin.ok, false);
  const c = await rpc('createChild', NAT, { full_name: 'Ana Ramos', grade: 'Delfines', tutor_id: tutor.data.user.id, tutor_phone: '443 100 2000', tutor_whatsapp: '+52 443 100 2099' });
  assert.equal(c.ok, true, c.error);
  assert.equal(c.data.tutor.phone, '4431002000');
  assert.equal(c.data.tutor.whatsapp, '4431002099');
  assert.equal(c.data.tutor.whatsapp_effective, '4431002099');
  const bad = await rpc('updateChild', NAT, { id: c.data.id, tutor_phone: '12', full_name: 'Ana Ramos' });
  assert.equal(bad.ok, false);
  const still = await rpc('listChildren', NAT);
  assert.equal(still.data.find((k) => k.id === c.data.id).full_name, 'Ana Ramos');
  const ok = await rpc('updateChild', NAT, { id: c.data.id, tutor_phone: '4431002000', tutor_whatsapp: '' });
  assert.equal(ok.data.tutor.phone, '4431002000');
  assert.equal(ok.data.tutor.whatsapp, null);
  assert.equal(ok.data.tutor.whatsapp_effective, '4431002000');
});

test('recordatorios: pausa, hora, vencidas y por vencer, sin repetir el mismo día', async () => {
  const a = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Lucía Ramos Dos', phone: '4431002010' } });
  const b = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Pedro Solís', phone: '4431002011', whatsapp: '4431002012' } });
  const sin = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Sin Teléfono', email: 'sintel-wa@example.com' } });
  assert.equal(a.ok && b.ok && sin.ok, true, (a.error || b.error || sin.error));
  const ana = await rpc('createChild', NAT, { full_name: 'Ana Ramos', tutor_id: a.data.user.id });
  const leo = await rpc('createChild', NAT, { full_name: 'Leo Solís', tutor_id: b.data.user.id });
  const nina = await rpc('createChild', NAT, { full_name: 'Nina Ramos', tutor_id: sin.data.user.id });
  const iris = await rpc('createChild', NAT, { full_name: 'Iris Solís', tutor_id: b.data.user.id });
  await rpc('mensSetPlan', NAT, { child_id: ana.data.id, dias_semana: 2, fecha_inicio: '2026-10-01' });
  await rpc('mensSetPlan', NAT, { child_id: leo.data.id, dias_semana: 1, fecha_inicio: '2026-11-05' });
  await rpc('mensSetPlan', NAT, { child_id: nina.data.id, dias_semana: 3, fecha_inicio: '2026-10-05' });
  await rpc('mensSetPlan', NAT, { child_id: iris.data.id, dias_semana: 1, fecha_inicio: '2026-12-20' });

  calls.length = 0;
  sessionStatus = 'WORKING';
  let r = await S.whatsapp.runReminders(AT_9);
  assert.equal(r.queued, 0, 'pausado no envía');
  assert.equal(sends().length, 0);

  await rpc('waSetSettings', NAT, { enabled: true, send_hour: 18 });
  r = await S.whatsapp.runReminders(AT_9);
  assert.equal(r.queued, 0);
  assert.equal(sends().length, 0, 'otra hora no envía');

  sessionStatus = 'SCAN_QR_CODE';
  await rpc('waSetSettings', NAT, { enabled: true, send_hour: 9 });
  r = await S.whatsapp.runReminders(AT_9);
  assert.equal(r.queued, 0);
  assert.equal(sends().length, 0, 'sin QR no marca el día');
  const settings = await rpc('waGetSettings', NAT);
  assert.equal(settings.data.last_run_on, null);

  sessionStatus = 'WORKING';
  calls.length = 0;
  r = await S.whatsapp.runReminders(AT_9);
  assert.equal(r.queued, 2, JSON.stringify(r));
  assert.ok(r.sin_telefono >= 1);
  const texts = sends().map((c) => c.body.text);
  assert.equal(sends().length, 2);
  assert.ok(texts.some((t) => /Lucía/.test(t) && /Ana Ramos/.test(t) && /\$470\.00 MXN/.test(t) && /venció/.test(t)));
  assert.ok(texts.some((t) => /Pedro/.test(t) && /Leo Solís/.test(t) && /\$330\.00 MXN/.test(t) && /vence hoy/.test(t)));
  assert.ok(!texts.some((t) => /Iris/.test(t)));
  assert.ok(!texts.some((t) => /Nina/.test(t)));
  for (const c of sends()) {
    assert.equal(c.body.session, 'cuitswimmer');
    assert.equal(c.headers['X-Api-Key'], 'test-key');
    assert.equal(c.url, 'http://waha.internal:3000/api/sendText');
    assert.match(c.body.chatId, /^52\d{10}@c\.us$/);
  }
  assert.ok(sends().some((c) => c.body.chatId === '524431002010@c.us'));
  assert.ok(sends().some((c) => c.body.chatId === '524431002012@c.us'), 'usa el WhatsApp si es distinto del teléfono');

  const n = sends().length;
  r = await S.whatsapp.runReminders(AT_9);
  assert.equal(r.queued, 0);
  assert.equal(sends().length, n, 'no repite el mismo día');
  const sid = S.db.get("SELECT id FROM schools WHERE name = 'Cuitswimmer Prueba'").id;
  const forced = await S.whatsapp.runReminders(AT_9, { force: true, schoolId: sid });
  assert.equal(forced.queued, 0);
  assert.equal(sends().length, n);
  // El botón "enviar hoy" usa el día real: si ese día ya quedó marcado, no manda otra vez.
  const hoy = S.whatsapp.mxParts(new Date()).date;
  S.db.run('UPDATE whatsapp_settings SET last_run_on = ? WHERE school_id = ?', [hoy, sid]);
  const again = await rpc('waRunNow', NAT);
  assert.equal(again.ok, true, again.error);
  assert.equal(again.data.queued, 0);
  assert.equal(sends().length, n);
});

test('la copia de avisos (compra, bloqueo, saldo) sale por WhatsApp y respeta la pausa', async () => {
  await rpc('setPushPrefs', MARIA, { purchases: true, rejected: true, low_balance: false });
  calls.length = 0;
  const sofia = S.db.get("SELECT id FROM children WHERE full_name = 'Sofía Hernández'");
  const gomitas = S.db.get("SELECT id FROM products WHERE name = 'Gomitas' AND school_id = 1");
  let p = await rpc('purchase', CAJERO, { uid: '04A1B2C3D4E5F6', items: [{ product_id: gomitas.id, qty: 1 }] });
  assert.equal(p.data.ok, true, p.data && p.data.reason);
  await S.push.idle(); await S.whatsapp.idle();
  assert.equal(sends().length, 0, 'escuela sin activar no copia el aviso');

  await rpc('waSetSettings', ADMIN, { enabled: true, send_hour: 9 });
  calls.length = 0;
  p = await rpc('purchase', CAJERO, { uid: '04A1B2C3D4E5F6', items: [{ product_id: gomitas.id, qty: 1 }] });
  assert.equal(p.data.ok, true, p.data && p.data.reason);
  await S.push.idle(); await S.whatsapp.idle();
  assert.equal(sends().length, 1);
  assert.match(sends()[0].body.text, /María/);
  assert.match(sends()[0].body.text, /Sofía/);
  assert.equal(sends()[0].body.chatId, '524431234567@c.us');

  await rpc('setCardStatus', MARIA, { card_id: S.db.get("SELECT id FROM cards WHERE uid = '04A1B2C3D4E5F6'").id, status: 'bloqueada' });
  calls.length = 0;
  p = await rpc('purchase', CAJERO, { uid: '04A1B2C3D4E5F6', items: [{ product_id: gomitas.id, qty: 1 }] });
  assert.equal(p.data.ok, false);
  await S.push.idle(); await S.whatsapp.idle();
  assert.equal(sends().length, 1);
  assert.match(sends()[0].body.text, /María/);
  assert.match(sends()[0].body.text, /bloqueada/i);

  await rpc('waSetSettings', ADMIN, { enabled: false, send_hour: 9 });
  calls.length = 0;
  await rpc('setCardStatus', MARIA, { card_id: S.db.get("SELECT id FROM cards WHERE uid = '04A1B2C3D4E5F6'").id, status: 'activa' });
  p = await rpc('purchase', CAJERO, { uid: '04A1B2C3D4E5F6', items: [{ product_id: gomitas.id, qty: 1 }] });
  assert.equal(p.data.ok, true, p.data && p.data.reason);
  await S.push.idle(); await S.whatsapp.idle();
  assert.equal(sends().length, 0, 'en pausa no copia');
  assert.ok(sofia);
});

test('si WAHA rechaza el envío queda el error y no se reintenta ese día', async () => {
  failSend = true;
  sessionStatus = 'WORKING';
  await rpc('waSetSettings', NAT, { enabled: true, send_hour: 9 });
  const sid = S.db.get("SELECT id FROM schools WHERE name = 'Cuitswimmer Prueba'").id;
  S.db.run('UPDATE whatsapp_settings SET last_run_on = NULL WHERE school_id = ?', [sid]);
  const day = new Date('2026-12-01T15:10:00Z');
  calls.length = 0;
  const r = await S.whatsapp.runReminders(day);
  assert.equal(r.queued, 2);
  await S.whatsapp.idle();
  const errs = S.db.all("SELECT status, error FROM whatsapp_log WHERE kind = 'mensualidad' AND status = 'error'");
  assert.ok(errs.length >= 2);
  assert.match(errs[0].error, /session not ready/);
  const n = sends().length;
  await S.whatsapp.runReminders(day);
  assert.equal(sends().length, n);
  failSend = false;
});

test('mensaje de prueba y separación entre envíos', async () => {
  const gaps = [];
  let clock = 1000;
  const localCalls = [];
  const S2 = await createServer({
    cardStock: false, jwtSecret: 'p'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, whatsappSweepMs: 0,
    env, pushSender: async () => {}, wahaDelayMs: 25000,
    wahaNowMs: () => clock,
    wahaSleep: async (ms) => { gaps.push(ms); clock += ms; },
    wahaFetch: async (url, opts) => {
      localCalls.push(opts && opts.body ? JSON.parse(opts.body) : null);
      if (String(url).includes('/api/sessions/')) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'WORKING' }) };
      return { ok: true, status: 201, text: async () => JSON.stringify({ id: 'ok' }) };
    },
  });
  const z = S2.svc.login('zuki', 'zuki123');
  const made = S2.platform.createSchool(z, { name: 'Pace', status: 'prueba', account_type: 'natacion', admin_username: 'pace.admin' });
  const admin = S2.svc.login('pace.admin', made.admin.temporary_password);
  const t1 = S2.svc.createUser(admin, { role: 'tutor', username: 'pace.lucia', password: 'tutor1234', full_name: 'Lucía Ramos', phone: '4432001000' });
  const t2 = S2.svc.createUser(admin, { role: 'tutor', username: 'pace.pedro', password: 'tutor1234', full_name: 'Pedro Solís', phone: '4432001001' });
  const c1 = S2.svc.createChild(admin, { full_name: 'Ana Pace', tutor_id: t1.id });
  const c2 = S2.svc.createChild(admin, { full_name: 'Leo Pace', tutor_id: t2.id });
  S2.svc.mensSetPlan(admin, { child_id: c1.id, dias_semana: 2, fecha_inicio: '2026-10-01' });
  S2.svc.mensSetPlan(admin, { child_id: c2.id, dias_semana: 1, fecha_inicio: '2026-11-06' });
  S2.whatsapp.methods.waSetSettings(admin, { enabled: true, send_hour: 9 });
  const out = await S2.whatsapp.runReminders(new Date('2026-11-06T15:00:00Z'));
  assert.equal(out.queued, 2);
  const texts = localCalls.filter(Boolean).map((b) => b.text);
  assert.equal(texts.length, 2);
  assert.notEqual(texts[0], texts[1]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0], 25000);
  const prueba = await S2.whatsapp.methods.waSendTest(admin, { phone: '4432001099' });
  assert.equal(prueba.status, 'enviado');
  await assert.rejects(() => S2.whatsapp.methods.waSendTest(admin, { phone: '4432001099' }), (e) => e.code === 'LIMITE');
});
