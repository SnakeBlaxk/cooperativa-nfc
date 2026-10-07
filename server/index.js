'use strict';
// Uso: npm run server
// Variables: PORT, DB_PATH, JWT_SECRET, APP_URL, TRUST_PROXY, NODE_ENV, SEED,
//            SUPERADMIN_USER, SUPERADMIN_PASSWORD (dueño de la plataforma), ADMIN_USER, ADMIN_PASSWORD, SCHOOL_NAME (primera escuela, opcional)
const path = require('path');
const { createServer } = require('./app');
(async () => {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'servidor.db');
  const prod = process.env.NODE_ENV === 'production';
  // Datos demo solo en desarrollo (o con SEED=1). En producción: SUPERADMIN_USER/SUPERADMIN_PASSWORD.
  const seedDemo = process.env.SEED ? process.env.SEED === '1' : !prod;
  if (prod && !seedDemo && !process.env.SUPERADMIN_PASSWORD) console.warn('[auth] Define SUPERADMIN_PASSWORD para crear la cuenta del superadministrador.');
  const bootstrapSuperadmin = process.env.SUPERADMIN_PASSWORD ? { username: process.env.SUPERADMIN_USER || 'zuki', password: process.env.SUPERADMIN_PASSWORD } : null;
  const bootstrapAdmin = process.env.ADMIN_PASSWORD ? { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD } : null;
  const { app } = await createServer({ dbPath, seed: seedDemo, bootstrapSuperadmin, bootstrapAdmin, bootstrapSchoolName: process.env.SCHOOL_NAME });
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Servidor Cooperativa NFC en http://localhost:${port}  (base: ${dbPath})`));
})().catch((e) => { console.error(e); process.exit(1); });
