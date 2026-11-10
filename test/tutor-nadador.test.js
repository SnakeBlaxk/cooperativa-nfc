'use strict';
// Adultos que son su propio tutor: crear tutor + nadador en un solo paso (y viceversa desde el alta del nadador).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { reminderText } = require('../src/core/whatsapp');

let S, srv, base, NAT;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const rpc = (m, token, body = {}) => api('/api/rpc/' + m, { token, body });
const login = (identifier, password) => api('/api/auth/login', { body: { identifier, password } });
before(async () => {
  S = await createServer({ cardStock: false, jwtSecret: 'n'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, whatsappSweepMs: 0, env: {} });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  const z = (await login('zuki', 'zuki123')).data.access_token;
  const r = await api('/api/super/createSchool', { token: z, body: { name: 'Adultos', status: 'prueba', account_type: 'natacion', admin_username: 'adultos.admin' } });
  NAT = (await login('adultos.admin', r.data.admin.temporary_password)).data.access_token;
});
after(() => srv.close());

test('tutor que también es nadador: crea cuenta, nadador vinculado, plan y primer mes', async () => {
  const r = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Roberto Adulto', phone: '4435550101', whatsapp: '4435550102',
    as_swimmer: { grade: 'Adultos 7am', dias_semana: 2, fecha_inicio: '2026-11-09', inscripcion_pagada: true, primer_mes_pagado: true } } });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.data.temporary_password);
  assert.equal(r.data.swimmer.full_name, 'Roberto Adulto');
  assert.equal(r.data.swimmer.tutor_id, r.data.user.id);
  const plan = await rpc('mensGetPlan', NAT, { child_id: r.data.swimmer.id });
  assert.equal(plan.data.dias_semana, 2); assert.equal(plan.data.inscripcion_pagada, true);
  assert.equal(plan.data.next_due, '2026-12-09'); assert.equal(plan.data.payments.length, 1);
  assert.equal(plan.data.tutor_whatsapp, '4435550102');
  // Puede entrar con su teléfono y ve su propio nadador
  const me = (await login('4435550101', r.data.temporary_password)).data;
  assert.ok(me && me.access_token);
  const kids = await rpc('listChildren', me.access_token);
  assert.deepEqual(kids.data.map((c) => c.full_name), ['Roberto Adulto']);
});

test('sin la casilla, el alta de tutor queda igual (sin nadador)', async () => {
  const before = (await rpc('listChildren', NAT)).data.length;
  const r = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Mamá Normal', phone: '4435550201' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data.swimmer, undefined);
  assert.equal((await rpc('listChildren', NAT)).data.length, before);
});

test('sin duplicados: teléfono repetido falla y no deja ni cuenta ni nadador a medias', async () => {
  const users = (await rpc('listUsers', NAT, { role: 'tutor' })).data.length;
  const kids = (await rpc('listChildren', NAT)).data.length;
  const r = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Otro Roberto', phone: '4435550101', as_swimmer: { dias_semana: 1, fecha_inicio: '2026-11-09' } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Ya existe una cuenta con ese teléfono \(Roberto Adulto\)/);
  assert.equal((await rpc('listUsers', NAT, { role: 'tutor' })).data.length, users);
  assert.equal((await rpc('listChildren', NAT)).data.length, kids);
  // Plan inválido (7 días) → se revierte también la cuenta
  const bad = await api('/api/admin/tutors', { token: NAT, body: { full_name: 'Ana Revertida', phone: '4435550301', as_swimmer: { dias_semana: 7, fecha_inicio: '2026-11-09' } } });
  assert.equal(bad.ok, false);
  assert.equal((await rpc('listUsers', NAT, { role: 'tutor' })).data.length, users);
  assert.equal((await rpc('listChildren', NAT)).data.length, kids);
  assert.equal((await login('4435550301', 'x')).ok, false);
});

test('recordatorio a un adulto que es su propio tutor: "Su mensualidad"', () => {
  const t = reminderText({ tutorName: 'Roberto Adulto', childName: 'roberto  adulto', amountCents: 47000, nextDue: '2026-12-09', status: 'por_vencer', daysLeft: 2, schoolName: 'Cuitswimmer' });
  assert.match(t, /Su mensualidad es de \$470\.00 MXN/);
  assert.doesNotMatch(t, /mensualidad de roberto/i);
  const n = reminderText({ tutorName: 'Lucía Ramos', childName: 'Ana Ramos', amountCents: 47000, nextDue: '2026-12-09', status: 'por_vencer', daysLeft: 2, schoolName: 'Cuitswimmer' });
  assert.match(n, /La mensualidad de Ana Ramos/);
});
