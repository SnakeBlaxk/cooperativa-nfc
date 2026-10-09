'use strict';
// Persistencia del servidor. La base vive en memoria (sql.js) y se guarda en un archivo (DB_PATH).
// En Render gratis ese archivo se borra al reiniciar, así que hay dos formas de no perder datos:
//   1) Disco persistente de Render (plan Starter + disco): DB_PATH=/var/data/servidor.db  → modo "disco".
//   2) Turso (libSQL, nivel gratis): TURSO_DATABASE_URL + TURSO_AUTH_TOKEN → modo "turso".
//      Se guarda una copia comprimida de la base completa en Turso unos segundos después de cada cambio
//      y al apagar; al arrancar se descarga la última copia. Solo usa fetch (sin dependencias nuevas).
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');

const CHUNK_CHARS = 600000; // ~600 KB de texto base64 por fila

function tursoClient({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
  const base = String(url || '').trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('TURSO_DATABASE_URL inválida (ej. libsql://mi-base-usuario.turso.io)');
  const arg = (v) => (v === null || v === undefined ? { type: 'null' } : (typeof v === 'number' ? { type: 'integer', value: String(v) } : { type: 'text', value: String(v) }));
  async function pipeline(stmts) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(base + '/v2/pipeline', {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [...stmts.map(([sql, args]) => ({ type: 'execute', stmt: { sql, args: (args || []).map(arg) } })), { type: 'close' }] }),
      });
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error(`Turso respondió ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const j = await res.json();
    return j.results.slice(0, stmts.length).map((r) => {
      if (r.type !== 'ok') throw new Error('Turso: ' + ((r.error && r.error.message) || 'error'));
      const x = r.response.result; const cols = x.cols.map((c) => c.name);
      return x.rows.map((row) => Object.fromEntries(row.map((v, i) => [cols[i], v.type === 'null' ? null : (v.type === 'integer' ? Number(v.value) : v.value)])));
    });
  }
  return { pipeline };
}

function createTursoStore(opts) {
  const c = tursoClient(opts);
  const init = () => c.pipeline([
    ['CREATE TABLE IF NOT EXISTS coop_snapshot_chunks (gen TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (gen, idx))'],
    ['CREATE TABLE IF NOT EXISTS coop_snapshot_head (id INTEGER PRIMARY KEY CHECK (id = 1), gen TEXT NOT NULL, prev_gen TEXT, chunks INTEGER NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, saved_at TEXT NOT NULL)'],
  ]);
  async function readGen(gen, chunks, sha) {
    const [rows] = await c.pipeline([['SELECT idx, data FROM coop_snapshot_chunks WHERE gen = ? ORDER BY idx', [gen]]]);
    if (rows.length !== chunks) throw new Error('copia incompleta');
    const gz = Buffer.from(rows.map((r) => r.data).join(''), 'base64');
    const buf = zlib.gunzipSync(gz);
    if (crypto.createHash('sha256').update(buf).digest('hex') !== sha) throw new Error('copia dañada (sha256)');
    return buf;
  }
  return {
    mode: 'turso',
    async load() {
      await init();
      const [[head]] = await c.pipeline([['SELECT gen, prev_gen, chunks, bytes, sha256, saved_at FROM coop_snapshot_head WHERE id = 1']]);
      if (!head) return null;
      try { return await readGen(head.gen, head.chunks, head.sha256); } catch (e) {
        console.error('[persistencia] La última copia en Turso no se pudo leer:', e.message);
        if (!head.prev_gen) throw e;
        const [[prev]] = await c.pipeline([['SELECT COUNT(*) AS n FROM coop_snapshot_chunks WHERE gen = ?', [head.prev_gen]]]);
        throw new Error(`Copia de Turso dañada (hay una anterior: ${head.prev_gen}, ${prev ? prev.n : 0} partes). Revise manualmente.`);
      }
    },
    async save(buf) {
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      const b64 = zlib.gzipSync(buf, { level: 6 }).toString('base64');
      const parts = []; for (let i = 0; i < b64.length; i += CHUNK_CHARS) parts.push(b64.slice(i, i + CHUNK_CHARS));
      const gen = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + crypto.randomBytes(3).toString('hex');
      for (let i = 0; i < parts.length; i += 4) {
        await c.pipeline(parts.slice(i, i + 4).map((d, k) => ['INSERT INTO coop_snapshot_chunks (gen, idx, data) VALUES (?, ?, ?)', [gen, i + k, d]]));
      }
      const [[head]] = await c.pipeline([['SELECT gen FROM coop_snapshot_head WHERE id = 1']]);
      const prev = head ? head.gen : null;
      await c.pipeline([
        ['INSERT INTO coop_snapshot_head (id, gen, prev_gen, chunks, bytes, sha256, saved_at) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET gen = excluded.gen, prev_gen = excluded.prev_gen, chunks = excluded.chunks, bytes = excluded.bytes, sha256 = excluded.sha256, saved_at = excluded.saved_at',
          [gen, prev, parts.length, buf.length, sha, new Date().toISOString()]],
        // Se conservan la copia nueva y la anterior (por si una se daña)
        ['DELETE FROM coop_snapshot_chunks WHERE gen <> ? AND gen IS NOT ?', [gen, prev]],
      ]);
      return { gen, bytes: buf.length, chunks: parts.length };
    },
  };
}

// Sube la base a la tienda remota unos segundos después de cada cambio (agrupa ráfagas) y al apagar.
function createReplicator(db, store, { debounceMs = 3000, maxWaitMs = 15000, log = console } = {}) {
  let timer = null; let firstDirty = 0; let running = null; let dirty = false;
  const state = { last_ok_at: null, last_error: null, last_bytes: 0, uploads: 0 };
  async function flush() {
    if (running) { dirty = true; return running; }
    clearTimeout(timer); timer = null; dirty = false; firstDirty = 0;
    running = (async () => {
      try { const r = await store.save(db.exportBuffer()); state.last_ok_at = new Date().toISOString(); state.last_error = null; state.last_bytes = r.bytes; state.uploads++; } catch (e) {
        state.last_error = e.message; log.error('[persistencia] No se pudo guardar la copia remota:', e.message);
        dirty = true; // reintento
      }
    })().finally(() => { running = null; if (dirty) schedule(); });
    return running;
  }
  function schedule() {
    dirty = true;
    const now = Date.now(); if (!firstDirty) firstDirty = now;
    clearTimeout(timer);
    timer = setTimeout(flush, now - firstDirty >= maxWaitMs ? 0 : debounceMs);
    if (timer.unref) timer.unref();
  }
  db.onSave(schedule);
  return { flush, schedule, state, pending: () => dirty || !!running };
}

// Copias diarias en archivo (modo disco): una por día, se conservan las últimas `keep`.
function dailyFileBackups(db, dir, { keep = 14 } = {}) {
  const run = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const d = new Date(); const p = (n) => String(n).padStart(2, '0');
      const f = path.join(dir, `servidor-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.db`);
      if (!fs.existsSync(f)) fs.writeFileSync(f, db.exportBuffer());
      const all = fs.readdirSync(dir).filter((x) => /^servidor-\d{4}-\d{2}-\d{2}\.db$/.test(x)).sort();
      for (const x of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, x));
    } catch (e) { console.error('[respaldo] No se pudo crear la copia diaria:', e.message); }
  };
  run();
  const t = setInterval(run, 6 * 3600 * 1000); if (t.unref) t.unref();
  return run;
}

// Decide el modo según las variables de entorno
function persistenceMode(env, dbPath) {
  if (env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN) return 'turso';
  const tmp = [os.tmpdir(), '/tmp'].map((x) => path.resolve(x));
  if (tmp.some((t) => path.resolve(dbPath).startsWith(t + path.sep))) return 'temporal';
  return 'disco';
}

module.exports = { createTursoStore, tursoClient, createReplicator, dailyFileBackups, persistenceMode };
