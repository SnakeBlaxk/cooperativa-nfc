'use strict';
// Prueba de humo de la PWA (diseño v2): `npx electron scripts/e2e-web.js`
// Levanta el servidor con datos de demostración y guarda capturas en docs/capturas/v2/.
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
app.whenReady().then(async () => {
  const mailer = consoleMailer(() => {});
  const { app: web } = await createServer({ jwtSecret: 'z'.repeat(40), mailer });
  const srv = await new Promise((r) => { const s = web.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body, token) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })).json();
  const win = new BrowserWindow({ width: 1360, height: 900, show: false });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon|serviceWorker|sw\.js/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => win.webContents.executeJavaScript(c);
  const text = () => js('document.body.innerText');
  const expect = async (n, ctx) => { await sleep(600); const t = await text(); if (!t.toLowerCase().includes(n.toLowerCase())) errors.push(`[${ctx}] falta "${n}" · pantalla: ${t.slice(0, 160).replace(/\s+/g, ' ')}`); };
  const refute = async (n, ctx) => { const t = await text(); if (t.includes(n)) errors.push(`[${ctx}] no debería aparecer "${n}"`); };
  // Captura de página completa: agranda la ventana a la altura del contenido
  const shot = async (n, w) => {
    await sleep(350);
    const width = w || win.getSize()[0];
    const hgt = await js(`Math.max(document.body.scrollHeight, (document.querySelector('.main')||{}).scrollHeight||0, (document.querySelector('.modal')||{}).scrollHeight||0) + 40`);
    const prev = win.getSize(); win.setSize(width, Math.min(Math.max(hgt, 760), 4000)); await sleep(400);
    fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(prev[0], prev[1]); await sleep(150);
  };
  const setInputs = (vals, sel = '.login input') => js(`(()=>{const v=${JSON.stringify(vals)};const i=[...document.querySelectorAll(${JSON.stringify(sel)})];v.forEach((x,k)=>{i[k].value=x;});})()`);
  const clickBtn = (t) => js(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(!b) throw new Error('No hay botón ${t.replace(/'/g, '')}'); b.click();})()`);
  const nav = (v) => js(`document.querySelector('.nav a[data-view="${v}"]').click()`);
  const closeModal = () => js(`document.querySelectorAll('.modal-bg').forEach(m=>m.remove())`);
  const login = async (u, p) => { await setInputs([u, p]); await clickBtn('Entrar'); await sleep(900); };
  const logout = async () => { await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cerrar sesión').click()`); await sleep(600); };
  try {
    await win.loadURL(base); await sleep(900);
    await expect('tengo un código de invitación', 'login'); await refute('admin123', 'login sin credenciales demo'); await refute('Olvidaste', 'login sin olvidé');
    await expect('Pida una nueva a la administración', 'nota olvidé');
    await shot('01-login');
    win.setSize(400, 860); await sleep(300); await shot('02-login-movil', 400); win.setSize(1360, 900);

    // ----- superadministrador -----
    await login('zuki', 'zuki123'); await expect('Escuelas', 'superadmin'); await expect('Colegio Morelos (demo)', 'lista escuelas');
    await shot('10-super-escuelas');
    await js(`[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('Colegio Morelos')).querySelector('button').click()`);
    await expect('Personal de la escuela', 'detalle escuela'); await shot('11-super-escuela-detalle');
    await nav('cuentas'); await expect('Jerarquía', 'cuentas'); await expect('Superadministrador', 'cuentas superadmin'); await expect('Protegida', 'superadmin protegido');
    await shot('12-super-cuentas');
    await js(`[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('cajero')&&r.textContent.includes('Colegio Morelos')).querySelector('button').click()`); await sleep(400);
    await clickBtn('Asignar contraseña'); await expect('Se muestra solo esta vez', 'contraseña mostrada'); await expect('Copiar', 'botón copiar');
    await shot('13-super-contrasena-asignada');
    const newPass = await js(`document.querySelector('[data-pass]').textContent`);
    if (!newPass || newPass.length < 12) errors.push('[contraseña] no se generó');
    await clickBtn('Listo, ya la copié'); await sleep(500);
    // Seguridad
    const a = await post('/api/auth/login', { identifier: 'admin', password: 'admin123' });
    const cards = await post('/api/rpc/listCards', {}, a.data.access_token);
    const card = cards.data.find((c) => c.child_id && c.status === 'activa');
    await post('/api/rpc/recharge', { uid: card.uid, amount_cents: 250000, note: 'prueba' }, a.data.access_token); // recarga grande -> alerta
    await post('/api/rpc/deleteProduct', { id: (await post('/api/rpc/listProducts', {}, a.data.access_token)).data[0].id }, a.data.access_token); // borrado -> papelera
    await nav('seguridad'); await expect('ALERTA ROJA', 'seguridad'); await expect('Congelar TODAS las recargas', 'seguridad global'); await expect('Papelera', 'papelera');
    await expect('Recarga grande', 'recarga sospechosa listada');
    await shot('20-super-seguridad');
    await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Límites y horario')).click()`); await sleep(400); await shot('21-super-limites'); await closeModal();
    await js(`document.querySelector('.redbtn').click()`); await sleep(400); await setInputs(['ALERTA ROJA'], '.modal input'); await shot('22-super-alerta-roja-confirmar');
    await clickBtn('ACTIVAR ALERTA ROJA'); await expect('ALERTA ROJA ACTIVA', 'lockdown'); await shot('23-super-alerta-roja-activa');
    const blocked = await post('/api/auth/login', { identifier: 'admin', password: 'admin123' });
    if (blocked.ok) errors.push('[lockdown] el admin pudo entrar');
    await clickBtn('🔓 Desbloquear el sistema'); await sleep(400); await js(`[...document.querySelectorAll('.modal button')].at(-1).click()`); await sleep(800);
    await refute('ALERTA ROJA ACTIVA', 'unlock');
    await nav('alertas'); await expect('Recarga grande', 'alertas'); await shot('24-super-alertas');
    await nav('bitacora'); await expect('ALERTA ROJA', 'bitácora'); await expect('Contraseña asignada', 'bitácora contraseña'); await shot('25-super-bitacora');
    await nav('ajustes'); await expect('Cambiar mi contraseña', 'superadmin cambia la suya'); await shot('26-super-mi-cuenta');
    win.setSize(400, 900); await sleep(400); await nav('seguridad'); await sleep(600); await shot('27-super-seguridad-movil', 400); win.setSize(1360, 900); await sleep(300);
    await logout();

    // ----- administrador de escuela -----
    await login('admin', 'admin123'); await expect('Resumen de la cooperativa', 'admin');
    await shot('30-escuela-resumen');
    await nav('alumnos'); await expect('Alumnos y padres', 'alumnos'); await shot('31-escuela-alumnos');
    await nav('productos'); await expect('Productos', 'productos'); await shot('32-escuela-productos');
    await nav('tarjetas'); await shot('33-escuela-tarjetas');
    await nav('movimientos'); await shot('34-escuela-movimientos');
    await nav('usuarios'); await expect('Personal', 'usuarios'); await shot('35-escuela-personal');
    await nav('ajustes'); await refute('Cambiar mi contraseña', 'admin sin cambio de contraseña'); await expect('solo las cambia el administrador de la plataforma', 'aviso contraseña');
    await shot('36-escuela-ajustes');
    const cp = await post('/api/auth/change-password', { current: 'admin123', next: 'OtraClave2026' }, (await post('/api/auth/login', { identifier: 'admin', password: 'admin123' })).data.access_token);
    if (cp.ok) errors.push('[política] el admin pudo cambiar su contraseña');
    await logout();

    // ----- cajero -----
    await login('cajero', newPass); await expect('Cobrar', 'cajero con la contraseña asignada por el superadmin');
    await js(`(()=>{const i=document.querySelector('.uidbox input'); i.value=${JSON.stringify(card.uid)}; i.parentElement.querySelector('button').click();})()`); await sleep(800);
    await js(`(()=>{const p=document.querySelector('.prod'); if(p) p.click();})()`); await sleep(400);
    await shot('40-cajero-cobrar');
    await nav('recargas'); await expect('Monto a recargar', 'recargas'); await shot('41-cajero-recargas');
    await logout();

    // ----- padres -----
    a.data = (await post('/api/auth/login', { identifier: 'admin', password: 'admin123' })).data; // la alerta roja cerró las sesiones anteriores
    const t = await post('/api/admin/tutors', { full_name: 'Raúl Díaz', phone: '4439998877' }, a.data.access_token);
    await login('4439998877', t.data.temporary_password); await expect('Mis hijos', 'tutor entra sin cambio obligatorio');
    await logout();
    await login('maria', 'tutor123'); await expect('Mis hijos', 'padres'); await shot('50-padres-hijos');
    await js(`(()=>{const c=document.querySelector('.card.kid'); if(c) c.click();})()`); await sleep(800); await shot('51-padres-detalle');
    await nav('movimientos'); await shot('52-padres-historial');
    win.setSize(400, 900); await sleep(300); await nav('hijos'); await sleep(700); await shot('53-padres-movil', 400); win.setSize(1360, 900); await sleep(300);
    await logout();
    // registro con invitación
    const child = await post('/api/rpc/createChild', { full_name: 'Emilia Torres', grade: '2° A' }, a.data.access_token);
    const inv = await post('/api/admin/invitations', { child_id: child.data.id }, a.data.access_token);
    await clickBtn('Soy padre/madre: tengo un código de invitación'); await sleep(400); await shot('03-registro');
    await setInputs([inv.data.code, 'Ana Torres', 'ana@example.com', '', 'ClaveAna2026', 'ClaveAna2026']); await clickBtn('Crear cuenta');
    await expect('Emilia Torres', 'registro -> mis hijos');
    await win.reload(); await sleep(1200); await expect('Emilia Torres', 'sesión persiste con refresh token');
  } catch (e) { errors.push('excepción: ' + e.message); }
  console.log(errors.length ? 'E2E WEB FALLÓ:\n' + errors.join('\n') : 'E2E WEB OK');
  srv.close(); app.exit(errors.length ? 1 : 0);
});
