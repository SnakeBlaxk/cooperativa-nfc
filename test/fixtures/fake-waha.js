#!/usr/bin/env node
'use strict';
// WAHA falso para probar server/start.js: escucha en PORT, exige X-Api-Key y anota su entorno.
const http = require('http');
const fs = require('fs');
const out = process.env.FAKE_WAHA_OUT;
const key = process.env.WAHA_API_KEY;
const srv = http.createServer((req, res) => {
  if (req.headers['x-api-key'] !== key) { res.writeHead(401); return res.end('{}'); }
  if (req.url.startsWith('/api/sessions/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'WORKING', me: { pushName: 'Fake' } })); }
  res.writeHead(404); res.end('{}');
});
srv.listen(Number(process.env.PORT), () => {
  const a = srv.address();
  fs.appendFileSync(out, JSON.stringify({ pid: process.pid, port: process.env.PORT, address: a.address, cwd: process.cwd(),
    hasTurso: !!process.env.TURSO_AUTH_TOKEN, hasJwt: !!process.env.JWT_SECRET, dashboard: process.env.WAHA_DASHBOARD_ENABLED,
    engine: process.env.WHATSAPP_DEFAULT_ENGINE, nodeOptions: process.env.NODE_OPTIONS }) + '\n');
});
process.on('SIGTERM', () => process.exit(0));
