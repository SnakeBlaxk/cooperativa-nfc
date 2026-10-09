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
const { createSecurity } = require('../src/core/security');
const { createBilling } = require('../src/core/billing');

// Métodos que, con una caja VIEJA sincronizada (solo si LEGACY_SYNC=1), se hacían solo en el escritorio.
// En el modo normal (solo en línea) el servidor es la única fuente de verdad y estos métodos se usan desde
// la web y la caja de escritorio nueva (que es un cliente en línea).
const DESKTOP_OWNED = ['purchase', 'recharge', 'adjust', 'registerCard', 'assignCard', 'assignCardByUid', 'unassignCard', 'reportLostAndReplace', 'createProduct', 'updateProduct', 'deleteProduct', 'createCategory', 'createChild'];

async function createServer(opts = {}) {
  const db = opts.db || await openDatabase(opts.dbPath || null);
  if (opts.seed !== false) seedPlatform(db); // demo: superadmin zuki/zuki123 + 2 escuelas
  // Producción: superadministrador desde variables de entorno (debe cambiar la contraseña al entrar)
  if (opts.bootstrapSuperadmin && !db.get("SELECT id FROM users WHERE role = 'superadmin'")) {
    const { username, password } = opts.bootstrapSuperadmin;
    if (!password || password.length < 8) throw new Error('SUPERADMIN_PASSWORD debe tener al menos 8 caracteres');
    // La contraseña inicial viene de la variable de entorno (la eligió el dueño): no se obliga a cambiarla
    // salvo que se pida con SUPERADMIN_FORCE_CHANGE=1.
    ensureSuperadmin(db, { username: username || 'zuki', password, mustChange: !!opts.bootstrapSuperadmin.forceChange });
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
  const sync = createSyncServer(db, { legacySync: opts.legacySync !== undefined ? !!opts.legacySync : process.env.LEGACY_SYNC === '1' });
  const persistence = opts.persistence || (() => ({ mode: opts.dbPath ? 'archivo' : 'memoria' }));
  const security = createSecurity(db, { svc, sync, persistence });
  sync.hooks.onRecharge = (id) => security.inspectRecharge(id);
  // Mensualidad por escuela (avisos, tolerancia y pausa automática)
  const billing = createBilling(db, { security, now: opts.now });
  sync.hooks.checkSchool = (sid) => billing.evaluate(sid);
  // Recuperación de emergencia del superadministrador (SUPERADMIN_RESET_PASSWORD)
  if (opts.superadminReset && opts.superadminReset.password) {
    const r = security.emergencyReset(opts.superadminReset);
    if (r && r.applied) console.warn(`[auth] Contraseña del superadministrador "${r.username}" restablecida con SUPERADMIN_RESET_PASSWORD. Quite la variable cuando ya haya entrado.`);
  }
  const auth = createAuth(db, svc, { jwtSecret: secret, mailer: opts.mailer || consoleMailer(), appUrl: opts.appUrl || process.env.APP_URL, onChildLinked: (id) => sync.recordChild('child_link', id), security, billing, ...(opts.authOptions || {}) });

  const platform = createPlatform(db, { svc, sync, auth, security, billing });
  // Revisión periódica de mensualidades (alertas y pausas aunque nadie entre). También al arrancar.
  try { billing.sweep(); } catch (e) { console.error('[mensualidad]', e); }
  const sweepMs = opts.billingSweepMs === undefined ? 15 * 60 * 1000 : opts.billingSweepMs;
  if (sweepMs > 0) { const t = setInterval(() => { try { billing.sweep(); } catch (e) { console.error('[mensualidad]', e); } }, sweepMs); if (t.unref) t.unref(); }
  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy || process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use('/api/sync/push', express.json({ limit: '25mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    // Los datos nunca se guardan en caché (ni navegador ni service worker): siempre al día
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  const STATUS = { BLOQUEADO_SEGURIDAD: 423, SISTEMA_BLOQUEADO: 403, OTRO_EQUIPO_PRINCIPAL: 409, REFERENCIA_FALTANTE: 409, SOLO_ESCRITORIO: 409, NO_AUTENTICADO: 401, PROHIBIDO: 403, DEBE_CAMBIAR_PASSWORD: 403, NO_ENCONTRADO: 404, ESCUELA_SUSPENDIDA: 403, ESCUELA_PAUSADA: 403, VERSION_OBSOLETA: 410, DUPLICADO: 409, CONFLICTO: 409, VALIDACION: 400, LIMITE_INTENTOS: 429, INTERNO: 500 };
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
  app.get('/api/health', (req, res) => res.json({ ok: true, data: { status: 'ok', time: new Date().toISOString(), persistence: persistence().mode } }));

  // ----- autenticación -----
  app.post('/api/auth/login', (req, res) => send(res, () => auth.login(req.body.identifier || req.body.username, req.body.password, ctx(req))));
  app.post('/api/auth/refresh', (req, res) => send(res, () => auth.refresh(req.body.refresh_token, ctx(req))));
  app.post('/api/auth/logout', (req, res) => send(res, () => auth.logout(req.body.refresh_token)));
  app.post('/api/auth/logout-all', authenticate({ allowMustChange: true }), (req, res) => send(res, () => auth.logoutAll(req.user)));
  app.get('/api/auth/me', authenticate({ allowMustChange: true }), (req, res) => send(res, () => req.user));
  // Solo el superadministrador cambia su propia contraseña aquí; las demás cuentas no pueden (política).
  app.post('/api/auth/change-password', authenticate({ allowMustChange: true }), (req, res) => send(res, () => {
    if (req.user.role !== 'superadmin') {
      security.audit(req.user, 'cambio_contrasena_rechazado', { ip: req.ip, severity: 'aviso' });
      throw Object.assign(new Error('Solo el administrador de la plataforma (Zuki Company) puede cambiar contraseñas. Pídeselo a él.'), { code: 'PROHIBIDO' });
    }
    const r = auth.changePassword(req.user, req.body.current, req.body.next, ctx(req));
    security.audit(req.user, 'contrasena_propia', { ip: req.ip, target_type: 'user', target_id: req.user.id, severity: 'aviso' });
    return r;
  }));
  app.post('/api/auth/forgot', (req, res) => send(res, () => auth.requestPasswordReset(req.body.identifier, ctx(req))));
  app.post('/api/auth/reset', (req, res) => send(res, () => auth.resetPassword(req.body.token, req.body.password)));
  app.post('/api/auth/register', (req, res) => send(res, () => auth.registerWithInvitation(req.body || {}, ctx(req))));
  app.post('/api/auth/redeem', authenticate(), requireRole('tutor'), (req, res) => send(res, () => auth.redeemInvitation(req.user, req.body.code)));

  // ----- administración de cuentas -----
  app.post('/api/admin/tutors', authenticate(), requireRole('admin'), (req, res) => send(res, () => auth.createTutorAccount(req.user, req.body || {})));
  app.post('/api/admin/invitations', authenticate(), requireRole('admin'), (req, res) => send(res, () => auth.createInvitation(req.user, req.body.child_id, { reuse: !!req.body.reuse })));
  app.get('/api/admin/invitations', authenticate(), requireRole('admin'), (req, res) => send(res, () => auth.listInvitations(req.user)));
  // Hoja de códigos para padres (Programar tarjetas → paso 3), en línea desde la web o la caja de escritorio
  app.post('/api/admin/invitation-sheet', authenticate(), requireRole('admin'), (req, res) => send(res, () => {
    const sid = Number(req.user.school_id) || -1;
    const ids = Array.isArray(req.body && req.body.child_ids) ? req.body.child_ids.map(Number).filter((n) => n > 0).slice(0, 500) : [];
    const rows = ids.map((id) => db.get('SELECT id, uuid FROM children WHERE id = ? AND school_id = ?', [id, sid])).filter(Boolean);
    const byUuid = new Map(rows.map((r) => [r.uuid, r.id]));
    const codes = auth.invitationsForSchool(sid, rows.map((r) => r.uuid), { reuse: true, skipLinked: !(req.body && req.body.include_linked) })
      .map((c) => ({ ...c, child_id: byUuid.get(c.child_uuid) }));
    const sc = db.get('SELECT name FROM schools WHERE id = ?', [sid]) || {};
    return { codes, school_name: sc.name || null };
  }));

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
    const f = security.flagsFor(req.device.school_id);
    return { device_id: req.device.id, device_name: req.device.name, primary_device: p, is_primary: !p || p === req.device.id, school_uuid: sc.uuid, school_name: sc.name, school_status: sc.status,
      billing: billing.noticeFor({ role: 'admin', school_id: req.device.school_id }),
      security: { lockdown: f.lockdown, freeze_recharges: f.freeze_recharges, freeze_sales: f.freeze_sales, read_only: f.read_only, daily_recharge_limit_cents: f.daily_recharge_limit_cents } };
  }));
  // Códigos de invitación para la hoja que imprime la caja (alumnos ya sincronizados de su escuela)
  app.post('/api/sync/invitations', deviceAuth, (req, res) => send(res, () => auth.invitationsForSchool(req.device.school_id, (req.body || {}).child_uuids, { reuse: true, skipLinked: (req.body || {}).include_linked ? false : true })));

  // ----- panel del superadministrador (Zuki Company) -----
  app.post('/api/super/:method', authenticate(), requireRole('superadmin'), (req, res) => send(res, () => platform.handle(req.user, req.params.method, req.body || {}, ctx(req))));
  // Respaldo descargable de toda la base (archivo SQLite)
  app.get('/api/super-backup', authenticate(), requireRole('superadmin'), (req, res) => {
    const buf = security.backup(req.user, ctx(req));
    const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="respaldo-cooperativa-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.db"`, 'Cache-Control': 'no-store' });
    res.send(buf);
  });

  // ----- lógica de negocio (misma que el escritorio). Permisos validados en el servicio -----
  // Operaciones que quedan en la bitácora (quién, cuándo, IP, qué)
  const AUDIT_RPC = { recharge: 'recarga', adjust: 'ajuste', deleteProduct: 'producto_borrado', createUser: 'usuario_creado', updateUser: 'usuario_editado', setCardStatus: 'tarjeta_estado', reportLostAndReplace: 'tarjeta_perdida', registerCard: 'tarjeta_registrada', assignCard: 'tarjeta_asignada', assignCardByUid: 'tarjeta_asignada', unassignCard: 'tarjeta_quitada', updateProduct: 'producto_editado', createProduct: 'producto_creado', createChild: 'alumno_creado' };
  const SEVERITY = { recharge: 'info', adjust: 'aviso', deleteProduct: 'aviso', reportLostAndReplace: 'aviso' };
  app.post('/api/rpc/:method', authenticate(), (req, res) => {
    const method = req.params.method;
    if (['login', 'logout', 'me'].includes(method)) return res.status(400).json({ ok: false, error: 'Usa /api/auth/*', code: 'VALIDACION' });
    if (method === 'securityStatus') return res.json({ ok: true, data: { ...security.statusFor(req.user), billing: billing.noticeFor(req.user) } });
    if (method === 'changePassword') return res.status(403).json({ ok: false, error: 'Solo el administrador de la plataforma (Zuki Company) puede cambiar contraseñas.', code: 'PROHIBIDO' });
    if (req.user.role === 'superadmin') return res.status(403).json({ ok: false, error: 'El superadministrador usa el panel de instituciones', code: 'PROHIBIDO' });
    if (DESKTOP_OWNED.includes(method) && ['admin', 'cajero'].includes(req.user.role) && sync.isSynced(req.user.school_id)) {
      return res.status(409).json({ ok: false, error: 'Este servidor está sincronizado con la caja de escritorio: ventas, recargas, tarjetas, alumnos y productos se registran en la caja.', code: 'SOLO_ESCRITORIO' });
    }
    const args = req.body || {};
    try { security.guard(req.user, method, args, ctx(req)); } catch (e) { return res.status(STATUS[e.code] || 423).json({ ok: false, error: e.message, code: e.code }); }
    const prevTutor = method === 'updateChild' && args.id ? (db.get('SELECT tutor_id FROM children WHERE id = ?', [Number(args.id)]) || {}).tutor_id : undefined;
    const prevProduct = method === 'updateProduct' && args.id ? db.get('SELECT name, price_cents, active FROM products WHERE id = ?', [Number(args.id)]) : null;
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
      try {
        // Solicitudes de cambio de datos del alumno (tutor → escuela)
        if (method === 'requestChildChange') {
          const q = r.data;
          security.audit(req.user, 'solicitud_cambio_datos', { school_id: q.school_id, ip: req.ip, target_type: 'child', target_id: q.child_id, details: { solicitud: q.id, alumno: q.child_name, dato: q.field_label, valor_actual: q.old_value, valor_nuevo: q.new_value, motivo: q.comment } });
        } else if (method === 'resolveChangeRequest') {
          const q = r.data.request;
          if (r.data.applied) sync.recordChild('child_profile', Number(q.child_id));
          security.audit(req.user, q.status === 'aprobada' ? 'solicitud_cambio_aprobada' : 'solicitud_cambio_rechazada', { ip: req.ip, target_type: 'child', target_id: q.child_id,
            details: { solicitud: q.id, alumno: q.child_name, tutor: q.tutor_name, dato: q.field_label, valor_nuevo: q.new_value, aplicado: r.data.applied || null, motivo_rechazo: q.reject_reason || undefined }, severity: q.status === 'aprobada' && r.data.applied ? 'aviso' : 'info' });
        }
        if (AUDIT_RPC[method] && !(method === 'updateProduct' && prevProduct && prevProduct.price_cents === r.data.price_cents && prevProduct.name === r.data.name && !!prevProduct.active === !!r.data.active)) {
          const det = { ...args };
          if (method === 'recharge' || method === 'adjust') { det.saldo_nuevo = r.data.balance_cents; det.transaccion = r.data.transaction_id; }
          if (method === 'deleteProduct' && r.data.product) det.producto = r.data.product.name;
          if (method === 'updateProduct' && prevProduct) det.antes = prevProduct;
          security.audit(req.user, AUDIT_RPC[method], { ip: req.ip, target_type: method.includes('Product') ? 'product' : (method.includes('User') ? 'user' : (method === 'recharge' || method === 'adjust' ? 'transaction' : 'card')), target_id: (r.data && (r.data.transaction_id || r.data.id)) || args.id || args.card_id || null, details: det, severity: SEVERITY[method] || 'info' });
        }
        if (method === 'deleteProduct') security.alert({ school_id: req.user.school_id, kind: 'borrado', severity: 'baja', message: `${req.user.full_name} envió a la papelera el producto "${r.data.product ? r.data.product.name : args.id}".`, ref_type: 'product', ref_id: Number(args.id) });
        if (method === 'recharge' && r.data.transaction_id) security.inspectRecharge(r.data.transaction_id);
      } catch (e) { console.error('[seguridad]', e); }
      return res.json(r);
    }
    // Tutor que intenta cambiar nombre o grado/grupo (solo los cambia la escuela): queda en la bitácora
    if (method === 'updateChild' && req.user.role === 'tutor' && r.code === 'PROHIBIDO') {
      try {
        const ch = db.get('SELECT school_id FROM children WHERE id = ?', [Number(args.id) || 0]) || {};
        security.audit(req.user, 'edicion_alumno_rechazada', { school_id: ch.school_id || null, ip: req.ip, target_type: 'child', target_id: args.id || null, details: { full_name: args.full_name, grade: args.grade }, severity: 'aviso' });
      } catch (e) { console.error('[seguridad]', e); }
    }
    return res.status(STATUS[r.code] || 400).json(r);
  });

  // ----- PWA -----
  const renderer = path.join(__dirname, '..', 'src', 'renderer');
  // iOS/Safari pide estas rutas por convención aunque el HTML declare otro ícono; si no existen
  // muestra un ícono genérico al "Agregar a inicio".
  app.get(['/apple-touch-icon-precomposed.png', '/apple-touch-icon-180x180.png', '/apple-touch-icon-180x180-precomposed.png'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'apple-touch-icon.png')));
  app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    setHeaders: (res, file) => {
      if (/\.webmanifest$/.test(file)) res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      // el service worker y el HTML siempre se revalidan para que los clientes reciban cambios
      if (/(sw\.js|\.html)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.use(express.static(renderer, { index: false }));
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada', code: 'NO_ENCONTRADO' }));

  return { app, db, svc, auth, sync, platform, billing, security };
}
module.exports = { createServer };
