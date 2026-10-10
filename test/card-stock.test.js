'use strict';
// Inventario de tarjetas del superadministrador (lista blanca): alta, entrega, bloqueo y validación en el servidor
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { openDatabase } = require('../src/core/db');
const { normUid } = require('../src/core/service');
const { parseUidList } = require('../src/core/card-stock');

let S, srv, base, Z, A, C, A2, C2;
async function api(p, { body, token } = {}) {
  const r = await fetch(base + p, { method: body !== undefined ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, ...(await r.json()) };
}
const tok = async (u, p) => { const r = await api('/api/auth/login', { body: { identifier: u, password: p } }); assert.ok(r.ok, u + ': ' + r.error); return r.data.access_token; };
const rpc = (m, body, token) => api('/api/rpc/' + m, { body: body || {}, token });
const sup = (m, body) => api('/api/super/' + m, { body: body || {}, token: Z });
const NOT_AUTH = 'Tarjeta no autorizada. Solicite tarjetas a Zuki Company.';
const alertsFor = (uid) => S.db.all("SELECT * FROM alerts WHERE kind = 'tarjeta_no_autorizada' AND message LIKE ?", ['%' + uid + '%']);
const auditFor = (uid) => S.db.all("SELECT * FROM audit_log WHERE action = 'tarjeta_no_autorizada' AND target_id = ?", [uid]);
let kid1, kid2, prod1;

before(async () => {
  S = await createServer({ jwtSecret: 'w'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  await new Promise((r) => { srv = S.app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  [Z, A, C, A2, C2] = [await tok('zuki', 'zuki123'), await tok('admin', 'admin123'), await tok('cajero', 'cajero123'), await tok('admin2', 'admin123'), await tok('cajero2', 'cajero123')];
  kid1 = (await rpc('createChild', { full_name: 'Niño Prueba Uno', grade: '1A' }, A)).data.id;
  kid2 = (await rpc('createChild', { full_name: 'Niña Prueba Dos', grade: '2B' }, A2)).data.id;
  prod1 = S.db.get('SELECT id FROM products WHERE school_id = 1 AND active = 1 AND stock IS NULL ORDER BY price_cents LIMIT 1').id;
});
after(() => new Promise((r) => srv.close(r)));

test('normalización: espacios, separadores, mayúsculas; 10 dígitos decimales con ceros a la izquierda', () => {
  assert.equal(normUid(' 04:a1-b2 c3 '), '04A1B2C3');
  assert.equal(normUid('0001234567'), '0001234567');
  assert.equal(normUid('000.123.4567'), '0001234567');
  assert.deepEqual(parseUidList('UID,lote\n0001234567,L1\n"04 AA BB CC"\n\n  0009999999\r\n'), ['0001234567', '04 AA BB CC', '0009999999']);
});

test('superadmin: alta uno por uno y en lote (repetidos/inválidos informados), entrega por rango y conteos', async () => {
  let r = await sup('stockAdd', { uid: '0001234567', kind: 'personalizada', batch: 'L-01' });
  assert.equal(r.ok, true, r.error); assert.equal(r.data.added, 1);
  r = await sup('stockAdd', { uid: '0001234567' }); assert.equal(r.data.added, 0); assert.deepEqual(r.data.duplicates, ['0001234567']);
  r = await sup('stockAdd', { text: '0001234568\n0001234569\n000-123-4570\n0001234569\n!!\n0007777777', batch: 'L-02' });
  assert.equal(r.data.added, 4); assert.deepEqual(r.data.duplicates, ['0001234569']); assert.equal(r.data.invalid.length, 1);
  const s0 = S.db.get("SELECT * FROM card_stock WHERE uid = '0001234567'"); assert.equal(s0.status, 'en_stock'); assert.equal(s0.kind, 'personalizada');
  // rango numérico 0001234567..0001234569 → escuela 1; 0001234570 → escuela 2
  r = await sup('stockDeliver', { school_id: 1, from: '0001234567', to: '0001234569' }); assert.equal(r.data.delivered, 3, JSON.stringify(r));
  r = await sup('stockDeliver', { school_id: 2, uids: ['0001234570'] }); assert.equal(r.data.delivered, 1);
  const sum = (await sup('stockSummary')).data;
  assert.equal(sum.by_status.en_stock, 1); // 0007777777
  assert.ok(sum.schools.find((x) => x.id === 1).entregada >= 3);
  assert.equal(typeof sum.migrated, 'number');
  const list = (await sup('stockList', { status: 'en_stock' })).data; assert.deepEqual(list.map((x) => x.uid), ['0007777777']);
  const csv = (await sup('stockExport', { school_id: 2 })).data; assert.match(csv.csv, /="0001234570",normal,entregada/);
  // solo el superadministrador
  assert.equal((await api('/api/super/stockAdd', { body: { uid: '0005555555' }, token: A })).status, 403);
  assert.ok(S.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'inventario_tarjetas_entrega'"));
});

test('asignar: tarjeta fuera del inventario, sin entregar o de otra escuela se rechaza con alerta y bitácora', async () => {
  for (const [uid, why] of [['0009990001', /no está en el inventario/], ['0007777777', /no ha sido entregada/], ['0001234570', /otra escuela/]]) {
    for (const [m, body] of [['assignCardByUid', { uid, child_id: kid1 }], ['registerCard', { uid }]]) {
      const r = await rpc(m, body, A);
      assert.equal(r.status, 403, m + ' ' + uid); assert.equal(r.error, NOT_AUTH); assert.equal(r.code, 'TARJETA_NO_AUTORIZADA');
    }
    const al = alertsFor(uid); assert.ok(al.length >= 1); const det = JSON.parse(al[0].details);
    assert.equal(det.uid, uid); assert.match(det.motivo, why); assert.equal(al[0].school_id, 1); assert.ok(det.usuario); assert.ok(det.escuela);
    assert.ok(auditFor(uid).length >= 2);
  }
  assert.equal(S.db.get("SELECT COUNT(*) AS n FROM cards WHERE uid IN ('0009990001','0007777777','0001234570')").n, 0);
  // la escuela 2 sí puede usar la suya; la escuela 1 la suya (escrita con separadores)
  let r = await rpc('assignCardByUid', { uid: '0001234570', child_id: kid2 }, A2); assert.equal(r.ok, true, r.error);
  r = await rpc('assignCardByUid', { uid: '000 123 4567', child_id: kid1 }, A); assert.equal(r.ok, true, r.error); assert.equal(r.data.uid, '0001234567');
  assert.equal(S.db.get("SELECT status FROM card_stock WHERE uid = '0001234567'").status, 'asignada');
  // el admin solo ve las tarjetas entregadas a su escuela
  const mine = (await rpc('listSchoolStock', {}, A)).data.map((x) => x.uid);
  assert.ok(mine.includes('0001234568')); assert.ok(!mine.includes('0001234570'));
  const cards1 = (await rpc('listCards', {}, A)).data.map((x) => x.uid); assert.ok(!cards1.includes('0001234570'));
});

test('recarga y venta: solo con tarjeta autorizada de la misma escuela; bloqueada por Zuki se rechaza', async () => {
  let r = await rpc('recharge', { uid: '0001234567', amount_cents: 5000 }, C); assert.equal(r.ok, true, r.error);
  r = await rpc('purchase', { uid: '0001234567', items: [{ product_id: prod1, qty: 1 }] }, C); assert.equal(r.ok, true, r.error); assert.equal(r.data.ok, true, r.data.reason);
  // otra escuela intenta cobrar/recargar con la tarjeta de la escuela 1
  r = await rpc('recharge', { uid: '0001234567', amount_cents: 1000 }, C2); assert.equal(r.status, 403); assert.equal(r.error, NOT_AUTH);
  r = await rpc('purchase', { uid: '0001234567', items: [{ product_id: prod1, qty: 1 }] }, C2); assert.equal(r.error, NOT_AUTH);
  assert.ok(alertsFor('0001234567').some((a) => a.school_id === 2));
  // bloqueo del superadministrador
  r = await sup('stockSetStatus', { uids: ['0001234567'], status: 'bloqueada' }); assert.equal(r.data.updated, 1);
  const bal = S.db.get("SELECT balance_cents FROM cards WHERE uid = '0001234567'").balance_cents;
  r = await rpc('recharge', { uid: '0001234567', amount_cents: 1000 }, C); assert.equal(r.error, NOT_AUTH);
  r = await rpc('purchase', { uid: '0001234567', items: [{ product_id: prod1, qty: 1 }] }, C); assert.equal(r.error, NOT_AUTH);
  assert.equal(S.db.get("SELECT balance_cents FROM cards WHERE uid = '0001234567'").balance_cents, bal, 'saldo intacto');
  assert.ok(alertsFor('0001234567').some((a) => /bloqueada/.test(a.message) && a.school_id === 1));
  // la escuela ve el estado del inventario en su lista
  assert.equal((await rpc('listCards', {}, A)).data.find((x) => x.uid === '0001234567').stock_status, 'bloqueada');
  r = await sup('stockSetStatus', { uids: ['0001234567'], status: 'desbloquear' }); assert.equal(r.data.updated, 1);
  assert.equal(S.db.get("SELECT status FROM card_stock WHERE uid = '0001234567'").status, 'asignada');
  r = await rpc('recharge', { uid: '0001234567', amount_cents: 1000 }, C); assert.equal(r.ok, true);
  // demo: las tarjetas sembradas siguen funcionando
  r = await rpc('recharge', { uid: '04A1B2C3D4E5F6', amount_cents: 1000 }, C); assert.equal(r.ok, true, r.error);
});

test('superadmin: eliminar solo si la escuela no la registró; regresar a stock; dañada', async () => {
  let r = await sup('stockRemove', { uids: ['0001234567', '0007777777'] });
  assert.equal(r.data.removed, 1); assert.equal(r.data.skipped[0].uid, '0001234567');
  r = await sup('stockSetStatus', { uids: ['0001234568'], status: 'danada' }); assert.equal(r.data.updated, 1);
  assert.equal((await rpc('registerCard', { uid: '0001234568' }, A)).error, NOT_AUTH);
  r = await sup('stockSetStatus', { uids: ['0001234569'], status: 'en_stock' }); assert.equal(r.data.updated, 1);
  assert.equal(S.db.get("SELECT school_id FROM card_stock WHERE uid = '0001234569'").school_id, null);
});

test('superadmin: eliminar definitivamente (tarjeta registrada por la escuela); rechaza alumno activo; conserva historial', async () => {
  // 0001234567 está asignada a un alumno activo y tiene movimientos
  let r = await sup('stockPurge', { uids: ['0001234567'] });
  assert.equal(r.data.removed, 0); assert.match(r.data.skipped[0].motivo, /alumno activo/);
  assert.ok(S.db.get("SELECT 1 AS x FROM cards WHERE uid = '0001234567'"));
  assert.equal((await rpc('stockPurge', { uids: ['0001234567'] }, A)).ok, false);
  // tarjeta de prueba registrada por la escuela, con movimientos y alumno dado de baja
  const uid = '0005550001';
  await sup('stockAdd', { uid, school_id: 1 });
  const kid = (await rpc('createChild', { full_name: 'Alumno Temporal', grade: '3C' }, A)).data.id;
  r = await rpc('registerCard', { uid, child_id: kid }, A); assert.equal(r.ok, true, r.error);
  const card = S.db.get('SELECT * FROM cards WHERE uid = ?', [uid]);
  if (!card.child_id) S.db.run('UPDATE cards SET child_id = ? WHERE id = ?', [kid, card.id]);
  S.db.run("INSERT INTO transactions (school_id, type, status, amount_cents, card_id, card_uid, child_id, created_at) VALUES (1, 'recarga', 'aprobado', 100, ?, ?, ?, '2026-01-01 00:00:00')", [card.id, uid, kid]);
  S.db.run('UPDATE cards SET balance_cents = 0 WHERE id = ?', [card.id]);
  S.db.run("UPDATE children SET active = 0, deleted_at = '2026-01-02' WHERE id = ?", [kid]);
  r = await sup('stockPurge', { uids: [uid] });
  assert.equal(r.data.removed, 1, JSON.stringify(r));
  assert.equal(S.db.get('SELECT 1 AS x FROM cards WHERE uid = ?', [uid]), undefined);
  assert.equal(S.db.get('SELECT 1 AS x FROM card_stock WHERE uid = ?', [uid]), undefined);
  const tx = S.db.all('SELECT * FROM transactions WHERE card_uid = ?', [uid]);
  assert.ok(tx.length >= 1); assert.ok(tx.every((t) => t.card_id === null));
  assert.equal(S.db.get('PRAGMA foreign_key_check'), undefined);
  assert.ok(S.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'inventario_tarjetas_eliminacion_definitiva'"));
  // tarjeta con saldo no se elimina
  const uid2 = '0005550002';
  await sup('stockAdd', { uid: uid2, school_id: 1 });
  assert.equal((await rpc('registerCard', { uid: uid2 }, A)).ok, true);
  S.db.run('UPDATE cards SET balance_cents = 500, child_id = NULL WHERE uid = ?', [uid2]);
  r = await sup('stockPurge', { uids: [uid2] }); assert.equal(r.data.removed, 0); assert.match(r.data.skipped[0].motivo, /saldo/);
});

test('migración: tarjetas existentes pasan al inventario como entregadas (o asignadas) a su escuela, una sola vez', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-stock-'));
  const file = path.join(dir, 'old.db');
  // Base "antigua" sin la tabla card_stock ni la marca de migración
  const d0 = await openDatabase(file);
  d0.db.exec("INSERT INTO schools (name, status, created_at) VALUES ('A', 'activa', '2026-01-01'), ('B', 'activa', '2026-01-01')");
  d0.db.exec("INSERT INTO children (school_id, full_name, created_at) VALUES (1, 'Ana', '2026-01-01')");
  d0.db.exec(`INSERT INTO cards (school_id, uid, child_id, status, balance_cents, created_at) VALUES
    (1, '0000000001', 1, 'activa', 500, '2026-01-01'), (1, '0000000002', NULL, 'sin_asignar', 0, '2026-01-01'), (2, '04AABBCCDD', NULL, 'sin_asignar', 0, '2026-01-01')`);
  d0.db.exec("DROP TRIGGER IF EXISTS trg_card_stock_ins; DROP TRIGGER IF EXISTS trg_card_stock_upd; DROP TABLE card_stock; DELETE FROM meta WHERE key = 'card_stock_v1';");
  d0.save(); d0.close();
  const d1 = await openDatabase(file);
  assert.equal(d1.cardStockMigrated, 3);
  assert.equal(JSON.parse(d1.get("SELECT value FROM meta WHERE key = 'card_stock_v1'").value).migrated, 3);
  assert.deepEqual(d1.all('SELECT uid, status, school_id FROM card_stock ORDER BY uid'), [
    { uid: '0000000001', status: 'asignada', school_id: 1 }, { uid: '0000000002', status: 'entregada', school_id: 1 }, { uid: '04AABBCCDD', status: 'entregada', school_id: 2 }]);
  assert.equal(d1.get("SELECT balance_cents FROM cards WHERE uid = '0000000001'").balance_cents, 500, 'datos intactos');
  d1.close();
  const d2 = await openDatabase(file); assert.equal(d2.cardStockMigrated, undefined, 'no se repite'); assert.equal(d2.get('SELECT COUNT(*) AS n FROM card_stock').n, 3); d2.close();
});
