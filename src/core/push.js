'use strict';
// Notificaciones Web Push para padres/tutores (PWA). Solo servidor.
// Llaves VAPID: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT. Si no están definidas se generan una vez
// y se guardan en la base (tabla meta), así siguen funcionando tras reinicios (la base se respalda en Turso).
let webpush = null;
try { webpush = require('web-push'); } catch (_) { webpush = null; }

const money = (c) => '$' + ((Number(c) || 0) / 100).toFixed(2);

function resolveVapid(db, env = process.env) {
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    return { publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: env.VAPID_PRIVATE_KEY.trim(), subject: (env.VAPID_SUBJECT || 'mailto:contacto@zuki.example').trim(), source: 'env' };
  }
  const row = db.get("SELECT value FROM meta WHERE key = 'vapid_keys'");
  let k = row ? JSON.parse(row.value) : null;
  if (!k && webpush) {
    k = webpush.generateVAPIDKeys();
    db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('vapid_keys', ?)", [JSON.stringify(k)]);
    console.warn('[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY no definidas: se generaron llaves y se guardaron en la base.');
  }
  return k ? { publicKey: k.publicKey, privateKey: k.privateKey, subject: (env.VAPID_SUBJECT || 'mailto:contacto@zuki.example').trim(), source: 'base' } : null;
}

// sender(sub, payloadString) -> Promise; puede rechazar con { statusCode }
function createPush(db, { svc, sender, env, log = console } = {}) {
  const vapid = resolveVapid(db, env);
  const send = sender || ((sub, payload) => {
    if (!webpush || !vapid) return Promise.reject(new Error('web-push no disponible'));
    return webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload,
      { vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 6 * 3600, urgency: 'high' });
  });
  const pending = new Set();
  const nowTs = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };

  async function toUser(userId, msg) {
    const subs = db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
    const payload = JSON.stringify({ title: msg.title, body: msg.body, tag: msg.tag, url: msg.url || '/', kind: msg.kind });
    let sent = 0;
    await Promise.all(subs.map(async (s) => {
      try {
        await send(s, payload);
        sent++; db.run('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?', [nowTs(), s.id]);
      } catch (e) {
        const code = e && e.statusCode;
        // 404/410: la suscripción ya no existe (se desinstaló la app o se quitó el permiso) → se borra
        if (code === 404 || code === 410) db.run('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
        else {
          db.run('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?', [s.id]);
          db.run('DELETE FROM push_subscriptions WHERE id = ? AND failures >= 15', [s.id]);
          log.error('[push] envío fallido:', code || (e && e.message));
        }
      }
    }));
    return sent;
  }
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); return p; };

  // Avisos tras una compra (aprobada o rechazada) de un alumno
  function onPurchase(txId) {
    const t = db.get('SELECT t.*, c.full_name AS child_name, c.tutor_id FROM transactions t LEFT JOIN children c ON c.id = t.child_id WHERE t.id = ?', [txId]);
    if (!t || t.type !== 'compra' || !t.tutor_id) return track(Promise.resolve(0));
    const prefs = svc.getPushPrefsRaw(t.tutor_id);
    const items = db.all('SELECT product_name, qty FROM transaction_items WHERE transaction_id = ?', [t.id]);
    const summary = items.map((i) => (i.qty > 1 ? `${i.qty}× ` : '') + i.product_name).join(', ');
    const short = summary.length > 90 ? summary.slice(0, 87) + '…' : summary;
    const first = (t.child_name || 'Su hijo(a)').split(' ')[0];
    const jobs = [];
    if (t.status === 'aprobado') {
      if (prefs.purchases) jobs.push({ kind: 'compra', tag: 'compra-' + t.id, title: `🛒 ${first} compró ${money(t.amount_cents)}`, body: `${short}. Saldo restante: ${money(t.balance_after_cents)}` });
      // Saldo bajo: una vez por cruce del umbral (se rearma al recargar por encima)
      if (prefs.low_balance) {
        const low = t.balance_after_cents < prefs.low_balance_cents;
        const st = db.get('SELECT notified FROM low_balance_state WHERE child_id = ?', [t.child_id]);
        if (low && !(st && st.notified)) {
          db.run('INSERT INTO low_balance_state (child_id, notified, updated_at) VALUES (?,1,?) ON CONFLICT(child_id) DO UPDATE SET notified = 1, updated_at = excluded.updated_at', [t.child_id, nowTs()]);
          jobs.push({ kind: 'saldo_bajo', tag: 'saldo-' + t.child_id, title: `⚠️ Saldo bajo de ${first}`, body: `Le quedan ${money(t.balance_after_cents)} (aviso por debajo de ${money(prefs.low_balance_cents)}). Recargue en la cooperativa.` });
        }
      }
    } else if (prefs.rejected) {
      jobs.push({ kind: 'rechazada', tag: 'rechazo-' + t.id, title: `⛔ Compra rechazada de ${first}`, body: `${t.reason || 'Rechazada'}${short ? ' · ' + short : ''} (${money(t.amount_cents)})` });
    }
    return track(Promise.all(jobs.map((j) => toUser(t.tutor_id, j))).then((r) => r.reduce((a, b) => a + b, 0)).catch((e) => { log.error('[push]', e); return 0; }));
  }
  // Recarga/ajuste: si el saldo vuelve a quedar arriba del umbral, se rearma el aviso de saldo bajo
  function onBalanceChange(childId) {
    const c = childId && db.get('SELECT tutor_id FROM children WHERE id = ?', [childId]);
    if (!c || !c.tutor_id) return;
    const prefs = svc.getPushPrefsRaw(c.tutor_id);
    const k = db.get("SELECT balance_cents FROM cards WHERE child_id = ? AND status IN ('activa','bloqueada') ORDER BY id DESC LIMIT 1", [childId]);
    if (k && k.balance_cents >= prefs.low_balance_cents) db.run('UPDATE low_balance_state SET notified = 0, updated_at = ? WHERE child_id = ? AND notified = 1', [nowTs(), childId]);
  }
  function test(userId) { return track(toUser(userId, { kind: 'prueba', tag: 'prueba', title: '🔔 Notificaciones activadas', body: 'Así le avisaremos de las compras de sus hijos en la cooperativa.' })); }
  const idle = () => Promise.all([...pending]);
  return { publicKey: vapid ? vapid.publicKey : null, vapidSource: vapid ? vapid.source : null, onPurchase, onBalanceChange, test, toUser, idle };
}

module.exports = { createPush, resolveVapid };
