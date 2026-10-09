'use strict';
// Panel del SUPERADMINISTRADOR (Zuki Company): alta y control de escuelas (multi-escuela).
// Solo lo usa el servidor. Cada función valida que el actor sea superadmin.
const { AppError, fmtLocal, str, normEmail, normPhone } = require('./service');
const { DEFAULT_CATEGORIES } = require('./seed');
const crypto = require('crypto');

const { STATUSES, isYmd } = require('./billing');
function tempPassword() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(10); let s = '';
  for (const x of b) s += A[x % A.length];
  return s;
}

function createPlatform(db, { svc, sync, auth, security = null, billing = null, now = () => new Date() } = {}) {
  const ts = () => fmtLocal(now());
  const need = (actor) => { if (!actor || actor.role !== 'superadmin') throw new AppError('Solo el superadministrador puede hacer esto', 'PROHIBIDO'); };
  const getSchool = (id) => {
    const s = db.get('SELECT * FROM schools WHERE id = ?', [Number(id) || 0]);
    if (!s) throw new AppError('Escuela no encontrada', 'NO_ENCONTRADO');
    return s;
  };
  const day0 = () => { const d = now(); return fmtLocal(new Date(d.getFullYear(), d.getMonth(), d.getDate())); };
  const month0 = () => { const d = now(); return fmtLocal(new Date(d.getFullYear(), d.getMonth(), 1)); };

  function statsOf(sid) {
    const q = (sql, p = []) => db.get(sql, [sid, ...p]);
    const sum = (type, since) => q(`SELECT COALESCE(SUM(amount_cents),0) AS s, COUNT(*) AS c FROM transactions WHERE school_id = ? AND type = ? AND status = 'aprobado' AND created_at >= ?`, [type, since]);
    const sd = sum('compra', day0()); const sm = sum('compra', month0()); const rm = sum('recarga', month0());
    const dev = q('SELECT COUNT(*) AS n, MAX(last_seen_at) AS last FROM devices WHERE school_id = ? AND revoked = 0');
    return {
      students: q('SELECT COUNT(*) AS n FROM children WHERE school_id = ? AND active = 1').n,
      tutors_linked: q('SELECT COUNT(DISTINCT tutor_id) AS n FROM children WHERE school_id = ? AND tutor_id IS NOT NULL').n,
      active_cards: q("SELECT COUNT(*) AS n FROM cards WHERE school_id = ? AND status = 'activa'").n,
      total_cards: q('SELECT COUNT(*) AS n FROM cards WHERE school_id = ?').n,
      sales_day_cents: sd.s, sales_month_cents: sm.s, sales_month_count: sm.c,
      sales_total_cents: q("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE school_id = ? AND type = 'compra' AND status = 'aprobado'").s,
      recharges_month_cents: rm.s,
      recharges_total_cents: q("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE school_id = ? AND type = 'recarga' AND status = 'aprobado'").s,
      balance_cents: q('SELECT COALESCE(SUM(balance_cents),0) AS s FROM cards WHERE school_id = ?').s,
      devices: dev.n, last_sync_at: dev.last || null,
      staff: q("SELECT COUNT(*) AS n FROM users WHERE school_id = ? AND role IN ('admin','cajero') AND active = 1").n,
    };
  }
  // Cada escuela incluye su mensualidad (estado, periodo, días restantes y etapa: ok/aviso/tolerancia/pausada)
  const schoolOut = (s) => {
    if (billing) { billing.evaluate(s.id); s = db.get('SELECT * FROM schools WHERE id = ?', [s.id]); }
    return { ...s, billing: billing ? billing.info(s) : null, stats: statsOf(s.id) };
  };

  function overview(actor) {
    need(actor);
    const schools = db.all('SELECT * FROM schools ORDER BY name').map(schoolOut);
    const keys = ['students', 'active_cards', 'total_cards', 'sales_day_cents', 'sales_month_cents', 'sales_total_cents', 'recharges_month_cents', 'recharges_total_cents', 'balance_cents', 'devices', 'tutors_linked'];
    const totals = Object.fromEntries(keys.map((k) => [k, schools.reduce((a, s) => a + (s.stats[k] || 0), 0)]));
    totals.schools = schools.length;
    for (const st of STATUSES) totals['schools_' + st] = schools.filter((s) => s.status === st).length;
    totals.schools_attention = schools.filter((s) => s.billing && ['aviso', 'tolerancia'].includes(s.billing.stage)).length;
    return { schools, totals };
  }

  function schoolData(data, prev = {}) {
    const g = (k, label, o) => (data[k] !== undefined ? str(data[k], label, { optional: true, ...o }) : (prev[k] === undefined ? null : prev[k]));
    const name = data.name !== undefined ? str(data.name, 'nombre de la escuela', { max: 120 }) : prev.name;
    if (!name) throw new AppError('El campo "nombre de la escuela" es obligatorio', 'VALIDACION');
    let status = data.status !== undefined ? data.status : (prev.status || 'prueba');
    if (status === 'suspendida') status = 'pausada'; // nombre anterior
    if (!STATUSES.includes(status)) throw new AppError('Estado inválido (prueba, activa o pausada)', 'VALIDACION');
    const contact_email = data.contact_email !== undefined ? (data.contact_email ? normEmail(data.contact_email) : null) : (prev.contact_email || null);
    let contact_phone = prev.contact_phone || null;
    if (data.contact_phone !== undefined) {
      contact_phone = data.contact_phone ? normPhone(data.contact_phone) : null;
      if (data.contact_phone && !contact_phone) throw new AppError('Teléfono inválido (10 dígitos)', 'VALIDACION');
    }
    return { name, status, plan_note: g('plan_note', 'plan / cuota', { max: 300 }), contact_name: g('contact_name', 'contacto', { max: 120 }), contact_phone, contact_email };
  }

  function makeStaff(sid, data) {
    const role = data.role || 'admin';
    if (!['admin', 'cajero'].includes(role)) throw new AppError('Rol inválido (admin o cajero)', 'VALIDACION');
    const password = tempPassword();
    const system = { id: 0, role: 'admin', school_id: sid };
    const u = svc.createUser(system, { role, username: data.username, full_name: data.full_name, email: data.email || null, phone: data.phone || null, password });
    return { user: u, temporary_password: password };
  }

  function createSchool(actor, data = {}) {
    need(actor);
    const d = schoolData(data);
    return db.transaction(() => {
      if (db.get('SELECT id FROM schools WHERE lower(name) = lower(?)', [d.name])) throw new AppError('Ya existe una escuela con ese nombre', 'DUPLICADO');
      // Mensualidad: una escuela nueva empieza en Prueba por 30 días (o Activa por un mes) desde hoy
      if (d.status === 'pausada') throw new AppError('Una escuela nueva debe empezar en Prueba o Activa', 'VALIDACION');
      const per = billing ? billing.defaultPeriod(d.status) : { period_start: null, period_end: null };
      if (data.period_end) {
        if (!isYmd(String(data.period_end)) || String(data.period_end) < per.period_start) throw new AppError('Fecha fin inválida', 'VALIDACION');
        per.period_end = String(data.period_end);
      }
      const sid = db.run('INSERT INTO schools (name, status, plan_note, contact_name, contact_phone, contact_email, created_at, period_start, period_end) VALUES (?,?,?,?,?,?,?,?,?)',
        [d.name, d.status, d.plan_note, d.contact_name, d.contact_phone, d.contact_email, ts(), per.period_start, per.period_end]).lastId;
      for (const n of DEFAULT_CATEGORIES) db.run('INSERT INTO categories (school_id, name) VALUES (?, ?)', [sid, n]);
      const admin = makeStaff(sid, { role: 'admin', username: data.admin_username, full_name: data.admin_full_name || `Administrador ${d.name}`, email: data.admin_email, phone: data.admin_phone });
      return { school: schoolOut(getSchool(sid)), admin };
    });
  }
  function updateSchool(actor, id, data = {}) {
    need(actor);
    const prev = getSchool(id);
    const d = schoolData(data, prev);
    if (db.get('SELECT id FROM schools WHERE lower(name) = lower(?) AND id <> ?', [d.name, prev.id])) throw new AppError('Ya existe una escuela con ese nombre', 'DUPLICADO');
    const prevStatus = prev.status === 'suspendida' ? 'pausada' : prev.status;
    db.run('UPDATE schools SET name=?, plan_note=?, contact_name=?, contact_phone=?, contact_email=? WHERE id=?',
      [d.name, d.plan_note, d.contact_name, d.contact_phone, d.contact_email, prev.id]);
    // El estado se cambia con las reglas de la mensualidad (pausar cierra sesiones; reactivar da un periodo vigente)
    if (d.status !== prevStatus) {
      if (!billing) db.run('UPDATE schools SET status = ? WHERE id = ?', [d.status, prev.id]);
      else if (d.status === 'pausada') billing.pause(prev.id, { reason: 'manual', actor });
      else if (prevStatus === 'pausada') billing.reactivate(actor, { school_id: prev.id, status: d.status });
      else db.run('UPDATE schools SET status = ? WHERE id = ?', [d.status, prev.id]);
    }
    return schoolOut(getSchool(prev.id));
  }
  function schoolDetail(actor, id) {
    need(actor);
    const s = getSchool(id);
    return {
      school: schoolOut(s),
      payments: billing ? billing.listPayments(actor, s.id) : [],
      staff: db.all("SELECT * FROM users WHERE school_id = ? AND role IN ('admin','cajero') ORDER BY role, full_name", [s.id]).map(svc.publicUser),
      devices: sync.listDevices(actor, s.id),
      invitations: auth.listInvitations(actor, { school_id: s.id }).slice(0, 100),
    };
  }
  function createStaff(actor, schoolId, data = {}) { need(actor); return makeStaff(getSchool(schoolId).id, data); }
  function staffOf(userId) {
    const u = db.get("SELECT * FROM users WHERE id = ? AND role IN ('admin','cajero')", [Number(userId) || 0]);
    if (!u) throw new AppError('Usuario no encontrado', 'NO_ENCONTRADO');
    return u;
  }
  function resetStaffPassword(actor, userId) {
    need(actor);
    const u = staffOf(userId);
    const password = tempPassword();
    const bcrypt = require('bcryptjs');
    db.transaction(() => {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, active = 1 WHERE id = ?', [bcrypt.hashSync(password, 10), u.id]);
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [u.id]);
    });
    return { user: svc.publicUser(db.get('SELECT * FROM users WHERE id = ?', [u.id])), temporary_password: password };
  }
  function setStaffActive(actor, userId, active) {
    need(actor);
    const u = staffOf(userId);
    db.run('UPDATE users SET active = ?, token_version = token_version + 1 WHERE id = ?', [active ? 1 : 0, u.id]);
    return svc.publicUser(db.get('SELECT * FROM users WHERE id = ?', [u.id]));
  }
  function listSchoolChildren(actor, schoolId) {
    need(actor);
    const s = getSchool(schoolId);
    return db.all(`SELECT c.id, c.full_name, c.grade, c.active, c.tutor_id, u.full_name AS tutor_name,
        (SELECT uid FROM cards k WHERE k.child_id = c.id AND k.status IN ('activa','bloqueada') ORDER BY k.id DESC LIMIT 1) AS card_uid
      FROM children c LEFT JOIN users u ON u.id = c.tutor_id WHERE c.school_id = ? ORDER BY c.grade, c.full_name`, [s.id]);
  }
  // Códigos de invitación (para padres) de los alumnos indicados o de todos los que no tienen tutor
  function generateInvitations(actor, schoolId, { child_ids, only_unlinked = true } = {}) {
    need(actor);
    const s = getSchool(schoolId);
    const ids = Array.isArray(child_ids) && child_ids.length
      ? child_ids.map(Number)
      : db.all(`SELECT id FROM children WHERE school_id = ? AND active = 1 ${only_unlinked ? 'AND tutor_id IS NULL' : ''} ORDER BY grade, full_name`, [s.id]).map((r) => r.id);
    return db.transaction(() => ids.map((cid) => {
      const c = db.get('SELECT id FROM children WHERE id = ? AND school_id = ?', [cid, s.id]);
      if (!c) throw new AppError('Alumno no encontrado en esta escuela', 'NO_ENCONTRADO');
      return auth.createInvitation(actor, cid, { reuse: true });
    }));
  }

  const M = {
    overview: (u) => overview(u),
    createSchool: (u, a) => createSchool(u, a),
    updateSchool: (u, a) => updateSchool(u, a.id, a),
    schoolDetail: (u, a) => schoolDetail(u, a.id),
    createStaff: (u, a) => createStaff(u, a.school_id, a),
    resetStaffPassword: (u, a) => resetStaffPassword(u, a.user_id),
    setStaffActive: (u, a) => setStaffActive(u, a.user_id, !!a.active),
    revokeDevice: (u, a) => sync.revokeDevice(u, a.device_id, a.school_id),
    setPrimaryDevice: (u, a) => sync.setPrimary(u, a.device_id, a.school_id),
    listChildren: (u, a) => listSchoolChildren(u, a.school_id),
    generateInvitations: (u, a) => generateInvitations(u, a.school_id, a),
  };
  // Acciones del panel que quedan en la bitácora
  const AUDITED = { createSchool: 'escuela_creada', updateSchool: 'escuela_editada', createStaff: 'usuario_creado', resetStaffPassword: 'contrasena_asignada', setStaffActive: 'cuenta_activada', revokeDevice: 'caja_revocada', setPrimaryDevice: 'caja_principal', generateInvitations: 'codigos_generados' };
  const SEC = security ? security.methods : {};
  const BILL = billing ? billing.methods : {}; // mensualidad (registran su propia bitácora)
  function handle(user, method, args, ctx = {}) {
    need(user);
    const a = args && typeof args === 'object' ? args : {};
    if (Object.prototype.hasOwnProperty.call(SEC, method)) return SEC[method](user, a, ctx);
    if (Object.prototype.hasOwnProperty.call(BILL, method)) return BILL[method](user, a, ctx);
    const fn = Object.prototype.hasOwnProperty.call(M, method) ? M[method] : null;
    if (!fn) throw new AppError('Operación desconocida', 'NO_ENCONTRADO');
    const out = fn(user, a);
    if (security && AUDITED[method]) {
      let action = AUDITED[method];
      if (method === 'setStaffActive' && !a.active) action = 'cuenta_desactivada';
      const sid = a.school_id || (method.endsWith('School') ? a.id : null) || (out && out.school && out.school.id) || (out && out.user && out.user.school_id) || null;
      const det = { ...a }; if (Array.isArray(det.child_ids)) det.child_ids = det.child_ids.length;
      security.audit(user, action, { school_id: sid, ip: ctx.ip, target_type: a.user_id ? 'user' : (a.device_id ? 'device' : 'school'), target_id: a.user_id || a.device_id || sid, details: det, severity: ['resetStaffPassword', 'setStaffActive', 'revokeDevice'].includes(method) || (method === 'updateSchool' && ['suspendida', 'pausada'].includes(a.status)) ? 'aviso' : 'info' });
    }
    return out;
  }
  return { handle, overview, createSchool, updateSchool, schoolDetail, createStaff, resetStaffPassword, setStaffActive, listSchoolChildren, generateInvitations, methods: [...Object.keys(M), ...Object.keys(SEC), ...Object.keys(BILL)] };
}

module.exports = { createPlatform, tempPassword };
