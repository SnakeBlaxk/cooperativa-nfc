'use strict';
/* Zuki Pay — interfaz (renderer). Sin frameworks ni build. */
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
      // Escuela pausada (mensualidad) en la app web: se cierra la sesión y se muestra el aviso en la entrada
      if (r.code === 'ESCUELA_PAUSADA' && method !== 'login' && WEB) { state.user = null; state.pausedMsg = r.error; render(); }
      throw Object.assign(new Error(r.error), { code: r.code });
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
  function field(label, input, hint) { return h('label', null, label, input, hint ? h('span', { class: 'hint' }, hint) : null); }
  // Encabezado de página: título grande, explicación corta y botones a la derecha
  function pageHead(title, sub, ...actions) {
    return h('div', { class: 'pagehead' }, h('div', { class: 'titles' }, h('h1', null, title), sub ? h('p', { class: 'sub' }, sub) : null),
      actions.flat().filter(Boolean).length ? h('div', { class: 'actions' }, actions) : null);
  }
  const statCard = (l, v, sub) => h('div', { class: 'card stat' }, h('div', { class: 'l' }, l), h('div', { class: 'v' }, v), sub ? h('div', { class: 's' }, sub) : null);
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copiado', 'ok'); } catch (_) {
      const t = h('textarea', { style: { position: 'fixed', opacity: '0' } }); t.value = text; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); toast('Copiado', 'ok'); } catch (__) { toast('No se pudo copiar; selecciónelo y cópielo a mano', 'err'); } t.remove();
    }
  }
  // Muestra una contraseña UNA sola vez, con botón para copiar
  function passShownModal(title, user, pass) {
    modal(title, h('div', { class: 'form' }, h('p', null, 'Usuario para entrar: ', h('b', null, user.username)),
      h('p', { style: { margin: 0 } }, 'Contraseña:'),
      h('div', { class: 'copyrow' }, h('div', { class: 'bigcode', 'data-pass': '1' }, pass), h('button', { class: 'btn primary', onclick: () => copyText(pass) }, '📋 Copiar')),
      h('div', { class: 'banner warn small' }, h('span', { class: 'ico' }, '⚠️'), h('div', null, 'Se muestra solo esta vez y no se guarda en ningún lado. Cópiela y entréguela a la persona por un medio seguro (en persona o por mensaje privado).'))),
    [{ label: 'Listo, ya la copié', class: 'primary', onClick: () => render() }]);
  }
  const banner = (cls, ico, ...txt) => h('div', { class: 'banner ' + cls }, h('span', { class: 'ico' }, ico), h('div', null, txt));
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
  // Menú agrupado por tema: [título del grupo, [[vista, etiqueta, ícono], ...]]
  const NAV = {
    superadmin: [['Plataforma', [['instituciones', 'Escuelas', '🏫'], ['inventario', 'Mis tarjetas (inventario)', '🪪'], ['cuentas', 'Cuentas', '👥'], ['papelera', 'Papelera', '🗑️']]],
      ['Seguridad', [['seguridad', 'Seguridad y emergencia', '🛡️'], ['alertas', 'Alertas', '🔔'], ['bitacora', 'Bitácora', '📜']]],
      ['Mi cuenta', [['ajustes', 'Mi cuenta', '👤']]]],
    admin: [['Inicio', [['dashboard', 'Resumen', '📊'], ['notificaciones', 'Notificaciones', '📬']]],
      ['Caja', [['pos', 'Cobrar', '🛒'], ['recargas', 'Recargas', '💵']]],
      ['Escuela', [['alumnos', 'Alumnos y padres', '🧒'], ['tarjetas', 'Tarjetas', '🪪'], ['programar', 'Programar tarjetas', '📶'], ['productos', 'Productos', '🍎']]],
      ['Reportes', [['reportes', 'Reportes', '📈'], ['movimientos', 'Movimientos', '🧾']]],
      ['Configuración', [['usuarios', 'Personal', '👥'], ['papelera', 'Papelera', '🗑️'], ['ajustes', 'Ajustes', '⚙️']]]],
    cajero: [['Caja', [['pos', 'Cobrar', '🛒'], ['recargas', 'Recargas', '💵'], ['movimientos', 'Movimientos', '🧾'], ['corte', 'Corte del día', '🧮']]], ['Cuenta', [['ajustes', 'Mi cuenta', '👤']]]],
    tutor: [['Mi familia', [['hijos', 'Mis hijos', '🧒'], ['movimientos', 'Historial', '🧾']]], ['Cuenta', [['ajustes', 'Mi cuenta', '👤']]]],
  };
  const navItems = (role) => NAV[role].flatMap(([, items]) => items);
  const ROLE_LABEL = { superadmin: 'Superadministrador', admin: 'Administrador', cajero: 'Cajero', tutor: 'Padre / tutor' };
  function go(view, params = {}) { state.view = view; state.params = params; render(); }

  function render() {
    teardown();
    $app.innerHTML = '';
    if (!state.user) {
      const qs = new URLSearchParams(location.search);
      if (WEB && state.view === 'registro') return renderRegister();
      if (WEB && qs.get('reset')) history.replaceState(null, '', '/'); // la recuperación por correo ya no se usa
      return renderLogin();
    }
    if (state.user.must_change_password) return renderForceChange();
    const items = navItems(state.user.role);
    const extra = state.user.role === 'superadmin' ? ['institucion'] : ['hijo'];
    if (WEB && location.search) history.replaceState(null, '', '/');
    if (!state.view || !VIEWS[state.view] || !(items.some(([k]) => k === state.view) || extra.includes(state.view))) state.view = items[0][0];
    const main = h('div', { class: 'main' });
    const navActive = state.view === 'hijo' ? (state.user.role === 'tutor' ? 'hijos' : 'alumnos') : (state.view === 'institucion' ? 'instituciones' : state.view);
    const subtitle = state.user.role === 'superadmin' ? 'Zuki Company · Plataforma' : (state.user.role === 'tutor' ? 'Tiendita escolar' : (state.user.school_name || 'Tiendita escolar'));
    $app.appendChild(h('div', { class: 'layout' },
      h('aside', { class: 'side' },
        h('div', { class: 'brand' }, h('img', { class: 'brand-logo', src: 'logo-zukipay-blanco.png', alt: 'Zuki Pay' }), h('small', null, subtitle)),
        h('nav', { class: 'nav' }, NAV[state.user.role].map(([title, its]) => h('div', { class: 'nav-group' }, h('div', { class: 'nav-title' }, title),
          its.map(([k, l, ico]) => h('a', { class: k === navActive ? 'active' : '', tabindex: '0', 'data-view': k, onclick: () => go(k), onkeydown: (e) => { if (e.key === 'Enter') go(k); } },
            h('span', { class: 'ico' }, ico), h('span', null, l), k === 'alertas' && state.alertCount ? h('span', { class: 'count' }, String(state.alertCount)) : null,
            k === 'notificaciones' && state.notifCount ? h('span', { class: 'count', title: 'Sin leer' }, String(state.notifCount)) : null))))),
        !WEB && state.user.role !== 'tutor' ? h('div', { id: 'syncind', class: 'syncind', title: 'Clic para sincronizar ahora', onclick: () => window.coop.sync.now().then(updateSyncInd) }) : null,
        h('div', { class: 'who' }, h('b', null, state.user.full_name), h('span', null, ROLE_LABEL[state.user.role]),
          h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: logout }, 'Cerrar sesión')))),
      main));
    if (!WEB && state.user.role !== 'tutor') window.coop.sync.status().then(updateSyncInd);
    // Aviso de seguridad (recargas/ventas congeladas, solo lectura) para el personal de la escuela
    if (['admin', 'cajero'].includes(state.user.role)) {
      window.coop.call('securityStatus').then((r) => {
        const f = r && r.ok ? r.data : null; if (!f) return;
        const msgs = [];
        if (f.lockdown) msgs.push('El sistema está en ALERTA ROJA: solo se puede consultar.');
        if (f.read_only) msgs.push('La escuela está en modo SOLO LECTURA por seguridad.');
        if (f.freeze_recharges) msgs.push('Las RECARGAS están congeladas por seguridad.');
        if (f.freeze_sales) msgs.push('Las VENTAS están congeladas por seguridad.');
        if (msgs.length) main.prepend(banner('err', '⛔', h('b', null, msgs.join(' ')), h('div', { class: 'small' }, 'Si cree que es un error, comuníquese con el administrador de la plataforma.')));
        const bb = billingBanner(f.billing, f.paused);
        if (bb) main.prepend(bb);
      }).catch(() => {});
    }
    if (state.user.role === 'superadmin') refreshAlertCount();
    if (state.user.role === 'admin') {
      if (state.view !== 'notificaciones') refreshNotifCount();
      // Revisa cada minuto si llegaron solicitudes nuevas de los padres
      const t = setInterval(refreshNotifCount, 60000); onCleanup(() => clearInterval(t));
    }
    Promise.resolve(VIEWS[state.view](main, state.params)).catch((e) => { main.appendChild(h('div', { class: 'result err' }, e.message)); });
  }
  // Número de alertas sin atender (insignia roja en el menú del superadministrador)
  function refreshAlertCount() {
    if (!window.coop.superCall) return;
    window.coop.superCall('listAlerts', {}).then((r) => {
      const n = r && r.ok ? r.data.length : 0;
      if (n === state.alertCount) return; state.alertCount = n;
      const a = document.querySelector('.nav a[data-view="alertas"]'); if (!a) return;
      let c = a.querySelector('.count'); if (!n) { if (c) c.remove(); return; }
      if (!c) { c = h('span', { class: 'count' }); a.appendChild(c); } c.textContent = String(n);
    }).catch(() => {});
  }
  // Solicitudes de los padres sin leer (insignia en "Notificaciones" del administrador de la escuela)
  function setNavCount(view, n) {
    const a = document.querySelector(`.nav a[data-view="${view}"]`); if (!a) return;
    let c = a.querySelector('.count'); if (!n) { if (c) c.remove(); return; }
    if (!c) { c = h('span', { class: 'count', title: 'Sin leer' }); a.appendChild(c); } c.textContent = String(n);
  }
  function refreshNotifCount() {
    window.coop.call('changeRequestsUnread').then((r) => {
      const n = r && r.ok ? r.data.unread + (r.data.notices || 0) : 0;
      state.notifCount = n; setNavCount('notificaciones', n);
    }).catch(() => {});
  }
  let cleanups = [];
  function onCleanup(fn) { cleanups.push(fn); }
  function teardown() { cleanups.forEach((f) => { try { f(); } catch (_) { /* */ } }); cleanups = []; }
  async function logout() {
    if (WEB && state.user && state.user.role === 'tutor' && typeof currentPushSub === 'function') { try { const sb = await currentPushSub(); if (sb) { await window.coop.call('pushUnsubscribe', { endpoint: sb.endpoint }); await sb.unsubscribe(); } } catch (_) { /* nada */ } }
    await window.coop.call('logout'); state.user = null; state.view = null; render(); }

  // ---------- mensualidad: avisos para administrador y cajero (los padres no los ven) ----------
  const ddmmyyyy = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '');
  const diasTxt = (n) => (n === 1 ? '1 día' : `${n} días`);
  function billingBanner(b, paused) {
    if (paused || (b && b.stage === 'pausada')) {
      return h('div', { class: 'banner err billing', 'data-billing': 'pausada' }, h('span', { class: 'ico' }, '⏸️'),
        h('div', null, h('b', null, 'Servicio pausado. Contacte a la administración.'), h('div', { class: 'small' }, 'Las ventas y recargas están detenidas hasta que se reactive el servicio. Sus datos se conservan.')));
    }
    if (!b) return null;
    if (b.stage === 'aviso') {
      return h('div', { class: 'banner warn billing', 'data-billing': 'aviso' }, h('span', { class: 'ico' }, '📅'),
        h('div', null, h('b', null, b.days_left === 0 ? 'Tu mensualidad vence hoy' : `Tu mensualidad vence en ${diasTxt(b.days_left)}`),
          h('div', { class: 'small' }, `Fecha de vencimiento: ${ddmmyyyy(b.period_end)}. Para no interrumpir el servicio, realice su pago con la administración.`)));
    }
    if (b.stage === 'tolerancia') {
      return h('div', { class: 'banner err billing', 'data-billing': 'tolerancia' }, h('span', { class: 'ico' }, '⚠️'),
        h('div', null, h('b', null, `Periodo de tolerancia: ${b.grace_days_left === 1 ? 'queda 1 día' : `quedan ${b.grace_days_left} días`} para realizar el pago`),
          h('div', { class: 'small' }, `Su mensualidad venció el ${ddmmyyyy(b.period_end)}. Si no se registra el pago, el servicio se pausará automáticamente el ${ddmmyyyy(b.pause_on)}.`)));
    }
    return null;
  }
  const pausedBox = (msg) => h('div', { class: 'paused-box', role: 'alert' }, h('div', { class: 'ico' }, '⏸️'),
    h('b', null, msg || 'Servicio pausado. Contacte a la administración.'),
    h('div', { class: 'small' }, 'Su información está guardada y segura. El acceso volverá en cuanto se reactive el servicio.'));

  function renderLogin() {
    const u = h('input', { placeholder: 'Usuario, correo o teléfono', autofocus: true, autocomplete: 'username' });
    const p = h('input', { placeholder: 'Contraseña', type: 'password', autocomplete: 'current-password' });
    const err = h('div', { class: 'small', role: 'alert', style: { color: 'var(--err)', minHeight: '20px', fontWeight: 600 } });
    const paused = h('div');
    if (state.pausedMsg) { paused.appendChild(pausedBox(state.pausedMsg)); state.pausedMsg = null; }
    const submit = async (e) => {
      e.preventDefault(); err.textContent = ''; paused.innerHTML = '';
      try { state.user = await call('login', { username: u.value, password: p.value }); state.view = null; render(); } catch (ex) {
        if (ex.code === 'ESCUELA_PAUSADA') paused.appendChild(pausedBox()); else err.textContent = ex.message;
        p.select();
      }
    };
    $app.appendChild(h('div', { class: 'login-wrap' }, h('form', { class: 'card login form', onsubmit: submit },
      h('div', { class: 'logo' }, h('img', { src: 'logo-zukipay.png', alt: 'Zuki Pay' })), h('h1', { class: 'sr-only' }, 'Zuki Pay'), h('p', { class: 'tag' }, 'Tiendita escolar con tarjeta'), paused,
      field('Usuario, correo o teléfono', u), field('Contraseña', p), err,
      h('button', { class: 'btn primary lg block', type: 'submit' }, 'Entrar'),
      WEB ? h('div', { class: 'links' },
        h('a', { href: '#', class: 'btn block', onclick: (e) => { e.preventDefault(); go('registro'); } }, 'Soy padre/madre: tengo un código de invitación'),
        h('div', { class: 'note' }, '¿Olvidó su contraseña? Pida una nueva a la administración de su escuela.')) : null)));
    setTimeout(() => u.focus(), 50);
  }

  // ---------- pantallas de cuenta (cambio obligatorio, recuperación, registro) ----------
  function authCard(title, ...kids) {
    $app.appendChild(h('div', { class: 'login-wrap' }, h('div', { class: 'card login form' }, h('div', { class: 'logo' }, '🪪'), h('h1', null, title), ...kids)));
    const f = $app.querySelector('input'); if (f) setTimeout(() => f.focus(), 50);
  }
  function renderForceChange() {
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }); const n1 = h('input', { type: 'password', autocomplete: 'new-password' }); const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const err = h('div', { class: 'small', style: { color: 'var(--err)' } });
    const go2 = async () => {
      err.textContent = '';
      if (n1.value !== n2.value) { err.textContent = 'Las contraseñas nuevas no coinciden'; return; }
      try { state.user = await call('changePassword', { current: cur.value, next: n1.value }); toast('Contraseña actualizada', 'ok'); render(); } catch (e) { err.textContent = e.message; }
    };
    authCard('Cambie su contraseña', h('p', { class: 'tag' }, `Hola ${state.user.full_name}. Por seguridad, cree una contraseña nueva para continuar.`),
      field('Contraseña actual', cur), field('Contraseña nueva', n1, 'Mínimo 10 caracteres. Use una frase fácil de recordar.'), field('Repita la contraseña nueva', n2), err,
      h('button', { class: 'btn primary lg block', onclick: go2 }, 'Guardar y continuar'), h('button', { class: 'btn block', onclick: logout }, 'Cerrar sesión'));
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
    authCard('Crear mi cuenta', h('p', { class: 'tag' }, 'Escriba el código de invitación que le entregó la escuela junto con la tarjeta de su hijo(a).'),
      field('Código de invitación', code), field('Nombre completo', name), h('div', { class: 'grid g2' }, field('Correo', email), field('Teléfono', phone)),
      field('Contraseña (mín. 8)', p1), field('Repetir contraseña', p2), msg,
      h('button', { class: 'btn primary lg block', onclick: async () => {
        msg.textContent = '';
        if (p1.value !== p2.value) { msg.textContent = 'Las contraseñas no coinciden'; return; }
        const r = await window.coop.auth.register({ code: code.value, full_name: name.value, email: email.value || null, phone: phone.value || null, password: p1.value });
        if (!r.ok) { msg.textContent = r.error; return; }
        state.user = r.data; state.view = null; toast('¡Cuenta creada! Su hijo(a) ya está vinculado.', 'ok'); render();
      } }, 'Crear cuenta'), h('button', { class: 'btn block', onclick: () => go(null) }, 'Volver'));
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
    const d = await call('dashboard');
    main.appendChild(pageHead('Resumen de la cooperativa', `${d.school_name || 'Su escuela'} · cifras de hoy, la semana y el mes`, h('button', { class: 'btn primary', onclick: () => go('pos') }, '🛒 Ir a cobrar')));
    const stat = statCard;
    main.appendChild(h('div', { class: 'section-title', style: { marginTop: 0 } }, 'Ventas'));
    main.appendChild(h('div', { class: 'grid g4' },
      stat('Ventas de hoy', money(d.sales_day_cents), `${d.sales_day_count} ventas`),
      stat('Ventas de la semana', money(d.sales_week_cents)),
      stat('Ventas del mes', money(d.sales_month_cents)),
      stat('Tarjetas activas', String(d.active_cards), `de ${d.total_cards} registradas`),
      stat('Recargas de hoy', money(d.recharges_day_cents)),
      stat('Recargas del mes', money(d.recharges_month_cents), 'Total histórico ' + money(d.recharges_total_cents)),
      stat('Saldo en tarjetas', money(d.balance_in_cards_cents), 'Dinero de los alumnos'),
      stat('Rechazos de hoy', String(d.rejected_today), 'Por límites, saldo o prohibiciones')));
    main.appendChild(h('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', marginTop: '20px' } },
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
      const r = mk('rect', { x, y: pad.t + ih - bh, width: bw * 0.7, height: Math.max(bh, 0), rx: 4, fill: '#0b7f86' });
      const t = document.createElementNS(NS, 'title'); t.textContent = `${d.date}: ${money(d.total_cents)}`; r.appendChild(t);
      const [, m, dd] = d.date.split('-');
      if (i % Math.ceil(data.length / 16) !== 0) return;
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
    const payBtn = h('button', { class: 'btn ok lg block', onclick: () => charge() }, '✔ Cobrar (F2)');
    const nfcLbl = h('span', { class: 'small muted' });
    window.coop.nfcStatus().then((s) => { nfcLbl.textContent = s.message; });
    const webNfcBtn = window.coop.startWebNfc && 'NDEFReader' in window ? h('button', { class: 'btn', onclick: () => window.coop.startWebNfc().catch((e) => toast(e.message, 'err')) }, 'Leer con NFC del teléfono') : null;
    onCleanup(window.coop.onNfcStatus((s) => { nfcLbl.textContent = s.message; }));

    function renderInfo() {
      info.innerHTML = '';
      if (!card) { info.appendChild(h('div', { class: 'muted', style: { fontSize: '1.1rem' } }, '🪪 Acerque la tarjeta del alumno al lector.')); return; }
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

    put(main, pageHead('Cobrar', 'Acerque la tarjeta del alumno, toque los productos y presione Cobrar.', webNfcBtn, nfcLbl),
      h('div', { class: 'pos' },
        h('div', { class: 'left' }, h('div', { class: 'uidbox' }, uidIn, h('button', { class: 'btn primary', onclick: () => lookup(uidIn.value) }, 'Leer')), info, result, prodBox),
        h('div', { class: 'card cart' }, h('h2', null, 'Carrito'), cartBox, h('div', { class: 'total' }, h('span', null, 'Total'), totalEl), payBtn,
          h('button', { class: 'btn block', style: { marginTop: '10px' }, onclick: () => { cart = []; renderCart(); } }, 'Vaciar carrito'), h('p', { class: 'small muted center' }, 'Tecla Esc: empezar de nuevo'))));
    renderInfo(); renderProducts(); renderCart();
    setTimeout(() => uidIn.focus(), 50);
  };

  // ----- Recargas -----
  VIEWS.recargas = async (main) => {
    let card = null;
    const uidIn = h('input', { placeholder: 'Acerque la tarjeta o escriba el UID y presione Enter' });
    const info = h('div', { class: 'card cardinfo' });
    const amount = h('input', { placeholder: '0.00', inputmode: 'decimal', style: { fontSize: '1.4rem', width: '180px' } });
    const note = h('input', { placeholder: 'Efectivo, transferencia…' });
    const result = h('div');
    const recent = h('div', { class: 'card' });
    function renderInfo() {
      info.innerHTML = '';
      if (!card) { info.appendChild(h('div', { class: 'muted', style: { fontSize: '1.1rem' } }, '🪪 Lea la tarjeta del alumno para recargar.')); return; }
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
    put(main, pageHead('Recargas', 'Agregue saldo a la tarjeta de un alumno. 1) Lea la tarjeta  2) Elija el monto  3) Registre.'),
      h('div', { class: 'grid g2' },
        h('div', { class: 'grid', style: { alignContent: 'start' } }, h('div', { class: 'uidbox' }, uidIn, h('button', { class: 'btn primary', onclick: () => lookup(uidIn.value) }, 'Leer tarjeta')), info,
          h('div', { class: 'card form' }, h('h2', null, 'Monto a recargar (pesos)'),
            h('div', { class: 'amounts' }, [50, 100, 200, 300, 500].map((v) => h('button', { class: 'btn', onclick: () => { amount.value = v.toFixed(2); amount.focus(); } }, '$' + v))),
            h('div', { class: 'row' }, field('Otro monto', amount), h('div', { class: 'grow' }, field('Nota (opcional)', note))),
            h('button', { class: 'btn primary lg block', onclick: doRecharge }, '💵 Registrar recarga')), result),
        recent));
    renderInfo(); loadRecent(); setTimeout(() => uidIn.focus(), 50);
  };

  // ----- Productos -----
  VIEWS.productos = async (main, params) => {
    const filter = params.f || 'todos';
    const [products, categories, inv] = await Promise.all([call('listProducts'), call('listCategories'), call('getInventorySettings')]);
    const lowCount = products.filter((p) => p.low_stock).length;
    const shown = filter === 'agotarse' ? products.filter((p) => p.low_stock) : products;
    const edit = (p) => {
      const name = h('input', { value: p ? p.name : '' });
      const cat = h('select', null, categories.map((c) => h('option', { value: c.id, selected: p && p.category_id === c.id }, c.name)));
      const price = h('input', { value: p ? centsToInput(p.price_cents) : '', placeholder: '0.00' });
      const active = h('input', { type: 'checkbox', checked: p ? p.active : true });
      const stock = h('input', { value: p && p.stock !== null && p.stock !== undefined ? String(p.stock) : '', placeholder: 'En blanco = sin control', inputmode: 'numeric' });
      const smin = h('input', { value: p && p.stock_min !== null && p.stock_min !== undefined ? String(p.stock_min) : '', placeholder: 'Opcional', inputmode: 'numeric' });
      modal(p ? 'Editar producto' : 'Nuevo producto', h('div', { class: 'form' }, field('Nombre', name), field('Categoría', cat), field('Precio (MXN)', price),
        h('div', { class: 'grid g2' }, field('Existencias (piezas)', stock, p && p.stock !== null ? 'Para sumar mercancía use "Entrada".' : 'Déjelo en blanco si no quiere llevar inventario.'), field('Stock mínimo', smin, 'Le avisamos cuando queden esas piezas o menos.')),
        h('label', { class: 'check' }, active, 'Activo (visible en punto de venta)')),
      [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
        try {
          const data = { name: name.value, category_id: Number(cat.value), price_cents: parseMoney(price.value), active: active.checked, stock: stock.value.trim(), stock_min: smin.value.trim() };
          if (p) await call('updateProduct', { id: p.id, ...data }); else await call('createProduct', data);
          toast('Producto guardado', 'ok'); render();
        } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const entrada = (p) => {
      const qty = h('input', { inputmode: 'numeric', placeholder: 'p. ej. 24' }); const note = h('input', { placeholder: 'Opcional: proveedor, factura…' });
      modal('Entrada de mercancía — ' + p.name, h('div', { class: 'form' }, h('p', { class: 'small muted' }, `Existencias actuales: ${p.stock === null ? 'sin control (empieza en 0)' : p.stock + ' piezas'}`), field('Piezas que llegaron', qty), field('Nota', note)),
        [{ label: 'Cancelar' }, { label: 'Agregar', class: 'primary', onClick: async () => {
          const r = await safe(() => call('addStock', { product_id: p.id, qty: Number(qty.value), note: note.value }));
          if (!r) return false; toast(`Entrada registrada: ${r.name} ahora tiene ${r.stock} piezas`, 'ok'); render();
        } }]);
    };
    const historial = async () => {
      const mv = await safe(() => call('listStockMoves', {})); if (!mv) return;
      const KIND = { entrada: 'Entrada', venta: 'Venta', cancelacion: 'Venta cancelada', inicial: 'Inicial', ajuste: 'Ajuste' };
      modal('Movimientos de inventario', h('div', { class: 'tablewrap', style: { maxHeight: '60vh', overflow: 'auto' } }, mv.length ? h('table', null, h('tr', null, ['Fecha', 'Producto', 'Tipo', 'Piezas', 'Quedan', 'Quién / nota'].map((x) => h('th', null, x))),
        mv.map((m) => h('tr', null, h('td', null, fmtDate(m.created_at)), h('td', null, m.product_name), h('td', null, KIND[m.kind] || m.kind), h('td', { class: 'right', style: { color: m.qty < 0 ? 'var(--err)' : 'var(--ok)' } }, (m.qty > 0 ? '+' : '') + m.qty),
          h('td', { class: 'right' }, m.stock_after), h('td', { class: 'small' }, [m.user_name, m.note].filter(Boolean).join(' · '))))) : h('div', { class: 'empty' }, 'Aún no hay movimientos')));
    };
    const newCat = () => {
      const n = h('input', { placeholder: 'p. ej. Lácteos' });
      modal('Nueva categoría', field('Nombre', n), [{ label: 'Cancelar' }, { label: 'Crear', class: 'primary', onClick: async () => {
        try { await call('createCategory', { name: n.value }); toast('Categoría creada', 'ok'); render(); } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const del = async (p) => {
      if (!(await confirmBox('Eliminar producto', `¿Eliminar "${p.name}"? Se quitará de la lista; el administrador de la plataforma puede restaurarlo.`))) return;
      const r = await safe(() => call('deleteProduct', { id: p.id }));
      if (r) { toast(r.message || 'Producto eliminado', 'ok'); render(); }
    };
    const block = h('input', { type: 'checkbox', checked: inv.block_at_zero, onchange: async (e) => { const r = await safe(() => call('setInventorySettings', { block_at_zero: e.target.checked })); if (r) toast(r.block_at_zero ? 'Se bloqueará la venta de productos sin existencias' : 'Se permitirá vender aunque no haya existencias', 'ok'); } });
    const stockCell = (p) => {
      if (p.stock === null || p.stock === undefined) return h('span', { class: 'small muted' }, 'Sin control');
      return h('span', null, h('b', { style: { color: p.stock <= 0 ? 'var(--err)' : (p.low_stock ? 'var(--warn)' : '') } }, String(p.stock)), ' pzas',
        p.stock_min !== null ? h('div', { class: 'small muted' }, 'Mínimo ' + p.stock_min) : null,
        p.low_stock ? h('div', null, badge(p.stock <= 0 ? 'agotado' : 'por agotarse', p.stock <= 0 ? 'err' : 'warn')) : null);
    };
    const tabs = h('div', { class: 'tabs' }, h('button', { class: 'btn' + (filter === 'todos' ? ' active' : ''), onclick: () => go('productos', {}) }, 'Todos'),
      h('button', { class: 'btn' + (filter === 'agotarse' ? ' active' : ''), 'data-filter': 'agotarse', onclick: () => go('productos', { f: 'agotarse' }) }, '⚠️ Por agotarse', lowCount ? h('span', { class: 'count-pill' }, String(lowCount)) : null),
      h('label', { class: 'check', style: { marginLeft: 'auto' } }, block, 'No vender si no hay existencias'));
    put(main, pageHead('Productos', 'Lo que se vende en la tiendita. Los productos desactivados no aparecen al cobrar. Ponga existencias para llevar inventario (opcional).',
      h('button', { class: 'btn', onclick: historial }, '📋 Movimientos de inventario'), h('button', { class: 'btn', onclick: newCat }, '+ Categoría'), h('button', { class: 'btn primary', onclick: () => edit(null) }, '+ Nuevo producto')),
    tabs,
    h('div', { class: 'card tablewrap' }, shown.length ? h('table', null, h('tr', null, h('th', null, 'Producto'), h('th', null, 'Categoría'), h('th', { class: 'right' }, 'Precio'), h('th', null, 'Existencias'), h('th', null, 'Estado'), h('th', null, '')),
      shown.map((p) => h('tr', { 'data-product': p.id, class: p.low_stock ? 'low' : '' }, h('td', null, p.name), h('td', null, p.category_name), h('td', { class: 'right' }, money(p.price_cents)),
        h('td', null, stockCell(p)),
        h('td', null, p.active ? badge('activo', 'ok') : badge('inactivo', '')),
        h('td', { class: 'right', style: { whiteSpace: 'nowrap' } }, h('button', { class: 'btn sm ok', onclick: () => entrada(p) }, '+ Entrada'), ' ', h('button', { class: 'btn sm', onclick: () => edit(p) }, 'Editar'), ' ',
          h('button', { class: 'btn sm', onclick: async () => { await safe(() => call('updateProduct', { id: p.id, active: !p.active })); render(); } }, p.active ? 'Desactivar' : 'Activar'), ' ',
          h('button', { class: 'btn sm danger', onclick: () => del(p) }, 'Eliminar')))))
      : h('div', { class: 'empty' }, filter === 'agotarse' ? 'Ningún producto está por agotarse. 👍' : 'Sin productos')));
  };

  // ----- Tarjetas -----
  VIEWS.tarjetas = async (main) => {
    const [cards, children, stock] = await Promise.all([call('listCards'), call('listChildren'), call('listSchoolStock').catch(() => null)]);
    const childOpts = (sel) => [h('option', { value: '' }, '— Sin asignar (inventario) —'), ...children.map((c) => h('option', { value: c.id, selected: sel === c.id }, `${c.full_name} (${c.tutor ? c.tutor.full_name : ''})${c.card ? ' — ya tiene tarjeta' : ''}`))];
    const uidIn = h('input', { placeholder: 'Pase la tarjeta por el lector o escriba el UID y presione Enter', class: 'grow', autocomplete: 'off', 'data-uid-input': '' });
    const childSel = h('select', null, childOpts(null));
    const regMsg = h('div', { role: 'status' });
    const register = async () => {
      if (!uidIn.value.trim()) { uidIn.focus(); return; }
      try {
        const cid = childSel.value ? Number(childSel.value) : null;
        const r = cid ? await call('assignCardByUid', { uid: uidIn.value, child_id: cid }) : await call('registerCard', { uid: uidIn.value });
        toast(cid ? `Tarjeta ${r.uid} asignada` : 'Tarjeta registrada en inventario: ' + r.uid, 'ok'); render();
      } catch (e) {
        regMsg.innerHTML = ''; regMsg.appendChild(h('div', { class: 'result err', 'data-no-autorizada': /no autorizada/i.test(e.message) ? '1' : null }, /no autorizada/i.test(e.message) ? '⛔ ' + e.message : e.message)); uidIn.select();
        if (/no autorizada/i.test(e.message)) beep(false);
      }
    };
    // Lector USB tipo teclado (125 kHz o NFC): "escribe" el UID en el campo y termina con Enter
    uidIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); register(); } });
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
    const unassign = async (k) => {
      if (!(await confirmBox('Quitar tarjeta', `La tarjeta ${k.uid} se le quitará a ${k.child ? k.child.full_name : 'el alumno'} y regresará al inventario (sin asignar).`))) return;
      if (await safe(() => call('unassignCard', { card_id: k.id }))) { toast('Tarjeta quitada', 'ok'); render(); }
    };
    listenCardReader((uid) => { uidIn.value = uid; register(); });
    put(main, pageHead('Tarjetas', 'Registre tarjetas nuevas, asígnelas a un alumno o repórtelas como perdidas.'),
      h('div', { class: 'card form', style: { marginBottom: '20px' } }, h('h2', null, 'Registrar o asignar una tarjeta'),
        h('div', { class: 'grid g2' }, field('1. Alumno (opcional: vacío = inventario)', childSel), field('2. Tarjeta (UID)', uidIn)),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: register }, 'Registrar / asignar'), h('span', { class: 'small muted grow' }, 'Pase la tarjeta por el lector USB (125 kHz o NFC) con el cursor en el campo UID, o escriba el número y presione Enter. No se permiten tarjetas repetidas.')),
        regMsg),
      stock ? h('div', { class: 'card', style: { marginBottom: '20px' } }, h('h2', null, `Tarjetas de Zuki Company para su escuela: ${stock.filter((x) => !x.child_id).length} libres · ${stock.filter((x) => x.child_id).length} asignadas`),
        h('p', { class: 'small muted' }, 'Solo puede registrar y asignar las tarjetas que Zuki Company entregó a su escuela. Para más tarjetas, solicítelas a Zuki Company.'),
        stock.filter((x) => !x.child_id).length ? h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } }, stock.filter((x) => !x.child_id).slice(0, 60).map((x) =>
          h('button', { class: 'btn sm', title: 'Usar esta tarjeta', onclick: () => { uidIn.value = x.uid; uidIn.focus(); } }, h('code', null, x.uid)))) : h('div', { class: 'small muted' }, 'No tiene tarjetas libres.')) : null,
      h('div', { class: 'card tablewrap' }, respTable([{ label: 'UID' }, { label: 'Estado' }, { label: 'Alumno' }, { label: 'Tutor' }, { label: 'Saldo', right: true }, { label: '', right: true }],
        cards.map((k) => [h('code', null, k.uid), h('span', null, badge(k.status), k.blocked_by && k.status === 'bloqueada' ? h('div', { class: 'small muted' }, 'por ' + k.blocked_by) : null,
            ['bloqueada', 'danada'].includes(k.stock_status) ? h('div', null, badge(k.stock_status === 'danada' ? 'dañada (Zuki)' : 'bloqueada por Zuki', 'err')) : null),
          k.child ? k.child.full_name : '—', k.child ? k.child.tutor_name : '—', money(k.balance_cents),
          h('div', { class: 'row acts-wrap', style: { justifyContent: 'flex-end', gap: '6px' } },
            k.status !== 'perdida' ? h('button', { class: 'btn sm', onclick: () => assign(k) }, 'Asignar') : null,
            k.child && ['activa', 'bloqueada'].includes(k.status) ? h('button', { class: 'btn sm', onclick: () => unassign(k) }, 'Quitar') : null,
            k.status === 'activa' ? h('button', { class: 'btn sm', onclick: async () => { await safe(() => call('setCardStatus', { card_id: k.id, status: 'bloqueada' })); render(); } }, 'Bloquear') : null,
            k.status === 'bloqueada' ? h('button', { class: 'btn sm', onclick: async () => { await safe(() => call('setCardStatus', { card_id: k.id, status: 'activa' })); render(); } }, 'Activar') : null, ' ',
            k.status !== 'perdida' ? h('button', { class: 'btn sm', onclick: () => adjust(k) }, 'Ajuste') : null, ' ',
            k.status !== 'perdida' ? h('button', { class: 'btn sm danger', onclick: () => lost(k) }, 'Perdida') : null)]), null, 'resp-md')));
    setTimeout(() => uidIn.focus(), 50);
  };

  // ----- Bajas de alumnos y papás/tutores (administrador de la escuela y superadministrador) -----
  // caller: call (administrador) o superCall (superadministrador). Todo queda en la Papelera.
  async function deleteChildFlow(c, caller, onDone) {
    let pv;
    try { pv = await caller('previewDeleteChild', { child_id: c.id }); } catch (e) { return toast(e.message, 'err'); }
    const bal = pv.balance_cents;
    const refund = h('input', { type: 'checkbox' });
    const alsoTutor = h('input', { type: 'checkbox' });
    const body = h('div', { class: 'form' },
      h('p', null, '¿Dar de baja a ', h('b', null, pv.child.full_name), pv.child.grade ? ` (${pv.child.grade})` : '', '?'),
      h('ul', { class: 'small' },
        h('li', null, 'El alumno pasa a la ', h('b', null, 'Papelera'), ' y se puede restaurar.'),
        pv.card ? h('li', null, 'Su tarjeta ', h('code', null, pv.card.uid), ' se le quita y vuelve a las tarjetas libres de la escuela.') : h('li', null, 'No tiene tarjeta asignada.'),
        h('li', null, 'Su historial de compras y recargas se conserva para los reportes.')),
      bal > 0 ? h('div', { style: { padding: '10px 12px', borderRadius: '10px', background: '#fff7e6', border: '1px solid #f5c26b' } },
        h('b', null, `⚠️ Tiene saldo de ${money(bal)}.`), h('div', { class: 'small' }, 'Para darlo de baja entregue ese dinero en efectivo al papá/tutor y márquelo aquí. Si no, cancele.'),
        h('label', { class: 'check', style: { marginTop: '8px' } }, refund, `Ya entregué el reembolso de ${money(bal)} en efectivo`)) : null,
      pv.tutor ? (pv.tutor.other_children === 0
        ? h('label', { class: 'check' }, alsoTutor, `También eliminar al papá/tutor ${pv.tutor.full_name} (no tiene otros hijos)`)
        : h('p', { class: 'small muted' }, `Su papá/tutor ${pv.tutor.full_name} tiene otros hijos y se conserva.`)) : null);
    modal('Eliminar alumno', body, [{ label: 'Cancelar' }, { label: 'Eliminar alumno', class: 'danger', onClick: async () => {
      if (bal > 0 && !refund.checked) { toast('Marque que entregó el reembolso en efectivo, o cancele.', 'err'); return false; }
      try {
        const r = await caller('deleteChild', { child_id: c.id, refund: bal > 0 ? 'efectivo' : undefined, delete_tutor: alsoTutor.checked || undefined });
        toast(r.refunded_cents ? `Alumno dado de baja. Reembolso registrado: ${money(r.refunded_cents)}` : 'Alumno enviado a la Papelera', 'ok');
        if (onDone) onDone();
      } catch (e) { toast(e.message, 'err'); return false; }
    } }]);
  }
  async function deleteTutorFlow(t, caller, onDone) {
    const kids = (t.children || []).map((c) => c.full_name);
    modal('Eliminar papá/tutor', h('div', { class: 'form' },
      h('p', null, '¿Dar de baja a ', h('b', null, t.full_name), t.username ? ` (${t.username})` : '', '?'),
      h('ul', { class: 'small' },
        h('li', null, 'Ya no podrá entrar y se cierran sus sesiones abiertas.'),
        h('li', null, kids.length ? `Sus hijos (${kids.join(', ')}) siguen inscritos, pero quedan sin papá/tutor.` : 'No tiene hijos vinculados.'),
        h('li', null, 'Pasa a la Papelera y se puede restaurar.'))),
    [{ label: 'Cancelar' }, { label: 'Eliminar papá/tutor', class: 'danger', onClick: async () => {
      try { await caller('deleteTutor', { user_id: t.id }); toast('Papá/tutor enviado a la Papelera', 'ok'); if (onDone) onDone(); } catch (e) { toast(e.message, 'err'); return false; }
    } }]);
  }
  // Papelera de alumnos y papás/tutores (escuela) — el superadministrador además puede eliminar definitivamente
  async function papeleraView(main, caller, { isSuper = false, schools = [], schoolId = '' } = {}) {
    const school = isSuper ? h('select', null, h('option', { value: '' }, 'Todas las escuelas'), schools.map((s) => h('option', { value: s.id, selected: String(s.id) === String(schoolId) }, s.name))) : null;
    const box = h('div');
    const ago = (d) => (d === 0 ? 'hoy' : d === 1 ? 'hace 1 día' : `hace ${d} días`);
    const load = async () => {
      const r = await safe(() => caller('listRemoved', { school_id: school && school.value ? Number(school.value) : undefined })); if (!r) return;
      box.innerHTML = '';
      const purge = (kind, x) => async () => {
        if (!(await confirmBox('Eliminar definitivamente', `${x.full_name} se borrará para siempre y ya no se podrá restaurar. Los movimientos se conservan en los reportes. ¿Continuar?`))) return;
        if (await safe(() => caller(kind === 'alumno' ? 'purgeChild' : 'purgeTutor', kind === 'alumno' ? { child_id: x.id } : { user_id: x.id }))) { toast('Eliminado definitivamente', 'ok'); load(); }
      };
      const restore = (kind, x) => async () => {
        const res = await safe(() => caller(kind === 'alumno' ? 'restoreChild' : 'restoreTutor', kind === 'alumno' ? { child_id: x.id } : { user_id: x.id }));
        if (res) { toast(res.message || 'Restaurado', 'ok'); load(); }
      };
      const acts = (kind, x) => h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px' } },
        h('button', { class: 'btn sm ok', onclick: restore(kind, x) }, '↩️ Restaurar'),
        r.can_purge ? h('button', { class: 'btn sm danger', onclick: purge(kind, x) }, 'Eliminar definitivamente') : null);
      box.appendChild(h('div', { class: 'card tablewrap' }, h('h2', null, `Alumnos dados de baja (${r.children.length})`),
        r.children.length ? respTable([{ label: 'Alumno' }, isSuper ? { label: 'Escuela' } : null, { label: 'Dado de baja' }, { label: 'Por' }, { label: 'Movimientos', right: true }, { label: '', right: true }].filter(Boolean),
          r.children.map((c) => [h('div', null, h('b', null, c.full_name), h('div', { class: 'small muted' }, [c.grade, c.tutor_name ? 'Tutor: ' + c.tutor_name : null].filter(Boolean).join(' · '))),
            isSuper ? c.school_name || '—' : null, h('span', { title: fmtDate(c.deleted_at) }, ago(c.days)), c.deleted_by || '—', String(c.movements), acts('alumno', c)].filter((x) => x !== null)), null, 'resp-md')
          : h('div', { class: 'empty' }, 'No hay alumnos en la Papelera')));
      box.appendChild(h('div', { class: 'card tablewrap', style: { marginTop: '16px' } }, h('h2', null, `Papás/tutores dados de baja (${r.tutors.length})`),
        r.tutors.length ? respTable([{ label: 'Papá/tutor' }, isSuper ? { label: 'Escuela' } : null, { label: 'Dado de baja' }, { label: 'Por' }, { label: '', right: true }].filter(Boolean),
          r.tutors.map((u) => [h('div', null, h('b', null, u.full_name), h('div', { class: 'small muted' }, [u.username, u.email, u.phone].filter(Boolean).join(' · '))),
            isSuper ? u.school_name || '—' : null, h('span', { title: fmtDate(u.deleted_at) }, ago(u.days)), u.deleted_by || '—', acts('tutor', u)].filter((x) => x !== null)), null, 'resp-md')
          : h('div', { class: 'empty' }, 'No hay papás/tutores en la Papelera')));
    };
    if (school) school.addEventListener('change', load);
    put(main, pageHead('Papelera', isSuper
      ? 'Alumnos y papás/tutores dados de baja en las escuelas. Puede restaurarlos o eliminarlos definitivamente.'
      : 'Alumnos y papás/tutores dados de baja. Puede restaurarlos cuando quiera (se guardan al menos 30 días; solo Zuki Company los elimina definitivamente).'),
    school ? h('div', { class: 'card filters' }, field('Escuela', school)) : null, box);
    await load();
  }
  VIEWS.papelera = async (main, params = {}) => {
    if (state.user.role === 'superadmin') { const o = await superCall('overview'); return papeleraView(main, superCall, { isSuper: true, schools: o.schools, schoolId: params.school_id || '' }); }
    return papeleraView(main, call);
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
    put(main, pageHead('Alumnos y padres', 'Alumnos con su tarjeta y saldo, y los padres o tutores vinculados.'),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card tablewrap' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Padres / tutores'), h('button', { class: 'btn primary sm', onclick: () => (WEB ? tutorTempModal() : editTutor(null)) }, '+ Tutor')),
          h('table', null, h('tr', null, h('th', null, 'Nombre'), h('th', null, 'Usuario'), h('th', null, 'Hijos'), h('th', null, '')),
            tutors.map((t) => h('tr', null, h('td', null, t.full_name, h('div', { class: 'small muted' }, [t.phone, t.email].filter(Boolean).join(' · '))), h('td', null, t.username, t.active ? '' : ' (inactivo)'),
              h('td', null, (t.children || []).map((c) => c.full_name).join(', ') || '—'), h('td', { class: 'right' }, h('button', { class: 'btn sm', onclick: () => editTutor(t) }, 'Editar'), ' ', h('button', { class: 'btn sm danger', title: 'Eliminar papá/tutor', onclick: () => deleteTutorFlow(t, call, render) }, 'Eliminar papá/tutor')))))),
        h('div', { class: 'card tablewrap' }, h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Alumnos'), h('button', { class: 'btn primary sm', onclick: () => editChild(null) }, '+ Alumno')),
          h('table', null, h('tr', null, h('th', null, 'Alumno'), h('th', null, 'Tarjeta'), h('th', { class: 'right' }, 'Saldo'), h('th', null, '')),
            children.map((c) => h('tr', null, h('td', null, h('div', { class: 'row' }, avatar(c.photo, 34), h('div', null, c.full_name, c.active ? '' : ' (inactivo)', h('div', { class: 'small muted' }, `${c.grade || ''} · ${c.tutor ? c.tutor.full_name : ''}`)))),
              h('td', null, c.card ? [h('code', null, c.card.uid), ' ', badge(c.card.status)] : h('button', { class: 'btn sm ok', onclick: () => go('hijo', { id: c.id, tab: 'tarjeta' }) }, '🪪 Asignar tarjeta')),
              h('td', { class: 'right' }, money(c.balance_cents)),
              h('td', { class: 'right' }, h('button', { class: 'btn sm', onclick: () => editChild(c) }, 'Editar'), ' ', h('button', { class: 'btn sm primary', onclick: () => go('hijo', { id: c.id }) }, 'Ver'), ' ', h('button', { class: 'btn sm', onclick: () => go('hijo', { id: c.id, tab: 'tarjeta' }) }, 'Tarjeta'),
                WEB ? [' ', h('button', { class: 'btn sm', onclick: () => invite(c) }, 'Invitación')] : null, ' ', h('button', { class: 'btn sm danger', onclick: () => deleteChildFlow(c, call, render) }, 'Eliminar alumno'))))))));
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
    modal('Nueva cuenta de tutor', h('div', { class: 'form' }, h('p', { class: 'small muted' }, 'Se genera una contraseña automáticamente. El tutor entra con su correo o teléfono.'),
      field('Nombre completo', name), h('div', { class: 'grid g2' }, field('Correo', email), field('Teléfono', phone))),
    [{ label: 'Cancelar' }, { label: 'Crear cuenta', class: 'primary', onClick: async () => {
      const r = await window.coop.auth.createTutor({ full_name: name.value, email: email.value || null, phone: phone.value || null });
      if (!r.ok) { toast(r.error, 'err'); return false; }
      passShownModal('Cuenta creada', r.data.user, r.data.temporary_password);
    } }]);
  }

  function userModal(u, fixedRole) {
    const role = h('select', { disabled: !!u || !!fixedRole }, ['admin', 'cajero', 'tutor'].map((r) => h('option', { value: r, selected: (u ? u.role : fixedRole || 'cajero') === r }, ROLE_LABEL[r])));
    const username = h('input', { value: u ? u.username : '', disabled: !!u });
    const name = h('input', { value: u ? u.full_name : '' }); const phone = h('input', { value: u ? u.phone || '' : '', type: 'tel' }); const email = h('input', { value: u ? u.email || '' : '', type: 'email' });
    const pass = h('input', { type: 'password', placeholder: 'Mínimo 6 caracteres', autocomplete: 'new-password' });
    const active = h('input', { type: 'checkbox', checked: u ? u.active : true });
    modal(u ? 'Editar usuario' : 'Nuevo usuario', h('div', { class: 'form' }, field('Puesto', role), field('Usuario (para iniciar sesión)', username), field('Nombre completo', name),
      h('div', { class: 'grid g2' }, field('Teléfono', phone), field('Correo', email)),
      u ? h('div', { class: 'banner info small' }, h('span', { class: 'ico' }, '🔑'), h('div', null, 'Las contraseñas solo las cambia el administrador de la plataforma (Zuki Company).'))
        : field('Contraseña inicial', pass, 'Désela a la persona. Si la olvida, el administrador de la plataforma le asigna otra.'),
      u ? h('label', { class: 'check' }, active, 'Cuenta activa (puede entrar)') : null),
    [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
      try {
        if (u) await call('updateUser', { id: u.id, full_name: name.value, phone: phone.value, email: email.value, active: active.checked });
        else await call('createUser', { role: role.value, username: username.value, full_name: name.value, phone: phone.value, email: email.value, password: pass.value });
        toast('Usuario guardado', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); return false; }
    } }]);
  }

  VIEWS.usuarios = async (main) => {
    const users = await call('listUsers');
    put(main, pageHead('Personal', 'Cuentas del personal de la escuela (administradores y cajeros) y de los padres.', h('button', { class: 'btn primary', onclick: () => userModal(null) }, '+ Nueva cuenta')),
      h('div', { class: 'card tablewrap' }, h('table', null, h('tr', null, h('th', null, 'Nombre'), h('th', null, 'Usuario'), h('th', null, 'Rol'), h('th', null, 'Estado'), h('th', null, '')),
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
    const box = h('div', { class: 'card tablewrap' }); let rows = [];
    const isTutor = state.user.role === 'tutor';
    async function load() {
      const f = { from: from.value || undefined, to: to.value || undefined, type: type.value || undefined, status: status.value || undefined, child_id: child.value ? Number(child.value) : undefined, uid: uid && uid.value ? uid.value : undefined, limit: 1000 };
      const r = await safe(() => call('listMovements', f)); if (!r) return; rows = r;
      box.innerHTML = '';
      box.appendChild(movTable(rows, { showUser: !isTutor, onReverse: state.user.role === 'admin' ? reverse : null }));
    }
    function reverse(m) {
      const why = h('input', { placeholder: 'p. ej. Se cobró dos veces' });
      modal('Cancelar venta', h('div', { class: 'form' }, h('p', null, `Se devolverán ${money(m.amount_cents)} a la tarjeta de ${m.child_name || m.card_uid} y las piezas regresarán al inventario.`), field('Motivo', why)),
        [{ label: 'No cancelar' }, { label: 'Cancelar venta', class: 'danger', onClick: async () => {
          const r = await safe(() => call('reverseSale', { transaction_id: m.id, reason: why.value })); if (!r) return false;
          toast(`Venta cancelada. Saldo nuevo: ${money(r.balance_cents)}`, 'ok'); load();
        } }]);
    }
    function exportCsv() {
      const esc = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
      const lines = [['Fecha', 'Tipo', 'Estado', 'Alumno', 'UID', 'Monto MXN', 'Saldo después', 'Detalle', 'Motivo rechazo', 'Atendió'].map(esc).join(',')];
      for (const m of rows) lines.push([m.created_at, m.type, m.status, m.child_name, m.card_uid, (m.amount_cents / 100).toFixed(2), m.balance_after_cents === null ? '' : (m.balance_after_cents / 100).toFixed(2), m.items.map((i) => `${i.qty}x ${i.product_name}`).join('; ') || m.note || '', m.reason || '', m.user_name || ''].map(esc).join(','));
      const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = h('a', { href: URL.createObjectURL(blob), download: `movimientos-${new Date().toISOString().slice(0, 10)}.csv` }); document.body.appendChild(a); a.click(); a.remove();
    }
    put(main, pageHead(isTutor ? 'Historial' : 'Movimientos', isTutor ? 'Compras y recargas de sus hijos, incluidas las compras rechazadas.' : 'Ventas, recargas y ajustes. Use los filtros y exporte a Excel (CSV).',
      h('button', { class: 'btn', onclick: exportCsv }, '⬇ Exportar a Excel (CSV)')),
      h('div', { class: 'card filters' }, field('Desde', from), field('Hasta', to), field('Tipo', type), field('Estado', status), field('Alumno', child), uid ? field('Tarjeta', uid) : null,
        h('button', { class: 'btn primary', onclick: load }, 'Buscar')),
      box);
    load();
  };
  function movTable(rows, { showUser = true, showChild = true, onReverse = null } = {}) {
    if (!rows.length) return h('div', { class: 'empty' }, 'Sin movimientos');
    return h('table', null, h('tr', null, h('th', null, 'Fecha'), showChild ? h('th', null, 'Alumno') : null, h('th', null, 'Tipo'), h('th', null, 'Detalle'), h('th', null, 'Estado'), h('th', { class: 'right' }, 'Monto'), h('th', { class: 'right' }, 'Saldo'), showUser ? h('th', null, 'Atendió') : null, onReverse ? h('th', null, '') : null),
      rows.map((m) => h('tr', null, h('td', null, fmtDate(m.created_at)), showChild ? h('td', null, m.child_name || '—') : null, h('td', null, badge(m.subtype || m.type, m.type === 'recarga' ? 'recarga' : (m.subtype === 'reembolso' ? 'warn' : ''))),
        h('td', null, m.items.length ? h('div', { class: 'items-list' }, m.items.map((i) => `${i.qty}× ${i.product_name}`).join(', ')) : h('span', { class: 'items-list' }, m.note || ''),
          m.reason ? h('div', { class: 'small', style: { color: 'var(--err)' } }, m.reason) : null),
        h('td', null, badge(m.status)),
        h('td', { class: 'right', style: { color: m.status === 'rechazado' ? 'var(--muted)' : (m.type === 'compra' || m.amount_cents < 0 ? 'var(--err)' : 'var(--ok)'), textDecoration: m.status === 'rechazado' ? 'line-through' : '' } },
          (m.type === 'compra' ? '−' : (m.amount_cents < 0 ? '' : '+')) + money(Math.abs(m.amount_cents)).replace('-', '−')),
        h('td', { class: 'right' }, m.balance_after_cents === null ? '' : money(m.balance_after_cents)),
        showUser ? h('td', { class: 'small' }, m.user_name || '') : null,
        onReverse ? h('td', null, m.type === 'compra' && m.status === 'aprobado' ? (m.reversed_at ? badge('cancelada', 'warn') : h('button', { class: 'btn sm', onclick: () => onReverse(m) }, 'Cancelar venta')) : null) : null)));
  }

  // ======================================================================
  // ----- Reportes (administrador) y Corte del día (cajero) -----
  // ======================================================================
  const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ddmm = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  function presetRange(k) {
    const n = new Date(); const t = ymdLocal(n);
    if (k === 'semana') { const s = new Date(n); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); return { from: ymdLocal(s), to: t }; }
    if (k === 'mes') return { from: ymdLocal(new Date(n.getFullYear(), n.getMonth(), 1)), to: t };
    return { from: t, to: t };
  }
  const rangeText = (r) => (r.from === r.to ? ddmm(r.from) : `${ddmm(r.from)} al ${ddmm(r.to)}`);
  const reportTitle = (r, corte) => (corte ? 'Corte del día' : 'Reporte de ventas');
  // Dibuja el reporte en un lienzo blanco (tamaño carta/A4 a 150 ppp de ancho) para PNG y PDF
  function drawReportCanvas(r, corte) {
    const W = 1240; const M = 70; const cw = W - 2 * M;
    const rowsTop = Math.min(r.top_products.length, 10); const rowsCash = r.by_cashier.length; const rowsRej = Math.min(r.rejected.length, 15);
    const H = 720 + 380 + (rowsTop + rowsCash + rowsRej + 6) * 34 + 260;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    const F = (sz, w) => `${w || 400} ${sz}px "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    let y = M;
    g.fillStyle = '#0b7f86'; g.fillRect(M, y, cw, 8); y += 52;
    g.fillStyle = '#111827'; g.font = F(40, 800); g.fillText(r.school_name || 'Cooperativa escolar', M, y); y += 46;
    g.font = F(28, 600); g.fillStyle = '#374151'; g.fillText(`${reportTitle(r, corte)} · ${rangeText(r)}`, M, y); y += 34;
    g.font = F(20); g.fillStyle = '#6b7280';
    g.fillText(`Generado: ${fmtDate(r.generated_at)}${r.only_cashier ? ' · Cajero: ' + r.only_cashier : ''} · Zuki Pay`, M, y); y += 36;
    const stats = [['Ventas', money(r.sales_cents)], ['Número de ventas', String(r.sales_count)], ['Ticket promedio', money(r.avg_ticket_cents)], ['Recargas', money(r.recharges_cents) + ` (${r.recharges_count})`],
      ['Ventas rechazadas', String(r.rejected_count)], ['Monto rechazado', money(r.rejected_cents)], ['Ventas canceladas', String(r.cancelled_count)], ['Monto cancelado', money(r.cancelled_cents)]];
    const bw = (cw - 3 * 16) / 4;
    stats.forEach(([l, v], i) => {
      const x = M + (i % 4) * (bw + 16); const yy = y + Math.floor(i / 4) * 118;
      g.fillStyle = '#f5f7fb'; g.strokeStyle = '#dde3ee'; g.lineWidth = 2; g.beginPath(); if (g.roundRect) g.roundRect(x, yy, bw, 102, 12); else g.rect(x, yy, bw, 102); g.fill(); g.stroke();
      g.fillStyle = '#6b7280'; g.font = F(19, 600); g.fillText(l, x + 18, yy + 34);
      g.fillStyle = '#111827'; g.font = F(v.length > 14 ? 25 : 31, 800); g.fillText(v, x + 18, yy + 78);
    });
    y += 2 * 118 + 30;
    // gráfica de ventas por día
    g.fillStyle = '#111827'; g.font = F(26, 700); g.fillText('Ventas por día', M, y); y += 20;
    const ch = 300; const pl = 90; const days = r.sales_by_day; const max = Math.max(1000, ...days.map((d) => d.total_cents));
    g.font = F(16); g.fillStyle = '#6b7280'; g.textAlign = 'right';
    for (let i = 0; i <= 4; i++) { const yy = y + ch - (ch * i) / 4; g.strokeStyle = '#e5e7eb'; g.lineWidth = 1; g.beginPath(); g.moveTo(M + pl, yy); g.lineTo(M + cw, yy); g.stroke(); g.fillText(money((max * i) / 4).replace('.00', ''), M + pl - 8, yy + 5); }
    const n = Math.max(1, days.length); const bwid = (cw - pl) / n; const every = Math.ceil(n / 16);
    g.textAlign = 'center';
    days.forEach((d, i) => {
      const bh = (d.total_cents / max) * ch; const x = M + pl + i * bwid;
      g.fillStyle = '#0b7f86'; g.fillRect(x + bwid * 0.15, y + ch - bh, bwid * 0.7, bh);
      if (i % every === 0) { g.fillStyle = '#6b7280'; g.fillText(`${d.date.slice(8, 10)}/${d.date.slice(5, 7)}`, x + bwid / 2, y + ch + 22); }
    });
    g.textAlign = 'left'; y += ch + 60;
    const table = (title, heads, rows, aligns) => {
      g.fillStyle = '#111827'; g.font = F(26, 700); g.fillText(title, M, y); y += 14;
      const cols = heads.length; const widths = aligns.map((a, i) => (i === 0 ? cw * (cols > 3 ? 0.4 : 0.55) : cw * (cols > 3 ? 0.6 : 0.45) / (cols - 1)));
      const row = (cells, head) => {
        y += 34; let x = M;
        if (head) { g.fillStyle = '#eef2f8'; g.fillRect(M, y - 24, cw, 34); }
        g.font = F(19, head ? 700 : 400); g.fillStyle = head ? '#374151' : '#111827';
        cells.forEach((v, i) => {
          let s = String(v); const maxw = widths[i] - 16;
          while (g.measureText(s).width > maxw && s.length > 3) s = s.slice(0, -2);
          if (s !== String(v)) s = s.slice(0, -1) + '…';
          if (aligns[i] === 'r') { g.textAlign = 'right'; g.fillText(s, x + widths[i] - 8, y); g.textAlign = 'left'; } else g.fillText(s, x + 8, y);
          x += widths[i];
        });
        g.strokeStyle = '#e5e7eb'; g.beginPath(); g.moveTo(M, y + 10); g.lineTo(M + cw, y + 10); g.stroke();
      };
      row(heads, true);
      if (!rows.length) { y += 34; g.fillStyle = '#6b7280'; g.font = F(19); g.fillText('Sin datos en este periodo', M + 8, y); }
      rows.forEach((rw) => row(rw));
      y += 50;
    };
    table('Productos más vendidos', ['Producto', 'Piezas', 'Total'], r.top_products.slice(0, 10).map((p) => [p.name, p.qty, money(p.total_cents)]), ['l', 'r', 'r']);
    table('Ventas por cajero', ['Cajero', 'Ventas', 'Total'], r.by_cashier.map((p) => [p.name, p.count, money(p.total_cents)]), ['l', 'r', 'r']);
    table('Ventas rechazadas', ['Alumno', 'Fecha', 'Motivo', 'Monto'], r.rejected.slice(0, 15).map((x) => [x.child_name || '—', fmtDate(x.created_at), x.reason || '', money(x.amount_cents)]), ['l', 'l', 'l', 'r']);
    // recorta el alto sobrante
    const out = document.createElement('canvas'); out.width = W; out.height = Math.min(H, y + 20);
    out.getContext('2d').drawImage(c, 0, 0);
    return out;
  }
  // PDF mínimo (sin librerías): cada página carta es una imagen JPEG del reporte
  function canvasToPdf(canvas) {
    const PW = 612; const PH = 792; // carta en puntos
    const pxPerPage = Math.floor(canvas.width * (PH / PW));
    const pages = [];
    for (let top = 0; top < canvas.height; top += pxPerPage) {
      const hgt = Math.min(pxPerPage, canvas.height - top);
      const pc = document.createElement('canvas'); pc.width = canvas.width; pc.height = pxPerPage;
      const g = pc.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, pc.width, pc.height); g.drawImage(canvas, 0, top, canvas.width, hgt, 0, 0, canvas.width, hgt);
      const bin = atob(pc.toDataURL('image/jpeg', 0.9).split(',')[1]);
      const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      pages.push({ bytes, w: pc.width, h: pc.height });
    }
    const enc = (s) => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; };
    const parts = []; let len = 0; const offs = [];
    const push = (b) => { parts.push(b); len += b.length; };
    const obj = (id, body, stream) => { offs[id] = len; push(enc(`${id} 0 obj\n${body}\n`)); if (stream) { push(enc('stream\n')); push(stream); push(enc('\nendstream\n')); } push(enc('endobj\n')); };
    push(enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'));
    const N = pages.length; const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${N} >>`);
    pages.forEach((p, i) => {
      const pid = 3 + i * 3; const iid = pid + 1; const cid = pid + 2;
      obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im${i} ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);
      obj(iid, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>`, p.bytes);
      const content = enc(`q ${PW} 0 0 ${PH} 0 0 cm /Im${i} Do Q`);
      obj(cid, `<< /Length ${content.length} >>`, content);
    });
    const xref = len; const total = 3 + N * 3;
    let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let i = 1; i < total; i++) x += String(offs[i]).padStart(10, '0') + ' 00000 n \n';
    push(enc(x + `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    return new Blob(parts, { type: 'application/pdf' });
  }
  function downloadBlob(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
  }
  const reportFileName = (r, corte, ext) => `${corte ? 'corte' : 'reporte'}-${(r.school_name || 'escuela').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}-${r.from}${r.to !== r.from ? '_' + r.to : ''}.${ext}`;
  function reportCsv(r) {
    const esc = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
    const L = []; const row = (...c) => L.push(c.map(esc).join(','));
    row(r.school_name, reportTitle(r), rangeText(r)); row();
    row('Ventas MXN', (r.sales_cents / 100).toFixed(2)); row('Número de ventas', r.sales_count); row('Ticket promedio MXN', (r.avg_ticket_cents / 100).toFixed(2));
    row('Recargas MXN', (r.recharges_cents / 100).toFixed(2)); row('Ventas rechazadas', r.rejected_count); row('Ventas canceladas', r.cancelled_count); row();
    row('Fecha', 'Ventas MXN', 'Número'); r.sales_by_day.forEach((d) => row(d.date, (d.total_cents / 100).toFixed(2), d.count)); row();
    row('Producto', 'Piezas', 'Total MXN'); r.top_products.forEach((p) => row(p.name, p.qty, (p.total_cents / 100).toFixed(2))); row();
    row('Cajero', 'Ventas', 'Total MXN'); r.by_cashier.forEach((p) => row(p.name, p.count, (p.total_cents / 100).toFixed(2))); row();
    row('Rechazada: fecha', 'Alumno', 'Motivo', 'Monto MXN'); r.rejected.forEach((x) => row(x.created_at, x.child_name, x.reason, (x.amount_cents / 100).toFixed(2)));
    return new Blob(['\ufeff' + L.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  }
  function reportBody(r, corte) {
    const actions = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } },
      h('button', { class: 'btn primary', 'data-dl': 'pdf', onclick: () => { downloadBlob(canvasToPdf(drawReportCanvas(r, corte)), reportFileName(r, corte, 'pdf')); toast('PDF descargado', 'ok'); } }, '⬇ Descargar PDF'),
      h('button', { class: 'btn', 'data-dl': 'png', onclick: () => drawReportCanvas(r, corte).toBlob((b) => { downloadBlob(b, reportFileName(r, corte, 'png')); toast('Imagen descargada', 'ok'); }, 'image/png') }, '🖼 Descargar imagen'),
      h('button', { class: 'btn', 'data-dl': 'csv', onclick: () => downloadBlob(reportCsv(r), reportFileName(r, corte, 'csv')) }, '⬇ Excel (CSV)'));
    const tbl = (heads, rows, empty) => (rows.length ? h('table', null, h('tr', null, heads.map(([t, right]) => h('th', { class: right ? 'right' : '' }, t))), rows.map((cells) => h('tr', null, cells.map((v, i) => h('td', { class: heads[i][1] ? 'right' : '' }, v)))))
      : h('div', { class: 'empty' }, empty || 'Sin datos en este periodo'));
    return h('div', { class: 'report' },
      h('div', { class: 'card row report-head', style: { marginBottom: '16px', justifyContent: 'space-between', flexWrap: 'wrap' } },
        h('div', null, h('h2', { style: { margin: 0 } }, r.school_name || 'Su escuela'), h('div', { class: 'muted' }, `${reportTitle(r, corte)} · ${rangeText(r)}`, r.only_cashier ? ` · ${r.only_cashier}` : '')), actions),
      h('div', { class: 'grid g4' }, statCard('Ventas', money(r.sales_cents), `${r.sales_count} ventas`), statCard('Ticket promedio', money(r.avg_ticket_cents)),
        statCard('Recargas', money(r.recharges_cents), r.refunds_count ? `${r.recharges_count} recargas · reembolsos por baja: ${money(r.refunds_cents)}` : `${r.recharges_count} recargas`), statCard('Ventas rechazadas', String(r.rejected_count), r.cancelled_count ? `${r.cancelled_count} canceladas (${money(r.cancelled_cents)})` : 'Por límites, saldo, prohibiciones o existencias')),
      h('div', { class: 'card chart', style: { marginTop: '20px' } }, h('h2', null, 'Ventas por día'), barChart(r.sales_by_day)),
      h('div', { class: 'grid g2', style: { marginTop: '20px' } },
        h('div', { class: 'card' }, h('h2', null, 'Productos más vendidos'), tbl([['Producto'], ['Piezas', 1], ['Total', 1]], r.top_products.map((p) => [p.name, p.qty, money(p.total_cents)]))),
        h('div', { class: 'card' }, h('h2', null, 'Ventas por cajero'), tbl([['Cajero'], ['Ventas', 1], ['Total', 1]], r.by_cashier.map((p) => [p.name, p.count, money(p.total_cents)])))),
      h('div', { class: 'card', style: { marginTop: '20px' } }, h('h2', null, 'Ventas rechazadas'),
        tbl([['Fecha'], ['Alumno'], ['Motivo'], ['Monto', 1]], r.rejected.map((x) => [fmtDate(x.created_at), x.child_name || '—', x.reason || '', money(x.amount_cents)]), 'No hubo ventas rechazadas')));
  }
  VIEWS.reportes = async (main, params) => {
    const preset = params.p || 'hoy';
    const rg = preset === 'personalizado' ? { from: params.from || presetRange('mes').from, to: params.to || ymdLocal(new Date()) } : presetRange(preset);
    const from = h('input', { type: 'date', value: rg.from }); const to = h('input', { type: 'date', value: rg.to });
    const corte = preset === 'hoy' && params.corte;
    const tabs = h('div', { class: 'tabs' }, [['hoy', 'Hoy'], ['semana', 'Esta semana'], ['mes', 'Este mes'], ['personalizado', 'Personalizado']]
      .map(([k, l]) => h('button', { class: 'btn' + (k === preset ? ' active' : ''), onclick: () => go('reportes', { p: k }) }, l)),
    h('button', { class: 'btn ok', style: { marginLeft: 'auto' }, onclick: () => go('reportes', { p: 'hoy', corte: 1 }) }, '🧮 Corte del día'));
    const custom = preset === 'personalizado' ? h('div', { class: 'card filters' }, field('Desde', from), field('Hasta', to), h('button', { class: 'btn primary', onclick: () => go('reportes', { p: 'personalizado', from: from.value, to: to.value }) }, 'Ver reporte')) : null;
    put(main, pageHead(corte ? 'Corte del día' : 'Reportes', 'Ventas, recargas y rechazos del periodo. Descárguelo en PDF o como imagen para imprimir o enviar.'), tabs, custom);
    const r = await call('report', rg);
    main.appendChild(reportBody(r, corte));
  };
  VIEWS.corte = async (main) => {
    const r = await call('report', {});
    put(main, pageHead('Corte del día', state.user.role === 'cajero' ? 'Sus ventas de hoy. Descárguelo para entregarlo al cerrar la caja.' : 'Ventas de hoy.'), reportBody(r, true));
  };

  // ----- Tutor: notificaciones push en este teléfono -----
  const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const IS_STANDALONE = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  function b64ToBytes(s) { const p = '='.repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, (ch) => ch.charCodeAt(0)); }
  async function currentPushSub() { if (!pushSupported()) return null; const reg = await navigator.serviceWorker.getRegistration(); return reg ? reg.pushManager.getSubscription() : null; }
  async function enablePush() {
    if (!pushSupported()) throw new Error(IS_IOS ? 'En iPhone/iPad primero agregue la app a la pantalla de inicio y ábrala desde el ícono.' : 'Este navegador no permite notificaciones.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('No se dio permiso para notificaciones. Actívelo en los ajustes del navegador para este sitio.');
    const k = await window.coop.push.key();
    if (!k.ok || !k.data.publicKey) throw new Error('El servidor no tiene notificaciones configuradas.');
    const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // si la llave del servidor cambió, se vuelve a suscribir
      const cur = sub.options && sub.options.applicationServerKey ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : k.data.publicKey;
      if (cur !== k.data.publicKey) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.data.publicKey) });
    await call('pushSubscribe', { subscription: sub.toJSON(), user_agent: navigator.userAgent.slice(0, 300) });
    window.coop.push.test().catch(() => {});
  }
  async function pushCard() {
    const prefs = await call('getPushPrefs');
    const sub = await currentPushSub().catch(() => null);
    const on = !!sub && Notification.permission === 'granted';
    const box = h('div', { class: 'card push-card', 'data-push': on ? 'on' : 'off', style: { marginBottom: '16px' } });
    const chk = (k, label) => { const i = h('input', { type: 'checkbox', checked: prefs[k], 'data-pref': k }); return { i, el: h('label', { class: 'check' }, i, label) }; };
    const c1 = chk('purchases', 'Cada compra (productos, monto y saldo restante)'); const c2 = chk('rejected', 'Compras rechazadas'); const c3 = chk('low_balance', 'Saldo bajo');
    const th = h('input', { value: centsToInput(prefs.low_balance_cents), inputmode: 'decimal', style: { width: '110px' }, 'data-pref': 'threshold' });
    const save = async () => {
      const r = await safe(async () => call('setPushPrefs', { purchases: c1.i.checked, rejected: c2.i.checked, low_balance: c3.i.checked, low_balance_cents: parseMoney(th.value) }));
      if (r) toast('Preferencias guardadas', 'ok');
    };
    let hint = null;
    if (IS_IOS && !IS_STANDALONE()) hint = banner('info', '📱', h('b', null, 'En iPhone o iPad: '), 'las notificaciones solo funcionan con la app instalada. Toque ', h('b', null, 'Compartir ⬆'), ' → ', h('b', null, 'Agregar a inicio'), ', abra la Cooperativa desde el ícono y toque aquí "Activar notificaciones" (requiere iOS 16.4 o más reciente).');
    else if (!pushSupported()) hint = banner('warn', '⚠️', 'Este navegador no permite notificaciones. Use Chrome, Edge, Firefox o Safari actualizados.');
    else if (Notification.permission === 'denied') hint = banner('warn', '🔕', 'Las notificaciones están bloqueadas para este sitio. Permítalas en los ajustes del navegador y vuelva a intentarlo.');
    put(box, h('div', { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' } },
      h('div', null, h('h2', { style: { margin: 0 } }, '🔔 Notificaciones'), h('div', { class: 'small muted' }, on ? 'Activadas en este teléfono. Le avisaremos al momento.' : 'Reciba un aviso en este teléfono cuando su hijo(a) compre en la cooperativa.')),
      on ? h('div', { class: 'row', style: { gap: '8px' } }, badge('activadas', 'ok'), h('button', { class: 'btn sm', onclick: async () => { await safe(async () => { const s2 = await currentPushSub(); if (s2) { await call('pushUnsubscribe', { endpoint: s2.endpoint }); await s2.unsubscribe(); } toast('Notificaciones desactivadas en este teléfono', 'ok'); render(); }); } }, 'Desactivar'))
        : h('button', { class: 'btn primary', 'data-push-enable': '1', disabled: IS_IOS && !IS_STANDALONE() ? true : undefined, onclick: async () => { const ok = await safe(async () => { await enablePush(); return true; }); if (ok) { toast('Notificaciones activadas', 'ok'); render(); } } }, 'Activar notificaciones')),
    hint ? h('div', { style: { marginTop: '12px' } }, hint) : null,
    h('div', { class: 'push-prefs', style: { marginTop: '14px', display: 'grid', gap: '8px' } }, h('div', { class: 'small muted' }, 'Avisarme de:'), c1.el, c2.el,
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, c3.el, h('span', { class: 'small' }, 'cuando quede menos de $'), th, h('span', { class: 'small muted' }, '(un aviso cada vez que baje de esa cantidad)')),
      h('div', null, h('button', { class: 'btn sm', onclick: save }, 'Guardar preferencias'))));
    return box;
  }

  // ----- Tutor: mis hijos -----
  VIEWS.hijos = async (main) => {
    const kids = await call('listChildren');
    main.appendChild(pageHead('Mis hijos', 'Toque a su hijo(a) para ver compras, poner límites o bloquear la tarjeta.',
      WEB ? h('button', { class: 'btn primary', onclick: () => {
        const code = h('input', { placeholder: 'COOP-XXXX-XXXX' });
        modal('Vincular otro hijo', h('div', { class: 'form' }, h('p', { class: 'small muted' }, 'Escriba el código de invitación que le dio la cooperativa.'), field('Código', code)),
          [{ label: 'Cancelar' }, { label: 'Vincular', class: 'primary', onClick: async () => { const r = await window.coop.auth.redeem(code.value); if (!r.ok) { toast(r.error, 'err'); return false; } toast(`${r.data.child.full_name} vinculado`, 'ok'); render(); } }]);
      } }, '+ Agregar hijo con código') : null));
    if (WEB && state.user.role === 'tutor' && window.coop.push) { try { main.appendChild(await pushCard()); } catch (e) { console.warn('[push]', e.message); } }
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
    const c = s.child; const isTutor = state.user.role === 'tutor';
    // Límites y prohibidos: solo el padre/madre/tutor los configura; la escuela solo los consulta
    let tab = params.tab || 'historial'; if (!isTutor && (tab === 'limites' || tab === 'prohibidos')) tab = 'reglas';
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
      (isTutor ? [['historial', 'Historial'], ['limites', 'Límites de gasto'], ['prohibidos', 'Productos prohibidos'], ['tarjeta', 'Tarjeta y perfil']]
        : [['historial', 'Historial'], ['reglas', 'Límites y prohibidos (del tutor)'], ['tarjeta', 'Tarjeta y perfil']]).map(([k, l]) => h('button', { class: 'btn' + (k === tab ? ' active' : ''), onclick: () => go('hijo', { id: c.id, tab: k }) }, l)));
    const body = h('div', { class: 'card' });
    put(main, header, tabs, body);

    if (tab === 'historial') {
      put(body, h('h2', null, 'Últimos movimientos'), h('p', { class: 'small muted' }, 'Incluye intentos de compra rechazados (por saldo, límites o productos prohibidos).'), movTable(s.movements, { showUser: false, showChild: false }));
    } else if (tab === 'reglas') {
      const pr = s.prohibitions || { products: [], categories: [] };
      const list = (xs) => (xs.length ? h('ul', null, xs.map((x) => h('li', null, x.name))) : h('p', { class: 'muted' }, 'Ninguno'));
      put(body, h('div', { class: 'result small', style: { marginBottom: '12px' } }, '🔒 Solo el padre, madre o tutor puede configurar los límites de gasto y los productos prohibidos desde su app. Aquí solo se consultan.'),
        h('h2', null, 'Límites de gasto'), h('p', null, limitsText(s.limits)),
        h('h2', { style: { marginTop: '16px' } }, 'Categorías prohibidas'), list(pr.categories),
        h('h2', { style: { marginTop: '16px' } }, 'Productos prohibidos'), list(pr.products));
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
      const isAdmin = state.user.role === 'admin';
      const reload = () => go('hijo', { id: c.id, tab: 'tarjeta' });
      // Campo de UID: se escribe a mano o se pasa la tarjeta por un lector USB tipo teclado (termina con Enter)
      const uidField = (placeholder, onSubmit) => {
        const inp = h('input', { placeholder, autocomplete: 'off', 'data-uid-input': '', style: { fontSize: '1.15rem' } });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(inp.value); } });
        return inp;
      };
      let cardBox;
      if (isAdmin) {
        const msg = h('div', { role: 'status' });
        const fail = (e) => { msg.innerHTML = ''; msg.appendChild(h('div', { class: 'result err' }, e.message)); };
        if (!k) {
          const doAssign = async (uid) => {
            if (!String(uid || '').trim()) return;
            try { const r = await call('assignCardByUid', { uid, child_id: c.id }); toast(`Tarjeta ${r.uid} asignada a ${c.full_name}`, 'ok'); reload(); } catch (e) { fail(e); inp.select(); }
          };
          const inp = uidField('Pase la tarjeta o escriba el UID + Enter', doAssign);
          listenCardReader((uid) => { inp.value = uid; doAssign(uid); });
          setTimeout(() => inp.focus(), 60);
          cardBox = h('div', { class: 'form assign-card' }, h('div', { class: 'result small' }, '🪪 Este alumno no tiene tarjeta.'),
            field('Asignar tarjeta (UID)', inp), h('div', null, h('button', { class: 'btn primary', onclick: () => doAssign(inp.value) }, 'Asignar tarjeta')),
            h('p', { class: 'small muted' }, 'Con el cursor en el campo, pase la tarjeta por el lector USB (125 kHz o NFC): el número se escribe solo y se asigna al presionar Enter. También puede escribirlo a mano. Si la tarjeta es nueva se registra; si ya está asignada a otro alumno, se avisa.'), msg);
        } else {
          const replace = () => {
            const m = h('div', { role: 'status' });
            let close = null;
            const submit = async (uid) => {
              if (!String(uid || '').trim()) return;
              try { const r = await call('reportLostAndReplace', { card_id: k.id, new_uid: uid }); toast(`Tarjeta reemplazada. Saldo transferido: ${money(r.transferred_cents)}`, 'ok'); if (close) close(); reload(); } catch (e) { m.innerHTML = ''; m.appendChild(h('div', { class: 'result err' }, e.message)); }
            };
            const nu = uidField('Pase la tarjeta NUEVA por el lector o escriba su UID', submit);
            close = modal('Reemplazar tarjeta', h('div', { class: 'form' }, h('p', null, `La tarjeta ${k.uid} quedará como perdida (inutilizable) y su saldo de ${money(k.balance_cents)} pasará a la tarjeta nueva.`), field('Tarjeta nueva (UID)', nu), m),
              [{ label: 'Cancelar' }, { label: 'Reemplazar', class: 'primary', onClick: async () => { await submit(nu.value); return false; } }]);
            setTimeout(() => nu.focus(), 60);
          };
          const unassign = async () => {
            if (!(await confirmBox('Quitar tarjeta', `La tarjeta ${k.uid} se le quitará a ${c.full_name} y regresará al inventario.`))) return;
            try { await call('unassignCard', { card_id: k.id }); toast('Tarjeta quitada', 'ok'); reload(); } catch (e) { fail(e); }
          };
          cardBox = h('div', { class: 'form' }, h('div', null, 'UID: ', h('code', null, k.uid), ' ', badge(k.status)),
            h('div', { class: 'row acts-wrap', style: { gap: '8px', flexWrap: 'wrap' } },
              k.status === 'activa' ? h('button', { class: 'btn warn', onclick: async () => { if (await safe(() => call('setCardStatus', { card_id: k.id, status: 'bloqueada' }))) reload(); } }, '⛔ Bloquear')
                : h('button', { class: 'btn ok', onclick: async () => { if (await safe(() => call('setCardStatus', { card_id: k.id, status: 'activa' }))) reload(); } }, 'Desbloquear'),
              h('button', { class: 'btn', onclick: replace }, '🔁 Reemplazar tarjeta'),
              h('button', { class: 'btn danger', onclick: unassign }, 'Quitar tarjeta')),
            h('p', { class: 'small muted' }, 'Reemplazar: para tarjeta perdida o dañada (el saldo pasa a la nueva). Quitar: solo si la tarjeta tiene saldo $0; regresa al inventario.'), msg);
        }
      }
      put(body, h('div', { class: 'grid g2' },
        h('div', null, h('h2', null, 'Tarjeta'),
          cardBox || (k ? h('div', { class: 'form' }, h('div', null, 'UID: ', h('code', null, k.uid), ' ', badge(k.status)),
            k.status === 'activa' ? h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('Bloquear tarjeta', 'Mientras esté bloqueada no se podrá comprar con ella. Puede desbloquearla cuando quiera.')) { await safe(() => call('setCardStatus', { card_id: k.id, status: 'bloqueada' })); go('hijo', { id: c.id, tab: 'tarjeta' }); } } }, 'Bloquear temporalmente')
              : h('button', { class: 'btn ok', onclick: async () => { await safe(() => call('setCardStatus', { card_id: k.id, status: 'activa' })); go('hijo', { id: c.id, tab: 'tarjeta' }); } }, 'Desbloquear tarjeta'),
            h('p', { class: 'small muted' }, 'Si la tarjeta se perdió, bloquéela aquí y avise a la cooperativa para transferir el saldo a una tarjeta nueva.'))
            : h('p', { class: 'muted' }, 'Este alumno no tiene tarjeta vigente. Acuda a la cooperativa.'))),
        isTutor ? tutorProfile(c, prev, file, () => photo, (v) => { photo = v; setPrev(); }, await call('listChangeRequests', { child_id: c.id }))
          : h('div', null, h('h2', null, 'Personalizar'), h('div', { class: 'form' }, field('Nombre del alumno', name), field('Grado y grupo', grade),
            h('div', { class: 'row' }, prev, field('Foto (opcional)', file), h('button', { class: 'btn sm', onclick: () => { photo = null; setPrev(); } }, 'Quitar')),
            h('div', null, h('button', { class: 'btn primary', onclick: async () => { const r = await safe(() => call('updateChild', { id: c.id, full_name: name.value, grade: grade.value, photo })); if (r) { toast('Perfil actualizado', 'ok'); go('hijo', { id: c.id, tab: 'tarjeta' }); } } }, 'Guardar'))))));
    }
  };

  // ----- Tutor: perfil del alumno (nombre y grado solo lectura; foto editable; solicitudes de cambio) -----
  const CR_STATUS = { pendiente: ['Pendiente', 'warn'], aprobada: ['Aprobada', 'ok'], rechazada: ['Rechazada', 'err'] };
  const crBadge = (st) => { const [l, k] = CR_STATUS[st] || [st, '']; return h('span', { class: 'badge ' + k, 'data-cr-status': st }, l); };
  const crDetail = (r) => h('div', null, h('b', null, r.field_label), r.field !== 'otro' ? [': ', h('span', { class: 'muted' }, r.old_value || '—'), ' → ', h('b', null, r.new_value || '—')] : (r.new_value ? [': ', r.new_value] : null),
    r.comment ? h('div', { class: 'small muted' }, 'Motivo: ', r.comment) : null);
  function tutorProfile(c, prev, file, getPhoto, setPhoto, requests) {
    const reload = () => go('hijo', { id: c.id, tab: 'tarjeta' });
    const ro = (label, value) => h('label', null, label, h('input', { value: value || '', readonly: true, disabled: true, 'data-readonly': '' }));
    const ask = () => {
      const fld = h('select', null, h('option', { value: 'nombre' }, 'Nombre'), h('option', { value: 'grado' }, 'Grado y grupo'), h('option', { value: 'otro' }, 'Otro'));
      const val = h('input', { placeholder: 'Escriba el dato correcto' });
      const com = h('textarea', { rows: 3, placeholder: 'Ej. Está mal escrito el apellido / Cambió de grupo' });
      const cur = h('p', { class: 'small muted', style: { margin: 0 } });
      const upd = () => { cur.textContent = fld.value === 'nombre' ? `Dato actual: ${c.full_name}` : (fld.value === 'grado' ? `Dato actual: ${c.grade || '—'}` : 'Describa el dato y el cambio que necesita.'); val.placeholder = fld.value === 'otro' ? 'Dato nuevo (opcional)' : 'Escriba el dato correcto'; };
      fld.addEventListener('change', upd); upd();
      modal('Solicitar cambio de datos', h('div', { class: 'form', 'data-cr-form': '' }, h('p', { class: 'small muted' }, `La escuela revisará su solicitud para ${c.full_name}. Verá aquí si fue aprobada o rechazada.`),
        field('¿Qué dato?', fld), cur, field('Valor nuevo', val), field('Motivo o comentario', com)),
      [{ label: 'Cancelar' }, { label: 'Enviar solicitud', class: 'primary', onClick: async () => {
        const r = await safe(() => call('requestChildChange', { child_id: c.id, field: fld.value, new_value: val.value, comment: com.value }));
        if (!r) return false; toast('Solicitud enviada a la escuela', 'ok'); reload();
      } }]);
    };
    const savePhoto = async () => { const r = await safe(() => call('updateChild', { id: c.id, photo: getPhoto() })); if (r) { toast('Foto actualizada', 'ok'); reload(); } };
    return h('div', null, h('h2', null, 'Perfil'),
      h('div', { class: 'form' }, ro('Nombre del alumno', c.full_name), ro('Grado y grupo', c.grade),
        h('p', { class: 'small muted', style: { margin: 0 } }, '🔒 El nombre y el grado/grupo solo los cambia la escuela.'),
        h('div', null, h('button', { class: 'btn', 'data-cr-open': '', onclick: ask }, '✏️ Solicitar cambio de datos')),
        h('div', { class: 'row' }, prev, field('Foto (opcional)', file), h('button', { class: 'btn sm', onclick: () => setPhoto(null) }, 'Quitar')),
        h('div', null, h('button', { class: 'btn primary', onclick: savePhoto }, 'Guardar foto'))),
      h('h2', { style: { marginTop: '18px' } }, 'Mis solicitudes'),
      requests.length ? h('div', { class: 'cr-list' }, requests.map((r) => h('div', { class: 'card', style: { padding: '10px 12px', marginBottom: '8px' } },
        h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px' } }, crDetail(r), crBadge(r.status)),
        h('div', { class: 'small muted' }, 'Enviada: ', fmtDate(r.created_at), r.resolved_at ? ` · Respuesta: ${fmtDate(r.resolved_at)}` : ''),
        r.status === 'rechazada' && r.reject_reason ? h('div', { class: 'small' }, 'Motivo del rechazo: ', r.reject_reason) : null)))
        : h('p', { class: 'muted' }, 'No ha enviado solicitudes.'));
  }

  // ----- Escuela: notificaciones (solicitudes de los padres) -----
  VIEWS.notificaciones = async (main, params) => {
    const filter = params.f || 'pendiente';
    const rows = await call('listChangeRequests', filter === 'todas' ? {} : { status: filter });
    const notices = await call('listSchoolNotices').catch(() => []);
    await call('markChangeRequestsRead').catch(() => {});
    await call('markNoticesRead').catch(() => {});
    state.notifCount = 0; setNavCount('notificaciones', 0);
    const resolve = async (r, decision) => {
      if (decision === 'aprobar') {
        const what = r.field === 'otro' ? 'Se marcará como aprobada. Este tipo de cambio debe hacerlo usted a mano.' : `Se cambiará ${r.field === 'nombre' ? 'el nombre' : 'el grado y grupo'} de ${r.child_name}: "${r.old_value || '—'}" → "${r.new_value}".`;
        if (!(await confirmBox('Aprobar solicitud', what))) return;
        const x = await safe(() => call('resolveChangeRequest', { id: r.id, decision: 'aprobar' }));
        if (x) { toast(x.applied ? 'Aprobada: el cambio ya se aplicó' : 'Solicitud aprobada', 'ok'); render(); }
        return;
      }
      const why = h('textarea', { rows: 3, placeholder: 'Opcional: se le mostrará al tutor' });
      modal('Rechazar solicitud', h('div', { class: 'form' }, h('div', null, crDetail(r)), field('Motivo (opcional)', why)),
        [{ label: 'Cancelar' }, { label: 'Rechazar', class: 'danger', onClick: async () => {
          const x = await safe(() => call('resolveChangeRequest', { id: r.id, decision: 'rechazar', reason: why.value }));
          if (!x) return false; toast('Solicitud rechazada', 'ok'); render();
        } }]);
    };
    const tabs = h('div', { class: 'tabs' }, [['pendiente', 'Pendientes'], ['aprobada', 'Aprobadas'], ['rechazada', 'Rechazadas'], ['todas', 'Todas']]
      .map(([k, l]) => h('button', { class: 'btn' + (k === filter ? ' active' : ''), onclick: () => go('notificaciones', { f: k }) }, l)));
    const table = rows.length ? h('div', { class: 'card tablewrap' }, h('table', { class: 'cr-table' },
      h('thead', null, h('tr', null, ['Alumno', 'Tutor', 'Fecha', 'Detalle', 'Estado', ''].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((r) => h('tr', { 'data-cr': r.id, class: r.unread ? 'unread' : '' },
        h('td', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('hijo', { id: r.child_id, tab: 'tarjeta' }); } }, r.child_name || '—'), r.child_grade ? h('div', { class: 'small muted' }, r.child_grade) : null),
        h('td', null, r.tutor_name || '—', r.tutor_phone ? h('div', { class: 'small muted' }, r.tutor_phone) : null),
        h('td', null, fmtDate(r.created_at), r.unread ? h('div', null, badge('nueva', 'info')) : null),
        h('td', null, crDetail(r), r.status === 'rechazada' && r.reject_reason ? h('div', { class: 'small' }, 'Motivo del rechazo: ', r.reject_reason) : null),
        h('td', null, crBadge(r.status), r.resolved_at ? h('div', { class: 'small muted' }, fmtDate(r.resolved_at), r.resolved_by_name ? ' · ' + r.resolved_by_name : '') : null),
        h('td', { style: { whiteSpace: 'nowrap' } }, r.status === 'pendiente' ? [h('button', { class: 'btn sm ok', onclick: () => resolve(r, 'aprobar') }, '✔ Aprobar'), ' ', h('button', { class: 'btn sm danger', onclick: () => resolve(r, 'rechazar') }, '✖ Rechazar')] : null))))))
      : h('div', { class: 'card empty' }, filter === 'pendiente' ? 'No hay solicitudes pendientes.' : 'No hay solicitudes.');
    const recent = notices.slice(0, 20);
    const noticeBox = recent.length ? h('div', { class: 'card', style: { marginBottom: '16px' }, 'data-notices': '1' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('h2', { style: { margin: 0 } }, '📦 Avisos de inventario'),
      h('button', { class: 'btn sm', onclick: () => go('productos', { f: 'agotarse' }) }, 'Ver productos por agotarse')),
    h('div', { class: 'notice-list' }, recent.map((n) => h('div', { class: 'notice' + (n.unread ? ' unread' : ''), 'data-notice': n.id }, h('span', null, n.unread ? badge('nueva', 'info') : null, ' ', n.message), h('span', { class: 'small muted' }, fmtDate(n.created_at)))))) : null;
    put(main, pageHead('Notificaciones', 'Avisos de inventario y solicitudes de los padres para corregir datos de sus hijos. Al aprobar un cambio de nombre o de grado y grupo, se aplica automáticamente.'), noticeBox, h('h2', { class: 'section-title' }, 'Solicitudes de los padres'), tabs, table);
  };

  // ======================================================================
  // ----- Superadministrador (Zuki Company): instituciones -----
  // ======================================================================
  const SCHOOL_STATUS = { prueba: 'Prueba', activa: 'Activa', pausada: 'Pausada' };
  const schoolBadge = (s) => h('span', { class: 'badge ' + s }, SCHOOL_STATUS[s] || s);
  // ----- mensualidad (fechas AAAA-MM-DD, calendario de la Ciudad de México que calcula el servidor) -----
  const ymdUtc = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const ymdAdd = (s, n) => new Date(ymdUtc(s) + n * 86400000).toISOString().slice(0, 10);
  const ymdAddMonth = (s) => { const [y, m, d] = s.split('-').map(Number); const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10); };
  const ymdDiff = (a, b) => Math.round((ymdUtc(b) - ymdUtc(a)) / 86400000);
  function billingSummary(b) {
    if (!b) return { text: '—', cls: '' };
    if (b.stage === 'pausada') return { text: b.pause_reason === 'falta_pago' ? 'Pausada por falta de pago' : 'Pausada', cls: 'err' };
    if (b.stage === 'tolerancia') return { text: `Vencida el ${ddmmyyyy(b.period_end)} · tolerancia: ${b.grace_days_left === 1 ? 'queda 1 día' : `quedan ${b.grace_days_left} días`}`, cls: 'err' };
    if (b.stage === 'aviso') return { text: b.days_left === 0 ? `Vence hoy (${ddmmyyyy(b.period_end)})` : `Vence en ${diasTxt(b.days_left)} (${ddmmyyyy(b.period_end)})`, cls: 'warn' };
    if (b.days_left === null || b.days_left === undefined) return { text: 'Sin fecha', cls: '' };
    return { text: `Quedan ${diasTxt(b.days_left)} · hasta ${ddmmyyyy(b.period_end)}`, cls: 'ok' };
  }
  const billingCell = (b) => { const x = billingSummary(b); return h('span', { class: 'billtxt ' + x.cls }, x.text); };
  const needsAttention = (b) => !!b && (b.stage === 'aviso' || b.stage === 'tolerancia' || (b.stage === 'pausada' && b.pause_reason === 'falta_pago'));
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
  function respTable(headers, rows, rowClass, extraClass) {
    return h('table', { class: 'resp' + (extraClass ? ' ' + extraClass : '') }, h('tr', { class: 'head' }, headers.map((x) => h('th', { class: x.right ? 'right' : '' }, x.label))),
      rows.map((cells, r) => h('tr', { class: rowClass ? rowClass(r) || null : null }, cells.map((c, i) => h('td', { 'data-label': headers[i].label, class: headers[i].right ? 'right' : '' }, c)))));
  }
  const tempPassModal = (title, user, pass) => passShownModal(title, user, pass);
  function schoolForm(s) {
    const name = h('input', { value: s ? s.name : '', placeholder: 'p. ej. Colegio Juárez Morelia' });
    // El estado de una escuela existente se cambia en el recuadro "Mensualidad"; aquí solo al crearla
    const status = h('select', null, [['prueba', 'Prueba (30 días gratis)'], ['activa', 'Activa (1 mes pagado)']].map(([k, l]) => h('option', { value: k, selected: k === 'prueba' }, l)));
    const plan = h('textarea', { rows: 2, placeholder: 'p. ej. Plan anual $1,500 MXN/mes, pago el día 5' }); plan.value = s && s.plan_note ? s.plan_note : '';
    const cname = h('input', { value: s ? s.contact_name || '' : '' }); const cphone = h('input', { value: s ? s.contact_phone || '' : '', type: 'tel', placeholder: '10 dígitos' });
    const cemail = h('input', { value: s ? s.contact_email || '' : '', type: 'email' });
    const fields = { name, status, plan, cname, cphone, cemail };
    const el = h('div', { class: 'form' }, field('Nombre de la escuela', name), h('div', { class: 'grid g2' }, s ? null : field('Estado inicial', status), field('Contacto (director/a)', cname)),
      h('div', { class: 'grid g2' }, field('Teléfono de contacto', cphone), field('Correo de contacto', cemail)), field('Plan / cuota (nota interna)', plan));
    const data = () => ({ name: name.value, ...(s ? {} : { status: status.value }), plan_note: plan.value, contact_name: cname.value, contact_phone: cphone.value, contact_email: cemail.value });
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
    const stat = statCard;
    const sec = await superCall('securityOverview').catch(() => null);
    const q = h('input', { placeholder: 'Buscar escuela…', class: 'grow' });
    const fs = h('select', null, h('option', { value: '' }, 'Todos los estados'), Object.entries(SCHOOL_STATUS).map(([k, l]) => h('option', { value: k }, l)), h('option', { value: 'atencion' }, 'Por vencer, vencidas o pausadas'));
    const box = h('div');
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const list = o.schools.filter((s) => (!fs.value || (fs.value === 'atencion' ? needsAttention(s.billing) || s.status === 'pausada' : s.status === fs.value)) && (!term || s.name.toLowerCase().includes(term)));
      box.innerHTML = '';
      if (!list.length) { box.appendChild(h('div', { class: 'empty' }, 'Sin escuelas con ese filtro')); return; }
      box.appendChild(respTable([{ label: 'Escuela' }, { label: 'Estado' }, { label: 'Mensualidad' }, { label: 'Alumnos', right: true }, { label: 'Tarjetas activas', right: true }, { label: 'Ventas del mes', right: true }, { label: 'Última sincronización' }, { label: '' }],
        list.map((s) => [
          h('div', null, h('b', null, s.name), s.plan_note ? h('div', { class: 'small muted' }, s.plan_note) : null),
          schoolBadge(s.status), billingCell(s.billing), String(s.stats.students), String(s.stats.active_cards), money(s.stats.sales_month_cents),
          h('span', { class: s.stats.last_sync_at ? '' : 'muted' }, since(s.stats.last_sync_at), s.stats.devices ? h('span', { class: 'small muted' }, ` · ${s.stats.devices} caja(s)`) : null),
          h('button', { class: 'btn sm primary', onclick: () => go('institucion', { id: s.id }) }, 'Administrar'),
        ]), (i) => { const b = list[i].billing; return b && (b.stage === 'tolerancia' || b.stage === 'pausada') ? 'row-err' : (b && b.stage === 'aviso' ? 'row-warn' : ''); }));
    };
    const attention = o.schools.filter((s) => needsAttention(s.billing));
    q.addEventListener('input', draw); fs.addEventListener('change', draw);
    const P = sec && sec.persistence ? sec.persistence : {};
    put(main, pageHead('Escuelas', 'Todas las escuelas que usan la cooperativa. Toque “Administrar” para ver su personal, cajas y códigos.', h('button', { class: 'btn primary', onclick: newSchoolModal }, '+ Nueva escuela')),
      sec && sec.lockdown ? banner('red', '🚨', h('b', null, 'ALERTA ROJA ACTIVA. '), 'Todo está en solo lectura. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('seguridad'); } }, 'Ir a Seguridad')) : null,
      P.mode === 'temporal' ? banner('warn', '⚠️', h('b', null, 'Los datos son temporales. '), 'El servidor gratuito borra todo al reiniciarse. Antes de usarlo con una escuela real configure el guardado permanente (vea la guía, sección “Guardar los datos”).') : null,
      sec && sec.open_alerts ? banner('info', '🔔', `Tiene ${sec.open_alerts} alerta(s) sin revisar. `, h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('alertas'); } }, 'Ver alertas')) : null,
      attention.length ? banner('warn', '📅', h('div', null, h('b', null, `Mensualidades: ${attention.length} escuela(s) requieren atención`),
        h('ul', { class: 'attn' }, attention.map((s) => h('li', null, h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('institucion', { id: s.id }); } }, s.name), ' — ', billingSummary(s.billing).text))))) : null,
      h('div', { class: 'grid g4 stats' },
        stat('Escuelas', String(t.schools), `${t.schools_activa} activas · ${t.schools_prueba} en prueba · ${t.schools_pausada} pausadas`),
        stat('Alumnos', String(t.students), `${t.tutors_linked} padres vinculados`),
        stat('Tarjetas activas', String(t.active_cards), `de ${t.total_cards} registradas`),
        stat('Cajas vinculadas', String(t.devices)),
        stat('Ventas de hoy', money(t.sales_day_cents)),
        stat('Ventas del mes', money(t.sales_month_cents), 'Total histórico ' + money(t.sales_total_cents)),
        stat('Recargas del mes', money(t.recharges_month_cents), 'Total histórico ' + money(t.recharges_total_cents)),
        stat('Saldo en tarjetas', money(t.balance_cents), 'Dinero de alumnos (todas las escuelas)')),
      h('div', { class: 'card', style: { marginTop: '20px' } }, h('div', { class: 'row', style: { marginBottom: '12px' } }, q, fs), box));
    draw();
  };

  // Recuadro "Mensualidad" de una escuela: estado, periodo, días restantes, botones e historial de pagos
  function billingCard(s, payments) {
    const b = s.billing || {}; const today = b.today; const sum = billingSummary(b);
    const paused = s.status === 'pausada';
    const pay = () => {
      const date = h('input', { type: 'date', value: today }); const amt = h('input', { inputmode: 'decimal', placeholder: 'Opcional, p. ej. 1500' });
      const note = h('input', { placeholder: 'Opcional, p. ej. Transferencia BBVA, recibo 123' });
      const fresh = paused || !s.period_end || ymdDiff(today, s.period_end) < -2;
      const newEnd = fresh ? ymdAddMonth(today) : ymdAddMonth(s.period_end);
      modal('Registrar pago / renovar', h('div', { class: 'form' },
        h('p', { style: { margin: 0 } }, 'Escuela: ', h('b', null, s.name)),
        h('div', { class: 'grid g2' }, field('Fecha de pago', date), field('Monto (pesos)', amt)), field('Nota', note),
        h('div', { class: 'banner ok small' }, h('span', { class: 'ico' }, '📅'), h('div', null, 'Se agrega 1 mes. Nuevo fin del periodo: ', h('b', null, ddmmyyyy(newEnd)),
          fresh ? h('div', { class: 'small' }, paused ? 'La escuela estaba pausada: se reactiva y el mes empieza hoy.' : 'El periodo anterior ya había terminado: el mes empieza hoy.') : null,
          s.status !== 'activa' && !paused ? h('div', { class: 'small' }, 'La escuela pasará de Prueba a Activa.') : null))),
      [{ label: 'Cancelar' }, { label: 'Registrar pago', class: 'primary', onClick: async () => {
        try {
          const r = await superCall('registerPayment', { school_id: s.id, paid_at: date.value || undefined, amount_cents: amt.value.trim() ? toCents(amt.value) : undefined, note: note.value.trim() || undefined });
          toast(`Pago registrado. Nuevo fin: ${ddmmyyyy(r.period_end)}${r.reactivated ? ' · escuela reactivada' : ''}`, 'ok'); render();
        } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const pauseNow = async () => {
      if (!(await confirmBox('Pausar ahora', `Nadie de "${s.name}" (administrador, cajeros y padres) podrá entrar, se cerrarán sus sesiones y su caja dejará de cobrar al sincronizar. Los datos se conservan y puede reactivarla cuando quiera. ¿Pausar?`))) return;
      const r = await safe(() => superCall('pauseSchool', { school_id: s.id }));
      if (r) { toast(`Escuela pausada. Sesiones cerradas: ${r.sessions_closed}`, 'ok'); render(); }
    };
    const reactivate = () => {
      const st = h('select', null, h('option', { value: 'activa', selected: payments.length > 0 }, 'Activa'), h('option', { value: 'prueba', selected: !payments.length }, 'Prueba'));
      const end = h('input', { type: 'date', value: s.period_end && s.period_end >= today ? s.period_end : ymdAdd(today, 7), min: today });
      modal('Reactivar escuela', h('div', { class: 'form' },
        h('p', { style: { margin: 0 } }, `Las cuentas de "${s.name}" podrán volver a entrar de inmediato.`),
        h('div', { class: 'grid g2' }, field('Estado', st), field('Fecha fin del periodo', end, 'Hasta qué día tiene servicio.')),
        h('p', { class: 'small muted', style: { margin: 0 } }, 'Si ya pagó, mejor use “Registrar pago / renovar”: reactiva y deja el pago en el historial.')),
      [{ label: 'Cancelar' }, { label: 'Reactivar', class: 'ok', onClick: async () => {
        try { await superCall('reactivateSchool', { school_id: s.id, status: st.value, period_end: end.value }); toast('Escuela reactivada', 'ok'); render(); } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const dates = () => {
      const st = h('select', null, h('option', { value: 'prueba', selected: s.status === 'prueba' }, 'Prueba'), h('option', { value: 'activa', selected: s.status === 'activa' }, 'Activa'));
      const ini = h('input', { type: 'date', value: s.period_start || today }); const fin = h('input', { type: 'date', value: s.period_end || ymdAdd(today, 30) });
      modal('Cambiar estado y fechas', h('div', { class: 'form' }, field('Estado', st), h('div', { class: 'grid g2' }, field('Fecha inicio', ini), field('Fecha fin del periodo', fin)),
        h('p', { class: 'small muted', style: { margin: 0 } }, 'Útil para alargar una prueba o corregir fechas. Para registrar un pago use “Registrar pago / renovar”.')),
      [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
        try { await superCall('setBillingPeriod', { school_id: s.id, status: st.value, period_start: ini.value, period_end: fin.value }); toast('Periodo actualizado', 'ok'); render(); } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const payRows = payments.map((p) => [ddmmyyyy(p.paid_at), p.amount_cents ? money(p.amount_cents) : h('span', { class: 'muted' }, '—'), `${ddmmyyyy(p.period_start)} al ${ddmmyyyy(p.period_end)}`, p.note || h('span', { class: 'muted' }, '—'), p.created_by || '—']);
    return h('div', { class: 'card billing-card ' + (sum.cls || ''), style: { marginBottom: '18px' } },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: { margin: 0 } }, '📅 Mensualidad'), schoolBadge(s.status)),
      h('div', { class: 'grid g3 billing-kv' },
        h('div', null, h('div', { class: 'l' }, 'Estado'), h('div', { class: 'v' }, SCHOOL_STATUS[s.status] || s.status)),
        h('div', null, h('div', { class: 'l' }, paused ? 'Pausada desde' : 'Periodo'), h('div', { class: 'v' }, paused ? fmtDate(s.paused_at) : `${ddmmyyyy(s.period_start)} al ${ddmmyyyy(s.period_end)}`)),
        h('div', null, h('div', { class: 'l' }, paused ? 'Motivo' : 'Días restantes'), h('div', { class: 'v' }, paused ? (s.pause_reason === 'falta_pago' ? 'Falta de pago (automática)' : 'Pausada a mano') : billingCell(b)))),
      b.stage === 'tolerancia' ? h('div', { class: 'small', style: { color: 'var(--err)', fontWeight: 600, marginTop: '10px' } }, `Si no se registra el pago, se pausará automáticamente el ${ddmmyyyy(b.pause_on)}.`) : null,
      h('div', { class: 'row', style: { marginTop: '16px' } },
        h('button', { class: 'btn primary', onclick: pay }, '💵 Registrar pago / renovar'),
        paused ? h('button', { class: 'btn ok', onclick: reactivate }, '▶️ Reactivar') : h('button', { class: 'btn danger', onclick: pauseNow }, '⏸️ Pausar ahora'),
        paused ? null : h('button', { class: 'btn', onclick: dates }, '✏️ Cambiar estado o fechas')),
      h('h3', { style: { marginTop: '22px' } }, 'Historial de pagos'),
      payRows.length ? respTable([{ label: 'Fecha de pago' }, { label: 'Monto' }, { label: 'Periodo cubierto' }, { label: 'Nota' }, { label: 'Registró' }], payRows)
        : h('div', { class: 'empty', style: { padding: '16px' } }, 'Aún no hay pagos registrados.'));
  }

  VIEWS.institucion = async (main, params) => {
    const d = await superCall('schoolDetail', { id: params.id });
    const s = d.school; const st = s.stats;
    const stat = statCard;
    const edit = () => {
      const f = schoolForm(s);
      modal('Editar escuela', f.el, [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
        try { await superCall('updateSchool', { id: s.id, ...f.data() }); toast('Escuela actualizada', 'ok'); render(); } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const billCard = billingCard(s, d.payments || []);
    const newStaff = () => {
      const role = h('select', null, h('option', { value: 'admin' }, 'Administrador'), h('option', { value: 'cajero' }, 'Cajero'));
      const u = h('input', { autocomplete: 'off' }); const n = h('input'); const e = h('input', { type: 'email', placeholder: 'Opcional' });
      modal('Nuevo usuario de la escuela', h('div', { class: 'form' }, field('Rol', role), field('Usuario para entrar', u), field('Nombre completo', n), field('Correo', e)),
        [{ label: 'Cancelar' }, { label: 'Crear', class: 'primary', onClick: async () => {
          try { const r = await superCall('createStaff', { school_id: s.id, role: role.value, username: u.value, full_name: n.value, email: e.value || undefined }); tempPassModal('Usuario creado', r.user, r.temporary_password); } catch (er) { toast(er.message, 'err'); return false; }
        } }]);
    };
    const resetPass = (u) => setPasswordModal(u);
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
      u.active ? badge('activo', 'ok') : badge('inactivo', ''),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px' } }, h('button', { class: 'btn sm', onclick: () => resetPass(u) }, '🔑 Contraseña'),
        h('button', { class: 'btn sm', onclick: async () => { if (await safe(() => superCall('setStaffActive', { user_id: u.id, active: !u.active }))) render(); } }, u.active ? 'Desactivar' : 'Activar'))]);
    const devRows = d.devices.map((x) => [h('div', null, h('b', null, x.name), x.primary ? [' ', badge('principal', 'ok')] : null, h('div', { class: 'small muted' }, h('code', null, x.id.slice(0, 8) + '…'))),
      x.revoked ? badge('revocado', 'err') : badge('autorizado', 'ok'), since(x.last_seen_at),
      x.revoked ? '' : h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px' } },
        x.primary ? null : h('button', { class: 'btn sm', onclick: async () => { if (await safe(() => superCall('setPrimaryDevice', { school_id: s.id, device_id: x.id }))) { toast('Equipo principal actualizado', 'ok'); render(); } } }, 'Hacer principal'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (!(await confirmBox('Revocar equipo', `"${x.name}" dejará de sincronizar hasta que se vuelva a vincular. ¿Revocar?`))) return; if (await safe(() => superCall('revokeDevice', { school_id: s.id, device_id: x.id }))) { toast('Equipo revocado', 'ok'); render(); } } }, 'Revocar'))]);
    const invRows = d.invitations.slice(0, 30).map((i) => [i.child_name, h('code', null, i.code), badge(i.status, i.status === 'usado' ? 'ok' : (i.status === 'vencido' ? 'err' : 'warn')), i.used_by_name || '—', fmtDate(i.expires_at)]);
    put(main,
      h('div', { style: { marginBottom: '10px' } }, h('button', { class: 'btn ghost', onclick: () => go('instituciones') }, '← Volver a escuelas')),
      pageHead(s.name, [s.contact_name, s.contact_phone, s.contact_email].filter(Boolean).join(' · ') || 'Datos de la escuela', schoolBadge(s.status)),
      h('div', { class: 'row', style: { marginBottom: '18px', flexWrap: 'wrap' } }, h('button', { class: 'btn', onclick: edit }, '✏️ Editar datos y plan'), h('button', { class: 'btn', onclick: () => go('seguridad') }, '🛡️ Seguridad de esta escuela'), h('button', { class: 'btn', onclick: () => schoolKidsModal(s) }, '🧒 Alumnos y papás'), h('button', { class: 'btn', onclick: () => go('papelera', { school_id: s.id }) }, '🗑️ Papelera')),
      billCard,
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

  // Alumnos de una escuela (superadministrador): dar de baja alumnos y papás/tutores
  async function schoolKidsModal(s) {
    const q = h('input', { placeholder: 'Buscar alumno o papá/tutor' });
    const box = h('div', { class: 'tablewrap', style: { maxHeight: '60vh', overflow: 'auto' } });
    let kids = [];
    const reload = async () => { kids = await safe(() => superCall('listChildren', { school_id: s.id })) || []; draw(); };
    const draw = () => {
      const t = q.value.trim().toLowerCase();
      const list = kids.filter((k) => !t || (k.full_name + ' ' + (k.tutor_name || '')).toLowerCase().includes(t));
      box.innerHTML = '';
      box.appendChild(list.length ? h('table', null, h('tr', null, h('th', null, 'Alumno'), h('th', null, 'Papá/tutor'), h('th', null, 'Tarjeta'), h('th', null, '')),
        list.map((k) => h('tr', null, h('td', null, h('b', null, k.full_name), h('div', { class: 'small muted' }, k.grade || '')),
          h('td', null, k.tutor_name || '—', k.tutor_id ? h('div', null, h('button', { class: 'btn sm danger', onclick: async () => { const acc = await safe(() => superCall('getAccount', { user_id: k.tutor_id })); if (acc) deleteTutorFlow(acc, superCall, reload); } }, 'Eliminar papá/tutor')) : null),
          h('td', null, k.card_uid ? h('code', null, k.card_uid) : '—'),
          h('td', { class: 'right' }, h('button', { class: 'btn sm danger', onclick: () => deleteChildFlow(k, superCall, reload) }, 'Eliminar alumno'))))) : h('div', { class: 'empty' }, 'Sin alumnos'));
    };
    q.addEventListener('input', draw);
    modal('Alumnos y papás — ' + s.name, h('div', { class: 'form' }, q, box), [{ label: 'Cerrar', onClick: () => render() }]);
    const ms = document.querySelectorAll('.modal-bg .modal'); if (ms.length) ms[ms.length - 1].classList.add('wide');
    await reload();
  }

  // ----- Hoja imprimible de códigos de activación para padres -----
  const SHEET_CSS = `.codesheet{font-family:"Segoe UI",Arial,sans-serif;color:#1e2533}
.codesheet .sh-head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #0b7f86;padding-bottom:6px;margin-bottom:10px}
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
        h('div', { class: 'sh-school' }, school || 'Zuki Pay'), h('div', { class: 'sh-name' }, r.child_name), h('div', null, [r.grade, r.card_uid ? 'Tarjeta ' + r.card_uid : null].filter(Boolean).join(' · ')),
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
    const bgs = document.querySelectorAll('.modal-bg .modal'); if (bgs.length) bgs[bgs.length - 1].classList.add('wide');
    return close;
  }

  // ----- Programar tarjetas (escritorio): lectura en lote, asignación y hoja de códigos -----
  const prog = { session: [] }; // tarjetas leídas en esta sesión (persisten al cambiar de pestaña)
  VIEWS.programar = async (main, params) => {
    const tab = params.tab || 'leer';
    const tabs = h('div', { class: 'tabs' }, [['leer', '1. Leer tarjetas'], ['asignar', '2. Asignar a alumnos'], ['codigos', '3. Hoja de códigos para padres']]
      .map(([k, l]) => h('button', { class: 'btn' + (k === tab ? ' active' : ''), onclick: () => go('programar', { tab: k }) }, l)));
    put(main, pageHead('Programar tarjetas', 'Tres pasos: leer las tarjetas nuevas, asignarlas a los alumnos e imprimir los códigos para los padres.'), tabs);
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
      const st = WEB ? { linked: true, school_name: state.user.school_name } : await window.coop.sync.status();
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
        if (WEB) {
          const r = await window.coop.auth.invitationSheet({ child_ids: sel.map((c) => c.id), include_linked: incl.checked });
          if (!r.ok) toast('No se obtuvieron códigos: ' + r.error, 'err'); else { codes = r.data.codes; url = location.origin; school = r.data.school_name || school; }
        } else if (st.linked) {
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
          h('ol', { class: 'small', style: { lineHeight: 1.6 } }, h('li', null, 'Se pide al servidor un código por alumno (si ya existe uno vigente, se reutiliza).'),
            h('li', null, 'Se arma una hoja con un recuadro por alumno: nombre, grado, tarjeta y su código.'), h('li', null, 'Imprima, recorte y entregue cada recuadro al padre/tutor junto con la tarjeta.'),
            h('li', null, 'El padre entra a la app web, toca "Tengo un código de invitación" y queda vinculado.')),
          WEB ? h('div', { class: 'result ok small' }, 'Los códigos se generan en el servidor.') : st.linked ? h('div', { class: 'result ok small' }, `Caja vinculada a ${st.school_name || 'el servidor'}: los códigos se generan en el servidor.`)
            : h('div', { class: 'result err small' }, 'Esta caja no está vinculada al servidor: la hoja saldrá sin códigos. Vincúlela en Ajustes → Servidor en la nube.'))));
      draw();
    }
  };

  // ======================================================================
  // ----- Superadministrador: Cuentas -----
  // ======================================================================
  const ROLE_ORDER_LABEL = { superadmin: 'Superadministrador', admin: 'Administrador de escuela', cajero: 'Cajero', tutor: 'Padre / tutor' };
  function accountState(u) {
    if (!u.active) return badge('desactivada', 'err');
    if (u.locked) return badge('bloqueada por intentos', 'warn');
    if (u.role !== 'superadmin' && u.school_status === 'pausada') return h('span', { title: 'La escuela está pausada (mensualidad): esta cuenta no puede entrar' }, badge('escuela pausada', 'err'));
    return badge('activa', 'ok');
  }
  function setPasswordModal(u) {
    const own = h('input', { type: 'text', placeholder: 'Déjelo vacío para generar una automática', autocomplete: 'off' });
    modal('Asignar contraseña nueva', h('div', { class: 'form' },
      h('p', null, 'Cuenta: ', h('b', null, u.full_name), ` (${u.username})`),
      h('p', { class: 'small muted' }, 'Las contraseñas están cifradas y nadie puede verlas, ni siquiera usted. Aquí puede asignar una nueva: la persona deberá usarla para entrar y se cerrarán sus sesiones abiertas.'),
      field('Contraseña nueva (opcional)', own, 'Mínimo 8 caracteres. Si la deja vacía se crea una segura de 12 caracteres.')),
    [{ label: 'Cancelar' }, { label: 'Asignar contraseña', class: 'primary', onClick: async () => {
      try { const r = await superCall('setPassword', { user_id: u.id, password: own.value.trim() || undefined }); passShownModal('Contraseña asignada', r.user, r.password); } catch (e) { toast(e.message, 'err'); return false; }
    } }]);
  }
  // Editar cualquier cuenta (superadministrador): datos, jerarquía, escuela y alumnos del padre/tutor
  async function editAccountModal(u0, schools, onDone) {
    let acc;
    try { acc = await superCall('getAccount', { user_id: u0.id }); } catch (e) { return toast(e.message, 'err'); }
    const prot = acc.protected;
    const name = h('input', { value: acc.full_name || '' });
    const user = h('input', { value: acc.username || '', disabled: prot, autocomplete: 'off' });
    const email = h('input', { value: acc.email || '', type: 'email' });
    const phone = h('input', { value: acc.phone || '', type: 'tel', placeholder: '10 dígitos' });
    const role = h('select', { disabled: prot }, (prot ? [['superadmin', 'Superadministrador']] : [['admin', 'Administrador'], ['cajero', 'Cajero'], ['tutor', 'Padre / tutor']])
      .map(([k, l]) => h('option', { value: k, selected: k === acc.role }, l)));
    const school = h('select', { disabled: prot }, h('option', { value: '' }, prot ? 'Toda la plataforma' : '— sin escuela —'), schools.map((s) => h('option', { value: s.id, selected: s.id === acc.school_id }, s.name)));
    let kids = acc.children.map((c) => ({ ...c }));
    const kidsBox = h('div'); const kidsWrap = h('div', { class: 'card', style: { padding: '12px', marginTop: '6px' } });
    const search = h('input', { placeholder: 'Buscar alumno por nombre para vincular', style: { width: '100%' } });
    const results = h('div', { class: 'checks', style: { maxHeight: '180px' } });
    const drawKids = () => {
      kidsBox.innerHTML = '';
      put(kidsBox, kids.length ? kids.map((c) => h('div', { class: 'row', style: { justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)' } },
        h('span', null, h('b', null, c.full_name), h('span', { class: 'small muted' }, ` · ${c.grade || ''} · ${c.school_name || ''}`)),
        h('button', { class: 'btn sm danger', type: 'button', onclick: () => { kids = kids.filter((x) => x.id !== c.id); drawKids(); } }, 'Quitar')))
        : h('div', { class: 'muted small' }, 'Sin alumnos vinculados'));
    };
    let st;
    const doSearch = async () => {
      results.innerHTML = '';
      const q = search.value.trim(); if (q.length < 2) return;
      const list = await superCall('searchChildren', { q }).catch(() => []); // todas las escuelas (un padre puede tener hijos en varias)
      put(results, list.filter((c) => !kids.some((k) => k.id === c.id)).slice(0, 40).map((c) => h('div', { class: 'row', style: { justifyContent: 'space-between', padding: '3px 0' } },
        h('span', null, c.full_name, h('span', { class: 'small muted' }, ` · ${c.grade || ''} · ${c.school_name || ''}${c.tutor_name ? ' · tutor actual: ' + c.tutor_name : ''}`)),
        h('button', { class: 'btn sm', type: 'button', onclick: () => { kids.push(c); drawKids(); doSearch(); } }, 'Vincular'))));
      if (!results.children.length) results.appendChild(h('div', { class: 'muted small' }, 'Sin resultados'));
    };
    search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(doSearch, 250); });
    put(kidsWrap, h('b', null, 'Alumnos vinculados (hijos)'), kidsBox, h('div', { style: { marginTop: '8px' } }, search), results);
    const syncRole = () => { kidsWrap.style.display = role.value === 'tutor' ? '' : 'none'; };
    role.addEventListener('change', syncRole);
    drawKids(); syncRole();
    modal('Editar cuenta', h('div', { class: 'form' },
      prot ? banner('info', '🛡️', 'Cuenta protegida del superadministrador: solo se pueden cambiar nombre, correo y teléfono.') : null,
      field('Nombre completo', name), h('div', { class: 'grid g2' }, field('Usuario (para entrar)', user), field('Jerarquía', role)),
      h('div', { class: 'grid g2' }, field('Correo', email), field('Teléfono', phone)), field('Escuela', school), prot ? null : kidsWrap,
      h('p', { class: 'small muted' }, 'Si cambia el usuario, la jerarquía o la escuela, la persona deberá volver a entrar. Todo cambio queda en la bitácora.')),
    [{ label: 'Cancelar' }, { label: 'Guardar cambios', class: 'primary', onClick: async () => {
      const data = { user_id: acc.id, full_name: name.value, email: email.value.trim() || null, phone: phone.value.trim() || null };
      if (!prot) Object.assign(data, { username: user.value.trim(), role: role.value, school_id: school.value ? Number(school.value) : null, child_ids: role.value === 'tutor' ? kids.map((k) => k.id) : [] });
      try { await superCall('updateAccount', data); toast('Cuenta actualizada', 'ok'); if (onDone) onDone(); } catch (e) { toast(e.message, 'err'); return false; }
    } }]);
    const bgs = document.querySelectorAll('.modal-bg .modal'); if (bgs.length) bgs[bgs.length - 1].classList.add('wide');
  }

  VIEWS.cuentas = async (main) => {
    const o = await superCall('overview');
    const q = h('input', { placeholder: 'Nombre, usuario, correo o teléfono' });
    const role = h('select', null, h('option', { value: '' }, 'Todas'), ['superadmin', 'admin', 'cajero', 'tutor'].map((r) => h('option', { value: r }, ROLE_ORDER_LABEL[r])));
    const school = h('select', null, h('option', { value: '' }, 'Todas'), o.schools.map((s) => h('option', { value: s.id }, s.name + (s.status === 'pausada' ? ' (pausada)' : ''))));
    const status = h('select', null, h('option', { value: '' }, 'Todas'), h('option', { value: 'activas' }, 'Activas'), h('option', { value: 'bloqueadas' }, 'Desactivadas o bloqueadas'));
    const pausedSchools = o.schools.filter((s) => s.status === 'pausada');
    const box = h('div', { class: 'card tablewrap' });
    const load = async () => {
      const list = await superCall('listAccounts', { q: q.value.trim() || undefined, role: role.value || undefined, school_id: school.value || undefined, status: status.value || undefined });
      box.innerHTML = '';
      box.appendChild(h('div', { class: 'small muted', style: { marginBottom: '8px' } }, `${list.length} cuenta(s)`));
      if (!list.length) { box.appendChild(h('div', { class: 'empty' }, 'No hay cuentas con ese filtro')); return; }
      box.appendChild(respTable([{ label: 'Persona' }, { label: 'Jerarquía' }, { label: 'Escuela' }, { label: 'Estado' }, { label: 'Último acceso' }, { label: 'Creada' }, { label: '', right: true }],
        list.map((u) => [
          h('div', null, h('b', null, u.full_name), h('div', { class: 'small muted' }, u.username, u.email ? ' · ' + u.email : '', u.phone ? ' · ' + u.phone : '')),
          h('span', null, ROLE_ORDER_LABEL[u.role] || u.role),
          (u.school_name && u.school_name.replace(/,(?! )/g, ', ')) || h('span', { class: 'muted' }, u.role === 'superadmin' ? 'Toda la plataforma' : '—'),
          accountState(u),
          h('span', { title: u.last_login_ip || '' }, since(u.last_login_at)),
          fmtDate(u.created_at),
          h('div', { class: 'row acts-wrap', style: { justifyContent: 'flex-end', gap: '6px' } },
            h('button', { class: 'btn sm primary', onclick: () => editAccountModal(u, o.schools, load) }, '✏️ Editar'),
            u.role === 'superadmin' ? h('span', { class: 'small muted' }, 'Protegida') : [
              h('button', { class: 'btn sm', onclick: () => setPasswordModal(u) }, '🔑 Contraseña'),
              u.locked ? h('button', { class: 'btn sm', onclick: async () => { if (await safe(() => superCall('unlockAccount', { user_id: u.id }))) { toast('Cuenta desbloqueada', 'ok'); load(); } } }, 'Desbloquear') : null,
              h('button', { class: 'btn sm ' + (u.active ? 'danger' : 'ok'), onclick: async () => {
                if (u.active && !(await confirmBox('Desactivar cuenta', `${u.full_name} ya no podrá entrar y se cerrarán sus sesiones. Puede reactivarla cuando quiera. ¿Desactivar?`))) return;
                if (await safe(() => superCall('setAccountActive', { user_id: u.id, active: !u.active }))) { toast(u.active ? 'Cuenta desactivada' : 'Cuenta activada', 'ok'); load(); }
              } }, u.active ? 'Desactivar' : 'Activar'),
              u.role === 'tutor' ? h('button', { class: 'btn sm danger', onclick: async () => { let acc; try { acc = await superCall('getAccount', { user_id: u.id }); } catch (e) { return toast(e.message, 'err'); } deleteTutorFlow(acc, superCall, load); } }, 'Eliminar papá/tutor') : null,
            ]),
        ]), null, 'resp-md'));
    };
    let t; q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 300); });
    [role, school, status].forEach((x) => x.addEventListener('change', load));
    put(main, pageHead('Cuentas', 'Todas las personas que pueden entrar al sistema, de todas las escuelas. Solo usted puede cambiar contraseñas.'),
      banner('info', '🔑', 'Por seguridad las contraseñas se guardan cifradas y no se pueden ver. Use ', h('b', null, '“Contraseña”'), ' para asignar una nueva: se mostrará una sola vez para que la copie y se la entregue a la persona.'),
      pausedSchools.length ? banner('err', '⏸️', h('div', null, h('b', null, 'Escuelas pausadas por mensualidad: '), pausedSchools.map((s, i) => [i ? ', ' : '', h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('institucion', { id: s.id }); } }, s.name)]),
        h('div', { class: 'small' }, 'Sus cuentas (administrador, cajeros y padres) no pueden entrar hasta que la reactive.'))) : null,
      h('div', { class: 'card filters' }, field('Buscar', q), field('Jerarquía', role), field('Escuela', school), field('Estado', status)), box);
    await load();
  };

  // ======================================================================
  // ----- Superadministrador: Seguridad y emergencia -----
  // ======================================================================
  const pesos = (c) => (c ? (c / 100).toFixed(0) : '');
  const toCents = (v) => { const s = String(v || '').replace(/[$,\s]/g, ''); if (!s) return null; const n = Math.round(Number(s) * 100); if (!Number.isFinite(n) || n <= 0) throw new Error('Monto inválido'); return n; };
  function switchRow(title, desc, on, onToggle, danger) {
    const b = h('button', { class: 'btn ' + (on ? 'ok' : (danger ? 'warn' : '')), onclick: onToggle }, on ? 'Quitar' : 'Activar');
    return h('div', { class: 'switchrow' }, h('div', { class: 'grow' }, h('b', null, title), h('div', { class: 'small muted' }, desc)),
      h('span', { class: on ? 'state-on' : 'state-off' }, on ? 'ACTIVO' : 'Apagado'), b);
  }
  function lockdownModal() {
    const inp = h('input', { placeholder: 'Escriba: ALERTA ROJA', autocomplete: 'off', style: { fontSize: '1.2rem' } });
    modal('🚨 Activar ALERTA ROJA', h('div', { class: 'form' },
      banner('red', '🚨', h('b', null, 'Esto detiene todo el sistema de inmediato:'),
        h('ul', null, h('li', null, 'Todas las escuelas quedan en SOLO LECTURA (no se puede cobrar, recargar ni modificar nada).'),
          h('li', null, 'Se cierran las sesiones de todos (directores, cajeros y padres).'),
          h('li', null, 'Nadie puede entrar excepto usted (superadministrador).'))),
      h('p', null, 'Úselo si sospecha un robo de contraseñas o recargas falsas. Para confirmar escriba ', h('b', null, 'ALERTA ROJA'), ':'), inp),
    [{ label: 'Cancelar' }, { label: 'ACTIVAR ALERTA ROJA', class: 'danger', onClick: async () => {
      if (inp.value.trim().toUpperCase() !== 'ALERTA ROJA') { toast('Escriba exactamente ALERTA ROJA para confirmar', 'err'); return false; }
      try { const r = await superCall('lockdown', { confirm: inp.value.trim().toUpperCase() }); toast(`Alerta roja activa. Sesiones cerradas: ${r.sessions_closed}`, 'ok'); render(); } catch (e) { toast(e.message, 'err'); return false; }
    } }]);
  }
  function schoolLimitsModal(s) {
    const f = s.flags;
    const lim = h('input', { value: pesos(f.daily_recharge_limit_cents), placeholder: 'Sin límite', inputmode: 'decimal' });
    const big = h('input', { value: pesos(f.large_recharge_cents), inputmode: 'decimal' });
    const hs = h('input', { type: 'time', value: f.hours_start }); const he = h('input', { type: 'time', value: f.hours_end });
    modal('Límites de ' + s.name, h('div', { class: 'form' },
      field('Límite de recargas por día (pesos, toda la escuela)', lim, 'Al llegar a este total ya no se aceptan más recargas ese día. Vacío = sin límite.'),
      field('Avisarme si una sola recarga es mayor a (pesos)', big),
      h('div', { class: 'grid g2' }, field('Horario escolar: desde', hs), field('hasta', he)),
      h('p', { class: 'small muted' }, 'Las recargas fuera de este horario o en fin de semana generan una alerta (no se bloquean).')),
    [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
      try {
        await superCall('setSchoolSecurity', { school_id: s.id, daily_recharge_limit_cents: lim.value.trim() ? toCents(lim.value) : null, large_recharge_cents: big.value.trim() ? toCents(big.value) : null, hours_start: hs.value || null, hours_end: he.value || null });
        toast('Límites guardados', 'ok'); render();
      } catch (e) { toast(e.message, 'err'); return false; }
    } }]);
  }
  VIEWS.seguridad = async (main) => {
    const o = await superCall('securityOverview');
    const set = async (s, k, v, msg) => { if (await safe(() => superCall('setSchoolSecurity', { school_id: s.id, [k]: v }))) { toast(msg, 'ok'); render(); } };
    const ask = async (title, txt, fn) => { if (await confirmBox(title, txt)) fn(); };
    const P = o.persistence || {};
    put(main, pageHead('Seguridad y emergencia', 'Botones para detener problemas rápido. Todo lo que haga aquí queda registrado en la Bitácora.'),
      o.lockdown ? h('div', { class: 'redzone' }, h('h2', null, '🚨 ALERTA ROJA ACTIVA'),
        h('p', null, `Desde ${fmtDate(o.lockdown_at)} por ${o.lockdown_by || '—'}. Todo está en solo lectura y solo usted puede entrar.`),
        h('button', { class: 'btn ok lg', onclick: () => ask('Quitar alerta roja', 'El sistema volverá a funcionar normal y las personas podrán entrar de nuevo (tendrán que iniciar sesión otra vez). ¿Desbloquear?', async () => { if (await safe(() => superCall('unlock'))) { toast('Sistema desbloqueado', 'ok'); render(); } }) }, '🔓 Desbloquear el sistema'))
        : h('div', { class: 'redzone' }, h('div', { class: 'grow' }, h('h2', null, 'Botón de emergencia'),
          h('p', null, 'Si cree que alguien robó una contraseña o está haciendo recargas falsas, presione el botón rojo: todo se congela y solo usted puede entrar.')),
        h('button', { class: 'redbtn', onclick: lockdownModal }, '🚨 ALERTA ROJA')),
      o.open_alerts ? banner('warn', '🔔', h('b', null, `Hay ${o.open_alerts} alerta(s) sin revisar. `), h('a', { href: '#', onclick: (e) => { e.preventDefault(); go('alertas'); } }, 'Ver alertas')) : null,
      h('h2', { class: 'section-title' }, 'Toda la plataforma'),
      h('div', { class: 'card' },
        switchRow('Congelar TODAS las recargas', 'Ninguna escuela podrá registrar recargas hasta que lo quite. Las ventas siguen funcionando.', o.freeze_recharges_global,
          () => ask(o.freeze_recharges_global ? 'Reanudar recargas' : 'Congelar recargas', o.freeze_recharges_global ? '¿Permitir de nuevo las recargas en todas las escuelas?' : '¿Congelar las recargas en TODAS las escuelas?', async () => { if (await safe(() => superCall('setGlobalFreeze', { on: !o.freeze_recharges_global }))) { toast('Listo', 'ok'); render(); } }), true),
        h('div', { class: 'switchrow' }, h('div', { class: 'grow' }, h('b', null, 'Cerrar la sesión de todos'), h('div', { class: 'small muted' }, 'Todas las personas (excepto usted) deberán volver a escribir su contraseña.')),
          h('button', { class: 'btn warn', onclick: () => ask('Cerrar todas las sesiones', '¿Cerrar la sesión de todas las cuentas de todas las escuelas?', async () => { const r = await safe(() => superCall('logoutEveryone')); if (r) toast(`Sesiones cerradas: ${r.sessions_closed} cuenta(s)`, 'ok'); }) }, 'Cerrar todas')),
        h('div', { class: 'switchrow' }, h('div', { class: 'grow' }, h('b', null, 'Descargar respaldo'), h('div', { class: 'small muted' }, 'Copia completa de la base de datos (todas las escuelas). Guárdela en un lugar seguro: contiene datos personales.')),
          h('button', { class: 'btn primary', onclick: async () => {
            if (!window.coop.downloadBackup) return toast('Disponible solo en la versión web', 'err');
            const r = await window.coop.downloadBackup(); if (r.ok) toast('Respaldo descargado: ' + r.data.name, 'ok'); else toast(r.error, 'err');
          } }, '⬇ Descargar respaldo')),
        h('div', { class: 'switchrow' }, h('div', { class: 'grow' }, h('b', null, 'Dónde se guardan los datos'),
          h('div', { class: 'small muted' }, P.mode === 'temporal' ? 'TEMPORAL: los datos se borran cuando el servidor se reinicia. Configure Turso o un disco antes de usarlo con una escuela real (ver guía).'
            : P.mode === 'turso' ? `Copia en Turso (nube). Última copia: ${P.last_ok_at ? since(P.last_ok_at) : 'pendiente'}${P.last_error ? ' · Error: ' + P.last_error : ''}`
              : P.mode === 'disco' ? 'Disco permanente del servidor, con respaldo diario automático.' : P.mode === 'memoria' ? 'Memoria (modo de prueba).' : (P.mode || '—'))),
          h('span', { class: P.mode === 'temporal' ? 'state-on' : 'state-off' }, P.mode === 'temporal' ? 'TEMPORAL' : 'OK'))),
      h('h2', { class: 'section-title' }, 'Por escuela'),
      o.schools.length ? o.schools.map((s) => {
        const f = s.flags;
        return h('div', { class: 'card', style: { marginBottom: '16px' } },
          h('div', { class: 'row', style: { marginBottom: '6px' } }, h('h2', { class: 'grow', style: { margin: 0 } }, '🏫 ' + s.name), schoolBadge(s.status),
            s.synced ? badge('usa caja de escritorio', 'info') : null),
          h('div', { class: 'kv small muted' }, `Recargas de hoy: ${money(s.today_recharges_cents)}`, f.daily_recharge_limit_cents ? ` · Límite diario: ${money(f.daily_recharge_limit_cents)}` : ' · Sin límite diario',
            ` · Aviso por recarga mayor a ${money(f.large_recharge_cents)} · Horario ${f.hours_start}–${f.hours_end}`),
          switchRow('Congelar recargas', f.freeze_recharges_global ? 'Ahora están congeladas para TODAS las escuelas (vea arriba).' : 'No se podrán registrar recargas en esta escuela.', !!f.freeze_recharges,
            () => set(s, 'freeze_recharges', !f.freeze_recharges, f.freeze_recharges ? 'Recargas reanudadas' : 'Recargas congeladas'), true),
          switchRow('Congelar ventas', 'La caja no podrá cobrar.', f.freeze_sales, () => set(s, 'freeze_sales', !f.freeze_sales, f.freeze_sales ? 'Ventas reanudadas' : 'Ventas congeladas'), true),
          switchRow('Solo lectura', 'Se puede consultar todo, pero nadie puede cobrar, recargar ni cambiar nada.', f.read_only, () => set(s, 'read_only', !f.read_only, f.read_only ? 'Escuela desbloqueada' : 'Escuela en solo lectura'), true),
          h('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap', gap: '8px' } },
            h('button', { class: 'btn', onclick: () => schoolLimitsModal(s) }, '⚙️ Límites y horario'),
            h('button', { class: 'btn', onclick: () => go('seguridad', { recargas: s.id }) }, '💵 Revisar recargas'),
            h('button', { class: 'btn warn', onclick: () => ask('Cerrar sesiones', `¿Cerrar la sesión de todo el personal y padres de ${s.name}?`, async () => { const r = await safe(() => superCall('logoutSchool', { school_id: s.id })); if (r) toast(`Sesiones cerradas: ${r.sessions_closed}`, 'ok'); }) }, 'Cerrar sesiones'),
            h('button', { class: 'btn danger', onclick: () => ask('Bloquear administradores', `Se DESACTIVAN las cuentas de administrador de ${s.name} (${s.admins.map((a) => a.username).join(', ') || 'ninguna'}) y se cierran sus sesiones. Puede reactivarlas en Cuentas. ¿Continuar?`, async () => { const r = await safe(() => superCall('blockSchoolAdmins', { school_id: s.id })); if (r) { toast(`Administradores bloqueados: ${r.blocked}`, 'ok'); render(); } }) }, '⛔ Bloquear administradores')));
      }) : h('div', { class: 'empty' }, 'Aún no hay escuelas'),
      h('div', { id: 'recargas-rev' }), h('div', { id: 'papelera' }));
    await rechargesReview(main.querySelector('#recargas-rev'), o, state.params && state.params.recargas);
    await trashBox(main.querySelector('#papelera'));
    if (state.params && state.params.recargas) main.querySelector('#recargas-rev').scrollIntoView();
  };
  async function rechargesReview(el, o, sid) {
    const school = h('select', null, h('option', { value: '' }, 'Todas las escuelas'), o.schools.map((s) => h('option', { value: s.id, selected: String(sid) === String(s.id) }, s.name)));
    const only = h('input', { type: 'checkbox', checked: true });
    const box = h('div', { class: 'tablewrap' });
    const load = async () => {
      const list = await superCall('listRecharges', { school_id: school.value || undefined, only_flagged: only.checked });
      box.innerHTML = '';
      if (!list.length) { box.appendChild(h('div', { class: 'empty' }, only.checked ? 'No hay recargas sospechosas 👍' : 'Sin recargas')); return; }
      box.appendChild(respTable([{ label: 'Fecha' }, { label: 'Escuela' }, { label: 'Alumno / tarjeta' }, { label: 'Monto', right: true }, { label: 'Hecha por' }, { label: 'Motivo' }, { label: '', right: true }],
        list.map((t) => [fmtDate(t.created_at), t.school_name || '—', h('div', null, t.child_name || '—', h('div', { class: 'small muted' }, t.card_uid || '')), money(t.amount_cents), t.operator || '—',
          h('div', null, t.status === 'revertida' ? badge('revertida', 'err') : null, t.flag ? badge('marcada', 'warn') : null, t.alert_kinds ? h('div', { class: 'small muted' }, t.alert_kinds.split(',').map((k) => ALERT_LABEL[k] || k).join(', ')) : null, t.flag_note ? h('div', { class: 'small' }, t.flag_note) : null),
          t.status === 'revertida' ? '' : h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '6px' } },
            t.flag ? null : h('button', { class: 'btn sm', onclick: async () => { if (await safe(() => superCall('flagRecharge', { tx_id: t.id, note: 'Revisar' }))) { toast('Recarga marcada', 'ok'); load(); } } }, 'Marcar'),
            h('button', { class: 'btn sm danger', onclick: async () => {
              if (!(await confirmBox('Revertir recarga', `Se quitarán ${money(t.amount_cents)} del saldo de ${t.child_name || 'la tarjeta'}. Si la escuela usa caja de escritorio, se bloqueará la tarjeta para que la escuela haga el ajuste. ¿Continuar?`))) return;
              const r = await safe(() => superCall('reverseRecharge', { tx_id: t.id, reason: 'Recarga sospechosa' }));
              if (r) { toast(r.reversed ? 'Recarga revertida' : r.message, r.reversed ? 'ok' : 'warn'); load(); }
            } }, 'Revertir'))])));
    };
    school.addEventListener('change', load); only.addEventListener('change', load);
    el.appendChild(h('h2', { class: 'section-title' }, 'Revisar recargas'));
    el.appendChild(h('div', { class: 'card' }, h('div', { class: 'filters', style: { boxShadow: 'none', padding: 0, border: 0 } }, field('Escuela', school), h('label', { class: 'check' }, only, 'Solo sospechosas o marcadas')), box));
    await load();
  }
  async function trashBox(el) {
    const list = await superCall('listTrash');
    el.appendChild(h('h2', { class: 'section-title' }, 'Papelera (productos borrados)'));
    el.appendChild(h('div', { class: 'card tablewrap' }, list.length ? respTable([{ label: 'Producto' }, { label: 'Escuela' }, { label: 'Precio', right: true }, { label: 'Borrado' }, { label: '', right: true }],
      list.map((p) => [p.name, p.school_name || '—', money(p.price_cents), fmtDate(p.deleted_at),
        h('button', { class: 'btn sm ok', onclick: async () => { if (await safe(() => superCall('restoreProduct', { id: p.id }))) { toast('Producto restaurado', 'ok'); render(); } } }, 'Restaurar')]))
      : h('div', { class: 'empty' }, 'La papelera está vacía')));
  }

  // ======================================================================
  // ----- Superadministrador: Mis tarjetas (inventario / lista blanca) -----
  // ======================================================================
  const STOCK_LABEL = { en_stock: 'En stock', entregada: 'Entregada a escuela', asignada: 'Asignada', bloqueada: 'Bloqueada', danada: 'Dañada' };
  const STOCK_CLS = { en_stock: 'info', entregada: 'ok', asignada: 'activa', bloqueada: 'bloqueada', danada: 'err' };
  const stockBadge = (st) => h('span', { class: 'badge ' + (STOCK_CLS[st] || '') }, STOCK_LABEL[st] || st || '—');
  // Sonido corto al leer una tarjeta (ok = agudo, error = grave)
  function beep(ok) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ctx = beep.ctx || (beep.ctx = new AC()); const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = ok ? 1200 : 300; o.type = ok ? 'sine' : 'square'; g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + (ok ? 0.09 : 0.25));
    } catch (_) { /* sin audio */ }
  }
  VIEWS.inventario = async (main) => {
    const [sum, overview] = await Promise.all([superCall('stockSummary'), superCall('overview')]);
    const schools = overview.schools;
    const schoolOpts = (first) => [h('option', { value: '' }, first), ...schools.map((x) => h('option', { value: x.id }, x.name))];
    // --- alta una por una (lector USB 125 kHz tipo teclado) ---
    const kind = h('select', null, h('option', { value: 'normal' }, 'Normal'), h('option', { value: 'personalizada' }, 'Personalizada'));
    const batch = h('input', { placeholder: 'p. ej. Lote octubre 2026 (opcional)' });
    const deliverTo = h('select', null, schoolOpts('— Dejar en stock —'));
    const uidIn = h('input', { placeholder: 'Pase la tarjeta por el lector o escriba el UID y presione Enter', autocomplete: 'off', 'data-uid-input': '', class: 'grow' });
    const cont = h('input', { type: 'checkbox', checked: true });
    const counter = h('b', null, '0'); let sessionN = 0;
    const feed = h('div', { class: 'small', style: { maxHeight: '160px', overflow: 'auto' } });
    const feedLine = (ok, text) => { feed.prepend(h('div', { class: 'result ' + (ok ? 'ok' : 'err'), style: { padding: '6px 10px', margin: '4px 0' } }, text)); };
    const addOne = async () => {
      const v = uidIn.value.trim(); if (!v) { uidIn.focus(); return; }
      uidIn.value = '';
      try {
        const r = await superCall('stockAdd', { uid: v, kind: kind.value, batch: batch.value || undefined, school_id: deliverTo.value ? Number(deliverTo.value) : undefined });
        if (r.added) { sessionN++; counter.textContent = String(sessionN); beep(true); feedLine(true, `✔ ${r.added_uids[0]} agregada${deliverTo.value ? ' y entregada' : ''}`); }
        else { beep(false); feedLine(false, r.duplicates.length ? `⚠ ${r.duplicates[0]} ya estaba en el inventario` : `✖ UID inválido: ${v}`); }
      } catch (e) { beep(false); feedLine(false, '✖ ' + e.message); }
      if (cont.checked) uidIn.focus(); else reload();
    };
    uidIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOne(); } });
    // --- carga en lote (pegar lista o archivo CSV/TXT) ---
    const bulk = h('textarea', { rows: 5, placeholder: 'Un UID por renglón (o CSV con el UID en la primera columna)\n0001234567\n0001234568' });
    const file = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', onchange: async () => { if (file.files[0]) bulk.value = await file.files[0].text(); } });
    const bulkAdd = async () => {
      if (!bulk.value.trim()) { toast('Pegue la lista o elija un archivo', 'err'); return; }
      try {
        const r = await superCall('stockAdd', { text: bulk.value, kind: kind.value, batch: batch.value || undefined, school_id: deliverTo.value ? Number(deliverTo.value) : undefined });
        beep(true);
        modal('Carga en lote', h('div', null, h('p', null, `Agregadas: ${r.added} · Repetidas: ${r.duplicates.length} · Inválidas: ${r.invalid.length}`),
          r.duplicates.length ? h('p', { class: 'small muted' }, 'Repetidas: ' + r.duplicates.slice(0, 50).join(', ') + (r.duplicates.length > 50 ? '…' : '')) : null,
          r.invalid.length ? h('p', { class: 'small muted' }, 'Inválidas: ' + r.invalid.slice(0, 50).join(', ')) : null), [{ label: 'Aceptar', class: 'primary' }]);
        bulk.value = ''; reload();
      } catch (e) { toast(e.message, 'err'); }
    };
    // --- filtros y lista ---
    const q = h('input', { placeholder: 'Buscar UID, lote o nota' });
    const fSt = h('select', null, h('option', { value: '' }, 'Todos los estados'), Object.entries(STOCK_LABEL).map(([k, l]) => h('option', { value: k }, l)));
    const fSch = h('select', null, h('option', { value: '' }, 'Todas las escuelas'), h('option', { value: 'none' }, 'Sin escuela'), schools.map((x) => h('option', { value: x.id }, x.name)));
    const filters = () => ({ q: q.value || undefined, status: fSt.value || undefined, school_id: fSch.value || undefined });
    const selected = new Set();
    const listBox = h('div'); const countsBox = h('div');
    const pickSchool = (title, args) => {
      const sel = h('select', null, schoolOpts('— Elija escuela —'));
      const from = h('input', { placeholder: 'UID inicial (p. ej. 0001234500)' }); const to = h('input', { placeholder: 'UID final (p. ej. 0001234599)' });
      const body = h('div', { class: 'form' }, field('Escuela', sel), args ? h('p', null, `${args.ids.length} tarjeta(s) seleccionada(s).`) : h('div', { class: 'grid g2' }, field('Desde', from), field('Hasta', to)),
        h('p', { class: 'small muted' }, 'Las tarjetas quedan disponibles para el administrador de esa escuela. Solo esa escuela podrá usarlas.'));
      modal(title, body, [{ label: 'Cancelar' }, { label: 'Entregar', class: 'primary', onClick: async () => {
        if (!sel.value) { toast('Elija la escuela', 'err'); return false; }
        try {
          const r = await superCall('stockDeliver', { school_id: Number(sel.value), ...(args || { from: from.value, to: to.value }) });
          toast(`${r.delivered} tarjeta(s) entregada(s) a ${r.school}` + (r.skipped.length ? ` · ${r.skipped.length} omitida(s)` : ''), r.delivered ? 'ok' : 'err');
          selected.clear(); reload();
        } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const bulkStatus = async (status, ids) => {
      const lbl = { bloqueada: 'bloquear', danada: 'marcar como dañadas', desbloquear: 'desbloquear', en_stock: 'regresar a stock' }[status];
      if (!(await confirmBox('Inventario', `¿${lbl[0].toUpperCase() + lbl.slice(1)} ${ids.length} tarjeta(s)?`))) return;
      const r = await safe(() => superCall('stockSetStatus', { ids, status }));
      if (r) { toast(`${r.updated} actualizada(s)` + (r.skipped.length ? ` · ${r.skipped.length} omitida(s): ${r.skipped[0].motivo}` : ''), 'ok'); selected.clear(); reload(); }
    };
    const removeCards = async (ids) => {
      if (!(await confirmBox('Eliminar del inventario', `¿Eliminar ${ids.length} tarjeta(s) del inventario? Las que ya registró una escuela no se eliminan (bloquéelas).`))) return;
      const r = await safe(() => superCall('stockRemove', { ids }));
      if (r) { toast(`${r.removed} eliminada(s)` + (r.skipped.length ? ` · ${r.skipped.length} omitida(s)` : ''), 'ok'); selected.clear(); reload(); }
    };
    const purgeCards = async (ids) => {
      if (!(await confirmBox('Eliminar definitivamente', `¿Eliminar DEFINITIVAMENTE ${ids.length} tarjeta(s)? También se borra el registro de la tarjeta en la escuela (p. ej. tarjetas de prueba). El historial de movimientos se conserva. No se eliminan las asignadas a un alumno activo ni las que tienen saldo. Esta acción no se puede deshacer.`))) return;
      const r = await safe(() => superCall('stockPurge', { ids }));
      if (r) { toast(`${r.removed} eliminada(s) definitivamente` + (r.skipped.length ? ` · ${r.skipped.length} omitida(s): ${r.skipped[0].motivo}` : ''), r.removed ? 'ok' : 'err'); selected.clear(); reload(); }
    };
    const editCard = (c) => {
      const k = h('select', null, ['normal', 'personalizada'].map((x) => h('option', { value: x, selected: c.kind === x }, x === 'normal' ? 'Normal' : 'Personalizada')));
      const b = h('input', { value: c.batch || '' }); const n = h('input', { value: c.note || '' });
      modal('Tarjeta ' + c.uid, h('div', { class: 'form' }, field('Tipo', k), field('Lote', b), field('Nota', n)), [{ label: 'Cancelar' }, { label: 'Guardar', class: 'primary', onClick: async () => {
        try { await superCall('stockUpdate', { id: c.id, kind: k.value, batch: b.value, note: n.value }); toast('Guardado', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); return false; }
      } }]);
    };
    const selBar = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', margin: '0 0 10px' } });
    const drawSelBar = () => {
      selBar.innerHTML = '';
      const ids = [...selected];
      selBar.append(h('span', { class: 'small muted grow' }, ids.length ? `${ids.length} seleccionada(s)` : 'Seleccione tarjetas con la casilla para entregarlas o bloquearlas en lote.'),
        h('button', { class: 'btn sm primary', disabled: !ids.length, onclick: () => pickSchool('Entregar a escuela', { ids }) }, '🏫 Entregar a escuela'),
        h('button', { class: 'btn sm', disabled: !ids.length, onclick: () => bulkStatus('bloqueada', ids) }, '⛔ Bloquear'),
        h('button', { class: 'btn sm', disabled: !ids.length, onclick: () => bulkStatus('danada', ids) }, 'Dañada'),
        h('button', { class: 'btn sm', disabled: !ids.length, onclick: () => bulkStatus('desbloquear', ids) }, 'Desbloquear'),
        h('button', { class: 'btn sm danger', disabled: !ids.length, onclick: () => removeCards(ids) }, 'Eliminar'),
        h('button', { class: 'btn sm danger', disabled: !ids.length, onclick: () => purgeCards(ids) }, '🗑 Eliminar definitivamente'));
    };
    const reload = async () => {
      const [rows, s2] = await Promise.all([superCall('stockList', filters()), superCall('stockSummary')]);
      countsBox.innerHTML = '';
      countsBox.append(h('div', { class: 'grid g3 stats' }, statCard('Total', String(s2.total), 'Tarjetas en el inventario'),
        ...Object.keys(STOCK_LABEL).map((k) => statCard(STOCK_LABEL[k], String(s2.by_status[k] || 0)))),
        s2.migrated ? h('p', { class: 'small muted' }, `${s2.migrated} tarjeta(s) que ya usaban las escuelas se agregaron automáticamente al actualizar.`) : null,
        h('div', { class: 'card tablewrap', style: { margin: '14px 0' } }, h('h2', null, 'Por escuela'), respTable([{ label: 'Escuela' }, { label: 'Entregadas (libres)', right: true }, { label: 'Asignadas', right: true }, { label: 'Bloqueadas / dañadas', right: true }, { label: 'Total', right: true }],
          s2.schools.map((x) => [x.name, String(x.entregada || 0), String(x.asignada || 0), String((x.bloqueada || 0) + (x.danada || 0)), h('b', null, String(x.total || 0))]), null, 'resp-md')));
      listBox.innerHTML = '';
      for (const id of [...selected]) if (!rows.some((r) => r.id === id)) selected.delete(id);
      drawSelBar();
      const all = h('input', { type: 'checkbox', checked: rows.length > 0 && rows.every((r) => selected.has(r.id)), onchange: () => { rows.forEach((r) => (all.checked ? selected.add(r.id) : selected.delete(r.id))); reload(); } });
      listBox.append(rows.length ? h('table', { class: 'resp resp-md' }, h('tr', { class: 'head' }, h('th', null, all), ['UID', 'Tipo', 'Estado', 'Escuela', 'Alumno', 'Alta', 'Lote / nota', ''].map((x) => h('th', null, x))),
        rows.map((c) => {
          const cb = h('input', { type: 'checkbox', checked: selected.has(c.id), onchange: () => { if (cb.checked) selected.add(c.id); else selected.delete(c.id); drawSelBar(); } });
          return h('tr', null, h('td', null, cb), h('td', { 'data-label': 'UID' }, h('code', null, c.uid)), h('td', { 'data-label': 'Tipo' }, c.kind === 'personalizada' ? 'Personalizada' : 'Normal'),
            h('td', { 'data-label': 'Estado' }, stockBadge(c.status)), h('td', { 'data-label': 'Escuela' }, c.school_name || h('span', { class: 'muted' }, '—')),
            h('td', { 'data-label': 'Alumno' }, c.child_name || '—'), h('td', { 'data-label': 'Alta', class: 'small' }, fmtDate(c.created_at)),
            h('td', { 'data-label': 'Lote / nota', class: 'small' }, [c.batch, c.note].filter(Boolean).join(' · ') || '—'),
            h('td', { class: 'right', style: { whiteSpace: 'nowrap' } }, h('button', { class: 'btn sm', onclick: () => editCard(c) }, 'Editar'), ' ',
              ['bloqueada', 'danada'].includes(c.status) ? h('button', { class: 'btn sm', onclick: () => bulkStatus('desbloquear', [c.id]) }, 'Desbloquear') : h('button', { class: 'btn sm', onclick: () => bulkStatus('bloqueada', [c.id]) }, 'Bloquear'), ' ',
              !c.card_id ? h('button', { class: 'btn sm danger', onclick: () => removeCards([c.id]) }, 'Eliminar') : h('button', { class: 'btn sm danger', onclick: () => purgeCards([c.id]) }, 'Eliminar definitivamente')));
        })) : h('div', { class: 'empty' }, 'No hay tarjetas con esos filtros'), h('p', { class: 'small muted' }, `${rows.length} tarjeta(s) mostradas`));
    };
    for (const el of [fSt, fSch]) el.addEventListener('change', reload);
    let qt; q.addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(reload, 250); });
    const exportCsv = async () => {
      const r = await safe(() => superCall('stockExport', filters()));
      if (r) downloadBlob(new Blob(['\ufeff' + r.csv], { type: 'text/csv;charset=utf-8' }), r.filename);
    };
    put(main, pageHead('Mis tarjetas (inventario)', 'Solo las tarjetas de este inventario, entregadas a una escuela, se pueden asignar, cobrar o recargar en esa escuela.',
      h('button', { class: 'btn', onclick: () => pickSchool('Entregar un rango a escuela') }, '🏫 Entregar rango'), h('button', { class: 'btn', onclick: exportCsv }, '⬇ Exportar CSV')),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card form' }, h('h2', null, 'Registrar tarjetas una por una'),
          field('Tarjeta (UID)', uidIn, 'Lector USB 125 kHz o NFC: con el cursor aquí, acerque la tarjeta; se agrega sola al leerla (Enter).'),
          h('label', { class: 'check' }, cont, 'Modo continuo (seguir leyendo una tras otra)'),
          h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Leídas en esta sesión: ', counter), h('button', { class: 'btn primary', onclick: addOne }, 'Agregar')), feed),
        h('div', { class: 'card form' }, h('h2', null, 'Carga en lote'), field('Pegar lista de UID', bulk), field('o subir archivo CSV / TXT', file),
          h('div', { class: 'row' }, h('span', { class: 'grow small muted' }, 'Se normaliza: sin espacios ni separadores, en mayúsculas; los ceros a la izquierda se conservan.'), h('button', { class: 'btn primary', onclick: bulkAdd }, 'Agregar lista')))),
      h('div', { class: 'card form', style: { margin: '14px 0' } }, h('div', { class: 'grid g3' }, field('Tipo', kind), field('Lote / nota', batch), field('Entregar al dar de alta a', deliverTo))),
      countsBox,
      h('div', { class: 'card tablewrap' }, h('h2', null, 'Tarjetas'), h('div', { class: 'filters row', style: { gap: '8px', flexWrap: 'wrap', marginBottom: '10px' } }, q, fSt, fSch), selBar, listBox));
    await reload();
    setTimeout(() => uidIn.focus(), 50);
  };

  // ======================================================================
  // ----- Superadministrador: Alertas -----
  // ======================================================================
  const ALERT_LABEL = { recarga_grande: 'Recarga grande', muchas_recargas: 'Muchas recargas seguidas del mismo usuario', recargas_repetidas: 'Varias recargas a la misma tarjeta',
    fuera_de_horario: 'Recarga fuera de horario', auto_recarga: 'Posible auto-recarga (padre/alumno)', limite_diario: 'Límite diario superado', borrado: 'Borrado',
    intentos_fallidos: 'Intentos de acceso fallidos', cuenta_bloqueada: 'Cuenta bloqueada por intentos', alerta_roja: 'Alerta roja', superadmin_recuperado: 'Recuperación de superadmin',
    tarjeta_no_autorizada: 'Tarjeta no autorizada', mensualidad_por_vencer: 'Mensualidad por vencer', mensualidad_tolerancia: 'Mensualidad vencida (tolerancia)', mensualidad_pausada: 'Escuela pausada' };
  const SEV_LABEL = { critica: 'Crítica', alta: 'Alta', media: 'Media', aviso: 'Aviso', info: 'Info', baja: 'Baja' };
  const sevBadge = (s) => h('span', { class: 'badge ' + (s || 'info') }, SEV_LABEL[s] || s || 'Info');
  VIEWS.alertas = async (main) => {
    const all = h('select', null, h('option', { value: '' }, 'Sin revisar'), h('option', { value: 'todas' }, 'Todas'));
    const box = h('div');
    const load = async () => {
      const list = await superCall('listAlerts', { status: all.value || undefined });
      box.innerHTML = '';
      if (!list.length) { box.appendChild(h('div', { class: 'card empty' }, all.value ? 'No hay alertas' : 'No hay alertas pendientes 👍')); return; }
      list.forEach((a) => box.appendChild(h('div', { class: 'alert-item sev-' + (a.severity || 'media') + (a.ack_at ? ' done' : '') },
        h('div', { class: 'grow' }, h('div', { class: 'row', style: { gap: '8px' } }, sevBadge(a.severity), h('b', null, ALERT_LABEL[a.kind] || a.kind), a.school_name ? h('span', { class: 'muted' }, '· ' + a.school_name) : null),
          h('div', { style: { margin: '6px 0' } }, a.message),
          h('div', { class: 'small muted' }, fmtDate(a.created_at), a.ack_at ? ` · Revisada por ${a.ack_by} (${fmtDate(a.ack_at)})` : '')),
        h('div', { class: 'row', style: { gap: '6px' } },
          a.ref_type === 'transaction' ? h('button', { class: 'btn sm', onclick: () => go('seguridad', { recargas: a.school_id || '' }) }, 'Ver recarga') : null,
          a.ack_at ? null : h('button', { class: 'btn sm ok', onclick: async () => { if (await safe(() => superCall('ackAlert', { id: a.id }))) { load(); refreshAlertCount(); } } }, '✔ Revisada')))));
    };
    all.addEventListener('change', load);
    put(main, pageHead('Alertas', 'Avisos automáticos de cosas raras: recargas grandes o muy seguidas, fuera de horario, borrados e intentos de acceso fallidos.',
      h('button', { class: 'btn', onclick: async () => { if (!(await confirmBox('Marcar todas', '¿Marcar todas las alertas como revisadas?'))) return; if (await safe(() => superCall('ackAlert', { id: 0 }))) { load(); refreshAlertCount(); } } }, '✔ Marcar todas como revisadas')),
      h('div', { class: 'card filters' }, field('Mostrar', all)), box);
    await load();
  };

  // ======================================================================
  // ----- Superadministrador: Bitácora -----
  // ======================================================================
  const ACTION_LABEL = { recarga: 'Recarga', recarga_caja: 'Recarga (caja)', ajuste: 'Ajuste de saldo', recarga_revertida: 'Recarga revertida', recarga_marcada: 'Recarga marcada',
    producto_borrado: 'Producto borrado', solicitud_cambio_datos: 'Solicitud de cambio de datos', solicitud_cambio_aprobada: 'Solicitud de cambio aprobada', solicitud_cambio_rechazada: 'Solicitud de cambio rechazada', edicion_alumno_rechazada: 'Edición de alumno rechazada (tutor)', producto_restaurado: 'Producto restaurado', contrasena_asignada: 'Contraseña asignada', contrasena_propia: 'Cambió su contraseña', superadmin_recuperado: 'Recuperación de superadmin',
    rol_cambiado: 'Cambio de rol', cuenta_activada: 'Cuenta activada', cuenta_desactivada: 'Cuenta desactivada', usuario_creado: 'Cuenta creada', usuario_editado: 'Cuenta editada', cuenta_desbloqueada: 'Cuenta desbloqueada',
    login: 'Inicio de sesión', login_fallido: 'Contraseña incorrecta', cuenta_bloqueada_intentos: 'Bloqueo por intentos', login_rechazado_bloqueo: 'Acceso rechazado (bloqueo)',
    alerta_roja: 'ALERTA ROJA', alerta_roja_fin: 'Fin de alerta roja', congelar_recargas: 'Congelar recargas', congelar_ventas: 'Congelar ventas', solo_lectura: 'Solo lectura', cerrar_sesiones: 'Cerrar sesiones',
    bloquear_admin: 'Bloquear administradores', limites_escuela: 'Límites de escuela', respaldo_descargado: 'Respaldo descargado',
    mensualidad_pago: 'Pago de mensualidad', mensualidad_periodo: 'Periodo de mensualidad', mensualidad_por_vencer: 'Mensualidad por vencer', mensualidad_tolerancia: 'Mensualidad vencida (tolerancia)',
    escuela_pausada: 'Escuela pausada', escuela_pausada_auto: 'Escuela pausada por falta de pago', escuela_reactivada: 'Escuela reactivada', login_rechazado_pausa: 'Acceso rechazado (escuela pausada)',
    escuela_creada: 'Escuela creada', escuela_editada: 'Escuela editada' };
  const detailsText = (d) => (!d ? '' : typeof d === 'string' ? d : Object.entries(d).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : (k === 'monto' ? money(v) : v)}`).join(' · '));
  VIEWS.bitacora = async (main) => {
    const o = await superCall('overview');
    const from = h('input', { type: 'date' }); const to = h('input', { type: 'date' }); const q = h('input', { placeholder: 'Persona, IP, tarjeta…' });
    const cat = h('select', null, h('option', { value: '' }, 'Todo'), [['recargas', 'Recargas'], ['borrados', 'Borrados'], ['contrasenas', 'Contraseñas'], ['roles', 'Cuentas y roles'], ['accesos', 'Accesos'], ['mensualidad', 'Mensualidad'], ['emergencia', 'Emergencia']].map(([v, l]) => h('option', { value: v }, l)));
    const school = h('select', null, h('option', { value: '' }, 'Todas'), o.schools.map((s) => h('option', { value: s.id }, s.name)));
    const box = h('div', { class: 'card tablewrap' });
    const load = async () => {
      const list = await superCall('listAudit', { from: from.value || undefined, to: to.value || undefined, category: cat.value || undefined, school_id: school.value || undefined, q: q.value.trim() || undefined, limit: 500 });
      box.innerHTML = '';
      box.appendChild(h('div', { class: 'small muted', style: { marginBottom: '8px' } }, `${list.length} registro(s)${list.length >= 500 ? ' (se muestran los 500 más recientes)' : ''}`));
      if (!list.length) { box.appendChild(h('div', { class: 'empty' }, 'Sin registros con ese filtro')); return; }
      box.appendChild(respTable([{ label: 'Fecha y hora' }, { label: 'Quién' }, { label: 'Qué hizo' }, { label: 'Escuela' }, { label: 'Detalles' }, { label: 'IP' }],
        list.map((a) => [fmtDate(a.created_at), h('div', null, a.actor_name || '—', a.actor_role ? h('div', { class: 'small muted' }, ROLE_LABEL[a.actor_role] || a.actor_role) : null),
          h('div', null, h('b', null, ACTION_LABEL[a.action] || a.action), ' ', ['critica', 'alta'].includes(a.severity) ? sevBadge(a.severity) : null),
          a.school_name || '—', h('span', { class: 'small' }, detailsText(a.details)), h('span', { class: 'small muted' }, a.ip || '—')])));
    };
    put(main, pageHead('Bitácora', 'Registro de todo lo importante: quién lo hizo, cuándo, desde qué IP y qué cambió. No se puede borrar.'),
      h('div', { class: 'card filters' }, field('Desde', from), field('Hasta', to), field('Tipo', cat), field('Escuela', school), field('Buscar', q), h('button', { class: 'btn primary', onclick: load }, 'Buscar')), box);
    await load();
  };

  // ----- Ajustes / Mi cuenta -----
  VIEWS.ajustes = async (main) => {
    const info = await window.coop.info();
    const me = state.user; const isSuper = me.role === 'superadmin';
    const cur = h('input', { type: 'password', autocomplete: 'current-password' }); const n1 = h('input', { type: 'password', autocomplete: 'new-password' }); const n2 = h('input', { type: 'password', autocomplete: 'new-password' });
    const change = async () => {
      if (n1.value !== n2.value) return toast('Las contraseñas nuevas no coinciden', 'err');
      const r = await safe(() => call('changePassword', { current: cur.value, next: n1.value }));
      if (r) { toast('Contraseña actualizada', 'ok'); cur.value = n1.value = n2.value = ''; }
    };
    put(main, pageHead(me.role === 'admin' ? 'Ajustes' : 'Mi cuenta', isSuper ? 'Cuenta del dueño de la plataforma (Zuki Company).' : 'Sus datos y opciones de la cuenta.'),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', null, 'Mis datos'), h('div', { class: 'kv' },
          h('div', null, h('span', { class: 'muted' }, 'Nombre: '), h('b', null, me.full_name)), h('div', null, h('span', { class: 'muted' }, 'Usuario: '), h('b', null, me.username)),
          h('div', null, h('span', { class: 'muted' }, 'Puesto: '), h('b', null, ROLE_LABEL[me.role])), me.email ? h('div', null, h('span', { class: 'muted' }, 'Correo: '), me.email) : null)),
        isSuper ? h('div', { class: 'card form' }, h('h2', null, 'Cambiar mi contraseña'), field('Contraseña actual', cur), field('Contraseña nueva', n1, 'Mínimo 10 caracteres. No la comparta con las escuelas.'), field('Repita la contraseña nueva', n2), h('div', null, h('button', { class: 'btn primary', onclick: change }, 'Guardar contraseña')))
          : h('div', { class: 'card' }, h('h2', null, 'Contraseña'), banner('info', '🔑', 'Por seguridad, las contraseñas solo las cambia el administrador de la plataforma. Si olvidó la suya o cree que alguien más la conoce, pídale una nueva.')),
        WEB ? h('div', { class: 'card form' }, h('h2', null, 'Sesiones'), h('p', { class: 'small muted' }, 'Las sesiones se cierran solas tras 30 días sin uso. Si perdió su celular o computadora, cierre todas.'),
          h('div', null, h('button', { class: 'btn danger', onclick: async () => { await window.coop.auth.logoutAll(); state.user = null; render(); } }, 'Cerrar sesión en todos mis dispositivos'))) : null,
        !WEB && me.role === 'admin' ? serverConfigCard() : null,
        !WEB && me.role === 'admin' ? h('div', { class: 'card form' }, h('h2', null, 'Respaldos'),
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
  const SYNC_LABEL = { desactivado: 'Solo local (sin servidor)', pendiente: 'Sincronización pendiente', sincronizando: 'Sincronizando…', ok: 'Sincronizado', solo_lectura: 'Solo lectura (no es el equipo principal)', sin_conexion: 'Sin conexión', conflicto: 'Otro equipo es el principal', error: 'Error de sincronización', pausado: 'Servicio pausado' };
  const SYNC_COLOR = { ok: '#22c55e', sincronizando: '#60a5fa', pendiente: '#fbbf24', sin_conexion: '#f59e0b', solo_lectura: '#a78bfa', conflicto: '#ef4444', error: '#ef4444', pausado: '#ef4444', desactivado: '#64748b' };
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

  // ---------- conexión (solo en línea) ----------
  // Sin internet el adaptador muestra el aviso a pantalla completa y rechaza toda operación.
  // Al volver la conexión: se recupera la sesión y se vuelven a cargar los datos (nunca se muestran datos viejos).
  if (window.coop.connection) {
    window.coop.connection.onChange(async (on) => {
      if (!on) { document.querySelectorAll('.modal-bg').forEach((m) => m.remove()); return; }
      if (!state.user) { const r = await window.coop.call('me'); if (r.ok && r.data) { state.user = r.data; render(); } return; }
      render();
    });
  }

  // ---------- inicio ----------
  (async () => { const r = await window.coop.call('me'); state.user = r.ok ? r.data : null; if (!r.ok && r.code === 'ESCUELA_PAUSADA') state.pausedMsg = r.error; render(); })();
})();
