'use strict';
// Prueba de interfaz (PWA): el tutor ve nombre y grado/grupo de solo lectura, cambia la foto y envía
// "Solicitar cambio de datos"; la escuela las ve en Notificaciones (insignia de no leídas) y aprueba/rechaza.
// `xvfb-run npx electron scripts/e2e-solicitudes.js` · Capturas: 86-tutor-solicitar-cambio, 87-escuela-notificaciones.
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
app.whenReady().then(async () => {
  const S = await createServer({ jwtSecret: 's'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0 });
  const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const win = new BrowserWindow({ width: 1360, height: 900, show: false });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon|serviceWorker|sw\.js|403|Forbidden/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => win.webContents.executeJavaScript(c);
  const text = () => js('document.body.innerText');
  const expect = async (n, ctx) => { await sleep(600); const t = await text(); if (!t.includes(n)) errors.push(`[${ctx}] falta "${n}"`); };
  const shot = async (n) => { await js(`document.getElementById('toast').innerHTML=''`); await sleep(300); win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('captura:', n); };
  const clickBtn = (t) => js(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(!b) throw new Error('No hay botón: ${t}'); b.click();})()`);
  const login = async (u, p) => { await js(`(()=>{const i=document.querySelectorAll('.login input');i[0].value=${JSON.stringify(u)};i[1].value=${JSON.stringify(p)};})()`); await clickBtn('Entrar'); await sleep(900); };
  const logout = async () => { await clickBtn('Cerrar sesión'); await sleep(600); };
  const nav = (v) => js(`document.querySelector('.nav a[data-view="${v}"]').click()`);
  try {
    const maria = S.svc.login('maria', 'tutor123'); const admin = S.svc.login('admin', 'admin123');
    const kid = (n) => S.db.get('SELECT * FROM children WHERE full_name = ?', [n]);
    const sofia = kid('Sofía Hernández'); const diego = kid('Diego Hernández');
    // historial previo: una aprobada y una rechazada
    const q1 = S.svc.requestChildChange(maria, { child_id: sofia.id, field: 'nombre', new_value: 'Sofía Hernández Ruiz', comment: 'Falta el segundo apellido' });
    S.svc.resolveChangeRequest(admin, { id: q1.id, decision: 'aprobar' });
    const q2 = S.svc.requestChildChange(maria, { child_id: sofia.id, field: 'otro', new_value: 'Alergia a cacahuate', comment: 'Agregar al expediente' });
    S.svc.resolveChangeRequest(admin, { id: q2.id, decision: 'rechazar', reason: 'Entregue el certificado médico en dirección' });
    S.svc.requestChildChange(maria, { child_id: diego.id, field: 'grado', new_value: '6° A', comment: 'Cambio de ciclo escolar' });
    S.svc.markChangeRequestsRead(admin);

    await win.loadURL(base); await sleep(900);
    // ----- tutor -----
    await login('maria', 'tutor123');
    await js(`[...document.querySelectorAll('.card.kid')].find(c=>c.textContent.includes('Sofía Hernández Ruiz')).click()`); await sleep(900);
    await clickBtn('Tarjeta y perfil'); await expect('Solicitar cambio de datos', 'botón solicitar');
    const ro = await js(`[...document.querySelectorAll('input[data-readonly]')].map(i=>[i.value, i.readOnly, i.disabled])`);
    if (ro.length !== 2 || !ro.every((x) => x[1] && x[2])) errors.push('nombre/grado no son de solo lectura: ' + JSON.stringify(ro));
    await expect('Mis solicitudes', 'lista del tutor'); await expect('Aprobada', 'estado aprobada'); await expect('Rechazada', 'estado rechazada');
    await expect('Entregue el certificado médico', 'motivo del rechazo');
    await clickBtn('Guardar foto'); await expect('Foto actualizada', 'guardar foto (sin cambiar nombre)');
    await clickBtn('Tarjeta y perfil'); await sleep(700);
    await js(`document.querySelector('[data-cr-open]').click()`); await sleep(500);
    await js(`(()=>{const m=document.querySelector('.modal'); const s=m.querySelector('select'); s.value='grado'; s.dispatchEvent(new Event('change')); m.querySelector('input').value='3° B'; m.querySelector('textarea').value='La cambiaron de grupo este ciclo escolar.';})()`);
    await sleep(300); await expect('Dato actual: 3° A', 'dato actual');
    await shot('86-tutor-solicitar-cambio');
    await clickBtn('Enviar solicitud'); await expect('Solicitud enviada a la escuela', 'enviar'); await sleep(600);
    await expect('Pendiente', 'estado pendiente');
    const sent = S.db.get("SELECT * FROM child_change_requests WHERE child_id = ? AND field = 'grado' AND status = 'pendiente'", [sofia.id]);
    if (!sent || sent.new_value !== '3° B') errors.push('no se guardó la solicitud');
    await logout();
    // ----- escuela -----
    await login('admin', 'admin123'); await sleep(600);
    const badge = await js(`(document.querySelector('.nav a[data-view="notificaciones"] .count')||{}).textContent`);
    if (badge !== '1') errors.push('insignia de no leídas: ' + badge);
    await nav('notificaciones'); await expect('Notificaciones', 'vista'); await expect('3° A', 'detalle'); await expect('María Hernández', 'tutor');
    await sleep(500);
    const badge2 = await js(`!!document.querySelector('.nav a[data-view="notificaciones"] .count')`);
    if (badge2) errors.push('la insignia no se limpió al abrir');
    await js(`[...document.querySelectorAll('tr[data-cr="${sent.id}"] button')].find(b=>b.textContent.includes('Aprobar')).click()`); await sleep(500);
    await clickBtn('Confirmar'); await expect('el cambio ya se aplicó', 'aprobar');
    if (S.db.get('SELECT grade FROM children WHERE id = ?', [sofia.id]).grade !== '3° B') errors.push('no se aplicó el grado');
    // nueva solicitud para mostrarla como "nueva" en la captura
    S.svc.requestChildChange(maria, { child_id: diego.id, field: 'nombre', new_value: 'Diego Hernández Ruiz', comment: 'Falta el segundo apellido' });
    await clickBtn('Todas'); await sleep(900);
    await expect('Aprobada', 'estado'); await expect('Rechazada', 'estado'); await expect('Pendiente', 'estado');
    await shot('87-escuela-notificaciones');
    if (!S.db.get("SELECT id FROM audit_log WHERE action = 'solicitud_cambio_aprobada'")) errors.push('sin bitácora');
  } catch (e) { errors.push('excepción: ' + e.message); }
  srv.close();
  if (errors.length) { console.error('E2E SOLICITUDES FALLÓ:\n' + errors.join('\n')); app.exit(1); } else { console.log('E2E SOLICITUDES OK'); app.exit(0); }
});
