'use strict';
// Perfil del alumno: el tutor no edita nombre ni grado/grupo (solo la foto) y pide cambios a la escuela.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { openDatabase } = require('../src/core/db');

let S, srv, base, A, A2, C, M, J;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const tok = async (u, p) => { const r = await api('/api/auth/login', { body: { identifier: u, password: p } }); assert.ok(r.ok, u + ': ' + r.error); return r.data.access_token; };
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const child = (name) => S.db.get('SELECT * FROM children WHERE full_name = ?', [name]);
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
before(async () => {
  S = await createServer({ jwtSecret: 'c'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  [A, A2, C, M, J] = [await tok('admin', 'admin123'), await tok('admin2', 'admin123'), await tok('cajero', 'cajero123'), await tok('maria', 'tutor123'), await tok('juan', 'tutor123')];
});
after(() => new Promise((r) => srv.close(r)));

test('tutor: 403 al cambiar nombre o grado/grupo; sí puede subir y quitar la foto; queda en la bitácora', async () => {
  const s = child('Sofía Hernández');
  for (const body of [{ id: s.id, full_name: 'Sofi H.' }, { id: s.id, grade: '6° C' }, { id: s.id, full_name: 'Otra', grade: 'X', photo: PHOTO }]) {
    const r = await rpc('updateChild', body, M);
    assert.equal(r.status, 403, JSON.stringify(body)); assert.equal(r.code, 'PROHIBIDO'); assert.match(r.error, /Solicitar cambio de datos/);
  }
  assert.equal(child('Sofía Hernández').full_name, 'Sofía Hernández'); assert.equal(child('Sofía Hernández').grade, '3° A');
  assert.equal(child('Sofía Hernández').photo, null, 'el intento rechazado no cambia nada');
  assert.ok(S.db.get("SELECT id FROM audit_log WHERE action = 'edicion_alumno_rechazada' AND actor_role = 'tutor'"));
  // foto: subir y quitar (enviar el mismo nombre/grado no cuenta como cambio)
  let r = await rpc('updateChild', { id: s.id, photo: PHOTO }, M);
  assert.equal(r.ok, true, r.error); assert.equal(child('Sofía Hernández').photo, PHOTO);
  r = await rpc('updateChild', { id: s.id, full_name: s.full_name, grade: s.grade, photo: null }, M);
  assert.equal(r.ok, true, r.error); assert.equal(child('Sofía Hernández').photo, null);
  // estado/tutor tampoco
  r = await rpc('updateChild', { id: s.id, active: false, tutor_id: 999 }, M);
  assert.equal(r.ok, true); assert.equal(child('Sofía Hernández').active, 1); assert.equal(child('Sofía Hernández').tutor_id, s.tutor_id);
  // el administrador sí edita nombre y grado
  r = await rpc('updateChild', { id: s.id, grade: '3° B' }, A);
  assert.equal(r.ok, true); assert.equal(child('Sofía Hernández').grade, '3° B');
  await rpc('updateChild', { id: s.id, grade: '3° A' }, A);
});

test('solicitudes: el tutor pide, el admin ve la notificación (no leída), aprueba (se aplica) o rechaza con motivo; el tutor ve el estado', async () => {
  const d = child('Diego Hernández');
  const v = child('Valentina Pérez');
  // validaciones y permisos
  assert.equal((await rpc('requestChildChange', { child_id: d.id, field: 'edad', new_value: 'x' }, M)).status, 400);
  assert.equal((await rpc('requestChildChange', { child_id: d.id, field: 'nombre', new_value: '' }, M)).status, 400);
  assert.equal((await rpc('requestChildChange', { child_id: d.id, field: 'grado', new_value: d.grade }, M)).status, 400);
  assert.equal((await rpc('requestChildChange', { child_id: d.id, field: 'otro' }, M)).status, 400);
  assert.equal((await rpc('requestChildChange', { child_id: v.id, field: 'nombre', new_value: 'Vale' }, M)).status, 403, 'no es su hijo');
  assert.equal((await rpc('requestChildChange', { child_id: d.id, field: 'nombre', new_value: 'X' }, A)).status, 403, 'solo tutores');

  const before = (await rpc('changeRequestsUnread', {}, A)).data;
  const r1 = await rpc('requestChildChange', { child_id: d.id, field: 'nombre', new_value: 'Diego Hernández López', comment: 'Falta el segundo apellido' }, M);
  assert.equal(r1.ok, true, r1.error); assert.equal(r1.data.status, 'pendiente'); assert.equal(r1.data.old_value, 'Diego Hernández');
  const r2 = await rpc('requestChildChange', { child_id: d.id, field: 'grado', new_value: '6° A', comment: 'Ya pasó de grado' }, M);
  const r3 = await rpc('requestChildChange', { child_id: d.id, field: 'otro', new_value: 'CURP', comment: 'Corregir CURP en expediente' }, M);
  assert.ok(r2.ok && r3.ok);
  assert.ok(S.db.get("SELECT id FROM audit_log WHERE action = 'solicitud_cambio_datos' AND target_id = ? AND school_id = ?", [String(d.id), d.school_id]));

  // insignia de no leídas en el panel de la escuela
  const un = (await rpc('changeRequestsUnread', {}, A)).data;
  assert.equal(un.unread, before.unread + 3); assert.equal(un.pending, before.pending + 3);
  assert.equal((await rpc('changeRequestsUnread', {}, A2)).data.unread, 0, 'otra escuela no la ve');
  assert.equal((await rpc('changeRequestsUnread', {}, C)).status, 403, 'el cajero no');
  const list = (await rpc('listChangeRequests', { status: 'pendiente' }, A)).data;
  const row = list.find((x) => x.id === r1.data.id);
  assert.equal(row.child_name, 'Diego Hernández'); assert.equal(row.tutor_name, 'María Hernández'); assert.equal(row.field_label, 'Nombre'); assert.equal(row.unread, true);
  assert.ok(row.created_at);
  assert.equal((await rpc('listChangeRequests', {}, A2)).data.length, 0);
  assert.equal((await rpc('markChangeRequestsRead', {}, A)).ok, true);
  assert.equal((await rpc('changeRequestsUnread', {}, A)).data.unread, 0);

  // otra escuela no puede resolver; el tutor tampoco
  assert.equal((await rpc('resolveChangeRequest', { id: r1.data.id, decision: 'aprobar' }, A2)).status, 404);
  assert.equal((await rpc('resolveChangeRequest', { id: r1.data.id, decision: 'aprobar' }, M)).status, 403);

  // aprobar nombre → se aplica
  let x = await rpc('resolveChangeRequest', { id: r1.data.id, decision: 'aprobar' }, A);
  assert.equal(x.ok, true, x.error); assert.equal(x.data.request.status, 'aprobada'); assert.deepEqual(x.data.applied, { field: 'nombre', before: 'Diego Hernández', after: 'Diego Hernández López' });
  assert.equal(S.db.get('SELECT full_name FROM children WHERE id = ?', [d.id]).full_name, 'Diego Hernández López');
  assert.equal((await rpc('resolveChangeRequest', { id: r1.data.id, decision: 'rechazar' }, A)).status, 409, 'ya atendida');
  // aprobar grado → se aplica
  x = await rpc('resolveChangeRequest', { id: r2.data.id, decision: 'aprobar' }, A);
  assert.equal(x.ok, true); assert.equal(S.db.get('SELECT grade FROM children WHERE id = ?', [d.id]).grade, '6° A');
  // rechazar "otro" con motivo → no cambia nada
  x = await rpc('resolveChangeRequest', { id: r3.data.id, decision: 'rechazar', reason: 'Acuda a control escolar con la CURP' }, A);
  assert.equal(x.ok, true); assert.equal(x.data.applied, null); assert.equal(x.data.request.reject_reason, 'Acuda a control escolar con la CURP');
  const logs = S.db.all("SELECT action, details FROM audit_log WHERE action IN ('solicitud_cambio_aprobada','solicitud_cambio_rechazada') AND target_id = ?", [String(d.id)]);
  assert.equal(logs.filter((l) => l.action === 'solicitud_cambio_aprobada').length, 2);
  assert.match(logs.find((l) => l.action === 'solicitud_cambio_rechazada').details, /control escolar/);

  // el tutor ve el estado de sus solicitudes (y solo las suyas)
  const mine = (await rpc('listChangeRequests', { child_id: d.id }, M)).data;
  const st = Object.fromEntries(mine.map((q) => [q.id, q.status]));
  assert.equal(st[r1.data.id], 'aprobada'); assert.equal(st[r2.data.id], 'aprobada'); assert.equal(st[r3.data.id], 'rechazada');
  assert.equal(mine.find((q) => q.id === r3.data.id).reject_reason, 'Acuda a control escolar con la CURP');
  assert.equal((await rpc('listChangeRequests', { child_id: d.id }, J)).data.length, 0);
  // el perfil del alumno ya refleja el cambio para el tutor
  assert.equal((await rpc('childSummary', { child_id: d.id }, M)).data.child.full_name, 'Diego Hernández López');
});

test('migración segura: una base anterior sin la tabla de solicitudes se abre sin perder datos', async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coop-cr-')), 'vieja.db');
  const db1 = await openDatabase(f);
  db1.run("INSERT INTO schools (name, created_at) VALUES ('Vieja', '2026-01-01')");
  db1.run("INSERT INTO children (school_id, full_name, grade, created_at) VALUES (1, 'Ana', '1° A', '2026-01-01')");
  db1.db.exec('DROP TABLE child_change_requests'); db1.save(); db1.close();
  const db2 = await openDatabase(f);
  assert.equal(db2.get("SELECT full_name FROM children WHERE full_name = 'Ana'").full_name, 'Ana');
  assert.ok(db2.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'child_change_requests'"));
  db2.close();
});
