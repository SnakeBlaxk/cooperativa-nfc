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
  const u = s.replace(/[\s:\-._,;]/g, '').toUpperCase();
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
    const c = db.get(`SELECT * FROM children WHERE id = ? AND deleted_at IS NULL${scope(actor)}`, [int(childId, 'niño', { min: 1 })]);
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
  // Escuela PAUSADA (mensualidad): nadie de esa escuela entra (administrador, cajero ni tutores).
  // Un tutor con hijos en varias escuelas sigue entrando mientras alguna de ellas esté activa.
  const PAUSED = (st) => st === 'pausada' || st === 'suspendida';
  function assertSchoolActive(u) {
    if (!u || u.role === 'superadmin') return;
    let blocked = false;
    if (u.role === 'tutor') {
      const rows = db.all('SELECT status FROM schools WHERE id IN (SELECT school_id FROM children WHERE tutor_id = ?) OR id = ?', [u.id, u.school_id || -1]);
      blocked = rows.length > 0 && rows.every((r) => PAUSED(r.status));
    } else if (u.school_id) {
      const s = db.get('SELECT status FROM schools WHERE id = ?', [u.school_id]);
      blocked = !!(s && PAUSED(s.status));
    }
    if (blocked) throw new AppError('Servicio pausado. Contacte a la administración.', 'ESCUELA_PAUSADA');
  }
  // Política: solo el superadministrador cambia contraseñas (la suya y, desde su panel, las de los demás).
  function changePassword(actor, current, next) {
    requireRole(actor, ...ALL_ROLES);
    if (actor.role !== 'superadmin') throw new AppError('Solo el administrador de la plataforma (Zuki Company) puede cambiar contraseñas. Pídeselo a él.', 'PROHIBIDO');
    const u = db.get('SELECT * FROM users WHERE id = ?', [actor.id]);
    if (!bcrypt.compareSync(String(current || ''), u.password_hash)) throw new AppError('La contraseña actual es incorrecta', 'VALIDACION');
    const p = str(next, 'nueva contraseña', { min: 10, max: 100 });
    if (p === current) throw new AppError('La nueva contraseña debe ser distinta de la actual', 'VALIDACION');
    db.run('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, password_set_at = ?, password_set_by = ? WHERE id = ?', [bcrypt.hashSync(p, 10), ts(), 'propio', actor.id]);
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
      [username, bcrypt.hashSync(password, 10), role, full_name, phone, email, 0, sch(actor), ts()]);
    return publicUser(db.get('SELECT * FROM users WHERE id = ?', [r.lastId]));
  }
  function assertUniqueIdentity(username, email, phone, exceptId = 0) {
    if (username && db.get('SELECT id FROM users WHERE username = ? AND id <> ?', [username, exceptId])) throw new AppError('Ese nombre de usuario ya existe', 'DUPLICADO');
    if (email && db.get('SELECT id FROM users WHERE lower(email) = lower(?) AND id <> ?', [email, exceptId])) throw new AppError('Ese correo ya está registrado', 'DUPLICADO');
    if (phone && db.get('SELECT id FROM users WHERE phone = ? AND id <> ?', [phone, exceptId])) throw new AppError('Ese teléfono ya está registrado', 'DUPLICADO');
  }
  function updateUser(actor, id, data) {
    requireRole(actor, 'admin');
    if (data.password) throw new AppError('Solo el administrador de la plataforma (Zuki Company) puede cambiar contraseñas.', 'PROHIBIDO');
    const u = getVisibleUser(actor, id);
    const full_name = data.full_name !== undefined ? str(data.full_name, 'nombre') : u.full_name;
    const phone = data.phone !== undefined ? (data.phone ? normPhone(data.phone) : null) : u.phone;
    if (data.phone && !phone) throw new AppError('Teléfono inválido (10 dígitos)', 'VALIDACION');
    const email = data.email !== undefined ? (data.email ? normEmail(data.email) : null) : u.email;
    assertUniqueIdentity(null, email, phone, u.id);
    const active = data.active !== undefined ? (data.active ? 1 : 0) : u.active;
    if (u.id === actor.id && !active) throw new AppError('No puedes desactivar tu propio usuario', 'VALIDACION');
    db.run('UPDATE users SET full_name=?, phone=?, email=?, active=? WHERE id=?', [full_name, phone, email, active, u.id]);
    if (data.password) throw new AppError('Solo el administrador de la plataforma (Zuki Company) puede cambiar contraseñas.', 'PROHIBIDO');
    if (!active) db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [u.id]);
    return publicUser(db.get('SELECT * FROM users WHERE id = ?', [u.id]));
  }
  // Usuarios visibles para el personal de una escuela: su personal y sus tutores
  function visibleUsersWhere(actor) {
    const id = sch(actor);
    return id === null ? "u.role <> 'superadmin' AND u.deleted_at IS NULL" : `u.deleted_at IS NULL AND ((u.role IN ('admin','cajero') AND u.school_id = ${id}) OR (u.role = 'tutor' AND ${TUTOR_IN_SCHOOL(id)}))`;
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
      if (u.role === 'tutor') u.children = db.all(`SELECT id, full_name FROM children WHERE tutor_id = ? AND deleted_at IS NULL${scope(actor)} ORDER BY full_name`, [u.id]);
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
      ? db.all('SELECT * FROM children WHERE tutor_id = ? AND deleted_at IS NULL ORDER BY full_name', [actor.id])
      : db.all(`SELECT * FROM children WHERE deleted_at IS NULL${scope(actor)} ORDER BY full_name`);
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
    // El tutor solo puede cambiar la foto de su hijo. Nombre y grado/grupo los cambia la escuela
    // (el tutor los pide con "Solicitar cambio de datos"). Solo admin cambia tutor o estado.
    if (actor.role === 'tutor') {
      const same = (a, b) => String(a === null || a === undefined ? '' : a).trim() === String(b === null || b === undefined ? '' : b).trim();
      if ((data.full_name !== undefined && !same(data.full_name, c.full_name)) || (data.grade !== undefined && !same(data.grade, c.grade))) {
        throw new AppError('El nombre y el grado/grupo solo los cambia la escuela. Use "Solicitar cambio de datos".', 'PROHIBIDO');
      }
      data = { photo: data.photo };
    }
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

  // ---------- solicitudes de cambio de datos del alumno (tutor → escuela) ----------
  const CR_FIELDS = { nombre: 'Nombre', grado: 'Grado y grupo', otro: 'Otro' };
  function crRow(r) {
    if (!r) return null;
    return { ...r, field_label: CR_FIELDS[r.field] || r.field, unread: !r.admin_read_at };
  }
  const CR_SELECT = `SELECT r.*, c.full_name AS child_name, c.grade AS child_grade, u.full_name AS tutor_name, u.phone AS tutor_phone, u.email AS tutor_email
    FROM child_change_requests r LEFT JOIN children c ON c.id = r.child_id LEFT JOIN users u ON u.id = r.tutor_id`;
  function requestChildChange(actor, data = {}) {
    requireRole(actor, 'tutor');
    const c = assertChildAccess(actor, data.child_id);
    const field = String(data.field || '').trim().toLowerCase();
    if (!CR_FIELDS[field]) throw new AppError('Indique qué dato quiere cambiar (Nombre, Grado y grupo u Otro)', 'VALIDACION');
    const max = field === 'nombre' ? 120 : (field === 'grado' ? 30 : 200);
    const new_value = str(data.new_value, 'valor nuevo', { optional: field === 'otro', max });
    const comment = str(data.comment, 'motivo/comentario', { optional: true, max: 500 });
    if (field === 'otro' && !new_value && !comment) throw new AppError('Describa el cambio que necesita', 'VALIDACION');
    const old_value = field === 'nombre' ? c.full_name : (field === 'grado' ? c.grade : null);
    if (field !== 'otro' && String(old_value || '').trim() === new_value) throw new AppError('El valor nuevo es igual al actual', 'VALIDACION');
    const pending = db.get("SELECT COUNT(*) AS n FROM child_change_requests WHERE child_id = ? AND status = 'pendiente'", [c.id]).n;
    if (pending >= 10) throw new AppError('Ya hay muchas solicitudes pendientes para este alumno. Espere la respuesta de la escuela.', 'VALIDACION');
    const r = db.run('INSERT INTO child_change_requests (school_id, child_id, tutor_id, field, old_value, new_value, comment, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [c.school_id, c.id, actor.id, field, old_value, new_value, comment, 'pendiente', ts()]);
    return crRow(db.get(`${CR_SELECT} WHERE r.id = ?`, [r.lastId]));
  }
  function listChangeRequests(actor, f = {}) {
    requireRole(actor, 'admin', 'tutor');
    const w = []; const p = [];
    if (actor.role === 'tutor') { w.push('r.tutor_id = ?'); p.push(actor.id); } else { w.push('r.school_id = ?'); p.push(sch(actor)); }
    if (f.child_id) { w.push('r.child_id = ?'); p.push(int(f.child_id, 'alumno', { min: 1 })); }
    if (f.status) { if (!['pendiente', 'aprobada', 'rechazada'].includes(f.status)) throw new AppError('Estado inválido', 'VALIDACION'); w.push('r.status = ?'); p.push(f.status); }
    const rows = db.all(`${CR_SELECT} WHERE ${w.join(' AND ')} ORDER BY CASE r.status WHEN 'pendiente' THEN 0 ELSE 1 END, r.id DESC LIMIT 300`, p).map(crRow);
    if (actor.role === 'tutor') for (const r of rows) { delete r.admin_read_at; delete r.unread; delete r.resolved_by; }
    return rows;
  }
  function changeRequestsUnread(actor) {
    requireRole(actor, 'admin');
    const sid = sch(actor);
    return {
      unread: db.get('SELECT COUNT(*) AS n FROM child_change_requests WHERE school_id = ? AND admin_read_at IS NULL', [sid]).n,
      pending: db.get("SELECT COUNT(*) AS n FROM child_change_requests WHERE school_id = ? AND status = 'pendiente'", [sid]).n,
      notices: db.get('SELECT COUNT(*) AS n FROM school_notices WHERE school_id = ? AND read_at IS NULL', [sid]).n,
    };
  }
  function markChangeRequestsRead(actor) {
    requireRole(actor, 'admin');
    const r = db.run('UPDATE child_change_requests SET admin_read_at = ? WHERE school_id = ? AND admin_read_at IS NULL', [ts(), sch(actor)]);
    return { marked: r.changes };
  }
  function resolveChangeRequest(actor, data = {}) {
    requireRole(actor, 'admin');
    const req = db.get('SELECT * FROM child_change_requests WHERE id = ? AND school_id = ?', [int(data.id, 'solicitud', { min: 1 }), sch(actor)]);
    if (!req) throw new AppError('Solicitud no encontrada', 'NO_ENCONTRADO');
    if (req.status !== 'pendiente') throw new AppError('Esta solicitud ya fue atendida', 'CONFLICTO');
    const decision = data.decision === 'aprobar' || data.decision === 'aprobada' ? 'aprobada' : (data.decision === 'rechazar' || data.decision === 'rechazada' ? 'rechazada' : null);
    if (!decision) throw new AppError('Indique si aprueba o rechaza la solicitud', 'VALIDACION');
    const reason = decision === 'rechazada' ? str(data.reason, 'motivo del rechazo', { optional: true, max: 300 }) : null;
    let applied = null;
    return db.transaction(() => {
      if (decision === 'aprobada' && req.field !== 'otro') {
        const c = getChildOrFail(req.child_id, actor);
        if (req.field === 'nombre') {
          const v = str(req.new_value, 'nombre del alumno');
          db.run('UPDATE children SET full_name = ? WHERE id = ?', [v, c.id]); applied = { field: 'nombre', before: c.full_name, after: v };
        } else {
          const v = str(req.new_value, 'grado/grupo', { optional: true, max: 30 });
          db.run('UPDATE children SET grade = ? WHERE id = ?', [v, c.id]); applied = { field: 'grado', before: c.grade, after: v };
        }
      }
      db.run('UPDATE child_change_requests SET status = ?, resolved_at = ?, resolved_by = ?, resolved_by_name = ?, reject_reason = ?, admin_read_at = COALESCE(admin_read_at, ?) WHERE id = ?',
        [decision, ts(), actor.id, actor.full_name || actor.username || null, reason, ts(), req.id]);
      return { request: crRow(db.get(`${CR_SELECT} WHERE r.id = ?`, [req.id])), applied };
    });
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
    const lowOnly = !!(f && f.low);
    const rows = db.all(`SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.deleted_at IS NULL${catalogScope(actor, f || {}, 'p')} ${onlyActive ? 'AND p.active = 1' : ''} ${lowOnly ? 'AND p.stock IS NOT NULL AND p.stock_min IS NOT NULL AND p.stock <= p.stock_min' : ''} ORDER BY c.name, p.name`);
    return rows.map((p) => {
      const o = { ...p, active: !!p.active, low_stock: isLow(p) };
      delete o.low_notified;
      if (actor.role === 'tutor') { delete o.stock; delete o.stock_min; delete o.low_stock; }
      return o;
    });
  }
  // ---------- inventario ----------
  const isLow = (p) => p.stock !== null && p.stock !== undefined && p.stock_min !== null && p.stock_min !== undefined && p.stock <= p.stock_min;
  function optStock(v, field) { return v === '' || v === null || v === undefined ? null : int(v, field, { min: 0, max: 1000000 }); }
  function logStock(p, kind, qty, extra = {}) {
    const after = db.get('SELECT stock FROM products WHERE id = ?', [p.id]).stock;
    db.run('INSERT INTO stock_moves (school_id, product_id, kind, qty, stock_after, note, transaction_id, user_id, user_name, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [p.school_id, p.id, kind, qty, after, extra.note || null, extra.transaction_id || null, extra.actor ? extra.actor.id : null, extra.actor ? (extra.actor.full_name || extra.actor.username || null) : null, ts()]);
  }
  // Aviso "por agotarse" una sola vez por cruce del mínimo (se rearma cuando vuelve a quedar arriba)
  function checkLowStock(productId) {
    const p = db.get('SELECT * FROM products WHERE id = ?', [productId]); if (!p) return;
    if (isLow(p)) {
      if (!p.low_notified) {
        db.run('UPDATE products SET low_notified = 1 WHERE id = ?', [p.id]);
        const msg = p.stock <= 0 ? `Se agotó "${p.name}" (quedan ${p.stock} piezas; mínimo ${p.stock_min}).` : `"${p.name}" está por agotarse: quedan ${p.stock} piezas (mínimo ${p.stock_min}).`;
        db.run('INSERT INTO school_notices (school_id, kind, message, ref_type, ref_id, created_at) VALUES (?,?,?,?,?,?)', [p.school_id, 'inventario', msg, 'product', p.id, ts()]);
      }
    } else if (p.low_notified) db.run('UPDATE products SET low_notified = 0 WHERE id = ?', [p.id]);
  }
  function addStock(actor, data = {}) {
    requireRole(actor, 'admin');
    const p = db.get(`SELECT * FROM products WHERE id = ? AND deleted_at IS NULL${scope(actor)}`, [int(data.product_id, 'producto', { min: 1 })]);
    if (!p) throw new AppError('Producto no encontrado', 'NO_ENCONTRADO');
    const qty = int(data.qty, 'piezas', { min: 1, max: 100000 });
    const note = str(data.note, 'nota', { optional: true, max: 200 });
    return db.transaction(() => {
      db.run('UPDATE products SET stock = COALESCE(stock, 0) + ? WHERE id = ?', [qty, p.id]);
      logStock(p, 'entrada', qty, { note, actor });
      checkLowStock(p.id);
      return db.get('SELECT * FROM products WHERE id = ?', [p.id]);
    });
  }
  function listStockMoves(actor, f = {}) {
    requireRole(actor, 'admin');
    const w = [`m.school_id = ${sch(actor)}`]; const prm = [];
    if (f.product_id) { w.push('m.product_id = ?'); prm.push(int(f.product_id, 'producto', { min: 1 })); }
    return db.all(`SELECT m.*, p.name AS product_name FROM stock_moves m JOIN products p ON p.id = m.product_id WHERE ${w.join(' AND ')} ORDER BY m.id DESC LIMIT 300`, prm);
  }
  function getInventorySettings(actor) {
    requireRole(actor, 'admin', 'cajero');
    const r = db.get('SELECT stock_block_zero FROM schools WHERE id = ?', [sch(actor)]) || {};
    return { block_at_zero: r.stock_block_zero === undefined || r.stock_block_zero === null ? true : !!r.stock_block_zero };
  }
  function setInventorySettings(actor, data = {}) {
    requireRole(actor, 'admin');
    db.run('UPDATE schools SET stock_block_zero = ? WHERE id = ?', [data.block_at_zero ? 1 : 0, sch(actor)]);
    return getInventorySettings(actor);
  }
  // ---------- avisos de la escuela (Notificaciones) ----------
  function listSchoolNotices(actor) {
    requireRole(actor, 'admin');
    return db.all('SELECT * FROM school_notices WHERE school_id = ? ORDER BY id DESC LIMIT 200', [sch(actor)]).map((n) => ({ ...n, unread: !n.read_at }));
  }
  function markNoticesRead(actor) {
    requireRole(actor, 'admin');
    return { marked: db.run('UPDATE school_notices SET read_at = ? WHERE school_id = ? AND read_at IS NULL', [ts(), sch(actor)]).changes };
  }
  function productData(actor, data, prev = {}) {
    const name = data.name !== undefined ? str(data.name, 'nombre del producto', { max: 80 }) : prev.name;
    const category_id = data.category_id !== undefined ? int(data.category_id, 'categoría', { min: 1 }) : prev.category_id;
    if (!db.get(`SELECT id FROM categories WHERE id = ?${scope(actor)}`, [category_id])) throw new AppError('Categoría no encontrada', 'NO_ENCONTRADO');
    const price_cents = data.price_cents !== undefined ? cents(data.price_cents, 'precio') : prev.price_cents;
    const active = data.active !== undefined ? (data.active ? 1 : 0) : (prev.active === undefined ? 1 : prev.active);
    const stock = data.stock !== undefined ? optStock(data.stock, 'existencias (piezas)') : (prev.stock === undefined ? null : prev.stock);
    const stock_min = data.stock_min !== undefined ? optStock(data.stock_min, 'stock mínimo') : (prev.stock_min === undefined ? null : prev.stock_min);
    return { name, category_id, price_cents, active, stock, stock_min };
  }
  function createProduct(actor, data) {
    requireRole(actor, 'admin');
    const p = productData(actor, data);
    return db.transaction(() => {
      const r = db.run('INSERT INTO products (school_id, name, category_id, price_cents, active, stock, stock_min, created_at) VALUES (?,?,?,?,?,?,?,?)', [sch(actor), p.name, p.category_id, p.price_cents, p.active, p.stock, p.stock_min, ts()]);
      const np = db.get('SELECT * FROM products WHERE id = ?', [r.lastId]);
      if (p.stock !== null) logStock(np, 'inicial', p.stock, { actor });
      checkLowStock(np.id);
      return db.get('SELECT * FROM products WHERE id = ?', [r.lastId]);
    });
  }
  function updateProduct(actor, id, data) {
    requireRole(actor, 'admin');
    const prev = db.get(`SELECT * FROM products WHERE id = ? AND deleted_at IS NULL${scope(actor)}`, [int(id, 'id', { min: 1 })]);
    if (!prev) throw new AppError('Producto no encontrado', 'NO_ENCONTRADO');
    const p = productData(actor, data, prev);
    return db.transaction(() => {
      db.run('UPDATE products SET name=?, category_id=?, price_cents=?, active=?, stock=?, stock_min=? WHERE id=?', [p.name, p.category_id, p.price_cents, p.active, p.stock, p.stock_min, prev.id]);
      if (p.stock !== prev.stock && p.stock !== null) logStock(prev, 'ajuste', p.stock - (prev.stock || 0), { actor, note: prev.stock === null ? 'Inicio de control de inventario' : 'Corrección de existencias' });
      checkLowStock(prev.id);
      return db.get('SELECT * FROM products WHERE id = ?', [prev.id]);
    });
  }
  // Borrado lógico: el producto pasa a la papelera (se puede restaurar) y se oculta del punto de venta
  function deleteProduct(actor, id) {
    requireRole(actor, 'admin');
    const p = db.get(`SELECT * FROM products WHERE id = ? AND deleted_at IS NULL${scope(actor)}`, [int(id, 'id', { min: 1 })]);
    if (!p) throw new AppError('Producto no encontrado', 'NO_ENCONTRADO');
    db.run('UPDATE products SET active = 0, deleted_at = ? WHERE id = ?', [ts(), p.id]);
    return { deleted: true, soft: true, product: { id: p.id, name: p.name, school_id: p.school_id }, message: 'Producto enviado a la papelera (se puede restaurar).' };
  }

  // ---------- inventario de tarjetas (lista blanca del superadministrador) ----------
  // Una tarjeta solo se registra, asigna, cobra o recarga si su UID está en el inventario de Zuki Company,
  // entregada a ESA escuela y no bloqueada/dañada. Se activa en el servidor (opts.cardStock).
  const enforceStock = opts.cardStock === true;
  const NOT_AUTH = 'Tarjeta no autorizada. Solicite tarjetas a Zuki Company.';
  const OP_LABEL = { registrar: 'registrar tarjeta', asignar: 'asignar tarjeta', venta: 'venta', recarga: 'recarga', reemplazo: 'tarjeta de reemplazo' };
  function stockProblem(uid, schoolId) {
    const s = db.get('SELECT * FROM card_stock WHERE uid = ?', [uid]);
    if (!s) return 'no está en el inventario de Zuki Company';
    if (s.status === 'bloqueada') return 'bloqueada en el inventario';
    if (s.status === 'danada') return 'marcada como dañada';
    if (s.status === 'en_stock' || s.school_id === null || s.school_id === undefined) return 'no ha sido entregada a ninguna escuela';
    if (s.school_id !== schoolId) return `entregada a otra escuela (${schoolName(s.school_id) || '#' + s.school_id})`;
    return null;
  }
  function assertCardAuthorized(actor, uid, op, schoolId) {
    if (!enforceStock) return;
    const why = stockProblem(uid, schoolId);
    if (!why) return;
    const school = schoolName(schoolId) || (schoolId ? '#' + schoolId : '—');
    const who = (actor && (actor.full_name || actor.username)) || '?';
    const details = JSON.stringify({ uid, escuela: school, usuario: who, rol: actor && actor.role, operacion: OP_LABEL[op] || op, motivo: why });
    try {
      const t = ts(); const since = fmtLocal(new Date(now().getTime() - 10 * 60000));
      // Una alerta por tarjeta/escuela cada 10 min (el lector puede leer la misma tarjeta varias veces)
      if (!db.get('SELECT id FROM alerts WHERE kind = ? AND school_id IS ? AND details = ? AND created_at >= ? AND ack_at IS NULL', ['tarjeta_no_autorizada', schoolId || null, details, since])) {
        db.run('INSERT INTO alerts (created_at, school_id, kind, severity, message, details, ref_type, ref_id) VALUES (?,?,?,?,?,?,?,?)',
          [t, schoolId || null, 'tarjeta_no_autorizada', 'alta', `Tarjeta no autorizada ${uid} en ${school} (${OP_LABEL[op] || op}, por ${who}): ${why}.`, details, null, null]);
      }
      db.run('INSERT INTO audit_log (created_at, actor_id, actor_name, actor_role, school_id, ip, action, target_type, target_id, details, severity) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [t, (actor && actor.id) || null, who, (actor && actor.role) || null, schoolId || null, null, 'tarjeta_no_autorizada', 'card', uid, details, 'alta']);
    } catch (e) { console.error('[tarjetas] alerta:', e.message); }
    throw new AppError(NOT_AUTH, 'TARJETA_NO_AUTORIZADA');
  }
  const stockScope = (actor) => { const id = sch(actor); return id === null ? '' : ` AND uid IN (SELECT uid FROM card_stock WHERE school_id = ${id})`; };
  // Tarjetas del inventario entregadas a la escuela del administrador (para registrar/asignar)
  function listSchoolStock(actor) {
    requireRole(actor, 'admin');
    const id = sch(actor);
    return db.all(`SELECT s.uid, s.kind, s.status, s.batch, s.delivered_at, k.id AS card_id, k.child_id, c.full_name AS child_name
      FROM card_stock s LEFT JOIN cards k ON k.uid = s.uid LEFT JOIN children c ON c.id = k.child_id
      WHERE s.school_id = ? AND s.status IN ('entregada','asignada') ORDER BY s.status, s.uid`, [id]);
  }

  // ---------- tarjetas ----------
  function cardRow(k) {
    if (!k) return null;
    const child = k.child_id ? db.get('SELECT c.id, c.full_name, c.grade, c.photo, c.tutor_id, u.full_name AS tutor_name FROM children c LEFT JOIN users u ON u.id = c.tutor_id WHERE c.id = ?', [k.child_id]) : null;
    return { ...k, child };
  }
  function listCards(actor) {
    requireRole(actor, 'admin', 'cajero');
    return db.all(`SELECT * FROM cards WHERE 1=1${scope(actor)}${enforceStock ? stockScope(actor) : ''} ORDER BY id DESC`).map((k) => {
      const row = cardRow(k);
      if (enforceStock) { const st = db.get('SELECT status FROM card_stock WHERE uid = ?', [k.uid]); row.stock_status = st ? st.status : null; }
      return row;
    });
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
    assertCardAuthorized(actor, uid, data.child_id ? 'asignar' : 'registrar', sch(actor));
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
    assertCardAuthorized(actor, k.uid, 'asignar', k.school_id);
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
  // Asigna una tarjeta a un alumno escribiendo o leyendo su UID (lector USB tipo teclado de 125 kHz o NFC):
  // si el UID no existe se registra; si está en inventario (sin asignar) se asigna; nunca se duplica.
  function assignCardByUid(actor, data = {}) {
    requireRole(actor, 'admin');
    const uid = normUid(data.uid);
    const c = getChildOrFail(data.child_id, actor);
    assertCardAuthorized(actor, uid, 'asignar', sch(actor) === null ? c.school_id : sch(actor));
    const k = db.get('SELECT * FROM cards WHERE uid = ?', [uid]);
    if (!k) return registerCard(actor, { uid, child_id: c.id });
    if (k.school_id !== sch(actor) && !single) throw new AppError('Esa tarjeta (UID) ya está registrada en otra escuela', 'DUPLICADO');
    if (k.child_id === c.id && ['activa', 'bloqueada'].includes(k.status)) throw new AppError('Esa tarjeta ya está asignada a este alumno', 'DUPLICADO');
    if (k.status === 'perdida') throw new AppError('Esa tarjeta fue reportada como perdida y no puede volver a usarse', 'VALIDACION');
    if (k.child_id && k.child_id !== c.id && ['activa', 'bloqueada'].includes(k.status)) {
      const other = db.get('SELECT full_name FROM children WHERE id = ?', [k.child_id]);
      throw new AppError(`Esa tarjeta ya está asignada a ${other ? other.full_name : 'otro alumno'}. Quítesela primero.`, 'DUPLICADO');
    }
    return assignCard(actor, k.id, c.id);
  }
  // Quita la tarjeta al alumno y la regresa al inventario (solo con saldo $0; si tiene saldo, use "perdida/reemplazar")
  function unassignCard(actor, cardId) {
    requireRole(actor, 'admin');
    const k = getCardOrFail(actor, cardId);
    if (!k.child_id || k.status === 'sin_asignar') throw new AppError('La tarjeta no está asignada a ningún alumno', 'VALIDACION');
    if (k.status === 'perdida') throw new AppError('La tarjeta está reportada como perdida', 'VALIDACION');
    if (k.balance_cents > 0) throw new AppError('La tarjeta tiene saldo. Use "Reemplazar tarjeta" para pasar el saldo a una nueva, o haga un ajuste a $0 antes de quitarla.', 'VALIDACION');
    db.run("UPDATE cards SET child_id = NULL, status = 'sin_asignar', blocked_by = NULL WHERE id = ?", [k.id]);
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
    if (uid) assertCardAuthorized(actor, uid, 'reemplazo', k.school_id);
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
  // Límites y prohibidos: SOLO el padre/madre/tutor del alumno (la escuela solo los consulta)
  function requireTutorSetting(actor, what) {
    requireRole(actor, 'admin', 'cajero', 'tutor');
    if (actor.role !== 'tutor') throw new AppError(`Solo el padre, madre o tutor puede configurar ${what}. La escuela solo puede consultarlos.`, 'PROHIBIDO');
  }
  function setLimits(actor, childId, data) {
    requireTutorSetting(actor, 'los límites de gasto');
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
    requireTutorSetting(actor, 'los productos prohibidos');
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
    assertCardAuthorized(actor, normUid(data.uid), 'recarga', sch(actor));
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
    assertCardAuthorized(actor, uid, 'venta', sch(actor));

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
      // 6) Existencias (solo productos con control de inventario y si la escuela bloquea la venta sin existencias)
      const blockZero = (db.get('SELECT stock_block_zero FROM schools WHERE id = ?', [k.school_id]) || { stock_block_zero: 1 }).stock_block_zero !== 0;
      if (blockZero) {
        const out = lines.find((l) => l.product.stock !== null && l.product.stock < l.qty);
        if (out) return reject(out.product.stock <= 0 ? `Sin existencias: ${out.product.name}` : `Existencias insuficientes: ${out.product.name} (quedan ${out.product.stock})`);
      }

      // Aprobar: actualización condicional (defensa extra contra carreras)
      const upd = db.run('UPDATE cards SET balance_cents = balance_cents - ? WHERE id = ? AND balance_cents >= ? AND status = \'activa\'', [total, k.id, total]);
      if (upd.changes !== 1) throw new AppError('No se pudo aplicar el cargo, intenta de nuevo', 'CONFLICTO');
      const newBal = k.balance_cents - total;
      const r = db.run(`INSERT INTO transactions (type,status,amount_cents,balance_after_cents,card_id,card_uid,child_id,user_id,created_at)
        VALUES ('compra','aprobado',?,?,?,?,?,?,?)`, [total, newBal, k.id, k.uid, child.id, actor.id, t]);
      for (const l of lines) {
        db.run(`INSERT INTO transaction_items (transaction_id, product_id, product_name, category_name, qty, unit_price_cents, subtotal_cents)
          VALUES (?,?,?,?,?,?,?)`, [r.lastId, l.product.id, l.product.name, l.product.category_name, l.qty, l.product.price_cents, l.subtotal]);
        if (l.product.stock !== null) {
          // descuento atómico dentro de la misma transacción de la venta
          const su = db.run(`UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL${blockZero ? ' AND stock >= ?' : ''}`, blockZero ? [l.qty, l.product.id, l.qty] : [l.qty, l.product.id]);
          if (su.changes !== 1) throw new AppError('Existencias insuficientes, intenta de nuevo', 'CONFLICTO');
          logStock(l.product, 'venta', -l.qty, { transaction_id: r.lastId, actor });
          checkLowStock(l.product.id);
        }
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
    const rows = db.all(`SELECT t.*, COALESCE(ch.full_name, t.child_name) AS child_name, COALESCE(u.full_name, t.processed_by_name) AS user_name
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

  // ---------- cancelar venta (devuelve el saldo y regresa las piezas al inventario) ----------
  function reverseSale(actor, data = {}) {
    requireRole(actor, 'admin');
    const reason = str(data.reason, 'motivo de la cancelación', { max: 200 });
    return db.transaction(() => {
      const t = db.get(`SELECT * FROM transactions WHERE id = ?${scope(actor)}`, [int(data.transaction_id, 'venta', { min: 1 })]);
      if (!t || t.type !== 'compra') throw new AppError('Venta no encontrada', 'NO_ENCONTRADO');
      if (t.status !== 'aprobado') throw new AppError('Solo se pueden cancelar ventas aprobadas', 'VALIDACION');
      if (t.reversed_at) throw new AppError('Esta venta ya fue cancelada', 'CONFLICTO');
      const k = db.get('SELECT * FROM cards WHERE id = ?', [t.card_id]);
      if (!k) throw new AppError('Tarjeta no encontrada', 'NO_ENCONTRADO');
      const nb = k.balance_cents + t.amount_cents;
      db.run('UPDATE cards SET balance_cents = ? WHERE id = ?', [nb, k.id]);
      const x = db.run(`INSERT INTO transactions (school_id,type,status,amount_cents,balance_after_cents,card_id,card_uid,child_id,user_id,note,created_at)
        VALUES (?,'ajuste','aprobado',?,?,?,?,?,?,?,?)`, [t.school_id, t.amount_cents, nb, k.id, k.uid, t.child_id, actor.id, `Cancelación de venta #${t.id}: ${reason}`, ts()]);
      db.run('UPDATE transactions SET reversed_at = ?, reversed_by = ? WHERE id = ?', [ts(), actor.full_name || actor.username || null, t.id]);
      for (const it of db.all('SELECT * FROM transaction_items WHERE transaction_id = ?', [t.id])) {
        const p = it.product_id ? db.get('SELECT * FROM products WHERE id = ?', [it.product_id]) : null;
        if (p && p.stock !== null) {
          db.run('UPDATE products SET stock = stock + ? WHERE id = ?', [it.qty, p.id]);
          logStock(p, 'cancelacion', it.qty, { transaction_id: t.id, actor, note: reason });
          checkLowStock(p.id);
        }
      }
      return { reversal_id: x.lastId, balance_cents: nb, transaction_id: t.id };
    });
  }

  // ---------- reportes (rango de fechas) ----------
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  function report(actor, f = {}) {
    requireRole(actor, 'admin', 'cajero');
    const sid = sch(actor);
    let from = f.from; let to = f.to; let userId = null;
    // El cajero solo ve su "Corte del día" (sus ventas de hoy)
    if (actor.role === 'cajero') { from = to = fmtDate(now()); userId = actor.id; }
    if (!from) from = fmtDate(now()); if (!to) to = from;
    if (!YMD.test(from) || !YMD.test(to)) throw new AppError('Fechas inválidas (AAAA-MM-DD)', 'VALIDACION');
    if (from > to) throw new AppError('La fecha inicial es posterior a la final', 'VALIDACION');
    const a = from + ' 00:00:00'; const b = to + ' 23:59:59';
    const U = userId ? ` AND t.user_id = ${Number(userId)}` : '';
    const W = ` AND t.school_id = ${Number(sid)} AND t.created_at >= ? AND t.created_at <= ?${U}`;
    const SALE = `t.type='compra' AND t.status='aprobado' AND t.reversed_at IS NULL`;
    const sales = db.get(`SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM transactions t WHERE ${SALE}${W}`, [a, b]);
    const rech = db.get(`SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM transactions t WHERE t.type='recarga' AND t.status='aprobado'${W}`, [a, b]);
    const rej = db.get(`SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM transactions t WHERE t.type='compra' AND t.status='rechazado'${W}`, [a, b]);
    const refunds = db.get(`SELECT COALESCE(SUM(-amount_cents),0) AS s, COUNT(*) AS n FROM transactions t WHERE t.type='ajuste' AND t.subtype='reembolso' AND t.status='aprobado'${W}`, [a, b]);
    const canc = db.get(`SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS n FROM transactions t WHERE t.type='compra' AND t.reversed_at IS NOT NULL${W}`, [a, b]);
    const byDayRows = db.all(`SELECT substr(t.created_at,1,10) AS date, SUM(amount_cents) AS total_cents, COUNT(*) AS n FROM transactions t WHERE ${SALE}${W} GROUP BY 1`, [a, b]);
    const map = new Map(byDayRows.map((r) => [r.date, r]));
    const days = [];
    const d0 = new Date(from + 'T12:00:00'); const d1 = new Date(to + 'T12:00:00');
    for (let d = new Date(d0), i = 0; d <= d1 && i < 400; d.setDate(d.getDate() + 1), i++) { const k = fmtDate(d); const r = map.get(k); days.push({ date: k, total_cents: r ? r.total_cents : 0, count: r ? r.n : 0 }); }
    const top = db.all(`SELECT ti.product_name AS name, SUM(ti.qty) AS qty, SUM(ti.subtotal_cents) AS total_cents FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
      WHERE ${SALE}${W} GROUP BY ti.product_name ORDER BY qty DESC, total_cents DESC LIMIT 10`, [a, b]);
    const byCashier = db.all(`SELECT COALESCE(u.full_name, t.processed_by_name, 'Sin nombre') AS name, COUNT(*) AS count, SUM(t.amount_cents) AS total_cents FROM transactions t LEFT JOIN users u ON u.id = t.user_id
      WHERE ${SALE}${W} GROUP BY 1 ORDER BY total_cents DESC`, [a, b]);
    const rejected = db.all(`SELECT t.id, t.created_at, t.reason, t.amount_cents, COALESCE(ch.full_name, t.child_name) AS child_name FROM transactions t LEFT JOIN children ch ON ch.id = t.child_id
      WHERE t.type='compra' AND t.status='rechazado'${W} ORDER BY t.id DESC LIMIT 50`, [a, b]);
    return {
      school_name: schoolName(sid), from, to, only_cashier: userId ? (actor.full_name || actor.username) : null, generated_at: ts(),
      sales_cents: sales.s, sales_count: sales.n, avg_ticket_cents: sales.n ? Math.round(sales.s / sales.n) : 0,
      recharges_cents: rech.s, recharges_count: rech.n, rejected_count: rej.n, rejected_cents: rej.s, cancelled_count: canc.n, cancelled_cents: canc.s, refunds_count: refunds.n, refunds_cents: refunds.s,
      sales_by_day: days, top_products: top, by_cashier: byCashier, rejected,
    };
  }

  // ---------- preferencias de notificaciones del tutor ----------
  const PREF_DEFAULT = { purchases: true, rejected: true, low_balance: true, low_balance_cents: 5000 };
  function getPushPrefsRaw(userId) {
    const r = db.get('SELECT * FROM push_prefs WHERE user_id = ?', [userId]);
    return r ? { purchases: !!r.purchases, rejected: !!r.rejected, low_balance: !!r.low_balance, low_balance_cents: r.low_balance_cents } : { ...PREF_DEFAULT };
  }
  function getPushPrefs(actor) {
    requireRole(actor, 'tutor');
    return { ...getPushPrefsRaw(actor.id), subscriptions: db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [actor.id]).n };
  }
  function setPushPrefs(actor, data = {}) {
    requireRole(actor, 'tutor');
    const cur = getPushPrefsRaw(actor.id);
    const b = (v, d) => (v === undefined ? d : !!v);
    const th = data.low_balance_cents === undefined ? cur.low_balance_cents : int(data.low_balance_cents, 'saldo mínimo', { min: 100, max: 1000000 });
    const n = { purchases: b(data.purchases, cur.purchases), rejected: b(data.rejected, cur.rejected), low_balance: b(data.low_balance, cur.low_balance), low_balance_cents: th };
    db.run(`INSERT INTO push_prefs (user_id, purchases, rejected, low_balance, low_balance_cents, updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET purchases=excluded.purchases, rejected=excluded.rejected, low_balance=excluded.low_balance, low_balance_cents=excluded.low_balance_cents, updated_at=excluded.updated_at`,
    [actor.id, n.purchases ? 1 : 0, n.rejected ? 1 : 0, n.low_balance ? 1 : 0, n.low_balance_cents, ts()]);
    if (th !== cur.low_balance_cents) db.run('DELETE FROM low_balance_state WHERE child_id IN (SELECT id FROM children WHERE tutor_id = ?)', [actor.id]);
    return getPushPrefs(actor);
  }
  function pushSubscribe(actor, data = {}) {
    requireRole(actor, 'tutor');
    const sub = data.subscription || data;
    const endpoint = str(sub.endpoint, 'endpoint', { max: 1000 });
    if (!/^https:\/\//.test(endpoint)) throw new AppError('Suscripción inválida', 'VALIDACION');
    const keys = sub.keys || {};
    const p256dh = str(keys.p256dh, 'clave p256dh', { max: 200 }); const auth = str(keys.auth, 'clave auth', { max: 100 });
    if (db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [actor.id]).n >= 10) db.run('DELETE FROM push_subscriptions WHERE id = (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id LIMIT 1)', [actor.id]);
    db.run(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, failures=0`, [actor.id, endpoint, p256dh, auth, str(data.user_agent, 'ua', { optional: true, max: 300 }), ts()]);
    return getPushPrefs(actor);
  }
  function pushUnsubscribe(actor, data = {}) {
    requireRole(actor, 'tutor');
    if (data.endpoint) db.run('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?', [actor.id, String(data.endpoint)]);
    else db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [actor.id]);
    return getPushPrefs(actor);
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
    requestChildChange, listChangeRequests, changeRequestsUnread, markChangeRequestsRead, resolveChangeRequest,
    addStock, listStockMoves, getInventorySettings, setInventorySettings, listSchoolNotices, markNoticesRead, checkLowStock,
    reverseSale, report, getPushPrefs, getPushPrefsRaw, setPushPrefs, pushSubscribe, pushUnsubscribe,
    listCategories, createCategory, listProducts, createProduct, updateProduct, deleteProduct,
    listCards, listSchoolStock, registerCard, assignCard, assignCardByUid, unassignCard, setCardStatus, reportLostAndReplace, lookupCard,
    getLimits, setLimits, getProhibitions, setProhibitions,
    recharge, adjust, purchase, listMovements, childSummary, dashboard,
  };
}

module.exports = { createService, AppError, fmtLocal, normUid, normEmail, normPhone, str };
