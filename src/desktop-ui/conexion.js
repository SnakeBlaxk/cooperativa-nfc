'use strict';
// Páginas locales de la caja: "Conectando…", "Sin conexión" y "Servidor…". Sin internet NO se puede cobrar.
(function () {
  const d = window.coopDesktop && window.coopDesktop.connection;
  const $ = (id) => document.getElementById(id);
  const mode = new URLSearchParams(location.search).get('modo') || 'conectando';
  ['conectando', 'sin-conexion', 'servidor'].forEach((m) => { $(m).hidden = m !== mode; });
  let st = null; let tick = null;
  function paint(s) {
    st = s || st; if (!st) return;
    document.querySelectorAll('[data-url]').forEach((el) => { el.textContent = st.serverUrl || ''; });
    if (mode === 'sin-conexion') {
      $('detalle').textContent = st.error ? 'Detalle: ' + st.error : '';
      clearInterval(tick);
      const upd = () => {
        if (st.state === 'conectando') { $('reintento').textContent = 'Comprobando conexión…'; return; }
        const secs = st.nextRetryAt ? Math.max(0, Math.ceil((st.nextRetryAt - Date.now()) / 1000)) : null;
        $('reintento').textContent = secs ? `Reintentando automáticamente en ${secs} s…` : 'Reintentando automáticamente…';
      };
      upd(); tick = setInterval(upd, 500);
    }
  }
  if (!d) return;
  d.onStatus(paint);
  d.status().then((s) => { paint(s); if (mode === 'servidor') $('url').value = s.serverUrl || ''; });
  if (mode === 'sin-conexion') {
    $('retry').addEventListener('click', () => { $('reintento').textContent = 'Comprobando conexión…'; d.retry(); });
    $('goconfig').addEventListener('click', () => { location.search = '?modo=servidor'; });
  }
  if (mode === 'servidor') {
    const msg = $('formmsg');
    const save = async (value) => {
      msg.className = 'small'; msg.textContent = 'Probando conexión…';
      const r = await d.setServerUrl(value);
      if (!r.ok) { msg.className = 'small err'; msg.textContent = r.error; return; }
      msg.className = 'small ' + (r.data.reachable ? 'ok' : 'err');
      msg.textContent = r.data.reachable ? 'Guardado. Conectando…' : 'Guardado, pero el servidor no responde. Se reintentará automáticamente.';
    };
    $('form').addEventListener('submit', (e) => { e.preventDefault(); save($('url').value); });
    $('default').addEventListener('click', () => save(null));
    $('cancel').addEventListener('click', () => d.retry());
    setTimeout(() => $('url').focus(), 50);
  }
})();
