'use strict';
// Arranque del contenedor en Render: Zuki Pay (API + PWA) y, si hay WAHA_API_KEY, WAHA (WhatsApp, motor GOWS)
// en el MISMO servicio, sin costo extra. Este archivo ES el proceso de Zuki Pay (carga server/index.js)
// y además vigila a WAHA como proceso hijo (así no se gasta memoria en un tercer proceso).
//  - Zuki Pay escucha en $PORT (lo único público). WAHA escucha solo en 127.0.0.1:$WAHA_INTERNAL_PORT (3001).
//  - Si Zuki Pay se cae, se cae el contenedor y Render lo reinicia. Si WAHA se cae, se reinicia solo WAHA.
//  - Memoria (plan de 512 MB): heap de WAHA limitado (WAHA_MAX_OLD_SPACE_MB, 128) y, si el contenedor pasa de
//    WAHA_MEM_RESTART_MB (490), se reinicia WAHA para proteger los cobros (la sesión sigue en disco, no se reescanea).
//  - La sesión de WhatsApp se respalda cifrada en Turso (si hay TURSO_*) y se restaura al arrancar, para no
//    tener que escanear el QR después de cada deploy.
// WAHA_EMBEDDED=0 desactiva WAHA aquí (por ejemplo, si algún día se usa un servicio aparte con WAHA_URL).
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { onShutdown } = require('./lifecycle');

const env = process.env;
const APP_PORT = Number(env.PORT || 3000);
const WAHA_PORT = Number(env.WAHA_INTERNAL_PORT || 3001);
const WAHA_ENTRY = env.WAHA_ENTRYPOINT || '/entrypoint.sh';
const SESS_DIR = env.WAHA_LOCAL_STORE_BASE_DIR || '/app/.sessions';
const WAHA_HEAP = Number(env.WAHA_MAX_OLD_SPACE_MB || 128);
const MEM_RESTART_MB = Number(env.WAHA_MEM_RESTART_MB || 490);
const MEM_MIN_UPTIME_MS = Number(env.WAHA_MEM_MIN_UPTIME_MS || 10 * 60e3);
const embedded = env.WAHA_EMBEDDED !== '0' && !!String(env.WAHA_API_KEY || '').trim() && fs.existsSync(WAHA_ENTRY);
const log = (...a) => console.log('[whatsapp]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = () => require('crypto').randomBytes(24).toString('hex');

function get(url, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, { headers, timeout: 5000 }, (res) => {
      let body = ''; res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 20000) body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

// Memoria (RSS) de este proceso y todos sus hijos (WAHA y GOWS), leída de /proc.
function treeRssMb() {
  try {
    const parent = new Map(); const rss = new Map();
    for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
      try {
        const st = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        parent.set(Number(pid), Number((/PPid:\s+(\d+)/.exec(st) || [])[1]));
        rss.set(Number(pid), Number((/VmRSS:\s+(\d+)/.exec(st) || [0, 0])[1]));
      } catch (_) { /* proceso terminado */ }
    }
    const mine = new Set([process.pid]); let grew = true;
    while (grew) { grew = false; for (const [p, pp] of parent) if (!mine.has(p) && mine.has(pp)) { mine.add(p); grew = true; } }
    let kb = 0; for (const p of mine) kb += rss.get(p) || 0;
    return Math.round(kb / 1024);
  } catch (_) { return null; }
}

let waha = null; let stopping = false; let backup = null;
const crashes = []; const memRestarts = [];
const recent = (arr, ms) => { const now = Date.now(); while (arr.length && now - arr[0] > ms) arr.shift(); return arr.length; };

function startWaha() {
  // WAHA lee PORT antes que WHATSAPP_API_PORT: se sobreescribe para que no choque con Zuki Pay.
  const wEnv = {
    ...env,
    PORT: String(WAHA_PORT), WHATSAPP_API_PORT: String(WAHA_PORT), WHATSAPP_API_HOSTNAME: '127.0.0.1',
    NODE_OPTIONS: `--max-old-space-size=${WAHA_HEAP} --max-semi-space-size=1 --require ${path.join(__dirname, 'waha-localhost.js')}`,
    ZUKI_WAHA_BIND_PORT: String(WAHA_PORT),
    WHATSAPP_DEFAULT_ENGINE: env.WHATSAPP_DEFAULT_ENGINE || 'GOWS',
    WAHA_LOCAL_STORE_BASE_DIR: SESS_DIR,
    UV_THREADPOOL_SIZE: env.WAHA_UV_THREADPOOL_SIZE || '2', MALLOC_ARENA_MAX: '2', GOGC: env.WAHA_GOGC || '50', GOMEMLIMIT: env.WAHA_GOMEMLIMIT || '96MiB',
    // Panel y Swagger apagados; contraseñas aleatorias para que WAHA no las genere e imprima en los logs.
    WAHA_DASHBOARD_ENABLED: 'false', WHATSAPP_SWAGGER_ENABLED: 'false', WAHA_PRINT_QR: 'False',
    WAHA_DASHBOARD_USERNAME: 'off', WAHA_DASHBOARD_PASSWORD: rand(), WHATSAPP_SWAGGER_USERNAME: 'off', WHATSAPP_SWAGGER_PASSWORD: rand(),
    WAHA_EVENTS_DOWNLOAD_MEDIA: 'false', WAHA_API_DOWNLOAD_MEDIA: 'false',
    WAHA_SESSION_CONFIG_IGNORE_STATUS: 'true', WAHA_SESSION_CONFIG_IGNORE_GROUPS: 'true',
    WAHA_SESSION_CONFIG_IGNORE_CHANNELS: 'true', WAHA_SESSION_CONFIG_IGNORE_BROADCAST: 'true',
    // Historial mínimo: menos memoria, menos espacio y respaldos más chicos.
    WAHA_GOWS_DEVICE_REQUIRE_FULL_SYNC: env.WAHA_GOWS_DEVICE_REQUIRE_FULL_SYNC || 'false',
    WAHA_GOWS_DEVICE_HISTORY_SYNC_FULL_SYNC_DAYS_LIMIT: env.WAHA_GOWS_DEVICE_HISTORY_SYNC_FULL_SYNC_DAYS_LIMIT || '1',
    WAHA_GOWS_DEVICE_HISTORY_SYNC_RECENT_SYNC_DAYS_LIMIT: env.WAHA_GOWS_DEVICE_HISTORY_SYNC_RECENT_SYNC_DAYS_LIMIT || '1',
    WAHA_GOWS_DEVICE_HISTORY_SYNC_INITIAL_SYNC_MAX_MESSAGES_PER_CHAT: env.WAHA_GOWS_DEVICE_HISTORY_SYNC_INITIAL_SYNC_MAX_MESSAGES_PER_CHAT || '1',
    WAHA_GOWS_DEVICE_HISTORY_SYNC_FULL_SYNC_SIZE_MB_LIMIT: env.WAHA_GOWS_DEVICE_HISTORY_SYNC_FULL_SYNC_SIZE_MB_LIMIT || '5',
    WAHA_LOG_LEVEL: env.WAHA_LOG_LEVEL || 'warn',
    TZ: env.TZ || 'America/Mexico_City',
  };
  // Las variables de Zuki Pay no hacen falta dentro de WAHA (menos superficie si WAHA se ve comprometido).
  for (const k of Object.keys(wEnv)) if (/^(TURSO_|JWT_SECRET|SUPERADMIN_|ADMIN_|VAPID_|WAHA_BACKUP_KEY|DB_PATH|SMTP_|RESEND_)/.test(k)) delete wEnv[k];
  fs.mkdirSync(SESS_DIR, { recursive: true });
  const child = spawn(WAHA_ENTRY, [], { env: wEnv, stdio: 'inherit', cwd: env.WAHA_APP_DIR || '/app' });
  child.startedAt = Date.now();
  waha = child;
  child.on('exit', (code, sig) => {
    if (waha === child) waha = null;
    if (stopping) return;
    if (child.memRestart) { log('WAHA reiniciado por memoria.'); setTimeout(() => { if (!stopping) startWaha(); }, 2000).unref(); return; }
    if (recent(crashes, 3600e3) >= 5) { console.error('[whatsapp] WAHA falló 5 veces en una hora; se deja apagado. Zuki Pay sigue funcionando.'); return; }
    crashes.push(Date.now());
    const wait = 5000 * crashes.length;
    console.error(`[whatsapp] WAHA terminó (código ${code}, señal ${sig}); se reinicia en ${wait / 1000} s.`);
    setTimeout(() => { if (!stopping) startWaha(); }, wait).unref();
  });
}

async function waitFor(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stopping) { const r = await get(url); if (r.status >= 200 && r.status < 500) return true; await sleep(1000); }
  return false;
}

async function sessionStatus() {
  const name = /^[A-Za-z0-9_-]{1,64}$/.test(String(env.WAHA_SESSION || '')) ? env.WAHA_SESSION : 'default';
  const r = await get(`http://127.0.0.1:${WAHA_PORT}/api/sessions/${name}`, { 'X-Api-Key': String(env.WAHA_API_KEY || '').trim(), Accept: 'application/json' });
  try { return r.status === 200 ? (JSON.parse(r.body).status || null) : null; } catch (_) { return null; }
}

// Respaldo: ~1 min después de conectarse (para no perder el QR recién escaneado), cada 6 horas y al apagar.
function watchSession() {
  let last = null; let lastSave = 0; let busy = false;
  const every = Number(env.WAHA_BACKUP_EVERY_MS || 6 * 3600e3);
  const t = setInterval(async () => {
    if (stopping || !waha || busy) return;
    busy = true;
    try {
      const st = await sessionStatus();
      const justConnected = st === 'WORKING' && last !== 'WORKING';
      last = st;
      if (st === 'WORKING' && (justConnected || Date.now() - lastSave > every)) {
        if (justConnected) await sleep(45000); // deja que GOWS termine de guardar las llaves del vínculo
        const r = await backup.save();
        if (r.saved) { lastSave = Date.now(); log(`Sesión respaldada en Turso (${Math.round(r.bytes / 1024)} KB).`); }
      }
    } finally { busy = false; }
  }, 30000);
  t.unref();
}

// Vigilancia de memoria: protege a Zuki Pay reiniciando WAHA antes de que Render mate el contenedor.
function watchMemory() {
  let n = 0;
  const t = setInterval(() => {
    const mb = treeRssMb();
    if (mb === null) return;
    if (++n % 20 === 0) console.log(`[memoria] Contenedor ≈ ${mb} MB (Zuki Pay + WhatsApp)`);
    // Solo si WAHA ya lleva un rato arriba (al arrancar hay un pico) y máximo 3 veces por hora.
    if (mb > MEM_RESTART_MB && waha && !stopping && Date.now() - waha.startedAt > MEM_MIN_UPTIME_MS && recent(memRestarts, 3600e3) < 3) {
      memRestarts.push(Date.now());
      console.warn(`[memoria] ${mb} MB > ${MEM_RESTART_MB} MB: se reinicia WAHA para proteger los cobros.`);
      waha.memRestart = true;
      try { waha.kill('SIGTERM'); } catch (_) { /* nada */ }
    }
  }, Number(env.MEM_CHECK_EVERY_MS || 30000));
  t.unref();
}

async function stopWaha() {
  stopping = true;
  const w = waha;
  if (!w) return;
  // Último respaldo con WAHA todavía corriendo (copia consistente), luego se apaga WAHA.
  try { if (backup && backup.enabled && (await sessionStatus()) === 'WORKING') await Promise.race([backup.save(), sleep(10000)]); } catch (_) { /* nada */ }
  try { w.kill('SIGTERM'); } catch (_) { /* nada */ }
  await Promise.race([new Promise((r) => (w.exitCode !== null || w.signalCode ? r() : w.once('exit', r))), sleep(6000)]);
}

(async () => {
  if (embedded) {
    const { createTursoStore } = require('./persist');
    const { createSessionBackup } = require('./waha-session-backup');
    const store = env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN ? createTursoStore({ url: env.TURSO_DATABASE_URL, token: env.TURSO_AUTH_TOKEN, prefix: 'waha_session' }) : null;
    backup = createSessionBackup({ dir: SESS_DIR, store });
    if (!backup.enabled) log('Sin Turso: la sesión no se respalda; tras cada reinicio hay que volver a vincular el número.');
    try { await backup.restore(); } catch (e) { console.error('[whatsapp] No se pudo restaurar la sesión (habrá que volver a vincular):', e.message); }
    if (!env.WAHA_URL) env.WAHA_URL = `http://127.0.0.1:${WAHA_PORT}`;
    onShutdown(stopWaha);
    // Si este proceso muere de golpe, WAHA no se queda huérfano.
    process.on('exit', () => { if (waha) try { waha.kill('SIGKILL'); } catch (_) { /* nada */ } });
  } else console.log('[whatsapp] WAHA no se inicia aquí (falta WAHA_API_KEY o WAHA_EMBEDDED=0).');
  require('./index'); // Zuki Pay (mismo proceso)
  if (!embedded) return;
  // Primero Zuki Pay (para que Render detecte su puerto), después WAHA.
  await waitFor(`http://127.0.0.1:${APP_PORT}/api/health`, 180000);
  if (stopping) return;
  log(`Iniciando WAHA (GOWS) en 127.0.0.1:${WAHA_PORT}…`);
  startWaha();
  if (backup.enabled) watchSession();
  watchMemory();
})().catch((e) => { console.error(e); process.exit(1); });
