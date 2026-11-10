'use strict';
// Se carga dentro de WAHA con NODE_OPTIONS=--require. WAHA (NestJS) escucha en todas las interfaces;
// esto fuerza que su puerto interno solo acepte conexiones locales (127.0.0.1). No toca otros puertos.
const net = require('net');
const port = Number(process.env.ZUKI_WAHA_BIND_PORT || 0);
if (port) {
  const orig = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    try {
      if ((typeof args[0] === 'number' || (typeof args[0] === 'string' && /^\d+$/.test(args[0]))) && Number(args[0]) === port) {
        const cb = args.find((a) => typeof a === 'function');
        return orig.call(this, { port, host: '127.0.0.1' }, cb);
      }
      if (args[0] && typeof args[0] === 'object' && Number(args[0].port) === port && !args[0].path) {
        return orig.call(this, { ...args[0], host: '127.0.0.1' }, ...args.slice(1));
      }
    } catch (_) { /* si algo raro pasa, se usa el listen original */ }
    return orig.apply(this, args);
  };
}
