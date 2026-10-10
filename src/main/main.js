'use strict';
// Caja de escritorio — CLIENTE EN LÍNEA del servidor (igual que la app web).
// * Ya no hay base de datos local ni cola de ventas sin conexión: cada venta y recarga va directo a la API.
// * La ventana carga la app web del servidor (dirección configurable; por defecto la de Render).
// * Sin internet o con el servidor caído se muestra "Sin conexión a internet. No se puede cobrar hasta que
//   regrese la conexión." y no se puede cobrar ni recargar; la caja reintenta sola y se recupera.
// * Se conserva el lector NFC: los lectores tipo teclado USB funcionan directamente y los PC/SC (ACR122U)
//   envían el UID a la página por el puente seguro (preload).
const { app, BrowserWindow, ipcMain, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { startNfcReader } = require('./nfc');
const { DEFAULT_SERVER_URL, normalizeServerUrl, resolveServerUrl, checkServer, isAllowedUrl } = require('./online');

const RETRY_MS = Number(process.env.COOP_RETRY_MS || 5000);
const LOCAL_PAGE = path.join(__dirname, '..', 'desktop-ui', 'conexion.html');
let mainWindow = null;
let lastNfcStatus = { available: false, message: 'Modo teclado USB' };
let retryTimer = null; let connecting = false; let configuring = false; // configuring: pantalla "Servidor…" abierta
const status = { state: 'conectando', serverUrl: DEFAULT_SERVER_URL, error: null, nextRetryAt: null };

function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function readConfig() { try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) { return {}; } }
function writeConfig(c) { fs.mkdirSync(path.dirname(configPath()), { recursive: true }); fs.writeFileSync(configPath(), JSON.stringify(c, null, 2)); }
function serverUrl() { return resolveServerUrl(process.env, readConfig()); }

function sendStatus(patch) {
  Object.assign(status, patch, { serverUrl: serverUrl() });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desk:status', { ...status });
}
const isLocal = (wc) => { try { return new URL(wc.getURL()).protocol === 'file:'; } catch (_) { return false; } };
function showLocal(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cur = mainWindow.webContents.getURL();
  if (cur.startsWith('file:') && cur.includes('conexion.html') && cur.includes('modo=' + mode)) return;
  mainWindow.loadFile(LOCAL_PAGE, { query: { modo: mode } });
}
function scheduleRetry() {
  clearTimeout(retryTimer);
  sendStatus({ nextRetryAt: Date.now() + RETRY_MS });
  retryTimer = setTimeout(connect, RETRY_MS);
}

// Intenta conectar con el servidor; si responde, carga la app web. Si no, muestra el aviso y reintenta.
async function connect() {
  if (connecting || configuring || !mainWindow || mainWindow.isDestroyed()) return;
  connecting = true; clearTimeout(retryTimer);
  const url = serverUrl();
  sendStatus({ state: 'conectando', error: null, nextRetryAt: null });
  const r = await checkServer(url);
  connecting = false;
  if (!mainWindow || mainWindow.isDestroyed() || configuring) return;
  if (url !== serverUrl()) return connect(); // cambió la dirección mientras se probaba
  if (r.ok) {
    sendStatus({ state: 'en_linea', error: null });
    mainWindow.loadURL(url + '/').catch(() => { /* lo maneja did-fail-load */ });
  } else {
    sendStatus({ state: 'sin_conexion', error: r.error });
    showLocal('sin-conexion');
    scheduleRetry();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1000, minHeight: 650,
    title: 'Zuki Pay',
    backgroundColor: '#f4f6fb',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = mainWindow.webContents;
  mainWindow.on('closed', () => { mainWindow = null; clearTimeout(retryTimer); });
  // No abrir ventanas nuevas ni salir del servidor configurado
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, target) => {
    if (!isAllowedUrl(target, serverUrl())) return e.preventDefault();
    if (target.startsWith('file:') && target.includes('modo=servidor')) { configuring = true; clearTimeout(retryTimer); }
  });
  wc.on('will-redirect', (e, target) => { if (!isAllowedUrl(target, serverUrl())) e.preventDefault(); });
  // Falla al cargar la app del servidor (sin internet, servidor caído): aviso y reintento
  wc.on('did-fail-load', (_e, code, desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* cancelado */ || configuring || String(failedUrl).startsWith('file:')) return;
    sendStatus({ state: 'sin_conexion', error: desc || 'No se pudo cargar' });
    showLocal('sin-conexion');
    scheduleRetry();
  });
  showLocal('conectando');
  wc.once('did-finish-load', () => connect());
  if (process.env.COOP_SMOKE_TEST) {
    const done = async () => {
      if (!mainWindow) return;
      const r = await wc.executeJavaScript('document.title + "|" + location.protocol + "|" + !!window.coopDesktop + "|" + !!window.coop');
      console.log('[smoke] cargado:', r);
      setTimeout(() => app.quit(), 500);
    };
    wc.on('did-finish-load', () => { if (!isLocal(wc) || status.state === 'sin_conexion') done(); });
  }
}

ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, serverUrl: serverUrl(), desktop: true }));
ipcMain.handle('app:nfcStatus', () => lastNfcStatus);
// Solo las páginas locales de la caja pueden cambiar el servidor o forzar el reintento
ipcMain.handle('desk:status', () => ({ ...status, serverUrl: serverUrl() }));
ipcMain.handle('desk:retry', (event) => { if (!isLocal(event.sender)) return { ok: false }; configuring = false; connect(); return { ok: true }; });
ipcMain.handle('desk:setServerUrl', async (event, raw) => {
  if (!isLocal(event.sender)) return { ok: false, error: 'No permitido' };
  try {
    const url = raw === null ? null : normalizeServerUrl(raw);
    const c = readConfig();
    if (!url || url === DEFAULT_SERVER_URL) delete c.serverUrl; else c.serverUrl = url;
    writeConfig(c);
    const test = await checkServer(serverUrl(), { timeoutMs: 20000 });
    configuring = false; connect();
    return { ok: true, data: { serverUrl: serverUrl(), reachable: test.ok, error: test.error || null } };
  } catch (e) { return { ok: false, error: e.message }; }
});

function openServerConfig() { configuring = true; clearTimeout(retryTimer); sendStatus({ nextRetryAt: null }); showLocal('servidor'); }

const template = [
  { label: 'Archivo', submenu: [
    { label: 'Servidor…', click: openServerConfig },
    { label: 'Volver a conectar', click: () => { configuring = false; connect(); } },
    { type: 'separator' }, { role: 'quit', label: 'Salir' }] },
  { label: 'Editar', submenu: [{ role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' }, { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' }] },
  { label: 'Ver', submenu: [{ label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: () => { configuring = false; connect(); } }, { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }, { type: 'separator' }, { role: 'resetZoom', label: 'Tamaño normal' }, { role: 'zoomIn', label: 'Acercar' }, { role: 'zoomOut', label: 'Alejar' }, { role: 'togglefullscreen', label: 'Pantalla completa' }] },
];
if (process.platform === 'darwin') template.unshift({ label: 'Zuki Pay', submenu: [{ role: 'about', label: 'Acerca de' }, { role: 'hide', label: 'Ocultar' }, { role: 'quit', label: 'Salir' }] });

if (process.env.COOP_USER_DATA) app.setPath('userData', process.env.COOP_USER_DATA); // pruebas
else { // v2.1: el producto se llama Zuki Pay; conservar la configuración de 'Cooperativa NFC' si existe
  try { const fs = require('fs'); const nuevo = path.join(app.getPath('userData'), 'config.json'); const viejo = path.join(app.getPath('appData'), 'Cooperativa NFC', 'config.json');
    if (!fs.existsSync(nuevo) && fs.existsSync(viejo)) { fs.mkdirSync(path.dirname(nuevo), { recursive: true }); fs.copyFileSync(viejo, nuevo); } } catch (_) {}
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    // Sin permisos especiales para la página (cámara, ubicación, notificaciones…)
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    createWindow();
    // Lector NFC PC/SC opcional (ACR122U, etc.). Envía el UID a la página por IPC.
    startNfcReader((uid) => { if (mainWindow) mainWindow.webContents.send('nfc:uid', uid); },
      (st) => { lastNfcStatus = st; if (mainWindow) mainWindow.webContents.send('nfc:status', st); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
