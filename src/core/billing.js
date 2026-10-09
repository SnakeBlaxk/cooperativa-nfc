'use strict';
// Mensualidad por escuela (solo servidor): estado Prueba / Activa / Pausada, periodo pagado (inicio–fin),
// avisos antes del vencimiento, días de tolerancia y pausa automática por falta de pago.
// Todas las fechas de periodo son días calendario (AAAA-MM-DD) de la Ciudad de México.
//   * fin = último día cubierto (inclusive).
//   * Aviso: desde 3 días antes del fin (incluido el día del fin).
//   * Tolerancia: los 2 días siguientes al fin.
//   * Al terminar la tolerancia la escuela se pausa sola: nadie de esa escuela (admin, cajero, tutores)
//     puede entrar; los datos se conservan. Solo el superadministrador la reactiva o registra el pago.
const { AppError, fmtLocal } = require('./service');

const TZ = 'America/Mexico_City';
const WARN_DAYS = 3;
const GRACE_DAYS = 2;
const TRIAL_DAYS = 30;
const STATUSES = ['prueba', 'activa', 'pausada'];
const STATUS_LABEL = { prueba: 'Prueba', activa: 'Activa', pausada: 'Pausada' };
const PAUSED_MSG = 'Servicio pausado. Contacte a la administración.';
const isPausedStatus = (s) => s === 'pausada' || s === 'suspendida'; // "suspendida" = valor de versiones anteriores

// ---------- fechas (calendario de la Ciudad de México) ----------
const dtf = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function mxDate(d = new Date()) {
  const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
const utcOf = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(utcOf(s)) === s; }
function addDays(s, n) { return ymd(utcOf(s) + n * 86400000); }
// Suma meses conservando el día (si el mes destino es más corto, se usa su último día: 31 ene → 28/29 feb)
function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return ymd(Date.UTC(y, m - 1 + n, Math.min(d, last)));
}
function daysBetween(a, b) { return Math.round((utcOf(b) - utcOf(a)) / 86400000); }
const dmy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');

// Calcula la etapa de cobro de una escuela para el día `today`.
function billingInfo(s, today) {
  const status = isPausedStatus(s.status) ? 'pausada' : s.status;
  const out = {
    status, status_label: STATUS_LABEL[status] || status, period_start: s.period_start || null, period_end: s.period_end || null,
    paused_at: s.paused_at || null, pause_reason: s.pause_reason || null, today, stage: 'ok', days_left: null, grace_days_left: null,
    grace_end: s.period_end ? addDays(s.period_end, GRACE_DAYS) : null, pause_on: s.period_end ? addDays(s.period_end, GRACE_DAYS + 1) : null,
  };
  if (s.period_end) out.days_left = daysBetween(today, s.period_end);
  if (status === 'pausada') { out.stage = 'pausada'; return out; }
  if (!s.period_end) return out;
  const left = out.days_left;
  if (left > WARN_DAYS) out.stage = 'ok';
  else if (left >= 0) out.stage = 'aviso';
  else if (left >= -GRACE_DAYS) { out.stage = 'tolerancia'; out.grace_days_left = GRACE_DAYS + left + 1; }
  else out.stage = 'vencida';
  return out;
}

function createBilling(db, { security = null, now = () => new Date() } = {}) {
  const today = () => mxDate(now());
  const ts = () => fmtLocal(now());
  const SYSTEM = { name: 'Sistema (mensualidad)' };
  const audit = (actor, action, o) => { if (security) try { security.audit(actor || SYSTEM, action, o); } catch (e) { console.error('[mensualidad] bitácora:', e.message); } };
  const alert = (a) => { if (security) try { security.alert(a); } catch (e) { console.error('[mensualidad] alerta:', e.message); } };
  const need = (actor) => { if (!actor || actor.role !== 'superadmin') throw new AppError('Solo el superadministrador puede hacer esto', 'PROHIBIDO'); };
  const row = (id) => db.get('SELECT * FROM schools WHERE id = ?', [Number(id) || 0]);
  const getSchool = (id) => { const s = row(id); if (!s) throw new AppError('Escuela no encontrada', 'NO_ENCONTRADO'); return s; };
  const date = (v, label, { optional = false } = {}) => {
    if (v === undefined || v === null || v === '') { if (optional) return null; throw new AppError(`Indica la ${label}`, 'VALIDACION'); }
    if (!isYmd(String(v))) throw new AppError(`La ${label} no es válida (AAAA-MM-DD)`, 'VALIDACION');
    return String(v);
  };

  // Periodo por omisión para escuelas sin fechas (escuelas nuevas o creadas por versiones anteriores)
  function defaultPeriod(status, from = today()) {
    return { period_start: from, period_end: status === 'activa' ? addMonths(from, 1) : addDays(from, TRIAL_DAYS) };
  }
  function ensurePeriod(s) {
    if (isPausedStatus(s.status) || s.period_end) return s;
    const p = defaultPeriod(s.status);
    db.run('UPDATE schools SET period_start = ?, period_end = ? WHERE id = ?', [p.period_start, p.period_end, s.id]);
    return row(s.id);
  }

  // Cierra las sesiones de todas las cuentas de la escuela (los tutores con hijos en otra escuela activa siguen entrando)
  function closeSessions(sid) {
    const staff = db.all("SELECT id FROM users WHERE school_id = ? AND role IN ('admin','cajero')", [sid]).map((r) => r.id);
    const tutors = db.all("SELECT id, school_id FROM users WHERE role = 'tutor' AND (school_id = ? OR id IN (SELECT tutor_id FROM children WHERE school_id = ? AND tutor_id IS NOT NULL))", [sid, sid])
      .filter((u) => tutorBlocked(u)).map((r) => r.id);
    const ids = [...staff, ...tutors];
    for (const id of ids) {
      db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [id]);
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', [id]);
    }
    return ids.length;
  }
  // Un tutor queda bloqueado si TODAS las escuelas de sus hijos (y la suya) están pausadas
  function tutorBlocked(u) {
    const rows = db.all('SELECT status FROM schools WHERE id IN (SELECT school_id FROM children WHERE tutor_id = ?) OR id = ?', [u.id, u.school_id || -1]);
    return rows.length > 0 && rows.every((r) => isPausedStatus(r.status));
  }

  function pause(sid, { reason = 'manual', actor = null, ip = null } = {}) {
    const s = getSchool(sid);
    if (isPausedStatus(s.status)) return { closed: 0 };
    const closed = db.transaction(() => {
      db.run("UPDATE schools SET status = 'pausada', paused_at = ?, pause_reason = ?, billing_notice = ? WHERE id = ?", [ts(), reason, 'pausada:' + (s.period_end || ''), s.id]);
      return closeSessions(s.id);
    });
    const auto = reason === 'falta_pago';
    audit(actor, auto ? 'escuela_pausada_auto' : 'escuela_pausada', { school_id: s.id, ip, target_type: 'school', target_id: s.id, severity: 'aviso',
      details: { escuela: s.name, motivo: auto ? 'falta de pago' : 'manual', vencio: s.period_end ? dmy(s.period_end) : null, sesiones_cerradas: closed } });
    alert({ school_id: s.id, kind: 'mensualidad_pausada', severity: 'alta', dedupe: `pausada:${s.id}:${ts()}`,
      message: auto ? `"${s.name}" se pausó automáticamente por falta de pago (su periodo venció el ${dmy(s.period_end)} y terminó la tolerancia). Sus cuentas ya no pueden entrar; los datos se conservan.`
        : `"${s.name}" fue pausada por ${actor ? (actor.full_name || actor.username) : 'el sistema'}. Sus cuentas ya no pueden entrar.` });
    return { closed };
  }

  // Revisa la escuela: asigna periodo si falta, genera avisos para el superadministrador y pausa al terminar la tolerancia.
  function evaluate(sid) {
    let s = row(sid);
    if (!s) return null;
    s = ensurePeriod(s);
    let info = billingInfo(s, today());
    if (info.stage === 'vencida') {
      pause(s.id, { reason: 'falta_pago' });
      info = billingInfo(row(s.id), today());
    } else if ((info.stage === 'aviso' || info.stage === 'tolerancia') && s.billing_notice !== `${info.stage}:${s.period_end}`) {
      db.run('UPDATE schools SET billing_notice = ? WHERE id = ?', [`${info.stage}:${s.period_end}`, s.id]);
      if (info.stage === 'aviso') {
        alert({ school_id: s.id, kind: 'mensualidad_por_vencer', severity: 'media', dedupe: `aviso:${s.id}:${s.period_end}`,
          message: `La mensualidad de "${s.name}" vence ${info.days_left === 0 ? 'hoy' : `en ${info.days_left} día(s)`} (${dmy(s.period_end)}).` });
        audit(null, 'mensualidad_por_vencer', { school_id: s.id, target_type: 'school', target_id: s.id, details: { escuela: s.name, vence: dmy(s.period_end), dias: info.days_left } });
      } else {
        alert({ school_id: s.id, kind: 'mensualidad_tolerancia', severity: 'alta', dedupe: `tolerancia:${s.id}:${s.period_end}`,
          message: `La mensualidad de "${s.name}" venció el ${dmy(s.period_end)}. Está en periodo de tolerancia: si no se registra el pago, se pausará automáticamente el ${dmy(info.pause_on)}.` });
        audit(null, 'mensualidad_tolerancia', { school_id: s.id, target_type: 'school', target_id: s.id, severity: 'aviso', details: { escuela: s.name, vencio: dmy(s.period_end), se_pausa: dmy(info.pause_on) } });
      }
    }
    return info;
  }
  // Escuelas que afectan a una cuenta (personal: la suya; tutor: las de sus hijos y la suya)
  function schoolsOfUser(u) {
    if (!u || u.role === 'superadmin') return [];
    if (u.role === 'tutor') return db.all('SELECT id FROM schools WHERE id IN (SELECT school_id FROM children WHERE tutor_id = ?) OR id = ?', [u.id, u.school_id || -1]).map((r) => r.id);
    return u.school_id ? [u.school_id] : [];
  }
  function evaluateForUser(u) {
    try { for (const sid of schoolsOfUser(u)) evaluate(sid); } catch (e) { console.error('[mensualidad] revisión:', e.message); }
  }
  // Revisión periódica de todas las escuelas (avisos y pausas aunque nadie entre)
  function sweep() {
    const out = [];
    for (const r of db.all('SELECT id FROM schools ORDER BY id')) { try { out.push({ id: r.id, ...evaluate(r.id) }); } catch (e) { console.error('[mensualidad] escuela', r.id, e.message); } }
    return out;
  }
  // Aviso para el panel de la escuela (solo administrador y cajero; los tutores no ven cobros)
  function noticeFor(user) {
    if (!user || !['admin', 'cajero'].includes(user.role) || !user.school_id) return null;
    const i = evaluate(user.school_id);
    if (!i) return null;
    return { stage: i.stage, status: i.status, days_left: i.days_left, grace_days_left: i.grace_days_left, period_end: i.period_end, pause_on: i.pause_on };
  }
  const info = (s) => billingInfo(s, today());

  // ---------- acciones del superadministrador ----------
  function listPayments(actor, sid) {
    need(actor);
    const s = getSchool(sid);
    return db.all('SELECT * FROM school_payments WHERE school_id = ? ORDER BY id DESC LIMIT 200', [s.id]);
  }
  // Registrar pago / renovar: extiende el fin un mes. Si la escuela estaba pausada o el periodo ya terminó
  // (más allá de la tolerancia), el nuevo mes empieza hoy. Una escuela en prueba o pausada pasa a Activa.
  function registerPayment(actor, data = {}, ctx = {}) {
    need(actor);
    const s = getSchool(data.school_id);
    const t = today();
    const paid_at = date(data.paid_at, 'fecha de pago', { optional: true }) || t;
    let amount = null;
    if (data.amount_cents !== undefined && data.amount_cents !== null && data.amount_cents !== '') {
      amount = Number(data.amount_cents);
      if (!Number.isInteger(amount) || amount <= 0 || amount > 100000000) throw new AppError('Monto inválido', 'VALIDACION');
    }
    const note = data.note ? String(data.note).trim().slice(0, 300) || null : null;
    const fresh = isPausedStatus(s.status) || !s.period_end || daysBetween(t, s.period_end) < -GRACE_DAYS;
    const start = fresh ? t : addDays(s.period_end, 1);
    const end = addMonths(fresh ? t : s.period_end, 1);
    const wasPaused = isPausedStatus(s.status);
    db.transaction(() => {
      db.run("UPDATE schools SET status = 'activa', period_start = ?, period_end = ?, paused_at = NULL, pause_reason = NULL, billing_notice = NULL WHERE id = ?", [start, end, s.id]);
      db.run('INSERT INTO school_payments (school_id, paid_at, amount_cents, note, period_start, period_end, prev_end, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
        [s.id, paid_at, amount, note, start, end, s.period_end || null, ts(), actor.full_name || actor.username || 'superadmin']);
    });
    audit(actor, 'mensualidad_pago', { school_id: s.id, ip: ctx.ip, target_type: 'school', target_id: s.id,
      details: { escuela: s.name, fecha_pago: dmy(paid_at), monto: amount, nota: note, nuevo_fin: dmy(end), antes: s.period_end ? dmy(s.period_end) : null, reactivada: wasPaused } });
    return { school: info(row(s.id)), period_start: start, period_end: end, reactivated: wasPaused };
  }
  function pauseNow(actor, data = {}, ctx = {}) {
    need(actor);
    const s = getSchool(data.school_id);
    if (isPausedStatus(s.status)) throw new AppError('La escuela ya está pausada', 'VALIDACION');
    const r = pause(s.id, { reason: 'manual', actor, ip: ctx.ip });
    return { school: info(row(s.id)), sessions_closed: r.closed };
  }
  // Reactivar: devuelve el acceso. Si el periodo ya terminó, se da un nuevo fin (por omisión, 7 días desde hoy)
  function reactivate(actor, data = {}, ctx = {}) {
    need(actor);
    const s = getSchool(data.school_id);
    const t = today();
    // Sin indicar estado: Activa si alguna vez pagó; si no, Prueba
    const status = data.status || (db.get('SELECT 1 AS x FROM school_payments WHERE school_id = ? LIMIT 1', [s.id]) ? 'activa' : 'prueba');
    if (!['prueba', 'activa'].includes(status)) throw new AppError('Estado inválido (prueba o activa)', 'VALIDACION');
    let end = date(data.period_end, 'fecha fin', { optional: true });
    if (!end) end = s.period_end && s.period_end >= t ? s.period_end : addDays(t, 7);
    if (end < t) throw new AppError('La fecha fin debe ser hoy o posterior', 'VALIDACION');
    const start = s.period_start && s.period_start <= end ? s.period_start : t;
    db.run('UPDATE schools SET status = ?, period_start = ?, period_end = ?, paused_at = NULL, pause_reason = NULL, billing_notice = NULL WHERE id = ?', [status, start, end, s.id]);
    audit(actor, 'escuela_reactivada', { school_id: s.id, ip: ctx.ip, target_type: 'school', target_id: s.id, severity: 'aviso',
      details: { escuela: s.name, estado: STATUS_LABEL[status], fin: dmy(end), estaba: STATUS_LABEL[isPausedStatus(s.status) ? 'pausada' : s.status] } });
    return { school: info(row(s.id)) };
  }
  // Cambiar estado y fechas a mano (p. ej. extender una prueba)
  function setPeriod(actor, data = {}, ctx = {}) {
    need(actor);
    const s = getSchool(data.school_id);
    let status = data.status === 'suspendida' ? 'pausada' : (data.status || (isPausedStatus(s.status) ? 'pausada' : s.status));
    if (!STATUSES.includes(status)) throw new AppError('Estado inválido (prueba, activa o pausada)', 'VALIDACION');
    if (status === 'pausada') {
      if (!isPausedStatus(s.status)) return pauseNow(actor, { school_id: s.id }, ctx);
      return { school: info(s) };
    }
    const start = date(data.period_start !== undefined ? data.period_start : s.period_start, 'fecha de inicio');
    const end = date(data.period_end !== undefined ? data.period_end : s.period_end, 'fecha fin');
    if (end < start) throw new AppError('La fecha fin no puede ser antes de la fecha de inicio', 'VALIDACION');
    db.run('UPDATE schools SET status = ?, period_start = ?, period_end = ?, paused_at = NULL, pause_reason = NULL, billing_notice = NULL WHERE id = ?', [status, start, end, s.id]);
    audit(actor, isPausedStatus(s.status) ? 'escuela_reactivada' : 'mensualidad_periodo', { school_id: s.id, ip: ctx.ip, target_type: 'school', target_id: s.id, severity: isPausedStatus(s.status) ? 'aviso' : 'info',
      details: { escuela: s.name, estado: STATUS_LABEL[status], inicio: dmy(start), fin: dmy(end), antes: `${STATUS_LABEL[isPausedStatus(s.status) ? 'pausada' : s.status]} ${dmy(s.period_start)}–${dmy(s.period_end)}` } });
    const out = evaluate(s.id); // por si las fechas ya están vencidas
    return { school: out };
  }

  const methods = {
    listPayments: (u, a) => listPayments(u, a.school_id),
    registerPayment: (u, a, c) => registerPayment(u, a, c),
    pauseSchool: (u, a, c) => pauseNow(u, a, c),
    reactivateSchool: (u, a, c) => reactivate(u, a, c),
    setBillingPeriod: (u, a, c) => setPeriod(u, a, c),
  };
  return { methods, evaluate, evaluateForUser, sweep, noticeFor, info, defaultPeriod, pause, reactivate, registerPayment, setPeriod, listPayments, tutorBlocked, today };
}

module.exports = { createBilling, billingInfo, mxDate, addDays, addMonths, daysBetween, isYmd, isPausedStatus, PAUSED_MSG, STATUSES, STATUS_LABEL, WARN_DAYS, GRACE_DAYS, TRIAL_DAYS, TZ };
