'use strict';
// Mensualidades de academias de natación: precios, ciclo mensual, pagos manuales, inscripción y filtros.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { dueDate, statusOf } = require('../src/core/mensualidades');
const { mxDate, addDays, addMonths } = require('../src/core/billing');

let S, srv, base, ZUKI, NAT, ESC;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const rpc = (m, token, body = {}) => api('/api/rpc/' + m, { token, body });
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });
before(async () => {
  S = await createServer({ cardStock: false, jwtSecret: 't'.repeat(40), mailer: consoleMailer(() => {}) });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  ZUKI = (await login('zuki', 'zuki123')).data.access_token;
  const r = await api('/api/super/createSchool', { token: ZUKI, body: { name: 'Cuit Test', status: 'prueba', account_type: 'natacion', admin_username: 'cuit.test' } });
  NAT = (await login('cuit.test', r.data.admin.temporary_password)).data.access_token;
  ESC = (await login('admin', 'admin123')).data.access_token;
});
after(() => srv.close());

test('vencimiento: mismo día cada mes y último día en meses cortos; estados', () => {
  assert.equal(dueDate('2026-01-31', 0), '2026-01-31');
  assert.equal(dueDate('2026-01-31', 1), '2026-02-28');
  assert.equal(dueDate('2026-01-31', 2), '2026-03-31');
  assert.equal(dueDate('2028-01-30', 1), '2028-02-29');
  assert.equal(dueDate('2026-03-15', 10), '2027-01-15');
  assert.equal(statusOf('2026-05-10', '2026-05-01'), 'al_corriente');
  assert.equal(statusOf('2026-05-04', '2026-05-01'), 'por_vencer');
  assert.equal(statusOf('2026-05-01', '2026-05-01'), 'por_vencer');
  assert.equal(statusOf('2026-04-30', '2026-05-01'), 'vencida');
});

test('precios por defecto, inscripción 200 y configurables por academia', async () => {
  const s = await rpc('mensGetSettings', NAT);
  assert.ok(s.ok, s.error);
  assert.deepEqual(s.data.prices_cents, { 1: 33000, 2: 47000, 3: 60000, 4: 75000, 5: 84000, 6: 92000 });
  assert.equal(s.data.inscripcion_cents, 20000);
  const u = await rpc('mensSetSettings', NAT, { prices_cents: { 2: 50000 }, inscripcion_cents: 25000 });
  assert.equal(u.data.prices_cents[2], 50000); assert.equal(u.data.prices_cents[1], 33000); assert.equal(u.data.inscripcion_cents, 25000);
  assert.equal((await rpc('mensSetSettings', NAT, { prices_cents: { 3: -1 } })).ok, false);
  await rpc('mensSetSettings', NAT, { prices_cents: { 2: 47000 }, inscripcion_cents: 20000 });
});

test('escuelas normales no tienen mensualidades', async () => {
  const r = await rpc('mensGetSettings', ESC);
  assert.equal(r.ok, false); assert.equal(r.code, 'PROHIBIDO');
  assert.equal((await rpc('mensList', ESC)).ok, false);
});

test('plan, pago manual que avanza un mes, historial, inscripción y filtros', async () => {
  const c = await rpc('createChild', NAT, { full_name: 'Nadador Uno', grade: 'Delfines 5pm' });
  assert.ok(c.ok, c.error);
  const t = mxDate();
  const start = addMonths(t, -1); // venció hace unos días → vencida
  assert.equal((await rpc('mensSetPlan', NAT, { child_id: c.data.id, dias_semana: 7, fecha_inicio: start })).ok, false);
  let p = await rpc('mensSetPlan', NAT, { child_id: c.data.id, dias_semana: 3, fecha_inicio: start, inscripcion_pagada: true, inscripcion_fecha: t });
  assert.ok(p.ok, p.error);
  assert.equal(p.data.monthly_cents, 60000); assert.equal(p.data.next_due, start); assert.equal(p.data.status, 'vencida');
  assert.equal(p.data.inscripcion_pagada, true); assert.equal(p.data.inscripcion_fecha, t);
  let l = await rpc('mensList', NAT, { status: 'vencida,por_vencer' });
  assert.equal(l.data.length, 1); assert.equal(l.data[0].child_name, 'Nadador Uno');
  p = await rpc('mensRegisterPayment', NAT, { child_id: c.data.id, note: 'efectivo' });
  assert.ok(p.ok, p.error);
  assert.equal(p.data.next_due, addMonths(start, 1));
  assert.equal(p.data.payments.length, 1); assert.equal(p.data.payments[0].amount_cents, 60000); assert.equal(p.data.payments[0].note, 'efectivo'); assert.equal(p.data.payments[0].period_due, start);
  p = await rpc('mensRegisterPayment', NAT, { child_id: c.data.id, amount_cents: 55000, paid_at: t });
  assert.equal(p.data.next_due, addMonths(start, 2)); assert.equal(p.data.status, 'al_corriente'); assert.equal(p.data.payments.length, 2);
  // no toca el saldo de la tarjeta
  const kids = await rpc('listChildren', NAT);
  assert.equal(kids.data.find((k) => k.id === c.data.id).balance_cents, 0);
  // por vencer
  const c2 = await rpc('createChild', NAT, { full_name: 'Nadador Dos' });
  await rpc('mensSetPlan', NAT, { child_id: c2.data.id, dias_semana: 1, fecha_inicio: addDays(t, 2) });
  l = await rpc('mensList', NAT, { status: 'por_vencer' });
  assert.deepEqual(l.data.map((x) => x.child_name), ['Nadador Dos']);
  assert.equal(l.data[0].monthly_cents, 33000);
  assert.ok('tutor_whatsapp' in l.data[0] && 'tutor_name' in l.data[0]);
  // sin plan no se puede registrar pago
  const c3 = await rpc('createChild', NAT, { full_name: 'Nadador Tres' });
  assert.equal((await rpc('mensRegisterPayment', NAT, { child_id: c3.data.id })).ok, false);
});

test('editar y borrar un pago por error: el vencimiento regresa y queda auditoría', async () => {
  const c = await rpc('createChild', NAT, { full_name: 'Nadador Cuatro' });
  const start = '2026-01-31';
  await rpc('mensSetPlan', NAT, { child_id: c.data.id, dias_semana: 2, fecha_inicio: start });
  await rpc('mensRegisterPayment', NAT, { child_id: c.data.id, paid_at: '2026-01-30' });
  let p = await rpc('mensRegisterPayment', NAT, { child_id: c.data.id, paid_at: '2026-02-27' });
  assert.equal(p.data.next_due, '2026-03-31');
  const last = p.data.payments[0];
  p = await rpc('mensUpdatePayment', NAT, { id: last.id, amount_cents: 40000, note: 'corregido' });
  assert.ok(p.ok, p.error); assert.equal(p.data.payments[0].amount_cents, 40000); assert.equal(p.data.next_due, '2026-03-31');
  p = await rpc('mensDeletePayment', NAT, { id: last.id });
  assert.ok(p.ok, p.error);
  assert.equal(p.data.next_due, '2026-02-28'); assert.equal(p.data.payments.length, 1);
  const row = S.db.get('SELECT deleted_at, deleted_by FROM swimmer_payments WHERE id = ?', [last.id]);
  assert.ok(row.deleted_at && row.deleted_by);
  assert.equal((await rpc('mensDeletePayment', NAT, { id: last.id })).ok, false);
  assert.equal((await rpc('mensDeletePayment', ESC, { id: p.data.payments[0].id })).ok, false);
});
