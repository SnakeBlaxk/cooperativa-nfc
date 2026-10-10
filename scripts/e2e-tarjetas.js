'use strict';
// Prueba de interfaz: inventario de tarjetas del superadministrador (lista blanca) y rechazo de tarjeta no autorizada.
// `xvfb-run npx electron scripts/e2e-tarjetas.js` · Capturas 95–96 en docs/capturas/v2.
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
app.whenReady().then(async () => {
  const S = await createServer({ jwtSecret: 't'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, env: {} });
  const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const win = new BrowserWindow({ width: 1360, height: 1000, show: false });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon|serviceWorker|sw\.js|403|Forbidden|\[push\]/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => win.webContents.executeJavaScript(c);
  const text = () => js('document.body.innerText');
  const expect = async (n, ctx) => { await sleep(600); const t = await text(); if (!t.includes(n)) errors.push(`[${ctx}] falta "${n}"`); };
  const shot = async (n) => { await js(`document.getElementById('toast').innerHTML=''`); await sleep(300); win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('captura:', n); };
  const clickBtn = (t) => js(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(!b) throw new Error('No hay botón: ${t}'); b.click();})()`);
  const login = async (u, p) => { await js(`(()=>{const i=document.querySelectorAll('.login input');i[0].value=${JSON.stringify(u)};i[1].value=${JSON.stringify(p)};})()`); await clickBtn('Entrar'); await sleep(900); };
  const logout = async () => { await clickBtn('Cerrar sesión'); await sleep(600); };
  const nav = (v) => js(`document.querySelector('.nav a[data-view="${v}"]').click()`);
  // Simula el lector USB tipo teclado: escribe el UID en el campo enfocado y presiona Enter
  const scan = async (uid) => { await js(`(()=>{const i=document.activeElement && document.activeElement.matches('[data-uid-input]') ? document.activeElement : document.querySelector('[data-uid-input]'); i.focus(); i.value=${JSON.stringify(uid)}; i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`); await sleep(500); };
  try {
    await win.loadURL(base); await sleep(900);
    // ----- superadministrador: Mis tarjetas -----
    await login('zuki', 'zuki123');
    await nav('inventario'); await expect('Mis tarjetas (inventario)', 'vista');
    for (const u of ['0001234501', '0001234502', '0001234503', '0001234502']) await scan(u);
    await expect('ya estaba en el inventario', 'repetida');
    if (S.db.get("SELECT COUNT(*) AS n FROM card_stock WHERE uid LIKE '00012345%'").n !== 3) errors.push('alta continua');
    await js(`(()=>{const t=document.querySelector('textarea'); t.value='UID\\n0001234504\\n0001234505\\n000-123-4506\\n0001234507\\n0001234508\\n0009000001';})()`);
    await clickBtn('Agregar lista'); await sleep(900);
    await expect('Agregadas: 6', 'lote'); await clickBtn('Aceptar'); await sleep(500);
    // entregar rango 0001234501..0001234506 a la escuela demo 1
    await clickBtn('🏫 Entregar rango'); await sleep(400);
    const school = S.db.get('SELECT id, name FROM schools ORDER BY id LIMIT 1');
    await js(`(()=>{const m=document.querySelector('.modal'); m.querySelector('select').value='${school.id}'; const i=m.querySelectorAll('input'); i[0].value='0001234501'; i[1].value='0001234506';})()`);
    await clickBtn('Entregar'); await sleep(1200);
    if (S.db.get("SELECT COUNT(*) AS n FROM card_stock WHERE school_id = ? AND uid BETWEEN '0001234501' AND '0001234506'", [school.id]).n !== 6) errors.push('entrega por rango');
    await expect('Entregada a escuela', 'estado');
    await js('window.scrollTo(0,0)');
    await shot('95-super-mis-tarjetas');
    await logout();
    // ----- administrador de escuela: tarjeta no autorizada -----
    await login('admin', 'admin123');
    await nav('tarjetas'); await expect('Tarjetas de Zuki Company para su escuela', 'lista de la escuela'); await expect('0001234503', 'tarjeta entregada');
    await scan('0009000001'); // está en el inventario pero no fue entregada a esta escuela
    await expect('Tarjeta no autorizada. Solicite tarjetas a Zuki Company.', 'rechazo');
    if (!S.db.get("SELECT id FROM alerts WHERE kind = 'tarjeta_no_autorizada'")) errors.push('no se creó la alerta');
    await js('window.scrollTo(0,0)');
    await shot('96-tarjeta-no-autorizada');
    await scan('0001234503'); await sleep(600);
    if (!S.db.get("SELECT id FROM cards WHERE uid = '0001234503'")) errors.push('no registró la tarjeta autorizada');
    await logout();
    await login('zuki', 'zuki123'); await nav('alertas'); await expect('Tarjeta no autorizada', 'alerta superadmin');
  } catch (e) { errors.push('excepción: ' + e.message); }
  srv.close();
  if (errors.length) { console.error('E2E TARJETAS FALLÓ:\n' + errors.join('\n')); app.exit(1); } else { console.log('E2E TARJETAS OK'); app.exit(0); }
});
