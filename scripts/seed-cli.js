'use strict';
// Uso: node scripts/seed-cli.js [ruta.db]  — crea una base con datos demo (útil para desarrollo).
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('../src/core/db');
const { seed } = require('../src/core/seed');
(async () => {
  const file = path.resolve(process.argv[2] || 'cooperativa-demo.db');
  if (fs.existsSync(file)) { console.error('Ya existe', file, '- bórrala primero si quieres regenerarla.'); process.exit(1); }
  const db = await openDatabase(file);
  seed(db);
  console.log('Base demo creada en', file);
})();
