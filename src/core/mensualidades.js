'use strict';
// Mensualidades de academias de natación (solo cuentas account_type = 'natacion').
// Registro manual de pagos: sin cobro en línea y sin descontar saldo de la tarjeta.
// Ciclo: vence cada mes el mismo día de la fecha de inicio (si el mes es más corto, el último día del mes).
// La fecha de vencimiento se calcula como fecha_inicio + periodos_pagados meses (sin "arrastrar" días cortos).
// Carga diferida de ./billing (evita dependencia circular con service.js)
const B = () => require('./billing');
const addMonths = (...a) => B().addMonths(...a); const daysBetween = (...a) => B().daysBetween(...a);
const isYmd = (s) => B().isYmd(s); const mxDate = (d) => B().mxDate(d);

const DEFAULT_PRICES = { 1: 33000, 2: 47000, 3: 60000, 4: 75000, 5: 84000, 6: 92000 }; // centavos MXN
const DEFAULT_INSCRIPCION_CENTS = 20000;
const POR_VENCER_DIAS = 3;
const STATUS_LABEL = { al_corriente: 'Al corriente', por_vencer: 'Por vencer', vencida: 'Vencida', sin_plan: 'Sin plan' };

function dueDate(fechaInicio, periodos) { return addMonths(fechaInicio, periodos); }
function statusOf(nextDue, today) {
  const d = daysBetween(today, nextDue); // días que faltan
  if (d < 0) return 'vencida';
  if (d <= POR_VENCER_DIAS) return 'por_vencer';
  return 'al_corriente';
}

function createMensualidades({ db, AppError, requireRole, sch, getChildOrFail, ts, now }) {
  const today = () => mxDate(now());
  const err = (m) => new AppError(m, 'VALIDACION');
  function schoolOf(actor) {
    const id = sch(actor);
    const s = id ? db.get('SELECT id, account_type, mens_prices, inscripcion_cents FROM schools WHERE id = ?', [id]) : null;
    if (!s || s.account_type !== 'natacion') throw new AppError('Las mensualidades solo están disponibles para academias de natación', 'PROHIBIDO');
    return s;
  }
  function pricesOf(s) {
    let p = {}; try { p = JSON.parse(s.mens_prices || '{}') || {}; } catch (_) { p = {}; }
    const out = {}; for (let d = 1; d <= 6; d++) out[d] = Number.isInteger(p[d]) && p[d] >= 0 ? p[d] : DEFAULT_PRICES[d];
    return out;
  }
  const inscOf = (s) => (s.inscripcion_cents === null || s.inscripcion_cents === undefined ? DEFAULT_INSCRIPCION_CENTS : s.inscripcion_cents);

  function getSettings(actor) {
    requireRole(actor, 'admin');
    const s = schoolOf(actor);
    return { prices_cents: pricesOf(s), inscripcion_cents: inscOf(s), defaults: { prices_cents: DEFAULT_PRICES, inscripcion_cents: DEFAULT_INSCRIPCION_CENTS } };
  }
  function setSettings(actor, data = {}) {
    requireRole(actor, 'admin');
    const s = schoolOf(actor);
    const cur = pricesOf(s);
    if (data.prices_cents) for (let d = 1; d <= 6; d++) {
      const v = data.prices_cents[d] ?? data.prices_cents[String(d)];
      if (v === undefined) continue;
      if (!Number.isInteger(v) || v < 0 || v > 10000000) throw err(`Precio inválido para ${d} día(s) por semana`);
      cur[d] = v;
    }
    let insc = s.inscripcion_cents;
    if (data.inscripcion_cents !== undefined) {
      if (data.inscripcion_cents === null || data.inscripcion_cents === '') insc = null;
      else if (!Number.isInteger(data.inscripcion_cents) || data.inscripcion_cents < 0 || data.inscripcion_cents > 10000000) throw err('Costo de inscripción inválido');
      else insc = data.inscripcion_cents;
    }
    db.run('UPDATE schools SET mens_prices = ?, inscripcion_cents = ? WHERE id = ?', [JSON.stringify(cur), insc, s.id]);
    return getSettings(actor);
  }

  function planOut(child, plan, s, t) {
    const tutor = child.tutor_id ? db.get('SELECT full_name, phone, whatsapp FROM users WHERE id = ?', [child.tutor_id]) : null;
    const base = { child_id: child.id, child_name: child.full_name, nivel: child.grade || null,
      tutor_name: tutor ? tutor.full_name : null, tutor_whatsapp: tutor ? (tutor.whatsapp || tutor.phone || null) : null,
      inscripcion_cents: inscOf(s), inscripcion_pagada: !!(plan && plan.inscripcion_pagada), inscripcion_fecha: plan ? plan.inscripcion_fecha : null };
    if (!plan || !plan.dias_semana || !plan.fecha_inicio) return { ...base, has_plan: false, status: 'sin_plan', status_label: STATUS_LABEL.sin_plan };
    const next_due = dueDate(plan.fecha_inicio, plan.periodos_pagados);
    const status = statusOf(next_due, t);
    return { ...base, has_plan: true, dias_semana: plan.dias_semana, fecha_inicio: plan.fecha_inicio, periodos_pagados: plan.periodos_pagados,
      monthly_cents: pricesOf(s)[plan.dias_semana], next_due, days_left: daysBetween(t, next_due), status, status_label: STATUS_LABEL[status] };
  }
  const planRow = (childId) => db.get('SELECT * FROM swimmer_plans WHERE child_id = ?', [childId]);

  function getPlan(actor, childId) {
    requireRole(actor, 'admin');
    const s = schoolOf(actor); const c = getChildOrFail(childId, actor);
    const out = planOut(c, planRow(c.id), s, today());
    out.payments = db.all('SELECT * FROM swimmer_payments WHERE child_id = ? AND deleted_at IS NULL ORDER BY paid_at DESC, id DESC', [c.id]);
    return out;
  }
  function setPlan(actor, data = {}) {
    requireRole(actor, 'admin');
    const s = schoolOf(actor); const c = getChildOrFail(data.child_id, actor);
    const prev = planRow(c.id) || {};
    let dias = prev.dias_semana || null; let inicio = prev.fecha_inicio || null;
    if (data.dias_semana !== undefined) {
      if (data.dias_semana === null || data.dias_semana === '') dias = null;
      else { dias = Number(data.dias_semana); if (!Number.isInteger(dias) || dias < 1 || dias > 6) throw err('Días por semana: de 1 a 6'); }
    }
    if (data.fecha_inicio !== undefined) {
      if (data.fecha_inicio === null || data.fecha_inicio === '') inicio = null;
      else { inicio = String(data.fecha_inicio); if (!isYmd(inicio)) throw err('Fecha de inicio inválida'); }
    }
    if ((dias === null) !== (inicio === null)) throw err('Indique días por semana y fecha de inicio');
    // Si cambia la fecha de inicio se reinicia el conteo de periodos pagados
    const periodos = inicio && inicio === prev.fecha_inicio ? (prev.periodos_pagados || 0) : 0;
    let ip = prev.inscripcion_pagada ? 1 : 0; let ifecha = prev.inscripcion_fecha || null;
    if (data.inscripcion_pagada !== undefined) {
      ip = data.inscripcion_pagada ? 1 : 0;
      if (ip) { ifecha = data.inscripcion_fecha ? String(data.inscripcion_fecha) : (ifecha || today()); if (!isYmd(ifecha)) throw err('Fecha de inscripción inválida'); } else ifecha = null;
    }
    db.run(`INSERT INTO swimmer_plans (child_id, school_id, dias_semana, fecha_inicio, periodos_pagados, inscripcion_pagada, inscripcion_fecha, updated_at) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(child_id) DO UPDATE SET dias_semana=excluded.dias_semana, fecha_inicio=excluded.fecha_inicio, periodos_pagados=excluded.periodos_pagados,
      inscripcion_pagada=excluded.inscripcion_pagada, inscripcion_fecha=excluded.inscripcion_fecha, updated_at=excluded.updated_at`,
    [c.id, s.id, dias, inicio, periodos, ip, ifecha, ts()]);
    // "Primer mes pagado" (alta del nadador): registra el pago de la primera mensualidad con fecha de inicio,
    // como un pago normal (historial y reportes). Solo si todavía no hay ningún periodo pagado.
    if (data.primer_mes_pagado === true || data.primer_mes_pagado === 1) {
      if (!dias || !inicio) throw err('Para marcar el primer mes pagado indique días por semana y fecha de inicio');
      if (!(planRow(c.id).periodos_pagados > 0)) return registerPayment(actor, { child_id: c.id, paid_at: inicio, note: 'Primer mes (alta)' });
    }
    return getPlan(actor, c.id);
  }
  function registerPayment(actor, data = {}) {
    requireRole(actor, 'admin');
    const s = schoolOf(actor); const c = getChildOrFail(data.child_id, actor);
    const plan = planRow(c.id);
    if (!plan || !plan.dias_semana || !plan.fecha_inicio) throw err('Primero configure días por semana y fecha de inicio');
    const amount = data.amount_cents === undefined || data.amount_cents === null || data.amount_cents === '' ? pricesOf(s)[plan.dias_semana] : data.amount_cents;
    if (!Number.isInteger(amount) || amount < 0 || amount > 10000000) throw err('Monto inválido');
    const paid_at = data.paid_at ? String(data.paid_at) : today();
    if (!isYmd(paid_at)) throw err('Fecha de pago inválida');
    const note = data.note ? String(data.note).trim().slice(0, 300) || null : null;
    const period_due = dueDate(plan.fecha_inicio, plan.periodos_pagados);
    db.transaction(() => {
      db.run('INSERT INTO swimmer_payments (school_id, child_id, amount_cents, paid_at, period_due, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [s.id, c.id, amount, paid_at, period_due, note, actor.full_name || actor.username || null, ts()]);
      db.run('UPDATE swimmer_plans SET periodos_pagados = periodos_pagados + 1, updated_at = ? WHERE child_id = ?', [ts(), c.id]);
    });
    return getPlan(actor, c.id);
  }
  // Lista de nadadores con su estado (para filtros y, más adelante, recordatorios por WhatsApp)
  function list(actor, f = {}) {
    requireRole(actor, 'admin');
    const s = schoolOf(actor); const t = today();
    const kids = db.all('SELECT * FROM children WHERE school_id = ? AND deleted_at IS NULL AND active = 1 ORDER BY full_name', [s.id]);
    let rows = kids.map((c) => planOut(c, planRow(c.id), s, t));
    if (f.status) { const want = String(f.status).split(','); rows = rows.filter((r) => want.includes(r.status)); }
    return rows.sort((a, b) => (a.next_due || '9999').localeCompare(b.next_due || '9999'));
  }
  function paymentOrFail(actor, s, id) {
    const n = Number(id);
    const p = Number.isInteger(n) && n > 0 ? db.get('SELECT * FROM swimmer_payments WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [n, s.id]) : null;
    if (!p) throw new AppError('Pago no encontrado', 'NO_ENCONTRADO');
    return p;
  }
  const who = (actor) => actor.full_name || actor.username || null;
  // Corrige un pago registrado por error (monto, fecha, nota). No cambia el vencimiento.
  function updatePayment(actor, data = {}) {
    requireRole(actor, 'admin');
    const s = schoolOf(actor); const p = paymentOrFail(actor, s, data.id);
    const amount = data.amount_cents === undefined ? p.amount_cents : data.amount_cents;
    if (!Number.isInteger(amount) || amount < 0 || amount > 10000000) throw err('Monto inválido');
    const paid_at = data.paid_at === undefined ? p.paid_at : String(data.paid_at);
    if (!isYmd(paid_at)) throw err('Fecha de pago inválida');
    const note = data.note === undefined ? p.note : (data.note ? String(data.note).trim().slice(0, 300) || null : null);
    db.run('UPDATE swimmer_payments SET amount_cents=?, paid_at=?, note=?, updated_at=?, updated_by=? WHERE id=?', [amount, paid_at, note, ts(), who(actor), p.id]);
    return getPlan(actor, p.child_id);
  }
  // Borra (lógicamente) un pago: el vencimiento regresa un mes. Queda registro de quién y cuándo.
  function deletePayment(actor, data = {}) {
    requireRole(actor, 'admin');
    const s = schoolOf(actor); const p = paymentOrFail(actor, s, data.id);
    db.transaction(() => {
      db.run('UPDATE swimmer_payments SET deleted_at=?, deleted_by=? WHERE id=?', [ts(), who(actor), p.id]);
      db.run('UPDATE swimmer_plans SET periodos_pagados = MAX(periodos_pagados - 1, 0), updated_at = ? WHERE child_id = ?', [ts(), p.child_id]);
    });
    return getPlan(actor, p.child_id);
  }
  return { getSettings, setSettings, getPlan, setPlan, registerPayment, updatePayment, deletePayment, list };
}
module.exports = { createMensualidades, dueDate, statusOf, DEFAULT_PRICES, DEFAULT_INSCRIPCION_CENTS, POR_VENCER_DIAS };
