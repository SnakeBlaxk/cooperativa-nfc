'use strict';
// Datos de demostración: admin, cajero, 2 tutores, 3 alumnos, tarjetas, 15 productos y movimientos de ejemplo.
const { createService } = require('./service');

function isEmpty(db) { return db.get("SELECT COUNT(*) AS n FROM users WHERE role <> 'superadmin'").n === 0; }

// Escuela por defecto (escritorio: el equipo trabaja con una sola escuela)
function ensureDefaultSchool(db, name = 'Mi escuela') {
  const s = db.get('SELECT id FROM schools ORDER BY id LIMIT 1');
  if (s) return s.id;
  return db.run("INSERT INTO schools (name, status, created_at) VALUES (?, 'activa', datetime('now','localtime'))", [name]).lastId;
}

// Tarjetas de demostración: se agregan al inventario de Zuki Company como entregadas a su escuela
function stockDemoCards(db) {
  db.run(`INSERT OR IGNORE INTO card_stock (uid, kind, status, school_id, batch, note, delivered_at, created_at)
    SELECT uid, 'normal', CASE WHEN child_id IS NOT NULL AND status IN ('activa','bloqueada') THEN 'asignada' ELSE 'entregada' END, school_id, 'DEMO', 'Tarjeta de demostración', created_at, created_at FROM cards WHERE school_id IS NOT NULL`);
}

function seed(db, { withSamples = true, schoolName = 'Mi escuela' } = {}) {
  if (!isEmpty(db)) return false;
  let clock = new Date();
  const schoolId = ensureDefaultSchool(db, schoolName);
  const svc = createService(db, { now: () => clock, schoolId });
  const bcrypt = require('bcryptjs');
  db.transaction(() => {
    // usuario admin inicial (directo, porque createUser requiere un admin)
    db.run("INSERT INTO users (username,password_hash,role,full_name,school_id,created_at) VALUES ('admin',?,'admin','Administrador Cooperativa',?,datetime('now','localtime'))", [bcrypt.hashSync('admin123', 10), schoolId]);
    const admin = svc.login('admin', 'admin123');
    svc.createUser(admin, { role: 'cajero', username: 'cajero', password: 'cajero123', full_name: 'Cajera Rosa López' });
    const t1 = svc.createUser(admin, { role: 'tutor', username: 'maria', password: 'tutor123', full_name: 'María Hernández', phone: '443 123 4567', email: 'maria@example.com' });
    const t2 = svc.createUser(admin, { role: 'tutor', username: 'juan', password: 'tutor123', full_name: 'Juan Pérez', phone: '443 765 4321', email: 'juan@example.com' });

    const cats = {};
    for (const n of ['Dulces', 'Refrescos', 'Frituras', 'Saludable', 'Comida']) cats[n] = svc.createCategory(admin, { name: n }).id;
    const P = [
      ['Paleta de caramelo', 'Dulces', 500], ['Chocolate', 'Dulces', 1500], ['Gomitas', 'Dulces', 1000], ['Mazapán', 'Dulces', 600],
      ['Coca-Cola 355 ml', 'Refrescos', 1800], ['Jugo de naranja', 'Refrescos', 1500], ['Agua natural 600 ml', 'Refrescos', 1000],
      ['Papas fritas', 'Frituras', 1800], ['Churritos', 'Frituras', 1200], ['Palomitas', 'Frituras', 1000],
      ['Manzana', 'Saludable', 800], ['Yogur', 'Saludable', 1400], ['Barra de granola', 'Saludable', 1200], ['Pepino con limón', 'Saludable', 1500],
      ['Sándwich de jamón', 'Comida', 2500],
    ];
    const prod = {};
    for (const [name, cat, price] of P) prod[name] = svc.createProduct(admin, { name, category_id: cats[cat], price_cents: price }).id;

    const sofia = svc.createChild(admin, { tutor_id: t1.id, full_name: 'Sofía Hernández', grade: '3° A' });
    const diego = svc.createChild(admin, { tutor_id: t1.id, full_name: 'Diego Hernández', grade: '5° B' });
    const vale = svc.createChild(admin, { tutor_id: t2.id, full_name: 'Valentina Pérez', grade: '4° A' });
    svc.registerCard(admin, { uid: '04A1B2C3D4E5F6', child_id: sofia.id });
    svc.registerCard(admin, { uid: '04B7C8D9E0F1A2', child_id: diego.id });
    svc.registerCard(admin, { uid: '04C3D4E5F6A7B8', child_id: vale.id });
    svc.registerCard(admin, { uid: '04D9E0F1A2B3C4' }); // tarjeta en inventario sin asignar

    svc.setLimits(t1, sofia.id, { per_transaction_cents: 5000, per_day_cents: 6000, period_type: 'semana', per_period_cents: 25000 });
    svc.setProhibitions(t1, sofia.id, { product_ids: [prod['Coca-Cola 355 ml']], category_ids: [] });
    svc.setLimits(t1, diego.id, { per_transaction_cents: null, per_day_cents: 8000, period_type: null, per_period_cents: null });
    svc.setProhibitions(t1, diego.id, { product_ids: [], category_ids: [cats['Refrescos']] });
    svc.setLimits(t2, vale.id, { per_transaction_cents: 4000, per_day_cents: null, period_type: 'mes', per_period_cents: 60000 });

    if (withSamples) {
      const cajero = svc.login('cajero', 'cajero123');
      const base = new Date();
      const at = (daysAgo, h, m) => { const d = new Date(base); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d; };
      clock = at(13, 7, 50);
      svc.recharge(cajero, { uid: '04A1B2C3D4E5F6', amount_cents: 30000, note: 'Recarga inicial' });
      svc.recharge(cajero, { uid: '04B7C8D9E0F1A2', amount_cents: 40000, note: 'Recarga inicial' });
      svc.recharge(cajero, { uid: '04C3D4E5F6A7B8', amount_cents: 25000, note: 'Recarga inicial' });
      const buys = [
        ['04A1B2C3D4E5F6', [['Manzana', 1], ['Jugo de naranja', 1]]],
        ['04B7C8D9E0F1A2', [['Sándwich de jamón', 1], ['Manzana', 1]]],
        ['04C3D4E5F6A7B8', [['Papas fritas', 1], ['Gomitas', 1]]],
        ['04A1B2C3D4E5F6', [['Yogur', 1]]],
        ['04B7C8D9E0F1A2', [['Churritos', 1], ['Barra de granola', 1]]],
        ['04C3D4E5F6A7B8', [['Pepino con limón', 1]]],
      ];
      let i = 0;
      for (let d = 12; d >= 0; d--) {
        const dt = at(d, 0, 0);
        if (dt.getDay() === 0 || dt.getDay() === 6) continue; // solo días hábiles
        for (let j = 0; j < 2; j++) {
          const [uid, items] = buys[i++ % buys.length];
          clock = at(d, 10, 15 + j * 7);
          svc.purchase(cajero, { uid, items: items.map(([n, q]) => ({ product_id: prod[n], qty: q })) });
        }
      }
      clock = at(1, 10, 40);
      svc.purchase(cajero, { uid: '04A1B2C3D4E5F6', items: [{ product_id: prod['Coca-Cola 355 ml'], qty: 1 }] }); // rechazada: prohibido
      svc.purchase(cajero, { uid: '04B7C8D9E0F1A2', items: [{ product_id: prod['Jugo de naranja'], qty: 1 }] }); // rechazada: categoría
      clock = at(0, 7, 45);
      svc.recharge(cajero, { uid: '04C3D4E5F6A7B8', amount_cents: 10000, note: 'Recarga semanal' });
      clock = new Date();
    }
  });
  stockDemoCards(db);
  return true;
}

// Base limpia para producción: solo un administrador (debe cambiar la contraseña) y categorías básicas.
function seedMinimal(db, { username = 'admin', password = 'admin123', schoolName = 'Mi escuela' } = {}) {
  if (!isEmpty(db)) return false;
  const bcrypt = require('bcryptjs');
  db.transaction(() => {
    const sid = ensureDefaultSchool(db, schoolName);
    db.run("INSERT INTO users (username,password_hash,role,full_name,must_change_password,school_id,created_at) VALUES (?,?,'admin','Administrador',0,?,datetime('now','localtime'))", [username, bcrypt.hashSync(password, 10), sid]);
    for (const n of DEFAULT_CATEGORIES) db.run('INSERT INTO categories (school_id, name) VALUES (?, ?)', [sid, n]);
  });
  return true;
}
const DEFAULT_CATEGORIES = ['Dulces', 'Refrescos', 'Frituras', 'Saludable', 'Comida'];

// Superadministrador de la plataforma (Zuki Company)
function ensureSuperadmin(db, { username = 'zuki', password = 'zuki123', mustChange = false } = {}) {
  const bcrypt = require('bcryptjs');
  const u = db.get('SELECT id FROM users WHERE username = ?', [username]);
  if (u) return u.id;
  return db.run("INSERT INTO users (username,password_hash,role,full_name,must_change_password,created_at) VALUES (?,?,'superadmin','Zuki Company',?,datetime('now','localtime'))",
    [username, bcrypt.hashSync(password, 10), mustChange ? 1 : 0]).lastId;
}

// Demo del servidor: superadmin + 2 escuelas. Escuela 1 = demo completo; escuela 2 = demo pequeño.
// María (tutora) tiene hijos en ambas escuelas.
function seedPlatform(db) {
  if (!isEmpty(db)) { ensureSuperadmin(db); return false; }
  seed(db, { schoolName: 'Colegio Morelos (demo)' });
  db.run("UPDATE schools SET plan_note = 'Plan anual · $1,500 MXN/mes', contact_name = 'Lic. Ana Torres', contact_phone = '4431112233' WHERE id = 1");
  ensureSuperadmin(db);
  // Caja de demostración (no utilizable: token aleatorio desconocido) para ver "última sincronización"
  const crypto = require('crypto');
  const fiveMin = new Date(Date.now() - 5 * 60e3);
  const pad = (n) => String(n).padStart(2, '0');
  const seen = `${fiveMin.getFullYear()}-${pad(fiveMin.getMonth() + 1)}-${pad(fiveMin.getDate())} ${pad(fiveMin.getHours())}:${pad(fiveMin.getMinutes())}:00`;
  const devId = crypto.randomBytes(16).toString('hex');
  db.run("INSERT INTO devices (id, school_id, name, token_hash, revoked, last_seen_at, created_at) VALUES (?, 1, 'Caja principal (demo)', ?, 0, ?, datetime('now','localtime'))", [devId, crypto.randomBytes(32).toString('hex'), seen]);
  const bcrypt = require('bcryptjs');
  let clock = new Date();
  db.transaction(() => {
    const sid = db.run("INSERT INTO schools (name, status, plan_note, contact_name, created_at) VALUES ('Instituto Valladolid (demo)', 'prueba', 'Prueba gratis 30 días', 'Mtro. Luis Ramos', datetime('now','localtime'))").lastId;
    const svc = createService(db, { now: () => clock, schoolId: sid });
    db.run("INSERT INTO users (username,password_hash,role,full_name,school_id,created_at) VALUES ('admin2',?,'admin','Admin Instituto Valladolid',?,datetime('now','localtime'))", [bcrypt.hashSync('admin123', 10), sid]);
    const admin = svc.login('admin2', 'admin123');
    svc.createUser(admin, { role: 'cajero', username: 'cajero2', password: 'cajero123', full_name: 'Cajero Pedro Ruiz' });
    const cats = {};
    for (const n of ['Dulces', 'Bebidas', 'Comida']) cats[n] = svc.createCategory(admin, { name: n }).id;
    const prod = {};
    for (const [n, c, p] of [['Tamal', 'Comida', 2000], ['Torta de jamón', 'Comida', 3000], ['Agua de jamaica', 'Bebidas', 1200], ['Paleta', 'Dulces', 500]]) prod[n] = svc.createProduct(admin, { name: n, category_id: cats[c], price_cents: p }).id;
    const maria = db.get("SELECT id FROM users WHERE username = 'maria'");
    const lucia = svc.createChild(admin, { full_name: 'Lucía Hernández', grade: '1° Secundaria' });
    db.run('UPDATE children SET tutor_id = ? WHERE id = ?', [maria.id, lucia.id]); // hija de María en otra escuela
    const mateo = svc.createChild(admin, { full_name: 'Mateo Gómez', grade: '2° Secundaria' });
    svc.registerCard(admin, { uid: '05A1A1A1A1A1A1', child_id: lucia.id });
    svc.registerCard(admin, { uid: '05B2B2B2B2B2B2', child_id: mateo.id });
    svc.registerCard(admin, { uid: '05C3C3C3C3C3C3' });
    const caj = svc.login('cajero2', 'cajero123');
    const d = new Date(); d.setHours(8, 0, 0, 0); clock = d;
    svc.recharge(caj, { uid: '05A1A1A1A1A1A1', amount_cents: 20000, note: 'Recarga inicial' });
    svc.recharge(caj, { uid: '05B2B2B2B2B2B2', amount_cents: 15000, note: 'Recarga inicial' });
    clock = new Date(d.getTime() + 2 * 3600e3);
    svc.purchase(caj, { uid: '05A1A1A1A1A1A1', items: [{ product_id: prod['Tamal'], qty: 1 }, { product_id: prod['Agua de jamaica'], qty: 1 }] });
    svc.purchase(caj, { uid: '05B2B2B2B2B2B2', items: [{ product_id: prod['Torta de jamón'], qty: 1 }] });
    clock = new Date();
  });
  stockDemoCards(db);
  return true;
}

module.exports = { seed, seedMinimal, seedPlatform, ensureSuperadmin, ensureDefaultSchool, isEmpty, stockDemoCards, DEFAULT_CATEGORIES };
