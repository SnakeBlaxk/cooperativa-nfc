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

const { openDatabase } = require('../src/core/db');

const DAILY_NAME = /^servidor-\d{4}-\d{2}-\d{2}\.db$/;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return { day: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, hm: `${p(d.getHours())}${p(d.getMinutes())}` };
}

function writeAtomic(file, buf) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

function encodePath(p) {
  return String(p).split('/').map((s) => encodeURIComponent(s)).join('/');
}

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

function amzDate(d) { return d.toISOString().replace(/[:-]|\.\d{3}/g, ''); }

// Firma AWS SigV4 para subir un objeto (Backblaze B2, Amazon S3 u otro compatible).
function signS3Put({ url, body, region, accessKey, secretKey, now = new Date() }) {
  const u = new URL(url);
  const payloadHash = sha256(body);
  const date = amzDate(now);
  const day = date.slice(0, 8);
  const signed = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonHeaders = `content-type:application/octet-stream\nhost:${u.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
  const canon = ['PUT', encodePath(u.pathname), '', canonHeaders, signed, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', date, scope, sha256(canon)].join('\n');
  let k = hmac('AWS4' + secretKey, day);
  k = hmac(k, region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const sig = hmac(k, sts).toString('hex');
  return {
    Host: u.host,
    'Content-Type': 'application/octet-stream',
    'x-amz-date': date,
    'x-amz-content-sha256': payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed}, Signature=${sig}`,
  };
}

function s3TargetFromEnv(env = process.env) {
  const endpoint = env.BACKUP_S3_ENDPOINT;
  const bucket = env.BACKUP_S3_BUCKET;
  const accessKey = env.BACKUP_S3_ACCESS_KEY_ID;
  const secretKey = env.BACKUP_S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey) return null;
  let prefix = String(env.BACKUP_S3_PREFIX || 'zuki-pay/').replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return {
    endpoint: String(endpoint).trim().replace(/\/+$/, ''),
    bucket: String(bucket).trim(),
    region: env.BACKUP_S3_REGION || 'us-east-1',
    accessKey, secretKey, prefix,
    timeoutMs: Number(env.BACKUP_S3_TIMEOUT_MS) || 20000,
  };
}

function createS3Uploader(cfg, fetchImpl = globalThis.fetch) {
  return {
    bucket: cfg.bucket,
    async put(name, buf) {
      const key = cfg.prefix + name;
      const url = `${cfg.endpoint}/${encodePath(cfg.bucket + '/' + key)}`;
      const headers = signS3Put({ url, body: buf, region: cfg.region, accessKey: cfg.accessKey, secretKey: cfg.secretKey });
      delete headers.Host; // lo pone el cliente HTTP; ya quedó dentro de la firma
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs || 20000);
      let res;
      try {
        res = await fetchImpl(url, { method: 'PUT', headers, body: buf, signal: ctrl.signal });
      } finally { clearTimeout(timer); }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`la nube respondió ${res.status} ${String(text).slice(0, 180)}`);
      }
    },
  };
}

// Abre la copia en un archivo temporal y cuenta filas. No modifica el respaldo guardado.
async function verifySqliteBackup(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16 || buf.toString('utf8', 0, 15) !== 'SQLite format 3') {
    return { ok: false, error: 'el archivo no es una base SQLite' };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-respaldo-'));
  const file = path.join(dir, 'copia.db');
  try {
    fs.writeFileSync(file, buf);
    const copy = await openDatabase(file);
    try {
      const n = (sql) => copy.get(sql).n;
      return { ok: true, users: n('SELECT COUNT(*) AS n FROM users'), schools: n('SELECT COUNT(*) AS n FROM schools'), transactions: n('SELECT COUNT(*) AS n FROM transactions') };
    } finally { copy.close(); }
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function pruneBackups(dir, keep) {
  const all = fs.readdirSync(dir).filter((x) => DAILY_NAME.test(x)).sort();
  for (const x of all.slice(0, Math.max(0, all.length - keep))) fs.unlinkSync(path.join(dir, x));
  return all.length;
}

// Copia local (todos los modos) y, si hay credenciales, subida a S3/Backblaze. Cada copia se abre para comprobar que no está dañada.
function createBackupService(db, { dir, keep = 14, remote = null, fetchImpl, everyMs = 6 * 3600 * 1000, autostart = true, log = console } = {}) {
  if (!dir) throw new Error('Falta la carpeta de respaldos');
  const uploader = remote ? createS3Uploader(remote, fetchImpl) : null;
  const state = {
    dir, last_at: null, last_file: null, verified: null, verify_error: null,
    users: null, schools: null, transactions: null,
    remote: uploader ? 's3' : null, remote_bucket: uploader ? remote.bucket : null,
    remote_ok_at: null, remote_error: null, files: 0,
  };
  let running = null; let timer = null;
  function status() { return { ...state }; }
  async function once({ force = false } = {}) {
    const buf = db.exportBuffer();
    const check = await verifySqliteBackup(buf);
    state.verified = !!check.ok;
    state.verify_error = check.ok ? null : (check.error || 'no se pudo abrir la copia');
    state.users = check.ok ? check.users : null;
    state.schools = check.ok ? check.schools : null;
    state.transactions = check.ok ? check.transactions : null;
    if (!check.ok) {
      log.error('[respaldo] La copia no pasó la prueba de lectura:', state.verify_error);
      return status();
    }
    fs.mkdirSync(dir, { recursive: true });
    const { day } = stamp();
    const daily = path.join(dir, `servidor-${day}.db`);
    writeAtomic(daily, buf);
    writeAtomic(path.join(dir, 'ultimo.db'), buf);
    pruneBackups(dir, keep);
    state.last_at = new Date().toISOString();
    state.last_file = path.basename(daily);
    state.files = fs.readdirSync(dir).filter((x) => DAILY_NAME.test(x) || x === 'ultimo.db').length;
    if (uploader) {
      try {
        await uploader.put('ultimo.db', buf);
        await uploader.put(path.basename(daily), buf);
        state.remote_ok_at = new Date().toISOString();
        state.remote_error = null;
      } catch (e) {
        state.remote_error = e.message || String(e);
        log.error('[respaldo] No se pudo subir la copia a la nube:', state.remote_error);
      }
    }
    if (force) { /* la copia de hoy ya quedó actualizada */ }
    return status();
  }
  function run(opts) {
    if (running) return running;
    running = once(opts).finally(() => { running = null; });
    return running;
  }
  if (autostart) {
    timer = setInterval(() => { run().catch((e) => log.error('[respaldo]', e.message)); }, everyMs);
    if (timer.unref) timer.unref();
  }
  return { run, status, stop() { if (timer) clearInterval(timer); } };
}

module.exports = { createTursoStore, tursoClient, createReplicator, dailyFileBackups, persistenceMode, createBackupService, s3TargetFromEnv, verifySqliteBackup, signS3Put };
