'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/core/db');
const { createService } = require('../src/core/service');

let db, svc, admin, cajero, tutorA, tutorB, childA, childB, cats, prods, clock;
const UID_A = '04AAAAAAAAAAAA';
const UID_B = '04BBBBBBBBBBBB';

beforeEach(async () => {
  db = await openDatabase(null); // base en memoria
  clock = new Date(2026, 9, 7, 10, 0, 0); // miércoles 7 oct 2026, 10:00
  svc = createService(db, { now: () => clock });
  const bcrypt = require('bcryptjs');
  db.run("INSERT INTO schools (name, created_at) VALUES ('Escuela de prueba', '2026-01-01 00:00:00')");
  db.run("INSERT INTO users (username,password_hash,role,full_name,school_id,created_at) VALUES ('admin',?,'admin','Admin',1,'2026-01-01 00:00:00')", [bcrypt.hashSync('admin123', 4)]);
  admin = svc.login('admin', 'admin123');
  cajero = svc.createUser(admin, { role: 'cajero', username: 'caja', password: 'caja123', full_name: 'Caja' });
  tutorA = svc.createUser(admin, { role: 'tutor', username: 'tutora', password: 'tutor123', full_name: 'Tutor A' });
  tutorB = svc.createUser(admin, { role: 'tutor', username: 'tutorb', password: 'tutor123', full_name: 'Tutor B' });
  cats = { dulces: svc.createCategory(admin, { name: 'Dulces' }).id, refrescos: svc.createCategory(admin, { name: 'Refrescos' }).id, sano: svc.createCategory(admin, { name: 'Saludable' }).id };
  prods = {
    coca: svc.createProduct(admin, { name: 'Coca-Cola', category_id: cats.refrescos, price_cents: 1800 }).id,
    jugo: svc.createProduct(admin, { name: 'Jugo', category_id: cats.refrescos, price_cents: 1500 }).id,
    chocolate: svc.createProduct(admin, { name: 'Chocolate', category_id: cats.dulces, price_cents: 1500 }).id,
    manzana: svc.createProduct(admin, { name: 'Manzana', category_id: cats.sano, price_cents: 800 }).id,
  };
  childA = svc.createChild(admin, { tutor_id: tutorA.id, full_name: 'Niña A' });
  childB = svc.createChild(admin, { tutor_id: tutorB.id, full_name: 'Niño B' });
  svc.registerCard(admin, { uid: UID_A, child_id: childA.id });
  svc.registerCard(admin, { uid: UID_B, child_id: childB.id });
});

const balance = (uid) => db.get('SELECT balance_cents FROM cards WHERE uid = ?', [uid]).balance_cents;
const buy = (uid, items) => svc.purchase(cajero, { uid, items: items.map(([product_id, qty]) => ({ product_id, qty })) });

test('la recarga actualiza el saldo y registra el movimiento', () => {
  const r = svc.recharge(cajero, { uid: UID_A, amount_cents: 10000 });
  assert.equal(r.balance_cents, 10000);
  assert.equal(balance(UID_A), 10000);
  svc.recharge(admin, { uid: UID_A, amount_cents: 2550 });
  assert.equal(balance(UID_A), 12550);
  const m = svc.listMovements(admin, { child_id: childA.id, type: 'recarga' });
  assert.equal(m.length, 2);
});

test('la recarga no la puede hacer un tutor', () => {
  assert.throws(() => svc.recharge(tutorA, { uid: UID_A, amount_cents: 1000 }), /permiso/);
});

test('compra aprobada descuenta saldo y guarda partidas', () => {
  svc.recharge(cajero, { uid: UID_A, amount_cents: 5000 });
  const r = buy(UID_A, [[prods.manzana, 2], [prods.chocolate, 1]]);
  assert.equal(r.ok, true);
  assert.equal(r.total_cents, 3100);
  assert.equal(balance(UID_A), 1900);
  const [mv] = svc.listMovements(admin, { type: 'compra' });
  assert.equal(mv.items.length, 2);
});

test('saldo insuficiente se rechaza y queda registrado como rechazado', () => {
  svc.recharge(cajero, { uid: UID_A, amount_cents: 1000 });
  const r = buy(UID_A, [[prods.chocolate, 1]]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Saldo insuficiente/);
  assert.equal(balance(UID_A), 1000);
  const mv = svc.listMovements(tutorA, { child_id: childA.id, status: 'rechazado' });
  assert.equal(mv.length, 1);
  assert.match(mv[0].reason, /Saldo insuficiente/);
});

test('límite por compra', () => {
  svc.recharge(cajero, { uid: UID_A, amount_cents: 10000 });
  svc.setLimits(tutorA, childA.id, { per_transaction_cents: 2000 });
  const r = buy(UID_A, [[prods.chocolate, 2]]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /límite por compra/);
  assert.equal(buy(UID_A, [[prods.chocolate, 1]]).ok, true);
});

test('límite diario (y se reinicia al día siguiente)', () => {
  svc.recharge(cajero, { uid: UID_A, amount_cents: 10000 });
  svc.setLimits(tutorA, childA.id, { per_day_cents: 3000 });
  assert.equal(buy(UID_A, [[prods.chocolate, 1]]).ok, true); // 15
  assert.equal(buy(UID_A, [[prods.manzana, 1]]).ok, true); // 23
  const r = buy(UID_A, [[prods.manzana, 1]]); // 31 > 30
  assert.equal(r.ok, false);
  assert.match(r.reason, /límite diario/);
  clock = new Date(2026, 9, 8, 9, 0, 0);
  assert.equal(buy(UID_A, [[prods.manzana, 1]]).ok, true);
});

test('límite semanal / mensual', () => {
  svc.recharge(cajero, { uid: UID_A, amount_cents: 20000 });
  svc.setLimits(tutorA, childA.id, { period_type: 'semana', per_period_cents: 3000 });
  assert.equal(buy(UID_A, [[prods.chocolate, 1]]).ok, true);
  clock = new Date(2026, 9, 9, 10, 0, 0); // viernes misma semana
  const r = buy(UID_A, [[prods.chocolate, 1], [prods.manzana, 1]]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /límite semanal/);
  clock = new Date(2026, 9, 12, 10, 0, 0); // lunes siguiente
  assert.equal(buy(UID_A, [[prods.chocolate, 1]]).ok, true);
  svc.setLimits(tutorA, childA.id, { period_type: 'mes', per_period_cents: 4000 });
  assert.match(buy(UID_A, [[prods.chocolate, 1]]).reason, /límite mensual/);
});

test('producto prohibido', () => {
  svc.recharge(cajero, { uid: UID_A, amount_cents: 10000 });
  svc.setProhibitions(tutorA, childA.id, { product_ids: [prods.coca] });
  const r = buy(UID_A, [[prods.manzana, 1], [prods.coca, 1]]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'Producto prohibido por el tutor: Coca-Cola');
  assert.equal(balance(UID_A), 10000);
  assert.equal(buy(UID_A, [[prods.jugo, 1]]).ok, true);
});

test('categoría prohibida', () => {
  svc.recharge(cajero, { uid: UID_A, amount_cents: 10000 });
  svc.setProhibitions(tutorA, childA.id, { category_ids: [cats.refrescos] });
  const r = buy(UID_A, [[prods.jugo, 1]]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /Categoría prohibida por el tutor: Refrescos/);
  assert.equal(buy(UID_A, [[prods.manzana, 1]]).ok, true);
});

test('tutor no puede acceder al alumno de otro tutor', () => {
  assert.throws(() => svc.childSummary(tutorA, childB.id), /No tienes acceso/);
  assert.throws(() => svc.setLimits(tutorA, childB.id, { per_day_cents: 100 }), /No tienes acceso/);
  assert.throws(() => svc.setProhibitions(tutorA, childB.id, { product_ids: [] }), /No tienes acceso/);
  assert.throws(() => svc.listMovements(tutorA, { child_id: childB.id }), /No tienes acceso/);
  const cardB = db.get('SELECT id FROM cards WHERE uid = ?', [UID_B]).id;
  assert.throws(() => svc.setCardStatus(tutorA, cardB, 'bloqueada'), /No tienes acceso/);
  assert.deepEqual(svc.listChildren(tutorA).map((c) => c.id), [childA.id]);
  svc.recharge(cajero, { uid: UID_B, amount_cents: 1000 });
  assert.equal(svc.listMovements(tutorA).length, 0);
});

test('tutor no puede usar funciones de administración', () => {
  assert.throws(() => svc.dashboard(tutorA), /permiso/);
  assert.throws(() => svc.createProduct(tutorA, { name: 'X', category_id: cats.dulces, price_cents: 100 }), /permiso/);
  assert.throws(() => svc.purchase(tutorA, { uid: UID_A, items: [{ product_id: prods.manzana, qty: 1 }] }), /permiso/);
  assert.throws(() => svc.listCards(tutorA), /permiso/);
  assert.throws(() => svc.dashboard(null), /Sesión/);
});

test('tarjeta bloqueada por el tutor rechaza compras', () => {
  svc.recharge(cajero, { uid: UID_A, amount_cents: 10000 });
  const cardA = db.get('SELECT id FROM cards WHERE uid = ?', [UID_A]).id;
  svc.setCardStatus(tutorA, cardA, 'bloqueada');
  const r = buy(UID_A, [[prods.manzana, 1]]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /bloqueada temporalmente por el tutor/);
  svc.setCardStatus(tutorA, cardA, 'activa');
  assert.equal(buy(UID_A, [[prods.manzana, 1]]).ok, true);
});

test('reporte de tarjeta perdida transfiere saldo a la nueva', () => {
  svc.recharge(cajero, { uid: UID_A, amount_cents: 7000 });
  const cardA = db.get('SELECT id FROM cards WHERE uid = ?', [UID_A]).id;
  const r = svc.reportLostAndReplace(admin, cardA, '04-cc-cc-cc-cc-cc-cc');
  assert.equal(r.transferred_cents, 7000);
  assert.equal(balance('04CCCCCCCCCCCC'), 7000);
  assert.equal(balance(UID_A), 0);
  const old = buy(UID_A, [[prods.manzana, 1]]);
  assert.equal(old.ok, false);
  assert.match(old.reason, /perdida/);
});

test('validación de entradas', () => {
  assert.throws(() => svc.recharge(cajero, { uid: UID_A, amount_cents: -5 }), /no es válido/);
  assert.throws(() => svc.recharge(cajero, { uid: UID_A, amount_cents: 10.5 }), /no es válido/);
  assert.throws(() => svc.createProduct(admin, { name: '', category_id: cats.dulces, price_cents: 100 }), /obligatorio/);
  assert.throws(() => svc.registerCard(admin, { uid: UID_A }), /ya está registrada/);
  assert.throws(() => svc.purchase(cajero, { uid: UID_A, items: [] }), /vacío/);
  assert.throws(() => svc.login('admin', 'mala'), /incorrectos/);
});

test('la base se guarda en archivo y persiste al reabrir', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coop-')), 'test.db');
  const d1 = await openDatabase(file);
  const { seed } = require('../src/core/seed');
  seed(d1, { withSamples: false });
  d1.close();
  const d2 = await openDatabase(file);
  const s2 = createService(d2);
  const a = s2.login('admin', 'admin123');
  assert.equal(s2.listProducts(a).length, 15);
  assert.equal(s2.listChildren(a).length, 3);
});
