'use strict';
// Prueba de interfaz v2.1: notificaciones para padres, Reportes (PDF/imagen) e inventario.
// `xvfb-run npx electron scripts/e2e-v21.js` · Capturas 90–94 en docs/capturas/v2.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2'); fs.mkdirSync(shots, { recursive: true });
const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-dl-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = []; const pushed = [];
app.whenReady().then(async () => {
  const S = await createServer({ jwtSecret: 's'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, env: {}, pushSender: async (sub, p) => { pushed.push(JSON.parse(p)); } });
  const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const win = new BrowserWindow({ width: 1360, height: 900, show: false });
  const downloads = [];
  win.webContents.session.on('will-download', (_e, item) => { const f = path.join(dl, item.getFilename()); item.setSavePath(f); item.once('done', (_x, st) => downloads.push({ f, st })); });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2 && !/favicon|serviceWorker|sw\.js|403|Forbidden|\[push\]/.test(msg)) errors.push('consola: ' + msg); });
  const js = (c) => win.webContents.executeJavaScript(c);
  const text = () => js('document.body.innerText');
  const expect = async (n, ctx) => { await sleep(600); const t = await text(); if (!t.includes(n)) errors.push(`[${ctx}] falta "${n}"`); };
  const shot = async (n, w = win) => { if (w === win) await js(`document.getElementById('toast').innerHTML=''`); await sleep(300); w.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(shots, n + '.png'), (await w.webContents.capturePage()).toPNG()); console.log('captura:', n); };
  const clickBtn = (t) => js(`(()=>{const b=[...document.querySelectorAll('button,a')].find(b=>b.textContent.trim()===${JSON.stringify(t)}); if(!b) throw new Error('No hay botón: ${t}'); b.click();})()`);
  const login = async (u, p) => { await js(`(()=>{const i=document.querySelectorAll('.login input');i[0].value=${JSON.stringify(u)};i[1].value=${JSON.stringify(p)};})()`); await clickBtn('Entrar'); await sleep(900); };
  const logout = async () => { await clickBtn('Cerrar sesión'); await sleep(600); };
  const nav = (v) => js(`document.querySelector('.nav a[data-view="${v}"]').click()`);
  try {
    const admin = S.svc.login('admin', 'admin123'); const caj = S.svc.login('cajero', 'cajero123');
    const P = (n) => S.db.get('SELECT * FROM products WHERE name = ? AND school_id = 1', [n]);
    for (const [n, st, mn] of [['Gomitas', 30, 5], ['Chocolate', 12, 4], ['Manzana', 40, 10], ['Yogur', 6, 3], ['Papas fritas', 20, null]]) S.svc.updateProduct(admin, P(n).id, { stock: st, stock_min: mn });
    S.svc.addStock(admin, { product_id: P('Gomitas').id, qty: 24, note: 'Proveedor Dulcería del Centro' });
    const maria = S.svc.login('maria', 'tutor123'); S.svc.setLimits(maria, S.db.get("SELECT id FROM children WHERE full_name='Sofía Hernández'").id, {});
    S.svc.recharge(caj, { uid: '04A1B2C3D4E5F6', amount_cents: 20000 });
    S.svc.purchase(caj, { uid: '04A1B2C3D4E5F6', items: [{ product_id: P('Yogur').id, qty: 2 }, { product_id: P('Gomitas').id, qty: 1 }] });
    S.svc.purchase(caj, { uid: '04B7C8D9E0F1A2', items: [{ product_id: P('Yogur').id, qty: 2 }] }); // cruza mínimo
    S.svc.purchase(caj, { uid: '04C3D4E5F6A7B8', items: [{ product_id: P('Chocolate').id, qty: 1 }] });

    await win.loadURL(base); await sleep(900);
    // ----- tutor: activar notificaciones (se simula el PushManager del navegador; el servidor es real) -----
    await login('maria', 'tutor123');
    await expect('Activar notificaciones', 'botón activar');
    await js(`(()=>{
      const fake = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-demo', toJSON(){ return { endpoint: this.endpoint, keys: { p256dh: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U', auth: 'tBHItJI5svbpez7KI4CCXg' } }; }, unsubscribe: async()=>true, options: {} };
      let subd = false;
      const reg = { pushManager: { getSubscription: async()=> subd ? fake : null, subscribe: async()=>{ subd = true; return fake; } } };
      Object.defineProperty(navigator, 'serviceWorker', { value: { register: async()=>reg, ready: Promise.resolve(reg), getRegistration: async()=>reg }, configurable: true });
      window.PushManager = window.PushManager || function(){};
      Object.defineProperty(Notification, 'permission', { get: ()=> subd ? 'granted' : 'default', configurable: true });
      Notification.requestPermission = async()=>'granted';
    })()`);
    await js(`document.querySelector('[data-push-enable]').click()`); await sleep(1500);
    await expect('Activadas en este teléfono', 'activadas');
    if (!S.db.get("SELECT id FROM push_subscriptions WHERE endpoint LIKE '%e2e-demo'")) errors.push('no se guardó la suscripción');
    await js(`(()=>{const t=document.querySelector('[data-pref="threshold"]'); t.value='80.00';})()`);
    await clickBtn('Guardar preferencias'); await sleep(700);
    if (S.db.get('SELECT low_balance_cents FROM push_prefs').low_balance_cents !== 8000) errors.push('no se guardó el umbral');
    // compra real en la caja → aviso al teléfono
    pushed.length = 0;
    S.svc.purchase(caj, { uid: '04A1B2C3D4E5F6', items: [{ product_id: P('Manzana').id, qty: 1 }] });
    const tx = S.db.get("SELECT id FROM transactions WHERE type='compra' ORDER BY id DESC LIMIT 1").id;
    await S.push.onPurchase(tx);
    if (!pushed.some((x) => x.kind === 'compra' && /Manzana/.test(x.body))) errors.push('no se envió el aviso de compra: ' + JSON.stringify(pushed));
    const pv = pushed.find((x) => x.kind === 'compra');
    // vista previa de cómo se ve el aviso en el teléfono (solo para la captura)
    await js(`(()=>{const d=document.createElement('div'); d.id='push-preview'; d.className='card'; d.style.cssText='position:fixed;right:24px;top:24px;width:380px;z-index:99;box-shadow:0 12px 40px rgba(0,0,0,.25);padding:14px 16px;border-radius:16px';
      d.innerHTML='<div class="small muted">🔔 Cooperativa · ahora</div><b></b><div class="small"></div>'; d.querySelector('b').textContent=${JSON.stringify(pv ? pv.title : '')}; d.querySelector('.small:last-child').textContent=${JSON.stringify(pv ? pv.body : '')}; document.body.appendChild(d);})()`);
    await shot('90-tutor-notificaciones');
    await js(`document.getElementById('push-preview').remove()`);
    await logout();
    // ----- escuela: reportes -----
    await login('admin', 'admin123'); await sleep(500);
    const badge = await js(`(document.querySelector('.nav a[data-view="notificaciones"] .count')||{}).textContent`);
    if (!(Number(badge) >= 1)) errors.push('insignia de inventario: ' + badge);
    await nav('reportes'); await expect('Reportes', 'vista');
    await clickBtn('Este mes'); await sleep(1200);
    await expect('Productos más vendidos', 'top'); await expect('Ventas por cajero', 'cajero'); await expect('Ticket promedio', 'ticket'); await expect('Cajera Rosa López', 'cajera');
    await shot('91-escuela-reporte');
    await js(`document.querySelector('[data-dl="pdf"]').click()`); await sleep(1500);
    await js(`document.querySelector('[data-dl="png"]').click()`); await sleep(1500);
    await js(`document.querySelector('[data-dl="csv"]').click()`); await sleep(1200);
    const pdf = downloads.find((d) => d.f.endsWith('.pdf')); const png = downloads.find((d) => d.f.endsWith('.png')); const csv = downloads.find((d) => d.f.endsWith('.csv'));
    if (!pdf || fs.readFileSync(pdf.f).slice(0, 5).toString() !== '%PDF-') errors.push('PDF no descargado');
    if (!png || fs.readFileSync(png.f).slice(1, 4).toString() !== 'PNG') errors.push('PNG no descargado');
    if (!csv || !fs.readFileSync(csv.f, 'utf8').includes('Ticket promedio')) errors.push('CSV no descargado');
    if (pdf) { try { execFileSync('pdftoppm', ['-png', '-r', '60', '-f', '1', '-l', '1', pdf.f, path.join(dl, 'pdfpage')]); } catch (e) { errors.push('PDF inválido: ' + e.message); } }
    // captura del archivo generado (imagen del reporte)
    if (png) {
      const w2 = new BrowserWindow({ width: 1000, height: 1300, show: false });
      await w2.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:#cfd6e2;display:flex;justify-content:center;padding:20px"><img src="data:image/png;base64,${fs.readFileSync(png.f).toString('base64')}" style="width:900px;box-shadow:0 6px 30px rgba(0,0,0,.25)"></body>`));
      await sleep(800); await shot('92-reporte-pdf-o-imagen', w2); w2.close();
    }
    // ----- inventario -----
    await nav('productos'); await sleep(900);
    await expect('Por agotarse', 'filtro'); await expect('Mínimo 3', 'mínimo');
    await js(`[...document.querySelectorAll('tr[data-product]')].find(r=>r.textContent.includes('Chocolate')).querySelector('button').click()`); await sleep(500);
    await js(`(()=>{const m=document.querySelector('.modal'); m.querySelectorAll('input')[0].value='12'; m.querySelectorAll('input')[1].value='Factura 1043';})()`);
    await clickBtn('Agregar'); await sleep(900);
    if (P('Chocolate').stock !== 23) errors.push('entrada de inventario: ' + P('Chocolate').stock);
    await shot('93-inventario');
    await js(`document.querySelector('[data-filter="agotarse"]').click()`); await sleep(800);
    const rows = await js(`[...document.querySelectorAll('tr[data-product]')].map(r=>r.textContent)`);
    if (!rows.length || !rows.every((t) => /Yogur/.test(t))) errors.push('filtro por agotarse: ' + JSON.stringify(rows));
    await nav('notificaciones'); await expect('Avisos de inventario', 'avisos'); await expect('"Yogur" está por agotarse', 'aviso yogur');
    await sleep(400);
    const b2 = await js(`!!document.querySelector('.nav a[data-view="notificaciones"] .count')`); if (b2) errors.push('insignia no se limpió');
    // nueva venta que agota otro producto para mostrar un aviso nuevo y la insignia
    S.svc.updateProduct(admin, P('Papas fritas').id, { stock_min: 19 });
    S.svc.purchase(caj, { uid: '04C3D4E5F6A7B8', items: [{ product_id: P('Papas fritas').id, qty: 1 }] });
    await nav('dashboard'); await sleep(1200);
    const b3 = await js(`(document.querySelector('.nav a[data-view="notificaciones"] .count')||{}).textContent`); if (b3 !== '1') errors.push('insignia del aviso nuevo: ' + b3);
    await nav('notificaciones'); await sleep(200);
    // la insignia se comprueba en el resumen; al abrir Notificaciones el aviso nuevo se ve resaltado como "nueva"
    await sleep(700); await expect('Papas fritas', 'aviso nuevo');
    await shot('94-aviso-inventario');
    await logout();
    // ----- cajero: solo corte del día -----
    await login('cajero', 'cajero123');
    const navs = await js(`[...document.querySelectorAll('.nav a')].map(a=>a.dataset.view)`);
    if (navs.includes('reportes') || !navs.includes('corte')) errors.push('menú del cajero: ' + navs);
    await nav('corte'); await expect('Corte del día', 'corte'); await expect('Descargar PDF', 'pdf cajero');
  } catch (e) { errors.push('excepción: ' + e.message); }
  srv.close();
  if (errors.length) { console.error('E2E V21 FALLÓ:\n' + errors.join('\n')); app.exit(1); } else { console.log('E2E V21 OK'); app.exit(0); }
});
