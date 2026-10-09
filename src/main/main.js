'use strict';
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { openDatabase } = require('../core/db');
const { createService } = require('../core/service');
const { createApi } = require('../core/api');
const { seed, seedMinimal, isEmpty, ensureDefaultSchool } = require('../core/seed');
const { startNfcReader } = require('./nfc');
const { remoteLogin, testServer } = require('./remote-auth');
const { createSyncClient } = require('../core/sync-client');
const { evaluateFlags } = require('../core/security');
const crypto = require('crypto');
let syncClient = null; let syncTimer = null; let kickTimer = null;
const SYNC_INTERVAL_MS = Number(process.env.COOP_SYNC_INTERVAL_MS || 45000);

function configPath() { return path.join(path.dirname(dbPath()), 'config.json'); }
function readConfig() { try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (_) { return {}; } }
function writeConfig(c) { fs.writeFileSync(configPath(), JSON.stringify(c, null, 2)); }

let db; let api; let mainWindow; let schoolId = null;
let lastNfcStatus = { available: false, message: 'Modo teclado USB' };
const sessions = new Map(); // webContents.id -> { user }

function dbPath() {
  // Permite sobreescribir con variable de entorno (útil para pruebas/portátil)
  return process.env.COOP_DB_PATH || path.join(app.getPath('userData'), 'cooperativa.db');
}

async function init() {
  const file = dbPath();
  db = await openDatabase(file, { syncOutbox: true });
  if (isEmpty(db)) {
    // Primera ejecución: preguntar si se cargan datos de demostración (en pruebas automáticas, siempre demo)
    let demo = true;
    if (!process.env.COOP_DB_PATH && !process.env.COOP_SMOKE_TEST) {
      const r = dialog.showMessageBoxSync({ type: 'question', title: 'Cooperativa NFC — primer uso', buttons: ['Cargar datos de demostración', 'Empezar con base vacía'], defaultId: 0, cancelId: 0,
        message: '¿Cómo quiere empezar?', detail: 'Demostración: incluye usuarios, alumnos, tarjetas, productos y movimientos de ejemplo (admin/admin123).\nBase vacía: solo el usuario admin / admin123, que deberá cambiar la contraseña al entrar.' });
      demo = r === 0;
    }
    if (demo) seed(db);
    else {
      // Base vacía: contraseña aleatoria para "admin" (solo el administrador de la plataforma cambia contraseñas)
      const A = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const b = crypto.randomBytes(12);
      let pass = ''; for (const x of b) pass += A[x % A.length];
      seedMinimal(db, { password: pass });
      if (!process.env.COOP_DB_PATH && !process.env.COOP_SMOKE_TEST) {
        dialog.showMessageBoxSync({ type: 'info', title: 'Anote su contraseña', buttons: ['Ya la anoté'], message: `Usuario: admin\nContraseña: ${pass}`,
          detail: 'Anótela en un lugar seguro: se muestra solo esta vez. Para cambiarla, vincule la caja al servidor y pida al administrador de la plataforma una nueva.' });
      }
    }
    console.log('[db] Base nueva creada', demo ? 'con datos demo' : 'vacía', 'en', file);
  } else console.log('[db] Base cargada de', file);
  // La caja trabaja con UNA escuela (la de su base local; al vincularla toma el nombre de la escuela del servidor)
  schoolId = ensureDefaultSchool(db);
  api = createApi(createService(db, { schoolId, singleSchool: true }));
  // Sincronización en segundo plano (solo si hay servidor y equipo vinculado)
  syncClient = createSyncClient({ db, getConfig: readConfig, onStatus: (s) => { if (mainWindow) mainWindow.webContents.send('sync:status', syncClient.getStatus()); } });
  syncTimer = setInterval(() => { const c = readConfig(); if (c.serverUrl && c.deviceToken) syncClient.syncNow(); }, SYNC_INTERVAL_MS);
  setTimeout(() => { const c = readConfig(); if (c.serverUrl && c.deviceToken) syncClient.syncNow(); }, 3000);
  // Tras cada cambio local se programa una sincronización rápida (3 s) para que el saldo en el servidor se actualice pronto
  const kick = () => { clearTimeout(kickTimer); kickTimer = setTimeout(() => { const c = readConfig(); if (c.serverUrl && c.deviceToken) syncClient.syncNow(); }, 3000); };
  const READ_ONLY = /^(list|get|lookup|childSummary|dashboard|securityStatus$|me$|login$|logout$)/;
  const readSecurityFlags = () => { try { const r = db.get("SELECT value FROM meta WHERE key = 'server_security'"); return r ? JSON.parse(r.value) : null; } catch (_) { return null; } };

  ipcMain.handle('api', async (event, method, args) => {
    const id = event.sender.id;
    if (!sessions.has(id)) sessions.set(id, { user: null });
    const session = sessions.get(id);
    const cfg = readConfig();
    // Con servidor configurado, el login se valida primero contra el servidor
    if (method === 'login' && cfg.serverUrl && args && args.username) {
      const linkedSchool = (db.get("SELECT value FROM meta WHERE key = 'linked_school_uuid'") || {}).value || null;
      const r = await remoteLogin({ serverUrl: cfg.serverUrl, username: String(args.username), password: String(args.password || ''), db, schoolUuid: cfg.deviceToken ? linkedSchool : null, localSchoolId: schoolId });
      if (r.status === 'rejected') return { ok: false, error: r.error, code: 'NO_AUTENTICADO' };
      const local = api.handle(session, 'login', args);
      if (local.ok && r.status === 'ok') session.remote = r.tokens; // reservado para la futura sincronización
      if (local.ok && r.status === 'offline') local.data = { ...local.data, offline: true };
      return local;
    }
    // Banderas de seguridad recibidas del servidor (congelar recargas/ventas, solo lectura, ALERTA ROJA)
    const flags = cfg.deviceToken ? readSecurityFlags() : null;
    if (method === 'securityStatus') return { ok: true, data: flags || {} };
    if (flags && session.user && !READ_ONLY.test(String(method))) {
      const today = new Date(); const d0 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')} 00:00:00`;
      const todayRechargesCents = method === 'recharge' ? db.get("SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE type = 'recarga' AND status = 'aprobado' AND created_at >= ?", [d0]).s : 0;
      const msg = evaluateFlags(flags, String(method), args || {}, { todayRechargesCents });
      if (msg) return { ok: false, error: msg, code: 'BLOQUEADO_SEGURIDAD' };
    }
    const out = api.handle(session, String(method), args);
    if (out.ok && !READ_ONLY.test(String(method))) kick();
    return out;
  });
  ipcMain.handle('sync:getStatus', () => syncClient.getStatus());
  ipcMain.handle('sync:now', (event) => { const s = sessions.get(event.sender.id); if (!s || !s.user || s.user.role === 'tutor') return syncClient.getStatus(); return syncClient.syncNow(); });
  ipcMain.handle('sync:link', async (event, a) => {
    if (!isAdmin(event)) return { ok: false, error: 'Solo el administrador' };
    try {
      const r = await syncClient.linkDevice({ serverUrl: a.serverUrl, username: a.username, password: a.password, name: a.name || require('os').hostname() });
      writeConfig({ ...readConfig(), serverUrl: r.serverUrl, deviceToken: r.deviceToken });
      const st = await syncClient.syncNow();
      return { ok: true, data: st };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('sync:unlink', (event) => {
    if (!isAdmin(event)) return { ok: false, error: 'Solo el administrador' };
    const c = readConfig(); delete c.deviceToken; writeConfig(c);
    db.run("DELETE FROM meta WHERE key = 'server_security'");
    return { ok: true, data: syncClient.getStatus() };
  });
  ipcMain.handle('sync:makePrimary', async (event, a) => {
    if (!isAdmin(event)) return { ok: false, error: 'Solo el administrador' };
    try { await syncClient.makePrimary({ serverUrl: readConfig().serverUrl, username: a.username, password: a.password }); return { ok: true, data: await syncClient.syncNow() }; } catch (e) { return { ok: false, error: e.message }; }
  });
  const isAdmin = (event) => { const s = sessions.get(event.sender.id); return s && s.user && s.user.role === 'admin'; };
  ipcMain.handle('app:getConfig', (event) => (isAdmin(event) ? readConfig() : {}));
  ipcMain.handle('app:setConfig', (event, c) => {
    if (!isAdmin(event)) return { ok: false, error: 'Solo el administrador' };
    const url = String((c && c.serverUrl) || '').trim();
    if (url && !/^https?:\/\/[^\s]+$/.test(url)) return { ok: false, error: 'URL inválida' };
    const prev = readConfig();
    const next = { ...prev, serverUrl: url || null };
    if (prev.serverUrl !== next.serverUrl) delete next.deviceToken; // otro servidor: hay que volver a vincular
    writeConfig(next);
    return { ok: true };
  });
  ipcMain.handle('app:testServer', (event, url) => (isAdmin(event) ? testServer(String(url || '')) : { ok: false, error: 'Solo el administrador' }));

  ipcMain.handle('app:nfcStatus', () => lastNfcStatus);
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), dbPath: file, platform: process.platform }));

  ipcMain.handle('app:backup', async (event) => {
    const s = sessions.get(event.sender.id);
    if (!s || !s.user || s.user.role !== 'admin') return { ok: false, error: 'Solo el administrador puede respaldar' };
    const d = new Date();
    const name = `respaldo-cooperativa-${d.toISOString().slice(0, 10)}.db`;
    const r = await dialog.showSaveDialog(mainWindow, { title: 'Guardar respaldo', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'Base SQLite', extensions: ['db'] }] });
    if (r.canceled || !r.filePath) return { ok: false, error: 'Cancelado' };
    fs.writeFileSync(r.filePath, db.exportBuffer());
    return { ok: true, data: r.filePath };
  });

  // Códigos de invitación para la hoja de "Programar tarjetas": primero sincroniza (para que el servidor conozca a los alumnos)
  ipcMain.handle('codes:get', async (event, a) => {
    if (!isAdmin(event)) return { ok: false, error: 'Solo el administrador' };
    try {
      const ids = Array.isArray(a && a.child_ids) ? a.child_ids.map(Number).filter((n) => n > 0) : [];
      const st = await syncClient.syncNow();
      if (!['ok', 'solo_lectura'].includes(st.state)) throw new Error(st.last_error || 'No se pudo sincronizar con el servidor');
      const res = await syncClient.requestInvitations(ids, { includeLinked: !!(a && a.include_linked) });
      const byUuid = new Map(db.all('SELECT id, uuid FROM children').map((r) => [r.uuid, r.id]));
      const codes = res.map((c) => ({ ...c, child_id: byUuid.get(c.child_uuid) }));
      return { ok: true, data: { codes, serverUrl: readConfig().serverUrl, school_name: syncClient.getStatus().school_name } };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  // Exporta a PDF un fragmento HTML generado por la interfaz (se renderiza sin JavaScript)
  ipcMain.handle('app:exportPdf', async (event, a) => {
    if (!isAdmin(event)) return { ok: false, error: 'Solo el administrador' };
    const html = String((a && a.html) || '');
    if (!html || html.length > 3e6) return { ok: false, error: 'Contenido inválido' };
    const name = String((a && a.fileName) || 'codigos.pdf').replace(/[^\w.\-]/g, '_');
    let target;
    if (process.env.COOP_EXPORT_DIR) target = path.join(process.env.COOP_EXPORT_DIR, name);
    else {
      const r = await dialog.showSaveDialog(mainWindow, { title: 'Guardar hoja de códigos', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
      if (r.canceled || !r.filePath) return { ok: false, error: 'Cancelado' };
      target = r.filePath;
    }
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
    try {
      const doc = `<!DOCTYPE html><html lang="es-MX"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>Códigos</title><style>body{margin:0}</style></head><body>${html}</body></html>`;
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(doc));
      const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } });
      fs.writeFileSync(target, pdf);
      if (!process.env.COOP_EXPORT_DIR) shell.openPath(target);
      return { ok: true, data: target };
    } catch (e) { return { ok: false, error: e.message }; } finally { win.destroy(); }
  });

  ipcMain.handle('app:openDataFolder', (event) => {
    const s = sessions.get(event.sender.id);
    if (!s || !s.user || s.user.role !== 'admin') return { ok: false };
    shell.showItemInFolder(file);
    return { ok: true };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1000, minHeight: 650,
    title: 'Cooperativa NFC',
    backgroundColor: '#f4f6fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  const wcId = mainWindow.webContents.id;
  mainWindow.on('closed', () => { sessions.delete(wcId); mainWindow = null; });
  // No abrir ventanas nuevas ni navegar fuera de la app
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (process.env.COOP_SMOKE_TEST) {
    mainWindow.webContents.once('did-finish-load', async () => {
      const r = await mainWindow.webContents.executeJavaScript('document.title + "|" + !!window.coop');
      console.log('[smoke] cargado:', r);
      setTimeout(() => app.quit(), 500);
    });
  }
}

const template = [
  { label: 'Archivo', submenu: [{ role: 'quit', label: 'Salir' }] },
  { label: 'Editar', submenu: [{ role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' }, { type: 'separator' }, { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' }, { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' }] },
  { label: 'Ver', submenu: [{ role: 'reload', label: 'Recargar' }, { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }, { type: 'separator' }, { role: 'resetZoom', label: 'Tamaño normal' }, { role: 'zoomIn', label: 'Acercar' }, { role: 'zoomOut', label: 'Alejar' }, { role: 'togglefullscreen', label: 'Pantalla completa' }] },
];
if (process.platform === 'darwin') template.unshift({ label: 'Cooperativa NFC', submenu: [{ role: 'about', label: 'Acerca de' }, { role: 'hide', label: 'Ocultar' }, { role: 'quit', label: 'Salir' }] });

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    try { await init(); } catch (e) {
      dialog.showErrorBox('Error al abrir la base de datos', String(e && e.stack || e));
      app.quit(); return;
    }
    createWindow();
    // Lector NFC PC/SC opcional (ACR122U, etc.). Envía el UID a la ventana por IPC.
    startNfcReader((uid) => { if (mainWindow) mainWindow.webContents.send('nfc:uid', uid); },
      (status) => { lastNfcStatus = status; if (mainWindow) mainWindow.webContents.send('nfc:status', status); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
