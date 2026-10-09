'use strict';
// Capa de acceso a SQLite usando sql.js (SQLite compilado a WebAssembly).
// Se eligió sql.js para evitar módulos nativos: el mismo código corre en Node (tests),
// en Electron (Windows/macOS/Linux) y se empaqueta sin recompilar nada.
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { mxDate, addDays, TRIAL_DAYS } = require('./billing');

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prueba' CHECK (status IN ('activa','prueba','pausada')),
  plan_note TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  primary_device_id TEXT,
  created_at TEXT NOT NULL,
  period_start TEXT,
  period_end TEXT,
  paused_at TEXT,
  pause_reason TEXT,
  billing_notice TEXT
);
-- Mensualidad: historial de pagos por escuela (servidor)
CREATE TABLE IF NOT EXISTS school_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER NOT NULL REFERENCES schools(id),
  paid_at TEXT NOT NULL,
  amount_cents INTEGER,
  note TEXT,
  period_start TEXT,
  period_end TEXT,
  prev_end TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_school_payments ON school_payments(school_id, id);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin','admin','cajero','tutor')),
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  school_id INTEGER REFERENCES schools(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS children (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT,
  school_id INTEGER REFERENCES schools(id),
  tutor_id INTEGER REFERENCES users(id),
  full_name TEXT NOT NULL,
  grade TEXT,
  photo TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT,
  school_id INTEGER REFERENCES schools(id),
  uid TEXT NOT NULL UNIQUE,
  child_id INTEGER REFERENCES children(id),
  status TEXT NOT NULL DEFAULT 'activa' CHECK (status IN ('activa','bloqueada','perdida','sin_asignar')),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  blocked_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT,
  school_id INTEGER REFERENCES schools(id),
  name TEXT NOT NULL COLLATE NOCASE,
  UNIQUE (school_id, name)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT,
  school_id INTEGER REFERENCES schools(id),
  name TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT,
  school_id INTEGER REFERENCES schools(id),
  type TEXT NOT NULL CHECK (type IN ('compra','recarga','ajuste')),
  status TEXT NOT NULL CHECK (status IN ('aprobado','rechazado')),
  reason TEXT,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER,
  card_id INTEGER REFERENCES cards(id),
  card_uid TEXT,
  child_id INTEGER REFERENCES children(id),
  user_id INTEGER REFERENCES users(id),
  processed_by_name TEXT,
  note TEXT,
  origin_device TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_child_date ON transactions(child_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(created_at);
CREATE TABLE IF NOT EXISTS transaction_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  category_name TEXT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL,
  subtotal_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS limits (
  child_id INTEGER PRIMARY KEY REFERENCES children(id),
  per_transaction_cents INTEGER,
  per_day_cents INTEGER,
  period_type TEXT CHECK (period_type IN ('semana','mes') OR period_type IS NULL),
  per_period_cents INTEGER,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS prohibited_products (
  child_id INTEGER NOT NULL REFERENCES children(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  PRIMARY KEY (child_id, product_id)
);
CREATE TABLE IF NOT EXISTS prohibited_categories (
  child_id INTEGER NOT NULL REFERENCES children(id),
  category_id INTEGER NOT NULL REFERENCES categories(id),
  PRIMARY KEY (child_id, category_id)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
-- Autenticación (usado por el servidor; inofensivo en la app de escritorio)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
-- Sincronización
CREATE TABLE IF NOT EXISTS sync_outbox (            -- escritorio: cambios pendientes de enviar
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sync_changes (           -- servidor: bitácora de ajustes para que los equipos los descarguen
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER,
  entity TEXT NOT NULL,
  key_uuid TEXT NOT NULL,
  origin_device TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sync_changes_key ON sync_changes(entity, key_uuid, seq);
CREATE TABLE IF NOT EXISTS devices (                -- servidor: equipos de escritorio vinculados
  id TEXT PRIMARY KEY,
  school_id INTEGER REFERENCES schools(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id),
  revoked INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
-- Seguridad (servidor): bitácora de auditoría, alertas y ajustes por escuela
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  actor_id INTEGER,
  actor_name TEXT,
  actor_role TEXT,
  school_id INTEGER,
  ip TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details TEXT,
  severity TEXT NOT NULL DEFAULT 'info'
);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(created_at);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  school_id INTEGER,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'media',
  message TEXT NOT NULL,
  details TEXT,
  ref_type TEXT,
  ref_id INTEGER,
  ack_at TEXT,
  ack_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts(ack_at, created_at);
CREATE TABLE IF NOT EXISTS school_security (
  school_id INTEGER PRIMARY KEY REFERENCES schools(id),
  freeze_recharges INTEGER NOT NULL DEFAULT 0,
  freeze_sales INTEGER NOT NULL DEFAULT 0,
  read_only INTEGER NOT NULL DEFAULT 0,
  daily_recharge_limit_cents INTEGER,
  large_recharge_cents INTEGER,
  hours_start TEXT,
  hours_end TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  child_id INTEGER NOT NULL REFERENCES children(id),
  created_by INTEGER REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_by INTEGER REFERENCES users(id),
  used_at TEXT,
  created_at TEXT NOT NULL
);
-- Solicitudes de cambio de datos del alumno (el tutor pide; el administrador de la escuela aprueba o rechaza)
CREATE TABLE IF NOT EXISTS child_change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER REFERENCES schools(id),
  child_id INTEGER NOT NULL REFERENCES children(id),
  tutor_id INTEGER REFERENCES users(id),
  field TEXT NOT NULL CHECK (field IN ('nombre','grado','otro')),
  old_value TEXT,
  new_value TEXT,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','aprobada','rechazada')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  resolved_by_name TEXT,
  reject_reason TEXT,
  admin_read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ccr_school ON child_change_requests(school_id, status, id);
CREATE INDEX IF NOT EXISTS idx_ccr_child ON child_change_requests(child_id, id);
-- Notificaciones push (Web Push) de los padres: una fila por navegador/teléfono suscrito
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
-- Preferencias de avisos del tutor (qué avisos quiere y el umbral de saldo bajo)
CREATE TABLE IF NOT EXISTS push_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  purchases INTEGER NOT NULL DEFAULT 1,
  rejected INTEGER NOT NULL DEFAULT 1,
  low_balance INTEGER NOT NULL DEFAULT 1,
  low_balance_cents INTEGER NOT NULL DEFAULT 5000,
  updated_at TEXT
);
-- Saldo bajo ya avisado (una vez por cruce del umbral) por alumno
CREATE TABLE IF NOT EXISTS low_balance_state (
  child_id INTEGER PRIMARY KEY REFERENCES children(id),
  notified INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
-- Inventario: entradas y movimientos de existencias (bitácora)
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER REFERENCES schools(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  kind TEXT NOT NULL,
  qty INTEGER NOT NULL,
  stock_after INTEGER,
  note TEXT,
  transaction_id INTEGER,
  user_id INTEGER,
  user_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stock_moves ON stock_moves(product_id, id);
-- Avisos para la escuela (p. ej. inventario por agotarse) en su sección Notificaciones
CREATE TABLE IF NOT EXISTS school_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school_id INTEGER REFERENCES schools(id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_school_notices ON school_notices(school_id, id);
`;

const SYNC_TABLES = ['users', 'categories', 'products', 'children', 'cards', 'transactions'];
const UUID_SQL = 'lower(hex(randomblob(16)))';
// Definiciones usadas al reconstruir tablas en migraciones
const TABLE_DEFS = {};
for (const m of SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\n\);/g)) TABLE_DEFS[m[1]] = m[0];
let SQL = null;
async function loadSql() {
  if (SQL) return SQL;
  const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
  SQL = await initSqlJs({ wasmBinary: fs.readFileSync(wasmPath) });
  return SQL;
}

class Database {
  constructor(sqlDb, filePath) {
    this.db = sqlDb;
    this.filePath = filePath || null;
    this.depth = 0;
    this.db.exec(SCHEMA);
    this._migrate();
  }
  // Migraciones simples para bases creadas con versiones anteriores
  _migrate() {
    const colsOf = (t) => this.all(`PRAGMA table_info(${t})`).map((c) => c.name);
    const sqlOf = (t) => (this.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [t]) || {}).sql || '';
    // Reconstruye una tabla con la definición nueva conservando los datos (para cambiar CHECK/UNIQUE)
    // exprs: expresión SQL opcional por columna para transformar valores al copiar
    const rebuild = (t, exprs = {}) => {
      const def = TABLE_DEFS[t];
      const oldCols = colsOf(t);
      this.db.exec(`PRAGMA foreign_keys = OFF; DROP TABLE IF EXISTS ${t}__new;`);
      this.db.exec(def.replace(`CREATE TABLE IF NOT EXISTS ${t} (`, `CREATE TABLE ${t}__new (`));
      const commonCols = colsOf(`${t}__new`).filter((c) => oldCols.includes(c));
      const common = commonCols.join(', ');
      const select = commonCols.map((c) => exprs[c] || c).join(', ');
      this.db.exec(`INSERT INTO ${t}__new (${common}) SELECT ${select} FROM ${t}; DROP TABLE ${t}; ALTER TABLE ${t}__new RENAME TO ${t}; PRAGMA foreign_keys = ON;`);
    };
    if (!sqlOf('users').includes('superadmin')) rebuild('users');
    if (!sqlOf('categories').includes('UNIQUE (school_id, name)')) rebuild('categories');
    // Mensualidad: el estado "suspendida" pasa a llamarse "pausada" (se conservan todos los datos de la escuela)
    if (!sqlOf('schools').includes("'pausada'")) rebuild('schools', { status: "CASE WHEN status = 'suspendida' THEN 'pausada' WHEN status IN ('activa','prueba','pausada') THEN status ELSE 'prueba' END" });
    for (const c of ['period_start', 'period_end', 'paused_at', 'pause_reason', 'billing_notice']) if (!colsOf('schools').includes(c)) this.db.exec(`ALTER TABLE schools ADD COLUMN ${c} TEXT`);
    // Escuelas existentes al introducir la mensualidad: quedan en PRUEBA por 30 días desde hoy (hora de la
    // Ciudad de México) para que ninguna se pause de forma inesperada. Las que estaban suspendidas siguen pausadas.
    if (!this.get("SELECT value FROM meta WHERE key = 'billing_v1'")) {
      const t = mxDate();
      this.db.run("UPDATE schools SET status = 'prueba', period_start = ?, period_end = ? WHERE status <> 'pausada'", [t, addDays(t, TRIAL_DAYS)]);
      this.db.run("UPDATE schools SET paused_at = COALESCE(paused_at, datetime('now','localtime')), pause_reason = COALESCE(pause_reason, 'manual') WHERE status = 'pausada'");
      this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('billing_v1', ?)", [t]);
    }
    const add = (t, c, def) => { if (!colsOf(t).includes(c)) this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
    add('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
    add('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
    add('transactions', 'processed_by_name', 'TEXT');
    add('transactions', 'origin_device', 'TEXT');
    // Seguridad: último acceso, bloqueo por intentos fallidos, papelera (borrado lógico), recargas marcadas
    add('users', 'last_login_at', 'TEXT');
    add('users', 'last_login_ip', 'TEXT');
    add('users', 'failed_logins', 'INTEGER NOT NULL DEFAULT 0');
    add('users', 'locked_until', 'INTEGER');
    add('users', 'password_set_at', 'TEXT');
    add('users', 'password_set_by', 'TEXT');
    add('products', 'deleted_at', 'TEXT');
    // Política de contraseñas: solo el superadministrador cambia contraseñas, así que nadie más
    // puede quedar obligado a cambiarla (se quedaría sin poder entrar).
    this.db.exec("UPDATE users SET must_change_password = 0 WHERE role <> 'superadmin' AND must_change_password <> 0");
    add('transactions', 'flag', 'TEXT');
    // v2.1: inventario (en blanco = sin control), venta cancelada y bloqueo de venta sin existencias
    add('products', 'stock', 'INTEGER');
    add('products', 'stock_min', 'INTEGER');
    add('products', 'low_notified', 'INTEGER NOT NULL DEFAULT 0');
    add('transactions', 'reversed_at', 'TEXT');
    add('transactions', 'reversed_by', 'TEXT');
    add('schools', 'stock_block_zero', 'INTEGER NOT NULL DEFAULT 1');
    add('transactions', 'flag_note', 'TEXT');
    for (const t of ['users', 'children', 'cards', 'categories', 'products', 'transactions', 'devices', 'sync_changes']) add(t, 'school_id', 'INTEGER');
    // Identificador global (UUID de 128 bits) para sincronizar sin depender de los id locales
    for (const t of SYNC_TABLES) {
      add(t, 'uuid', 'TEXT');
      this.db.exec(`UPDATE ${t} SET uuid = ${UUID_SQL} WHERE uuid IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_uuid ON ${t}(uuid);
        CREATE TRIGGER IF NOT EXISTS trg_${t}_uuid AFTER INSERT ON ${t} WHEN NEW.uuid IS NULL
        BEGIN UPDATE ${t} SET uuid = ${UUID_SQL} WHERE id = NEW.id; END;`);
    }
    this.db.exec(`UPDATE schools SET uuid = ${UUID_SQL} WHERE uuid IS NULL;
      CREATE TRIGGER IF NOT EXISTS trg_schools_uuid AFTER INSERT ON schools WHEN NEW.uuid IS NULL
      BEGIN UPDATE schools SET uuid = ${UUID_SQL} WHERE id = NEW.id; END;`);
    // Datos de versiones anteriores (una sola escuela): se asignan a una institución por defecto
    const orphan = ['children', 'cards', 'categories', 'products', 'transactions'].some((t) => this.get(`SELECT 1 AS x FROM ${t} WHERE school_id IS NULL LIMIT 1`))
      || this.get("SELECT 1 AS x FROM users WHERE school_id IS NULL AND role IN ('admin','cajero') LIMIT 1");
    if (orphan) {
      let sch = this.get('SELECT id FROM schools ORDER BY id LIMIT 1');
      if (!sch) {
        this.db.exec("INSERT INTO schools (name, status, created_at) VALUES ('Mi escuela', 'activa', datetime('now','localtime'))");
        sch = this.get('SELECT id FROM schools ORDER BY id LIMIT 1');
      }
      for (const t of ['children', 'cards', 'categories', 'products', 'transactions', 'devices', 'sync_changes']) this.db.exec(`UPDATE ${t} SET school_id = ${sch.id} WHERE school_id IS NULL`);
      this.db.exec(`UPDATE users SET school_id = ${sch.id} WHERE school_id IS NULL AND role <> 'superadmin'`);
      const prim = this.get("SELECT value FROM meta WHERE key = 'sync_primary_device'");
      if (prim) { this.run('UPDATE schools SET primary_device_id = ? WHERE id = ? AND primary_device_id IS NULL', [prim.value, sch.id]); this.db.exec("DELETE FROM meta WHERE key = 'sync_primary_device'"); }
    }
    // Los movimientos heredan la escuela de su tarjeta (o alumno) si no se indica
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS trg_tx_school AFTER INSERT ON transactions WHEN NEW.school_id IS NULL
      BEGIN UPDATE transactions SET school_id = COALESCE((SELECT school_id FROM cards WHERE id = NEW.card_id), (SELECT school_id FROM children WHERE id = NEW.child_id)) WHERE id = NEW.id; END;
      CREATE INDEX IF NOT EXISTS idx_children_school ON children(school_id);
      CREATE INDEX IF NOT EXISTS idx_cards_school ON cards(school_id);
      CREATE INDEX IF NOT EXISTS idx_tx_school_date ON transactions(school_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sync_changes_school ON sync_changes(school_id, seq);`);
    // Protección del superadministrador: no se puede borrar, degradar ni desactivar (ni por SQL de la app)
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS trg_superadmin_nodelete BEFORE DELETE ON users WHEN OLD.role = 'superadmin'
        BEGIN SELECT RAISE(ABORT, 'El superadministrador no se puede eliminar'); END;
      CREATE TRIGGER IF NOT EXISTS trg_superadmin_nodemote BEFORE UPDATE OF role ON users WHEN OLD.role = 'superadmin' AND NEW.role <> 'superadmin'
        BEGIN SELECT RAISE(ABORT, 'El superadministrador no se puede degradar'); END;
      CREATE TRIGGER IF NOT EXISTS trg_superadmin_noinactive BEFORE UPDATE OF active ON users WHEN OLD.role = 'superadmin' AND NEW.active = 0
        BEGIN SELECT RAISE(ABORT, 'El superadministrador no se puede desactivar'); END;`);
  }
  // Ganchos tras guardar en disco (p. ej. copia remota de la base)
  onSave(fn) { (this._saveHooks = this._saveHooks || []).push(fn); }
  // Escritorio: registra en sync_outbox cada alta/cambio de las tablas sincronizadas.
  // No registra cambios aplicados desde el servidor (meta sync_applying = '1').
  enableOutbox() {
    const guard = "(SELECT value FROM meta WHERE key = 'sync_applying') IS NOT '1'";
    const add = (name, table, ev, entity, rowExpr) => this.db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${ev} ON ${table} WHEN ${guard}
      BEGIN INSERT INTO sync_outbox (entity, row_id) VALUES ('${entity}', ${rowExpr}); END;`);
    for (const [t, e] of [['categories', 'category'], ['products', 'product'], ['children', 'child'], ['cards', 'card'], ['transactions', 'transaction'], ['limits', 'limits']]) {
      const key = t === 'limits' ? 'child_id' : 'id';
      add(`trg_ob_${t}_i`, t, 'INSERT', e, `NEW.${key}`);
      add(`trg_ob_${t}_u`, t, 'UPDATE', e, `NEW.${key}`);
    }
    for (const t of ['prohibited_products', 'prohibited_categories']) {
      add(`trg_ob_${t}_i`, t, 'INSERT', 'prohibitions', 'NEW.child_id');
      add(`trg_ob_${t}_d`, t, 'DELETE', 'prohibitions', 'OLD.child_id');
    }
  }
  _bind(params) {
    if (params === undefined || params === null) return [];
    return params;
  }
  all(sql, params) {
    const st = this.db.prepare(sql);
    try {
      st.bind(this._bind(params));
      const rows = [];
      while (st.step()) rows.push(st.getAsObject());
      return rows;
    } finally { st.free(); }
  }
  get(sql, params) { return this.all(sql, params)[0]; }
  run(sql, params) {
    const st = this.db.prepare(sql);
    try { st.run(this._bind(params)); } finally { st.free(); }
    const changes = this.db.getRowsModified();
    const lastId = this.db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
    if (this.depth === 0) this.save();
    return { changes, lastId };
  }
  // Ejecuta fn dentro de una transacción atómica (BEGIN IMMEDIATE ... COMMIT / ROLLBACK).
  transaction(fn) {
    if (this.depth > 0) { // anidada: se ejecuta dentro de la externa
      return fn();
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const r = fn();
      this.depth--;
      this.db.exec('COMMIT');
      this.save();
      return r;
    } catch (e) {
      this.depth--;
      try { this.db.exec('ROLLBACK'); } catch (_) { /* ignorar */ }
      throw e;
    }
  }
  // Guarda la base en disco de forma atómica (archivo temporal + rename).
  save() {
    if (!this.filePath) { this._runSaveHooks(); return; }
    const data = Buffer.from(this.db.export());
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.filePath);
    // export() desactiva foreign_keys en sql.js; se reactiva
    this.db.exec('PRAGMA foreign_keys = ON;');
    this._runSaveHooks();
  }
  _runSaveHooks() { for (const fn of this._saveHooks || []) { try { fn(); } catch (e) { console.error('[db] gancho de guardado:', e.message); } } }
  exportBuffer() { return Buffer.from(this.db.export()); }
  close() { this.db.close(); }
}

async function openDatabase(filePath, opts = {}) {
  const S = await loadSql();
  let sqlDb;
  if (filePath && fs.existsSync(filePath)) {
    sqlDb = new S.Database(fs.readFileSync(filePath));
  } else {
    if (filePath) fs.mkdirSync(path.dirname(filePath), { recursive: true });
    sqlDb = new S.Database();
  }
  const db = new Database(sqlDb, filePath);
  if (opts.syncOutbox) db.enableOutbox();
  db.save();
  return db;
}

module.exports = { openDatabase, Database };
