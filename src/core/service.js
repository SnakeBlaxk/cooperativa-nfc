'use strict';
// Lógica de negocio de la cooperativa. Independiente de Electron para poder probarla con node:test.
// Todas las funciones reciben `actor` (usuario autenticado) y validan permisos.
const bcrypt = require('bcryptjs');

class AppError extends Error {
  constructor(message, code = 'ERROR') { super(message); this.code = code; }
}

const ROLES = ['admin', 'cajero', 'tutor'];
const ALL_ROLES = ['superadmin', ...ROLES];
const CARD_STATUS = ['activa', 'bloqueada', 'perdida', 'sin_asignar'];

function pad(n) { return String(n).padStart(2, '0'); }
function fmtLocal(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function startOfWeek(d) { // lunes
  const s = startOfDay(d); const dow = (s.getDay() + 6) % 7; s.setDate(s.getDate() - dow); return s;
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function money(c) { return '$' + (c / 100).toFixed(2) + ' MXN'; }

// ---------- validación ----------
function str(v, field, { min = 1, max = 120, optional = false } = {}) {
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    if (optional) return null;
    throw new AppError(`El campo "${field}" es obligatorio`, 'VALIDACION');
  }
  if (typeof v !== 'string') throw new AppError(`El campo "${field}" debe ser texto`, 'VALIDACION');
  const s = v.trim();
  if (s.length < min || s.length > max) throw new AppError(`El campo "${field}" debe tener entre ${min} y ${max} caracteres`, 'VALIDACION');
  return s;
}
function int(v, field, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw new AppError(`El campo "${field}" es obligatorio`, 'VALIDACION');
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`El campo "${field}" no es válido`, 'VALIDACION');
  return n;
}
function cents(v, field, { optional = false, allowZero = false } = {}) {
  const n = int(v, field, { min: allowZero ? 0 : 1, max: 100000000, optional });
  return n;
}
function normEmail(e) {
  const s = String(e).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 120) throw new AppError('Correo electrónico inválido', 'VALIDACION');
  return s;
}
// Teléfono México: se guardan los últimos 10 dígitos
function normPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length < 10 || d.length > 13) return null;
  return d.slice(-10);
}
function normUid(uid) {
  const s = str(uid, 'UID de tarjeta', { min: 4, max: 64 });
  const u = s.replace(/[\s:\-]/g, '').toUpperCase();
  if (!/^[0-9A-Z]{4,64}$/.test(u)) throw new AppError('UID de tarjeta inválido', 'VALIDACION');
  return u;
}

function createService(db, opts = {}) {
  const now = opts.now || (() => new Date());
  const ts = () => fmtLocal(now());
  // Multi-escuela: el servicio puede quedar fijo a una escuela (escritorio / servidor por escuela).
  // singleSchool (escritorio): todo el personal local pertenece a la escuela del equipo.
  const S = opts.schoolId === undefined || opts.schoolId === null ? null : Number(opts.schoolId);
  const single = !!opts.singleSchool;
  function sch(actor) {
    if (!actor || actor.role === 'tutor' || actor.role === 'superadmin') return null;
    if (single && S !== null) return S;
    const a = actor.school_id === undefined || actor.school_id === null ? null : Number(actor.school_id);
    if (a === null) throw new AppError('Tu usuario no tiene escuela asignada', 'PROHIBIDO');
    if (S !== null && a !== S) throw new AppError('No tienes acceso a esta escuela', 'PROHIBIDO');
    return a;
  }
  // Fragmento SQL de filtro por escuela (id numérico validado, nunca texto del usuario)
  const scope = (actor, alias) => { const id = sch(actor); return id === null ? '' : ` AND ${alias ? alias + '.' : ''}school_id = ${id}`; };
  const schoolRow = (id) => (id ? db.get('SELECT uuid, name FROM schools WHERE id = ?', [id]) || {} : {});
  const schoolName = (id) => schoolRow(id).name || null;
  // Tutores visibles para una escuela: los de la escuela o con hijos en ella
  const TUTOR_IN_SCHOOL = (id) => `(u.school_id = ${id} OR EXISTS (SELECT 1 FROM children x WHERE x.tutor_id = u.id AND x.school_id = ${id}))`;

  // ---------- autorización ----------
  function requireRole(actor, ...roles) {
    if (!actor) throw new AppError('Sesión no iniciada', 'NO_AUTENTICADO');
    if (!roles.includes(actor.role)) throw new AppError('No tienes permiso para esta acción', 'PROHIBIDO');
  }
  function getChildOrFail(childId, actor) {
    const c = db.get(`SELECT * FROM children WHERE id = ?${scope(actor)}`, [int(childId, 'niño', { min: 1 })]);
    if (!c) throw new AppError('Alumno no encontrado', 'NO_ENCONTRADO');
    return c;
  }
  // Admin/cajero ven todos; tutor solo sus hijos.
  function assertChildAccess(actor, childId, { write = false } = {}) {
    requireRole(actor, 'admin', 'cajero', 'tutor');
    const c = getChildOrFail(childId, actor);
    if (actor.role === 'tutor' && c.tutor_id !== actor.id) throw new AppError('No tienes acceso a este alumno', 'PROHIBIDO');
    if (write && actor.role === 'cajero') throw new AppError('No tienes permiso para esta acción', 'PROHIBIDO');
    return c;
  }
  function publicUser(u) {
    if (!u) return null;
    return { id: u.id, username: u.username, role: u.role, full_name: u.full_name, phone: u.phone, email: u.email, active: !!u.active, must_change_password: !!u.must_change_password,
      school_id: u.school_id === undefined ? null : u.school_id, school_name: schoolName(u.school_id), school_uuid: schoolRow(u.school_id).uuid || null };
  }

  // ---------- auth ----------
  // Busca por usuario, correo o teléfono (10 dígitos)
  function findUserByIdentifier(identifier) {
    const id = String(identifier || '').trim();
    if (!id) return null;
    let u = db.get('SELECT * FROM users WHERE username = ?', [id]);
    if (!u && id.includes('@')) u = db.get('SELECT * FROM users WHERE lower(email) = lower(?)', [id]);
    if (!u) { const ph = normPhone(id); if (ph) u = db.get('SELECT * FROM users WHERE phone = ?', [ph]); }
    return u || null;
  }
  function login(username, password) {
    const u = findUserByIdentifier(username);
    if (!u || !u.active || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
      throw new AppError('Usuario o contraseña incorrectos', 'NO_AUTENTICADO');
    }
    assertSchoolActive(u);
    return publicUser(u);
  }
  // El personal de una escuela suspendida no puede entrar (los tutores sí, para consultar)
  function assertSchoolActive(u) {
    if (!u || !['admin', 'cajero'].includes(u.role) || !u.school_id) return;
    const s = db.get('SELECT status FROM schools WHERE id = ?', [u.school_id]);
    if (s && s.status === 'suspendida') throw new AppError('El servicio de esta escuela está suspendido. Comunícate con Zuki Company.', 'ESCUELA_SUSPENDIDA');
  }
  function changePassword(actor, current, next) {
    requireRole(actor, ...ALL_ROLES);
    const u = db.get('SELECT * FROM users WHERE id = ?', [actor.id]);
    if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw new AppError('La contraseña actual es incorrecta', 'VALIDACION');
    const p = str(next, 'nueva contraseña', { min: 6, max: 100 });
    if (p === current) throw new AppError('La nueva contraseña debe ser distinta de la actual', 'VALIDACION');
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?', [bcrypt.hashSync(p, 10), actor.id]);
    return publicUser(db.get('SELECT * FROM users WHERE id = ?', [actor.id]));
  }

  // ---------- usuarios ----------
  function createUser(actor, data) {
    requireRole(actor, 'admin');
    const role = data.role;
    if (!ROLES.includes(role)) throw new AppError('Rol inválido', 'VALIDACION');
    const email = data.email ? normEmail(data.email) : null;
    const phone = data.phone ? normPhone(data.phone) : null;
    if (data.phone && !phone) throw new AppError('Teléfono inválido (10 dígitos)', 'VALIDACION');
    // Si no se indica usuario, se usa el correo o el teléfono como identificador
    const username = str(data.username || email || phone, 'usuario', { min: 3, max: 80 });
    if (!/^[a-zA-Z0-9._@+-]+$/.test(username)) throw new AppError('El usuario solo puede tener letras, números y . _ - @', 'VALIDACION');
    const password = str(data.password, 'contraseña', { min: 6, max: 100 });
    const full_name = str(data.full_name, 'nombre', { max: 120 });
    assertUniqueIdentity(username, email, phone);
    const r = db.run('INSERT INTO users (username,password_hash,role,full_name,phone,email,must_change_password,school_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [username, bcrypt.hashSync(password, 10), role, full_name, phone, email, data.must_change_password ? 1 : 0, sch(actor), ts()]);
    return publicUser(db.get('SELECT * FROM users WHERE id = ?', [r.lastId]));
  }
  function assertUniqueIdentity(username, email, phone, exceptId = 0) {
    if (username && db.get('SELECT id FROM users WHERE username = ? AND id <> ?', [username, exceptId])) throw new AppError('Ese nombre de usuario ya existe', 'DUPLICADO');
    if (email && db.get('SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?', [email, exceptId])) throw new AppError('Ese correo ya está registrado', 'DUPLICADO');
    if (phone && db.get('SELECT id FROM users WHERE phone = ? AND id <> ?', [phone, exceptId])) throw new AppError('Ese teléfono ya está registrado', 'DUPLICADO');
  }
  function updateUser(actor, id, data) {
    requireRole(actor, 'admin');
    const u = getVisibleUser(actor, id);
    const full_name = data.full_name !== undefined ? str(data.full_name, 'nombre') : u.full_name;
    const phone = data.phone !== undefined ? (data.phone ? normPhone(data.phone) : null) : u.phone;
    if (data.phone && !phone) throw new AppError('Teléfono inválido (10 dígitos)', 'VALIDACION');
    const email = data.email !== undefined ? (data.email ? normEmail(data.email) : null) : u.email;
    assertUniqueIdentity(null, email, phone, u.id);
    const active = data.active !== undefined ? (data.active ? 1 : 0) : u.active;
    if (u.id === actor.id && !active) throw new AppError('No puedes desactivar tu propio usuario', 'VALIDACION');
    db.run('UPDATE users SET full_name=?, phone=?, email=?, active=? WHERE id=?', [full_name, phone, email, active, u.id]);
    if (data.password) {
      const p = str(data.password, 'contraseña', { min: 6, max: 100 });
      // Contraseña asignada por el admin = temporal: se obliga a cambiarla y se cierran sesiones
      db.run('UPDATE users SET password_hash=?, must_change_password=?, token_version = token_version + 1 WHERE id=?', [bcrypt.hashSync(p, 10), data.must_change_password === false ? 0 : 1, u.id]);
    }
    if (!active) db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [u.id]);
    return publicUser(db.get('SELECT * FROM users WHERE id = ?', [u.id]));
  }
  // Usuarios visibles para el personal de una escuela: su personal y sus tutores
  function visibleUsersWhere(actor) {
    const id = sch(actor);
    return id === null ? "u.role <> 'superadmin'" : `((u.role IN ('admin','cajero') AND u.school_id = ${id}) OR (u.role = 'tutor' AND ${TUTOR_IN_SCHOOL(id)}))`;
  }
  function getVisibleUser(actor, id) {
    const u = db.get(`SELECT u.* FROM users u WHERE u.id = ? AND ${visibleUsersWhere(actor)}`, [int(id, 'id', { min: 1 })]);
    if (!u) throw new AppError('Usuario no encontrado', 'NO_ENCONTRADO');
    return u;
  }
  function getVisibleTutor(actor, id) {
    const u = getVisibleUser(actor, id);
    if (u.role !== 'tutor') throw new AppError('Tutor no encontrado', 'NO_ENCONTRADO');
    return u;
  }
  function listUsers(actor, { role } = {}) {
    requireRole(actor, 'admin', 'cajero');
    const vis = visibleUsersWhere(actor);
    const rows = role ? db.all(`SELECT u.* FROM users u WHERE u.role = ? AND ${vis} ORDER BY u.full_name`, [role]) : db.all(`SELECT u.* FROM users u WHERE ${vis} ORDER BY u.role, u.full_name`);
    return rows.map(publicUser).map((u) => {
      if (u.role === 'tutor') u.children = db.all(`SELECT id, full_name FROM children WHERE tutor_id = ?${scope(actor)} ORDER BY full_name`, [u.id]);
      return u;
    });
  }

  // ---------- alumnos ----------
  function childRow(c) {
    const cards = db.all("SELECT id, uid, status, balance_cents FROM cards WHERE child_id = ? ORDER BY CASE status WHEN 'activa' THEN 0 WHEN 'bloqueada' THEN 1 ELSE 2 END, id DESC", [c.id]);
    const tutor = db.get('SELECT id, full_name, username FROM users WHERE id = ?', [c.tutor_id]);
    const current = cards.find((k) => k.status === 'activa' || k.status === 'bloqueada') || null;
    return { ...c, active: !!c.active, school_name: schoolName(c.school_id), tutor, cards, card: current, balance_cents: current ? current.balance_cents : 0 };
  }
  function listChildren(actor) {
    requireRole(actor, ...ROLES);
    const rows = actor.role === 'tutor'
      ? db.all('SELECT * FROM children WHERE tutor_id = ? ORDER BY full_name', [actor.id])
      : db.all(`SELECT * FROM children WHERE 1=1${scope(actor)} ORDER BY full_name`);
    return rows.map(childRow);
  }
  function validPhoto(p) {
    if (p === undefined) return undefined;
    if (p === null || p === '') return null;
    if (typeof p !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(p) || p.length > 400000) throw new AppError('Foto inválida (máx. ~300 KB, PNG/JPG/WEBP)', 'VALIDACION');
    return p;
  }
  function createChild(actor, data) {
    requireRole(actor, 'admin');
    // El tutor es opcional: si no se indica, se vincula después con un código de invitación
    let tutor = null;
    if (data.tutor_id) tutor = getVisibleTutor(actor, data.tutor_id);
    const full_name = str(data.full_name, 'nombre del alumno');
    const grade = str(data.grade, 'grado/grupo', { optional: true, max: 30 });
    const photo = validPhoto(data.photo) || null;
    const r = db.run('INSERT INTO children (school_id, tutor_id, full_name, grade, photo, created_at) VALUES (?,?,?,?,?,?)', [sch(actor), tutor ? tutor.id : null, full_name, grade, photo, ts()]);
    return childRow(db.get('SELECT * FROM children WHERE id = ?', [r.lastId]));
  }
  function updateChild(actor, id, data) {
    const c = assertChildAccess(actor, id, { write: true });
    // El tutor puede personalizar nombre/foto de su hijo; solo admin cambia tutor o estado.
    const full_name = data.full_name !== undefined ? str(data.full_name, 'nombre del alumno') : c.full_name;
    const grade = data.grade !== undefined ? str(data.grade, 'grado/grupo', { optional: true, max: 30 }) : c.grade;
    const ph = validPhoto(data.photo);
    const photo = ph === undefined ? c.photo : ph;
    let tutor_id = c.tutor_id; let active = c.active;
    if (actor.role === 'admin') {
      if (data.tutor_id === null || data.tutor_id === '' || data.tutor_id === 0) tutor_id = null;
      else if (data.tutor_id !== undefined && Number(data.tutor_id) !== c.tutor_id) tutor_id = getVisibleTutor(actor, data.tutor_id).id;
      if (data.active !== undefined) active = data.active ? 1 : 0;
    }
    db.run('UPDATE children SET full_name=?, grade=?, photo=?, tutor_id=?, active=? WHERE id=?', [full_name, grade, photo, tutor_id, active, c.id]);
    return childRow(db.get('SELECT * FROM children WHERE id = ?', [c.id]));
  }

  // ---------- categorías y productos ----------
  // Escuelas cuyo catálogo puede ver el actor (tutor: las de sus hijos, o la de un hijo concreto)
  function catalogScope(actor, f = {}, alias = '') {
    const a = alias ? alias + '.' : '';
    if (actor.role !== 'tutor') return scope(actor, alias);
    if (f.child_id) { const c = assertChildAccess(actor, f.child_id); return ` AND ${a}school_id = ${Number(c.school_id) || 0}`; }
    return ` AND ${a}school_id IN (SELECT school_id FROM children WHERE tutor_id = ${Number(actor.id)})`;
  }
  function listCategories(actor, f = {}) {
    requireRole(actor, ...ROLES);
    return db.all(`SELECT * FROM categories WHERE 1=1${catalogScope(actor, f || {})} ORDER BY name`);
  }
  function createCategory(actor, data) {
    requireRole(actor, 'admin');
    const name = str(data.name, 'categoría', { max: 40 });
    if (db.get(`SELECT id FROM categories WHERE name = ?${scope(actor)}`, [name])) throw new AppError('La categoría ya existe', 'DUPLICADO');
    const r = db.run('INSERT INTO categories (school_id, name) VALUES (?, ?)', [sch(actor), name]);
    return db.get('SELECT * FROM categories WHERE id = ?', [r.lastId]);
  }
  function listProducts(actor, f = {}) {
    requireRole(actor, ...ROLES);
    const onlyActive = !!(f && f.onlyActive);
    const rows = db.all(`SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id
      WHERE 1=1${catalogScope(actor, f || {}, 'p')} ${onlyActive ? 'AND p.active = 1' : ''} ORDER BY c.name, p.name`);
    return rows.map((p) => ({ ...p, active: !!p.active }));
  }
  function productData(actor, data, prev = {}) {
    const name = data.name !== undefined ? str(data.name, 'nombre del producto', { max: 80 }) : prev.name;
    const category_id = data.category_id !== undefined ? int(data.category_id, 'categoría', { min: 1 }) : prev.category_id;
    if (!db.get(`SELECT id FROM categories WHERE id = ?${scope(actor)}`, [category_id])) throw new AppError('Categoría no encontrada', 'NO_ENCONTRADO');
    const price_cents = data.price_cents !== undefined ? cents(data.price_cents, 'precio') : prev.price_cents;
    const active = data.active !== undefined ? (data.active ? 1 : 0) : (prev.active === undefined ? 1 : prev.active);
    return { name, category_id, price_cents, active };
  }
  function createProduct(actor, data) {
    requireRole(actor, 'admin');
    const p = productData(actor, data);
    const r = db.run('INSERT INTO products (school_id, name, category_id, price_cents, active, created_at) VALUES (?,?,?,?,?,?)', [sch(actor), p.name, p.category_id, p.price_cents, p.active, ts()]);
    return db.get('SELECT * FROM products WHERE id = ?', [r.lastId]);
  }
  function updateProduct(actor, id, data) {
    requireRole(actor, 'admin');
    const prev = db.get(`SELECT * FROM products WHERE id = ?${scope(actor)}`, [int(id, 'id', { min: 1 })]);
    if (!prev) throw new AppError('Producto no encontrado', 'NO_ENCONTRADO');
    const p = productData(actor, data, prev);
    db.run('UPDATE products SET name=?, category_id=?, price_cents=?, active=? WHERE id=?', [p.name, p.category_id, p.price_cents, p.active, prev.id]);
    return db.get('SELECT * FROM products WHERE id = ?', [prev.id]);
  }
  function deleteProduct(actor, id) {
    requireRole(actor, 'admin');
    const p = db.get(`SELECT * FROM products WHERE id = ?${scope(actor)}`, [int(id, 'id', { min: 1 })]);
    if (!p) throw new AppError('Producto no encontrado', 'NO_ENCONTRADO');
    const used = db.get('SELECT COUNT(*) AS n FROM transaction_items WHERE product_id = ?', [p.id]).n;
    return db.transaction(() => {
      if (used > 0) { // conservar historial: se desactiva
        db.run('UPDATE products SET active = 0 WHERE id = ?', [p.id]);
        return { deleted: false, deactivated: true, message: 'El producto tiene ventas registradas; se desactivó en lugar de borrarse.' };
      }
      db.run('DELETE FROM prohibited_products WHERE product_id = ?', [p.id]);
      db.run('DELETE FROM products WHERE id = ?', [p.id]);
      return { deleted: true };
    });
  }

  // ---------- tarjetas ----------
  function cardRow(k) {
    if (!k) return null;
    const child = k.child_id ? db.get('SELECT c.id, c.full_name, c.grade, c.photo, c.tutor_id, u.full_name AS tutor_name FROM children c LEFT JOIN users u ON u.id = c.tutor_id WHERE c.id = ?', [k.child_id]) : null;
    return { ...k, child };
  }
  function listCards(actor) {
    requireRole(actor, 'admin', 'cajero');
    return db.all(`SELECT * FROM cards WHERE 1=1${scope(actor)} ORDER BY id DESC`).map(cardRow);
  }
  function getCardByUid(uid, actor) { return db.get(`SELECT * FROM cards WHERE uid = ?${scope(actor)}`, [normUid(uid)]); }
  function getCardOrFail(actor, cardId) {
    const k = db.get(`SELECT * FROM cards WHERE id = ?${scope(actor)}`, [int(cardId, 'tarjeta', { min: 1 })]);
    if (!k) throw new AppError('Tarjeta no encontrada', 'NO_ENCONTRADO');
    return k;
  }
  // Los UID son únicos en toda la plataforma
  function assertUidFree(uid, msg, actor) {
    const other = db.get('SELECT school_id FROM cards WHERE uid = ?', [uid]);
    if (!other) return;
    const mine = sch(actor);
    if (!single && mine !== null && other.school_id !== mine) throw new AppError('Esa tarjeta (UID) ya está registrada en otra escuela', 'DUPLICADO');
    throw new AppError(msg, 'DUPLICADO');
  }
  // Si el alumno tenía saldo pendiente (tarjeta perdida sin reemplazo), se abona a la nueva tarjeta.
  function applyPending(actor, childId, cardId) {
    const key = `saldo_pendiente_child_${childId}`;
    const pend = db.get('SELECT value FROM meta WHERE key = ?', [key]);
    if (!pend || Number(pend.value) <= 0) return;
    const k = db.get('SELECT * FROM cards WHERE id = ?', [cardId]);
    const nb = k.balance_cents + Number(pend.value);
    db.run('UPDATE cards SET balance_cents = ? WHERE id = ?', [nb, k.id]);
    db.run(`INSERT INTO transactions (type,status,amount_cents,balance_after_cents,card_id,card_uid,child_id,user_id,note,created_at)
      VALUES ('ajuste','aprobado',?,?,?,?,?,?,?,?)`, [Number(pend.value), nb, k.id, k.uid, childId, actor.id, 'Saldo transferido de tarjeta perdida', ts()]);
    db.run('DELETE FROM meta WHERE key = ?', [key]);
  }
  function registerCard(actor, data) {
    requireRole(actor, 'admin');
    const uid = normUid(data.uid);
    assertUidFree(uid, 'Esa tarjeta (UID) ya está registrada', actor);
    let child_id = null; let status = 'sin_asignar';
    if (data.child_id) {
      const c = getChildOrFail(data.child_id, actor);
      if (db.get("SELECT id FROM cards WHERE child_id = ? AND status IN ('activa','bloqueada')", [c.id])) {
        throw new AppError('El alumno ya tiene una tarjeta vigente. Repórtala como perdida para reasignar.', 'VALIDACION');
      }
      child_id = c.id; status = 'activa';
    }
    const r = db.transaction(() => {
      const ins = db.run('INSERT INTO cards (school_id, uid, child_id, status, balance_cents, created_at) VALUES (?,?,?,?,0,?)', [sch(actor), uid, child_id, status, ts()]);
      if (child_id) applyPending(actor, child_id, ins.lastId);
      return ins;
    });
    return cardRow(db.get('SELECT * FROM cards WHERE id = ?', [r.lastId]));
  }
  function assignCard(actor, cardId, childId) {
    requireRole(actor, 'admin');
    const k = getCardOrFail(actor, cardId);
    if (k.status === 'perdida') throw new AppError('Una tarjeta reportada como perdida no puede reasignarse', 'VALIDACION');
    const c = getChildOrFail(childId, actor);
    if (db.get("SELECT id FROM cards WHERE child_id = ? AND status IN ('activa','bloqueada') AND id <> ?", [c.id, k.id])) {
      throw new AppError('El alumno ya tiene una tarjeta vigente', 'VALIDACION');
    }
    if (k.child_id && k.child_id !== c.id && k.balance_cents > 0) throw new AppError('La tarjeta tiene saldo de otro alumno; ajústalo a $0 antes de reasignarla', 'VALIDACION');
    db.transaction(() => {
      db.run("UPDATE cards SET child_id = ?, status = 'activa', blocked_by = NULL WHERE id = ?", [c.id, k.id]);
      applyPending(actor, c.id, k.id);
    });
    return cardRow(db.get('SELECT * FROM cards WHERE id = ?', [k.id]));
  }
  function setCardStatus(actor, cardId, status) {
    requireRole(actor, 'admin', 'tutor');
    const k = getCardOrFail(actor, cardId);
    if (!['activa', 'bloqueada'].includes(status)) throw new AppError('Estado inválido', 'VALIDACION');
    if (actor.role === 'tutor') {
      if (!k.child_id) throw new AppError('No tienes acceso a esta tarjeta', 'PROHIBIDO');
      assertChildAccess(actor, k.child_id);
      if (status === 'activa' && k.blocked_by === 'admin') throw new AppError('La tarjeta fue bloqueada por la cooperativa; acude con el administrador', 'PROHIBIDO');
    }
    if (k.status === 'perdida' || k.status === 'sin_asignar') throw new AppError(`No se puede cambiar el estado de una tarjeta ${k.status.replace('_', ' ')}`, 'VALIDACION');
    db.run('UPDATE cards SET status = ?, blocked_by = ? WHERE id = ?', [status, status === 'bloqueada' ? actor.role : null, k.id]);
    return cardRow(db.get('SELECT * FROM cards WHERE id = ?', [k.id]));
  }
  // Reporta tarjeta perdida y transfiere el saldo a una nueva tarjeta (UID nuevo).
  function reportLostAndReplace(actor, cardId, newUid) {
    requireRole(actor, 'admin');
    const k = getCardOrFail(actor, cardId);
    if (k.status === 'perdida') throw new AppError('La tarjeta ya está reportada como perdida', 'VALIDACION');
    const uid = newUid ? normUid(newUid) : null;
    if (uid) assertUidFree(uid, 'El UID nuevo ya está registrado', actor);
    return db.transaction(() => {
      const t = ts();
      const bal = k.balance_cents;
      db.run("UPDATE cards SET status = 'perdida', balance_cents = 0, blocked_by = 'admin' WHERE id = ?", [k.id]);
      let newCard = null;
      if (bal > 0) {
        db.run(`INSERT INTO transactions (type,status,reason,amount_cents,balance_after_cents,card_id,card_uid,child_id,user_id,note,created_at)
          VALUES ('ajuste','aprobado',NULL,?,0,?,?,?,?,?,?)`, [-bal, k.id, k.uid, k.child_id, actor.id, 'Tarjeta reportada como perdida; saldo transferido', t]);
      }
      if (uid) {
        const r = db.run('INSERT INTO cards (school_id, uid, child_id, status, balance_cents, created_at) VALUES (?,?,?,?,?,?)',
          [k.school_id, uid, k.child_id, k.child_id ? 'activa' : 'sin_asignar', bal, t]);
        if (bal > 0) {
          db.run(`INSERT INTO transactions (type,status,reason,amount_cents,balance_after_cents,card_id,card_uid,child_id,user_id,note,created_at)
            VALUES ('ajuste','aprobado',NULL,?,?,?,?,?,?,?,?)`, [bal, bal, r.lastId, uid, k.child_id, actor.id, `Saldo transferido desde tarjeta ${k.uid}`, t]);
        }
        newCard = cardRow(db.get('SELECT * FROM cards WHERE id = ?', [r.lastId]));
      } else if (bal > 0) {
        // Sin tarjeta nueva aún: el saldo queda pendiente en meta para no perderlo
        const key = `saldo_pendiente_child_${k.child_id}`;
        const prev = db.get('SELECT value FROM meta WHERE key = ?', [key]);
        const total = (prev ? Number(prev.value) : 0) + bal;
        db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [key, String(total)]);
      }
      return { lost: cardRow(db.get('SELECT * FROM cards WHERE id = ?', [k.id])), newCard, transferred_cents: bal };
    });
  }

  // ---------- consulta de tarjeta (POS) ----------
  function lookupCard(actor, uid) {
    requireRole(actor, 'admin', 'cajero');
    const k = getCardByUid(uid, actor);
    if (!k) throw new AppError('Tarjeta no registrada', 'NO_ENCONTRADO');
    const row = cardRow(k);
    if (k.child_id) {
      row.limits = getLimitsRaw(k.child_id);
      row.spent_today_cents = spentSince(k.child_id, startOfDay(now()));
      row.prohibited_products = db.all('SELECT product_id FROM prohibited_products WHERE child_id = ?', [k.child_id]).map((r) => r.product_id);
      row.prohibited_categories = db.all('SELECT category_id FROM prohibited_categories WHERE child_id = ?', [k.child_id]).map((r) => r.category_id);
    }
    return row;
  }

  // ---------- límites y prohibiciones ----------
  function getLimitsRaw(childId) {
    return db.get('SELECT per_transaction_cents, per_day_cents, period_type, per_period_cents FROM limits WHERE child_id = ?', [childId])
      || { per_transaction_cents: null, per_day_cents: null, period_type: null, per_period_cents: null };
  }
  function getLimits(actor, childId) { assertChildAccess(actor, childId); return getLimitsRaw(Number(childId)); }
  function setLimits(actor, childId, data) {
    const c = assertChildAccess(actor, childId, { write: true });
    const per_transaction_cents = cents(data.per_transaction_cents, 'límite por compra', { optional: true });
    const per_day_cents = cents(data.per_day_cents, 'límite diario', { optional: true });
    let period_type = data.period_type || null;
    if (period_type !== null && !['semana', 'mes'].includes(period_type)) throw new AppError('Periodo inválido (semana o mes)', 'VALIDACION');
    let per_period_cents = cents(data.per_period_cents, 'límite del periodo', { optional: true });
    if (period_type && per_period_cents === null) throw new AppError('Indica el monto del límite semanal/mensual', 'VALIDACION');
    if (!period_type) per_period_cents = null;
    db.run(`INSERT INTO limits (child_id, per_transaction_cents, per_day_cents, period_type, per_period_cents, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(child_id) DO UPDATE SET per_transaction_cents=excluded.per_transaction_cents, per_day_cents=excluded.per_day_cents,
      period_type=excluded.period_type, per_period_cents=excluded.per_period_cents, updated_at=excluded.updated_at`,
    [c.id, per_transaction_cents, per_day_cents, period_type, per_period_cents, ts()]);
    return getLimitsRaw(c.id);
  }
  function getProhibitions(actor, childId) {
    const c = assertChildAccess(actor, childId);
    return {
      products: db.all('SELECT p.id, p.name FROM prohibited_products x JOIN products p ON p.id = x.product_id WHERE x.child_id = ? ORDER BY p.name', [c.id]),
      categories: db.all('SELECT k.id, k.name FROM prohibited_categories x JOIN categories k ON k.id = x.category_id WHERE x.child_id = ? ORDER BY k.name', [c.id]),
    };
  }
  function setProhibitions(actor, childId, data) {
    const c = assertChildAccess(actor, childId, { write: true });
    const prods = Array.isArray(data.product_ids) ? [...new Set(data.product_ids.map((x) => int(x, 'producto', { min: 1 })))] : null;
    const cats = Array.isArray(data.category_ids) ? [...new Set(data.category_ids.map((x) => int(x, 'categoría', { min: 1 })))] : null;
    db.transaction(() => {
      if (prods) {
        db.run('DELETE FROM prohibited_products WHERE child_id = ?', [c.id]);
        for (const p of prods) {
          if (!db.get('SELECT id FROM products WHERE id = ? AND school_id IS ?', [p, c.school_id])) throw new AppError('Producto no encontrado', 'NO_ENCONTRADO');
          db.run('INSERT INTO prohibited_products (child_id, product_id) VALUES (?,?)', [c.id, p]);
        }
      }
      if (cats) {
        db.run('DELETE FROM prohibited_categories WHERE child_id = ?', [c.id]);
        for (const k of cats) {
          if (!db.get('SELECT id FROM categories WHERE id = ? AND school_id IS ?', [k, c.school_id])) throw new AppError('Categoría no encontrada', 'NO_ENCONTRADO');
          db.run('INSERT INTO prohibited_categories (child_id, category_id) VALUES (?,?)', [c.id, k]);
        }
      }
    });
    return getProhibitions(actor, c.id);
  }

  function spentSince(childId, since) {
    return db.get("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE child_id = ? AND type='compra' AND status='aprobado' AND created_at >= ?",
      [childId, fmtLocal(since)]).s;
  }

  // ---------- recargas ----------
  function recharge(actor, data) {
    requireRole(actor, 'admin', 'cajero');
    const amount = cents(data.amount_cents, 'monto de recarga');
    if (amount > 500000) throw new AppError('La recarga máxima es de $5,000.00 MXN', 'VALIDACION');
    const note = str(data.note, 'nota', { optional: true, max: 200 });
    return db.transaction(() => {
      const k = getCardByUid(data.uid, actor);
      if (!k) throw new AppError('Tarjeta no registrada', 'NO_ENCONTRADO');
      if (!k.child_id) throw new AppError('La tarjeta no está asignada a ningún alumno', 'VALIDACION');
      if (k.status === 'perdida') throw new AppError('La tarjeta está reportada como perdida', 'VALIDACION');
      const newBal = k.balance_cents + amount;
      db.run('UPDATE cards SET balance_cents = ? WHERE id = ?', [newBal, k.id]);
      const r = db.run(`INSERT INTO transactions (type,status,amount_cents,balance_after_cents,card_id,card_uid,child_id,user_id,note,created_at)
        VALUES ('recarga','aprobado',?,?,?,?,?,?,?,?)`, [amount, newBal, k.id, k.uid, k.child_id, actor.id, note, ts()]);
      return { transaction_id: r.lastId, balance_cents: newBal, card: cardRow(db.get('SELECT * FROM cards WHERE id = ?', [k.id])) };
    });
  }
  function adjust(actor, data) {
    requireRole(actor, 'admin');
    const amount = int(data.amount_cents, 'monto del ajuste', { min: -100000000, max: 100000000 });
    if (amount === 0) throw new AppError('El ajuste no puede ser $0', 'VALIDACION');
    const note = str(data.note, 'motivo del ajuste', { max: 200 });
    return db.transaction(() => {
      const k = getCardByUid(data.uid, actor);
      if (!k) throw new AppError('Tarjeta no registrada', 'NO_ENCONTRADO');
      const newBal = k.balance_cents + amount;
      if (newBal < 0) throw new AppError('El ajuste dejaría saldo negativo', 'VALIDACION');
      db.run('UPDATE cards SET balance_cents = ? WHERE id = ?', [newBal, k.id]);
      const r = db.run(`INSERT INTO transactions (type,status,amount_cents,balance_after_cents,card_id,card_uid,child_id,user_id,note,created_at)
        VALUES ('ajuste','aprobado',?,?,?,?,?,?,?,?)`, [amount, newBal, k.id, k.uid, k.child_id, actor.id, note, ts()]);
      return { transaction_id: r.lastId, balance_cents: newBal };
    });
  }

  // ---------- compra (validación atómica) ----------
  function purchase(actor, data) {
    requireRole(actor, 'admin', 'cajero');
    if (!Array.isArray(data.items) || data.items.length === 0) throw new AppError('El carrito está vacío', 'VALIDACION');
    if (data.items.length > 50) throw new AppError('Demasiados productos en una sola venta', 'VALIDACION');
    const uid = normUid(data.uid);
    // Agrupar cantidades por producto
    const qtyById = new Map();
    for (const it of data.items) {
      const pid = int(it.product_id, 'producto', { min: 1 });
      const q = int(it.qty, 'cantidad', { min: 1, max: 100 });
      qtyById.set(pid, (qtyById.get(pid) || 0) + q);
    }

    const outcome = db.transaction(() => {
      const t = ts();
      const k = getCardByUid(uid, actor);
      if (!k) throw new AppError('Tarjeta no registrada', 'NO_ENCONTRADO');

      // Construir líneas con precios actuales
      const lines = [];
      for (const [pid, qty] of qtyById) {
        const p = db.get('SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ? AND p.school_id IS ?', [pid, k.school_id]);
        if (!p) throw new AppError('Producto no encontrado', 'NO_ENCONTRADO');
        lines.push({ product: p, qty, subtotal: p.price_cents * qty });
      }
      const total = lines.reduce((s, l) => s + l.subtotal, 0);

      const reject = (reason) => {
        const r = db.run(`INSERT INTO transactions (type,status,reason,amount_cents,balance_after_cents,card_id,card_uid,child_id,user_id,created_at)
          VALUES ('compra','rechazado',?,?,?,?,?,?,?,?)`, [reason, total, k.balance_cents, k.id, k.uid, k.child_id, actor.id, t]);
        for (const l of lines) {
          db.run(`INSERT INTO transaction_items (transaction_id, product_id, product_name, category_name, qty, unit_price_cents, subtotal_cents)
            VALUES (?,?,?,?,?,?,?)`, [r.lastId, l.product.id, l.product.name, l.product.category_name, l.qty, l.product.price_cents, l.subtotal]);
        }
        return { ok: false, reason, transaction_id: r.lastId, total_cents: total, balance_cents: k.balance_cents };
      };

      // 1) Estado de la tarjeta
      if (!k.child_id || k.status === 'sin_asignar') return reject('Tarjeta sin asignar a un alumno');
      if (k.status === 'perdida') return reject('Tarjeta reportada como perdida');
      if (k.status === 'bloqueada') return reject(k.blocked_by === 'tutor' ? 'Tarjeta bloqueada temporalmente por el tutor' : 'Tarjeta bloqueada por la cooperativa');
      const child = db.get('SELECT * FROM children WHERE id = ?', [k.child_id]);
      if (!child || !child.active) return reject('Alumno inactivo');
      // 2) Productos inactivos
      const inactive = lines.find((l) => !l.product.active);
      if (inactive) return reject(`Producto no disponible: ${inactive.product.name}`);
      // 3) Productos / categorías prohibidas
      for (const l of lines) {
        if (db.get('SELECT 1 AS x FROM prohibited_products WHERE child_id = ? AND product_id = ?', [child.id, l.product.id])) {
          return reject(`Producto prohibido por el tutor: ${l.product.name}`);
        }
        if (db.get('SELECT 1 AS x FROM prohibited_categories WHERE child_id = ? AND category_id = ?', [child.id, l.product.category_id])) {
          return reject(`Categoría prohibida por el tutor: ${l.product.category_name} (${l.product.name})`);
        }
      }
      // 4) Límites
      const lim = getLimitsRaw(child.id);
      const n = now();
      if (lim.per_transaction_cents !== null && total > lim.per_transaction_cents) {
        return reject(`Excede el límite por compra (${money(lim.per_transaction_cents)}); total ${money(total)}`);
      }
      if (lim.per_day_cents !== null) {
        const spent = spentSince(child.id, startOfDay(n));
        if (spent + total > lim.per_day_cents) {
          return reject(`Excede el límite diario (${money(lim.per_day_cents)}); gastado hoy ${money(spent)}, disponible ${money(Math.max(0, lim.per_day_cents - spent))}`);
        }
      }
      if (lim.period_type && lim.per_period_cents !== null) {
        const since = lim.period_type === 'semana' ? startOfWeek(n) : startOfMonth(n);
        const spent = spentSince(child.id, since);
        if (spent + total > lim.per_period_cents) {
          const label = lim.period_type === 'semana' ? 'semanal' : 'mensual';
          return reject(`Excede el límite ${label} (${money(lim.per_period_cents)}); gastado ${money(spent)}, disponible ${money(Math.max(0, lim.per_period_cents - spent))}`);
        }
      }
      // 5) Saldo
      if (k.balance_cents < total) return reject(`Saldo insuficiente: saldo ${money(k.balance_cents)}, total ${money(total)}`);

      // Aprobar: actualización condicional (defensa extra contra carreras)
      const upd = db.run('UPDATE cards SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ? AND status = \'activa\'', [total, k.id, total]);
      if (upd.changes !== 1) throw new AppError('No se pudo aplicar el cargo, intenta de nuevo', 'CONFLICTO');
      const newBal = k.balance_cents - total;
      const r = db.run(`INSERT INTO transactions (type,status,amount_cents,balance_after_cents,card_id,card_uid,child_id,user_id,created_at)
        VALUES ('compra','aprobado',?,?,?,?,?,?,?)`, [total, newBal, k.id, k.uid, child.id, actor.id, t]);
      for (const l of lines) {
        db.run(`INSERT INTO transaction_items (transaction_id, product_id, product_name, category_name, qty, unit_price_cents, subtotal_cents)
          VALUES (?,?,?,?,?,?,?)`, [r.lastId, l.product.id, l.product.name, l.product.category_name, l.qty, l.product.price_cents, l.subtotal]);
      }
      return { ok: true, transaction_id: r.lastId, total_cents: total, balance_cents: newBal, child_name: child.full_name };
    });
    return outcome;
  }

  // ---------- movimientos ----------
  function listMovements(actor, f = {}) {
    requireRole(actor, ...ROLES);
    const where = []; const params = [];
    if (actor.role === 'tutor') { where.push('ch.tutor_id = ?'); params.push(actor.id); } else { const id = sch(actor); if (id !== null) where.push(`t.school_id = ${id}`); }
    if (f.child_id) {
      if (actor.role === 'tutor') assertChildAccess(actor, f.child_id);
      where.push('t.child_id = ?'); params.push(int(f.child_id, 'alumno', { min: 1 }));
    }
    if (f.type) { if (!['compra', 'recarga', 'ajuste'].includes(f.type)) throw new AppError('Tipo inválido', 'VALIDACION'); where.push('t.type = ?'); params.push(f.type); }
    if (f.status) { if (!['aprobado', 'rechazado'].includes(f.status)) throw new AppError('Estado inválido', 'VALIDACION'); where.push('t.status = ?'); params.push(f.status); }
    if (f.from) { if (!/^\d{4}-\d{2}-\d{2}$/.test(f.from)) throw new AppError('Fecha inicial inválida', 'VALIDACION'); where.push('t.created_at >= ?'); params.push(f.from + ' 00:00:00'); }
    if (f.to) { if (!/^\d{4}-\d{2}-\d{2}$/.test(f.to)) throw new AppError('Fecha final inválida', 'VALIDACION'); where.push('t.created_at <= ?'); params.push(f.to + ' 23:59:59'); }
    if (f.uid) { where.push('t.card_uid = ?'); params.push(normUid(f.uid)); }
    const limit = int(f.limit || 300, 'límite', { min: 1, max: 5000 });
    const rows = db.all(`SELECT t.*, ch.full_name AS child_name, COALESCE(u.full_name, t.processed_by_name) AS user_name
      FROM transactions t LEFT JOIN children ch ON ch.id = t.child_id LEFT JOIN users u ON u.id = t.user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit}`, params);
    for (const r of rows) {
      r.items = db.all('SELECT product_name, category_name, qty, unit_price_cents, subtotal_cents FROM transaction_items WHERE transaction_id = ?', [r.id]);
      if (actor.role === 'tutor') { delete r.user_id; }
    }
    return rows;
  }

  function childSummary(actor, childId) {
    const c = assertChildAccess(actor, childId);
    const n = now();
    const lim = getLimitsRaw(c.id);
    const spentToday = spentSince(c.id, startOfDay(n));
    const spentWeek = spentSince(c.id, startOfWeek(n));
    const spentMonth = spentSince(c.id, startOfMonth(n));
    const pend = db.get('SELECT value FROM meta WHERE key = ?', [`saldo_pendiente_child_${c.id}`]);
    return {
      child: childRow(c),
      limits: lim,
      spent_today_cents: spentToday,
      spent_week_cents: spentWeek,
      spent_month_cents: spentMonth,
      pending_transfer_cents: pend ? Number(pend.value) : 0,
      prohibitions: getProhibitions(actor, c.id),
      movements: listMovements(actor, { child_id: c.id, limit: 100 }),
    };
  }

  // ---------- dashboard ----------
  function dashboard(actor) {
    requireRole(actor, 'admin');
    const n = now();
    const W = scope(actor); const WT = scope(actor, 't');
    const sum = (type, since) => db.get(`SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS c FROM transactions WHERE type = ? AND status='aprobado' AND created_at >= ?${W}`, [type, fmtLocal(since)]);
    const day = sum('compra', startOfDay(n)); const week = sum('compra', startOfWeek(n)); const month = sum('compra', startOfMonth(n));
    const rDay = sum('recarga', startOfDay(n)); const rMonth = sum('recarga', startOfMonth(n));
    const rTotal = db.get(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE type='recarga' AND status='aprobado'${W}`).s;
    const top = db.all(`SELECT ti.product_name AS name, SUM(ti.qty) AS qty, SUM(ti.subtotal_cents) AS total_cents
      FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
      WHERE t.status='aprobado' AND t.type='compra' AND t.created_at >= ?${WT} GROUP BY ti.product_name ORDER BY qty DESC LIMIT 8`, [fmtLocal(startOfMonth(n))]);
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = startOfDay(n); d.setDate(d.getDate() - i);
      const e = new Date(d); e.setDate(e.getDate() + 1);
      const s = db.get(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE type='compra' AND status='aprobado' AND created_at >= ? AND created_at < ?${W}`, [fmtLocal(d), fmtLocal(e)]).s;
      days.push({ date: fmtDate(d), total_cents: s });
    }
    return {
      sales_day_cents: day.s, sales_day_count: day.c, sales_week_cents: week.s, sales_month_cents: month.s,
      recharges_day_cents: rDay.s, recharges_month_cents: rMonth.s, recharges_total_cents: rTotal,
      active_cards: db.get(`SELECT COUNT(*) AS n FROM cards WHERE status='activa'${W}`).n,
      total_cards: db.get(`SELECT COUNT(*) AS n FROM cards WHERE 1=1${W}`).n,
      balance_in_cards_cents: db.get(`SELECT COALESCE(SUM(balance_cents),0) AS s FROM cards WHERE 1=1${W}`).s,
      rejected_today: db.get(`SELECT COUNT(*) AS n FROM transactions WHERE status='rechazado' AND created_at >= ?${W}`, [fmtLocal(startOfDay(n))]).n,
      school_name: schoolName(sch(actor)),
      top_products: top, sales_by_day: days,
    };
  }

  return {
    login, assertSchoolActive, findUserByIdentifier, publicUser, changePassword, createUser, updateUser, listUsers,
    listChildren, createChild, updateChild,
    listCategories, createCategory, listProducts, createProduct, updateProduct, deleteProduct,
    listCards, registerCard, assignCard, setCardStatus, reportLostAndReplace, lookupCard,
    getLimits, setLimits, getProhibitions, setProhibitions,
    recharge, adjust, purchase, listMovements, childSummary, dashboard,
  };
}

module.exports = { createService, AppError, fmtLocal, normUid, normEmail, normPhone, str };
