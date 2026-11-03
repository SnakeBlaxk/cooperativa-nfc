'use strict';
// Ayuda: preguntas frecuentes por tipo de cuenta y asistente de IA (sin llave → mensaje amable; límite por cuenta).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { createHelpAI, systemPrompt, faqFor } = require('../src/core/help');

let S, srv, base, NAT, ESC; let calls = [];
const fakeFetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { ok: true, json: async () => ({ choices: [{ message: { content: 'Vaya a Mensualidades.' } }] }) }; };
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...(await r.json()) };
}
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });
before(async () => {
  S = await createServer({ cardStock: false, jwtSecret: 't'.repeat(40), mailer: consoleMailer(() => {}), helpAI: createHelpAI({ env: {}, fetchImpl: fakeFetch }) });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  const Z = (await login('zuki', 'zuki123')).data.access_token;
  const r = await api('/api/super/createSchool', { token: Z, body: { name: 'Nat Ayuda', account_type: 'natacion', admin_username: 'nat.ayuda' } });
  NAT = (await login('nat.ayuda', r.data.admin.temporary_password)).data.access_token;
  ESC = (await login('admin', 'admin123')).data.access_token;
});
after(() => srv.close());

test('preguntas frecuentes: natación incluye mensualidades; escuela no', async () => {
  const n = await api('/api/rpc/helpFaq', { token: NAT });
  assert.ok(n.ok, n.error); assert.ok(n.data.some((f) => /mensualidad/i.test(f.q)));
  const e = await api('/api/rpc/helpFaq', { token: ESC });
  assert.ok(e.data.length > 5); assert.ok(!e.data.some((f) => /mensualidad/i.test(f.q)));
  assert.match(systemPrompt('natacion', 'Cuit'), /nadador/); assert.ok(faqFor('natacion').length > faqFor('escuela').length);
});

test('IA sin llave: responde configured=false con enlace de WhatsApp', async () => {
  const r = await api('/api/help/chat', { token: NAT, body: { messages: [{ role: 'user', content: '¿cómo cobro?' }] } });
  assert.ok(r.ok, r.error); assert.equal(r.data.configured, false); assert.match(r.data.support_url, /wa\.me\/5215658629519/);
  assert.equal((await api('/api/help/chat', { body: {} })).status, 401);
});

test('IA con llave: usa la guía como system prompt y limita por cuenta', async () => {
  const ai = createHelpAI({ env: { ZUKIPAY_AI_API_KEY: 'k-test', ZUKIPAY_AI_MODEL: 'm1' }, fetchImpl: fakeFetch, limit: 2 });
  calls = [];
  const u = { id: 1, school_id: 7 };
  const r = await ai.chat({ user: u, messages: [{ role: 'user', content: 'hola' }], schoolName: 'Cuit', type: 'natacion' });
  assert.equal(r.answer, 'Vaya a Mensualidades.');
  assert.equal(calls[0].body.model, 'm1'); assert.equal(calls[0].auth, 'Bearer k-test');
  assert.equal(calls[0].body.messages[0].role, 'system'); assert.match(calls[0].body.messages[0].content, /Registrar pago/);
  await ai.chat({ user: u, messages: [{ role: 'user', content: 'x' }] });
  await assert.rejects(ai.chat({ user: u, messages: [{ role: 'user', content: 'y' }] }), (e) => e.code === 'LIMITE');
  await ai.chat({ user: { id: 2, school_id: 8 }, messages: [{ role: 'user', content: 'z' }] });
});
