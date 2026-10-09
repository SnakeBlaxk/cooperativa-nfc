'use strict';
// Seguridad y emergencias del servidor: congelar recargas/ventas, modo solo lectura, ALERTA ROJA,
// bitácora de auditoría, alertas de anomalías, papelera y reversión de recargas sospechosas.
// Independiente de Express (se prueba con node:test). Lo usa el panel del superadministrador.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { AppError, fmtLocal, str } = require('./service');

// Métodos de la API que solo leen (todo lo demás se considera escritura)
const READ_METHODS = new Set(['listUsers', 'listChildren', 'listCategories', 'listProducts', 'listCards', 'lookupCard', 'getLimits', 'getProhibitions', 'listMovements', 'childSummary', 'dashboard', 'securityStatus', 'me', 'login', 'logout']);
const DEFAULTS = { large_recharge_cents: 100000, hours_start: '07:00', hours_end: '16:00' };
const LOCKDOWN_PHRASE = 'ALERTA ROJA';

function pad(n) { return String(n).padStart(2, '0'); }
const normName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function genPassword(len = 12) {
  const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(len);
  let s = ''; for (let i = 0; i < len; i++) s += A[b[i] % A.length];
  return s;
}

// Decide si una operación está permitida con las banderas de seguridad vigentes.
// Se usa en el servidor y también en la caja de escritorio (con las banderas descargadas al sincronizar).
// Devuelve null si se permite o un mensaje de error.
function evaluateFlags(flags, method, args = {}, { todayRechargesCents = 0 } = {}) {
  if (!flags || READ_METHODS.has(method)) return null;
  if (flags.lockdown) return 'El sistema está en ALERTA ROJA: todo está en modo solo lectura hasta que el administrador de la plataforma lo desbloquee.';
  if (flags.read_only) return 'Esta escuela está en modo SOLO LECTURA por seguridad. Comuníquese con el administrador de la plataforma.';
  if (method === 'recharge' && flags.freeze_recharges) return 'Las RECARGAS están congeladas por seguridad. Comuníquese con el administrador de la plataforma.';
  if (method === 'purchase' && flags.freeze_sales) return 'Las VENTAS están congeladas por seguridad. Comuníquese con el administrador de la plataforma.';
  if (method === 'recharge' && flags.daily_recharge_limit_cents) {
    const amt = Number(args.amount_cents) || 0;
    if (todayRechargesCents + amt > flags.daily_recharge_limit_cents) {
      const left = Math.max(0, flags.daily_recharge_limit_cents - todayRechargesCents);
      return `Se alcanzó el límite diario de recargas de la escuela ($${(flags.daily_recharge_limit_cents / 100).toFixed(2)}). Disponible hoy: $${(left / 100).toFixed(2)}.`;
    }
  }
  return null;
}

function createSecurity(db, opts = {}) {
  const now = opts.now || (() => new Date());
  const ts = () => fmtLocal(now());
  const svc = opts.svc; const sync = opts.sync || null; const auth = opts.auth || null;
  const persistence = opts.persistence || (() => ({ mode: 'desconocido' }));
  const meta = (k) => { const r = db.get('SELECT value FROM meta WHERE key = ?', [k]); return r ? r.value : null; };
  const setMeta = (k, v) => (v === null ? db.run('DELETE FROM meta WHERE key = ?', [k]) : db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [k, String(v)]));
  const need = (actor) => { if (!actor || actor.role !== 'superadmin') throw new AppError('Solo el superadministrador puede hacer esto', 'PROHIBIDO'); };
  const minutesAgo = (m) => fmtLocal(new Date(now().getTime() - m * 60000));
  const dayStart = () => { const d = now(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`; };

  // ---------- bitácora ----------
  function audit(actor, action, o = {}) {
    const a = actor || {};
    let details = o.details;
    if (details && typeof details === 'object') {
      details = { ...details };
      for (const k of ['password', 'current', 'next', 'photo', 'refresh_token', 'token']) if (k in details) details[k] = k === 'photo' ? '[foto]' : '***';
      details = JSON.stringify(details).slice(0, 2000);
    }
    db.run('INSERT INTO audit_log (created_at, actor_id, actor_name, actor_role, school_id, ip, action, target_type, target_id, details, severity) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [ts(), a.id || null, a.full_name || a.username || a.name || null, a.role || null, o.school_id !== undefined ? o.school_id : (a.school_id || null), o.ip ? String(o.ip).slice(0, 64) : null,
        action, o.target_type || null, o.target_id === undefined || o.target_id === null ? null : String(o.target_id), details || null, o.severity || 'info']);
  }
  function listAudit(actor, f = {}) {
    need(actor);
    const w = []; const p = [];
    if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) { w.push('a.created_at >= ?'); p.push(f.from + ' 00:00:00'); }
    if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) { w.push('a.created_at <= ?'); p.push(f.to + ' 23:59:59'); }
    if (f.action) { w.push('a.action = ?'); p.push(String(f.action)); }
    if (f.category && CATEGORIES[f.category]) { w.push(`a.action IN (${CATEGORIES[f.category].map(() => '?').join(',')})`); p.push(...CATEGORIES[f.category]); }
    if (f.school_id) { w.push('a.school_id = ?'); p.push(Number(f.school_id)); }
    if (f.severity) { w.push('a.severity = ?'); p.push(String(f.severity)); }
    if (f.q) { w.push('(a.actor_name LIKE ? OR a.details LIKE ? OR a.ip LIKE ? OR a.target_id = ?)'); const q = '%' + String(f.q).slice(0, 60) + '%'; p.push(q, q, q, String(f.q)); }
    const limit = Math.min(Math.max(Number(f.limit) || 300, 1), 3000);
    return db.all(`SELECT a.*, s.name AS school_name FROM audit_log a LEFT JOIN schools s ON s.id = a.school_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ${limit}`, p)
      .map((r) => ({ ...r, details: r.details ? safeJson(r.details) : null }));
  }
  const safeJson = (s) => { try { return JSON.parse(s); } catch (_) { return s; } };
  const CATEGORIES = {
    recargas: ['recarga', 'recarga_caja', 'ajuste', 'recarga_revertida', 'recarga_marcada'],
    borrados: ['producto_borrado', 'producto_restaurado'],
    contrasenas: ['contrasena_asignada', 'contrasena_propia', 'superadmin_recuperado'],
    roles: ['rol_cambiado', 'cuenta_activada', 'cuenta_desactivada', 'usuario_creado', 'usuario_editado', 'cuenta_desbloqueada'],
    accesos: ['login', 'login_fallido', 'cuenta_bloqueada_intentos', 'login_rechazado_bloqueo'],
    emergencia: ['alerta_roja', 'alerta_roja_fin', 'congelar_recargas', 'congelar_ventas', 'solo_lectura', 'cerrar_sesiones', 'bloquear_admin', 'limites_escuela', 'respaldo_descargado'],
  };

  // ---------- alertas ----------
  function alert(a) {
    // Evita duplicados: misma clase y referencia, o misma clase/escuela en los últimos 10 min si no hay referencia
    const dup = a.ref_id
      ? db.get('SELECT id FROM alerts WHERE kind = ? AND ref_type IS ? AND ref_id = ?', [a.kind, a.ref_type || null, a.ref_id])
      : db.get('SELECT id FROM alerts WHERE kind = ? AND school_id IS ? AND created_at >= ? AND ack_at IS NULL AND details IS ?', [a.kind, a.school_id || null, minutesAgo(10), a.dedupe || null]);
    if (dup) return null;
    return db.run('INSERT INTO alerts (created_at, school_id, kind, severity, message, details, ref_type, ref_id) VALUES (?,?,?,?,?,?,?,?)',
      [ts(), a.school_id || null, a.kind, a.severity || 'media', a.message, a.dedupe || (a.details ? JSON.stringify(a.details) : null), a.ref_type || null, a.ref_id || null]).lastId;
  }
  function listAlerts(actor, f = {}) {
    need(actor);
    const w = []; const p = [];
    if (f.status !== 'todas') w.push('a.ack_at IS NULL');
    if (f.school_id) { w.push('a.school_id = ?'); p.push(Number(f.school_id)); }
    return db.all(`SELECT a.*, s.name AS school_name FROM alerts a LEFT JOIN schools s ON s.id = a.school_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY a.id DESC LIMIT 500`, p);
  }
  function ackAlert(actor, id) {
    need(actor);
    const r = db.run('UPDATE alerts SET ack_at = ?, ack_by = ? WHERE (? = 0 OR id = ?) AND ack_at IS NULL', [ts(), actor.username || actor.full_name, Number(id) || 0, Number(id) || 0]);
    return { acknowledged: r.changes };
  }
  const openAlerts = () => db.get('SELECT COUNT(*) AS n FROM alerts WHERE ack_at IS NULL').n;

  // ---------- banderas ----------
  const isLockdown = () => meta('sec_lockdown') === '1';
  function schoolRow(sid) {
    const r = sid ? db.get('SELECT * FROM school_security WHERE school_id = ?', [sid]) : null;
    return r || { school_id: sid, freeze_recharges: 0, freeze_sales: 0, read_only: 0, daily_recharge_limit_cents: null, large_recharge_cents: null, hours_start: null, hours_end: null };
  }
  function flagsFor(sid) {
    const r = schoolRow(sid);
    const gFreeze = meta('sec_freeze_recharges') === '1';
    return {
      lockdown: isLockdown(), freeze_recharges_global: gFreeze,
      freeze_recharges: gFreeze || !!r.freeze_recharges, freeze_sales: !!r.freeze_sales, read_only: !!r.read_only,
      daily_recharge_limit_cents: r.daily_recharge_limit_cents || null,
      large_recharge_cents: r.large_recharge_cents || DEFAULTS.large_recharge_cents,
      hours_start: r.hours_start || DEFAULTS.hours_start, hours_end: r.hours_end || DEFAULTS.hours_end,
    };
  }
  const todayRecharges = (sid) => db.get("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE school_id = ? AND type = 'recarga' AND status = 'aprobado' AND created_at >= ?", [sid, dayStart()]).s;

  // Escuela afectada por una llamada (para tutores se deduce del alumno / tarjeta)
  function schoolForCall(user, method, args = {}) {
    if (user.role === 'admin' || user.role === 'cajero') return user.school_id;
    if (user.role !== 'tutor') return null;
    const cid = Number(args.child_id || (method === 'updateChild' ? args.id : 0)) || 0;
    if (cid) { const c = db.get('SELECT school_id FROM children WHERE id = ?', [cid]); return c ? c.school_id : null; }
    if (args.card_id) { const k = db.get('SELECT school_id FROM cards WHERE id = ?', [Number(args.card_id) || 0]); return k ? k.school_id : null; }
    return null;
  }
  // Lanza error si la operación está bloqueada por seguridad
  function guard(user, method, args = {}, ctx = {}) {
    if (!user || user.role === 'superadmin' || READ_METHODS.has(method)) return;
    const sid = schoolForCall(user, method, args);
    const flags = sid ? flagsFor(sid) : { lockdown: isLockdown() };
    const msg = evaluateFlags(flags, method, args, { todayRechargesCents: method === 'recharge' && sid ? todayRecharges(sid) : 0 });
    if (msg) {
      if (method === 'recharge' && flags.daily_recharge_limit_cents && /límite diario/.test(msg)) {
        alert({ school_id: sid, kind: 'limite_diario', severity: 'alta', message: `Recarga rechazada por límite diario de la escuela (intentó ${user.full_name || user.username}).`, dedupe: 'limite:' + dayStart() });
      }
      audit(user, 'operacion_bloqueada', { school_id: sid, ip: ctx.ip, details: { method, motivo: msg }, severity: 'aviso' });
      throw new AppError(msg, 'BLOQUEADO_SEGURIDAD');
    }
  }
  function statusFor(user) {
    const sid = user && (user.role === 'admin' || user.role === 'cajero') ? user.school_id : null;
    const f = sid ? flagsFor(sid) : { lockdown: isLockdown() };
    return { lockdown: !!f.lockdown, freeze_recharges: !!f.freeze_recharges, freeze_sales: !!f.freeze_sales, read_only: !!f.read_only, daily_recharge_limit_cents: f.daily_recharge_limit_cents || null };
  }

  // ---------- detección de anomalías en recargas ----------
  function inspectRecharge(txId) {
    const t = db.get(`SELECT t.*, c.full_name AS child_name, c.tutor_id, u.full_name AS op_name, u.email AS op_email, u.phone AS op_phone
      FROM transactions t LEFT JOIN children c ON c.id = t.child_id LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?`, [txId]);
    if (!t || t.type !== 'recarga' || t.status !== 'aprobado') return [];
    const f = flagsFor(t.school_id);
    const found = [];
    const money = (c) => '$' + (c / 100).toFixed(2);
    const who = t.op_name || t.processed_by_name || 'desconocido';
    const add = (kind, severity, message) => { const id = alert({ school_id: t.school_id, kind, severity, message, ref_type: 'transaction', ref_id: t.id }); if (id) found.push(kind); };
    if (t.amount_cents >= f.large_recharge_cents) add('recarga_grande', 'alta', `Recarga grande: ${money(t.amount_cents)} a ${t.child_name || t.card_uid} (atendió ${who}).`);
    const base = new Date(String(t.created_at).replace(' ', 'T'));
    const tenBefore = fmtLocal(new Date(base.getTime() - 10 * 60000));
    const sameCard = db.get("SELECT COUNT(*) AS n FROM transactions WHERE type = 'recarga' AND status = 'aprobado' AND card_uid = ? AND created_at >= ? AND created_at <= ?", [t.card_uid, tenBefore, t.created_at]).n;
    if (sameCard >= 3) add('recargas_repetidas', 'alta', `${sameCard} recargas a la misma tarjeta (${t.child_name || t.card_uid}) en 10 minutos.`);
    const sameOp = t.user_id
      ? db.get("SELECT COUNT(*) AS n FROM transactions WHERE type = 'recarga' AND status = 'aprobado' AND user_id = ? AND created_at >= ? AND created_at <= ?", [t.user_id, tenBefore, t.created_at]).n
      : db.get("SELECT COUNT(*) AS n FROM transactions WHERE type = 'recarga' AND status = 'aprobado' AND school_id IS ? AND processed_by_name IS ? AND created_at >= ? AND created_at <= ?", [t.school_id, t.processed_by_name, tenBefore, t.created_at]).n;
    if (sameOp >= 10) add('muchas_recargas', 'media', `${who} hizo ${sameOp} recargas en 10 minutos.`);
    const hm = String(t.created_at).slice(11, 16); const dow = base.getDay();
    if (dow === 0 || dow === 6 || hm < f.hours_start || hm > f.hours_end) add('fuera_de_horario', 'media', `Recarga fuera del horario escolar (${dow === 0 || dow === 6 ? 'fin de semana' : hm}): ${money(t.amount_cents)} a ${t.child_name || t.card_uid}, atendió ${who}.`);
    // ¿El que recarga es el propio tutor del alumno? (mismo usuario, correo, teléfono o nombre)
    if (t.tutor_id) {
      const tu = db.get('SELECT id, full_name, email, phone FROM users WHERE id = ?', [t.tutor_id]);
      const same = tu && ((t.user_id && t.user_id === tu.id) || (t.op_email && tu.email && t.op_email.toLowerCase() === tu.email.toLowerCase())
        || (t.op_phone && tu.phone && t.op_phone === tu.phone) || (normName(who) && normName(who) === normName(tu.full_name)));
      if (same) add('auto_recarga', 'alta', `Posible AUTO-RECARGA: ${who} recargó ${money(t.amount_cents)} a ${t.child_name}, cuyo tutor es la misma persona (${tu.full_name}).`);
    }
    if (f.daily_recharge_limit_cents) {
      const day = String(t.created_at).slice(0, 10) + ' 00:00:00';
      const s = db.get("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE school_id = ? AND type = 'recarga' AND status = 'aprobado' AND created_at >= ? AND created_at <= ?", [t.school_id, day, t.created_at]).s;
      if (s > f.daily_recharge_limit_cents) add('limite_diario', 'alta', `Se superó el límite diario de recargas de la escuela (${money(s)} de ${money(f.daily_recharge_limit_cents)}).`);
    }
    return found;
  }

  // ---------- intentos de acceso ----------
  function onLoginFailure(identifier, ip, user) {
    audit(user ? { id: user.id, full_name: user.full_name, role: user.role, school_id: user.school_id } : { name: String(identifier || '').slice(0, 80) }, 'login_fallido', { ip, details: { usuario: String(identifier || '').slice(0, 80) }, severity: 'aviso' });
    const n = db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login_fallido' AND created_at >= ? AND (ip IS ? OR details = ?)", [minutesAgo(10), ip ? String(ip).slice(0, 64) : null, JSON.stringify({ usuario: String(identifier || '').slice(0, 80) })]).n;
    if (n >= 5) alert({ kind: 'intentos_fallidos', severity: user && user.role === 'superadmin' ? 'alta' : 'media', message: `${n} intentos fallidos de inicio de sesión en 10 min (usuario "${String(identifier || '').slice(0, 40)}", IP ${ip || '?'}).`, school_id: user ? user.school_id : null, dedupe: 'login:' + (ip || '') + ':' + String(identifier || '').toLowerCase() });
  }

  // ---------- sesiones ----------
  function logoutUsers(where, params = []) {
    const ids = db.all(`SELECT id FROM users WHERE ${where}`, params).map((r) => r.id);
    db.transaction(() => {
      for (const id of ids) {
        db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [id]);
        db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', [id]);
      }
    });
    return ids.length;
  }
  const getSchool = (id) => { const s = db.get('SELECT * FROM schools WHERE id = ?', [Number(id) || 0]); if (!s) throw new AppError('Escuela no encontrada', 'NO_ENCONTRADO'); return s; };

  // ---------- acciones del superadministrador ----------
  function overview(actor) {
    need(actor);
    const schools = db.all('SELECT id, name, status FROM schools ORDER BY name').map((s) => ({
      ...s, flags: flagsFor(s.id), today_recharges_cents: todayRecharges(s.id), synced: sync ? sync.isSynced(s.id) : false,
      admins: db.all("SELECT id, username, full_name, active FROM users WHERE school_id = ? AND role = 'admin' ORDER BY full_name", [s.id]),
    }));
    return {
      lockdown: isLockdown(), lockdown_at: meta('sec_lockdown_at'), lockdown_by: meta('sec_lockdown_by'),
      freeze_recharges_global: meta('sec_freeze_recharges') === '1', open_alerts: openAlerts(), schools,
      persistence: persistence(), defaults: DEFAULTS,
    };
  }
  function setGlobalFreeze(actor, on, ctx = {}) {
    need(actor);
    setMeta('sec_freeze_recharges', on ? '1' : null);
    audit(actor, 'congelar_recargas', { school_id: null, ip: ctx.ip, details: { alcance: 'todas las escuelas', activo: !!on }, severity: on ? 'alta' : 'info' });
    return overview(actor);
  }
  function setSchoolSecurity(actor, a = {}, ctx = {}) {
    need(actor);
    const s = getSchool(a.school_id);
    const prev = schoolRow(s.id);
    const bool = (k) => (a[k] === undefined ? prev[k] : (a[k] ? 1 : 0));
    const cents = (k) => { if (a[k] === undefined) return prev[k]; if (a[k] === null || a[k] === '' || Number(a[k]) === 0) return null; const n = Number(a[k]); if (!Number.isInteger(n) || n < 100 || n > 100000000) throw new AppError('Monto inválido', 'VALIDACION'); return n; };
    const hour = (k) => { if (a[k] === undefined) return prev[k]; if (!a[k]) return null; if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(a[k])) throw new AppError('Hora inválida (use HH:MM)', 'VALIDACION'); return a[k]; };
    const n = { freeze_recharges: bool('freeze_recharges'), freeze_sales: bool('freeze_sales'), read_only: bool('read_only'), daily_recharge_limit_cents: cents('daily_recharge_limit_cents'), large_recharge_cents: cents('large_recharge_cents'), hours_start: hour('hours_start'), hours_end: hour('hours_end') };
    db.run(`INSERT INTO school_security (school_id, freeze_recharges, freeze_sales, read_only, daily_recharge_limit_cents, large_recharge_cents, hours_start, hours_end, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(school_id) DO UPDATE SET freeze_recharges=excluded.freeze_recharges, freeze_sales=excluded.freeze_sales, read_only=excluded.read_only, daily_recharge_limit_cents=excluded.daily_recharge_limit_cents,
      large_recharge_cents=excluded.large_recharge_cents, hours_start=excluded.hours_start, hours_end=excluded.hours_end, updated_at=excluded.updated_at`,
    [s.id, n.freeze_recharges, n.freeze_sales, n.read_only, n.daily_recharge_limit_cents, n.large_recharge_cents, n.hours_start, n.hours_end, ts()]);
    const changed = Object.keys(n).filter((k) => (n[k] || null) !== (prev[k] || null));
    for (const k of changed) {
      const action = { freeze_recharges: 'congelar_recargas', freeze_sales: 'congelar_ventas', read_only: 'solo_lectura' }[k] || 'limites_escuela';
      audit(actor, action, { school_id: s.id, ip: ctx.ip, target_type: 'school', target_id: s.id, details: { escuela: s.name, campo: k, antes: prev[k], ahora: n[k] }, severity: ['freeze_recharges', 'freeze_sales', 'read_only'].includes(k) && n[k] ? 'alta' : 'info' });
    }
    return { school_id: s.id, flags: flagsFor(s.id) };
  }
  function blockSchoolAdmins(actor, schoolId, ctx = {}) {
    need(actor);
    const s = getSchool(schoolId);
    const admins = db.all("SELECT id, username FROM users WHERE school_id = ? AND role = 'admin' AND active = 1", [s.id]);
    db.run("UPDATE users SET active = 0 WHERE school_id = ? AND role = 'admin'", [s.id]);
    const n = logoutUsers("school_id = ? AND role IN ('admin','cajero')", [s.id]);
    audit(actor, 'bloquear_admin', { school_id: s.id, ip: ctx.ip, target_type: 'school', target_id: s.id, details: { escuela: s.name, administradores: admins.map((x) => x.username), sesiones_cerradas: n }, severity: 'alta' });
    return { blocked: admins.length, sessions_closed: n };
  }
  function logoutSchool(actor, schoolId, ctx = {}) {
    need(actor);
    const s = getSchool(schoolId);
    const n = logoutUsers("school_id = ? AND role IN ('admin','cajero')", [s.id]);
    audit(actor, 'cerrar_sesiones', { school_id: s.id, ip: ctx.ip, target_type: 'school', target_id: s.id, details: { escuela: s.name, cuentas: n }, severity: 'aviso' });
    return { sessions_closed: n };
  }
  function logoutEveryone(actor, ctx = {}) {
    need(actor);
    const n = logoutUsers('id <> ?', [actor.id]);
    audit(actor, 'cerrar_sesiones', { school_id: null, ip: ctx.ip, details: { alcance: 'todas las cuentas', cuentas: n }, severity: 'alta' });
    return { sessions_closed: n };
  }
  function lockdown(actor, confirm, ctx = {}) {
    need(actor);
    if (String(confirm || '').trim().toUpperCase() !== LOCKDOWN_PHRASE) throw new AppError(`Para confirmar escriba exactamente: ${LOCKDOWN_PHRASE}`, 'VALIDACION');
    setMeta('sec_lockdown', '1'); setMeta('sec_lockdown_at', ts()); setMeta('sec_lockdown_by', actor.username || actor.full_name);
    const n = logoutUsers("role <> 'superadmin'");
    audit(actor, 'alerta_roja', { school_id: null, ip: ctx.ip, details: { sesiones_cerradas: n }, severity: 'critica' });
    alert({ kind: 'alerta_roja', severity: 'critica', message: `ALERTA ROJA activada por ${actor.full_name || actor.username}: sistema en solo lectura y accesos bloqueados.` });
    return { lockdown: true, sessions_closed: n };
  }
  function unlock(actor, ctx = {}) {
    need(actor);
    setMeta('sec_lockdown', null); setMeta('sec_lockdown_at', null); setMeta('sec_lockdown_by', null);
    audit(actor, 'alerta_roja_fin', { school_id: null, ip: ctx.ip, severity: 'alta' });
    return { lockdown: false };
  }

  // ---------- recargas: revisión, marca y reversión ----------
  function listRecharges(actor, f = {}) {
    need(actor);
    const w = ["t.type = 'recarga'"]; const p = [];
    if (f.school_id) { w.push('t.school_id = ?'); p.push(Number(f.school_id)); }
    if (f.only_flagged) w.push('(t.flag IS NOT NULL OR EXISTS (SELECT 1 FROM alerts a WHERE a.ref_type = \'transaction\' AND a.ref_id = t.id))');
    if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) { w.push('t.created_at >= ?'); p.push(f.from + ' 00:00:00'); }
    if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) { w.push('t.created_at <= ?'); p.push(f.to + ' 23:59:59'); }
    return db.all(`SELECT t.id, t.created_at, t.amount_cents, t.status, t.card_uid, t.flag, t.flag_note, t.school_id, s.name AS school_name, c.full_name AS child_name,
        COALESCE(u.full_name, t.processed_by_name) AS operator, (SELECT group_concat(a.kind, ',') FROM alerts a WHERE a.ref_type = 'transaction' AND a.ref_id = t.id) AS alert_kinds
      FROM transactions t LEFT JOIN schools s ON s.id = t.school_id LEFT JOIN children c ON c.id = t.child_id LEFT JOIN users u ON u.id = t.user_id
      WHERE ${w.join(' AND ')} ORDER BY t.id DESC LIMIT ${Math.min(Number(f.limit) || 200, 2000)}`, p);
  }
  function flagRecharge(actor, txId, note, ctx = {}) {
    need(actor);
    const t = db.get("SELECT * FROM transactions WHERE id = ? AND type = 'recarga'", [Number(txId) || 0]);
    if (!t) throw new AppError('Recarga no encontrada', 'NO_ENCONTRADO');
    const n = str(note, 'nota', { optional: true, max: 200 });
    db.run("UPDATE transactions SET flag = 'sospechosa', flag_note = ? WHERE id = ?", [n, t.id]);
    audit(actor, 'recarga_marcada', { school_id: t.school_id, ip: ctx.ip, target_type: 'transaction', target_id: t.id, details: { monto: t.amount_cents, tarjeta: t.card_uid, nota: n }, severity: 'aviso' });
    return { flagged: true };
  }
  function reverseRecharge(actor, txId, reason, ctx = {}) {
    need(actor);
    const t = db.get("SELECT * FROM transactions WHERE id = ? AND type = 'recarga' AND status = 'aprobado'", [Number(txId) || 0]);
    if (!t) throw new AppError('Recarga no encontrada', 'NO_ENCONTRADO');
    if (t.flag === 'revertida') throw new AppError('Esta recarga ya fue revertida', 'VALIDACION');
    const why = str(reason, 'motivo', { max: 200 });
    const k = db.get('SELECT * FROM cards WHERE id = ?', [t.card_id]);
    if (!k) throw new AppError('La tarjeta de la recarga ya no existe', 'NO_ENCONTRADO');
    // Escuela con caja de escritorio: la caja manda en los saldos. Se bloquea la tarjeta (se envía a la caja) y se marca.
    if (sync && sync.isSynced(t.school_id)) {
      db.transaction(() => {
        db.run("UPDATE cards SET status = 'bloqueada', blocked_by = 'admin' WHERE id = ? AND status = 'activa'", [k.id]);
        db.run("UPDATE transactions SET flag = 'sospechosa', flag_note = ? WHERE id = ?", ['Pendiente de revertir en la caja: ' + why, t.id]);
      });
      sync.recordCard(k.id);
      audit(actor, 'recarga_revertida', { school_id: t.school_id, ip: ctx.ip, target_type: 'transaction', target_id: t.id, details: { monto: t.amount_cents, tarjeta: t.card_uid, motivo: why, modo: 'tarjeta bloqueada; ajuste pendiente en la caja' }, severity: 'alta' });
      return { reversed: false, card_blocked: true, message: 'Esta escuela usa la caja de escritorio: se BLOQUEÓ la tarjeta y la recarga quedó marcada. Haga el ajuste negativo en la caja (Tarjetas → Ajuste).' };
    }
    if (k.balance_cents < t.amount_cents) throw new AppError(`La tarjeta ya gastó parte del dinero (saldo actual $${(k.balance_cents / 100).toFixed(2)}). Bloquee la tarjeta y haga un ajuste manual.`, 'VALIDACION');
    const r = db.transaction(() => {
      const nb = k.balance_cents - t.amount_cents;
      db.run('UPDATE cards SET balance_cents = ? WHERE id = ?', [nb, k.id]);
      const x = db.run(`INSERT INTO transactions (school_id, type, status, amount_cents, balance_after_cents, card_id, card_uid, child_id, user_id, note, created_at)
        VALUES (?, 'ajuste', 'aprobado', ?, ?, ?, ?, ?, ?, ?, ?)`, [t.school_id, -t.amount_cents, nb, k.id, k.uid, t.child_id, actor.id, `Reversión de recarga #${t.id}: ${why}`, ts()]);
      db.run("UPDATE transactions SET flag = 'revertida', flag_note = ? WHERE id = ?", [why, t.id]);
      return { reversal_id: x.lastId, balance_cents: nb };
    });
    audit(actor, 'recarga_revertida', { school_id: t.school_id, ip: ctx.ip, target_type: 'transaction', target_id: t.id, details: { monto: t.amount_cents, tarjeta: t.card_uid, motivo: why }, severity: 'alta' });
    return { reversed: true, ...r };
  }

  // ---------- papelera ----------
  function listTrash(actor) {
    need(actor);
    return db.all('SELECT p.id, p.name, p.price_cents, p.deleted_at, s.name AS school_name FROM products p LEFT JOIN schools s ON s.id = p.school_id WHERE p.deleted_at IS NOT NULL ORDER BY p.deleted_at DESC LIMIT 500')
      .map((r) => ({ ...r, type: 'producto' }));
  }
  function restoreProduct(actor, id, ctx = {}) {
    need(actor);
    const p = db.get('SELECT * FROM products WHERE id = ? AND deleted_at IS NOT NULL', [Number(id) || 0]);
    if (!p) throw new AppError('No está en la papelera', 'NO_ENCONTRADO');
    db.run('UPDATE products SET deleted_at = NULL, active = 1 WHERE id = ?', [p.id]);
    audit(actor, 'producto_restaurado', { school_id: p.school_id, ip: ctx.ip, target_type: 'product', target_id: p.id, details: { producto: p.name } });
    return { restored: true };
  }

  // ---------- cuentas ----------
  function listAccounts(actor, f = {}) {
    need(actor);
    const w = []; const p = [];
    if (f.role) { w.push('u.role = ?'); p.push(String(f.role)); }
    if (f.school_id) { w.push('(u.school_id = ? OR EXISTS (SELECT 1 FROM children c WHERE c.tutor_id = u.id AND c.school_id = ?))'); p.push(Number(f.school_id), Number(f.school_id)); }
    if (f.status === 'activas') w.push('u.active = 1'); else if (f.status === 'bloqueadas') w.push('(u.active = 0 OR COALESCE(u.locked_until, 0) > ' + Date.now() + ')');
    if (f.q) { w.push('(u.username LIKE ? OR u.full_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?)'); const q = '%' + String(f.q).slice(0, 60) + '%'; p.push(q, q, q, q); }
    const ORDER = "CASE u.role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 WHEN 'cajero' THEN 2 ELSE 3 END";
    return db.all(`SELECT u.id, u.username, u.role, u.full_name, u.email, u.phone, u.active, u.school_id, u.created_at, u.last_login_at, u.last_login_ip, u.locked_until, u.failed_logins, u.password_set_at, u.password_set_by,
        CASE WHEN u.role = 'tutor' THEN COALESCE((SELECT group_concat(DISTINCT s2.name) FROM children c JOIN schools s2 ON s2.id = c.school_id WHERE c.tutor_id = u.id), s.name) ELSE s.name END AS school_name
      FROM users u LEFT JOIN schools s ON s.id = u.school_id ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ${ORDER}, school_name, u.full_name LIMIT 2000`, p)
      .map((u) => ({ ...u, active: !!u.active, locked: !!(u.locked_until && u.locked_until > Date.now()) }));
  }
  const userOr404 = (id) => { const u = db.get('SELECT * FROM users WHERE id = ?', [Number(id) || 0]); if (!u) throw new AppError('Cuenta no encontrada', 'NO_ENCONTRADO'); return u; };
  function setPassword(actor, userId, password, ctx = {}) {
    need(actor);
    const u = userOr404(userId);
    if (u.role === 'superadmin' && u.id !== actor.id) throw new AppError('No se puede cambiar la contraseña de otro superadministrador', 'PROHIBIDO');
    const p = password ? str(password, 'contraseña', { min: 8, max: 100 }) : genPassword(12);
    db.transaction(() => {
      db.run('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1, failed_logins = 0, locked_until = NULL, password_set_at = ?, password_set_by = ? WHERE id = ?',
        [bcrypt.hashSync(p, 10), ts(), actor.username || 'superadmin', u.id]);
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [u.id]);
    });
    audit(actor, 'contrasena_asignada', { school_id: u.school_id, ip: ctx.ip, target_type: 'user', target_id: u.id, details: { cuenta: u.username, rol: u.role, generada: !password }, severity: 'aviso' });
    return { user: svc.publicUser(userOr404(u.id)), password: p };
  }
  function setActive(actor, userId, active, ctx = {}) {
    need(actor);
    const u = userOr404(userId);
    if (u.role === 'superadmin') throw new AppError('El superadministrador no se puede desactivar', 'PROHIBIDO');
    db.run('UPDATE users SET active = ?, token_version = token_version + 1 WHERE id = ?', [active ? 1 : 0, u.id]);
    if (!active) db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [u.id]);
    audit(actor, active ? 'cuenta_activada' : 'cuenta_desactivada', { school_id: u.school_id, ip: ctx.ip, target_type: 'user', target_id: u.id, details: { cuenta: u.username, rol: u.role }, severity: active ? 'info' : 'aviso' });
    return svc.publicUser(userOr404(u.id));
  }
  function setRole(actor, userId, role, ctx = {}) {
    need(actor);
    const u = userOr404(userId);
    if (u.role === 'superadmin') throw new AppError('El superadministrador no se puede degradar', 'PROHIBIDO');
    if (!['admin', 'cajero'].includes(u.role) || !['admin', 'cajero'].includes(role)) throw new AppError('Solo se puede cambiar entre Administrador y Cajero', 'VALIDACION');
    if (u.role === role) return svc.publicUser(u);
    db.run('UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?', [role, u.id]);
    audit(actor, 'rol_cambiado', { school_id: u.school_id, ip: ctx.ip, target_type: 'user', target_id: u.id, details: { cuenta: u.username, antes: u.role, ahora: role }, severity: 'aviso' });
    return svc.publicUser(userOr404(u.id));
  }
  function unlockAccount(actor, userId, ctx = {}) {
    need(actor);
    const u = userOr404(userId);
    db.run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [u.id]);
    audit(actor, 'cuenta_desbloqueada', { school_id: u.school_id, ip: ctx.ip, target_type: 'user', target_id: u.id, details: { cuenta: u.username } });
    return { unlocked: true };
  }
  function backup(actor, ctx = {}) {
    need(actor);
    audit(actor, 'respaldo_descargado', { school_id: null, ip: ctx.ip, severity: 'aviso' });
    return db.exportBuffer();
  }

  // Recuperación de emergencia del superadministrador (variable SUPERADMIN_RESET_PASSWORD al arrancar).
  // Se aplica una sola vez por valor (se guarda su huella) para no pisar cambios posteriores.
  function emergencyReset({ username, password }) {
    if (!password) return null;
    if (password.length < 10) throw new Error('SUPERADMIN_RESET_PASSWORD debe tener al menos 10 caracteres');
    const fp = crypto.createHash('sha256').update('reset:' + (username || '') + ':' + password).digest('hex');
    if (meta('superadmin_reset_fp') === fp) return { applied: false };
    let u = username ? db.get("SELECT * FROM users WHERE username = ? AND role = 'superadmin'", [username]) : null;
    if (!u) u = db.get("SELECT * FROM users WHERE role = 'superadmin' ORDER BY id LIMIT 1");
    const hash = bcrypt.hashSync(password, 10);
    if (!u) {
      const id = db.run("INSERT INTO users (username, password_hash, role, full_name, created_at) VALUES (?,?,'superadmin','Zuki Company',?)", [username || 'zuki', hash, ts()]).lastId;
      u = db.get('SELECT * FROM users WHERE id = ?', [id]);
    } else {
      db.run('UPDATE users SET password_hash = ?, active = 1, must_change_password = 0, failed_logins = 0, locked_until = NULL, token_version = token_version + 1, password_set_at = ?, password_set_by = ? WHERE id = ?', [hash, ts(), 'recuperación (variable de entorno)', u.id]);
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [u.id]);
    }
    setMeta('superadmin_reset_fp', fp);
    audit({ id: u.id, full_name: 'Sistema (arranque)', role: 'sistema' }, 'superadmin_recuperado', { school_id: null, details: { cuenta: u.username }, severity: 'critica' });
    alert({ kind: 'superadmin_recuperado', severity: 'alta', message: `Se restableció la contraseña del superadministrador "${u.username}" con la variable SUPERADMIN_RESET_PASSWORD. Quítela de Render cuando ya haya entrado.` });
    return { applied: true, username: u.username };
  }

  const M = {
    securityOverview: (u) => overview(u),
    setGlobalFreeze: (u, a, c) => setGlobalFreeze(u, !!a.on, c),
    setSchoolSecurity: (u, a, c) => setSchoolSecurity(u, a, c),
    blockSchoolAdmins: (u, a, c) => blockSchoolAdmins(u, a.school_id, c),
    logoutSchool: (u, a, c) => logoutSchool(u, a.school_id, c),
    logoutEveryone: (u, a, c) => logoutEveryone(u, c),
    lockdown: (u, a, c) => lockdown(u, a.confirm, c),
    unlock: (u, a, c) => unlock(u, c),
    listRecharges: (u, a) => listRecharges(u, a),
    flagRecharge: (u, a, c) => flagRecharge(u, a.tx_id, a.note, c),
    reverseRecharge: (u, a, c) => reverseRecharge(u, a.tx_id, a.reason, c),
    listAudit: (u, a) => listAudit(u, a),
    listAlerts: (u, a) => listAlerts(u, a),
    ackAlert: (u, a) => ackAlert(u, a.id),
    listTrash: (u) => listTrash(u),
    restoreProduct: (u, a, c) => restoreProduct(u, a.id, c),
    listAccounts: (u, a) => listAccounts(u, a),
    setPassword: (u, a, c) => setPassword(u, a.user_id, a.password, c),
    setAccountActive: (u, a, c) => setActive(u, a.user_id, !!a.active, c),
    setAccountRole: (u, a, c) => setRole(u, a.user_id, a.role, c),
    unlockAccount: (u, a, c) => unlockAccount(u, a.user_id, c),
  };
  return {
    methods: M, audit, alert, guard, statusFor, flagsFor, isLockdown, inspectRecharge, onLoginFailure, logoutUsers, emergencyReset, backup,
    overview, setSchoolSecurity, setGlobalFreeze, blockSchoolAdmins, logoutSchool, logoutEveryone, lockdown, unlock, listRecharges, flagRecharge, reverseRecharge,
    listAudit, listAlerts, ackAlert, listTrash, restoreProduct, listAccounts, setPassword, setActive, setRole, unlockAccount, openAlerts,
  };
}

module.exports = { createSecurity, evaluateFlags, READ_METHODS, LOCKDOWN_PHRASE, genPassword };
