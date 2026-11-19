'use strict';
// Prueba de interfaz: el superadministrador elimina una escuela definitivamente (nombre exacto + contraseña),
// con respaldo; la otra escuela queda intacta y las cuentas de la escuela eliminada ya no entran.
// `xvfb-run npx electron scripts/e2e-eliminar-escuela.js` · Capturas 102–103 en docs/capturas/v2.
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
app.whenReady().then(async () => {
  const S = await createServer({ jwtSecret: 'e'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, whatsappSweepMs: 0, env: {} });
  const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const win = new BrowserWindow({ width: 1360, height: 1000, show: false });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon|serviceWorker|sw\.js|400|401|403|404|409|Bad Request|Forbidden|Conflict|Unauthorized|\[push\]/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => win.webContents.executeJavaScript(c);
  const text = () => js('document.body.innerText');
  const expect = async (n, ctx) => { await sleep(600); const t = await text(); if (!t.includes(n)) errors.push(`[${ctx}] falta "${n}"`); };
  const shot = async (n) => { await js(`document.getElementById('toast').innerHTML=''`); await sleep(300); win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('captura:', n); };
  const clickBtn = (t) => js(`(()=>{const b=[...document.querySelectorAll('button,a')].reverse().find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(!b) throw new Error('No hay botón: ${t}'); b.click();})()`);
  const clickInRow = (rowText, t) => js(`(()=>{const rows=[...document.querySelectorAll('tr')].filter(r=>r.innerText.includes(${JSON.stringify(rowText)})).reverse(); if(!rows.length) throw new Error('No hay fila: ${rowText}'); let b=null; for(const r of rows){ b=[...r.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(b) break; } if(!b) throw new Error('No hay botón ${t} en ${rowText}'); b.click();})()`);
  const fill = (vals) => js(`(()=>{const i=[...document.querySelectorAll('.modal input')]; const v=${JSON.stringify(vals)}; v.forEach((x,k)=>{i[k].value=x;});})()`);
  const toastText = () => js(`document.getElementById('toast').innerText`);
  const login = async (u, p) => { await js(`(()=>{const i=document.querySelectorAll('.login input');i[0].value=${JSON.stringify(u)};i[1].value=${JSON.stringify(p)};})()`); await clickBtn('Entrar'); await sleep(900); };
  const logout = async () => { await clickBtn('Cerrar sesión'); await sleep(600); };
  const nav = (v) => js(`document.querySelector('.nav a[data-view="${v}"]').click()`);
  const NAME = 'Colegio Morelos (demo)';
  const exists = () => !!S.db.get('SELECT id FROM schools WHERE id = 1');
  try {
    await win.loadURL(base); await sleep(900);
    // ----- administrador de escuela: no ve la opción -----
    await login('admin', 'admin123');
    if ((await text()).includes('Eliminar escuela')) errors.push('el admin de escuela ve Eliminar escuela');
    await logout();
    // ----- superadministrador -----
    await login('zuki', 'zuki123');
    await nav('instituciones'); await sleep(900);
    await clickInRow(NAME, 'Administrar'); await sleep(1000);
    await expect('Zona de peligro', 'zona de peligro'); await expect('⏸️ Pausar ahora', 'sigue la opción de pausar');
    await clickBtn('🗑️ Eliminar escuela'); await sleep(900);
    await expect('Esto no se puede deshacer', 'aviso'); await expect('Pausar ahora', 'sugerencia de pausar'); await expect('respaldo', 'respaldo');
    // nombre incorrecto
    await fill(['Colegio Morelos', 'zuki123']); await clickBtn('Eliminar escuela para siempre'); await sleep(700);
    if (!exists()) errors.push('borró con nombre incorrecto');
    // contraseña incorrecta
    await fill([NAME, 'mala']); await clickBtn('Eliminar escuela para siempre'); await sleep(1000);
    if (!exists()) errors.push('borró con contraseña incorrecta');
    if (!(await toastText()).includes('Contraseña incorrecta')) errors.push('no avisó contraseña incorrecta');
    await fill([NAME, 'zuki123']);
    await js(`document.activeElement && document.activeElement.blur(); document.querySelector('.modal-body').scrollTop=0`); await sleep(6500); // deja que se vayan los avisos
    await shot('102-eliminar-escuela');
    await clickBtn('Eliminar escuela para siempre'); await sleep(1500);
    if (exists()) errors.push('no eliminó la escuela');
    if (!S.db.get('SELECT id FROM deleted_schools WHERE original_school_id = 1')) errors.push('sin respaldo');
    await expect('Instituto Valladolid (demo)', 'lista con la otra escuela');
    if (await js(`[...document.querySelectorAll('tr')].some(r=>r.innerText.includes(${JSON.stringify(NAME)}))`)) errors.push('la escuela eliminada sigue en la lista');
    await shot('103-escuela-eliminada');
    await logout();
    // ----- las cuentas de la escuela eliminada ya no entran; la otra escuela sí -----
    await login('admin', 'admin123');
    if (await js(`!!document.querySelector('.nav')`)) errors.push('admin de escuela eliminada pudo entrar');
    await login('admin2', 'admin123');
    if (!(await js(`!!document.querySelector('.nav')`))) errors.push('admin2 no pudo entrar');
  } catch (e) { errors.push('excepción: ' + e.message); }
  srv.close();
  if (errors.length) { console.error('E2E ELIMINAR ESCUELA FALLÓ:\n' + errors.join('\n')); app.exit(1); } else { console.log('E2E ELIMINAR ESCUELA OK'); app.exit(0); }
});
