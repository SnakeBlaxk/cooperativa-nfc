'use strict';
// Prueba de la caja de escritorio como CLIENTE EN LÍNEA: `xvfb-run npx electron scripts/e2e.js`
// 1) Arranca la caja sin servidor: debe mostrar "Sin conexión a internet…" y reintentar sola.
// 2) Levanta el servidor: la caja se recupera sola y carga la app web del servidor.
// 3) Cajero cobra con el lector PC/SC (UID por IPC): la venta queda registrada directo en el servidor.
// 4) Se apaga el servidor: aviso a pantalla completa, no se puede cobrar (nada se guarda para después).
// 5) Regresa el servidor: el aviso desaparece y se puede volver a cobrar.
// Capturas: docs/capturas/v2/80-sin-conexion.png (app) y 83-escritorio-sin-conexion.png (caja al arrancar).
const path = require('path'); const fs = require('fs'); const os = require('os'); const net = require('net');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-e2e-'));
process.env.COOP_USER_DATA = tmp;
process.env.COOP_RETRY_MS = '1500';
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  process.env.COOP_SERVER_URL = base;
  const S = await createServer({ jwtSecret: 'e'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  let srv = null;
  const startServer = () => new Promise((r) => { srv = S.app.listen(port, '127.0.0.1', r); });
  const stopServer = () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); });
  const balance = (uid) => S.db.get('SELECT balance_cents AS b FROM cards WHERE uid = ?', [uid]).b;
  const sales = () => S.db.get("SELECT COUNT(*) AS n FROM transactions WHERE type = 'compra'").n;

  require('../src/main/main.js');
  await app.whenReady();
  let win = null;
  for (let i = 0; i < 50 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await sleep(100); }
  const wc = win.webContents;
  wc.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon|serviceWorker|sw\.js|ERR_CONNECTION_REFUSED|Failed to fetch|Failed to load resource/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => wc.executeJavaScript(c);
  const text = () => js('document.body ? document.body.innerText : ""').catch(() => '');
  const waitFor = async (pred, ms, what) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await pred()) return true; } catch (_) { /* página cargando */ } await sleep(200); } errors.push('tiempo agotado: ' + what); return false; };
  const shot = async (n) => { await sleep(500); fs.writeFileSync(path.join(shots, n + '.png'), (await wc.capturePage()).toPNG()); };
  const clickBtn = (t) => js(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(!b) throw new Error('No hay botón'); b.click();})()`);
  try {
    // 1) sin servidor
    await waitFor(async () => (await text()).includes('No se puede cobrar hasta que regrese la conexión'), 15000, 'aviso sin conexión al arrancar');
    await waitFor(async () => /Reintentando automáticamente/.test(await text()), 5000, 'reintento automático');
    await shot('83-escritorio-sin-conexion');
    // 2) llega el servidor: se recupera sola
    await startServer();
    await waitFor(async () => wc.getURL().startsWith(base) && (await text()).includes('Entrar'), 20000, 'recupera y carga el login del servidor');
    if (!(await js('!!(window.coop && window.coop.desktop && window.coopDesktop)'))) errors.push('la página del servidor no recibió el puente de escritorio');
    // 3) cajero cobra con el lector PC/SC
    await js(`(()=>{const i=document.querySelectorAll('.login input');i[0].value='cajero';i[1].value='cajero123';document.querySelector('.login').requestSubmit();})()`);
    await waitFor(async () => (await text()).includes('Acerque la tarjeta'), 10000, 'pantalla Cobrar');
    const uid = '04A1B2C3D4E5F6'; const b0 = balance(uid); const n0 = sales();
    wc.send('nfc:uid', uid);
    await waitFor(async () => (await text()).includes('Sofía') || (await text()).includes('Sofia'), 8000, 'tarjeta leída por PC/SC');
    await js(`document.querySelector('.pbtn').click()`); await sleep(300);
    await clickBtn('✔ Cobrar (F2)');
    await waitFor(async () => (await text()).includes('Venta aprobada'), 8000, 'venta aprobada');
    if (sales() !== n0 + 1 || !(balance(uid) < b0)) errors.push('la venta no quedó en el servidor');
    // 4) se apaga el servidor
    await stopServer();
    await waitFor(async () => js(`!!document.getElementById('offline-overlay') && !document.getElementById('offline-overlay').hidden`), 45000, 'aviso a pantalla completa');
    const t = await text();
    if (!t.includes('Sin conexión a internet. No se puede cobrar hasta que regrese la conexión.')) errors.push('falta el texto del aviso');
    // intento de cobro sin conexión: se rechaza y no se guarda nada
    const r = await js(`window.coop.call('purchase', { uid: '${uid}', items: [] })`);
    if (r.ok || r.code !== 'SIN_CONEXION') errors.push('se permitió operar sin conexión: ' + JSON.stringify(r));
    wc.send('nfc:uid', uid); await sleep(800);
    await shot('80-sin-conexion');
    const n1 = sales();
    // 5) regresa el servidor
    await startServer();
    await waitFor(async () => js(`!document.getElementById('offline-overlay') || document.getElementById('offline-overlay').hidden`), 20000, 'el aviso desaparece al volver la conexión');
    if (sales() !== n1) errors.push('se enviaron operaciones guardadas sin conexión');
    await waitFor(async () => (await text()).includes('Acerque la tarjeta'), 8000, 'vuelve a Cobrar (sesión recuperada)');
    wc.send('nfc:uid', uid);
    await waitFor(async () => (await text()).includes('Saldo'), 8000, 'se puede volver a leer la tarjeta');
  } catch (e) { errors.push('excepción: ' + (e && e.stack || e)); }
  if (errors.length) { console.error('E2E escritorio: ERRORES\n' + errors.join('\n')); app.exit(1); } else { console.log('E2E escritorio (en línea): OK'); app.exit(0); }
})().catch((e) => { console.error(e); app.exit(1); });
