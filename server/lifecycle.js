'use strict';
// Tareas extra al apagar el servidor (por ejemplo, el último respaldo de la sesión de WhatsApp y cerrar WAHA).
// server/index.js las corre en paralelo con la última copia de la base, con el mismo tiempo límite.
const hooks = [];
function onShutdown(fn) { hooks.push(fn); }
function runShutdownHooks() { return Promise.all(hooks.map((fn) => Promise.resolve().then(fn).catch((e) => console.error('[apagado]', e && e.message)))); }
module.exports = { onShutdown, runShutdownHooks };
