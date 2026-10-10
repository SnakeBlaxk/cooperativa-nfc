'use strict';
// Pantalla "Instala Zuki Pay" en celular (UA emulado). `xvfb-run npx electron scripts/e2e-instalar.js`
const path = require('path'); const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('../server/app');
const { consoleMailer } = require('../src/core/auth');
const shots = path.join(__dirname, '..', 'docs', 'capturas', 'v2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = {
  ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
};
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let ok = true;
  try {
    const S = await createServer({ jwtSecret: 'e'.repeat(40), mailer: consoleMailer(() => {}), billingSweepMs: 0, env: {} });
    const srv = await new Promise((r) => { const s = S.app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${srv.address().port}/`;
    const run = async (ua, url) => {
      const win = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { partition: 'p' + Math.random() } });
      win.webContents.setUserAgent(ua); await win.loadURL(url).catch(() => {}); await sleep(1500); return win;
    };
    for (const [k, name] of [['ios', '100-instalar-ios'], ['android', '101-instalar-android']]) {
      const win = await run(UA[k], base);
      const p = await win.webContents.executeJavaScript('(document.getElementById("install-gate")||{dataset:{}}).dataset.platform');
      if (p !== k) { ok = false; console.error('falta pantalla', k, p); }
      await sleep(400); win.webContents.invalidate(); await sleep(600);
      fs.writeFileSync(path.join(shots, name + '.png'), (await win.webContents.capturePage()).toPNG()); console.log('captura', name);
      win.destroy();
    }
    const w2 = await run(UA.android, base + '?nogate=1');
    if (await w2.webContents.executeJavaScript('!!document.getElementById("install-gate")')) { ok = false; console.error('?nogate=1 no funcionó'); }
    w2.destroy();
    const w3 = await run(new BrowserWindow({ show: false }).webContents.getUserAgent(), base);
    if (await w3.webContents.executeJavaScript('!!document.getElementById("install-gate")')) { ok = false; console.error('pantalla en escritorio'); }
    srv.close();
  } catch (e) { ok = false; console.error(e); }
  console.log(ok ? 'E2E INSTALAR OK' : 'E2E INSTALAR FALLÓ'); app.exit(ok ? 0 : 1);
});
