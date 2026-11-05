'use strict';
// Cliente de WAHA (WhatsApp HTTP API, motor tipo Baileys / WhatsApp Web).
// No usa la API de WhatsApp Business de Meta. Si WAHA_URL o WAHA_API_KEY no están definidos,
// todas las operaciones son un no-op (no lanzan error y no llaman a la red).
// Números de México en E.164: +52 y 10 dígitos. El chatId por defecto es 52XXXXXXXXXX@c.us.
// WAHA_MX_PREFIX=521 usa el prefijo antiguo de móviles que algunas sesiones Baileys todavía piden.

const DEFAULT_DELAY_MS = 30000;
const MIN_DELAY_MS = 20000;
const MAX_DELAY_MS = 60000;

function digits(p) { return String(p || '').replace(/\D/g, ''); }

// Acepta 10 dígitos, +52 y 10, o 521 y 10. Devuelve '+52' + 10 dígitos, o null.
function toE164Mx(phone) {
  const d = digits(phone);
  let ten = null;
  if (d.length === 10) ten = d;
  else if (d.length === 12 && d.startsWith('52')) ten = d.slice(2);
  else if (d.length === 13 && d.startsWith('521')) ten = d.slice(3);
  if (!ten || !/^[1-9]\d{9}$/.test(ten)) return null;
  return '+52' + ten;
}

function mxPrefix(env) {
  const p = String((env && env.WAHA_MX_PREFIX) || '52').trim();
  return p === '521' ? '521' : '52';
}

function chatIdFor(e164, env) {
  const ten = digits(e164).slice(-10);
  return mxPrefix(env) + ten + '@c.us';
}

function baseUrl(env) {
  const u = String((env && env.WAHA_URL) || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) return '';
  return u;
}

function sessionName(env) {
  const s = String((env && env.WAHA_SESSION) || 'default').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : 'default';
}

function dashboardUrl(env) {
  const explicit = String((env && env.WAHA_DASHBOARD_URL) || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  const b = baseUrl(env);
  return b ? b + '/dashboard' : null;
}

function configured(env) {
  return !!(baseUrl(env) && String((env && env.WAHA_API_KEY) || '').trim());
}

// Pausa entre mensajes. Por defecto 30 s, acotada a 20–60 s. Un override explícito (pruebas) puede ser 0.
function paceMs(env, override) {
  if (override !== undefined && override !== null && override !== '') {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const n = Number(env && env.WAHA_SEND_DELAY_MS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DELAY_MS;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Math.round(n)));
}

const STATUS_LABEL = {
  not_configured: 'No configurado en el servidor',
  WORKING: 'Conectado',
  SCAN_QR_CODE: 'Falta escanear el código QR',
  STARTING: 'Conectando…',
  STOPPED: 'Sesión detenida',
  FAILED: 'Error de sesión',
  unreachable: 'No se pudo contactar a WAHA',
  missing: 'La sesión no existe en WAHA',
};

function createWahaClient({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 20000 } = {}) {
  const apiKey = () => String(env.WAHA_API_KEY || '').trim();
  async function request(path, { method = 'GET', body } = {}) {
    const ctrl = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(timeoutMs) : undefined;
    let res;
    try {
      res = await fetchImpl(baseUrl(env) + path, {
        method,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': apiKey() },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl,
      });
    } catch (e) {
      const msg = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'Tiempo de espera agotado al contactar WAHA' : ((e && e.message) || 'error de red');
      return { ok: false, error: msg };
    }
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (_) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error || (data.exception && data.exception.message))) || (raw && raw.slice(0, 180)) || ('HTTP ' + res.status);
      return { ok: false, status: res.status, error: String(msg).slice(0, 300), data };
    }
    return { ok: true, status: res.status, data };
  }

  async function sendText(e164, text) {
    if (!configured(env)) return { ok: false, skipped: true, reason: 'not_configured' };
    const chatId = chatIdFor(e164, env);
    const r = await request('/api/sendText', { method: 'POST', body: { session: sessionName(env), chatId, text: String(text || '').slice(0, 4000) } });
    if (!r.ok) return { ok: false, chatId, error: r.error || 'no se pudo enviar', status: r.status };
    const id = r.data && (r.data.id || (r.data.key && r.data.key.id)) || null;
    return { ok: true, chatId, id };
  }

  async function sessionStatus() {
    if (!configured(env)) return { configured: false, session: sessionName(env), status: 'not_configured', status_label: STATUS_LABEL.not_configured, dashboard_url: dashboardUrl(env) };
    const r = await request('/api/sessions/' + encodeURIComponent(sessionName(env)));
    if (!r.ok && r.status === 404) return { configured: true, session: sessionName(env), status: 'missing', status_label: STATUS_LABEL.missing, dashboard_url: dashboardUrl(env), error: r.error };
    if (!r.ok && !r.status) return { configured: true, session: sessionName(env), status: 'unreachable', status_label: STATUS_LABEL.unreachable, dashboard_url: dashboardUrl(env), error: r.error };
    if (!r.ok) return { configured: true, session: sessionName(env), status: 'FAILED', status_label: STATUS_LABEL.FAILED, dashboard_url: dashboardUrl(env), error: r.error };
    const st = (r.data && r.data.status) || 'STOPPED';
    const me = r.data && r.data.me && (r.data.me.pushName || r.data.me.id) || null;
    return { configured: true, session: sessionName(env), status: st, status_label: STATUS_LABEL[st] || st, me, dashboard_url: dashboardUrl(env) };
  }

  return { configured: () => configured(env), sendText, sessionStatus, dashboardUrl: () => dashboardUrl(env), session: () => sessionName(env) };
}

module.exports = {
  toE164Mx, chatIdFor, baseUrl, sessionName, dashboardUrl, configured, paceMs, createWahaClient, STATUS_LABEL,
  DEFAULT_DELAY_MS, MIN_DELAY_MS, MAX_DELAY_MS,
};
