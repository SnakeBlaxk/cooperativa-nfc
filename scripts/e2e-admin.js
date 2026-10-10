'use strict';
// Prueba de interfaz (PWA): editar cuentas (superadmin), Cuentas en iPad vertical, asignar tarjeta con lector
// USB tipo teclado y límites/prohibidos solo lectura para la escuela. `xvfb-run npx electron scripts/e2e-admin.js`
// Capturas: 81-super-editar-cuenta, 84-super-cuentas-ipad, 82-asignar-tarjeta, 85-admin-limites-solo-lectura.
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
app.whenReady().then(async () => {
  const S = await createServer({ jwtSecret: 'w'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const win = new BrowserWindow({ width: 1360, height: 900, show: false });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon|serviceWorker|sw\.js/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => win.webContents.executeJavaScript(c);
  const text = () => js('document.body.innerText');
  const expect = async (n, ctx) => { await sleep(600); const t = await text(); if (!t.includes(n)) errors.push(`[${ctx}] falta "${n}"`); };
  const refute = async (n, ctx) => { const t = await text(); if (t.includes(n)) errors.push(`[${ctx}] no debería aparecer "${n}"`); };
  const shot = async (n) => { await js(`document.getElementById('toast').innerHTML=''`); await sleep(300); win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('captura:', n); };
  const clickBtn = (t) => js(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(!b) throw new Error('No hay botón'); b.click();})()`);
  const login = async (u, p) => { await js(`(()=>{const i=document.querySelectorAll('.login input');i[0].value=${JSON.stringify(u)};i[1].value=${JSON.stringify(p)};})()`); await clickBtn('Entrar'); await sleep(900); };
  const logout = async () => { await clickBtn('Cerrar sesión'); await sleep(600); };
  const nav = (v) => js(`document.querySelector('.nav a[data-view="${v}"]').click()`);
  const typeKeys = async (s) => { for (const ch of s) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(15); } win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }); };
  try {
    await win.loadURL(base); await sleep(900);
    // ----- superadmin: editar cuenta de padre/tutor -----
    await login('zuki', 'zuki123'); await nav('cuentas'); await expect('Jerarquía', 'cuentas');
    await js(`[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('María Hernández')).querySelectorAll('button')[0].click()`);
    await expect('Editar cuenta', 'modal editar'); await expect('Alumnos vinculados (hijos)', 'hijos del tutor'); await expect('Sofía Hernández', 'hijo vinculado');
    await js(`(()=>{const s=[...document.querySelectorAll('.modal input')].find(i=>i.placeholder.startsWith('Buscar alumno')); s.value='Valentina'; s.dispatchEvent(new Event('input'));})()`);
    await sleep(900); await expect('Valentina Pérez', 'búsqueda de alumno');
    await shot('81-super-editar-cuenta');
    await js(`[...document.querySelectorAll('.modal button')].find(b=>b.textContent.trim()==='Vincular').click()`); await sleep(300);
    await js(`(()=>{const i=document.querySelector('.modal input'); i.value='María Hernández López';})()`);
    await clickBtn('Guardar cambios'); await expect('Cuenta actualizada', 'guardar cuenta');
    const maria = S.db.get("SELECT id, full_name FROM users WHERE username = 'maria'");
    if (maria.full_name !== 'María Hernández López') errors.push('no se guardó el nombre');
    if (S.db.all('SELECT id FROM children WHERE tutor_id = ?', [maria.id]).length < 4) errors.push('no se vinculó el alumno');
    if (!S.db.get("SELECT id FROM audit_log WHERE action = 'cuenta_editada'")) errors.push('sin bitácora');
    // duplicado
    await js(`[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('Cajera Rosa')).querySelectorAll('button')[0].click()`); await sleep(700);
    await js(`(()=>{const i=document.querySelectorAll('.modal input')[1]; i.value='admin';})()`);
    await clickBtn('Guardar cambios'); await expect('Ese nombre de usuario ya existe', 'usuario duplicado');
    await js(`document.querySelectorAll('.modal-bg').forEach(m=>m.remove())`);
    // iPad vertical (768 px): tarjetas, sin desbordar y con botones visibles
    win.setSize(768, 1024); await sleep(700);
    const ov = await js(`(()=>{const w=document.querySelector('.tablewrap'); const b=[...document.querySelectorAll('.tablewrap button')].filter(x=>x.textContent.includes('Editar')); return { over: w.scrollWidth > w.clientWidth + 2, hidden: b.filter(x=>{const r=x.getBoundingClientRect(); return r.right > window.innerWidth || r.width === 0;}).length, n: b.length };})()`);
    if (ov.over || ov.hidden || !ov.n) errors.push('Cuentas en iPad: ' + JSON.stringify(ov));
    await js(`document.querySelectorAll('.tablewrap tr')[2].scrollIntoView({block:'start'})`);
    win.setSize(768, 1025); await sleep(500); win.setSize(768, 1024); await sleep(500); // repinta la ventana oculta
    await shot('84-super-cuentas-ipad');
    win.setSize(1360, 900); await sleep(300);
    await logout();
    // ----- admin: asignar tarjeta con lector USB tipo teclado -----
    await login('admin', 'admin123');
    await js(`(async()=>{})()`);
    const kid = S.db.get("SELECT id FROM children WHERE school_id = (SELECT school_id FROM users WHERE username='admin') AND id NOT IN (SELECT child_id FROM cards WHERE child_id IS NOT NULL AND status IN ('activa','bloqueada'))");
    let kidId = kid && kid.id;
    if (!kidId) {
      await nav('alumnos'); await sleep(600);
      kidId = S.svc.createChild(S.svc.login('admin', 'admin123'), { full_name: 'Mateo Ramírez', grade: '2° B' }).id;
    }
    // La tarjeta debe estar en el inventario de Zuki Company y entregada a la escuela (lista blanca)
    S.db.run("INSERT OR IGNORE INTO card_stock (uid, status, school_id, delivered_at, created_at) VALUES ('0A0B0C0D0E', 'entregada', (SELECT school_id FROM users WHERE username = 'admin'), datetime('now','localtime'), datetime('now','localtime'))");
    await nav('alumnos'); await sleep(800);
    await expect('Asignar tarjeta', 'botón asignar en alumnos');
    await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Asignar tarjeta')).click()`); await sleep(900);
    await expect('Este alumno no tiene tarjeta', 'tab tarjeta');
    const focused = await js(`document.activeElement && document.activeElement.hasAttribute('data-uid-input')`);
    if (!focused) errors.push('el campo UID no tiene el foco');
    await shot('82-asignar-tarjeta');
    await typeKeys('0A0B0C0D0E'); await sleep(900);
    await expect('UID: 0A0B0C0D0E', 'tarjeta asignada por lector');
    await expect('Reemplazar tarjeta', 'opciones de tarjeta'); await expect('Quitar tarjeta', 'quitar'); await expect('Bloquear', 'bloquear');
    const kc = S.db.get("SELECT child_id, status FROM cards WHERE uid = '0A0B0C0D0E'");
    if (!kc || kc.child_id !== kidId || kc.status !== 'activa') errors.push('la tarjeta no quedó asignada: ' + JSON.stringify(kc));
    await shot('82b-tarjeta-asignada');
    // duplicado desde Tarjetas
    await nav('tarjetas'); await sleep(800);
    await typeKeys('04A1B2C3D4E5F6'); await expect('ya está registrada', 'UID duplicado en Tarjetas');
    // límites: solo lectura
    const sofia = S.db.get("SELECT id FROM children WHERE full_name = 'Sofía Hernández'").id;
    await js(`document.querySelector('.nav a[data-view="alumnos"]').click()`); await sleep(700);
    await js(`[...document.querySelectorAll('tr')].filter(r=>r.textContent.includes('Sofía Hernández')).flatMap(r=>[...r.querySelectorAll('button')]).find(b=>b.textContent.trim()==='Ver').click()`); await sleep(900);
    await refute('Guardar límites', 'admin no edita límites');
    await clickBtn('Límites y prohibidos (del tutor)'); await expect('Solo el padre, madre o tutor', 'aviso solo lectura');
    await refute('Guardar límites', 'admin no edita límites'); await refute('Guardar prohibiciones', 'admin no edita prohibidos');
    await shot('85-admin-limites-solo-lectura');
    void sofia;
  } catch (e) { errors.push('excepción: ' + e.message); }
  srv.close();
  if (errors.length) { console.error('E2E ADMIN FALLÓ:\n' + errors.join('\n')); app.exit(1); } else { console.log('E2E ADMIN OK'); app.exit(0); }
});
