'use strict';
// Avisos automáticos por WhatsApp (WAHA) para una escuela o academia.
// - Recordatorio diario de mensualidades por vencer o vencidas (solo academias de natación).
// - Copia de los mismos avisos que ya se mandan al tutor en la app (compra, compra rechazada, saldo bajo).
// La hora es del calendario America/Mexico_City. Un mismo recordatorio no se reenvía el mismo día.
// Entre mensajes hay una pausa (por defecto 30 s) para no disparar el bloqueo de WhatsApp.
const { AppError } = require('./service');
const { dueDate, statusOf, DEFAULT_PRICES } = require('./mensualidades');
const { daysBetween } = require('./billing');
const { toE164Mx, createWahaClient, paceMs, dashboardUrl, sessionName, configured } = require('./waha');

const TZ = 'America/Mexico_City';

function mxParts(d = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(d).map((x) => [x.type, x.value]));
  let hour = Number(p.hour);
  if (hour === 24) hour = 0;
  const date = `${p.year}-${p.month}-${p.day}`;
  const hh = String(hour).padStart(2, '0');
  return { date, hour, minute: Number(p.minute), second: Number(p.second), ts: `${date} ${hh}:${p.minute}:${p.second}` };
}

function firstName(name) {
  const s = String(name || '').trim();
  return s ? s.split(/\s+/)[0] : '';
}
function moneyMx(cents) { return '$' + ((Number(cents) || 0) / 100).toFixed(2) + ' MXN'; }
function dmy(s) {
  const x = String(s || '');
  return x.length >= 10 ? `${x.slice(8, 10)}/${x.slice(5, 7)}/${x.slice(0, 4)}` : x;
}
function maskPhone(p) {
  const d = String(p || '').replace(/\D/g, '');
  const ten = d.length >= 10 ? d.slice(-10) : d;
  if (ten.length < 4) return '';
  return ten.slice(0, 3) + '****' + ten.slice(-2);
}

function monthlyCents(school, dias) {
  let p = {};
  try { p = JSON.parse(school.mens_prices || '{}') || {}; } catch (_) { p = {}; }
  const v = p[dias];
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_PRICES[dias];
}

// Texto distinto por tutor, nadador, monto y fecha (no un aviso idéntico para todos).
function greet(name) {
  const tutor = firstName(name);
  return tutor ? `Hola ${tutor}` : 'Hola';
}
function reminderText({ tutorName, childName, amountCents, nextDue, status, daysLeft, schoolName }) {
  const lugar = schoolName || 'la academia';
  const hijo = childName || 'su hijo(a)';
  const monto = moneyMx(amountCents);
  const fecha = dmy(nextDue);
  let cuando;
  if (status === 'vencida') {
    const n = Math.abs(Number(daysLeft) || 0);
    cuando = n <= 0 ? `venció hoy (${fecha})` : `venció el ${fecha} (hace ${n} día${n === 1 ? '' : 's'})`;
  } else if (Number(daysLeft) <= 0) cuando = `vence hoy (${fecha})`;
  else if (Number(daysLeft) === 1) cuando = `vence mañana (${fecha})`;
  else cuando = `vence el ${fecha} (en ${daysLeft} días)`;
  return `${greet(tutorName)}, le escribimos de ${lugar}. La mensualidad de ${hijo} es de ${monto} y ${cuando}. Puede pasar a pagarla en recepción cuando guste. Gracias.`;
}

function noticeText({ tutorName, childName, kind, title, body, schoolName }) {
  const hi = greet(tutorName);
  const lugar = schoolName || 'la escuela';
  const hijo = childName || 'su hijo(a)';
  const detail = String(body || '').trim();
  if (kind === 'saldo_bajo') return `${hi}, le avisamos de ${lugar}: el saldo de ${hijo} está bajo. ${detail}`.trim();
  if (kind === 'rechazada') return `${hi}, en ${lugar} no se pudo completar una compra de ${hijo}. ${detail}`.trim();
  if (kind === 'compra') return `${hi}, en ${lugar} se registró una compra de ${hijo}. ${detail}`.trim();
  return `${hi}. ${title || ''} ${detail}`.replace(/\s+/g, ' ').trim();
}

const KIND_LABEL = { mensualidad: 'Mensualidad', compra: 'Compra', saldo_bajo: 'Saldo bajo', rechazada: 'Compra rechazada', prueba: 'Prueba' };
const LOG_LABEL = { enviado: 'Enviado', error: 'Error', en_cola: 'En cola', sin_telefono: 'Sin teléfono', omitido: 'Omitido' };

function instructions(session) {
  return [
    'Este aviso usa un número de WhatsApp propio de la academia (no la API de Meta). Se vincula una sola vez con un código QR.',
    'En el celular nuevo, con el chip ya activado, instale WhatsApp y confirme el número.',
    `Abra el panel de WAHA y arranque la sesión "${session}".`,
    'Cuando aparezca el código QR, en el celular entre a WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo, y escanée el QR.',
    'Espere a que el estado quede en Conectado. La sesión queda guardada en WAHA; no hay que escanear cada día.',
    'Active los avisos automáticos y elija la hora (horario de la Ciudad de México). Puede pausarlos cuando quiera.',
    'Los recordatorios de mensualidad salen una vez al día, solo si están por vencer (3 días o menos) o vencidas. El mismo aviso no se repite el mismo día.',
    'Las compras, las compras rechazadas (saldo, límites, tarjeta bloqueada o producto prohibido) y el saldo bajo se copian a WhatsApp en el momento, si el tutor tiene teléfono.',
  ];
}

function createWhatsApp(db, opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || console;
  const now = opts.now || (() => new Date());
  const client = opts.client || createWahaClient({ env, fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  const delay = paceMs(env, opts.delayMs);
  const nowMs = opts.nowMs || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const audit = opts.audit || null;

  let tail = Promise.resolve();
  let lastMs = 0;
  let hasSent = false;
  const pending = new Set();
  const scheduledIds = new Set();
  function schedule(fn) {
    const job = tail.then(async () => {
      const gap = !hasSent || delay <= 0 ? 0 : Math.max(0, delay - (nowMs() - lastMs));
      if (gap > 0) await sleep(gap);
      try { return await fn(); } finally { lastMs = nowMs(); hasSent = true; }
    });
    tail = job.then(() => {}, () => {});
    pending.add(job);
    const done = job.finally(() => pending.delete(job));
    return done;
  }
  const idle = () => Promise.all([...pending]);

  const stamp = () => mxParts(now()).ts;
  function requireAdmin(actor) {
    if (!actor) throw new AppError('Sesión no iniciada', 'NO_AUTENTICADO');
    if (actor.role !== 'admin') throw new AppError('No tienes permiso para esta acción', 'PROHIBIDO');
    const id = Number(actor.school_id);
    if (!id) throw new AppError('Tu usuario no tiene escuela asignada', 'PROHIBIDO');
    return id;
  }
  function schoolRow(id) {
    return db.get('SELECT id, name, account_type, mens_prices FROM schools WHERE id = ?', [id]);
  }
  function settingsRow(id) {
    return db.get('SELECT enabled, send_hour, last_run_on FROM whatsapp_settings WHERE school_id = ?', [id]) || null;
  }
  function publicSettings(id) {
    const s = schoolRow(id) || {};
    const w = settingsRow(id);
    return {
      enabled: !!(w && w.enabled),
      send_hour: w && Number.isInteger(w.send_hour) ? w.send_hour : 9,
      last_run_on: w ? w.last_run_on : null,
      account_type: s.account_type || 'escuela',
      school_name: s.name || null,
      timezone: TZ,
      delay_seconds: Math.round(delay / 1000),
      configured: configured(env),
      session: sessionName(env),
      dashboard_url: dashboardUrl(env),
    };
  }
  function getSettings(actor) { return publicSettings(requireAdmin(actor)); }
  function setSettings(actor, data = {}) {
    const id = requireAdmin(actor);
    const cur = publicSettings(id);
    let enabled = cur.enabled;
    if (data.enabled !== undefined) enabled = data.enabled === true || data.enabled === 1 || data.enabled === '1';
    let hour = cur.send_hour;
    if (data.send_hour !== undefined && data.send_hour !== null && data.send_hour !== '') {
      hour = Number(data.send_hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new AppError('La hora debe ser entre 0 y 23', 'VALIDACION');
    }
    db.run(`INSERT INTO whatsapp_settings (school_id, enabled, send_hour, last_run_on, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(school_id) DO UPDATE SET enabled = excluded.enabled, send_hour = excluded.send_hour, updated_at = excluded.updated_at`,
    [id, enabled ? 1 : 0, hour, cur.last_run_on, stamp()]);
    try { if (audit) audit(actor, 'whatsapp_ajustes', { details: { activo: enabled, hora: hour } }); } catch (e) { log.error('[whatsapp] bitácora', e.message); }
    return publicSettings(id);
  }

  function claim(row) {
    return db.transaction(() => {
      const ex = db.get('SELECT id, status FROM whatsapp_log WHERE school_id = ? AND dedupe_key = ?', [row.schoolId, row.dedupeKey]);
      if (ex) return { duplicate: true, id: ex.id, status: ex.status };
      const r = db.run('INSERT INTO whatsapp_log (school_id, dedupe_key, kind, phone, body, status, created_at) VALUES (?,?,?,?,?,?,?)',
        [row.schoolId, row.dedupeKey, row.kind, row.phone || null, String(row.body || '').slice(0, 1500), row.status || 'en_cola', stamp()]);
      return { id: r.lastId, status: row.status || 'en_cola' };
    });
  }

  function scheduleSend(id) {
    if (scheduledIds.has(id)) return Promise.resolve(null);
    scheduledIds.add(id);
    return schedule(async () => {
      try {
        const row = db.get('SELECT * FROM whatsapp_log WHERE id = ?', [id]);
        if (!row || row.status !== 'en_cola') return row;
        if (!client.configured()) {
          db.run("UPDATE whatsapp_log SET status = 'omitido', error = ? WHERE id = ?", ['no_configurado', id]);
          return db.get('SELECT * FROM whatsapp_log WHERE id = ?', [id]);
        }
        const e164 = toE164Mx(row.phone);
        if (!e164) {
          db.run("UPDATE whatsapp_log SET status = 'sin_telefono', error = ? WHERE id = ?", ['teléfono inválido', id]);
          return db.get('SELECT * FROM whatsapp_log WHERE id = ?', [id]);
        }
        const result = await client.sendText(e164, row.body);
        if (result.skipped) {
          db.run("UPDATE whatsapp_log SET status = 'omitido', error = ? WHERE id = ?", [result.reason || 'omitido', id]);
        } else if (!result.ok) {
          db.run("UPDATE whatsapp_log SET status = 'error', error = ? WHERE id = ?", [String(result.error || 'error').slice(0, 300), id]);
          log.error('[whatsapp] no se envió', row.kind, maskPhone(row.phone), result.error);
        } else {
          db.run('UPDATE whatsapp_log SET status = ?, error = NULL WHERE id = ?', ['enviado', id]);
          log.info('[whatsapp] enviado', row.kind, maskPhone(row.phone));
        }
        return db.get('SELECT * FROM whatsapp_log WHERE id = ?', [id]);
      } finally { scheduledIds.delete(id); }
    });
  }

  function resume() {
    if (!client.configured()) return;
    const rows = db.all("SELECT id FROM whatsapp_log WHERE status = 'en_cola' ORDER BY id");
    for (const r of rows) scheduleSend(r.id);
  }

  function tutorOf(userId) {
    if (!userId) return null;
    return db.get('SELECT id, full_name, phone, whatsapp, active, deleted_at FROM users WHERE id = ?', [userId]) || null;
  }
  function tutorPhone(u) {
    if (!u || u.deleted_at || u.active === 0) return null;
    return toE164Mx(u.whatsapp || u.phone);
  }

  // Copia de un aviso que la app ya creó (push). No hace nada si está pausado, sin WAHA o sin teléfono.
  function mirrorNotice(notice) {
    try {
      if (!notice || !notice.schoolId || !notice.userId) return { skipped: true, reason: 'datos' };
      if (!client.configured()) return { skipped: true, reason: 'not_configured' };
      const st = settingsRow(notice.schoolId);
      if (!st || !st.enabled) return { skipped: true, reason: 'paused' };
      const tutor = tutorOf(notice.userId);
      const e164 = tutorPhone(tutor);
      if (!e164) return { skipped: true, reason: 'sin_telefono' };
      const school = schoolRow(notice.schoolId);
      const body = noticeText({
        tutorName: tutor && tutor.full_name, childName: notice.childName, kind: notice.kind,
        title: notice.title, body: notice.body, schoolName: school && school.name,
      });
      const dedupeKey = String(notice.dedupe || notice.tag || (notice.kind + '-' + notice.txId));
      const c = claim({ schoolId: notice.schoolId, dedupeKey, kind: notice.kind || 'aviso', phone: e164, body, status: 'en_cola' });
      if (c.duplicate) return { skipped: true, reason: 'duplicate', id: c.id };
      scheduleSend(c.id);
      return { queued: true, id: c.id };
    } catch (e) {
      log.error('[whatsapp] aviso', e && e.message);
      return { skipped: true, reason: 'error' };
    }
  }

  function dueRows(school, today) {
    if (!school || school.account_type !== 'natacion') return [];
    const kids = db.all(`SELECT c.id AS child_id, c.full_name AS child_name, p.dias_semana, p.fecha_inicio, p.periodos_pagados,
        u.full_name AS tutor_name, u.phone, u.whatsapp, u.active AS tutor_active, u.deleted_at AS tutor_deleted
      FROM children c
      JOIN swimmer_plans p ON p.child_id = c.id
      LEFT JOIN users u ON u.id = c.tutor_id
      WHERE c.school_id = ? AND c.deleted_at IS NULL AND c.active = 1
        AND p.dias_semana IS NOT NULL AND p.fecha_inicio IS NOT NULL`, [school.id]);
    const out = [];
    for (const k of kids) {
      const nextDue = dueDate(k.fecha_inicio, k.periodos_pagados || 0);
      const status = statusOf(nextDue, today);
      if (status !== 'vencida' && status !== 'por_vencer') continue;
      const daysLeft = daysBetween(today, nextDue);
      const alive = k.tutor_name && !k.tutor_deleted && k.tutor_active !== 0;
      const e164 = alive ? toE164Mx(k.whatsapp || k.phone) : null;
      const body = reminderText({
        tutorName: alive ? k.tutor_name : '', childName: k.child_name,
        amountCents: monthlyCents(school, k.dias_semana), nextDue, status, daysLeft, schoolName: school.name,
      });
      out.push({
        childId: k.child_id, dedupeKey: `mens:${k.child_id}:${nextDue}:${today}`, phone: e164, body,
        status: e164 ? 'en_cola' : 'sin_telefono',
      });
    }
    return out;
  }

  async function runReminders(at = now(), { force = false, schoolId = null } = {}) {
    const parts = mxParts(at);
    if (!client.configured()) return { skipped: true, reason: 'not_configured', date: parts.date, hour: parts.hour, queued: 0 };
    let schools = db.all(`SELECT s.id FROM schools s JOIN whatsapp_settings w ON w.school_id = s.id WHERE w.enabled = 1`);
    if (schoolId) schools = schools.filter((s) => s.id === Number(schoolId));
    let queued = 0; let sinTelefono = 0; let skippedHour = 0;
    const ids = [];
    for (const row of schools) {
      const w = settingsRow(row.id);
      if (!force && w.send_hour !== parts.hour) { skippedHour++; continue; }
      if (w.last_run_on === parts.date) continue;
      const live = await client.sessionStatus();
      if (live.status !== 'WORKING') {
        log.warn('[whatsapp] sesión no lista (' + (live.status_label || live.status) + '); se reintenta en el horario de hoy');
        continue;
      }
      const school = schoolRow(row.id);
      const due = dueRows(school, parts.date);
      for (const item of due) {
        const c = claim({ schoolId: school.id, dedupeKey: item.dedupeKey, kind: 'mensualidad', phone: item.phone, body: item.body, status: item.status });
        if (c.duplicate) continue;
        ids.push(c.id);
        if (item.status === 'en_cola') { scheduleSend(c.id); queued++; }
        else sinTelefono++;
      }
      db.run('UPDATE whatsapp_settings SET last_run_on = ? WHERE school_id = ?', [parts.date, school.id]);
    }
    if (ids.length) await idle();
    return { skipped: false, date: parts.date, hour: parts.hour, queued, sin_telefono: sinTelefono, skipped_hour: skippedHour };
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try { return await runReminders(); } catch (e) { log.error('[whatsapp]', e); return { skipped: true, reason: 'error' }; } finally { ticking = false; }
  }

  function recent(id) {
    return db.all('SELECT id, kind, phone, body, status, error, created_at FROM whatsapp_log WHERE school_id = ? ORDER BY id DESC LIMIT 20', [id]).map((r) => ({
      id: r.id, kind: r.kind, kind_label: KIND_LABEL[r.kind] || r.kind, status: r.status, status_label: LOG_LABEL[r.status] || r.status,
      phone_mask: maskPhone(r.phone), preview: String(r.body || '').slice(0, 180), error: r.error || null, created_at: r.created_at,
    }));
  }
  async function status(actor) {
    const id = requireAdmin(actor);
    const base = publicSettings(id);
    const live = await client.sessionStatus();
    return { ...base, connection: live, instructions: instructions(base.session), recent: recent(id) };
  }
  async function sendTest(actor, data = {}) {
    const id = requireAdmin(actor);
    if (!client.configured()) throw new AppError('WhatsApp no está configurado en el servidor. Defina WAHA_URL, WAHA_API_KEY y WAHA_SESSION.', 'VALIDACION');
    const e164 = toE164Mx(data.phone);
    if (!e164) throw new AppError('Teléfono inválido (10 dígitos de México)', 'VALIDACION');
    const school = schoolRow(id);
    const parts = mxParts(now());
    const body = `Hola, este es un mensaje de prueba de ${school.name || 'Zuki Pay'} para ${e164}. Si lo recibió, la conexión de WhatsApp de la academia ya funciona.`;
    const c = claim({ schoolId: id, dedupeKey: `prueba:${e164}:${parts.date}:${parts.hour}`, kind: 'prueba', phone: e164, body, status: 'en_cola' });
    if (c.duplicate) throw new AppError('Ya se envió una prueba a ese número en esta hora. Intente más tarde.', 'LIMITE');
    await scheduleSend(c.id);
    const row = db.get('SELECT status, error FROM whatsapp_log WHERE id = ?', [c.id]);
    return { status: row.status, status_label: LOG_LABEL[row.status] || row.status, error: row.error || null, phone_mask: maskPhone(e164) };
  }
  async function runNow(actor) {
    const id = requireAdmin(actor);
    const cur = publicSettings(id);
    if (!cur.enabled) throw new AppError('Active los avisos de WhatsApp antes de enviar.', 'VALIDACION');
    return runReminders(now(), { force: true, schoolId: id });
  }

  resume();

  return {
    client, mxParts, reminderText, noticeText, runReminders, tick, idle, mirrorNotice, resume,
    methods: { waGetSettings: getSettings, waSetSettings: setSettings, waStatus: status, waSendTest: sendTest, waRunNow: runNow },
  };
}

module.exports = { createWhatsApp, mxParts, reminderText, noticeText, firstName, moneyMx };
