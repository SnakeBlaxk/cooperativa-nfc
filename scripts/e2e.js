'use strict';
// Prueba de humo de la interfaz: `npx electron scripts/e2e.js`
// Inicia la app con una base temporal, recorre las pantallas de cada rol, hace una venta y
// guarda capturas en ./e2e-shots. Termina con código 1 si hay errores.
const path = require('path'); const fs = require('fs'); const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-e2e-'));
process.env.COOP_DB_PATH = path.join(tmp, 'coop.db');
process.env.COOP_SYNC_INTERVAL_MS = '600000';
process.env.COOP_EXPORT_DIR = tmp;
const { app, BrowserWindow } = require('electron');
require('../src/main/main.js');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return; // ignora ventanas auxiliares (p. ej. la oculta que genera el PDF)
  started = true;
  win.webContents.on('console-message', (_ev, level, msg) => { if (level >= 2) errors.push('consola: ' + msg); });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const shot = async (n) => { await sleep(400); const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(shots, n + '.png'), img.toPNG()); };
    const text = () => js('document.body.innerText');
    const NAVMAP = { 'Productos': 'productos', 'Tarjetas': 'tarjetas', 'Alumnos y padres': 'alumnos', 'Movimientos': 'movimientos', 'Personal': 'usuarios', 'Ajustes': 'ajustes', 'Recargas': 'recargas', 'Cobrar': 'pos', 'Programar tarjetas': 'programar' };
    const clickNav = (label) => js(`document.querySelector('.nav a[data-view="${NAVMAP[label]}"]').click()`);
    const login = async (u, p) => {
      await js(`(()=>{const i=document.querySelectorAll('.login input');i[0].value=${JSON.stringify(u)};i[1].value=${JSON.stringify(p)};document.querySelector('.login').requestSubmit();})()`);
      await sleep(500);
    };
    const logout = async () => { await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cerrar sesión').click()`); await sleep(300); };
    const expect = async (needle, ctx) => { const t = await text(); if (!t.toLowerCase().includes(needle.toLowerCase())) errors.push(`[${ctx}] no se encontró "${needle}"`); };
    try {
      await sleep(500); await shot('60-escritorio-login'); { const t0 = await text(); if (t0.includes('admin123') || t0.includes('Olvid')) errors.push('login de escritorio muestra credenciales demo u olvidé'); }
      await login('admin', 'admin123'); await expect('Resumen de la cooperativa', 'admin'); await expect('Ventas por día', 'admin'); await shot('61-escritorio-resumen');
      for (const [nav, needle, n] of [['Productos', 'Coca-Cola', null], ['Tarjetas', '04A1B2C3D4E5F6', null], ['Alumnos y padres', 'Valentina', null], ['Movimientos', 'rechazado', null], ['Personal', 'cajero', null], ['Ajustes', 'Crear respaldo', '62-escritorio-ajustes'], ['Recargas', 'Últimas recargas', '63-escritorio-recargas']]) {
        await clickNav(nav); await sleep(500); await expect(needle, nav); if (n) await shot(n);
      }
      { const t1 = await text(); if (t1.includes('Cambiar mi contraseña')) errors.push('el admin de escritorio ve cambiar contraseña'); }
      { const r = await js(`window.coop.call('changePassword', { current: 'admin123', next: 'OtraClave2026' })`); if (r.ok) errors.push('el admin de escritorio pudo cambiar su contraseña'); }
      // POS: venta aprobada y rechazada por producto prohibido
      await clickNav('Cobrar'); await sleep(500);
      await js(`(()=>{const i=document.querySelector('.uidbox input');i.value='04A1B2C3D4E5F6';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
      await sleep(500); await expect('Sofía Hernández', 'POS lectura');
      await js(`[...document.querySelectorAll('.pbtn')].find(b=>b.textContent.includes('Manzana')).click()`);
      await shot('64-escritorio-cobrar-carrito');
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Cobrar (F2)')).click()`); await sleep(600);
      await expect('Venta aprobada', 'POS venta'); await shot('65-escritorio-venta-aprobada');
      // rechazo: simulamos lector teclado USB (ráfaga de teclas sin foco en input)
      await js(`document.activeElement.blur()`);
      await js(`(()=>{for(const k of '04A1B2C3D4E5F6'.split('').concat(['Enter'])) document.dispatchEvent(new KeyboardEvent('keydown',{key:k,bubbles:true}));})()`);
      await sleep(500); await expect('Sofía Hernández', 'POS lector teclado');
      await js(`[...document.querySelectorAll('.pbtn')].find(b=>b.textContent.includes('Coca-Cola')).click()`);
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Cobrar (F2)')).click()`); await sleep(600);
      await expect('Producto prohibido por el tutor: Coca-Cola 355 ml', 'POS rechazo'); await shot('66-escritorio-venta-rechazada');
      await logout();
      // Tutor
      await login('maria', 'tutor123'); await expect('Mis hijos', 'tutor'); await expect('Diego Hernández', 'tutor'); 
      const t = await text(); if (t.includes('Valentina')) errors.push('El tutor ve un alumno ajeno');
      await js(`[...document.querySelectorAll('.kid')].find(k=>k.textContent.includes('Sofía')).click()`); await sleep(600); await expect('Últimos movimientos', 'tutor detalle'); await expect('Producto prohibido', 'tutor ve rechazo'); await shot('67-escritorio-padres-detalle');
      for (const [tab, needle, n] of [['Límites de gasto', 'Máximo por día', '13-tutor-limites'], ['Productos prohibidos', 'Categorías prohibidas', '14-tutor-prohibidos'], ['Tarjeta y perfil', 'Bloquear temporalmente', '15-tutor-tarjeta']]) {
        await js(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent===${JSON.stringify(tab)}).click()`); await sleep(500); await expect(needle, tab);
      }
      await logout();
      await login('cajero', 'cajero123'); await expect('Cobrar', 'cajero'); const tc = await text(); if (tc.includes('Resumen de la cooperativa')) errors.push('cajero ve el panel de admin');
      await logout();
      // Sincronización con un servidor real (vacío) levantado en esta prueba
      const { createServer } = require('../server/app');
      const S = await createServer({ jwtSecret: 'e'.repeat(40), seed: false, bootstrapAdmin: { username: 'admin', password: 'ServidorAdmin1' }, mailer: { send: async () => {} } });
      S.db.run('UPDATE users SET must_change_password = 0');
      const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
      const url = `http://127.0.0.1:${srv.address().port}`;
      await login('admin', 'admin123'); await clickNav('Ajustes'); await sleep(600);
      await expect('Solo local', 'indicador sin servidor');
      await js(`(()=>{const c=[...document.querySelectorAll('.card')].find(x=>x.textContent.includes('Servidor en la nube y sincronización'));const i=c.querySelectorAll('input');i[0].value=${JSON.stringify(url)};i[1].value='admin';i[2].value='ServidorAdmin1';[...c.querySelectorAll('button')].find(b=>b.textContent==='Vincular este equipo').click();})()`);
      await sleep(2500); await expect('Sincronizado', 'vincular y sincronizar'); await shot('68-escritorio-sincronizado');
      const nCards = S.db.get('SELECT COUNT(*) AS n FROM cards').n; if (nCards !== 4) errors.push('el servidor no recibió las tarjetas: ' + nCards);
      // venta en la caja -> saldo en el servidor tras "Sincronizar ahora"
      const sbBefore = S.db.get("SELECT balance_cents AS b FROM cards WHERE uid = '04C3D4E5F6A7B8'").b;
      await clickNav('Cobrar'); await sleep(500);
      await js(`(()=>{const i=document.querySelector('.uidbox input');i.value='04C3D4E5F6A7B8';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`); await sleep(500);
      await js(`[...document.querySelectorAll('.pbtn')].find(b=>b.textContent.includes('Manzana')).click()`);
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Cobrar (F2)')).click()`); await sleep(600);
      await js(`document.getElementById('syncind').click()`); await sleep(2000);
      const local = await js(`document.body.innerText`);
      const sb = S.db.get("SELECT balance_cents AS b FROM cards WHERE uid = '04C3D4E5F6A7B8'").b;
      if (!local.includes('Sincronizado')) errors.push('indicador no muestra Sincronizado');
      if (sb !== sbBefore - 800) errors.push('saldo del servidor no refleja la venta: ' + sb);
      // ----- Programar tarjetas: lectura en lote, asignación y hoja de códigos -----
      for (const n of ['Ana López', 'Bruno Díaz', 'Carla Ruiz']) await js(`window.coop.call('createChild', { full_name: ${JSON.stringify(n)}, grade: '1° A' })`);
      await clickNav('Programar tarjetas'); await sleep(600); await expect('Acerque las tarjetas', 'programar');
      for (const uid of ['E2E0000000000A', 'E2E0000000000B', 'E2E0000000000C', '04A1B2C3D4E5F6']) { win.webContents.send('nfc:uid', uid); await sleep(350); }
      await sleep(400); await expect('3 nuevas en esta sesión', 'lectura en lote'); await expect('ya está registrada', 'duplicado avisado'); await shot('69-escritorio-programar-leer');
      await js(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.startsWith('2.')).click()`); await sleep(600);
      await expect('Alumnos sin tarjeta (3)', 'asignar'); 
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Asignar seleccionadas').click()`); await sleep(300);
      await js(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Confirmar').click()`); await sleep(1200);
      const kids = await js(`window.coop.call('listChildren').then(r=>r.data.filter(c=>c.grade==='1° A').map(c=>c.card && c.card.uid).join(','))`);
      if (kids !== '04D9E0F1A2B3C4,E2E0000000000A,E2E0000000000B') errors.push('asignación en orden incorrecta: ' + kids);
      await js(`[...document.querySelectorAll('.tabs button')].find(b=>b.textContent.startsWith('3.')).click()`); await sleep(600);
      await expect('Caja vinculada', 'hoja: caja vinculada');
      await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('Generar hoja')).click()`); await sleep(3000);
      await expect('COOP-', 'hoja con códigos'); await expect('Carla Ruiz', 'hoja alumno'); 
      await js(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent==='Guardar PDF…').click()`); await sleep(3000);
      const pdfs = fs.readdirSync(tmp).filter((f) => f.endsWith('.pdf'));
      if (!pdfs.length || fs.statSync(path.join(tmp, pdfs[0])).size < 2000) errors.push('no se generó el PDF de códigos');
      else void 0;
      const inv = S.db.get('SELECT COUNT(*) AS n FROM invitations').n; if (inv < 3) errors.push('el servidor no generó invitaciones: ' + inv);
      srv.close();
    } catch (e) { errors.push('excepción: ' + e.message); }
    console.log(errors.length ? 'E2E FALLÓ:\n' + errors.join('\n') : 'E2E OK — capturas en ' + shots);
    app.exit(errors.length ? 1 : 0);
  });
});
