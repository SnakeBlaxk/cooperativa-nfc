'use strict';
// Página pública /privacidad: convierte docs/aviso-privacidad.md (fuente única) a HTML sencillo.
const fs = require('fs');
const path = require('path');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[COMPLETAR([^\]]*)\]/g, '<mark>[COMPLETAR$1]</mark>');
function mdToHtml(md) {
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of md.split('\n')) {
    let m;
    if ((m = line.match(/^(#{1,3}) (.*)/))) { close(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
    else if ((m = line.match(/^- (.*)/))) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = line.match(/^\d+\. (.*)/))) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!line.trim()) close();
    else { close(); out.push(`<p>${inline(line)}</p>`); }
  }
  close(); return out.join('\n');
}
let cache = null;
function privacyPage() {
  if (cache) return cache;
  const md = fs.readFileSync(path.join(__dirname, '..', 'docs', 'aviso-privacidad.md'), 'utf8');
  cache = `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aviso de privacidad — Zuki Pay</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:0 auto;padding:24px 18px 60px;color:#1b2a3a;line-height:1.55;background:#f7fafc}h1{color:#0d2b4a}h2{color:#0f766e;margin-top:28px}mark{background:#fff3bf}a{color:#0f766e}</style></head>
<body><p><a href="/">← Volver a Zuki Pay</a></p>${mdToHtml(md)}</body></html>`;
  return cache;
}
module.exports = { privacyPage, mdToHtml };
