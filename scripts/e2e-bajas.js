'use strict';
// Prueba de interfaz: dar de baja alumnos y papás/tutores, Papelera (escuela y superadministrador).
// `xvfb-run npx electron scripts/e2e-bajas.js` · Capturas 97–98 en docs/capturas/v2.
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
app.whenReady().then(async () => {
  const S = await createServer({ jwtSecret: 'e'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, env: {} });
  const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const win = new BrowserWindow({ width: 1360, height: 1000, show: false });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon|serviceWorker|sw\.js|403|409|Forbidden|Conflict|\[push\]/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => win.webContents.executeJavaScript(c);
  const text = () => js('document.body.innerText');
  const expect = async (n, ctx) => { await sleep(600); const t = await text(); if (!t.includes(n)) errors.push(`[${ctx}] falta "${n}"`); };
  const shot = async (n) => { await js(`document.getElementById('toast').innerHTML=''`); await sleep(300); win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('captura:', n); };
  const clickBtn = (t) => js(`(()=>{const b=[...document.querySelectorAll('button,a')].reverse().find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(!b) throw new Error('No hay botón: ${t}'); b.click();})()`);
  const clickInRow = (rowText, t) => js(`(()=>{const rows=[...document.querySelectorAll('tr')].filter(r=>r.innerText.includes(${JSON.stringify(rowText)})).reverse(); if(!rows.length) throw new Error('No hay fila: ${rowText}'); let b=null; for(const r of rows){ b=[...r.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(b) break; } if(!b) throw new Error('No hay botón ${t} en ${rowText}'); b.click();})()`);
  const login = async (u, p) => { await js(`(()=>{const i=document.querySelectorAll('.login input');i[0].value=${JSON.stringify(u)};i[1].value=${JSON.stringify(p)};})()`); await clickBtn('Entrar'); await sleep(900); };
  const logout = async () => { await clickBtn('Cerrar sesión'); await sleep(600); };
  const nav = (v) => js(`document.querySelector('.nav a[data-view="${v}"]').click()`);
  try {
    const vale = S.db.get("SELECT id FROM children WHERE full_name = 'Valentina Pérez'");
    const bal = S.db.get('SELECT balance_cents FROM cards WHERE child_id = ?', [vale.id]).balance_cents;
    const adm = S.db.get("SELECT * FROM users WHERE username = 'admin'");
    const laura = S.svc.createUser(adm, { role: 'tutor', username: 'laura', password: 'tutor1234', full_name: 'Laura Gómez' });
    S.svc.createChild(adm, { full_name: 'Mateo Gómez', grade: '2° B', tutor_id: laura.id });
    await win.loadURL(base); await sleep(900);
    // ----- cajero: no ve botones de baja -----
    await login('cajero', 'cajero123');
    if ((await text()).includes('Eliminar alumno')) errors.push('el cajero ve Eliminar alumno');
    if (await js(`!!document.querySelector('.nav a[data-view="papelera"]')`)) errors.push('el cajero ve la Papelera');
    await logout();
    // ----- administrador: eliminar alumno con saldo -----
    await login('admin', 'admin123');
    await nav('alumnos'); await expect('Eliminar alumno', 'botón');
    await clickInRow('Valentina Pérez', 'Eliminar alumno'); await sleep(800);
    await expect('Tiene saldo de', 'aviso de saldo'); await expect('También eliminar al papá/tutor Juan Pérez', 'opción tutor');
    await clickBtn('Eliminar alumno'); await sleep(700); // sin marcar reembolso: no deja
    if (S.db.get('SELECT deleted_at FROM children WHERE id = ?', [vale.id]).deleted_at) errors.push('borró sin reembolso');
    await js(`(()=>{const c=document.querySelectorAll('.modal input[type=checkbox]'); c.forEach(x=>{x.checked=true;});})()`);
    await shot('97-eliminar-alumno');
    await clickBtn('Eliminar alumno'); await sleep(1200);
    const ch = S.db.get('SELECT deleted_at FROM children WHERE id = ?', [vale.id]);
    if (!ch.deleted_at) errors.push('no se dio de baja');
    if (!S.db.get("SELECT 1 AS x FROM transactions WHERE child_id = ? AND subtype = 'reembolso' AND amount_cents = ?", [vale.id, -bal])) errors.push('sin movimiento de reembolso');
    if (S.db.get("SELECT status FROM card_stock WHERE uid = '04C3D4E5F6A7B8'").status !== 'entregada') errors.push('la tarjeta no volvió a libres');
    if (!S.db.get("SELECT deleted_at FROM users WHERE username = 'juan'").deleted_at) errors.push('no se dio de baja al tutor');
    // eliminar papá/tutor (Laura: su hijo sigue inscrito)
    await clickInRow('Laura Gómez', 'Eliminar papá/tutor'); await sleep(600);
    await expect('siguen inscritos', 'aviso hijos'); await clickBtn('Eliminar papá/tutor'); await sleep(1000);
    if (!S.db.get("SELECT deleted_at FROM users WHERE username = 'laura'").deleted_at) errors.push('no se dio de baja a Laura');
    await nav('papelera'); await expect('Valentina Pérez', 'papelera alumno'); await expect('Juan Pérez', 'papelera tutor');
    await js('window.scrollTo(0,0)');
    await shot('98-papelera');
    await clickInRow('Laura Gómez', '↩️ Restaurar'); await sleep(900);
    if (S.db.get("SELECT deleted_at FROM users WHERE username = 'laura'").deleted_at) errors.push('no restauró a Laura');
    if ((await text()).includes('Eliminar definitivamente')) errors.push('el admin ve Eliminar definitivamente');
    await logout();
    // ----- superadministrador: Papelera con borrado definitivo -----
    await login('zuki', 'zuki123');
    await nav('papelera'); await expect('Valentina Pérez', 'papelera super');
    await clickInRow('Juan Pérez', 'Eliminar definitivamente'); await sleep(500); await clickBtn('Confirmar'); await sleep(1000);
    if (S.db.get("SELECT id FROM users WHERE username = 'juan'")) errors.push('no eliminó definitivamente a Juan');
    await clickInRow('Valentina Pérez', '↩️ Restaurar'); await sleep(900);
    if (S.db.get('SELECT deleted_at FROM children WHERE id = ?', [vale.id]).deleted_at) errors.push('super no restauró');
    // Cuentas: eliminar papá/tutor
    await nav('cuentas'); await sleep(900);
    await clickInRow('María Hernández', 'Eliminar papá/tutor'); await sleep(800); await clickBtn('Eliminar papá/tutor'); await sleep(1000);
    if (!S.db.get("SELECT deleted_at FROM users WHERE username = 'maria'").deleted_at) errors.push('super no dio de baja a María');
    // Detalle de escuela: Alumnos y papás → eliminar alumno sin saldo
    await nav('instituciones'); await sleep(900);
    const sid = S.db.get('SELECT school_id FROM children WHERE id = ?', [vale.id]).school_id;
    await clickInRow(S.db.get('SELECT name FROM schools WHERE id = ?', [sid]).name, 'Administrar'); await sleep(1000);
    await clickBtn('🧒 Alumnos y papás'); await sleep(900);
    await clickInRow('Valentina Pérez', 'Eliminar alumno'); await sleep(800); await clickBtn('Eliminar alumno'); await sleep(1000);
    if (!S.db.get('SELECT deleted_at FROM children WHERE id = ?', [vale.id]).deleted_at) errors.push('super no dio de baja desde la escuela');
    if (!S.db.get("SELECT 1 AS x FROM audit_log WHERE action = 'tutor_eliminado_definitivo'")) errors.push('bitácora');
  } catch (e) { errors.push('excepción: ' + e.message); }
  srv.close();
  if (errors.length) { console.error('E2E BAJAS FALLÓ:\n' + errors.join('\n')); app.exit(1); } else { console.log('E2E BAJAS OK'); app.exit(0); }
});
