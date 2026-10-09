'use strict';
// Adaptador para usar la misma interfaz del escritorio en el navegador (PWA).
// Implementa window.coop sobre la API REST del servidor con JWT de acceso + refresh token.
(function () {
  const RT_KEY = 'coop_refresh_token';
  let access = null;
  const listeners = { uid: new Set(), status: new Set() };

  async function req(path, body, { auth = false, method = 'POST' } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && access) headers.Authorization = 'Bearer ' + access;
    let r;
    try { r = await fetch(path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}) }); } catch (_) {
      return { ok: false, error: 'Sin conexión con el servidor', code: 'SIN_CONEXION' };
    }
    try { return await r.json(); } catch (_) { return { ok: false, error: 'Respuesta inválida del servidor (' + r.status + ')', code: 'INTERNO' }; }
  }
  function store(t) { access = t.access_token; localStorage.setItem(RT_KEY, t.refresh_token); }
  function clear() { access = null; localStorage.removeItem(RT_KEY); }
  let refreshing = null;
  async function refresh() {
    const rt = localStorage.getItem(RT_KEY);
    if (!rt) return false;
    if (!refreshing) {
      refreshing = req('/api/auth/refresh', { refresh_token: rt }).then((r) => { refreshing = null; if (r.ok) { store(r.data); return true; } if (r.code !== 'SIN_CONEXION') clear(); return false; });
    }
    return refreshing;
  }
  // Llamada autenticada con reintento tras renovar el token de acceso
  async function authed(path, body, method) {
    if (!access) await refresh();
    let r = await req(path, body, { auth: true, method });
    if (!r.ok && r.code === 'NO_AUTENTICADO' && await refresh()) r = await req(path, body, { auth: true, method });
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
        if (!access && !(await refresh())) return { ok: true, data: null };
        const r = await authed('/api/auth/me', null, 'GET');
        return r.ok ? r : { ok: true, data: null };
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

  window.coop = {
    web: true,
    call,
    superCall: (method, args) => authed('/api/super/' + encodeURIComponent(method), args || {}),
    info: async () => ({ version: 'web', dbPath: 'Servidor', platform: 'web' }),
    nfcStatus: async () => ({ available: 'NDEFReader' in window, message: 'NDEFReader' in window ? 'Web NFC disponible (toque "Leer con NFC del teléfono")' : 'Lector USB tipo teclado' }),
    onNfcUid: (cb) => { listeners.uid.add(cb); return () => listeners.uid.delete(cb); },
    onNfcStatus: (cb) => { listeners.status.add(cb); return () => listeners.status.delete(cb); },
    startWebNfc,
    backup: async () => ({ ok: false, error: 'Los respaldos del servidor se hacen en el servidor (ver README)' }),
    // Descarga del respaldo completo de la base (solo superadministrador)
    downloadBackup: async () => {
      if (!access) await refresh();
      const get = () => fetch('/api/super-backup', { headers: { Authorization: 'Bearer ' + access } });
      let r;
      try { r = await get(); if (r.status === 401 && await refresh()) r = await get(); } catch (_) { return { ok: false, error: 'Sin conexión con el servidor' }; }
      if (!r.ok) { try { return await r.json(); } catch (_) { return { ok: false, error: 'No se pudo descargar (' + r.status + ')' }; } }
      const blob = await r.blob();
      const m = /filename="?([^";]+)"?/.exec(r.headers.get('Content-Disposition') || '');
      const name = m ? m[1] : 'respaldo-cooperativa.db';
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
      return { ok: true, data: { name, bytes: blob.size } };
    },
    openDataFolder: async () => ({ ok: false }),
    auth: {
      forgot: (identifier) => req('/api/auth/forgot', { identifier }),
      reset: (token, password) => req('/api/auth/reset', { token, password }),
      register: async (data) => { const r = await req('/api/auth/register', data); if (r.ok) { store(r.data); return { ok: true, data: r.data.user }; } return r; },
      redeem: (code) => authed('/api/auth/redeem', { code }),
      logoutAll: async () => { const r = await authed('/api/auth/logout-all', {}); clear(); return r; },
      createTutor: (data) => authed('/api/admin/tutors', data),
      createInvitation: (child_id) => authed('/api/admin/invitations', { child_id }),
      listInvitations: () => authed('/api/admin/invitations', null, 'GET'),
    },
  };
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
