'use strict';
// Copia de la sesión de WhatsApp (carpeta de WAHA, por defecto /app/.sessions) en Turso, cifrada.
// Sirve para no tener que escanear el QR después de cada deploy o reinicio en Render sin disco.
// - Las bases SQLite se copian con la API de respaldo de SQLite (node:sqlite) para que la copia sea consistente
//   aunque WAHA/GOWS las esté usando. Los archivos -wal/-shm/-journal no se copian (el respaldo ya los incluye).
// - El paquete es JSON comprimido y cifrado con AES-256-GCM. La llave sale de WAHA_BACKUP_KEY o, si no existe, de WAHA_API_KEY.
//   Si cambia la llave, la copia vieja no se puede abrir y solo hay que volver a escanear el QR.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from('ZKWA1');
const SQLITE_HEADER = Buffer.from('SQLite format 3\0');
const SKIP_RE = /-(wal|shm|journal)$/;
const MAX_FILE_BYTES = 40 * 1024 * 1024;

function backupKey(env = process.env) {
  const k = String(env.WAHA_BACKUP_KEY || env.WAHA_API_KEY || '').trim();
  if (!k) return null;
  return crypto.createHash('sha256').update('zukipay-waha-session:' + k).digest();
}

function encrypt(buf, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
}
function decrypt(buf, key) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + 28 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('copia de sesión con formato desconocido');
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(MAGIC.length + 28)), d.final()]);
}

function isSqlite(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(16);
    return fs.readSync(fd, b, 0, 16, 0) === 16 && b.equals(SQLITE_HEADER);
  } catch (_) { return false; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function walk(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile() && !SKIP_RE.test(e.name)) out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

// Copia consistente de una base SQLite en uso. Si node:sqlite no existe (Node viejo), copia el archivo tal cual.
async function sqliteSnapshot(file, tmpDir) {
  let sqlite = null;
  try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
  if (!sqlite || typeof sqlite.backup !== 'function') return fs.readFileSync(file);
  const dest = path.join(tmpDir, crypto.randomBytes(6).toString('hex') + '.db');
  const src = new sqlite.DatabaseSync(file, { timeout: 5000 });
  try { await sqlite.backup(src, dest); } finally { try { src.close(); } catch (_) { /* nada */ } }
  try { return fs.readFileSync(dest); } finally { try { fs.unlinkSync(dest); } catch (_) { /* nada */ } }
}

async function packDir(dir) {
  const files = walk(dir);
  if (!files.length) return null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'waha-bk-'));
  try {
    const list = [];
    for (const f of files) {
      const st = fs.statSync(f.full);
      if (st.size > MAX_FILE_BYTES) throw new Error(`archivo de sesión demasiado grande (${f.rel}, ${Math.round(st.size / 1e6)} MB)`);
      const data = isSqlite(f.full) ? await sqliteSnapshot(f.full, tmp) : fs.readFileSync(f.full);
      list.push({ p: f.rel, m: st.mode & 0o777, d: data.toString('base64') });
    }
    return zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, files: list })), { level: 6 });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function unpackTo(gz, dir) {
  const j = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  if (!j || j.v !== 1 || !Array.isArray(j.files)) throw new Error('copia de sesión inválida');
  const root = path.resolve(dir);
  let n = 0;
  for (const f of j.files) {
    const target = path.resolve(root, String(f.p || ''));
    if (!target.startsWith(root + path.sep)) throw new Error('ruta inválida en la copia de sesión');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(String(f.d || ''), 'base64'), { mode: Number(f.m) || 0o600 });
    n++;
  }
  return n;
}

function dirIsEmpty(dir) {
  return walk(dir).length === 0;
}

// store: { load(): Buffer|null, save(Buffer) } (createTursoStore con prefix 'waha_session')
function createSessionBackup({ dir, store, env = process.env, log = console }) {
  const key = backupKey(env);
  const state = { last_ok_at: null, last_error: null, last_bytes: 0, restored_files: 0 };
  async function restore() {
    if (!store || !key) return { restored: false, reason: !store ? 'sin_turso' : 'sin_llave' };
    if (!dirIsEmpty(dir)) return { restored: false, reason: 'ya_hay_sesion' };
    const buf = await store.load();
    if (!buf) return { restored: false, reason: 'sin_copia' };
    const n = unpackTo(decrypt(buf, key), dir);
    state.restored_files = n;
    log.log(`[whatsapp] Sesión de WhatsApp restaurada desde Turso (${n} archivos).`);
    return { restored: true, files: n };
  }
  let running = null;
  async function save() {
    if (!store || !key) return { saved: false, reason: !store ? 'sin_turso' : 'sin_llave' };
    if (running) return running;
    running = (async () => {
      try {
        const gz = await packDir(dir);
        if (!gz) return { saved: false, reason: 'vacio' };
        const r = await store.save(encrypt(gz, key));
        state.last_ok_at = new Date().toISOString(); state.last_error = null; state.last_bytes = gz.length;
        return { saved: true, bytes: r.bytes };
      } catch (e) {
        state.last_error = e.message;
        log.error('[whatsapp] No se pudo respaldar la sesión:', e.message);
        return { saved: false, reason: 'error', error: e.message };
      } finally { running = null; }
    })();
    return running;
  }
  return { restore, save, state, enabled: !!(store && key) };
}

module.exports = { createSessionBackup, packDir, unpackTo, encrypt, decrypt, backupKey, dirIsEmpty };
