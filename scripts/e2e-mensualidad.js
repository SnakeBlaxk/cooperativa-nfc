'use strict';
// Prueba de la MENSUALIDAD en la PWA: `npx electron scripts/e2e-mensualidad.js`
// Prepara escuelas en distintos estados (aviso, tolerancia, pausada) y guarda capturas en docs/capturas/v2/.
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const { mxDate, addDays } = require('../src/core/billing');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
app.whenReady().then(async () => {
  const S = await createServer({ jwtSecret: 'm'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, body, token) => (await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) })).json();
  const win = new BrowserWindow({ width: 1360, height: 900, show: false });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon|serviceWorker|sw\.js|401|403/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => win.webContents.executeJavaScript(c);
  const text = () => js('document.body.innerText');
  const expect = async (n, ctx) => { await sleep(700); const t = await text(); if (!t.toLowerCase().includes(n.toLowerCase())) errors.push(`[${ctx}] falta "${n}" · pantalla: ${t.slice(0, 200).replace(/\s+/g, ' ')}`); };
  const shot = async (n) => {
    await sleep(400);
    const hgt = await js(`Math.max(document.body.scrollHeight, (document.querySelector('.main')||{}).scrollHeight||0, (document.querySelector('.modal')||{}).scrollHeight||0) + 40`);
    const prev = win.getSize(); win.setSize(prev[0], Math.min(Math.max(hgt, 760), 4000)); await sleep(400);
    fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(prev[0], prev[1]); await sleep(150);
    console.log('captura:', n);
  };
  const setInputs = (vals, sel = '.login input') => js(`(()=>{const v=${JSON.stringify(vals)};const i=[...document.querySelectorAll(${JSON.stringify(sel)})];v.forEach((x,k)=>{i[k].value=x;});})()`);
  const clickBtn = (t) => js(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(!b) throw new Error('No hay botón ${t.replace(/'/g, '')}'); b.click();})()`);
  const login = async (u, p) => { await setInputs([u, p]); await clickBtn('Entrar'); await sleep(1000); };
  const logout = async () => { await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Cerrar sesión').click()`); await sleep(600); };
  const today = mxDate();
  const db = S.db;
  const sid = (n) => db.get('SELECT id FROM schools WHERE name = ?', [n]).id;
  try {
    const Z = (await post('/api/auth/login', { identifier: 'zuki', password: 'zuki123' })).data.access_token;
    const A = sid('Colegio Morelos (demo)'); const B = sid('Instituto Valladolid (demo)');
    // Colegio Morelos: dos pagos registrados y luego el periodo cerca de vencer (aviso)
    await post('/api/super/registerPayment', { school_id: A, paid_at: addDays(today, -35), amount_cents: 150000, note: 'Transferencia BBVA' }, Z);
    await post('/api/super/registerPayment', { school_id: A, paid_at: addDays(today, -4), amount_cents: 150000, note: 'Depósito OXXO, recibo 2231' }, Z);
    const pays = db.all('SELECT id FROM school_payments WHERE school_id = ? ORDER BY id', [A]);
    db.run('UPDATE school_payments SET period_start = ?, period_end = ? WHERE id = ?', [addDays(today, -57), addDays(today, -28), pays[0].id]);
    db.run('UPDATE school_payments SET period_start = ?, period_end = ? WHERE id = ?', [addDays(today, -27), addDays(today, 2), pays[1].id]);
    db.run("UPDATE schools SET status = 'activa', period_start = ?, period_end = ?, billing_notice = NULL WHERE id = ?", [addDays(today, -27), addDays(today, 2), A]);
    // Instituto Valladolid: venció ayer (periodo de tolerancia)
    db.run("UPDATE schools SET status = 'prueba', period_start = ?, period_end = ?, billing_notice = NULL WHERE id = ?", [addDays(today, -31), addDays(today, -1), B]);
    // Tercera escuela: venció hace 5 días → se pausa sola por falta de pago
    const c = await post('/api/super/createSchool', { name: 'Primaria Miguel Hidalgo', status: 'activa', admin_username: 'admin.hidalgo', contact_name: 'Profra. Rosa Medina' }, Z);
    const C = c.data.school.id; const pwC = c.data.admin.temporary_password;
    db.run('UPDATE schools SET period_start = ?, period_end = ? WHERE id = ?', [addDays(today, -35), addDays(today, -5), C]);
    // Cuarta escuela: al corriente
    await post('/api/super/createSchool', { name: 'Secundaria Técnica 12', status: 'activa', admin_username: 'admin.st12', contact_name: 'Ing. Pablo Cruz' }, Z);
    S.billing.sweep();

    await win.loadURL(base); await sleep(900);
    // ----- superadministrador -----
    await login('zuki', 'zuki123'); await expect('Mensualidades', 'banner de atención'); await expect('Pausada por falta de pago', 'escuela pausada sola');
    await expect('Vence en 2 días', 'aviso'); await expect('tolerancia', 'tolerancia');
    await shot('70-super-escuelas-mensualidad');
    await js(`[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('Colegio Morelos')).querySelector('button').click()`);
    await expect('Historial de pagos', 'detalle'); await expect('Registrar pago / renovar', 'botón pago'); await expect('Depósito OXXO', 'historial'); await expect('Pausar ahora', 'botón pausar');
    await shot('71-super-escuela-mensualidad');
    await clickBtn('💵 Registrar pago / renovar'); await sleep(500); await expect('Nuevo fin del periodo', 'modal pago');
    await setInputs(['1500', 'Transferencia, recibo 2290'], '.modal input:not([type=date])');
    await shot('72-super-registrar-pago');
    await js(`document.querySelectorAll('.modal-bg').forEach(m=>m.remove())`); await sleep(300);
    // escuela pausada: detalle con botón Reactivar
    await js(`[...document.querySelectorAll('.nav a')].find(a=>a.dataset.view==='instituciones').click()`); await sleep(800);
    await js(`[...document.querySelectorAll('tr')].find(r=>r.textContent.includes('Primaria Miguel Hidalgo')).querySelector('button').click()`);
    await expect('Reactivar', 'reactivar'); await expect('Falta de pago', 'motivo');
    await shot('73-super-escuela-pausada');
    await js(`[...document.querySelectorAll('.nav a')].find(a=>a.dataset.view==='alertas').click()`); await sleep(800);
    await expect('Mensualidad por vencer', 'alerta aviso'); await expect('Escuela pausada', 'alerta pausa');
    await shot('74-super-alertas-mensualidad');
    await logout();

    // ----- administrador: aviso de vencimiento -----
    await login('admin', 'admin123'); await expect('Tu mensualidad vence en 2 días', 'banner aviso');
    await shot('75-admin-aviso-mensualidad');
    await logout();
    // ----- administrador: periodo de tolerancia -----
    await login('admin2', 'admin123'); await expect('Periodo de tolerancia: quedan 2 días para realizar el pago', 'banner tolerancia');
    await shot('76-admin-tolerancia');
    await logout();
    // ----- cajero: también ve el aviso -----
    await login('cajero2', 'cajero123'); await expect('Periodo de tolerancia', 'cajero ve aviso');
    await logout();
    // ----- tutor: no ve avisos de cobro -----
    await login('maria', 'tutor123'); await sleep(500);
    if ((await text()).includes('mensualidad')) errors.push('[tutor] no debe ver avisos de mensualidad');
    await logout();
    // ----- escuela pausada: mensaje al intentar entrar -----
    await login('admin.hidalgo', pwC); await expect('Servicio pausado. Contacte a la administración.', 'login pausado');
    await shot('77-login-servicio-pausado');
    // sesión abierta que se pausa: al siguiente uso vuelve a la entrada con el aviso
    await login('admin2', 'admin123'); await expect('Periodo de tolerancia', 'admin2 de nuevo');
    await post('/api/super/pauseSchool', { school_id: B }, Z);
    await js(`[...document.querySelectorAll('.nav a')].find(a=>a.dataset.view==='alumnos').click()`); await sleep(1200);
    await expect('Servicio pausado', 'sesión cerrada por pausa');
  } catch (e) { errors.push('excepción: ' + e.message); }
  console.log(errors.length ? 'E2E MENSUALIDAD FALLÓ:\n' + errors.join('\n') : 'E2E MENSUALIDAD OK');
  srv.close(); app.exit(errors.length ? 1 : 0);
});
