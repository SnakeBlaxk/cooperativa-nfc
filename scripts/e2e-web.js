'use strict';
// Prueba de humo de la PWA: `npx electron scripts/e2e-web.js` (levanta el servidor en un puerto libre).
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'e2e-shots'); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
app.whenReady().then(async () => {
  const mailer = consoleMailer(() => {});
  const { app: web } = await createServer({ jwtSecret: 'z'.repeat(40), mailer });
  const srv = await new Promise((r) => { const s = web.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body, token) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })).json();
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => win.webContents.executeJavaScript(c);
  const text = () => js('document.body.innerText');
  const expect = async (n, ctx) => { await sleep(500); const t = await text(); if (!t.includes(n)) errors.push(`[${ctx}] falta "${n}"`); };
  const shot = async (n) => { await sleep(300); fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const setInputs = (vals) => js(`(()=>{const v=${JSON.stringify(vals)};const i=[...document.querySelectorAll('.login input')];v.forEach((x,k)=>{i[k].value=x;});})()`);
  const clickBtn = (t) => js(`[...document.querySelectorAll('button,a')].find(b=>b.textContent.trim()===${JSON.stringify(t)}).click()`);
  try {
    await win.loadURL(base); await sleep(800); await shot('w01-login');
    await expect('Tengo un código de invitación', 'login web');
    // admin
    await setInputs(['admin', 'admin123']); await clickBtn('Entrar'); await expect('Panel de la cooperativa', 'admin web');
    await js(`[...document.querySelectorAll('.nav a')].find(a=>a.textContent==='Tutores y alumnos').click()`); await expect('Invitación', 'botón invitación');
    await js(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Invitación').click()`); await expect('COOP-', 'código'); await shot('w02-invitacion');
    await js(`document.querySelector('.modal-bg').remove()`);
    await clickBtn('Cerrar sesión'); await sleep(500);
    // registro con invitación
    const a = await post('/api/auth/login', { identifier: 'admin', password: 'admin123' });
    const child = await post('/api/rpc/createChild', { full_name: 'Emilia Torres', grade: '2° A' }, a.data.access_token);
    const inv = await post('/api/admin/invitations', { child_id: child.data.id }, a.data.access_token);
    await clickBtn('Tengo un código de invitación'); await sleep(400); await shot('w03-registro');
    await setInputs([inv.data.code, 'Ana Torres', 'ana@example.com', '', 'ClaveAna2026', 'ClaveAna2026']); await clickBtn('Crear cuenta');
    await expect('Emilia Torres', 'registro -> mis hijos'); await shot('w04-tutor-registrado');
    await clickBtn('Cerrar sesión'); await sleep(500);
    // contraseña temporal -> cambio obligatorio
    const t = await post('/api/admin/tutors', { full_name: 'Raúl Díaz', phone: '4439998877' }, a.data.access_token);
    await setInputs(['4439998877', t.data.temporary_password]); await clickBtn('Entrar'); await expect('Cambia tu contraseña', 'forzar cambio'); await shot('w05-cambio-obligatorio');
    await setInputs([t.data.temporary_password, 'RaulNueva1', 'RaulNueva1']); await clickBtn('Guardar y continuar'); await expect('Mis hijos', 'tras cambio');
    // la sesión persiste al recargar (refresh token)
    await win.reload(); await sleep(1200); await expect('Mis hijos', 'recarga con refresh token');
    await clickBtn('Cerrar sesión'); await sleep(500);
    // olvidé contraseña
    await clickBtn('¿Olvidaste tu contraseña?'); await sleep(300); await setInputs(['ana@example.com']); await clickBtn('Enviar enlace'); await expect('Si la cuenta existe', 'olvidé');
    const tok = mailer.outbox.at(-1).token;
    await win.loadURL(base + '/?reset=' + tok); await sleep(800); await setInputs(['AnaNueva2026', 'AnaNueva2026']); await clickBtn('Guardar contraseña'); await expect('Contraseña actualizada', 'reset');
    await sleep(1800); await setInputs(['ana@example.com', 'AnaNueva2026']); await clickBtn('Entrar'); await expect('Emilia Torres', 'login tras reset');
    win.setSize(400, 800); await sleep(500); await shot('w06-movil');
    await clickBtn('Cerrar sesión'); await sleep(500);
    // tutora con hijos en dos escuelas (celular)
    win.setSize(400, 1300); await sleep(300);
    await setInputs(['maria', 'tutor123']); await clickBtn('Entrar'); await expect('Instituto Valladolid', 'tutor multi-escuela'); await sleep(500); await shot('w07-tutor-dos-escuelas-movil');
    await clickBtn('Cerrar sesión'); await sleep(500);
    // superadministrador (Zuki Company): celular
    await setInputs(['zuki', 'zuki123']); await clickBtn('Entrar'); await expect('Instituciones', 'superadmin'); await expect('Colegio Morelos (demo)', 'lista escuelas');
    win.setSize(400, 1500); await sleep(600); await shot('w08-superadmin-movil');
    await js(`window.scrollTo(0, 0); document.querySelector('.main').scrollTop = 0; [...document.querySelectorAll('button')].find(b=>b.textContent==='Administrar').click()`);
    await expect('Personal de la escuela', 'detalle escuela'); await shot('w09-superadmin-escuela-movil');
    // escritorio / tablet horizontal
    win.setSize(1280, 900); await sleep(500);
    await js(`[...document.querySelectorAll('.nav a')].find(a=>a.textContent==='Instituciones').click()`); await expect('Saldo en tarjetas', 'totales'); await shot('w10-superadmin-escritorio');
    await clickBtn('+ Nueva escuela'); await sleep(300);
    await js(`(()=>{const m=document.querySelector('.modal');const i=[...m.querySelectorAll('input')];i[0].value='Escuela Primaria Hidalgo';i[1].value='Profra. Laura Gil';i[2].value='4435556677';i[4].value='admin.hidalgo';i[5].value='Laura Gil';m.querySelector('textarea').value='Prueba 30 días, después $1,200/mes';})()`);
    await shot('w11-superadmin-nueva-escuela');
    await clickBtn('Crear escuela'); await expect('Contraseña temporal', 'alta escuela'); await shot('w12-superadmin-temporal');
    await clickBtn('Listo'); await expect('Escuela Primaria Hidalgo', 'escuela en lista');
    await js(`[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('Instituto Valladolid')).querySelector('button').click()`);
    await expect('Cajas (equipos de escritorio)', 'detalle escritorio'); await shot('w13-superadmin-escuela-escritorio');
    await clickBtn('Generar hoja para alumnos sin tutor'); await sleep(800);
    const sheetTxt = await text(); if (!sheetTxt.includes('Códigos de activación') && !sheetTxt.includes('ya tienen padre')) errors.push('[hoja códigos] no apareció');
    if (sheetTxt.includes('Códigos de activación')) await shot('w14-superadmin-hoja-codigos');
    win.setSize(820, 1100); await sleep(500); await js(`document.querySelector('.modal-bg') && document.querySelector('.modal-bg').remove()`); await shot('w15-superadmin-tablet');
  } catch (e) { errors.push('excepción: ' + e.message); }
  console.log(errors.length ? 'E2E WEB FALLÓ:\n' + errors.join('\n') : 'E2E WEB OK');
  srv.close(); app.exit(errors.length ? 1 : 0);
});
