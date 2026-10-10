'use strict';
const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const { detect, shouldGate } = require('../server/public/install-gate.js');
const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1',
  iphoneChromeOld: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/110.0 Mobile/15E148 Safari/604.1',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0 Mobile Safari/537.36',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  electron: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) zuki-pay/2.1.0 Chrome/126.0 Electron/31.7.7 Safari/537.36',
};
test('celulares y tabletas en navegador: pantalla de instalación', () => {
  for (const k of ['iphoneSafari', 'iphoneChrome', 'androidChrome', 'androidSamsung']) assert.equal(shouldGate({ ua: UA[k] }), true, k);
  assert.equal(shouldGate({ ua: UA.ipadOS, maxTouchPoints: 5 }), true, 'iPadOS como Mac táctil');
});
test('computadoras, Mac sin táctil y Electron: sin pantalla', () => {
  assert.equal(shouldGate({ ua: UA.winChrome }), false);
  assert.equal(shouldGate({ ua: UA.ipadOS, maxTouchPoints: 0 }), false);
  assert.equal(shouldGate({ ua: UA.electron, maxTouchPoints: 5 }), false);
});
test('instalada (standalone) o ?nogate=1: sin pantalla', () => {
  assert.equal(shouldGate({ ua: UA.iphoneSafari, standalone: true }), false);
  assert.equal(shouldGate({ ua: UA.androidChrome, nogate: true }), false);
});
test('detección de navegador por plataforma', () => {
  assert.deepEqual(detect({ ua: UA.iphoneSafari }), { mobile: true, platform: 'ios', safari: true, shareCapable: true });
  assert.equal(detect({ ua: UA.iphoneChrome }).safari, false); assert.equal(detect({ ua: UA.iphoneChrome }).shareCapable, true);
  assert.equal(detect({ ua: UA.iphoneChromeOld }).shareCapable, false);
  assert.equal(detect({ ua: UA.androidChrome }).chrome, true); assert.equal(detect({ ua: UA.androidSamsung }).chrome, false);
});
test('index.html carga la pantalla antes de la app y el SW la guarda (cache v10)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../server/public/index.html'), 'utf8');
  assert.ok(html.indexOf('/install-gate.js') > 0 && html.indexOf('/install-gate.js') < html.indexOf('/app.js'));
  const sw = fs.readFileSync(path.join(__dirname, '../server/public/sw.js'), 'utf8');
  assert.match(sw, /coop-v10/); assert.match(sw, /'\/install-gate\.js'/);
});
