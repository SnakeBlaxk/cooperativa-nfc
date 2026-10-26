'use strict';
// Correo real (Resend) o consola si no hay llave. El mensaje siempre se arma igual:
// { to, channel, subject, text }. La contraseña sigue mostrándose una vez en pantalla.
const { consoleMailer } = require('./auth');

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim());
}

function createResendMailer({ apiKey, from, fetchImpl = globalThis.fetch, log = console } = {}) {
  if (!apiKey || !from) throw new Error('Resend necesita RESEND_API_KEY y MAIL_FROM');
  const outbox = [];
  return {
    outbox,
    provider: 'resend',
    configured: true,
    from,
    status() { return { provider: 'resend', configured: true, from }; },
    async send(msg) {
      outbox.push(msg);
      const to = String(msg.to || '').trim();
      if (!looksLikeEmail(to)) return { ok: false, skipped: true, reason: 'sin_correo' };
      let res;
      try {
        res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject: msg.subject || 'Zuki Pay', text: msg.text || '' }),
        });
      } catch (e) {
        log.error('[mailer] No se pudo conectar con Resend: ' + e.message);
        return { ok: false, error: e.message };
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        log.error(`[mailer] Resend respondió ${res.status}: ${String(t).slice(0, 300)}`);
        return { ok: false, status: res.status, error: String(t).slice(0, 200) };
      }
      const j = await res.json().catch(() => ({}));
      return { ok: true, id: j.id || null };
    },
  };
}

let warned = false;
function createMailer(env = process.env, opts = {}) {
  const apiKey = env && env.RESEND_API_KEY;
  const from = env && env.MAIL_FROM;
  if (apiKey && from) return createResendMailer({ apiKey, from, fetchImpl: opts.fetchImpl, log: opts.log || console });
  if (env && env.NODE_ENV === 'production' && !warned) {
    warned = true;
    console.warn('[mailer] Sin RESEND_API_KEY y MAIL_FROM: las contraseñas no se envían por correo; se muestran en pantalla.');
  }
  const log = opts.log || (env && env.NODE_ENV === 'production' ? () => {} : console.log);
  return consoleMailer(log);
}

// Envía la contraseña al correo de la cuenta. Devuelve true solo si salió por un proveedor real.
async function deliverPassword(mailer, user, password, { appUrl = '' } = {}) {
  if (!mailer || !user) return false;
  const email = looksLikeEmail(user.email) ? String(user.email).trim() : '';
  const to = email || (user.phone ? String(user.phone).trim() : '');
  if (!to) return false;
  const where = appUrl ? ` Entra en ${appUrl}.` : '';
  let sent;
  try {
    sent = await mailer.send({
      to, channel: email ? 'email' : 'sms', subject: 'Tu contraseña de Zuki Pay',
      text: `Hola ${user.full_name || user.username}. Tu usuario es ${user.username} y tu contraseña es ${password}.${where} Guárdala en un lugar seguro. Si no reconoces este mensaje, avisa a la escuela.`,
    });
  } catch (e) {
    console.error('[mailer]', e.message);
    return false;
  }
  return !!(email && mailer.configured && sent && sent.ok && !sent.skipped);
}

module.exports = { createMailer, createResendMailer, deliverPassword, looksLikeEmail };
