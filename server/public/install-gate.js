// Pantalla "Instala Zuki Pay" (como Xbox Cloud Gaming): en celulares y tabletas (iPhone, iPad —incluido iPadOS
// que se reporta como Mac con pantalla táctil— y Android) la app solo se usa INSTALADA (pantalla de inicio).
// Si se abre en el navegador, se muestra una pantalla completa con instrucciones según el equipo.
// * Computadoras y la app de escritorio (Electron): sin pantalla de instalación.
// * Al instalar (evento appinstalled) o al abrir desde el ícono (display-mode standalone / navigator.standalone): desaparece.
// * Pruebas: agregar ?nogate=1 a la URL la omite durante esa pestaña (sessionStorage). No hay otro modo de saltarla.
(function (root) {
  'use strict';
  function detect(env) {
    const ua = env.ua || ''; const touch = env.maxTouchPoints || 0;
    if (/Electron\//.test(ua)) return { mobile: false };
    const ipadOS = /Macintosh/.test(ua) && touch > 1;
    const ios = /iPhone|iPad|iPod/.test(ua) || ipadOS;
    const android = /Android/.test(ua);
    if (!ios && !android) return { mobile: false };
    if (ios) {
      const other = /CriOS|FxiOS|EdgiOS|OPiOS|GSA\/|YaBrowser|DuckDuckGo|FBAN|FBAV|Instagram|Line\//.test(ua);
      const m = ua.match(/OS (\d+)[_.](\d+)/); const v = m ? +m[1] + +m[2] / 100 : (ipadOS ? 99 : 0);
      return { mobile: true, platform: 'ios', safari: !other && /Safari\//.test(ua), shareCapable: v >= 16.04 };
    }
    const chrome = /Chrome\//.test(ua) && !/EdgA|OPR|SamsungBrowser|Firefox|YaBrowser|UCBrowser|MiuiBrowser|HuaweiBrowser|; wv\)/.test(ua);
    return { mobile: true, platform: 'android', chrome };
  }
  function shouldGate(env) {
    if (env.standalone || env.nogate) return false;
    return detect(env).mobile;
  }
  const api = { detect, shouldGate };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.ZukiInstallGate = api;

  const w = root; const d = w.document;
  const qs = new URLSearchParams(w.location.search);
  try { if (qs.get('nogate') === '1') sessionStorage.setItem('zp-nogate', '1'); } catch (_) {}
  let nogate = false; try { nogate = sessionStorage.getItem('zp-nogate') === '1'; } catch (_) {}
  const isStandalone = () => !!(w.matchMedia && (w.matchMedia('(display-mode: standalone)').matches || w.matchMedia('(display-mode: fullscreen)').matches || w.matchMedia('(display-mode: minimal-ui)').matches)) || w.navigator.standalone === true;
  const env = () => ({ ua: w.navigator.userAgent, maxTouchPoints: w.navigator.maxTouchPoints, standalone: isStandalone(), nogate });
  if (!shouldGate(env())) return;
  const info = detect(env());
  let deferred = null;

  const SHARE = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="#1E7BF2" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H6v10h12V10h-2" fill="none" stroke="#1E7BF2" stroke-width="2" stroke-linejoin="round"/></svg>';
  const ADD = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" fill="none" stroke="#16224A" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="#16224A" stroke-width="2" stroke-linecap="round"/></svg>';
  const DOTS = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="#16224A"/><circle cx="12" cy="12" r="2" fill="#16224A"/><circle cx="12" cy="19" r="2" fill="#16224A"/></svg>';
  const PHONE = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="6" y="2.5" width="12" height="19" rx="2.5" fill="none" stroke="#16224A" stroke-width="2"/><rect x="9" y="7" width="6" height="6" rx="1.5" fill="#2EE6B6"/></svg>';
  const DL = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14" fill="none" stroke="#16224A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const step = (n, icon, html) => `<li class="ig-step"><span class="ig-n">${n}</span><span class="ig-ico">${icon}</span><span class="ig-t">${html}</span></li>`;
  const copyBtn = '<button type="button" class="ig-btn ig-sec" id="ig-copy">📋 Copiar enlace</button>';

  function content() {
    if (info.platform === 'ios') {
      if (info.safari || info.shareCapable) {
        const where = info.safari ? 'abajo (o arriba en iPad)' : 'en la barra del navegador';
        return `<p class="ig-sub">Así se instala en tu iPhone o iPad:</p><ol class="ig-steps">
          ${step(1, SHARE, `Toca el botón <b>Compartir</b> ${where}.`)}
          ${step(2, ADD, 'Busca y toca <b>“Agregar a pantalla de inicio”</b>. Si no lo ves, desliza hacia abajo.')}
          ${step(3, PHONE, 'Toca <b>Agregar</b> y abre <b>Zuki Pay</b> desde el nuevo ícono.')}</ol>
          ${info.safari ? '' : '<p class="ig-note">¿No aparece la opción? Copia el enlace y ábrelo en <b>Safari</b>.</p>' + copyBtn}`;
      }
      return `<p class="ig-sub">Para instalar Zuki Pay necesitas abrirla en <b>Safari</b>:</p><ol class="ig-steps">
        ${step(1, '📋', 'Toca <b>“Copiar enlace”</b> aquí abajo.')}
        ${step(2, '🧭', 'Abre <b>Safari</b> y pega el enlace en la barra de direcciones.')}
        ${step(3, SHARE, 'Toca <b>Compartir</b> y luego <b>“Agregar a pantalla de inicio”</b>.')}</ol>${copyBtn}`;
    }
    if (info.chrome) {
      return `<button type="button" class="ig-btn" id="ig-install" hidden>⬇️ Instalar Zuki Pay</button>
        <div id="ig-manual"><p class="ig-sub">Así se instala en tu celular Android:</p><ol class="ig-steps">
        ${step(1, DOTS, 'Toca los <b>tres puntitos</b> arriba a la derecha.')}
        ${step(2, DL, 'Toca <b>“Instalar app”</b> o <b>“Agregar a pantalla principal”</b>.')}
        ${step(3, PHONE, 'Confirma y abre <b>Zuki Pay</b> desde el nuevo ícono.')}</ol></div>`;
    }
    return `<p class="ig-sub">Para instalar Zuki Pay te recomendamos usar <b>Google Chrome</b>:</p><ol class="ig-steps">
      ${step(1, '📋', 'Toca <b>“Copiar enlace”</b> aquí abajo.')}
      ${step(2, '🌐', 'Abre <b>Chrome</b> y pega el enlace.')}
      ${step(3, DOTS, 'Toca los <b>tres puntitos</b> y luego <b>“Instalar app”</b>.')}</ol>
      <p class="ig-note">En otros navegadores, busca en el menú la opción “Agregar a pantalla principal”.</p>${copyBtn}`;
  }

  let el = null;
  function show() {
    if (el || !d.body) return;
    el = d.createElement('div'); el.id = 'install-gate'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
    el.dataset.platform = info.platform;
    el.innerHTML = `<div class="ig-box"><img class="ig-logo" src="/logo-zukipay.png" alt="Zuki Pay">
      <h1 class="ig-title">Instala Zuki Pay para continuar</h1>
      <p class="ig-lead">Zuki Pay funciona como una app en tu ${info.platform === 'ios' ? 'iPhone o iPad' : 'celular o tableta'}. Es gratis y tarda un minuto.</p>
      ${content()}<p class="ig-msg" id="ig-msg" aria-live="polite"></p></div>`;
    d.body.appendChild(el); d.documentElement.classList.add('ig-lock');
    const copy = el.querySelector('#ig-copy');
    if (copy) copy.onclick = async () => {
      const url = w.location.origin + '/';
      let ok = false; try { await w.navigator.clipboard.writeText(url); ok = true; } catch (_) {
        try { const t = d.createElement('textarea'); t.value = url; d.body.appendChild(t); t.select(); ok = d.execCommand('copy'); t.remove(); } catch (_) {}
      }
      el.querySelector('#ig-msg').textContent = ok ? '✅ Enlace copiado. Pégalo en el navegador.' : 'Copia este enlace: ' + url;
    };
    const ib = el.querySelector('#ig-install');
    if (ib) ib.onclick = async () => {
      if (!deferred) return; deferred.prompt();
      try { const r = await deferred.userChoice; if (r && r.outcome === 'accepted') el.querySelector('#ig-msg').textContent = 'Instalando… abre Zuki Pay desde el nuevo ícono.'; } catch (_) {}
      deferred = null; ib.hidden = true; el.querySelector('#ig-manual').hidden = false;
    };
    refreshInstall();
  }
  function refreshInstall() {
    if (!el) return; const ib = el.querySelector('#ig-install'); const man = el.querySelector('#ig-manual');
    if (ib) { ib.hidden = !deferred; if (man) man.hidden = !!deferred; }
  }
  function hide() { if (el) { el.remove(); el = null; } d.documentElement.classList.remove('ig-lock'); }
  w.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; refreshInstall(); });
  w.addEventListener('appinstalled', () => { deferred = null; hide(); });
  if (w.matchMedia) { const mq = w.matchMedia('(display-mode: standalone)'); const f = (e) => { if (e.matches) hide(); }; if (mq.addEventListener) mq.addEventListener('change', f); }
  if (d.body) show(); else d.addEventListener('DOMContentLoaded', show);
})(typeof window !== 'undefined' ? window : globalThis);
