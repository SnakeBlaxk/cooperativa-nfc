'use strict';
// Restaura un respaldo (.db) en Turso como la copia vigente.
// Uso: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/restore-turso.js respaldo/zukipay-XXXX.db --si
// IMPORTANTE: suspenda el servicio en Render antes (si sigue encendido sobrescribirá la copia
// con su base en memoria) y vuelva a encenderlo después: al arrancar descargará esta copia.
// La copia anterior no se borra: queda como "prev_gen" en Turso.
const fs = require('fs');
const initSqlJs = require('sql.js');
const path = require('path');
const { createTursoStore } = require('../server/persist');

async function main() {
  const file = process.argv[2]; const yes = process.argv.includes('--si');
  if (!file || !fs.existsSync(file)) { console.error('Indique el archivo .db del respaldo.'); process.exit(2); }
  const buf = fs.readFileSync(file);
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')) });
  const db = new SQL.Database(buf); // valida que sea una base SQLite
  const n = db.exec("SELECT COUNT(*) FROM sqlite_master WHERE type='table'")[0].values[0][0]; db.close();
  console.log(`Respaldo válido: ${buf.length} bytes, ${n} tablas.`);
  if (!yes) { console.log('Agregue --si para subirlo a Turso (reemplaza la copia vigente).'); return; }
  const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token } = process.env;
  if (!url || !token) { console.error('Faltan TURSO_DATABASE_URL y/o TURSO_AUTH_TOKEN.'); process.exit(2); }
  const store = createTursoStore({ url, token, timeoutMs: 60000 });
  await store.load().catch(() => null); // crea tablas si faltan
  await store.save(buf);
  console.log('Restaurado en Turso. Encienda (o reinicie) el servicio en Render.');
}
main().catch((e) => { console.error('Error al restaurar:', e.message); process.exit(1); });
