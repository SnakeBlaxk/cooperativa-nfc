'use strict';
// Inicio de sesión de escritorio contra el servidor (cuando está configurado), con respaldo local.
// - Servidor responde OK (admin/cajero): se actualiza la cuenta local (hash bcrypt de la contraseña)
//   para poder entrar después sin internet.
// - Servidor rechaza credenciales: se rechaza (el servidor manda cuando está disponible).
// - Servidor inalcanzable / timeout: se usa el login local (modo sin conexión).
const bcrypt = require('bcryptjs');

async function remoteLogin({ serverUrl, username, password, db, fetchImpl = globalThis.fetch, timeoutMs = 5000, schoolUuid = null, localSchoolId = null }) {
  const base = String(serverUrl || '').replace(/\/+$/, '');
  let res; let body;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    res = await fetchImpl(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: username, password }), signal: ctrl.signal });
    body = await res.json();
  } catch (e) {
    return { status: 'offline', error: e.name === 'AbortError' ? 'Tiempo de espera agotado' : e.message };
  } finally { clearTimeout(timer); }
  if (res.status >= 500) return { status: 'offline', error: 'Error del servidor' };
  if (!body || !body.ok) return { status: 'rejected', error: (body && body.error) || 'Credenciales rechazadas por el servidor' };
  const ru = body.data.user;
  if (ru.role === 'superadmin') return { status: 'rejected', error: 'La cuenta de superadministrador se usa en el panel web, no en la caja' };
  if (!['admin', 'cajero'].includes(ru.role)) return { status: 'local-only', error: 'Las cuentas de tutor se usan en la app web' };
  // Multi-escuela: el equipo vinculado solo acepta personal de SU escuela
  if (schoolUuid && ru.school_uuid && ru.school_uuid !== schoolUuid) return { status: 'rejected', error: 'Esta cuenta pertenece a otra escuela' };
  if (body.data.must_change_password) return { status: 'rejected', error: 'Tu contraseña es temporal: cámbiala primero en la app web del servidor' };
  // Sincroniza la cuenta en la base local (por nombre de usuario)
  const hash = bcrypt.hashSync(String(password), 10);
  const local = db.get('SELECT id FROM users WHERE username = ?', [ru.username]);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (local) db.run('UPDATE users SET password_hash = ?, role = ?, full_name = ?, active = 1, must_change_password = 0 WHERE id = ?', [hash, ru.role, ru.full_name, local.id]);
  else db.run('INSERT INTO users (username, password_hash, role, full_name, email, school_id, created_at) VALUES (?,?,?,?,?,?,?)', [ru.username, hash, ru.role, ru.full_name, ru.email || null, localSchoolId, now]);
  return { status: 'ok', tokens: { access_token: body.data.access_token, refresh_token: body.data.refresh_token }, remoteUser: ru };
}

async function testServer(serverUrl, fetchImpl = globalThis.fetch) {
  try {
    const u = new URL(serverUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Use http:// o https://');
    const r = await fetchImpl(String(serverUrl).replace(/\/+$/, '') + '/api/health', { signal: AbortSignal.timeout(5000) });
    const b = await r.json();
    return b && b.ok ? { ok: true } : { ok: false, error: 'Respuesta inesperada' };
  } catch (e) { return { ok: false, error: e.message }; }
}
module.exports = { remoteLogin, testServer };
