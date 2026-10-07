'use strict';
// Servidor en la nube (opcional): API REST + PWA para padres, administrador y cajero.
// Reutiliza la misma lógica de negocio que la app de escritorio (src/core).
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { openDatabase } = require('../src/core/db');
const { createService } = require('../src/core/service');
const { createApi } = require('../src/core/api');
const { createAuth, consoleMailer } = require('../src/core/auth');
const { seedPlatform, seedMinimal, ensureSuperadmin } = require('../src/core/seed');
const { createPlatform } = require('../src/core/platform');
const { createSyncServer } = require('../src/core/sync-server');

// Métodos que, con una caja de escritorio sincronizada, solo se hacen en el escritorio (fuente de verdad)
const DESKTOP_OWNED = ['purchase', 'recharge', 'adjust', 'registerCard', 'assignCard', 'reportLostAndReplace', 'createProduct', 'updateProduct', 'deleteProduct', 'createCategory', 'createChild'];

async function createServer(opts = {}) {
  const db = opts.db || await openDatabase(opts.dbPath || null);
  if (opts.seed !== false) seedPlatform(db); // demo: superadmin zuki/zuki123 + 2 escuelas
  // Producción: superadministrador desde variables de entorno (debe cambiar la contraseña al entrar)
  if (opts.bootstrapSuperadmin && !db.get("SELECT id FROM users WHERE role = 'superadmin'")) {
    const { username, password } = opts.bootstrapSuperadmin;
    if (!password || password.length < 8) throw new Error('SUPERADMIN_PASSWORD debe tener al menos 8 caracteres');
    ensureSuperadmin(db, { username: username || 'zuki', password, mustChange: true });
    console.log('[auth] Superadministrador inicial creado:', username || 'zuki');
  }
  // Opcional: primera escuela con su administrador (ADMIN_USER/ADMIN_PASSWORD)
  if (opts.bootstrapAdmin && !db.get("SELECT id FROM users WHERE role = 'admin'")) {
    const { username, password } = opts.bootstrapAdmin;
    if (!password || password.length < 8) throw new Error('ADMIN_PASSWORD debe tener al menos 8 caracteres');
    seedMinimal(db, { username: username || 'admin', password, schoolName: opts.bootstrapSchoolName || 'Mi escuela' });
    console.log('[auth] Escuela y administrador inicial creados:', username || 'admin');
  }
  const svc = createService(db);
  const api = createApi(svc);
  let secret = opts.jwtSecret || process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new Error('Define JWT_SECRET (mín. 32 caracteres) en producción');
    // Desarrollo: se genera y guarda en la base para que las sesiones sobrevivan reinicios
    const row = db.get("SELECT value FROM meta WHERE key = 'dev_jwt_secret'");
    secret = row ? row.value : crypto.randomBytes(48).toString('hex');
    if (!row) db.run("INSERT INTO meta (key, value) VALUES ('dev_jwt_secret', ?)", [secret]);
    console.warn('[auth] JWT_SECRET no definido: usando secreto de desarrollo guardado en la base.');
  }
  const sync = createSyncServer(db);
  const auth = createAuth(db, svc, { jwtSecret: secret, mailer: opts.mailer || consoleMailer(), appUrl: opts.appUrl || process.env.APP_URL, onChildLinked: (id) => sync.recordChild('child_link', id), ...(opts.authOptions || {}) });

  const platform = createPlatform(db, { svc, sync, auth });
  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy || process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use('/api/sync/push', express.json({ limit: '25mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
  });

  const STATUS = { OTRO_EQUIPO_PRINCIPAL: 409, REFERENCIA_FALTANTE: 409, SOLO_ESCRITORIO: 409, NO_AUTENTICADO: 401, PROHIBIDO: 403, DEBE_CAMBIAR_PASSWORD: 403, NO_ENCONTRADO: 404, ESCUELA_SUSPENDIDA: 403, DUPLICADO: 409, CONFLICTO: 409, VALIDACION: 400, LIMITE_INTENTOS: 429, INTERNO: 500 };
  const send = (res, fn) => {
    Promise.resolve().then(fn).then((data) => res.json({ ok: true, data })).catch((e) => {
      const code = e.code || 'INTERNO';
      if (!e.code) console.error(e);
      res.status(STATUS[code] || 400).json({ ok: false, error: e.code ? e.message : 'Error interno', code });
    });
  };
  const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });
  // Middleware de autenticación: Authorization: Bearer <access_token>
  const authenticate = ({ allowMustChange = false } = {}) => (req, res, next) => {
    try {
      const h = req.get('authorization') || '';
      const m = /^Bearer\s+(.+)$/i.exec(h);
      if (!m) throw Object.assign(new Error('Sesión no iniciada'), { code: 'NO_AUTENTICADO' });
      req.user = auth.verifyAccess(m[1]);
      if (req.user.must_change_password && !allowMustChange) throw Object.assign(new Error('Debes cambiar tu contraseña antes de continuar'), { code: 'DEBE_CAMBIAR_PASSWORD' });
      next();
    } catch (e) { res.status(STATUS[e.code] || 401).json({ ok: false, error: e.message, code: e.code || 'NO_AUTENTICADO' }); }
  };
  const requireRole = (...roles) => (req, res, next) => (roles.includes(req.user.role) ? next() : res.status(403).json({ ok: false, error: 'No tienes permiso para esta acción', code: 'PROHIBIDO' }));

  // ----- salud -----
  app.get('/api/health', (req, res) => res.json({ ok: true, data: { status: 'ok', time: new Date().toISOString() } }));

  // ----- autenticación -----
  app.post('/api/auth/login', (req, res) => send(res, () => auth.login(req.body.identifier || req.body.username, req.body.password, ctx(req))));
  app.post('/api/auth/refresh', (req, res) => send(res, () => auth.refresh(req.body.refresh_token, ctx(req))));
  app.post('/api/auth/logout', (req, res) => send(res, () => auth.logout(req.body.refresh_token)));
  app.post('/api/auth/logout-all', authenticate({ allowMustChange: true }), (req, res) => send(res, () => auth.logoutAll(req.user)));
  app.get('/api/auth/me', authenticate({ allowMustChange: true }), (req, res) => send(res, () => req.user));
  app.post('/api/auth/change-password', authenticate({ allowMustChange: true }), (req, res) => send(res, () => auth.changePassword(req.user, req.body.current, req.body.next, ctx(req))));
  app.post('/api/auth/forgot', (req, res) => send(res, () => auth.requestPasswordReset(req.body.identifier, ctx(req))));
  app.post('/api/auth/reset', (req, res) => send(res, () => auth.resetPassword(req.body.token, req.body.password)));
  app.post('/api/auth/register', (req, res) => send(res, () => auth.registerWithInvitation(req.body || {}, ctx(req))));
  app.post('/api/auth/redeem', authenticate(), requireRole('tutor'), (req, res) => send(res, () => auth.redeemInvitation(req.user, req.body.code)));

  // ----- administración de cuentas -----
  app.post('/api/admin/tutors', authenticate(), requireRole('admin'), (req, res) => send(res, () => auth.createTutorAccount(req.user, req.body || {})));
  app.post('/api/admin/invitations', authenticate(), requireRole('admin'), (req, res) => send(res, () => auth.createInvitation(req.user, req.body.child_id, { reuse: !!req.body.reuse })));
  app.get('/api/admin/invitations', authenticate(), requireRole('admin'), (req, res) => send(res, () => auth.listInvitations(req.user)));

  // ----- sincronización con la app de escritorio -----
  // Autenticación: token de equipo (X-Device-Token) o JWT de admin/cajero + X-Device-Id de un equipo vinculado.
  const deviceAuth = (req, res, next) => {
    try {
      const tok = req.get('x-device-token');
      if (tok) { req.device = sync.authDevice(tok); return next(); }
      const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
      if (!m) throw Object.assign(new Error('Equipo no autorizado'), { code: 'NO_AUTENTICADO' });
      const u = auth.verifyAccess(m[1]);
      if (!['admin', 'cajero'].includes(u.role)) throw Object.assign(new Error('No tienes permiso para sincronizar'), { code: 'PROHIBIDO' });
      const d = db.get('SELECT * FROM devices WHERE id = ? AND revoked = 0 AND school_id = ?', [String(req.get('x-device-id') || ''), u.school_id]);
      if (!d) throw Object.assign(new Error('Equipo no vinculado'), { code: 'NO_AUTENTICADO' });
      req.device = d; req.user = u; next();
    } catch (e) { res.status(STATUS[e.code] || 401).json({ ok: false, error: e.message, code: e.code || 'NO_AUTENTICADO' }); }
  };
  app.post('/api/sync/devices', authenticate(), requireRole('admin'), (req, res) => send(res, () => sync.registerDevice(req.user, req.body || {})));
  app.get('/api/sync/devices', authenticate(), requireRole('admin'), (req, res) => send(res, () => sync.listDevices(req.user)));
  app.post('/api/sync/devices/:id/revoke', authenticate(), requireRole('admin'), (req, res) => send(res, () => sync.revokeDevice(req.user, req.params.id)));
  app.post('/api/sync/devices/:id/primary', authenticate(), requireRole('admin'), (req, res) => send(res, () => sync.setPrimary(req.user, req.params.id)));
  app.post('/api/sync/push', deviceAuth, (req, res) => send(res, () => sync.push(req.device, req.body || {})));
  app.get('/api/sync/pull', deviceAuth, (req, res) => send(res, () => sync.pull(req.device, req.query.cursor)));
  app.get('/api/sync/status', deviceAuth, (req, res) => send(res, () => {
    const sc = db.get('SELECT uuid, name, status, primary_device_id FROM schools WHERE id = ?', [req.device.school_id]) || {};
    const p = sc.primary_device_id || null;
    return { device_id: req.device.id, device_name: req.device.name, primary_device: p, is_primary: !p || p === req.device.id, school_uuid: sc.uuid, school_name: sc.name, school_status: sc.status };
  }));
  // Códigos de invitación para la hoja que imprime la caja (alumnos ya sincronizados de su escuela)
  app.post('/api/sync/invitations', deviceAuth, (req, res) => send(res, () => auth.invitationsForSchool(req.device.school_id, (req.body || {}).child_uuids, { reuse: true, skipLinked: (req.body || {}).include_linked ? false : true })));

  // ----- panel del superadministrador (Zuki Company) -----
  app.post('/api/super/:method', authenticate(), requireRole('superadmin'), (req, res) => send(res, () => platform.handle(req.user, req.params.method, req.body || {})));

  // ----- lógica de negocio (misma que el escritorio). Permisos validados en el servicio -----
  app.post('/api/rpc/:method', authenticate(), (req, res) => {
    const method = req.params.method;
    if (['login', 'logout', 'me'].includes(method)) return res.status(400).json({ ok: false, error: 'Usa /api/auth/*', code: 'VALIDACION' });
    if (req.user.role === 'superadmin' && method !== 'changePassword') return res.status(403).json({ ok: false, error: 'El superadministrador usa el panel de instituciones', code: 'PROHIBIDO' });
    if (DESKTOP_OWNED.includes(method) && ['admin', 'cajero'].includes(req.user.role) && sync.isSynced(req.user.school_id)) {
      return res.status(409).json({ ok: false, error: 'Este servidor está sincronizado con la caja de escritorio: ventas, recargas, tarjetas, alumnos y productos se registran en la caja.', code: 'SOLO_ESCRITORIO' });
    }
    const args = req.body || {};
    const prevTutor = method === 'updateChild' && args.id ? (db.get('SELECT tutor_id FROM children WHERE id = ?', [Number(args.id)]) || {}).tutor_id : undefined;
    const r = api.handle({ user: req.user }, method, args);
    if (r.ok) {
      // Bitácora de ajustes del servidor que los equipos de escritorio descargarán
      if (method === 'setLimits') sync.recordChild('limits', Number(args.child_id));
      else if (method === 'setProhibitions') sync.recordChild('prohibitions', Number(args.child_id));
      else if (method === 'setCardStatus') sync.recordCard(Number(args.card_id));
      else if (method === 'updateChild') {
        sync.recordChild('child_profile', Number(args.id));
        if (r.data && r.data.tutor_id !== prevTutor) sync.recordChild('child_link', Number(args.id));
      }
      return res.json(r);
    }
    return res.status(STATUS[r.code] || 400).json(r);
  });

  // ----- PWA -----
  const renderer = path.join(__dirname, '..', 'src', 'renderer');
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
  app.use(express.static(renderer, { index: false }));
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada', code: 'NO_ENCONTRADO' }));

  return { app, db, svc, auth, sync, platform };
}
module.exports = { createServer };
