'use strict';
// Móviles de México: WhatsApp puede registrar el número como 52XXXXXXXXXX o 521XXXXXXXXXX.
// Antes de enviar se consulta check-exists y se usa el chatId que devuelve WAHA.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createWahaClient } = require('../src/core/waha');

const env = { WAHA_URL: 'http://127.0.0.1:3001', WAHA_API_KEY: 'k' };
function fakeWaha({ registered = {}, checkStatus = 200, sendError = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url); const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), body });
    const res = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
    if (u.pathname === '/api/contacts/check-exists') {
      if (checkStatus !== 200) return res(checkStatus, { message: 'nope' });
      const phone = u.searchParams.get('phone');
      return registered[phone] ? res(200, { numberExists: true, chatId: registered[phone] }) : res(200, { numberExists: false, chatId: null });
    }
    if (u.pathname === '/api/sendText') {
      if (sendError[body.chatId]) return res(500, { message: sendError[body.chatId] });
      return res(201, { id: 'MSG-' + body.chatId });
    }
    return res(404, {});
  };
  return { calls, fetchImpl, sends: () => calls.filter((c) => c.path === '/api/sendText') };
}

test('número registrado como 521: se prueba 52, luego 521, y se envía al chatId devuelto', async () => {
  const W = fakeWaha({ registered: { '5215658629519': '5215658629519@c.us' } });
  const c = createWahaClient({ env, fetchImpl: W.fetchImpl });
  const r = await c.sendText('+525658629519', 'hola');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.chatId, '5215658629519@c.us');
  const checks = W.calls.filter((x) => x.path === '/api/contacts/check-exists');
  assert.deepEqual(checks.map((x) => x.q.phone), ['525658629519', '5215658629519']);
  assert.equal(checks[0].q.session, 'default');
  assert.equal(W.sends().length, 1);
  // Segunda vez usa la caché: no vuelve a consultar
  await c.sendText('5658629519', 'otra');
  assert.equal(W.calls.filter((x) => x.path === '/api/contacts/check-exists').length, 2);
  assert.equal(W.sends()[1].body.chatId, '5215658629519@c.us');
});

test('número registrado como 52 o con @lid: usa el chatId devuelto tal cual', async () => {
  const W = fakeWaha({ registered: { '524431112233': '123456789012345@lid' } });
  const c = createWahaClient({ env, fetchImpl: W.fetchImpl });
  const r = await c.sendText('+524431112233', 'hola');
  assert.equal(r.ok, true);
  assert.equal(W.sends()[0].body.chatId, '123456789012345@lid');
  assert.equal(W.calls.filter((x) => x.path === '/api/contacts/check-exists').length, 1);
});

test('número sin WhatsApp: no envía y da un error claro en español', async () => {
  const W = fakeWaha({ registered: {} });
  const c = createWahaClient({ env, fetchImpl: W.fetchImpl });
  const r = await c.sendText('+524431112233', 'hola');
  assert.equal(r.ok, false);
  assert.equal(r.notOnWhatsapp, true);
  assert.match(r.error, /no tiene WhatsApp/);
  assert.match(r.error, /52 y 521/);
  assert.equal(W.sends().length, 0);
});

test('WAHA sin check-exists (404): envía como antes y, si dice "no LID", reintenta con 521', async () => {
  const W = fakeWaha({ checkStatus: 404, sendError: { '525658629519@c.us': '2 UNKNOWN: recipient is not on WhatsApp: no LID found for 525658629519@s.whatsapp.net from server' } });
  const c = createWahaClient({ env, fetchImpl: W.fetchImpl });
  const r = await c.sendText('+525658629519', 'hola');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(W.sends().map((s) => s.body.chatId), ['525658629519@c.us', '5215658629519@c.us']);
});

test('WAHA_MX_PREFIX=521 consulta primero 521', async () => {
  const W = fakeWaha({ registered: { '5215658629519': '5215658629519@c.us' } });
  const c = createWahaClient({ env: { ...env, WAHA_MX_PREFIX: '521' }, fetchImpl: W.fetchImpl });
  await c.sendText('+525658629519', 'hola');
  assert.deepEqual(W.calls.filter((x) => x.path === '/api/contacts/check-exists').map((x) => x.q.phone), ['5215658629519']);
});

test('mensaje de prueba: usa el chatId 521 y una prueba fallida se puede reintentar en la misma hora', async () => {
  const { createServer } = require('../server/app');
  const { consoleMailer } = require('../src/core/auth');
  let exists = false; const sent = [];
  const S = await createServer({
    cardStock: false, jwtSecret: 'j'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, whatsappSweepMs: 0,
    env: { ...env, WAHA_SESSION: 'default' }, pushSender: async () => {}, wahaDelayMs: 0,
    wahaFetch: async (url, opts = {}) => {
      const u = new URL(url); const res = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
      if (u.pathname.startsWith('/api/sessions/')) return res(200, { status: 'WORKING' });
      if (u.pathname === '/api/contacts/check-exists') {
        return res(200, exists && u.searchParams.get('phone') === '5215658629519' ? { numberExists: true, chatId: '5215658629519@c.us' } : { numberExists: false });
      }
      if (u.pathname === '/api/sendText') { sent.push(JSON.parse(opts.body).chatId); return res(201, { id: 'ok' }); }
      return res(404, {});
    },
  });
  const z = S.svc.login('zuki', 'zuki123');
  const made = S.platform.createSchool(z, { name: 'JID', status: 'prueba', account_type: 'natacion', admin_username: 'jid.admin' });
  const admin = S.svc.login('jid.admin', made.admin.temporary_password);
  const first = await S.whatsapp.methods.waSendTest(admin, { phone: '5658629519' });
  assert.equal(first.status, 'error');
  assert.match(first.error, /no tiene WhatsApp/);
  assert.equal(sent.length, 0);
  exists = true;
  const second = await S.whatsapp.methods.waSendTest(admin, { phone: '5658629519' });
  assert.equal(second.status, 'enviado', JSON.stringify(second));
  assert.deepEqual(sent, ['5215658629519@c.us']);
  await assert.rejects(() => S.whatsapp.methods.waSendTest(admin, { phone: '5658629519' }), (e) => e.code === 'LIMITE');
});

test('error 463 (reach-out timelock): mensaje claro en español y estado del límite', async () => {
  const W = fakeWaha({ registered: { '524439904367': '524439904367@c.us' }, sendError: { '524439904367@c.us': '2 UNKNOWN: server returned error 463' } });
  const c = createWahaClient({ env, fetchImpl: W.fetchImpl });
  const r = await c.sendText('+524439904367', 'hola');
  assert.equal(r.ok, false); assert.equal(r.reachout, true);
  assert.match(r.error, /WhatsApp bloqueó el primer mensaje a este número \(error 463\)/);
  assert.match(r.error, /«Hola»/);
  assert.equal(W.sends().length, 1, 'no reintenta con otro prefijo');
  // Estado de la sesión con límite activo
  const st = createWahaClient({ env, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'WORKING', me: { id: '1@c.us', reachoutTimelock: { isActive: true, timeEnforcementEnds: 1784477333 } } }) }) });
  const s = await st.sessionStatus();
  assert.deepEqual(s.reachout_limit, { active: true, ends_at: new Date(1784477333000).toISOString() });
  const st2 = createWahaClient({ env, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'WORKING', me: { id: '1@c.us' } }) }) });
  assert.equal((await st2.sessionStatus()).reachout_limit, null);
});

test('los logs del correo de prueba no muestran contraseñas, tokens ni el número completo', async () => {
  const { consoleMailer } = require('../src/core/auth');
  const lines = []; const m = consoleMailer((x) => lines.push(x));
  await m.send({ to: '4439904367', subject: 'Tu cuenta de Zuki Pay', text: 'Hola. Tu usuario es pepe y tu contraseña temporal es bcb9gm6mpn. Entra en https://x.test/reset?token=abcdef123' });
  assert.doesNotMatch(lines[0], /bcb9gm6mpn/); assert.doesNotMatch(lines[0], /abcdef123/); assert.doesNotMatch(lines[0], /4439904367/);
  assert.match(lines[0], /443\*\*\*\*67/);
  assert.match(m.outbox[0].text, /bcb9gm6mpn/, 'el mensaje real no se altera');
});
