'use strict';
// Uso: npm run server
// Variables: PORT, DB_PATH, JWT_SECRET, APP_URL, TRUST_PROXY, NODE_ENV, SEED, TZ (por defecto America/Mexico_City),
//            SUPERADMIN_USER, SUPERADMIN_PASSWORD (dueño de la plataforma; se crea si no existe),
//            SUPERADMIN_FORCE_CHANGE=1 (obliga a cambiarla al entrar), SUPERADMIN_RESET_PASSWORD (recuperación de emergencia),
//            ADMIN_USER, ADMIN_PASSWORD, SCHOOL_NAME (primera escuela, opcional),
//            TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (persistencia gratis en Turso), BACKUP_DIR (copias diarias en modo disco),
//            LEGACY_SYNC=1 (solo para migrar cajas 1.x: acepta temporalmente su envío de ventas sin conexión)
process.env.TZ = process.env.TZ || 'America/Mexico_City'; // horas de la escuela (México), también en Render
const path = require('path');
const fs = require('fs');
const { createServer } = require('./app');
const { createTursoStore, createReplicator, dailyFileBackups, persistenceMode } = require('./persist');
const { openDatabase } = require('../src/core/db');

(async () => {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'servidor.db');
  const prod = process.env.NODE_ENV === 'production';
  const mode = persistenceMode(process.env, dbPath);
  let store = null; let replicator = null;
  // Turso: descargar la última copia antes de abrir la base
  if (mode === 'turso') {
    store = createTursoStore({ url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN });
    const buf = await store.load();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (buf) { fs.writeFileSync(dbPath, buf); console.log(`[persistencia] Base restaurada desde Turso (${buf.length} bytes).`); } else console.log('[persistencia] Turso vacío: se crea una base nueva.');
  } else if (mode === 'temporal') {
    console.warn('[persistencia] ATENCIÓN: la base está en una carpeta temporal; los datos se borran al reiniciar. Configure Turso o un disco persistente (ver README).');
  }
  const db = await openDatabase(dbPath);
  // Datos demo solo en desarrollo (o con SEED=1). En producción: SUPERADMIN_USER/SUPERADMIN_PASSWORD.
  const seedDemo = process.env.SEED ? process.env.SEED === '1' : !prod;
  if (prod && !seedDemo && !process.env.SUPERADMIN_PASSWORD) console.warn('[auth] Define SUPERADMIN_PASSWORD para crear la cuenta del superadministrador.');
  const bootstrapSuperadmin = process.env.SUPERADMIN_PASSWORD ? { username: process.env.SUPERADMIN_USER || 'zuki', password: process.env.SUPERADMIN_PASSWORD, forceChange: process.env.SUPERADMIN_FORCE_CHANGE === '1' } : null;
  const superadminReset = process.env.SUPERADMIN_RESET_PASSWORD ? { username: process.env.SUPERADMIN_USER || null, password: process.env.SUPERADMIN_RESET_PASSWORD } : null;
  const bootstrapAdmin = process.env.ADMIN_PASSWORD ? { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD } : null;
  if (store) replicator = createReplicator(db, store);
  const persistence = () => ({ mode, ...(replicator ? { last_ok_at: replicator.state.last_ok_at, last_error: replicator.state.last_error, bytes: replicator.state.last_bytes } : {}) });
  const { app } = await createServer({ db, dbPath, seed: seedDemo, bootstrapSuperadmin, superadminReset, bootstrapAdmin, bootstrapSchoolName: process.env.SCHOOL_NAME, persistence });
  if (replicator) await replicator.flush(); // primera copia (incluye lo creado al arrancar)
  if (mode === 'disco') dailyFileBackups(db, process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'respaldos'));
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => console.log(`Servidor Zuki Pay en http://localhost:${port}  (base: ${dbPath}, persistencia: ${mode})`));
  // Al apagar (Render envía SIGTERM al reiniciar o dormir) se sube la última copia
  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return; closing = true;
    console.log(`[servidor] ${sig}: guardando y cerrando…`);
    server.close();
    try { if (replicator) await Promise.race([replicator.flush(), new Promise((r) => setTimeout(r, 20000))]); } catch (_) { /* ya registrado */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})().catch((e) => { console.error(e); process.exit(1); });
