'use strict';
// Tipo de cuenta por escuela (terminología): 'natacion' para academias de natación; las escuelas no cambian.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');

let S, srv, base, ZUKI;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });
before(async () => {
  S = await createServer({ cardStock: false, jwtSecret: 't'.repeat(40), mailer: consoleMailer(() => {}) });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  ZUKI = (await login('zuki', 'zuki123')).data.access_token;
});
after(() => srv.close());

test('cuenta de natación: tipo guardado, sesión con school_type, productos habilitados; escuelas siguen igual', async () => {
  const r = await api('/api/super/createSchool', { token: ZUKI, body: { name: 'Natación Prueba', status: 'prueba', account_type: 'natacion', admin_username: 'nat.prueba' } });
  assert.ok(r.ok, r.error);
  assert.equal(r.data.school.account_type, 'natacion');
  assert.equal(r.data.school.status, 'prueba');
  assert.equal(r.data.school.tipo_pago, null);
  const l = await login('nat.prueba', r.data.admin.temporary_password);
  assert.ok(l.ok, l.error);
  assert.equal(l.data.user.school_type, 'natacion');
  const cats = await api('/api/rpc/listCategories', { token: l.data.access_token, body: {} });
  const p = await api('/api/rpc/createProduct', { token: l.data.access_token, body: { name: 'Goggles', category_id: cats.data[0].id, price_cents: 15000 } });
  assert.ok(p.ok, p.error);
  const a = await login('admin', 'admin123');
  assert.equal(a.data.user.school_type, 'escuela');
  const bad = await api('/api/super/createSchool', { token: ZUKI, body: { name: 'X', account_type: 'otro', admin_username: 'x.x' } });
  assert.equal(bad.ok, false);
  // editar sin mandar account_type conserva el valor
  const u = await api('/api/super/updateSchool', { token: ZUKI, body: { id: r.data.school.id, name: 'Natación Prueba 2' } });
  assert.equal(u.data.account_type, 'natacion');
});
