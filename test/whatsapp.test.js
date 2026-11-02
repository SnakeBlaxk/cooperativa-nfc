'use strict';
// Campo WhatsApp opcional de personas: se guarda; si está vacío se usa el teléfono.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');

let S, srv, base, ADMIN;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });
before(async () => {
  S = await createServer({ cardStock: false, jwtSecret: 't'.repeat(40), mailer: consoleMailer(() => {}) });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  const z = (await login('zuki', 'zuki123')).data.access_token;
  const r = await api('/api/super/createSchool', { token: z, body: { name: 'WA Prueba', status: 'prueba', admin_username: 'wa.admin' } });
  ADMIN = (await login('wa.admin', r.data.admin.temporary_password)).data.access_token;
});
after(() => srv.close());

test('tutor con WhatsApp distinto y tutor sin WhatsApp (usa el teléfono)', async () => {
  const a = await api('/api/admin/tutors', { token: ADMIN, body: { full_name: 'Papá Uno', phone: '4431110000', whatsapp: '443 222 0000' } });
  assert.ok(a.ok, a.error);
  assert.equal(a.data.user.whatsapp, '4432220000');
  assert.equal(a.data.user.whatsapp_effective, '4432220000');
  const b = await api('/api/admin/tutors', { token: ADMIN, body: { full_name: 'Papá Dos', phone: '4431113333' } });
  assert.ok(b.ok, b.error);
  assert.equal(b.data.user.whatsapp, null);
  assert.equal(b.data.user.whatsapp_effective, '4431113333');
  const bad = await api('/api/admin/tutors', { token: ADMIN, body: { full_name: 'Papá Tres', phone: '4431114444', whatsapp: '12' } });
  assert.equal(bad.ok, false);
});
