'use strict';
// Utilidades de la caja de escritorio como CLIENTE EN LÍNEA del servidor (sin operación sin internet).
const DEFAULT_SERVER_URL = 'https://cooperativa-nfc.onrender.com';

// Normaliza la dirección del servidor: solo http(s), sin ruta ni diagonal final. Lanza error si no es válida.
function normalizeServerUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Escriba la dirección del servidor');
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { throw new Error('Dirección inválida'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Use una dirección http:// o https://');
  if (u.username || u.password) throw new Error('Dirección inválida');
  return u.origin;
}

// Elige la dirección: variable COOP_SERVER_URL > configuración guardada > dirección predeterminada
function resolveServerUrl(env = {}, config = {}) {
  for (const c of [env.COOP_SERVER_URL, config.serverUrl]) {
    if (!c) continue;
    try { return normalizeServerUrl(c); } catch (_) { /* se ignora y se usa la siguiente */ }
  }
  return DEFAULT_SERVER_URL;
}

// ¿Responde el servidor? (GET /api/health). Nunca lanza: { ok, error }
async function checkServer(serverUrl, { fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(String(serverUrl).replace(/\/+$/, '') + '/api/health', { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) return { ok: false, error: 'El servidor respondió con error ' + r.status };
    const b = await r.json().catch(() => null);
    return b && b.ok ? { ok: true } : { ok: false, error: 'Respuesta inesperada del servidor' };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'El servidor no respondió a tiempo' : 'Sin conexión a internet o servidor inalcanzable' };
  } finally { clearTimeout(t); }
}

// Solo se permite navegar dentro del servidor configurado (o a las páginas locales de la caja)
function isAllowedUrl(target, serverUrl) {
  try {
    const u = new URL(target);
    if (u.protocol === 'file:') return true;
    return u.origin === new URL(serverUrl).origin;
  } catch (_) { return false; }
}

module.exports = { DEFAULT_SERVER_URL, normalizeServerUrl, resolveServerUrl, checkServer, isAllowedUrl };
