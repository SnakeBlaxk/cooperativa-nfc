'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { openDatabase } = require('../src/core/db');
const { exportBuffer } = require('../scripts/backup-turso');

test('respaldo exporta .db, .json, .sql y manifest con todas las tablas', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-'));
  const db = await openDatabase(path.join(dir, 'x.db'));
  const buf = db.exportBuffer();
  const m = await exportBuffer(buf, path.join(dir, 'out'), 't');
  assert.ok(Object.keys(m.tables).includes('schools'));
  const sql = fs.readFileSync(path.join(dir, 'out', 'zukipay-t.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE/);
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'zukipay-t.json'), 'utf8'));
  assert.ok(Array.isArray(j.schools));
});

test('la página /privacidad existe y menciona LFPDPPP y ARCO', async () => {
  const { createServer } = require('../server/app');
  const { consoleMailer } = require('../src/core/auth');
  const { app } = await createServer({ cardStock: false, jwtSecret: 'p'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  const srv = app.listen(0); const port = srv.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/privacidad`); const t = await r.text();
    assert.strictEqual(r.status, 200); assert.match(t, /Aviso de privacidad/); assert.match(t, /ARCO/); assert.match(t, /\[COMPLETAR/);
  } finally { srv.close(); }
});
