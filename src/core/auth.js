'use strict';
// Autenticación del servidor: JWT de acceso + refresh tokens rotativos, límite de intentos,
// cambio obligatorio de contraseña, recuperación por token e invitaciones por alumno/tarjeta.
// Independiente de Express para poder probarlo con node:test.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { AppError, fmtLocal, str, normEmail, normPhone } = require('./service');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
// Código legible sin caracteres ambiguos (0/O, 1/I)
function inviteCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(8);
  let s = ''; for (let i = 0; i < 8; i++) s += A[b[i] % A.length];
  return `COOP-${s.slice(0, 4)}-${s.slice(4)}`;
}
function tempPassword() {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(10);
  let s = ''; for (let i = 0; i < 10; i++) s += A[b[i] % A.length];
  return s;
}

// Mailer enchufable: en desarrollo solo imprime en consola. En producción implementar
// send({ to, subject, text }) con Resend, SendGrid, Amazon SES (correo) o Twilio (SMS).
function consoleMailer(log = console.log) {
  const outbox = [];
  return {
    outbox,
    async send(msg) { outbox.push(msg); log(`[mailer:dev] Para: ${msg.to} | ${msg.subject}\n${msg.text}`); },
  };
}

// Limitador en memoria (ventana deslizante). Para varias instancias usar Redis.
function createRateLimiter({ max, windowMs, now }) {
  const hits = new Map();
  return {
    check(key) {
      const t = now(); const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
      hits.set(key, arr);
      if (arr.length >= max) {
        const retry = Math.ceil((windowMs - (t - arr[0])) / 1000);
        throw new AppError(`Demasiados intentos. Intenta de nuevo en ${Math.ceil(retry / 60)} min.`, 'LIMITE_INTENTOS');
      }
    },
    hit(key) { const arr = hits.get(key) || []; arr.push(now()); hits.set(key, arr); },
    reset(key) { hits.delete(key); },
  };
}

function createAuth(db, svc, opts = {}) {
  const nowMs = opts.nowMs || (() => Date.now());
  const ts = () => fmtLocal(new Date(nowMs()));
  const secret = opts.jwtSecret;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET debe tener al menos 32 caracteres');
  const accessTtlSec = opts.accessTtlSec || 15 * 60; // 15 minutos
  const refreshTtlMs = opts.refreshTtlMs || 30 * 24 * 3600 * 1000; // 30 días
  const resetTtlMs = opts.resetTtlMs || 60 * 60 * 1000; // 1 hora
  const inviteTtlMs = opts.inviteTtlMs || 30 * 24 * 3600 * 1000;
  const mailer = opts.mailer || consoleMailer();
  const appUrl = (opts.appUrl || 'http://localhost:3000').replace(/\/$/, '');
  const loginLimiter = createRateLimiter({ max: opts.maxLoginAttempts || 5, windowMs: opts.loginWindowMs || 15 * 60 * 1000, now: nowMs });
  const ipLimiter = createRateLimiter({ max: opts.maxIpAttempts || 30, windowMs: opts.loginWindowMs || 15 * 60 * 1000, now: nowMs });
  const forgotLimiter = createRateLimiter({ max: 5, windowMs: 60 * 60 * 1000, now: nowMs });

  const getUser = (id) => db.get('SELECT * FROM users WHERE id = ?', [id]);
  const onChildLinked = opts.onChildLinked || (() => {});

  function issueTokens(u, { family, userAgent } = {}) {
    const access_token = jwt.sign({ iat: Math.floor(nowMs() / 1000), sub: u.id, role: u.role, tv: u.token_version, mcp: !!u.must_change_password }, secret,
      { algorithm: 'HS256', expiresIn: accessTtlSec, issuer: 'cooperativa-nfc' });
    const refresh_token = randomToken(48);
    db.run('INSERT INTO refresh_tokens (user_id, token_hash, family, expires_at, created_at, user_agent) VALUES (?,?,?,?,?,?)',
      [u.id, sha256(refresh_token), family || randomToken(12), nowMs() + refreshTtlMs, ts(), userAgent ? String(userAgent).slice(0, 200) : null]);
    return { access_token, refresh_token, token_type: 'Bearer', expires_in: accessTtlSec, user: svc.publicUser(u), must_change_password: !!u.must_change_password };
  }

  function login(identifier, password, { ip = 'local', userAgent } = {}) {
    const idKey = 'id:' + String(identifier || '').trim().toLowerCase();
    loginLimiter.check(idKey); ipLimiter.check('ip:' + ip);
    let user;
    try { user = svc.login(identifier, password); } catch (e) {
      loginLimiter.hit(idKey); ipLimiter.hit('ip:' + ip);
      throw e;
    }
    loginLimiter.reset(idKey);
    return issueTokens(getUser(user.id), { userAgent });
  }

  // Verifica el JWT de acceso y que el usuario siga activo y sin sesiones revocadas.
  function verifyAccess(token) {
    let p;
    try { p = jwt.verify(String(token || ''), secret, { algorithms: ['HS256'], issuer: 'cooperativa-nfc', clockTimestamp: Math.floor(nowMs() / 1000) }); } catch (e) {
      throw new AppError(e.name === 'TokenExpiredError' ? 'La sesión expiró' : 'Sesión inválida', 'NO_AUTENTICADO');
    }
    const u = getUser(p.sub);
    if (!u || !u.active || u.token_version !== p.tv) throw new AppError('Sesión inválida o cerrada', 'NO_AUTENTICADO');
    svc.assertSchoolActive(u);
    return svc.publicUser(u);
  }

  // Rotación: cada refresh invalida el anterior. Si se reutiliza uno ya usado (posible robo),
  // se revoca toda la familia de tokens.
  function refresh(refreshToken, { userAgent } = {}) {
    const row = db.get('SELECT * FROM refresh_tokens WHERE token_hash = ?', [sha256(refreshToken || '')]);
    if (!row) throw new AppError('Sesión inválida', 'NO_AUTENTICADO');
    if (row.revoked) {
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE family = ?', [row.family]);
      throw new AppError('Sesión revocada. Inicia sesión de nuevo.', 'NO_AUTENTICADO');
    }
    if (row.expires_at < nowMs()) throw new AppError('La sesión expiró. Inicia sesión de nuevo.', 'NO_AUTENTICADO');
    const u = getUser(row.user_id);
    if (!u || !u.active) throw new AppError('Usuario inactivo', 'NO_AUTENTICADO');
    svc.assertSchoolActive(u);
    return db.transaction(() => {
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [row.id]);
      return issueTokens(u, { family: row.family, userAgent });
    });
  }

  function logout(refreshToken) {
    if (refreshToken) db.run('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [sha256(refreshToken)]);
    return { ok: true };
  }
  function logoutAll(actor) {
    db.transaction(() => {
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [actor.id]);
      db.run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [actor.id]);
    });
    return { ok: true };
  }

  function changePassword(actor, current, next, { userAgent } = {}) {
    svc.changePassword(actor, current, next); // valida y sube token_version (invalida otros accesos)
    db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [actor.id]);
    return issueTokens(getUser(actor.id), { userAgent });
  }

  // ----- recuperación de contraseña -----
  async function requestPasswordReset(identifier, { ip = 'local' } = {}) {
    forgotLimiter.check('f:' + ip + ':' + String(identifier || '').toLowerCase());
    forgotLimiter.hit('f:' + ip + ':' + String(identifier || '').toLowerCase());
    const u = svc.findUserByIdentifier(identifier);
    // Respuesta idéntica exista o no la cuenta (evita enumerar usuarios)
    const generic = { ok: true, message: 'Si la cuenta existe, enviamos instrucciones para restablecer la contraseña.' };
    if (!u || !u.active) return generic;
    const token = randomToken(32);
    db.run('INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?,?,?,?)', [u.id, sha256(token), nowMs() + resetTtlMs, ts()]);
    const to = u.email || u.phone || u.username;
    await mailer.send({
      to, channel: u.email ? 'email' : (u.phone ? 'sms' : 'console'), subject: 'Restablecer contraseña — Cooperativa NFC',
      text: `Hola ${u.full_name}. Para restablecer tu contraseña abre este enlace (válido 1 hora):\n${appUrl}/?reset=${token}\nSi no lo solicitaste, ignora este mensaje.`,
      token, userId: u.id,
    });
    return generic;
  }
  function resetPassword(token, newPassword) {
    const row = db.get('SELECT * FROM password_resets WHERE token_hash = ?', [sha256(token || '')]);
    if (!row || row.used || row.expires_at < nowMs()) throw new AppError('El enlace no es válido o ya expiró', 'VALIDACION');
    const p = str(newPassword, 'nueva contraseña', { min: 6, max: 100 });
    db.transaction(() => {
      db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [row.id]);
      db.run('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?', [bcrypt.hashSync(p, 10), row.user_id]);
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [row.user_id]);
    });
    return { ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' };
  }

  // ----- alta de tutores por el admin (contraseña temporal) -----
  async function createTutorAccount(actor, data) {
    if (!actor || actor.role !== 'admin') throw new AppError('No tienes permiso para esta acción', 'PROHIBIDO');
    if (!data.email && !data.phone) throw new AppError('Indica correo o teléfono del tutor', 'VALIDACION');
    const password = tempPassword();
    const u = svc.createUser(actor, { role: 'tutor', full_name: data.full_name, email: data.email || null, phone: data.phone || null, password, must_change_password: true });
    if (Array.isArray(data.child_ids)) {
      for (const cid of data.child_ids) { svc.updateChild(actor, cid, { tutor_id: u.id }); onChildLinked(Number(cid)); }
    }
    await mailer.send({ to: u.email || u.phone, channel: u.email ? 'email' : 'sms', subject: 'Tu cuenta de la Cooperativa NFC',
      text: `Hola ${u.full_name}. Tu usuario es ${u.username} y tu contraseña temporal es ${password}. Al entrar en ${appUrl} se te pedirá cambiarla.` });
    return { user: u, temporary_password: password };
  }

  // ----- invitaciones (código por alumno/tarjeta) -----
  // Genera (o reutiliza, si reuse) el código pendiente de un alumno
  function inviteFor(c, createdBy, { reuse = false } = {}) {
    if (reuse) {
      const p = db.get('SELECT * FROM invitations WHERE child_id = ? AND used_by IS NULL AND expires_at > ? ORDER BY id DESC LIMIT 1', [c.id, nowMs()]);
      if (p) return { code: p.code, child_id: c.id, child_name: c.full_name, grade: c.grade, expires_at: fmtLocal(new Date(p.expires_at)) };
    }
    // invalida códigos pendientes anteriores del mismo alumno
    db.run('UPDATE invitations SET expires_at = ? WHERE child_id = ? AND used_by IS NULL AND expires_at > ?', [nowMs() - 1, c.id, nowMs()]);
    let code; do { code = inviteCode(); } while (db.get('SELECT id FROM invitations WHERE code = ?', [code]));
    const expires_at = nowMs() + inviteTtlMs;
    db.run('INSERT INTO invitations (code, child_id, created_by, expires_at, created_at) VALUES (?,?,?,?,?)', [code, c.id, createdBy, expires_at, ts()]);
    return { code, child_id: c.id, child_name: c.full_name, grade: c.grade, expires_at: fmtLocal(new Date(expires_at)) };
  }
  // Admin: solo alumnos de su escuela. Superadmin: cualquiera.
  function createInvitation(actor, childId, opt = {}) {
    if (!actor || !['admin', 'superadmin'].includes(actor.role)) throw new AppError('No tienes permiso para esta acción', 'PROHIBIDO');
    const c = db.get('SELECT * FROM children WHERE id = ?', [Number(childId)]);
    if (!c || (actor.role === 'admin' && c.school_id !== actor.school_id)) throw new AppError('Alumno no encontrado', 'NO_ENCONTRADO');
    return inviteFor(c, actor.id || null, opt);
  }
  // Para un equipo vinculado (hoja de códigos): alumnos por uuid dentro de su escuela
  function invitationsForSchool(schoolId, childUuids, opt = { reuse: true }) {
    if (!Array.isArray(childUuids) || childUuids.length > 500) throw new AppError('Lista de alumnos inválida', 'VALIDACION');
    return db.transaction(() => childUuids.map((u) => {
      const c = db.get('SELECT * FROM children WHERE uuid = ? AND school_id = ?', [String(u), schoolId]);
      if (!c) return { child_uuid: u, error: 'Alumno aún no sincronizado' };
      if (c.tutor_id && opt.skipLinked !== false) return { child_uuid: u, child_name: c.full_name, linked: true };
      return { child_uuid: u, ...inviteFor(c, null, opt) };
    }));
  }
  function listInvitations(actor, { school_id } = {}) {
    if (!actor || !['admin', 'superadmin'].includes(actor.role)) throw new AppError('No tienes permiso para esta acción', 'PROHIBIDO');
    const sid = actor.role === 'admin' ? Number(actor.school_id) || -1 : (school_id ? Number(school_id) : null);
    return db.all(`SELECT i.code, i.child_id, c.full_name AS child_name, c.grade, i.expires_at, i.used_at, u.full_name AS used_by_name, i.created_at
      FROM invitations i JOIN children c ON c.id = i.child_id LEFT JOIN users u ON u.id = i.used_by
      ${sid !== null ? 'WHERE c.school_id = ' + sid : ''} ORDER BY i.id DESC LIMIT 300`)
      .map((r) => ({ ...r, expires_at: fmtLocal(new Date(r.expires_at)), status: r.used_at ? 'usado' : (r.expires_at < nowMs() ? 'vencido' : 'pendiente') }));
  }
  function takeInvitation(code) {
    const c = String(code || '').trim().toUpperCase().replace(/\s/g, '');
    const inv = db.get('SELECT * FROM invitations WHERE code = ?', [c]);
    if (!inv || inv.used_by || inv.expires_at < nowMs()) throw new AppError('Código de invitación inválido, usado o vencido', 'VALIDACION');
    return inv;
  }
  function linkChild(inv, userId) {
    db.run('UPDATE children SET tutor_id = ? WHERE id = ?', [userId, inv.child_id]);
    db.run('UPDATE invitations SET used_by = ?, used_at = ? WHERE id = ?', [userId, ts(), inv.id]);
    onChildLinked(inv.child_id);
  }
  // Autoregistro del padre con el código entregado junto con la tarjeta
  function registerWithInvitation(data, { ip = 'local', userAgent } = {}) {
    ipLimiter.check('ip:' + ip);
    let inv;
    try { inv = takeInvitation(data.code); } catch (e) { ipLimiter.hit('ip:' + ip); throw e; }
    if (!data.email && !data.phone) throw new AppError('Indica tu correo o teléfono', 'VALIDACION');
    const email = data.email ? normEmail(data.email) : null;
    const phone = data.phone ? normPhone(data.phone) : null;
    if (data.phone && !phone) throw new AppError('Teléfono inválido (10 dígitos)', 'VALIDACION');
    const password = str(data.password, 'contraseña', { min: 8, max: 100 });
    const full_name = str(data.full_name, 'nombre completo', { max: 120 });
    const child = db.get('SELECT school_id FROM children WHERE id = ?', [inv.child_id]);
    const system = { id: 0, role: 'admin', school_id: child ? child.school_id : null }; // actor interno para crear la cuenta
    const u = db.transaction(() => {
      const created = svc.createUser(system, { role: 'tutor', full_name, email, phone, password, must_change_password: false });
      linkChild(inv, created.id);
      return created;
    });
    return issueTokens(getUser(u.id), { userAgent });
  }
  // Tutor ya registrado vincula otro hijo con su código
  function redeemInvitation(actor, code) {
    if (!actor || actor.role !== 'tutor') throw new AppError('Solo los tutores pueden vincular alumnos', 'PROHIBIDO');
    const inv = takeInvitation(code);
    db.transaction(() => linkChild(inv, actor.id));
    const c = db.get('SELECT id, full_name FROM children WHERE id = ?', [inv.child_id]);
    return { ok: true, child: c };
  }

  return { login, verifyAccess, refresh, logout, logoutAll, changePassword, requestPasswordReset, resetPassword, createTutorAccount, createInvitation, invitationsForSchool, listInvitations, registerWithInvitation, redeemInvitation, mailer };
}

module.exports = { createAuth, consoleMailer, createRateLimiter, sha256 };
