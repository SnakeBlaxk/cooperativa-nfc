'use strict';
/* Cooperativa NFC — interfaz (renderer). Sin frameworks ni build. */
(function () {
  // ---------- utilidades ----------
  const $app = document.getElementById('app');
  const WEB = !!(window.coop && window.coop.web);
  const state = { user: null, view: null, params: {} };

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'autofocus') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  // append que ignora null/undefined/false (evita textos "null" en pantalla)
  const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
  const fmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
  const money = (c) => fmt.format((Number(c) || 0) / 100);
  const fmtDate = (s) => { if (!s) return ''; const [d, t] = s.split(' '); const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y} ${t ? t.slice(0, 5) : ''}`; };
  function parseMoney(str, { optional = false } = {}) {
    const s = String(str || '').trim().replace(/[$,\s]/g, '');
    if (s === '') { if (optional) return null; throw new Error('Indica un monto'); }
    if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Monto inválido: usa números, p. ej. 15.50');
    return Math.round(parseFloat(s) * 100);
  }
  const centsToInput = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2));
  function toast(msg, type = '') {
    const t = h('div', { class: 'toast ' + type }, msg);
    document.getElementById('toast').appendChild(t);
    setTimeout(() => t.remove(), type === 'err' ? 6000 : 3500);
  }
  async function call(method, args) {
    const r = await window.coop.call(method, args);
    if (!r.ok) {
      if (r.code === 'NO_AUTENTICADO' && method !== 'login') { state.user = null; render(); }
      throw new Error(r.error);
    }
    return r.data;
  }
  async function safe(fn) { try { return await fn(); } catch (e) { toast(e.message, 'err'); return undefined; } }
  function modal(title, body, actions) {
    const bg = h('div', { class: 'modal-bg' });
    const close = () => bg.remove();
    const acts = (actions || [{ label: 'Cerrar' }]).map((a) => h('button', {
      class: 'btn ' + (a.class || ''), onclick: async () => { if (a.onClick) { const keep = await a.onClick(close); if (keep === false) return; } close(); },
    }, a.label));
    bg.appendChild(h('div', { class: 'modal' }, h('h2', null, title), body, h('div', { class: 'actions' }, acts)));
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
    document.body.appendChild(bg);
    const f = bg.querySelector('input,select,textarea'); if (f) setTimeout(() => f.focus(), 30);
    return close;
  }
  function confirmBox(title, text) {
    return new Promise((res) => {
      modal(title, h('p', null, text), [{ label: 'Cancelar', onClick: () => res(false) }, { label: 'Confirmar', class: 'primary', onClick: () => res(true) }]);
    });
  }
  function field(label, input) { return h('label', null, label, input); }
  function badge(text, cls) { return h('span', { class: 'badge ' + (cls || text) }, text.replace('_', ' ')); }
  function avatar(photo, size) {
    const a = h('div', { class: 'avatar', style: size ? { width: size + 'px', height: size + 'px' } : null });
    if (photo) a.appendChild(h('img', { src: photo, alt: '' })); else a.textContent = '🧒';
    return a;
  }
  function resizeImage(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 240; const sc = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas'); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.82));
        };
        img.onerror = () => rej(new Error('Imagen inválida'));
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }
  function limitsText(l) {
    if (!l) return 'Sin límites';
    const p = [];
    if (l.per_transaction_cents !== null) p.push('por compra ' + money(l.per_transaction_cents));
    if (l.per_day_cents !== null) p.push('diario ' + money(l.per_day_cents));
    if (l.period_type) p.push((l.period_type === 'semana' ? 'semanal ' : 'mensual ') + money(l.per_period_cents));
    return p.length ? p.join(' · ') : 'Sin límites';
  }

  // ---------- navegación ----------
  const NAV = {
    superadmin: [['instituciones', 'Instituciones'], ['ajustes', 'Mi cuenta']],
    admin: [['dashboard', 'Panel'], ['pos', 'Punto de venta'], ['recargas', 'Recargas'], ['productos', 'Productos'], ['tarjetas', 'Tarjetas'], ...(WEB ? [] : [['programar', 'Programar tarjetas']]), ['alumnos', 'Tutores y alumnos'], ['movimientos', 'Movimientos'], ['usuarios', 'Usuarios'], ['ajustes', 'Ajustes']],
    cajero: [['pos', 'Punto de venta'], ['recargas', 'Recargas'], ['movimientos', 'Movimientos'], ['ajustes', 'Mi cuenta']],
    tutor: [['hijos', 'Mis hijos'], ['movimientos', 'Historial'], ['ajustes', 'Mi cuenta']],
  };
  const ROLE_LABEL = { superadmin: 'Superadministrador', admin: 'Administrador', cajero: 'Cajero', tutor: 'Padre / tutor' };
  function go(view, params = {}) { state.view = view; state.params = params; render(); }

  function render() {
    teardown();
    $app.innerHTML = '';
    if (!state.user) {
      const qs = new URLSearchParams(location.search);
      if (WEB && qs.get('reset')) return renderReset(qs.get('reset'));
      if (WEB && state.view === 'registro') return renderRegister();
      if (WEB && state.view === 'olvide') return renderForgot();
      return renderLogin();
    }
    if (state.user.must_change_password) return renderForceChange();
    const items = NAV[state.user.role];
    const extra = state.user.role === 'superadmin' ? ['institucion'] : ['hijo'];
    if (!state.view || !VIEWS[state.view] || !(items.some(([k]) => k === state.view) || extra.includes(state.view))) state.view = items[0][0];
    const main = h('div', { class: 'main' });
    const navActive = state.view === 'hijo' ? (state.user.role === 'tutor' ? 'hijos' : 'alumnos') : (state.view === 'institucion' ? 'instituciones' : state.view);
    const subtitle = state.user.role === 'superadmin' ? 'Zuki Company · Plataforma' : (state.user.role === 'tutor' ? 'Tiendita escolar' : (state.user.school_name || 'Tiendita escolar'));
    $app.appendChild(h('div', { class: 'layout' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, '🪪 Cooperativa NFC', h('small', null, subtitle)),
        h('nav', { class: 'nav' }, items.map(([k, l]) => h('a', { class: k === navActive ? 'active' : '', onclick: () => go(k) }, l))),
        !WEB && state.user.role !== 'tutor' ? h('div', { id: 'syncind', class: 'syncind', title: 'Clic para sincronizar ahora', onclick: () => window.coop.sync.now().then(updateSyncInd) }) : null,
        h('div', { class: 'who' }, h('b', null, state.user.full_name), ROLE_LABEL[state.user.role],
          h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: logout }, 'Cerrar sesión')))),
      main));
    if (!WEB && state.user.role !== 'tutor') window.coop.sync.status().then(updateSyncInd);
    Promise.resolve(VIEWS[state.view](main, state.params)).catch((e) => { main.appendChild(h('div', { class: 'result err' }, e.message)); });
  }
  let cleanups = [];
  function onCleanup(fn) { cleanups.push(fn); }
  function teardown() { cleanups.forEach((f) => { try { f(); } catch (_) { /* */ } }); cleanups = []; }
  async function logout() { await window.coop.call('logout'); state.user = null; state.view = null; render(); }

  function renderLogin() {
    const u = h('input', { placeholder: 'Usuario, correo o teléfono', autofocus: true, autocomplete: 'username' });
    const p = h('input', { placeholder: 'Contraseña', type: 'password', autocomplete: 'current-password' });
    const err = h('div', { class: 'small', style: { color: 'var(--err)', minHeight: '18px' } });
    const submit = async (e) => {
      e.preventDefault(); err.textContent = '';
      try { state.user = await call('login', { username: u.value, password: p.value }); state.view = null; render(); if (state.user && state.user.offline) toast('Servidor no disponible: sesión iniciada en modo sin conexión'); } catch (ex) { err.textContent = ex.message; p.select(); }
    };
    $app.appendChild(h('div', { class: 'login-wrap' }, h('form', { class: 'card login form', onsubmit: submit },
      h('div', { class: 'logo' }, '🪪'), h('h1', null, 'Cooperativa NFC'),
      field('Usuario, correo o teléfono', u), field('Contraseña', p), err,
      h('button', { class: 'btn primary lg', type: 'submit' }, 'Entrar'),
      WEB ? h('div', { class: 'row', style: { justifyContent: 'space-between' } },
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('olvide'); } }, '¿Olvidaste tu contraseña?'),
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('registro'); } }, 'Tengo un código de invitación')) : null,
      h('div', { class: 'demo' }, h('b', null, 'Accesos de demostración:'), h('br'), 'Administrador: admin / admin123', h('br'), 'Cajero: cajero / cajero123', h('br'), 'Tutores: maria / tutor123 · juan / tutor123', WEB ? [h('br'), 'Superadmin (Zuki): zuki / zuki123 · Escuela 2: admin2 / admin123'] : null, h('br'), 'Cambia estas contraseñas antes de usar la app en producción.'))));
    setTimeout(() => u.focus(), 50);
  }

  // ---------- pantallas de cuenta (cambio obligatorio, recuperación, registro) ----------
  function authCard(title, ...kids) {
    $app.appendChild(h('div', { class: 'login-wrap' }, h('div', { class: 'card login form' }, h('div', { class: 'logo' }, '🪪'), h('h1', null, title), ...kids)));
  }
  function renderForceChange() {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }); const n1 = h('input', { type: 'password', autocomplete: 'new-password' }); const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const err = h('div', { class: 'small', style: { color: 'var(--err)' } });
    const go2 = async () => {
      err.textContent = '';
      if (n1.value !== n2.value) { err.textContent = 'Las contraseñas nuevas no coinciden'; return; }
      try { state.user = await call('changePassword', { current: cur.value, next: n1.value }); toast('Contraseña actualizada', 'ok'); render(); } catch (e) { err.textContent = e.message; }
    };
    authCard('Cambia tu contraseña', h('p', { class: 'muted small' }, `Hola ${state.user.full_name}. Tu contraseña es temporal; crea una nueva para continuar.`),
      field('Contraseña temporal / actual', cur), field('Nueva contraseña (mín. 6)', n1), field('Repetir nueva contraseña', n2), err,
      h('button', { class: 'btn primary lg', onclick: go2 }, 'Guardar y continuar'), h('button', { class: 'btn', onclick: logout }, 'Cerrar sesión'));
  }
  function renderForgot() {
    const id = h('input', { placeholder: 'Correo, teléfono o usuario' }); const msg = h('div', { class: 'small' });
    authCard('Recuperar contraseña', h('p', { class: 'muted small' }, 'Te enviaremos un enlace para crear una nueva contraseña.'), field('Cuenta', id), msg,
      h('button', { class: 'btn primary lg', onclick: async () => { const r = await window.coop.auth.forgot(id.value); msg.textContent = r.ok ? r.data.message : r.error; msg.style.color = r.ok ? 'var(--ok)' : 'var(--err)'; } }, 'Enviar enlace'),
      h('button', { class: 'btn', onclick: () => go(null) }, 'Volver'));
  }
  function renderReset(token) {
    const n1 = h('input', { type: 'password', autocomplete: 'new-password' }); const n2 = h('input', { type: 'password', autocomplete: 'new-password' }); const msg = h('div', { class: 'small' });
    authCard('Nueva contraseña', field('Nueva contraseña (mín. 6)', n1), field('Repetir', n2), msg,
      h('button', { class: 'btn primary lg', onclick: async () => {
        if (n1.value !== n2.value) { msg.textContent = 'No coinciden'; msg.style.color = 'var(--err)'; return; }
        const r = await window.coop.auth.reset(token, n1.value);
        msg.textContent = r.ok ? r.data.message : r.error; msg.style.color = r.ok ? 'var(--ok)' : 'var(--err)';
        if (r.ok) setTimeout(() => { history.replaceState(null, '', '/'); go(null); }, 1500);
      } }, 'Guardar contraseña'));
  }
  function renderRegister() {
    const code = h('input', { placeholder: 'COOP-XXXX-XXXX', style: { textTransform: 'uppercase' } }); const name = h('input', { autocomplete: 'name' });
    const email = h('input', { type: 'email', autocomplete: 'email' }); const phone = h('input', { type: 'tel', autocomplete: 'tel', placeholder: '10 dígitos' });
    const p1 = h('input', { type: 'password', autocomplete: 'new-password' }); const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const msg = h('div', { class: 'small', style: { color: 'var(--err)' } });
    authCard('Crear cuenta de tutor', h('p', { class: 'muted small' }, 'Use el código de invitación que le entregó la cooperativa junto con la tarjeta de su hijo(a).'),
      field('Código de invitación', code), field('Nombre completo', name), h('div', { class: 'grid g2' }, field('Correo', email), field('Teléfono', phone)),
      field('Contraseña (mín. 8)', p1), field('Repetir contraseña', p2), msg,
      h('button', { class: 'btn primary lg', onclick: async () => {
        msg.textContent = '';
        if (p1.value !== p2.value) { msg.textContent = 'Las contraseñas no coinciden'; return; }
        const r = await window.coop.auth.register({ code: code.value, full_name: name.value, email: email.value || null, phone: phone.value || null, password: p1.value });
        if (!r.ok) { msg.textContent = r.error; return; }
        state.user = r.data; state.view = null; toast('¡Cuenta creada! Su hijo(a) ya está vinculado.', 'ok'); render();
      } }, 'Crear cuenta'), h('button', { class: 'btn', onclick: () => go(null) }, 'Volver'));
  }

  // ---------- lector de tarjetas (teclado USB + PC/SC por IPC) ----------
  // Los lectores USB tipo teclado "escriben" el UID muy rápido y terminan con Enter.
  // Si el foco no está en un campo de texto, capturamos esa ráfaga como UID.
  function listenCardReader(onUid) {
    let buf = ''; let last = 0;
    const kd = (e) => {
      const t = e.target; const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      if (typing || document.querySelector('.modal-bg')) return;
      const nowT = Date.now();
      if (nowT - last > 80) buf = '';
      last = nowT;
      if (e.key === 'Enter') { if (buf.length >= 4) { onUid(buf); e.preventDefault(); } buf = ''; return; }
      if (e.key.length === 1 && /[0-9a-zA-Z:\- ]/.test(e.key)) buf += e.key;
    };
    document.addEventListener('keydown', kd);
    const off = window.coop.onNfcUid((uid) => { if (!document.querySelector('.modal-bg')) onUid(uid); });
    onCleanup(() => { document.removeEventListener('keydown', kd); off(); });
  }

  // ---------- vistas ----------
  const VIEWS = {};

  VIEWS.dashboard = async (main) => {
    main.appendChild(h('h1', null, 'Panel de la cooperativa'));
    const d = await call('dashboard');
    const stat = (l, v, sub) => h('div', { class: 'card stat' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), sub ? h('div', { class: 'small muted' }, sub) : null);
    main.appendChild(h('div', { class: 'grid g4' },
      stat('Ventas de hoy', money(d.sales_day_cents), `${d.sales_day_count} ventas`),
      stat('Ventas de la semana', money(d.sales_week_cents)),
      stat('Ventas del mes', money(d.sales_month_cents)),
      stat('Tarjetas activas', String(d.active_cards), `de ${d.total_cards} registradas`),
      stat('Recargas de hoy', money(d.recharges_day_cents)),
      stat('Recargas del mes', money(d.recharges_month_cents), 'Total histórico ' + money(d.recharges_total_cents)),
      stat('Saldo en tarjetas', money(d.balance_in_cards_cents), 'Dinero de los alumnos'),
      stat('Rechazos de hoy', String(d.rejected_today), 'Por límites, saldo o prohibiciones')));
    main.appendChild(h('div', { class: 'grid', style: { gridTemplateColumns: '2fr 1fr', marginTop: '16px' } },
      h('div', { class: 'card chart' }, h('h2', null, 'Ventas por día (últimos 14 días)'), barChart(d.sales_by_day)),
      h('div', { class: 'card' }, h('h2', null, 'Más vendidos del mes'),
        d.top_products.length ? h('table', null, h('tr', null, h('th', null, 'Producto'), h('th', { class: 'right' }, 'Piezas'), h('th', { class: 'right' }, 'Total')),
          d.top_products.map((p) => h('tr', null, h('td', null, p.name), h('td', { class: 'right' }, p.qty), h('td', { class: 'right' }, money(p.total_cents)))))
          : h('div', { class: 'empty' }, 'Sin ventas este mes'))));
  };
  function barChart(data) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 700; const H = 240; const pad = { l: 56, r: 10, t: 14, b: 34 };
    const max = Math.max(1000, ...data.map((d) => d.total_cents));
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const mk = (tag, a, text) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); if (text) e.textContent = text; svg.appendChild(e); return e; };
    const ih = H - pad.t - pad.b; const iw = W - pad.l - pad.r; const bw = iw / data.length;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + ih - (ih * i) / 4;
      mk('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: '#e3e7ef' });
      mk('text', { x: pad.l - 6, y: y + 3, 'text-anchor': 'end' }, money((max * i) / 4).replace('.00', ''));
    }
    data.forEach((d, i) => {
      const bh = (d.total_cents / max) * ih; const x = pad.l + i * bw + bw * 0.15;
      const r = mk('rect', { x, y: pad.t + ih - bh, width: bw * 0.7, height: Math.max(bh, 0), rx: 4, fill: '#2f6fec' });
      const t = document.createElementNS(NS, 'title'); t.textContent = `${d.date}: ${money(d.total_cents)}`; r.appendChild(t);
      const [, m, dd] = d.date.split('-');
      mk('text', { x: x + bw * 0.35, y: H - pad.b + 14, 'text-anchor': 'middle' }, `${dd}/${m}`);
    });
    return svg;
  }

  // ----- Punto de venta -----
  VIEWS.pos = async (main) => {
    const [products, categories] = await Promise.all([call('listProducts', { onlyActive: true }), call('listCategories')]);
    let card = null; let cart = []; let busy = false;
    const uidIn = h('input', { placeholder: 'Acerque la tarjeta o escriba el UID y presione Enter', autofocus: true });
    const info = h('div', { class: 'card cardinfo' });
    const result = h('div');
    const prodBox = h('div', { class: 'products card' });
    const cartBox = h('div', { class: 'items' });
    const totalEl = h('span');
    const payBtn = h('button', { class: 'btn ok lg', onclick: () => charge() }, 'Cobrar (F2)');
    const nfcLbl = h('span', { class: 'small muted' });
    window.coop.nfcStatus().then((s) => { nfcLbl.textContent = s.message; });
    const webNfcBtn = window.coop.startWebNfc && 'NDEFReader' in window ? h('button', { class: 'btn', onclick: () => window.coop.startWebNfc().catch((e) => toast(e.message, 'err')) }, 'Leer con NFC del teléfono') : null;
    onCleanup(window.coop.onNfcStatus((s) => { nfcLbl.textContent = s.message; }));

    function renderInfo() {
      info.innerHTML = '';
      if (!card) { info.appendChild(h('div', { class: 'muted' }, 'Sin tarjeta. Acerque la tarjeta del alumno al lector.')); return; }
      const c = card.child;
      put(info, avatar(c && c.photo), h('div', { class: 'grow' },
        h('div', { style: { fontSize: '1.2rem', fontWeight: 700 } }, c ? c.full_name : 'Tarjeta sin asignar', ' ', badge(card.status)),
        h('div', { class: 'small muted' }, c ? `${c.grade || ''} · Tutor: ${c.tutor_name}` : '', ' · UID ', card.uid),
        card.limits ? h('div', { class: 'small muted' }, 'Límites: ', limitsText(card.limits), ' · Gastado hoy: ', money(card.spent_today_cents)) : null),
      h('div', { class: 'right' }, h('div', { class: 'small muted' }, 'Saldo'), h('div', { class: 'bal' }, money(card.balance_cents))));
    }
    function renderProducts() {
      prodBox.innerHTML = '';
      const forbP = new Set(card && card.prohibited_products || []); const forbC = new Set(card && card.prohibited_categories || []);
      for (const cat of categories) {
        const ps = products.filter((p) => p.category_id === cat.id);
        if (!ps.length) continue;
        prodBox.appendChild(h('div', { class: 'catname' }, cat.name, forbC.has(cat.id) ? ' — prohibida para este alumno' : ''));
        prodBox.appendChild(h('div', { class: 'pgrid' }, ps.map((p) => h('button', {
          class: 'pbtn' + (forbP.has(p.id) || forbC.has(p.category_id) ? ' forbidden' : ''),
          title: forbP.has(p.id) || forbC.has(p.category_id) ? 'Prohibido por el tutor' : '',
          onclick: () => { add(p); },
        }, h('b', null, p.name), h('span', null, money(p.price_cents))))));
      }
    }
    function add(p) {
      const l = cart.find((x) => x.p.id === p.id);
      if (l) l.qty++; else cart.push({ p, qty: 1 });
      result.innerHTML = ''; renderCart();
    }
    function renderCart() {
      cartBox.innerHTML = '';
      if (!cart.length) cartBox.appendChild(h('div', { class: 'empty' }, 'Carrito vacío'));
      for (const l of cart) {
        cartBox.appendChild(h('div', { class: 'cline' }, h('div', { class: 'n' }, l.p.name, h('div', { class: 'small muted' }, money(l.p.price_cents))),
          h('button', { class: 'btn sm', onclick: () => { l.qty--; if (l.qty <= 0) cart = cart.filter((x) => x !== l); renderCart(); } }, '−'),
          h('b', { style: { minWidth: '22px', textAlign: 'center' } }, l.qty),
          h('button', { class: 'btn sm', onclick: () => { l.qty++; renderCart(); } }, '+'),
          h('div', { style: { width: '80px', textAlign: 'right' } }, money(l.p.price_cents * l.qty))));
      }
      totalEl.textContent = money(cart.reduce((s, l) => s + l.qty * l.p.price_cents, 0));
      payBtn.disabled = !cart.length || !card;
    }
    async function lookup(uid) {
      uid = String(uid || '').trim(); if (!uid) return;
      uidIn.value = uid;
      try { card = await call('lookupCard', { uid }); result.innerHTML = ''; } catch (e) { card = null; result.innerHTML = ''; result.appendChild(h('div', { class: 'result err' }, e.message)); }
      renderInfo(); renderProducts(); renderCart();
    }
    async function charge() {
      if (busy || !card || !cart.length) return;
      busy = true; payBtn.disabled = true;
      try {
        const r = await call('purchase', { uid: card.uid, items: cart.map((l) => ({ product_id: l.p.id, qty: l.qty })) });
        result.innerHTML = '';
        if (r.ok) {
          result.appendChild(h('div', { class: 'result ok' }, `✔ Venta aprobada: ${money(r.total_cents)} — ${r.child_name}. Saldo restante: ${money(r.balance_cents)}`));
          cart = []; card = null; uidIn.value = ''; renderInfo(); renderProducts();
        } else {
          result.appendChild(h('div', { class: 'result err' }, `✖ Rechazada: ${r.reason}`));
          card = await call('lookupCard', { uid: card.uid }).catch(() => card); renderInfo();
        }
      } catch (e) { result.innerHTML = ''; result.appendChild(h('div', { class: 'result err' }, e.message)); }
      busy = false; renderCart(); uidIn.focus();
    }
    uidIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(uidIn.value); } });
    const fkey = (e) => { if (e.key === 'F2') { e.preventDefault(); charge(); } if (e.key === 'Escape' && !document.querySelector('.modal-bg')) { cart = []; card = null; uidIn.value = ''; result.innerHTML = ''; renderInfo(); renderProducts(); renderCart(); uidIn.focus(); } };
    document.addEventListener('keydown', fkey); onCleanup(() => document.removeEventListener('keydown', fkey));
    listenCardReader(lookup);

    put(main, h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h1', { style: { margin: 0 } }, 'Punto de venta'), h('div', { class: 'grow' }), webNfcBtn, nfcLbl),
      h('div', { class: 'pos' },
        h('div', { class: 'left' }, h('div', { class: 'uidbox' }, uidIn, h('button', { class: 'btn primary', onclick: () => lookup(uidIn.value) }, 'Leer')), info, result, prodBox),
        h('div', { class: 'card cart' }, h('h2', null, 'Carrito'), cartBox, h('div', { class: 'total' }, h('span', null, 'Total'), totalEl), payBtn,
          h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: () => { cart = []; renderCart(); } }, 'Vaciar carrito (Esc limpia todo)'))));
    renderInfo(); renderProducts(); renderCart();
    setTimeout(() => uidIn.focus(), 50);
  };

  // ----- Recargas -----
  VIEWS.recargas = async (main) => {
    let card = null;
    const uidIn = h('input', { placeholder: 'Acerque la tarjeta o escriba el UID y presione Enter', style: { fontSize: '1.15rem', padding: '12px' } });
    const info = h('div', { class: 'card cardinfo' });
    const amount = h('input', { placeholder: '0.00', style: { fontSize: '1.3rem', width: '160px' } });
    const note = h('input', { placeholder: 'Nota (opcional): efectivo, transferencia…', class: 'grow' });
    const result = h('div');
    const recent = h('div', { class: 'card' });
    function renderInfo() {
      info.innerHTML = '';
      if (!card) { info.appendChild(h('div', { class: 'muted' }, 'Lea una tarjeta para recargar.')); return; }
      put(info, avatar(card.child && card.child.photo), h('div', { class: 'grow' },
        h('div', { style: { fontSize: '1.2rem', fontWeight: 700 } }, card.child ? card.child.full_name : 'Tarjeta sin asignar', ' ', badge(card.status)),
        h('div', { class: 'small muted' }, card.child ? 'Tutor: ' + card.child.tutor_name : '', ' · UID ', card.uid)),
      h('div', { class: 'right' }, h('div', { class: 'small muted' }, 'Saldo actual'), h('div', { class: 'bal' }, money(card.balance_cents))));
    }
    async function lookup(uid) {
      uid = String(uid || '').trim(); if (!uid) return; uidIn.value = uid; result.innerHTML = '';
      try { card = await call('lookupCard', { uid }); amount.focus(); } catch (e) { card = null; result.appendChild(h('div', { class: 'result err' }, e.message)); }
      renderInfo();
    }
    async function doRecharge() {
      result.innerHTML = '';
      try {
        if (!card) throw new Error('Primero lea una tarjeta');
        const c = parseMoney(amount.value);
        if (!(await confirmBox('Confirmar recarga', `¿Recargar ${money(c)} a ${card.child ? card.child.full_name : card.uid}?`))) return;
        const r = await call('recharge', { uid: card.uid, amount_cents: c, note: note.value });
        result.appendChild(h('div', { class: 'result ok' }, `✔ Recarga de ${money(c)} aplicada. Nuevo saldo: ${money(r.balance_cents)}`));
        card = r.card; amount.value = ''; note.value = ''; renderInfo(); loadRecent();
      } catch (e) { result.appendChild(h('div', { class: 'result err' }, e.message)); }
    }
    async function loadRecent() {
      const rows = await call('listMovements', { type: 'recarga', limit: 15 });
      recent.innerHTML = ''; recent.appendChild(h('h2', null, 'Últimas recargas'));
      recent.appendChild(h('table', null, h('tr', null, h('th', null, 'Fecha'), h('th', null, 'Alumno'), h('th', null, 'Atendió'), h('th', { class: 'right' }, 'Monto')),
        rows.map((m) => h('tr', null, h('td', null, fmtDate(m.created_at)), h('td', null, m.child_name || m.card_uid), h('td', null, m.user_name || ''), h('td', { class: 'right' }, money(m.amount_cents))))));
    }
    uidIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(uidIn.value); } });
    amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doRecharge(); } });
    listenCardReader(lookup);
    put(main, h('h1', null, 'Recargas'),
      h('div', { class: 'grid', style: { gridTemplateColumns: '1fr 1fr' } },
        h('div', { class: 'grid' }, h('div', { class: 'uidbox' }, uidIn, h('button', { class: 'btn primary', onclick: () => lookup(uidIn.value) }, 'Leer')), info,
          h('div', { class: 'card form' }, h('h2', null, 'Monto a recargar (MXN)'),
            h('div', { class: 'row' }, [50, 100, 200, 300, 500].map((v) => h('button', { class: 'btn', onclick: () => { amount.value = v.toFixed(2); amount.focus(); } }, '$' + v))),
            h('div', { class: 'row' }, amount, note),
            h('button', { class: 'btn primary lg', onclick: doRecharge }, 'Registrar recarga')), result),
        recent));
    renderInfo(); loadRecent(); setTimeout(() => uidIn.focus(), 50);
  };

  // ----- Productos -----
  VIEWS.productos = async (main) => {
    const [products, categories] = await Promise.all([call('listProducts'), call('listCategories')]);
    const edit = (p) => {
      const name = h('input', { value: p ? p.name : '' });
      const cat = h('select', null, categories.map((c) => h('option', { value: c.id, selected: p && p.category_id === c.id }, c.name)));
      const price = h('input', { value: p ? centsToInput(p.price_cents) : '', placeholder: '0.00' });
      const active = h('input', { type: 'checkbox', checked: p ? p.active : true });
      modal(p ? 'Editar producto' : 'Nuevo producto', h('div', { class: 'form' }, field('Nombre', name), field('Categoría', cat), field('Precio (MXN)', price), h('label', { class: 'check' }, active, 'Activo (visible en punto de venta)')),
        [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
          try {
            const data = { name: name.value, category_id: Number(cat.value), price_cents: parseMoney(price.value), active: active.checked };
            if (p) await call('updateProduct', { id: p.id, ...data }); else await call('createProduct', data);
            toast('Producto guardado', 'ok'); render();
          } catch (e) { toast(e.message, 'err'); return false; }
        } }]);
    };
    const newCat = () => {
      const n = h('input', { placeholder: 'p. ej. Lácteos' });
      modal('Nueva categoría', field('Nombre', n), [{ label: 'Cancelar' }, { label: 'Crear', class: 'primary', onClick: async () => {
        try { await call('createCategory', { name: n.value }); toast('Categoría creada', 'ok'); render(); } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const del = async (p) => {
      if (!(await confirmBox('Eliminar producto', `¿Eliminar "${p.name}"? Si tiene ventas, solo se desactivará.`))) return;
      const r = await safe(() => call('deleteProduct', { id: p.id }));
      if (r) { toast(r.message || 'Producto eliminado', 'ok'); render(); }
    };
    put(main, h('div', { class: 'row', style: { marginBottom: '14px' } }, h('h1', { style: { margin: 0 } }, 'Productos'), h('div', { class: 'grow' }),
      h('button', { class: 'btn', onclick: newCat }, '+ Categoría'), h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ Producto')),
    h('div', { class: 'card' }, h('table', null, h('tr', null, h('th', null, 'Producto'), h('th', null, 'Categoría'), h('th', { class: 'right' }, 'Precio'), h('th', null, 'Estado'), h('th', null, '')),
      products.map((p) => h('tr', null, h('td', null, p.name), h('td', null, p.category_name), h('td', { class: 'right' }, money(p.price_cents)),
        h('td', null, p.active ? badge('activo', 'ok') : badge('inactivo', '')),
        h('td', { class: 'right' }, h('button', { class: 'btn sm', onclick: () => edit(p) }, 'Editar'), ' ',
          h('button', { class: 'btn sm', onclick: async () => { await safe(() => call('updateProduct', { id: p.id, active: !p.active })); render(); } }, p.active ? 'Desactivar' : 'Activar'), ' ',
          h('button', { class: 'btn sm danger', onclick: () => del(p) }, 'Eliminar')))))));
  };

  // ----- Tarjetas -----
  VIEWS.tarjetas = async (main) => {
    const [cards, children] = await Promise.all([call('listCards'), call('listChildren')]);
    const childOpts = (sel) => [h('option', { value: '' }, '— Sin asignar (inventario) —'), ...children.map((c) => h('option', { value: c.id, selected: sel === c.id }, `${c.full_name} (${c.tutor ? c.tutor.full_name : ''})${c.card ? ' — ya tiene tarjeta' : ''}`))];
    const uidIn = h('input', { placeholder: 'UID: acerque la tarjeta al lector', class: 'grow' });
    const childSel = h('select', null, childOpts(null));
    const register = async () => {
      const r = await safe(() => call('registerCard', { uid: uidIn.value, child_id: childSel.value ? Number(childSel.value) : null }));
      if (r) { toast('Tarjeta registrada: ' + r.uid, 'ok'); render(); }
    };
    uidIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); childSel.focus(); } });
    const assign = (k) => {
      const sel = h('select', null, children.map((c) => h('option', { value: c.id, selected: k.child_id === c.id }, `${c.full_name} (${c.tutor ? c.tutor.full_name : ''})`)));
      modal('Asignar tarjeta ' + k.uid, field('Alumno', sel), [{ label: 'Cancelar' }, { label: 'Asignar', class: 'primary', onClick: async () => {
        try { await call('assignCard', { card_id: k.id, child_id: Number(sel.value) }); toast('Tarjeta asignada', 'ok'); render(); } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const lost = (k) => {
      const nu = h('input', { placeholder: 'UID de la tarjeta nueva (opcional)' });
      modal('Reportar tarjeta perdida', h('div', { class: 'form' },
        h('p', null, `La tarjeta ${k.uid} quedará inutilizable. Su saldo (${money(k.balance_cents)}) se transferirá a la tarjeta nueva. Si aún no tiene tarjeta nueva, el saldo queda pendiente y se abonará al asignarle una.`), field('Tarjeta nueva', nu)),
      [{ label: 'Cancelar' }, { label: 'Reportar perdida', class: 'danger', onClick: async () => {
        try { const r = await call('reportLostAndReplace', { card_id: k.id, new_uid: nu.value || null }); toast(`Tarjeta reportada. Saldo transferido: ${money(r.transferred_cents)}`, 'ok'); render(); } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const adjust = (k) => {
      const amt = h('input', { placeholder: 'p. ej. -10.00 o 25.00' }); const note = h('input', { placeholder: 'Motivo (obligatorio)' });
      modal('Ajuste de saldo — ' + k.uid, h('div', { class: 'form' }, h('p', { class: 'muted small' }, 'Use ajustes solo para correcciones (errores de cobro, devoluciones). Quedan registrados.'), field('Monto (negativo para descontar)', amt), field('Motivo', note)),
        [{ label: 'Cancelar' }, { label: 'Aplicar', class: 'primary', onClick: async () => {
          try {
            const s = amt.value.trim(); const neg = s.startsWith('-');
            const c = parseMoney(neg ? s.slice(1) : s) * (neg ? -1 : 1);
            await call('adjust', { uid: k.uid, amount_cents: c, note: note.value }); toast('Ajuste aplicado', 'ok'); render();
          } catch (e) { toast(e.message, 'err'); return false; }
        } }]);
    };
    listenCardReader((uid) => { uidIn.value = uid; childSel.focus(); });
    put(main, h('h1', null, 'Tarjetas NFC'),
      h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h2', null, 'Registrar tarjeta'),
        h('div', { class: 'row' }, uidIn, childSel, h('button', { class: 'btn primary', onclick: register }, 'Registrar')),
        h('p', { class: 'small muted' }, 'Con un lector USB tipo teclado, haga clic en el campo UID y acerque la tarjeta. Se pueden registrar tarjetas sin asignar (inventario) y asignarlas después.')),
      h('div', { class: 'card' }, h('table', null, h('tr', null, h('th', null, 'UID'), h('th', null, 'Estado'), h('th', null, 'Alumno'), h('th', null, 'Tutor'), h('th', { class: 'right' }, 'Saldo'), h('th', null, '')),
        cards.map((k) => h('tr', null, h('td', null, h('code', null, k.uid)), h('td', null, badge(k.status), k.blocked_by && k.status === 'bloqueada' ? h('div', { class: 'small muted' }, 'por ' + k.blocked_by) : null),
          h('td', null, k.child ? k.child.full_name : '—'), h('td', null, k.child ? k.child.tutor_name : '—'), h('td', { class: 'right' }, money(k.balance_cents)),
          h('td', { class: 'right' },
            k.status !== 'perdida' ? h('button', { class: 'btn sm', onclick: () => assign(k) }, 'Asignar') : null, ' ',
            k.status === 'activa' ? h('button', { class: 'btn sm', onclick: async () => { await safe(() => call('setCardStatus', { card_id: k.id, status: 'bloqueada' })); render(); } }, 'Bloquear') : null,
            k.status === 'bloqueada' ? h('button', { class: 'btn sm', onclick: async () => { await safe(() => call('setCardStatus', { card_id: k.id, status: 'activa' })); render(); } }, 'Activar') : null, ' ',
            k.status !== 'perdida' ? h('button', { class: 'btn sm', onclick: () => adjust(k) }, 'Ajuste') : null, ' ',
            k.status !== 'perdida' ? h('button', { class: 'btn sm danger', onclick: () => lost(k) }, 'Perdida') : null))))));
  };

  // ----- Tutores y alumnos (admin) -----
  VIEWS.alumnos = async (main) => {
    const [tutors, children] = await Promise.all([call('listUsers', { role: 'tutor' }), call('listChildren')]);
    const editTutor = (t) => userModal(t, 'tutor');
    const editChild = (c) => {
      const name = h('input', { value: c ? c.full_name : '' }); const grade = h('input', { value: c ? c.grade || '' : '', placeholder: 'p. ej. 3° A' });
      const tutor = h('select', null, h('option', { value: '' }, '— Sin tutor (se vinculará con código de invitación) —'), tutors.map((t) => h('option', { value: t.id, selected: c && c.tutor_id === t.id }, t.full_name)));
      const active = h('input', { type: 'checkbox', checked: c ? c.active : true });
      let photo = c ? c.photo : null; const prev = h('div'); const setPrev = () => { prev.innerHTML = ''; prev.appendChild(avatar(photo)); };
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: async () => { if (file.files[0]) { photo = await resizeImage(file.files[0]); setPrev(); } } });
      setPrev();
      modal(c ? 'Editar alumno' : 'Nuevo alumno', h('div', { class: 'form' }, field('Nombre completo', name), field('Grado y grupo', grade), field('Tutor', tutor),
        h('div', { class: 'row' }, prev, field('Foto (opcional)', file), h('button', { class: 'btn sm', onclick: () => { photo = null; setPrev(); } }, 'Quitar foto')),
        c ? h('label', { class: 'check' }, active, 'Alumno activo') : null),
      [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
        try {
          const data = { full_name: name.value, grade: grade.value, tutor_id: tutor.value ? Number(tutor.value) : null, photo };
          if (c) await call('updateChild', { id: c.id, ...data, active: active.checked }); else await call('createChild', data);
          toast('Alumno guardado', 'ok'); render();
        } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    put(main, h('h1', null, 'Tutores y alumnos'),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Tutores'), h('button', { class: 'btn primary sm', onclick: () => (WEB ? tutorTempModal() : editTutor(null)) }, '+ Tutor')),
          h('table', null, h('tr', null, h('th', null, 'Nombre'), h('th', null, 'Usuario'), h('th', null, 'Hijos'), h('th', null, '')),
            tutors.map((t) => h('tr', null, h('td', null, t.full_name, h('div', { class: 'small muted' }, [t.phone, t.email].filter(Boolean).join(' · '))), h('td', null, t.username, t.active ? '' : ' (inactivo)'),
              h('td', null, (t.children || []).map((c) => c.full_name).join(', ') || '—'), h('td', null, h('button', { class: 'btn sm', onclick: () => editTutor(t) }, 'Editar')))))),
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Alumnos'), h('button', { class: 'btn primary sm', onclick: () => editChild(null) }, '+ Alumno')),
          h('table', null, h('tr', null, h('th', null, 'Alumno'), h('th', null, 'Tarjeta'), h('th', { class: 'right' }, 'Saldo'), h('th', null, '')),
            children.map((c) => h('tr', null, h('td', null, h('div', { class: 'row' }, avatar(c.photo, 34), h('div', null, c.full_name, c.active ? '' : ' (inactivo)', h('div', { class: 'small muted' }, `${c.grade || ''} · ${c.tutor ? c.tutor.full_name : ''}`)))),
              h('td', null, c.card ? [h('code', null, c.card.uid), ' ', badge(c.card.status)] : h('span', { class: 'muted' }, 'sin tarjeta')),
              h('td', { class: 'right' }, money(c.balance_cents)),
              h('td', { class: 'right' }, h('button', { class: 'btn sm', onclick: () => editChild(c) }, 'Editar'), ' ', h('button', { class: 'btn sm primary', onclick: () => go('hijo', { id: c.id }) }, 'Límites'),
                WEB ? [' ', h('button', { class: 'btn sm', onclick: () => invite(c) }, 'Invitación')] : null)))))));
  };
  // Código de invitación para que el padre cree su cuenta y quede vinculado (solo servidor)
  async function invite(c) {
    const r = await window.coop.auth.createInvitation(c.id);
    if (!r.ok) return toast(r.error, 'err');
    modal('Código de invitación', h('div', { class: 'form' },
      h('p', null, `Entregue este código al padre/tutor de ${c.full_name}. Con él crea su cuenta en la app web y queda vinculado al alumno.`),
      h('div', { style: { fontSize: '1.8rem', fontWeight: 700, textAlign: 'center', letterSpacing: '.08em' } }, r.data.code),
      h('p', { class: 'small muted' }, `Vence: ${fmtDate(r.data.expires_at)}. Generar uno nuevo invalida el anterior. Dirección: ${location.origin}`)));
  }
  // Alta de tutor con contraseña temporal generada por el servidor (se envía por correo/SMS)
  function tutorTempModal() {
    const name = h('input'); const email = h('input', { type: 'email' }); const phone = h('input', { type: 'tel', placeholder: '10 dígitos' });
    modal('Nueva cuenta de tutor', h('div', { class: 'form' }, h('p', { class: 'small muted' }, 'Se genera una contraseña temporal; el tutor deberá cambiarla al entrar. Puede iniciar sesión con su correo o teléfono.'),
      field('Nombre completo', name), h('div', { class: 'grid g2' }, field('Correo', email), field('Teléfono', phone))),
    [{ label: 'Cancelar' }, { label: 'Crear cuenta', class: 'primary', onClick: async () => {
      const r = await window.coop.auth.createTutor({ full_name: name.value, email: email.value || null, phone: phone.value || null });
      if (!r.ok) { toast(r.error, 'err'); return false; }
      modal('Cuenta creada', h('div', { class: 'form' }, h('p', null, `Usuario: ${r.data.user.username}`), h('p', null, 'Contraseña temporal:'),
        h('div', { style: { fontSize: '1.6rem', fontWeight: 700, textAlign: 'center' } }, r.data.temporary_password),
        h('p', { class: 'small muted' }, 'Se mostró solo esta vez. También se envió al tutor (en desarrollo aparece en la consola del servidor).')), [{ label: 'Listo', onClick: () => render() }]);
    } }]);
  }

  function userModal(u, fixedRole) {
    const role = h('select', { disabled: !!u || !!fixedRole }, ['admin', 'cajero', 'tutor'].map((r) => h('option', { value: r, selected: (u ? u.role : fixedRole || 'cajero') === r }, ROLE_LABEL[r])));
    const username = h('input', { value: u ? u.username : '', disabled: !!u });
    const name = h('input', { value: u ? u.full_name : '' }); const phone = h('input', { value: u ? u.phone || '' : '' }); const email = h('input', { value: u ? u.email || '' : '' });
    const pass = h('input', { type: 'password', placeholder: u ? 'Dejar vacío para no cambiar' : 'Mínimo 6 caracteres' });
    const active = h('input', { type: 'checkbox', checked: u ? u.active : true });
    const mustChange = h('input', { type: 'checkbox', checked: true });
    modal(u ? 'Editar usuario' : 'Nuevo usuario', h('div', { class: 'form' }, field('Rol', role), field('Usuario (para iniciar sesión)', username), field('Nombre completo', name),
      h('div', { class: 'grid g2' }, field('Teléfono', phone), field('Correo', email)), field('Contraseña', pass), h('label', { class: 'check' }, mustChange, u ? 'Si asigno contraseña, pedir cambio al primer inicio' : 'Pedir cambio de contraseña al primer inicio'), u ? h('label', { class: 'check' }, active, 'Usuario activo') : null),
    [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
      try {
        if (u) await call('updateUser', { id: u.id, full_name: name.value, phone: phone.value, email: email.value, active: active.checked, password: pass.value || undefined, must_change_password: mustChange.checked });
        else await call('createUser', { role: role.value, username: username.value, full_name: name.value, phone: phone.value, email: email.value, password: pass.value, must_change_password: mustChange.checked });
        toast('Usuario guardado', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); return false; }
    } }]);
  }

  VIEWS.usuarios = async (main) => {
    const users = await call('listUsers');
    put(main, h('div', { class: 'row', style: { marginBottom: '14px' } }, h('h1', { style: { margin: 0 } }, 'Usuarios'), h('div', { class: 'grow' }), h('button', { class: 'btn primary', onclick: () => userModal(null) }, '+ Usuario')),
      h('div', { class: 'card' }, h('table', null, h('tr', null, h('th', null, 'Nombre'), h('th', null, 'Usuario'), h('th', null, 'Rol'), h('th', null, 'Estado'), h('th', null, '')),
        users.map((u) => h('tr', null, h('td', null, u.full_name), h('td', null, u.username), h('td', null, ROLE_LABEL[u.role]), h('td', null, u.active ? badge('activo', 'ok') : badge('inactivo', '')),
          h('td', { class: 'right' }, h('button', { class: 'btn sm', onclick: () => userModal(u) }, 'Editar')))))));
  };

  // ----- Movimientos -----
  VIEWS.movimientos = async (main) => {
    const children = await call('listChildren');
    const from = h('input', { type: 'date' }); const to = h('input', { type: 'date' });
    const type = h('select', null, h('option', { value: '' }, 'Todos los tipos'), ['compra', 'recarga', 'ajuste'].map((t) => h('option', { value: t }, t)));
    const status = h('select', null, h('option', { value: '' }, 'Todos los estados'), h('option', { value: 'aprobado' }, 'aprobado'), h('option', { value: 'rechazado' }, 'rechazado'));
    const child = h('select', null, h('option', { value: '' }, 'Todos los alumnos'), children.map((c) => h('option', { value: c.id }, c.full_name)));
    const uid = state.user.role !== 'tutor' ? h('input', { placeholder: 'UID tarjeta' }) : null;
    const box = h('div', { class: 'card' }); let rows = [];
    const isTutor = state.user.role === 'tutor';
    async function load() {
      const f = { from: from.value || undefined, to: to.value || undefined, type: type.value || undefined, status: status.value || undefined, child_id: child.value ? Number(child.value) : undefined, uid: uid && uid.value ? uid.value : undefined, limit: 1000 };
      const r = await safe(() => call('listMovements', f)); if (!r) return; rows = r;
      box.innerHTML = '';
      box.appendChild(movTable(rows, { showUser: !isTutor }));
    }
    function exportCsv() {
      const esc = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
      const lines = [['Fecha', 'Tipo', 'Estado', 'Alumno', 'UID', 'Monto MXN', 'Saldo después', 'Detalle', 'Motivo rechazo', 'Atendió'].map(esc).join(',')];
      for (const m of rows) lines.push([m.created_at, m.type, m.status, m.child_name, m.card_uid, (m.amount_cents / 100).toFixed(2), m.balance_after_cents === null ? '' : (m.balance_after_cents / 100).toFixed(2), m.items.map((i) => `${i.qty}x ${i.product_name}`).join('; ') || m.note || '', m.reason || '', m.user_name || ''].map(esc).join(','));
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `movimientos-${new Date().toISOString().slice(0, 10)}.csv` }); document.body.appendChild(a); a.click(); a.remove();
    }
    put(main, h('h1', null, isTutor ? 'Historial de movimientos' : 'Movimientos'),
      h('div', { class: 'card row', style: { marginBottom: '14px' } }, field('Desde', from), field('Hasta', to), field('Tipo', type), field('Estado', status), field('Alumno', child), uid ? field('Tarjeta', uid) : null,
        h('button', { class: 'btn primary', onclick: load, style: { alignSelf: 'flex-end' } }, 'Filtrar'), h('button', { class: 'btn', onclick: exportCsv, style: { alignSelf: 'flex-end' } }, 'Exportar CSV')),
      box);
    load();
  };
  function movTable(rows, { showUser = true, showChild = true } = {}) {
    if (!rows.length) return h('div', { class: 'empty' }, 'Sin movimientos');
    return h('table', null, h('tr', null, h('th', null, 'Fecha'), showChild ? h('th', null, 'Alumno') : null, h('th', null, 'Tipo'), h('th', null, 'Detalle'), h('th', null, 'Estado'), h('th', { class: 'right' }, 'Monto'), h('th', { class: 'right' }, 'Saldo'), showUser ? h('th', null, 'Atendió') : null),
      rows.map((m) => h('tr', null, h('td', null, fmtDate(m.created_at)), showChild ? h('td', null, m.child_name || '—') : null, h('td', null, badge(m.type, m.type === 'recarga' ? 'recarga' : '')),
        h('td', null, m.items.length ? h('div', { class: 'items-list' }, m.items.map((i) => `${i.qty}× ${i.product_name}`).join(', ')) : h('span', { class: 'items-list' }, m.note || ''),
          m.reason ? h('div', { class: 'small', style: { color: 'var(--err)' } }, m.reason) : null),
        h('td', null, badge(m.status)),
        h('td', { class: 'right', style: { color: m.status === 'rechazado' ? 'var(--muted)' : (m.type === 'compra' || m.amount_cents < 0 ? 'var(--err)' : 'var(--ok)'), textDecoration: m.status === 'rechazado' ? 'line-through' : '' } },
          (m.type === 'compra' ? '−' : (m.amount_cents < 0 ? '' : '+')) + money(Math.abs(m.amount_cents)).replace('-', '−')),
        h('td', { class: 'right' }, m.balance_after_cents === null ? '' : money(m.balance_after_cents)),
        showUser ? h('td', { class: 'small' }, m.user_name || '') : null)));
  }

  // ----- Tutor: mis hijos -----
  VIEWS.hijos = async (main) => {
    const kids = await call('listChildren');
    main.appendChild(h('div', { class: 'row', style: { marginBottom: '14px' } }, h('h1', { style: { margin: 0 } }, 'Mis hijos'), h('div', { class: 'grow' }),
      WEB ? h('button', { class: 'btn primary', onclick: () => {
        const code = h('input', { placeholder: 'COOP-XXXX-XXXX' });
        modal('Vincular otro hijo', h('div', { class: 'form' }, h('p', { class: 'small muted' }, 'Escriba el código de invitación que le dio la cooperativa.'), field('Código', code)),
          [{ label: 'Cancelar' }, { label: 'Vincular', class: 'primary', onClick: async () => { const r = await window.coop.auth.redeem(code.value); if (!r.ok) { toast(r.error, 'err'); return false; } toast(`${r.data.child.full_name} vinculado`, 'ok'); render(); } }]);
      } }, '+ Vincular hijo con código') : null));
    if (!kids.length) { main.appendChild(h('div', { class: 'card empty' }, 'Aún no hay alumnos registrados a su nombre. Acuda a la cooperativa para registrar la tarjeta.')); return; }
    const sums = await Promise.all(kids.map((k) => call('childSummary', { child_id: k.id })));
    main.appendChild(h('div', { class: 'grid g2' }, sums.map((s) => {
      const c = s.child;
      return h('div', { class: 'card kid', onclick: () => go('hijo', { id: c.id }) }, avatar(c.photo, 72),
        h('div', { class: 'grow' }, h('h2', { style: { margin: 0 } }, c.full_name), h('div', { class: 'small muted' }, [c.school_name ? '🏫 ' + c.school_name : null, c.grade].filter(Boolean).join(' · ')),
          h('div', { style: { marginTop: '6px' } }, c.card ? badge(c.card.status) : badge('sin tarjeta', 'warn')),
          h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Gastado hoy: ', h('b', null, money(s.spent_today_cents)), ' · Límites: ', limitsText(s.limits))),
        h('div', { class: 'right' }, h('div', { class: 'small muted' }, 'Saldo'), h('div', { class: 'bal' }, money(c.balance_cents))));
    })));
  };

  // ----- Detalle de un alumno (tutor y admin) -----
  VIEWS.hijo = async (main, params) => {
    const [s, products, categories] = await Promise.all([call('childSummary', { child_id: params.id }), call('listProducts', { child_id: params.id }), call('listCategories', { child_id: params.id })]);
    const c = s.child; const tab = params.tab || 'historial';
    const back = state.user.role === 'tutor' ? 'hijos' : 'alumnos';
    const header = h('div', { class: 'card row', style: { marginBottom: '16px' } }, avatar(c.photo, 80),
      h('div', { class: 'grow' }, h('h1', { style: { margin: 0 } }, c.full_name), h('div', { class: 'muted' }, state.user.role === 'tutor' && c.school_name ? `🏫 ${c.school_name} · ` : '', c.grade || '', ' · Tutor: ', c.tutor ? c.tutor.full_name : ''),
        h('div', { style: { marginTop: '6px' } }, c.card ? [badge(c.card.status), ' ', h('span', { class: 'small muted' }, 'Tarjeta ' + c.card.uid)] : badge('sin tarjeta', 'warn'),
          s.pending_transfer_cents ? h('span', { class: 'small', style: { color: 'var(--warn)' } }, ` · Saldo pendiente por transferir: ${money(s.pending_transfer_cents)}`) : null)),
      h('div', { class: 'grid g4', style: { minWidth: '520px' } },
        h('div', null, h('div', { class: 'small muted' }, 'Saldo'), h('div', { class: 'bal' }, money(c.balance_cents))),
        h('div', null, h('div', { class: 'small muted' }, 'Hoy'), h('div', { style: { fontSize: '1.3rem', fontWeight: 700 } }, money(s.spent_today_cents))),
        h('div', null, h('div', { class: 'small muted' }, 'Esta semana'), h('div', { style: { fontSize: '1.3rem', fontWeight: 700 } }, money(s.spent_week_cents))),
        h('div', null, h('div', { class: 'small muted' }, 'Este mes'), h('div', { style: { fontSize: '1.3rem', fontWeight: 700 } }, money(s.spent_month_cents)))));
    const tabs = h('div', { class: 'tabs' }, h('button', { class: 'btn', onclick: () => go(back) }, '← Volver'),
      [['historial', 'Historial'], ['limites', 'Límites de gasto'], ['prohibidos', 'Productos prohibidos'], ['tarjeta', 'Tarjeta y perfil']].map(([k, l]) => h('button', { class: 'btn' + (k === tab ? ' active' : ''), onclick: () => go('hijo', { id: c.id, tab: k }) }, l)));
    const body = h('div', { class: 'card' });
    put(main, header, tabs, body);

    if (tab === 'historial') {
      put(body, h('h2', null, 'Últimos movimientos'), h('p', { class: 'small muted' }, 'Incluye intentos de compra rechazados (por saldo, límites o productos prohibidos).'), movTable(s.movements, { showUser: false, showChild: false }));
    } else if (tab === 'limites') {
      const l = s.limits;
      const pt = h('input', { value: centsToInput(l.per_transaction_cents), placeholder: 'Sin límite' });
      const pd = h('input', { value: centsToInput(l.per_day_cents), placeholder: 'Sin límite' });
      const ptype = h('select', null, h('option', { value: '' }, 'Sin límite semanal/mensual'), h('option', { value: 'semana', selected: l.period_type === 'semana' }, 'Por semana (lunes a domingo)'), h('option', { value: 'mes', selected: l.period_type === 'mes' }, 'Por mes calendario'));
      const pp = h('input', { value: centsToInput(l.per_period_cents), placeholder: 'Monto' });
      const save = async () => {
        try {
          const r = await call('setLimits', { child_id: c.id, per_transaction_cents: parseMoney(pt.value, { optional: true }), per_day_cents: parseMoney(pd.value, { optional: true }), period_type: ptype.value || null, per_period_cents: ptype.value ? parseMoney(pp.value) : null });
          toast('Límites guardados: ' + limitsText(r), 'ok');
        } catch (e) { toast(e.message, 'err'); }
      };
      put(body, h('h2', null, 'Límites de gasto'), h('p', { class: 'small muted' }, 'Deje vacío un campo para no aplicar ese límite. Montos en pesos (MXN).'),
        h('div', { class: 'form', style: { maxWidth: '520px' } }, field('Máximo por compra', pt), field('Máximo por día', pd), h('div', { class: 'grid g2' }, field('Límite por periodo', ptype), field('Monto del periodo', pp)),
          h('div', null, h('button', { class: 'btn primary', onclick: save }, 'Guardar límites'))));
    } else if (tab === 'prohibidos') {
      const pset = new Set(s.prohibitions.products.map((p) => p.id)); const cset = new Set(s.prohibitions.categories.map((k) => k.id));
      const cchecks = categories.map((k) => ({ id: k.id, el: h('input', { type: 'checkbox', checked: cset.has(k.id) }), name: k.name }));
      const pchecks = products.map((p) => ({ id: p.id, el: h('input', { type: 'checkbox', checked: pset.has(p.id) }), name: `${p.name} (${p.category_name}) ${money(p.price_cents)}` }));
      const save = async () => {
        const r = await safe(() => call('setProhibitions', { child_id: c.id, product_ids: pchecks.filter((x) => x.el.checked).map((x) => x.id), category_ids: cchecks.filter((x) => x.el.checked).map((x) => x.id) }));
        if (r) toast(`Guardado: ${r.products.length} productos y ${r.categories.length} categorías prohibidas`, 'ok');
      };
      put(body, h('h2', null, 'Categorías prohibidas'), h('p', { class: 'small muted' }, 'Ningún producto de estas categorías podrá comprarse con la tarjeta.'),
        h('div', { class: 'checks' }, cchecks.map((x) => h('label', { class: 'check' }, x.el, x.name))),
        h('h2', { style: { marginTop: '18px' } }, 'Productos prohibidos'),
        h('div', { class: 'checks' }, pchecks.map((x) => h('label', { class: 'check' }, x.el, x.name))),
        h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn primary', onclick: save }, 'Guardar prohibiciones')));
    } else if (tab === 'tarjeta') {
      const k = c.card;
      const name = h('input', { value: c.full_name }); const grade = h('input', { value: c.grade || '' });
      let photo = c.photo; const prev = h('div'); const setPrev = () => { prev.innerHTML = ''; prev.appendChild(avatar(photo, 80)); }; setPrev();
      const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', onchange: async () => { if (file.files[0]) { photo = await resizeImage(file.files[0]); setPrev(); } } });
      put(body, h('div', { class: 'grid g2' },
        h('div', null, h('h2', null, 'Tarjeta'),
          k ? h('div', { class: 'form' }, h('div', null, 'UID: ', h('code', null, k.uid), ' ', badge(k.status)),
            k.status === 'activa' ? h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('Bloquear tarjeta', 'Mientras esté bloqueada no se podrá comprar con ella. Puede desbloquearla cuando quiera.')) { await safe(() => call('setCardStatus', { card_id: k.id, status: 'bloqueada' })); go('hijo', { id: c.id, tab: 'tarjeta' }); } } }, 'Bloquear temporalmente')
              : h('button', { class: 'btn ok', onclick: async () => { await safe(() => call('setCardStatus', { card_id: k.id, status: 'activa' })); go('hijo', { id: c.id, tab: 'tarjeta' }); } }, 'Desbloquear tarjeta'),
            h('p', { class: 'small muted' }, 'Si la tarjeta se perdió, bloquéela aquí y avise a la cooperativa para transferir el saldo a una tarjeta nueva.'))
            : h('p', { class: 'muted' }, 'Este alumno no tiene tarjeta vigente. Acuda a la cooperativa.')),
        h('div', null, h('h2', null, 'Personalizar'), h('div', { class: 'form' }, field('Nombre del alumno', name), field('Grado y grupo', grade),
          h('div', { class: 'row' }, prev, field('Foto (opcional)', file), h('button', { class: 'btn sm', onclick: () => { photo = null; setPrev(); } }, 'Quitar')),
          h('div', null, h('button', { class: 'btn primary', onclick: async () => { const r = await safe(() => call('updateChild', { id: c.id, full_name: name.value, grade: grade.value, photo })); if (r) { toast('Perfil actualizado', 'ok'); go('hijo', { id: c.id, tab: 'tarjeta' }); } } }, 'Guardar'))))));
    }
  };

  // ======================================================================
  // ----- Superadministrador (Zuki Company): instituciones -----
  // ======================================================================
  const SCHOOL_STATUS = { activa: 'Activa', prueba: 'En prueba', suspendida: 'Suspendida' };
  const schoolBadge = (s) => h('span', { class: 'badge ' + s }, SCHOOL_STATUS[s] || s);
  async function superCall(method, args) {
    const r = await window.coop.superCall(method, args || {});
    if (!r.ok) { if (r.code === 'NO_AUTENTICADO') { state.user = null; render(); } throw new Error(r.error); }
    return r.data;
  }
  const since = (s) => {
    if (!s) return 'nunca';
    const d = new Date(s.replace(' ', 'T')); const min = Math.round((Date.now() - d.getTime()) / 60000);
    if (min < 2) return 'hace un momento'; if (min < 60) return `hace ${min} min`; if (min < 1440) return `hace ${Math.round(min / 60)} h`;
    return fmtDate(s);
  };
  // Tabla que en celular se muestra como tarjetas (cada celda con su etiqueta)
  function respTable(headers, rows) {
    return h('table', { class: 'resp' }, h('tr', { class: 'head' }, headers.map((x) => h('th', { class: x.right ? 'right' : '' }, x.label))),
      rows.map((cells) => h('tr', null, cells.map((c, i) => h('td', { 'data-label': headers[i].label, class: headers[i].right ? 'right' : '' }, c)))));
  }
  function tempPassModal(title, user, pass) {
    modal(title, h('div', { class: 'form' }, h('p', null, 'Usuario: ', h('b', null, user.username)), h('p', null, 'Contraseña temporal (se pedirá cambiarla al entrar):'),
      h('div', { class: 'bigcode' }, pass),
      h('p', { class: 'small muted' }, 'Se muestra solo esta vez. Anótela o envíela al responsable de la escuela por un medio seguro.')), [{ label: 'Listo', class: 'primary', onClick: () => render() }]);
  }
  function schoolForm(s) {
    const name = h('input', { value: s ? s.name : '', placeholder: 'p. ej. Colegio Juárez Morelia' });
    const status = h('select', null, Object.entries(SCHOOL_STATUS).map(([k, l]) => h('option', { value: k, selected: (s ? s.status : 'prueba') === k }, l)));
    const plan = h('textarea', { rows: 2, placeholder: 'p. ej. Plan anual $1,500 MXN/mes, pago el día 5' }); plan.value = s && s.plan_note ? s.plan_note : '';
    const cname = h('input', { value: s ? s.contact_name || '' : '' }); const cphone = h('input', { value: s ? s.contact_phone || '' : '', type: 'tel', placeholder: '10 dígitos' });
    const cemail = h('input', { value: s ? s.contact_email || '' : '', type: 'email' });
    const fields = { name, status, plan, cname, cphone, cemail };
    const el = h('div', { class: 'form' }, field('Nombre de la escuela', name), h('div', { class: 'grid g2' }, field('Estado', status), field('Contacto (director/a)', cname)),
      h('div', { class: 'grid g2' }, field('Teléfono de contacto', cphone), field('Correo de contacto', cemail)), field('Plan / cuota (nota interna)', plan));
    const data = () => ({ name: name.value, status: status.value, plan_note: plan.value, contact_name: cname.value, contact_phone: cphone.value, contact_email: cemail.value });
    return { el, data, fields };
  }
  function newSchoolModal() {
    const f = schoolForm(null);
    const au = h('input', { placeholder: 'p. ej. admin.juarez', autocomplete: 'off' }); const an = h('input', { placeholder: 'Nombre del administrador' });
    const ae = h('input', { type: 'email', placeholder: 'Opcional' });
    modal('Nueva escuela', h('div', { class: 'form' }, f.el, h('h3', { style: { marginTop: '8px' } }, 'Administrador de la escuela'),
      h('div', { class: 'grid g2' }, field('Usuario para entrar', au), field('Nombre completo', an)), field('Correo', ae),
      h('p', { class: 'small muted' }, 'Se crea con una contraseña temporal y las categorías básicas (Dulces, Refrescos, Frituras, Saludable, Comida).')),
    [{ label: 'Cancelar' }, { label: 'Crear escuela', class: 'primary', onClick: async () => {
      try {
        const r = await superCall('createSchool', { ...f.data(), admin_username: au.value, admin_full_name: an.value || undefined, admin_email: ae.value || undefined });
        tempPassModal(`Escuela "${r.school.name}" creada`, r.admin.user, r.admin.temporary_password);
      } catch (e) { toast(e.message, 'err'); return false; }
    } }]);
  }

  VIEWS.instituciones = async (main) => {
    const o = await superCall('overview');
    const t = o.totals;
    const stat = (l, v, sub) => h('div', { class: 'card stat' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), sub ? h('div', { class: 'small muted' }, sub) : null);
    const q = h('input', { placeholder: 'Buscar escuela…', class: 'grow' });
    const fs = h('select', null, h('option', { value: '' }, 'Todos los estados'), Object.entries(SCHOOL_STATUS).map(([k, l]) => h('option', { value: k }, l)));
    const box = h('div');
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const list = o.schools.filter((s) => (!fs.value || s.status === fs.value) && (!term || s.name.toLowerCase().includes(term)));
      box.innerHTML = '';
      if (!list.length) { box.appendChild(h('div', { class: 'empty' }, 'Sin escuelas con ese filtro')); return; }
      box.appendChild(respTable([{ label: 'Escuela' }, { label: 'Estado' }, { label: 'Alumnos', right: true }, { label: 'Tarjetas activas', right: true }, { label: 'Ventas del mes', right: true }, { label: 'Recargas del mes', right: true }, { label: 'Última sincronización' }, { label: '' }],
        list.map((s) => [
          h('div', null, h('b', null, s.name), s.plan_note ? h('div', { class: 'small muted' }, s.plan_note) : null),
          schoolBadge(s.status), String(s.stats.students), String(s.stats.active_cards), money(s.stats.sales_month_cents), money(s.stats.recharges_month_cents),
          h('span', { class: s.stats.last_sync_at ? '' : 'muted' }, since(s.stats.last_sync_at), s.stats.devices ? h('span', { class: 'small muted' }, ` · ${s.stats.devices} caja(s)`) : null),
          h('button', { class: 'btn sm primary', onclick: () => go('institucion', { id: s.id }) }, 'Administrar'),
        ])));
    };
    q.addEventListener('input', draw); fs.addEventListener('change', draw);
    put(main, h('div', { class: 'row pagehead' }, h('h1', { style: { margin: 0 } }, 'Instituciones'), h('div', { class: 'grow' }), h('button', { class: 'btn primary', onclick: newSchoolModal }, '+ Nueva escuela')),
      h('div', { class: 'grid g4 stats' },
        stat('Escuelas', String(t.schools), `${t.schools_activa} activas · ${t.schools_prueba} en prueba · ${t.schools_suspendida} suspendidas`),
        stat('Alumnos', String(t.students), `${t.tutors_linked} padres vinculados`),
        stat('Tarjetas activas', String(t.active_cards), `de ${t.total_cards} registradas`),
        stat('Cajas vinculadas', String(t.devices)),
        stat('Ventas de hoy', money(t.sales_day_cents)),
        stat('Ventas del mes', money(t.sales_month_cents), 'Total histórico ' + money(t.sales_total_cents)),
        stat('Recargas del mes', money(t.recharges_month_cents), 'Total histórico ' + money(t.recharges_total_cents)),
        stat('Saldo en tarjetas', money(t.balance_cents), 'Dinero de alumnos (todas las escuelas)')),
      h('div', { class: 'card', style: { marginTop: '16px' } }, h('div', { class: 'row', style: { marginBottom: '10px' } }, q, fs), box));
    draw();
  };

  VIEWS.institucion = async (main, params) => {
    const d = await superCall('schoolDetail', { id: params.id });
    const s = d.school; const st = s.stats;
    const stat = (l, v, sub) => h('div', { class: 'card stat' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), sub ? h('div', { class: 'small muted' }, sub) : null);
    const edit = () => {
      const f = schoolForm(s);
      modal('Editar escuela', f.el, [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
        try { await superCall('updateSchool', { id: s.id, ...f.data() }); toast('Escuela actualizada', 'ok'); render(); } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const setStatus = async (status) => {
      const txt = status === 'suspendida' ? 'El personal de la escuela no podrá entrar y su caja dejará de sincronizar. Los padres seguirán viendo saldos e historial. ¿Suspender?' : `¿Cambiar el estado a "${SCHOOL_STATUS[status]}"?`;
      if (!(await confirmBox(status === 'suspendida' ? 'Suspender escuela' : 'Cambiar estado', txt))) return;
      if (await safe(() => superCall('updateSchool', { id: s.id, status }))) { toast('Estado actualizado', 'ok'); render(); }
    };
    const newStaff = () => {
      const role = h('select', null, h('option', { value: 'admin' }, 'Administrador'), h('option', { value: 'cajero' }, 'Cajero'));
      const u = h('input', { autocomplete: 'off' }); const n = h('input'); const e = h('input', { type: 'email', placeholder: 'Opcional' });
      modal('Nuevo usuario de la escuela', h('div', { class: 'form' }, field('Rol', role), field('Usuario para entrar', u), field('Nombre completo', n), field('Correo', e)),
        [{ label: 'Cancelar' }, { label: 'Crear', class: 'primary', onClick: async () => {
          try { const r = await superCall('createStaff', { school_id: s.id, role: role.value, username: u.value, full_name: n.value, email: e.value || undefined }); tempPassModal('Usuario creado', r.user, r.temporary_password); } catch (er) { toast(er.message, 'err'); return false; }
        } }]);
    };
    const resetPass = async (u) => {
      if (!(await confirmBox('Restablecer contraseña', `Se generará una contraseña temporal para ${u.full_name} y se cerrarán sus sesiones. ¿Continuar?`))) return;
      const r = await safe(() => superCall('resetStaffPassword', { user_id: u.id })); if (r) tempPassModal('Contraseña restablecida', r.user, r.temporary_password);
    };
    const genCodes = async () => {
      const kids = await superCall('listChildren', { school_id: s.id });
      const pending = kids.filter((k) => !k.tutor_id && k.active);
      if (!pending.length) return toast('Todos los alumnos activos ya tienen padre/tutor vinculado', 'ok');
      const codes = await superCall('generateInvitations', { school_id: s.id });
      const byId = new Map(kids.map((k) => [k.id, k]));
      const rows = codes.map((c) => ({ child_name: c.child_name, grade: (byId.get(c.child_id) || {}).grade, card_uid: (byId.get(c.child_id) || {}).card_uid, code: c.code, expires_at: c.expires_at }));
      showCodesSheet(rows, { school: s.name, url: location.origin });
    };
    const staffRows = d.staff.map((u) => [h('div', null, h('b', null, u.full_name), h('div', { class: 'small muted' }, u.email || '')), u.username, ROLE_LABEL[u.role],
      u.active ? (u.must_change_password ? badge('contraseña temporal', 'warn') : badge('activo', 'ok')) : badge('inactivo', ''),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px' } }, h('button', { class: 'btn sm', onclick: () => resetPass(u) }, 'Restablecer contraseña'),
        h('button', { class: 'btn sm', onclick: async () => { if (await safe(() => superCall('setStaffActive', { user_id: u.id, active: !u.active }))) render(); } }, u.active ? 'Desactivar' : 'Activar'))]);
    const devRows = d.devices.map((x) => [h('div', null, h('b', null, x.name), x.primary ? [' ', badge('principal', 'ok')] : null, h('div', { class: 'small muted' }, h('code', null, x.id.slice(0, 8) + '…'))),
      x.revoked ? badge('revocado', 'err') : badge('autorizado', 'ok'), since(x.last_seen_at),
      x.revoked ? '' : h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px' } },
        x.primary ? null : h('button', { class: 'btn sm', onclick: async () => { if (await safe(() => superCall('setPrimaryDevice', { school_id: s.id, device_id: x.id }))) { toast('Equipo principal actualizado', 'ok'); render(); } } }, 'Hacer principal'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (!(await confirmBox('Revocar equipo', `"${x.name}" dejará de sincronizar hasta que se vuelva a vincular. ¿Revocar?`))) return; if (await safe(() => superCall('revokeDevice', { school_id: s.id, device_id: x.id }))) { toast('Equipo revocado', 'ok'); render(); } } }, 'Revocar'))]);
    const invRows = d.invitations.slice(0, 30).map((i) => [i.child_name, h('code', null, i.code), badge(i.status, i.status === 'usado' ? 'ok' : (i.status === 'vencido' ? 'err' : 'warn')), i.used_by_name || '—', fmtDate(i.expires_at)]);
    put(main,
      h('div', { class: 'row pagehead' }, h('button', { class: 'btn', onclick: () => go('instituciones') }, '← Instituciones'), h('h1', { style: { margin: 0 }, class: 'grow' }, s.name), schoolBadge(s.status)),
      h('div', { class: 'row', style: { marginBottom: '14px' } }, h('button', { class: 'btn', onclick: edit }, 'Editar datos y plan'),
        s.status !== 'activa' ? h('button', { class: 'btn ok', onclick: () => setStatus('activa') }, 'Activar') : null,
        s.status !== 'prueba' ? h('button', { class: 'btn', onclick: () => setStatus('prueba') }, 'Pasar a prueba') : null,
        s.status !== 'suspendida' ? h('button', { class: 'btn danger', onclick: () => setStatus('suspendida') }, 'Suspender') : null),
      h('div', { class: 'grid g4 stats' },
        stat('Alumnos', String(st.students), `${st.tutors_linked} padres vinculados`), stat('Tarjetas activas', String(st.active_cards), `de ${st.total_cards}`),
        stat('Ventas de hoy', money(st.sales_day_cents)), stat('Ventas del mes', money(st.sales_month_cents), `${st.sales_month_count} ventas · total ${money(st.sales_total_cents)}`),
        stat('Recargas del mes', money(st.recharges_month_cents), 'Total ' + money(st.recharges_total_cents)), stat('Saldo en tarjetas', money(st.balance_cents)),
        stat('Última sincronización', since(st.last_sync_at), st.devices ? `${st.devices} caja(s) autorizada(s)` : 'Sin caja vinculada'),
        stat('Plan / cuota', s.plan_note || '—', [s.contact_name, s.contact_phone, s.contact_email].filter(Boolean).join(' · ') || null)),
      h('div', { class: 'grid g2', style: { marginTop: '16px' } },
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Personal de la escuela'), h('button', { class: 'btn primary sm', onclick: newStaff }, '+ Usuario')),
          d.staff.length ? respTable([{ label: 'Nombre' }, { label: 'Usuario' }, { label: 'Rol' }, { label: 'Estado' }, { label: '', right: true }], staffRows) : h('div', { class: 'empty' }, 'Sin usuarios')),
        h('div', { class: 'card' }, h('h2', null, 'Cajas (equipos de escritorio)'),
          d.devices.length ? respTable([{ label: 'Equipo' }, { label: 'Estado' }, { label: 'Última conexión' }, { label: '', right: true }], devRows)
            : h('div', { class: 'empty' }, 'Aún no hay cajas vinculadas. El administrador de la escuela vincula la caja desde la app de escritorio (Ajustes → Servidor).'))),
      h('div', { class: 'card', style: { marginTop: '16px' } }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Códigos de invitación para padres'),
        h('button', { class: 'btn primary sm', onclick: () => safe(genCodes) }, 'Generar hoja para alumnos sin tutor')),
      h('p', { class: 'small muted' }, 'Cada código vincula a un padre/tutor con su hijo(a). Se reutiliza el código vigente si ya existe.'),
      invRows.length ? respTable([{ label: 'Alumno' }, { label: 'Código' }, { label: 'Estado' }, { label: 'Usado por' }, { label: 'Vence' }], invRows) : h('div', { class: 'empty' }, 'Sin códigos generados')));
  };

  // ----- Hoja imprimible de códigos de activación para padres -----
  const SHEET_CSS = `.codesheet{font-family:"Segoe UI",Arial,sans-serif;color:#1e2533}
.codesheet .sh-head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #2f6fec;padding-bottom:6px;margin-bottom:10px}
.codesheet .sh-head h2{margin:0;font-size:16px}.codesheet .sh-head div{font-size:11px;color:#6b7385}
.codesheet .sh-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.codesheet .sh-card{border:1.5px dashed #9aa5bd;border-radius:10px;padding:10px 12px;break-inside:avoid;page-break-inside:avoid;font-size:11.5px;line-height:1.35}
.codesheet .sh-school{font-size:10.5px;color:#6b7385;text-transform:uppercase;letter-spacing:.04em}
.codesheet .sh-name{font-size:15px;font-weight:700;margin:2px 0}.codesheet .sh-code{font-size:20px;font-weight:800;letter-spacing:.08em;margin:6px 0;color:#1f56c2;font-family:Consolas,monospace}
.codesheet .sh-nocode{font-size:12px;color:#d97706;margin:6px 0}.codesheet ol{margin:4px 0 0 16px;padding:0}.codesheet .sh-foot{font-size:10px;color:#6b7385;margin-top:4px}`;
  function codesSheet(rows, { school, url }) {
    return h('div', { class: 'codesheet' }, h('style', null, SHEET_CSS),
      h('div', { class: 'sh-head' }, h('h2', null, `Códigos de activación para padres — ${school || ''}`), h('div', null, `Generado ${new Date().toLocaleDateString('es-MX')} · ${rows.length} alumno(s)`)),
      h('div', { class: 'sh-grid' }, rows.map((r) => h('div', { class: 'sh-card' },
        h('div', { class: 'sh-school' }, school || 'Cooperativa NFC'), h('div', { class: 'sh-name' }, r.child_name), h('div', null, [r.grade, r.card_uid ? 'Tarjeta ' + r.card_uid : null].filter(Boolean).join(' · ')),
        r.code ? h('div', { class: 'sh-code' }, r.code) : h('div', { class: 'sh-nocode' }, r.linked ? 'Ya tiene padre/tutor vinculado' : 'Código pendiente (sincronice la caja con el servidor)'),
        h('ol', null, h('li', null, 'Abra en su celular: ', h('b', null, url || 'la dirección que le indique la escuela')), h('li', null, 'Toque "Tengo un código de invitación".'), h('li', null, 'Escriba el código, sus datos y una contraseña.')),
        h('div', { class: 'sh-foot' }, r.expires_at ? `Vence: ${fmtDate(r.expires_at)}. ` : '', 'Con su cuenta verá saldo e historial, y podrá poner límites o bloquear la tarjeta.')))));
  }
  function printNode(node) {
    const host = h('div', { class: 'print-host' }, node.cloneNode(true));
    document.body.appendChild(host); document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); host.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => { window.print(); setTimeout(done, 1500); }, 50);
  }
  function showCodesSheet(rows, opts) {
    const sheet = codesSheet(rows, opts);
    const acts = [{ label: 'Cerrar' }, { label: 'Imprimir', class: 'primary', onClick: () => { printNode(sheet); return false; } }];
    if (!WEB && window.coop.exportPdf) acts.splice(1, 0, { label: 'Guardar PDF…', onClick: async () => { const r = await window.coop.exportPdf({ html: sheet.outerHTML, fileName: `codigos-padres-${new Date().toISOString().slice(0, 10)}.pdf` }); if (r.ok) toast('PDF guardado en ' + r.data, 'ok'); else if (r.error !== 'Cancelado') toast(r.error, 'err'); return false; } });
    const close = modal('Hoja de códigos para padres', h('div', { class: 'sheet-preview' }, sheet), acts);
    const m = document.querySelector('.modal-bg:last-child .modal'); if (m) m.classList.add('wide');
    return close;
  }

  // ----- Programar tarjetas (escritorio): lectura en lote, asignación y hoja de códigos -----
  const prog = { session: [] }; // tarjetas leídas en esta sesión (persisten al cambiar de pestaña)
  VIEWS.programar = async (main, params) => {
    const tab = params.tab || 'leer';
    const tabs = h('div', { class: 'tabs' }, [['leer', '1. Leer tarjetas'], ['asignar', '2. Asignar a alumnos'], ['codigos', '3. Hoja de códigos para padres']]
      .map(([k, l]) => h('button', { class: 'btn' + (k === tab ? ' active' : ''), onclick: () => go('programar', { tab: k }) }, l)));
    put(main, h('h1', null, 'Programar tarjetas'), tabs);
    const body = h('div'); main.appendChild(body);
    if (tab === 'leer') {
      const cards = await call('listCards');
      const free = cards.filter((k) => k.status === 'sin_asignar').length;
      const counter = h('div', { class: 'scan-count' });
      const list = h('div', { class: 'scan-list' });
      const flash = h('div', { class: 'scan-zone' }, h('div', { class: 'scan-icon' }, '📶'), h('div', { class: 'scan-title' }, 'Acerque las tarjetas al lector, una tras otra'), h('div', { class: 'small muted' }, 'Cada tarjeta nueva se registra en inventario (sin asignar). Si una ya estaba registrada, se avisa y no se duplica.'), counter);
      const manual = h('input', { placeholder: 'o escriba un UID y presione Enter', class: 'grow' });
      const draw = () => {
        const ok = prog.session.filter((x) => x.ok).length;
        counter.textContent = `${ok} nuevas en esta sesión · ${free + ok} sin asignar en total`;
        list.innerHTML = '';
        put(list, prog.session.slice().reverse().map((x, i) => h('div', { class: 'scan-item ' + (x.ok ? 'ok' : 'err') }, h('span', null, `#${prog.session.length - i}`), h('code', null, x.uid), h('span', { class: 'grow' }, x.ok ? '✔ registrada' : '✖ ' + x.msg))));
      };
      const add = async (raw) => {
        const uid = String(raw || '').trim(); if (!uid) return;
        const r = await window.coop.call('registerCard', { uid });
        prog.session.push(r.ok ? { uid: r.data.uid, ok: true } : { uid: uid.toUpperCase(), ok: false, msg: r.error });
        flash.classList.remove('hit', 'miss'); void flash.offsetWidth; flash.classList.add(r.ok ? 'hit' : 'miss');
        draw();
      };
      manual.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(manual.value); manual.value = ''; } });
      listenCardReader(add);
      put(body, h('div', { class: 'grid g2' }, h('div', { class: 'grid' }, flash, h('div', { class: 'card row' }, manual, h('button', { class: 'btn', onclick: () => { add(manual.value); manual.value = ''; } }, 'Agregar'))),
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Leídas en esta sesión'), h('button', { class: 'btn sm', onclick: () => { prog.session = []; draw(); } }, 'Limpiar lista'),
          h('button', { class: 'btn sm primary', onclick: () => go('programar', { tab: 'asignar' }) }, 'Siguiente: asignar →')), list)));
      draw();
    } else if (tab === 'asignar') {
      const [cards, children] = await Promise.all([call('listCards'), call('listChildren')]);
      const free = cards.filter((k) => k.status === 'sin_asignar').sort((a, b) => a.id - b.id);
      const grades = [...new Set(children.map((c) => c.grade || ''))].sort();
      const gsel = h('select', null, h('option', { value: '' }, 'Todos los grados'), grades.map((g) => h('option', { value: g }, g || '(sin grado)')));
      if (params.grade !== undefined) gsel.value = params.grade;
      const pending = children.filter((c) => c.active && !c.card && (!gsel.value || (c.grade || '') === gsel.value)).sort((a, b) => (a.grade || '').localeCompare(b.grade || '') || a.full_name.localeCompare(b.full_name));
      gsel.addEventListener('change', () => go('programar', { tab: 'asignar', grade: gsel.value }));
      const sels = pending.map((c, i) => ({ c, el: h('select', null, h('option', { value: '' }, '— elegir tarjeta —'), free.map((k, j) => h('option', { value: k.id, selected: j === i }, k.uid))) }));
      const assignAll = async () => {
        const todo = sels.filter((x) => x.el.value);
        const used = todo.map((x) => x.el.value); if (new Set(used).size !== used.length) return toast('Hay una tarjeta elegida para dos alumnos', 'err');
        if (!todo.length) return toast('No hay asignaciones seleccionadas', 'err');
        if (!(await confirmBox('Asignar tarjetas', `Se asignarán ${todo.length} tarjeta(s). ¿Continuar?`))) return;
        let ok = 0; const errs = [];
        for (const x of todo) { const r = await window.coop.call('assignCard', { card_id: Number(x.el.value), child_id: x.c.id }); if (r.ok) ok++; else errs.push(`${x.c.full_name}: ${r.error}`); }
        toast(`${ok} tarjeta(s) asignada(s)` + (errs.length ? ` · ${errs.length} con error` : ''), errs.length ? 'err' : 'ok');
        if (errs.length) console.warn(errs);
        go('programar', { tab: 'asignar', grade: gsel.value });
      };
      // Asignación "leyendo": elige alumno y acerca la tarjeta (registra si es nueva)
      let target = null; const tgtInfo = h('div', { class: 'small muted' }, 'O bien: toque "Leer" junto a un alumno y acerque su tarjeta.');
      listenCardReader(async (uid) => {
        if (!target) return toast('Primero toque "Leer" junto al alumno', 'err');
        let r = await window.coop.call('registerCard', { uid, child_id: target.id });
        if (!r.ok && /ya está registrada/.test(r.error)) { const k = cards.find((x) => x.uid === String(uid).replace(/[\s:-]/g, '').toUpperCase()); if (k) r = await window.coop.call('assignCard', { card_id: k.id, child_id: target.id }); }
        if (r.ok) { toast(`Tarjeta asignada a ${target.full_name}`, 'ok'); go('programar', { tab: 'asignar', grade: gsel.value }); } else toast(r.error, 'err');
      });
      put(body, h('div', { class: 'card' }, h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h2', { class: 'grow', style: { margin: 0 } }, `Alumnos sin tarjeta (${pending.length}) · tarjetas libres: ${free.length}`), gsel,
        h('button', { class: 'btn primary', onclick: assignAll, disabled: !pending.length || !free.length }, 'Asignar seleccionadas')),
      h('p', { class: 'small muted' }, 'Las tarjetas se proponen en el orden en que se leyeron. Ordene las tarjetas físicas igual que esta lista (por grado y nombre) o cambie la tarjeta de cada alumno.'), tgtInfo,
      pending.length ? respTable([{ label: 'Alumno' }, { label: 'Grado' }, { label: 'Tutor' }, { label: 'Tarjeta' }, { label: '' }],
        sels.map((x) => [x.c.full_name, x.c.grade || '—', x.c.tutor ? x.c.tutor.full_name : h('span', { class: 'muted' }, 'sin tutor'), x.el,
          h('button', { class: 'btn sm', onclick: (e) => { target = x.c; document.querySelectorAll('.btn.reading').forEach((b) => b.classList.remove('reading')); e.target.classList.add('reading'); tgtInfo.textContent = `Acerque la tarjeta de ${x.c.full_name}…`; } }, 'Leer')]))
        : h('div', { class: 'empty' }, 'Todos los alumnos activos tienen tarjeta.'),
      h('div', { class: 'row', style: { marginTop: '12px' } }, h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: () => go('programar', { tab: 'codigos' }) }, 'Siguiente: hoja de códigos →'))));
    } else {
      const children = (await call('listChildren')).filter((c) => c.active);
      const st = await window.coop.sync.status();
      const incl = h('input', { type: 'checkbox' });
      const grades = [...new Set(children.map((c) => c.grade || ''))].sort();
      const gsel = h('select', null, h('option', { value: '' }, 'Todos los grados'), grades.map((g) => h('option', { value: g }, g || '(sin grado)')));
      const listBox = h('div', { class: 'checks', style: { maxHeight: '340px' } });
      let checks = [];
      const draw = () => {
        listBox.innerHTML = '';
        checks = children.filter((c) => (incl.checked || !c.tutor) && (!gsel.value || (c.grade || '') === gsel.value))
          .sort((a, b) => (a.grade || '').localeCompare(b.grade || '') || a.full_name.localeCompare(b.full_name))
          .map((c) => ({ c, el: h('input', { type: 'checkbox', checked: true }) }));
        put(listBox, checks.length ? checks.map((x) => h('label', { class: 'check' }, x.el, `${x.c.full_name} · ${x.c.grade || ''}${x.c.card ? '' : ' (sin tarjeta)'}`)) : h('div', { class: 'muted' }, 'No hay alumnos con este filtro.'));
      };
      incl.addEventListener('change', draw); gsel.addEventListener('change', draw);
      const make = async () => {
        const sel = checks.filter((x) => x.el.checked).map((x) => x.c);
        if (!sel.length) return toast('Seleccione al menos un alumno', 'err');
        let codes = []; let url = ''; let school = state.user.school_name || '';
        if (st.linked) {
          const r = await window.coop.codes({ child_ids: sel.map((c) => c.id), include_linked: incl.checked });
          if (!r.ok) toast('No se obtuvieron códigos: ' + r.error, 'err'); else { codes = r.data.codes; url = r.data.serverUrl; school = r.data.school_name || school; }
        }
        const byId = new Map(codes.map((c) => [c.child_id, c]));
        showCodesSheet(sel.map((c) => { const x = byId.get(c.id) || {}; return { child_name: c.full_name, grade: c.grade, card_uid: c.card ? c.card.uid : null, code: x.code, expires_at: x.expires_at, linked: x.linked }; }), { school, url });
      };
      put(body, h('div', { class: 'grid g2' },
        h('div', { class: 'card form' }, h('h2', null, 'Alumnos para la hoja'), h('div', { class: 'row' }, gsel, h('label', { class: 'check' }, incl, 'Incluir alumnos que ya tienen tutor')), listBox,
          h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => checks.forEach((x) => { x.el.checked = true; }) }, 'Todos'), h('button', { class: 'btn sm', onclick: () => checks.forEach((x) => { x.el.checked = false; }) }, 'Ninguno'),
            h('div', { class: 'grow' }), h('button', { class: 'btn primary', onclick: () => safe(make) }, 'Generar hoja (PDF / imprimir)'))),
        h('div', { class: 'card' }, h('h2', null, '¿Cómo funciona?'),
          h('ol', { class: 'small', style: { lineHeight: 1.6 } }, h('li', null, 'La caja se sincroniza y pide al servidor un código por alumno (si ya existe uno vigente, se reutiliza).'),
            h('li', null, 'Se arma una hoja con un recuadro por alumno: nombre, grado, tarjeta y su código.'), h('li', null, 'Imprima, recorte y entregue cada recuadro al padre/tutor junto con la tarjeta.'),
            h('li', null, 'El padre entra a la app web, toca "Tengo un código de invitación" y queda vinculado.')),
          st.linked ? h('div', { class: 'result ok small' }, `Caja vinculada a ${st.school_name || 'el servidor'}: los códigos se generan en el servidor.`)
            : h('div', { class: 'result err small' }, 'Esta caja no está vinculada al servidor: la hoja saldrá sin códigos. Vincúlela en Ajustes → Servidor en la nube.'))));
      draw();
    }
  };

  // ----- Ajustes / Mi cuenta -----
  VIEWS.ajustes = async (main) => {
    const info = await window.coop.info();
    const cur = h('input', { type: 'password' }); const n1 = h('input', { type: 'password' }); const n2 = h('input', { type: 'password' });
    const change = async () => {
      if (n1.value !== n2.value) return toast('Las contraseñas nuevas no coinciden', 'err');
      const r = await safe(() => call('changePassword', { current: cur.value, next: n1.value }));
      if (r) { toast('Contraseña actualizada', 'ok'); cur.value = n1.value = n2.value = ''; }
    };
    put(main, h('h1', null, state.user.role === 'admin' ? 'Ajustes' : 'Mi cuenta'),
      state.user.role === 'superadmin' ? h('p', { class: 'muted' }, 'Cuenta del dueño de la plataforma (Zuki Company). Use una contraseña larga y no la comparta con las escuelas.') : null,
      h('div', { class: 'grid g2' },
        h('div', { class: 'card form' }, h('h2', null, 'Cambiar contraseña'), field('Contraseña actual', cur), field('Nueva contraseña (mín. 6)', n1), field('Repetir nueva contraseña', n2), h('div', null, h('button', { class: 'btn primary', onclick: change }, 'Actualizar'))),
        WEB ? h('div', { class: 'card form' }, h('h2', null, 'Sesiones'), h('p', { class: 'small muted' }, 'Las sesiones expiran solas tras 30 días sin uso. Si perdió un dispositivo, cierre todas.'),
          h('div', null, h('button', { class: 'btn danger', onclick: async () => { await window.coop.auth.logoutAll(); state.user = null; render(); } }, 'Cerrar sesión en todos los dispositivos'))) : null,
        !WEB && state.user.role === 'admin' ? serverConfigCard() : null,
        !WEB && state.user.role === 'admin' ? h('div', { class: 'card form' }, h('h2', null, 'Base de datos y respaldos'),
          h('p', { class: 'small muted' }, 'Toda la información se guarda en este equipo:'), h('code', { class: 'small' }, info.dbPath),
          h('p', { class: 'small muted' }, 'Haga un respaldo al menos una vez al día y guárdelo en una USB o en la nube. Para restaurar, cierre la app y reemplace el archivo anterior por el respaldo (renombrándolo a cooperativa.db).'),
          h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => { const r = await window.coop.backup(); if (r.ok) toast('Respaldo guardado en ' + r.data, 'ok'); else if (r.error !== 'Cancelado') toast(r.error, 'err'); } }, 'Crear respaldo…'),
            h('button', { class: 'btn', onclick: () => window.coop.openDataFolder() }, 'Abrir carpeta de datos')),
          h('p', { class: 'small muted' }, `Versión ${info.version} · ${info.platform}`)) : null));
  };

  function serverConfigCard() {
    const url = h('input', { placeholder: 'https://cooperativa.midominio.mx (vacío = solo local)', class: 'grow' });
    const user = h('input', { placeholder: 'Usuario administrador del servidor', autocomplete: 'off' });
    const pass = h('input', { type: 'password', placeholder: 'Contraseña del servidor', autocomplete: 'new-password' });
    const msg = h('div', { class: 'small' });
    const statusBox = h('div', { id: 'synccard-status', class: 'card', style: { background: '#f8fafd' } });
    const say = (ok, t) => { msg.textContent = t; msg.style.color = ok ? 'var(--ok)' : 'var(--err)'; };
    window.coop.getConfig().then((c) => { url.value = c.serverUrl || ''; });
    window.coop.sync.status().then((st) => { lastSync = st; renderSyncDetails(statusBox, st); });
    return h('div', { class: 'card form', style: { gridColumn: '1 / -1' } }, h('h2', null, 'Servidor en la nube y sincronización'),
      h('p', { class: 'small muted' }, 'Con un servidor configurado y este equipo vinculado, la caja envía automáticamente (cada 45 s y unos segundos después de cada venta) movimientos, saldos, tarjetas, alumnos y productos, y descarga los ajustes que los padres hacen desde su celular (límites, prohibidos, bloqueos y vínculos). Sin internet la caja sigue funcionando y envía todo al reconectarse.'),
      statusBox,
      h('div', { class: 'row' }, url),
      h('div', { class: 'grid g2' }, user, pass), msg,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { const r = await window.coop.testServer(url.value); say(r.ok, r.ok ? '✔ Conexión correcta' : '✖ ' + r.error); } }, 'Probar conexión'),
        h('button', { class: 'btn primary', onclick: async () => {
          say(true, 'Vinculando…');
          const r = await window.coop.sync.link({ serverUrl: url.value, username: user.value, password: pass.value });
          pass.value = '';
          if (!r.ok) return say(false, '✖ ' + r.error);
          say(true, '✔ Equipo vinculado'); updateSyncInd(r.data);
        } }, 'Vincular este equipo'),
        h('button', { class: 'btn ok', onclick: async () => { updateSyncInd(await window.coop.sync.now()); } }, 'Sincronizar ahora'),
        h('button', { class: 'btn', onclick: async () => {
          if (!(await confirmBox('Equipo principal', 'Solo el equipo principal envía ventas y saldos. Convertir este equipo en principal hará que el anterior deje de enviar. ¿Continuar?'))) return;
          const r = await window.coop.sync.makePrimary({ username: user.value, password: pass.value }); pass.value = '';
          if (!r.ok) return say(false, '✖ ' + r.error); say(true, '✔ Este equipo ahora es el principal'); updateSyncInd(r.data);
        } }, 'Hacer principal'),
        h('button', { class: 'btn', onclick: async () => { const r = await window.coop.setConfig({ serverUrl: url.value }); if (r.ok) toast('URL guardada', 'ok'); else toast(r.error, 'err'); } }, 'Guardar solo URL (login)'),
        h('button', { class: 'btn danger', onclick: async () => { const r = await window.coop.sync.unlink(); if (r.ok) { say(true, 'Equipo desvinculado'); updateSyncInd(r.data); } } }, 'Desvincular')),
      h('p', { class: 'small muted' }, 'Vincular requiere una cuenta de administrador del servidor; la contraseña no se guarda, solo un token del equipo (revocable desde el servidor).'));
  }

  // ---------- indicador de sincronización (escritorio) ----------
  const SYNC_LABEL = { desactivado: 'Solo local (sin servidor)', pendiente: 'Sincronización pendiente', sincronizando: 'Sincronizando…', ok: 'Sincronizado', solo_lectura: 'Solo lectura (no es el equipo principal)', sin_conexion: 'Sin conexión', conflicto: 'Otro equipo es el principal', error: 'Error de sincronización' };
  const SYNC_COLOR = { ok: '#22c55e', sincronizando: '#60a5fa', pendiente: '#fbbf24', sin_conexion: '#f59e0b', solo_lectura: '#a78bfa', conflicto: '#ef4444', error: '#ef4444', desactivado: '#64748b' };
  const hhmm = (iso) => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }); };
  const fullDate = (iso) => (iso ? new Date(iso).toLocaleString('es-MX') : 'nunca');
  let lastSync = null;
  function updateSyncInd(st) {
    if (st) lastSync = st;
    const el = document.getElementById('syncind'); if (!el || !lastSync) return;
    const s2 = lastSync; el.innerHTML = '';
    put(el, h('span', { class: 'dot', style: { background: SYNC_COLOR[s2.state] || '#64748b' } }), h('span', null, SYNC_LABEL[s2.state] || s2.state,
      s2.state === 'ok' && s2.last_sync_at ? ' ' + hhmm(s2.last_sync_at) : '',
      s2.pending && s2.state !== 'desactivado' ? ` · ${s2.pending} pendientes` : ''));
    const card = document.getElementById('synccard-status'); if (card) renderSyncDetails(card, s2);
  }
  if (!WEB && window.coop.sync) window.coop.sync.onStatus(updateSyncInd);
  function renderSyncDetails(box, st) {
    box.innerHTML = '';
    put(box, ...[h('div', { class: 'row' }, h('span', { class: 'dot', style: { background: SYNC_COLOR[st.state] } }), h('b', null, SYNC_LABEL[st.state] || st.state)),
      st.linked && st.school_name ? h('div', null, 'Escuela: ', h('b', null, st.school_name)) : null,
      h('div', { class: 'small muted' }, `Última sincronización: ${fullDate(st.last_sync_at)} · Cambios pendientes de enviar: ${st.pending} · Equipo: ${st.device_id.slice(0, 8)}… ${st.linked ? '(vinculado)' : '(sin vincular)'}`),
      st.last_error ? h('div', { class: 'small', style: { color: st.state === 'solo_lectura' ? 'var(--warn)' : 'var(--err)' } }, st.last_error) : null,
      st.last_stats ? h('div', { class: 'small muted' }, `Último ciclo: ${st.last_stats.pulled || 0} ajustes descargados, ${st.last_stats.transactions || 0} movimientos enviados${st.last_stats.conflicts_server_wins ? `, ${st.last_stats.conflicts_server_wins} ajustes donde ganó el servidor` : ''}.`) : null].filter(Boolean));
  }

  // ---------- inicio ----------
  (async () => { const r = await window.coop.call('me'); state.user = r.ok ? r.data : null; render(); })();
})();
