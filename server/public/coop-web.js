'use strict';
// Adaptador para usar la misma interfaz en el navegador (PWA) y en la caja de escritorio (cliente en línea).
// Implementa window.coop sobre la API REST del servidor con JWT de acceso + refresh token.
// El sistema funciona SOLO CON INTERNET: no hay cola de ventas sin conexión. Si no hay conexión con el
// servidor se muestra un aviso a pantalla completa y se bloquean cobros, recargas y cualquier cambio.
(function () {
  const RT_KEY = 'coop_refresh_token';
  const OFFLINE_MSG = 'Sin conexión a internet. No se puede cobrar hasta que regrese la conexión.';
  let access = null;
  const listeners = { uid: new Set(), status: new Set() };
  const desk = window.coopDesktop || null; // puente de la caja de escritorio (lector NFC PC/SC), si existe

  // ----- estado de la conexión con el servidor -----
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const conn = { online: nav.onLine !== false, subs: new Set(), timer: null, checking: null };
  const PING_ONLINE_MS = 30000; const PING_OFFLINE_MS = 4000;
  function setOnline(v) {
    v = !!v;
    if (conn.online !== v) { conn.online = v; updateBanner(); conn.subs.forEach((cb) => { try { cb(v); } catch (_) { /* nada */ } }); }
    schedule();
  }
  function schedule() {
    clearTimeout(conn.timer);
    conn.timer = setTimeout(checkNow, conn.online ? PING_ONLINE_MS : PING_OFFLINE_MS);
    if (conn.timer && conn.timer.unref) conn.timer.unref();
  }
  // Verifica que el servidor responda (no solo que haya red)
  function checkNow() {
    if (conn.checking) return conn.checking;
    conn.checking = (async () => {
      if (nav.onLine === false) { setOnline(false); return false; }
      let ok = false;
      try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const t = setTimeout(() => ctrl && ctrl.abort(), 15000);
        const r = await fetch('/api/health', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
        clearTimeout(t);
        ok = !!r && r.ok;
      } catch (_) { ok = false; }
      setOnline(ok);
      return ok;
    })().finally(() => { conn.checking = null; });
    return conn.checking;
  }
  // Aviso a pantalla completa (bloquea toda la interfaz mientras no haya conexión)
  let banner = null;
  function updateBanner() {
    if (typeof document === 'undefined' || !document.body) return;
    document.body.classList.toggle('sin-conexion', !conn.online);
    if (conn.online) { if (banner) banner.hidden = true; return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'offline-overlay'; banner.setAttribute('role', 'alert'); banner.setAttribute('aria-live', 'assertive');
      const box = document.createElement('div'); box.className = 'offline-box';
      const ico = document.createElement('div'); ico.className = 'offline-ico'; ico.textContent = '📡';
      const h = document.createElement('h2'); h.textContent = 'Sin conexión a internet';
      const p = document.createElement('p'); p.className = 'offline-msg'; p.textContent = OFFLINE_MSG;
      const p2 = document.createElement('p'); p2.className = 'offline-sub'; p2.textContent = 'Cobros y recargas están detenidos. Reintentando automáticamente…';
      const b = document.createElement('button'); b.className = 'btn primary'; b.type = 'button'; b.textContent = 'Reintentar ahora';
      b.addEventListener('click', () => { p2.textContent = 'Comprobando conexión…'; checkNow().then((ok) => { if (!ok) p2.textContent = 'Sigue sin conexión. Reintentando automáticamente…'; }); });
      box.append(ico, h, p, p2, b); banner.appendChild(box); document.body.appendChild(banner);
    }
    banner.hidden = false;
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('offline', () => setOnline(false));
    window.addEventListener('online', () => { checkNow(); });
  }
  if (typeof document !== 'undefined' && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateBanner); else updateBanner();
  checkNow();

  const offlineResult = (sent) => ({ ok: false, code: 'SIN_CONEXION', error: sent ? OFFLINE_MSG + ' La operación NO se pudo confirmar: cuando regrese la conexión revise Movimientos antes de repetirla.' : OFFLINE_MSG });
  async function req(path, body, { auth = false, method = 'POST' } = {}) {
    // Sin conexión: no se envía nada ni se guarda para después (no hay operación sin internet)
    if (!conn.online || nav.onLine === false) { if (nav.onLine === false) setOnline(false); else checkNow(); return offlineResult(false); }
    const headers = { 'Content-Type': 'application/json' };
    if (auth && access) headers.Authorization = 'Bearer ' + access;
    let r;
    try { r = await fetch(path, { method, headers, cache: 'no-store', body: method === 'GET' ? undefined : JSON.stringify(body || {}) }); } catch (_) {
      setOnline(false);
      return offlineResult(method !== 'GET');
    }
    // 502/503/504: el servidor no está disponible (p. ej. reiniciando)
    if (r.status >= 502 && r.status <= 504) { setOnline(false); return offlineResult(method !== 'GET'); }
    try { return await r.json(); } catch (_) { return { ok: false, error: 'Respuesta inválida del servidor (' + r.status + ')', code: 'INTERNO' }; }
  }
  function store(t) { access = t.access_token; localStorage.setItem(RT_KEY, t.refresh_token); }
  function clear() { access = null; localStorage.removeItem(RT_KEY); }
  let refreshing = null;
  let pausedErr = null; // escuela pausada (mensualidad): el servidor lo indica al renovar la sesión
  async function refresh() {
    const rt = localStorage.getItem(RT_KEY);
    if (!rt) return false;
    if (!refreshing) {
      refreshing = req('/api/auth/refresh', { refresh_token: rt }).then((r) => {
        refreshing = null; pausedErr = !r.ok && r.code === 'ESCUELA_PAUSADA' ? r : null;
        if (r.ok) { store(r.data); return true; } if (r.code !== 'SIN_CONEXION') clear(); return false;
      });
    }
    return refreshing;
  }
  // Llamada autenticada con reintento tras renovar el token de acceso
  async function authed(path, body, method) {
    if (!access && !(await refresh()) && pausedErr) return pausedErr;
    let r = await req(path, body, { auth: true, method });
    if (!r.ok && r.code === 'NO_AUTENTICADO') { if (await refresh()) r = await req(path, body, { auth: true, method }); else if (pausedErr) r = pausedErr; }
    if (!r.ok && r.code === 'ESCUELA_PAUSADA') clear();
    return r;
  }

  async function call(method, args = {}) {
    switch (method) {
      case 'login': {
        const r = await req('/api/auth/login', { identifier: args.username, password: args.password });
        if (!r.ok) return r;
        store(r.data); return { ok: true, data: r.data.user };
      }
      case 'logout': { const rt = localStorage.getItem(RT_KEY); clear(); if (rt) await req('/api/auth/logout', { refresh_token: rt }); return { ok: true, data: null }; }
      case 'me': {
        if (!access && !(await refresh())) return pausedErr || (!conn.online ? offlineResult(false) : { ok: true, data: null });
        const r = await authed('/api/auth/me', null, 'GET');
        return r.ok || r.code === 'ESCUELA_PAUSADA' || r.code === 'SIN_CONEXION' ? r : { ok: true, data: null };
      }
      case 'changePassword': {
        const r = await authed('/api/auth/change-password', { current: args.current, next: args.next });
        if (!r.ok) return r; store(r.data); return { ok: true, data: r.data.user };
      }
      default: return authed('/api/rpc/' + encodeURIComponent(method), args);
    }
  }

  // Web NFC (Chrome en Android): lee el número de serie (UID) de la tarjeta
  async function startWebNfc() {
    if (!('NDEFReader' in window)) throw new Error('Este navegador no soporta Web NFC (use Chrome en Android)');
    const reader = new window.NDEFReader();
    await reader.scan();
    reader.onreading = (ev) => { const uid = String(ev.serialNumber || '').replace(/:/g, '').toUpperCase(); listeners.uid.forEach((cb) => cb(uid)); };
    listeners.status.forEach((cb) => cb({ available: true, message: 'NFC del teléfono activo: acerque la tarjeta' }));
  }

  // Caja de escritorio: el lector NFC PC/SC (ACR122U, etc.) llega por el puente del escritorio
  if (desk && typeof desk.onNfcUid === 'function') desk.onNfcUid((uid) => listeners.uid.forEach((cb) => cb(String(uid).toUpperCase())));
  if (desk && typeof desk.onNfcStatus === 'function') desk.onNfcStatus((st) => listeners.status.forEach((cb) => cb(st)));

  window.coop = {
    web: true,
    desktop: !!desk,
    call,
    superCall: (method, args) => authed('/api/super/' + encodeURIComponent(method), args || {}),
    info: async () => (desk && desk.info ? { ...(await desk.info()), dbPath: 'Servidor' } : { version: 'web', dbPath: 'Servidor', platform: 'web' }),
    nfcStatus: async () => {
      if (desk && desk.nfcStatus) return desk.nfcStatus();
      return { available: 'NDEFReader' in window, message: 'NDEFReader' in window ? 'Web NFC disponible (toque "Leer con NFC del teléfono")' : 'Lector USB tipo teclado' };
    },
    onNfcUid: (cb) => { listeners.uid.add(cb); return () => listeners.uid.delete(cb); },
    onNfcStatus: (cb) => { listeners.status.add(cb); return () => listeners.status.delete(cb); },
    // Conexión con el servidor (para la interfaz): isOnline(), onChange(cb), check()
    connection: { isOnline: () => conn.online, onChange: (cb) => { conn.subs.add(cb); return () => conn.subs.delete(cb); }, check: checkNow, message: OFFLINE_MSG },
    startWebNfc,
    backup: async () => ({ ok: false, error: 'Los respaldos del servidor se hacen en el servidor (ver README)' }),
    // Descarga del respaldo completo de la base (solo superadministrador)
    downloadBackup: async () => {
      if (!access) await refresh();
      const get = () => fetch('/api/super-backup', { headers: { Authorization: 'Bearer ' + access } });
      let r;
      if (!conn.online) return offlineResult(false);
      try { r = await get(); if (r.status === 401 && await refresh()) r = await get(); } catch (_) { setOnline(false); return offlineResult(false); }
      if (!r.ok) { try { return await r.json(); } catch (_) { return { ok: false, error: 'No se pudo descargar (' + r.status + ')' }; } }
      const blob = await r.blob();
      const m = /filename="?([^";]+)"?/.exec(r.headers.get('Content-Disposition') || '');
      const name = m ? m[1] : 'respaldo-cooperativa.db';
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      return { ok: true, data: { name, bytes: blob.size } };
    },
    openDataFolder: async () => ({ ok: false }),
    push: { key: () => req('/api/push/key', null, { method: 'GET' }), test: () => authed('/api/push/test', {}) },
    auth: {
      forgot: (identifier) => req('/api/auth/forgot', { identifier }),
      reset: (token, password) => req('/api/auth/reset', { token, password }),
      register: async (data) => { const r = await req('/api/auth/register', data); if (r.ok) { store(r.data); return { ok: true, data: r.data.user }; } return r; },
      redeem: (code) => authed('/api/auth/redeem', { code }),
      logoutAll: async () => { const r = await authed('/api/auth/logout-all', {}); clear(); return r; },
      createTutor: (data) => authed('/api/admin/tutors', data),
      createInvitation: (child_id) => authed('/api/admin/invitations', { child_id }),
      listInvitations: () => authed('/api/admin/invitations', null, 'GET'),
      invitationSheet: (a) => authed('/api/admin/invitation-sheet', a || {}),
    },
  };
  if (nav.serviceWorker && typeof location !== 'undefined' && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
