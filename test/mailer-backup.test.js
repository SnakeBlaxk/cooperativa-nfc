'use strict';
// Correo real (Resend) y respaldos: copia local verificada y subida S3/Backblaze.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server/app');
const { createMailer, createResendMailer } = require('../src/core/mailer');
const { createBackupService, verifySqliteBackup, signS3Put, s3TargetFromEnv } = require('../server/persist');
const { openDatabase } = require('../src/core/db');

test('sin llaves el correo queda en consola y no se marca como enviado', async () => {
  const m = createMailer({ NODE_ENV: 'test' }, { log() {} });
  assert.equal(m.configured, false);
  assert.equal(m.status().provider, 'consola');
  const r = await m.send({ to: 'a@b.mx', subject: 'Hola', text: 'clave' });
  assert.equal(r.skipped, true);
  assert.equal(m.outbox.length, 1);
});

test('Resend: envía al correo, omite teléfonos y reporta un rechazo del proveedor', async () => {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    calls.push({ url, auth: opt.headers.Authorization, body: JSON.parse(opt.body) });
    if (calls.length === 1) return { ok: true, json: async () => ({ id: 're_1' }), text: async () => '' };
    return { ok: false, status: 422, json: async () => ({}), text: async () => 'dominio' };
  };
  const m = createResendMailer({ apiKey: 're_test', from: 'Zuki Pay <avisos@zuki.test>', fetchImpl, log: { error() {} } });
  assert.equal(m.status().configured, true);
  const ok = await m.send({ to: 'laura@example.com', subject: 'Tu contraseña de Zuki Pay', text: 'clave secreta' });
  assert.equal(ok.ok, true); assert.equal(ok.id, 're_1');
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.equal(calls[0].auth, 'Bearer re_test');
  assert.deepEqual(calls[0].body.to, ['laura@example.com']);
  assert.match(calls[0].body.text, /clave secreta/);
  const skip = await m.send({ to: '4431112233', channel: 'sms', subject: 'x', text: 'y' });
  assert.equal(skip.skipped, true); assert.equal(calls.length, 1);
  const bad = await m.send({ to: 'otra@example.com', subject: 'x', text: 'y' });
  assert.equal(bad.ok, false); assert.equal(bad.status, 422);
});

test('alta de tutor y alerta alta salen por Resend; una alerta baja no', async () => {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    calls.push(JSON.parse(opt.body));
    return { ok: true, json: async () => ({ id: 're_' + calls.length }), text: async () => '' };
  };
  const mailer = createResendMailer({ apiKey: 're_test', from: 'Zuki Pay <avisos@zuki.test>', fetchImpl, log: { error() {} } });
  const S = await createServer({ cardStock: false, jwtSecret: 'm'.repeat(40), mailer, billingSweepMs: 0, env: { ALERT_EMAIL: 'aviso@zuki.test', APP_URL: 'https://zuki.test' } });
  const admin = S.svc.login('admin', 'admin123');
  const r = await S.auth.createTutorAccount(admin, { full_name: 'Laura Gómez', email: 'laura@example.com' });
  assert.equal(r.emailed, true);
  assert.equal(calls[0].to[0], 'laura@example.com');
  assert.match(calls[0].text, new RegExp(r.temporary_password));
  assert.match(calls[0].text, /https:\/\/zuki\.test/);
  calls.length = 0;
  S.security.alert({ kind: 'recarga_grande', severity: 'alta', message: 'Revisar recarga grande de $1,200' });
  S.security.alert({ kind: 'ruido', severity: 'baja', message: 'esto no se envía' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to[0], 'aviso@zuki.test');
  assert.match(calls[0].subject, /alerta/);
  assert.match(calls[0].text, /Revisar recarga grande/);
});

test('la firma S3 es estable y las variables incompletas no arman destino', () => {
  const now = new Date('2013-05-24T00:00:00Z');
  const body = Buffer.from('abc');
  const a = signS3Put({ url: 'https://s3.example.com/cubeta/zuki-pay/ultimo.db', body, region: 'us-east-1', accessKey: 'AKIAEXAMPLE', secretKey: 'secreto', now });
  const b = signS3Put({ url: 'https://s3.example.com/cubeta/zuki-pay/ultimo.db', body, region: 'us-east-1', accessKey: 'AKIAEXAMPLE', secretKey: 'secreto', now });
  assert.equal(a.Authorization, b.Authorization);
  assert.match(a.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20130524\/us-east-1\/s3\/aws4_request/);
  assert.equal(a['x-amz-date'], '20130524T000000Z');
  assert.equal(s3TargetFromEnv({}), null);
  assert.equal(s3TargetFromEnv({ BACKUP_S3_ENDPOINT: 'https://s3.example.com', BACKUP_S3_BUCKET: 'cubeta' }), null);
});

test('respaldo: copia local que abre, poda a 14 días, y la nube no borra la copia si falla', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-bak-'));
  const db = await openDatabase(path.join(dir, 'viva.db'));
  db.run("INSERT INTO schools (name, created_at) VALUES ('Escuela', '2026-01-01')");
  db.run("INSERT INTO users (username, password_hash, role, full_name, created_at) VALUES ('zuki','x','superadmin','Zuki','2026-01-01')");
  for (let i = 1; i <= 16; i++) {
    const name = `servidor-2020-01-${String(i).padStart(2, '0')}.db`;
    fs.writeFileSync(path.join(dir, name), Buffer.from('viejo'));
  }
  const puts = [];
  const fetchImpl = async (url, opt) => {
    puts.push({ url, len: opt.body.length, auth: opt.headers.Authorization });
    if (puts.length <= 2) return { ok: true, text: async () => '' };
    return { ok: false, status: 403, text: async () => 'AccessDenied' };
  };
  const remote = { endpoint: 'https://s3.example.com', bucket: 'cubeta', region: 'us-east-1', accessKey: 'AKIA', secretKey: 'secreto', prefix: 'zuki-pay/', timeoutMs: 5000 };
  const svc = createBackupService(db, { dir, remote, fetchImpl, autostart: false, log: { error() {} } });
  const st = await svc.run();
  assert.equal(st.verified, true, st.verify_error);
  assert.equal(st.users, 1); assert.equal(st.schools, 1);
  assert.ok(fs.existsSync(path.join(dir, 'ultimo.db')));
  assert.ok(fs.existsSync(path.join(dir, st.last_file)));
  const dailies = fs.readdirSync(dir).filter((n) => /^servidor-\d{4}-\d{2}-\d{2}\.db$/.test(n));
  assert.ok(dailies.length <= 14, dailies.join(','));
  assert.equal(puts.length, 2);
  assert.match(puts[0].url, /https:\/\/s3\.example\.com\/cubeta\/zuki-pay\/ultimo\.db/);
  assert.ok(puts[0].len > 100);
  assert.match(puts[0].auth, /^AWS4-HMAC-SHA256 /);
  assert.ok(st.remote_ok_at); assert.equal(st.remote_error, null);
  const again = await svc.run();
  assert.equal(again.verified, true);
  assert.match(again.remote_error, /403/);
  assert.ok(fs.existsSync(path.join(dir, 'ultimo.db')));
  const bad = await verifySqliteBackup(Buffer.from('esto no es sqlite'));
  assert.equal(bad.ok, false);
  svc.stop();
  db.close();
});
