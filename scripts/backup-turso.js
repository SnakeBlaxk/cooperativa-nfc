'use strict';
// Respaldo de la base de Zuki Pay guardada en Turso.
// Uso: TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/backup-turso.js [carpeta]
// Genera en la carpeta (por defecto ./respaldo):
//   zukipay-<fecha>.db       base SQLite completa (la misma copia que usa el servidor)
//   zukipay-<fecha>.json     todas las tablas en JSON (para consultar sin SQLite)
//   zukipay-<fecha>.sql      volcado SQL (CREATE + INSERT)
//   manifest.json            fecha, sha256, filas por tabla
// No imprime credenciales.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const { createTursoStore } = require('../server/persist');

function q(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (v instanceof Uint8Array) return "X'" + Buffer.from(v).toString('hex') + "'";
  return "'" + String(v).replace(/'/g, "''") + "'";
}

async function exportBuffer(buf, outDir, stamp) {
  const SQL = await initSqlJs({ wasmBinary: fs.readFileSync(path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')) });
  const db = new SQL.Database(buf);
  const tables = db.exec("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")[0];
  const json = {}; const counts = {}; const sql = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
  for (const [name, ddl] of (tables ? tables.values : [])) {
    sql.push(ddl + ';');
    const r = db.exec(`SELECT * FROM "${name}"`)[0];
    const rows = r ? r.values.map((row) => Object.fromEntries(row.map((v, i) => [r.columns[i], v instanceof Uint8Array ? { hex: Buffer.from(v).toString('hex') } : v]))) : [];
    json[name] = rows; counts[name] = rows.length;
    if (r) for (const row of r.values) sql.push(`INSERT INTO "${name}" (${r.columns.map((c) => `"${c}"`).join(',')}) VALUES (${row.map(q).join(',')});`);
  }
  const idx = db.exec("SELECT sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL")[0];
  if (idx) for (const [s] of idx.values) sql.push(s + ';');
  sql.push('COMMIT;');
  db.close();
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, `zukipay-${stamp}`);
  fs.writeFileSync(base + '.db', buf);
  fs.writeFileSync(base + '.json', JSON.stringify(json));
  fs.writeFileSync(base + '.sql', sql.join('\n') + '\n');
  const manifest = { created_at: new Date().toISOString(), bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), tables: counts };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

async function main() {
  const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token } = process.env;
  if (!url || !token) { console.error('Faltan TURSO_DATABASE_URL y/o TURSO_AUTH_TOKEN.'); process.exit(2); }
  const buf = await createTursoStore({ url, token, timeoutMs: 60000 }).load(); // verifica sha256
  if (!buf) { console.error('Turso no tiene ninguna copia guardada.'); process.exit(3); }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const m = await exportBuffer(Buffer.from(buf), process.argv[2] || 'respaldo', stamp);
  console.log(`Respaldo listo: ${m.bytes} bytes, ${Object.keys(m.tables).length} tablas, sha256 ${m.sha256.slice(0, 12)}…`);
}
if (require.main === module) main().catch((e) => { console.error('Error en el respaldo:', e.message); process.exit(1); });
module.exports = { exportBuffer };
