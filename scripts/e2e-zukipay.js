'use strict';
// Capturas de la marca Zuki Pay: login y panel. `xvfb-run npx electron scripts/e2e-zukipay.js`
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  let ok = true;
  try {
    const S = await createServer({ jwtSecret: 'e'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, env: {} });
    const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
    const win = new BrowserWindow({ width: 1360, height: 900, show: false });
    const js = (c) => win.webContents.executeJavaScript(c);
    const shot = async (n) => { await sleep(500); win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(shots, n + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('captura', n); };
    await win.loadURL(`http://127.0.0.1:${srv.address().port}`); await sleep(1200);
    const t = await js('document.title + "|" + !!document.querySelector(".login .logo img") && document.querySelector(".login .logo img").naturalWidth');
    if (!(await js('document.title')).includes('Zuki Pay') || !t) { ok = false; console.error('falta marca en login', t); }
    await shot('99-zukipay-login');
    await js(`(()=>{const i=document.querySelectorAll('.login input');i[0].value='admin';i[1].value='admin123';[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Entrar').click();})()`);
    await sleep(1500);
    if (!(await js('(document.querySelector(".brand-logo")||{}).naturalWidth'))) { ok = false; console.error('falta logo en encabezado'); }
    await shot('99b-zukipay-panel');
    srv.close();
  } catch (e) { ok = false; console.error(e); }
  console.log(ok ? 'E2E ZUKIPAY OK' : 'E2E ZUKIPAY FALLÓ'); app.exit(ok ? 0 : 1);
});
