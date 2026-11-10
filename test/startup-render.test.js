'use strict';
// Regresión de pantalla en blanco al abrir Zuki Pay (nov 2026).
// El renderer que el servidor entrega en /app.js tiene que parsear Y pintar:
// acceso sin sesión, sesión guardada (escritorio) y app instalada (standalone).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { createServer } = require('../server/app');

const UA = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

let srv, base, html, gateSrc, coopSrc, appSrc, swSrc;
const scripts = {};

before(async () => {
  const S = await createServer({ cardStock: false, jwtSecret: 's'.repeat(40), billingSweepMs: 0 });
  await new Promise((r) => { srv = S.app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${srv.address().port}`;
  const get = async (p) => {
    const r = await fetch(base + p);
    const text = await r.text();
    assert.equal(r.status, 200, p);
    return { type: r.headers.get('content-type') || '', text };
  };
  html = await get('/');
  gateSrc = await get('/install-gate.js');
  coopSrc = await get('/coop-web.js');
  appSrc = await get('/app.js');
  swSrc = await get('/sw.js');
  assert.match(html.type, /html/);
  assert.match(appSrc.type, /javascript/);
  assert.equal(appSrc.text, fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8'));
  const tmp = path.join(os.tmpdir(), `zukipay-shipped-app-${process.pid}.js`);
  fs.writeFileSync(tmp, appSrc.text);
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  scripts.gate = new vm.Script(gateSrc.text, { filename: 'install-gate.js' });
  scripts.coop = new vm.Script(coopSrc.text, { filename: 'coop-web.js' });
  scripts.app = new vm.Script(appSrc.text, { filename: 'app.js' });
});

after(() => new Promise((r) => srv.close(r)));

function unrefTimer(fn) {
  return (cb, ms, ...args) => {
    const t = fn(cb, ms, ...args);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
}

function memStore(init) {
  const data = Object.assign({}, init);
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
  };
}

// DOM mínimo: el mismo app.js del navegador crea nodos de verdad y los afirma el test.
const DOM = `
var Node = function Node() {};
function Element(tag) {
  this.nodeType = 1;
  this.nodeName = String(tag).toUpperCase();
  this.tagName = this.nodeName;
  this.childNodes = [];
  this.parentNode = null;
  this.attributes = {};
  this.style = {};
  this.className = '';
  this.id = '';
  this.value = '';
  this.listeners = {};
}
Element.prototype = Object.create(Node.prototype);
Element.prototype.constructor = Element;
function TextNode(v) {
  this.nodeType = 3;
  this.nodeValue = v == null ? '' : String(v);
  this.parentNode = null;
  this.childNodes = [];
}
TextNode.prototype = Object.create(Node.prototype);
Element.prototype.setAttribute = function (k, v) {
  this.attributes[k] = String(v);
  if (k === 'id') this.id = String(v);
};
Element.prototype.getAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; };
Element.prototype.hasAttribute = function (k) { return Object.prototype.hasOwnProperty.call(this.attributes, k); };
Element.prototype.addEventListener = function (n, fn) { (this.listeners[n] || (this.listeners[n] = [])).push(fn); };
Element.prototype.removeChild = function (k) {
  var i = this.childNodes.indexOf(k);
  if (i >= 0) this.childNodes.splice(i, 1);
  if (k) k.parentNode = null;
  return k;
};
Element.prototype.appendChild = function (k) {
  if (k && k.parentNode) k.parentNode.removeChild(k);
  k.parentNode = this;
  this.childNodes.push(k);
  return k;
};
Element.prototype.append = function () {
  for (var i = 0; i < arguments.length; i++) {
    var k = arguments[i];
    this.appendChild(k && k.nodeType ? k : new TextNode(k));
  }
};
Element.prototype.prepend = function () {
  var nodes = [];
  for (var i = 0; i < arguments.length; i++) {
    var k = arguments[i];
    nodes.push(k && k.nodeType ? k : new TextNode(k));
  }
  for (var j = nodes.length - 1; j >= 0; j--) {
    if (nodes[j].parentNode) nodes[j].parentNode.removeChild(nodes[j]);
    nodes[j].parentNode = this;
    this.childNodes.unshift(nodes[j]);
  }
};
Element.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
Element.prototype.focus = function () {};
Element.prototype.select = function () {};
Object.defineProperty(Element.prototype, 'textContent', {
  get: function () {
    return this.childNodes.map(function (c) { return c.nodeType === 3 ? c.nodeValue : (c.textContent || ''); }).join('');
  },
  set: function (v) {
    var t = new TextNode(v);
    t.parentNode = this;
    this.childNodes = [t];
  },
});
Object.defineProperty(Element.prototype, 'innerHTML', {
  get: function () { return this.textContent; },
  set: function () { this.childNodes = []; },
});
Object.defineProperty(Element.prototype, 'classList', {
  get: function () {
    var el = this;
    var read = function () { return String(el.className || '').split(/\\s+/).filter(Boolean); };
    return {
      toggle: function (name, on) {
        var xs = read(); var has = xs.indexOf(name) >= 0;
        var next = on === undefined ? !has : !!on;
        if (next && !has) el.className = xs.concat(name).join(' ');
        if (!next && has) el.className = xs.filter(function (x) { return x !== name; }).join(' ');
      },
      add: function (name) { this.toggle(name, true); },
      remove: function (name) { this.toggle(name, false); },
      contains: function (name) { return read().indexOf(name) >= 0; },
    };
  },
});
function matchesCompound(el, compound) {
  var rest = compound;
  var tag = /^[A-Za-z][\\w-]*/.exec(rest);
  if (tag) {
    if (el.nodeName !== tag[0].toUpperCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest) {
    if (rest.charAt(0) === '.') {
      var cm = /^\\.([\\w-]+)/.exec(rest); if (!cm) return false;
      if (String(el.className || '').split(/\\s+/).indexOf(cm[1]) < 0) return false;
      rest = rest.slice(cm[0].length);
    } else if (rest.charAt(0) === '#') {
      var im = /^#([\\w-]+)/.exec(rest); if (!im) return false;
      if (el.id !== im[1]) return false;
      rest = rest.slice(im[0].length);
    } else if (rest.charAt(0) === '[') {
      var am = /^\\[([\\w-]+)(?:="([^"]*)")?\\]/.exec(rest); if (!am) return false;
      if (am[2] === undefined) { if (!el.hasAttribute(am[1])) return false; }
      else if (el.getAttribute(am[1]) !== am[2]) return false;
      rest = rest.slice(am[0].length);
    } else return false;
  }
  return true;
}
function matchesSelector(el, selector) {
  var parts = selector.trim().split(/\\s+/);
  var cur = el;
  for (var i = parts.length - 1; i >= 0; i--) {
    if (i === parts.length - 1) {
      if (!cur || cur.nodeType !== 1 || !matchesCompound(cur, parts[i])) return false;
    } else {
      var p = cur.parentNode;
      while (p && p.nodeType === 1 && !matchesCompound(p, parts[i])) p = p.parentNode;
      if (!p || p.nodeType !== 1) return false;
      cur = p;
    }
  }
  return true;
}
function walk(el, fn) {
  var cs = el.childNodes || [];
  for (var i = 0; i < cs.length; i++) { if (cs[i].nodeType === 1) { fn(cs[i]); walk(cs[i], fn); } }
}
function queryAll(root, selector) {
  var out = [];
  walk(root, function (el) { if (matchesSelector(el, selector)) out.push(el); });
  return out;
}
Element.prototype.querySelectorAll = function (sel) { return queryAll(this, sel); };
Element.prototype.querySelector = function (sel) { return queryAll(this, sel)[0] || null; };
function makeDoc() {
  var docEl = new Element('html');
  var body = new Element('body');
  var app = new Element('div'); app.setAttribute('id', 'app');
  var toast = new Element('div'); toast.setAttribute('id', 'toast');
  body.appendChild(app); body.appendChild(toast); docEl.appendChild(body);
  var doc = {
    nodeType: 9, documentElement: docEl, body: body, readyState: 'complete', childNodes: [docEl],
    createElement: function (tag) { return new Element(tag); },
    createElementNS: function (_ns, tag) { return new Element(tag); },
    createTextNode: function (v) { return new TextNode(v); },
    addEventListener: function () {},
    getElementById: function (id) {
      var found = null;
      walk(docEl, function (el) { if (!found && el.id === id) found = el; });
      return found;
    },
    querySelector: function (sel) { return queryAll(docEl, sel)[0] || null; },
    querySelectorAll: function (sel) { return queryAll(docEl, sel); },
  };
  return doc;
}
var document = makeDoc();
function MutationObserver() {}
MutationObserver.prototype.observe = function () {};
MutationObserver.prototype.disconnect = function () {};
`;

function boot({ ua, standalone = false, wide = true, refreshToken = null, search = '' } = {}) {
  const crashes = [];
  const onCrash = (err) => { crashes.push(err); };
  process.on('unhandledRejection', onCrash);
  const sandbox = {
    console, Promise, Intl, URL, URLSearchParams, AbortController,
    Object, Array, String, Number, Boolean, RegExp, Date, Math, JSON, Error, TypeError, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent, NaN, Infinity, undefined,
    atob, btoa, queueMicrotask,
    setTimeout: unrefTimer(setTimeout), clearTimeout, setInterval: unrefTimer(setInterval), clearInterval,
    fetch: (url, opts) => fetch(new URL(typeof url === 'string' ? url : url.url, base), opts),
    localStorage: memStore(refreshToken ? { coop_refresh_token: refreshToken } : {}),
    sessionStorage: memStore(),
    location: { protocol: 'http:', search, origin: base, href: base + '/' + (search || ''), pathname: '/' },
    history: { replaceState() {}, pushState() {} },
    navigator: {
      userAgent: ua, platform: /iPhone/.test(ua) ? 'iPhone' : 'Win32',
      maxTouchPoints: /iPhone|Android/.test(ua) ? 5 : 0,
      onLine: true, standalone: !!standalone,
      serviceWorker: {
        register: () => Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(null) } }),
        getRegistration: () => Promise.resolve(null),
        ready: Promise.resolve({}),
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.matchMedia = (q) => ({
    matches: /display-mode:\s*standalone/.test(q) ? !!standalone : /min-width:\s*901px/.test(q) ? !!wide : false,
    addEventListener() {}, addListener() {},
  });
  sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(DOM, sandbox, { filename: 'dom.js' });
  scripts.gate.runInContext(sandbox);
  scripts.coop.runInContext(sandbox);
  scripts.app.runInContext(sandbox);
  const app = sandbox.document.getElementById('app');
  return {
    sandbox, app, crashes,
    stop: () => process.off('unhandledRejection', onCrash),
  };
}

async function paint(page, re, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (page.crashes.length) throw page.crashes[0];
    const text = page.app.textContent || '';
    if (re.test(text)) return text;
    await new Promise((r) => setTimeout(r, 15));
  }
  const err = new Error('La app no pintó ' + re + '. #app=' + JSON.stringify((page.app.textContent || '').slice(0, 400)));
  page.stop();
  throw err;
}

function byClass(root, cls) {
  const out = [];
  const walk = (el) => {
    for (const c of el.childNodes || []) {
      if (c.nodeType === 1) {
        if (String(c.className || '').split(/\s+/).includes(cls)) out.push(c);
        walk(c);
      }
    }
  };
  walk(root);
  return out;
}

async function login(user, pass) {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: user, password: pass }),
  });
  const j = await r.json();
  assert.equal(j.ok, true, j.error);
  return j.data;
}

test('el HTML de inicio deja #app vacío hasta que el renderer pinte', () => {
  assert.match(html.text, /<div id="app"><\/div>/);
  assert.match(html.text, /<title>Zuki Pay<\/title>/);
  assert.ok(html.text.indexOf('/install-gate.js') < html.text.indexOf('/coop-web.js'));
  assert.ok(html.text.indexOf('/coop-web.js') < html.text.indexOf('/app.js'));
  assert.match(swSrc.text, /coop-v27/);
  assert.match(swSrc.text, /'\/app\.js'/);
  assert.match(appSrc.text, /brand-school/);
  assert.match(appSrc.text, /brand-user/);
});

test('navegador de escritorio sin sesión pinta el acceso', async () => {
  const page = boot({ ua: UA.desktop, wide: true });
  try {
    const text = await paint(page, /Entrar/);
    assert.match(text, /Tiendita escolar con tarjeta/);
    assert.match(text, /Soy padre\/madre/);
    assert.equal(page.sandbox.document.getElementById('install-gate'), null);
    assert.equal(page.sandbox.document.getElementById('toast').textContent, '');
    assert.ok(page.app.childNodes.length > 0);
  } finally { page.stop(); }
});

test('sesión guardada pinta el encabezado compacto y el resumen', async () => {
  const data = await login('admin', 'admin123');
  const page = boot({ ua: UA.desktop, wide: true, refreshToken: data.refresh_token });
  try {
    const text = await paint(page, /Resumen de la cooperativa/);
    assert.match(text, /Ventas de hoy/);
    assert.equal(byClass(page.app, 'brand-school')[0].textContent, data.user.school_name);
    const who = byClass(page.app, 'brand-user')[0].textContent;
    assert.match(who, new RegExp(data.user.full_name));
    assert.match(who, /Administrador/);
    assert.equal(byClass(page.app, 'brand-logo').length, 1);
    assert.match(text, /Cerrar sesión/);
    assert.match(text, /Ayuda/);
    assert.equal(page.sandbox.document.querySelector('.result.err'), null);
    assert.equal(page.sandbox.document.getElementById('toast').textContent, '');
  } finally { page.stop(); }
});

test('PWA instalada (iPhone standalone) con sesión pinta la app y no la pantalla de instalar', async () => {
  const data = await login('admin', 'admin123');
  const page = boot({ ua: UA.iphone, standalone: true, wide: false, refreshToken: data.refresh_token });
  try {
    const text = await paint(page, /Resumen de la cooperativa/);
    assert.equal(page.sandbox.document.getElementById('install-gate'), null);
    assert.equal(byClass(page.app, 'brand-school')[0].textContent, data.user.school_name);
    assert.match(byClass(page.app, 'brand-user')[0].textContent, new RegExp(data.user.full_name));
    assert.match(text, /Ventas de hoy/);
    assert.equal(page.sandbox.document.getElementById('toast').textContent, '');
  } finally { page.stop(); }
});

test('token guardado que el servidor rechaza vuelve al acceso y no deja #app vacío', async () => {
  const page = boot({ ua: UA.desktop, refreshToken: 'token-viejo-no-valido' });
  try {
    const text = await paint(page, /Entrar/);
    assert.match(text, /Tiendita escolar con tarjeta/);
    assert.equal(page.app.childNodes.length > 0, true);
    assert.equal(page.sandbox.document.getElementById('toast').textContent, '');
  } finally { page.stop(); }
});

test('la caché nueva borra la cáscara coop-v26 y guarda un app.js que parsea', async () => {
  const handlers = {};
  const stores = new Map();
  const openStore = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
  openStore('coop-v26').set('/app.js', 'this is not valid ((((');
  openStore('coop-v26').set('/', '<div id="app"></div>');
  const ctx = {
    self: { addEventListener: (n, h) => { handlers[n] = h; }, skipWaiting() {}, clients: { claim() {} }, location: { origin: base } },
    caches: {
      async open(name) {
        const s = openStore(name);
        return {
          async addAll(reqs) {
            for (const req of reqs) {
              const url = req.url || req;
              const r = await ctx.fetch(url);
              s.set(new URL(url, base).pathname, await r.text());
            }
          },
          async put(k, r) { s.set(k, r); },
          async match(k) { return s.has(k) ? s.get(k) : undefined; },
        };
      },
      async keys() { return [...stores.keys()]; },
      async delete(name) { return stores.delete(name); },
    },
    fetch: async (req) => {
      const url = typeof req === 'string' ? req : req.url;
      const r = await fetch(new URL(url, base));
      const text = await r.text();
      return { ok: r.ok, text: async () => text };
    },
    Request: function Request(u) { this.url = u; },
    Response: { error: () => ({ error: true }) },
    URL,
  };
  vm.runInNewContext(swSrc.text, ctx);
  let installP; handlers.install({ waitUntil: (p) => { installP = p; } }); await installP;
  let activateP; handlers.activate({ waitUntil: (p) => { activateP = p; } }); await activateP;
  assert.deepEqual([...stores.keys()], ['coop-v27']);
  const cached = stores.get('coop-v27').get('/app.js');
  new vm.Script(cached, { filename: 'cached-app.js' });
  assert.match(cached, /brand-school/);
  assert.equal(stores.has('coop-v26'), false);
});
