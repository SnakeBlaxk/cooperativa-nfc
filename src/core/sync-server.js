'use strict';
// Sincronización — lado SERVIDOR.
// Reglas:
//  * El escritorio es la fuente de verdad de movimientos (compras/recargas/ajustes, incl. rechazados),
//    saldos, tarjetas, alumnos (datos base), productos y categorías: el servidor los guarda tal cual (upsert por UUID).
//  * El servidor gana en ajustes del tutor: límites, prohibiciones, bloqueo de tarjeta, perfil del alumno
//    y vínculo tutor-alumno. Si un ajuste cambió en el servidor después del último "pull" del equipo,
//    el valor enviado por el equipo se ignora.
//  * Un solo equipo "principal" por escuela puede enviar datos (evita saldos contradictorios entre cajas).
//  * Multi-escuela: cada equipo pertenece a UNA escuela (la del administrador que lo vinculó);
//    todo lo que envía o descarga queda limitado a esa escuela. Los UID de tarjeta son únicos en la plataforma.
//  * Todo es idempotente: reenviar el mismo lote no duplica nada.
const crypto = require('crypto');
const { AppError, fmtLocal } = require('./service');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const isUuid = (u) => typeof u === 'string' && /^[0-9a-f]{32}$/.test(u);

function createSyncServer(db, opts = {}) {
  const ts = () => fmtLocal(new Date());
  const primaryOf = (sid) => { const r = db.get('SELECT primary_device_id AS p FROM schools WHERE id = ?', [sid]); return r ? r.p : null; };
  const setPrimaryOf = (sid, dev) => db.run('UPDATE schools SET primary_device_id = ? WHERE id = ?', [dev, sid]);
  const idBy = (table, uuid, sid) => { if (!uuid) return null; const r = db.get(`SELECT id FROM ${table} WHERE uuid = ? AND school_id = ?`, [uuid, sid]); return r ? r.id : null; };
  const uuidBy = (table, id) => { if (!id) return null; const r = db.get(`SELECT uuid FROM ${table} WHERE id = ?`, [id]); return r ? r.uuid : null; };
  const takenElsewhere = (table, uuid, sid) => !!db.get(`SELECT 1 AS x FROM ${table} WHERE uuid = ? AND school_id IS NOT ?`, [uuid, sid]);
  // Escuela sobre la que actúa: admin → la suya; superadmin → la indicada
  function schoolOf(a, schoolId) {
    if (a && a.role === 'admin' && a.school_id) return Number(a.school_id);
    if (a && a.role === 'superadmin') {
      if (!schoolId || !db.get('SELECT id FROM schools WHERE id = ?', [Number(schoolId)])) throw new AppError('Escuela no encontrada', 'NO_ENCONTRADO');
      return Number(schoolId);
    }
    throw new AppError('Solo el administrador puede administrar equipos', 'PROHIBIDO');
  }

  function recordChange(entity, keyUuid, originDevice = null) {
    if (!keyUuid) return;
    const r = entity === 'card_status' ? db.get('SELECT school_id FROM cards WHERE uuid = ?', [keyUuid]) : db.get('SELECT school_id FROM children WHERE uuid = ?', [keyUuid]);
    db.run('INSERT INTO sync_changes (entity, key_uuid, origin_device, school_id) VALUES (?,?,?,?)', [entity, keyUuid, originDevice, r ? r.school_id : null]);
  }
  const recordChild = (entity, childId, origin) => recordChange(entity, uuidBy('children', childId), origin);
  const recordCard = (cardId, origin) => recordChange('card_status', uuidBy('cards', cardId), origin);

  // ----- equipos -----
  function registerDevice(actor, { device_id, name }) {
    const sid = schoolOf(actor);
    if (!isUuid(device_id)) throw new AppError('Identificador de equipo inválido', 'VALIDACION');
    const prev = db.get('SELECT school_id FROM devices WHERE id = ?', [device_id]);
    if (prev && prev.school_id !== null && prev.school_id !== sid) throw new AppError('Este equipo ya estuvo vinculado a otra escuela. Usa una base de datos nueva en este equipo para vincularlo aquí.', 'VALIDACION');
    const nm = String(name || 'Equipo de escritorio').slice(0, 80);
    const token = crypto.randomBytes(32).toString('base64url');
    db.run(`INSERT INTO devices (id, school_id, name, token_hash, created_by, created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, token_hash = excluded.token_hash, revoked = 0, school_id = excluded.school_id`, [device_id, sid, nm, sha256(token), actor.id, ts()]);
    const sc = db.get('SELECT uuid, name FROM schools WHERE id = ?', [sid]);
    return { device_id, device_token: token, primary_device: primaryOf(sid), school_uuid: sc.uuid, school_name: sc.name };
  }
  function authDevice(token) {
    const d = db.get(`SELECT d.*, s.status AS school_status, s.name AS school_name, s.uuid AS school_uuid FROM devices d JOIN schools s ON s.id = d.school_id
      WHERE d.token_hash = ? AND d.revoked = 0`, [sha256(token || '')]);
    if (!d) throw new AppError('Equipo no autorizado o revocado', 'NO_AUTENTICADO');
    if (d.school_status === 'suspendida') throw new AppError('El servicio de esta escuela está suspendido. Comunícate con Zuki Company.', 'ESCUELA_SUSPENDIDA');
    db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', [ts(), d.id]);
    return d;
  }
  function listDevices(actor, schoolId) {
    const sid = schoolOf(actor, schoolId);
    const p = primaryOf(sid);
    return db.all('SELECT id, name, revoked, last_seen_at, created_at FROM devices WHERE school_id = ? ORDER BY created_at', [sid]).map((d) => ({ ...d, primary: d.id === p }));
  }
  function revokeDevice(actor, id, schoolId) {
    const sid = schoolOf(actor, schoolId);
    const r = db.run('UPDATE devices SET revoked = 1 WHERE id = ? AND school_id = ?', [id, sid]);
    if (!r.changes) throw new AppError('Equipo no encontrado', 'NO_ENCONTRADO');
    if (primaryOf(sid) === id) setPrimaryOf(sid, null);
    return { ok: true };
  }
  function setPrimary(actor, id, schoolId) {
    const sid = schoolOf(actor, schoolId);
    if (!db.get('SELECT id FROM devices WHERE id = ? AND revoked = 0 AND school_id = ?', [id, sid])) throw new AppError('Equipo no encontrado', 'NO_ENCONTRADO');
    setPrimaryOf(sid, id);
    return { ok: true, primary_device: id };
  }
  const isSynced = (schoolId) => !!(schoolId && primaryOf(schoolId));

  // ¿Cambió este ajuste en el servidor (por otro origen) después del último pull del equipo?
  function serverNewer(entity, key, pulledCursor, deviceId) { // las claves (uuid) ya se validaron dentro de la escuela
    return !!db.get('SELECT 1 AS x FROM sync_changes WHERE entity = ? AND key_uuid = ? AND seq > ? AND (origin_device IS NULL OR origin_device <> ?)',
      [entity, key, Number(pulledCursor) || 0, deviceId]);
  }

  // ----- push: el equipo envía sus datos -----
  function push(device, payload) {
    const sid = device.school_id;
    const primary = primaryOf(sid);
    if (primary && primary !== device.id) {
      throw new AppError('Otro equipo es el principal de este servidor. Un administrador puede cambiarlo desde Ajustes.', 'OTRO_EQUIPO_PRINCIPAL');
    }
    const e = (payload && payload.entities) || {};
    const cursor = Number(payload && payload.pulled_cursor) || 0;
    const stats = { categories: 0, products: 0, children: 0, cards: 0, limits: 0, prohibitions: 0, transactions: 0, duplicates: 0, conflicts_server_wins: 0, uid_conflicts: [] };
    const guard = (table, uuid) => { if (!isUuid(uuid)) throw new AppError('UUID inválido', 'VALIDACION'); if (takenElsewhere(table, uuid, sid)) throw new AppError('Identificador usado por otra escuela', 'CONFLICTO'); };
    const need = (table, uuid, what) => { const id = idBy(table, uuid, sid); if (!id) throw new AppError(`Referencia faltante (${what} ${uuid})`, 'REFERENCIA_FALTANTE'); return id; };
    const t0 = ts();
    db.transaction(() => {
      if (!primary) setPrimaryOf(sid, device.id);
      for (const c of e.categories || []) {
        guard('categories', c.uuid);
        let id = idBy('categories', c.uuid, sid);
        if (!id) { const same = db.get('SELECT id FROM categories WHERE name = ? AND school_id = ?', [c.name, sid]); if (same) { db.run('UPDATE categories SET uuid = ? WHERE id = ?', [c.uuid, same.id]); id = same.id; } }
        if (id) db.run('UPDATE categories SET name = ? WHERE id = ?', [c.name, id]);
        else db.run('INSERT INTO categories (uuid, school_id, name) VALUES (?,?,?)', [c.uuid, sid, c.name]);
        stats.categories++;
      }
      for (const p of e.products || []) {
        guard('products', p.uuid);
        const cat = need('categories', p.category_uuid, 'categoría');
        const id = idBy('products', p.uuid, sid);
        if (id) db.run('UPDATE products SET name=?, category_id=?, price_cents=?, active=? WHERE id=?', [p.name, cat, p.price_cents, p.active ? 1 : 0, id]);
        else db.run('INSERT INTO products (uuid, school_id, name, category_id, price_cents, active, created_at) VALUES (?,?,?,?,?,?,?)', [p.uuid, sid, p.name, cat, p.price_cents, p.active ? 1 : 0, p.created_at || t0]);
        stats.products++;
      }
      for (const c of e.children || []) {
        guard('children', c.uuid);
        const id = idBy('children', c.uuid, sid);
        if (id) {
          if (serverNewer('child_profile', c.uuid, cursor, device.id)) { db.run('UPDATE children SET active=? WHERE id=?', [c.active ? 1 : 0, id]); stats.conflicts_server_wins++; }
          else db.run('UPDATE children SET full_name=?, grade=?, photo=?, active=? WHERE id=?', [c.full_name, c.grade, c.photo, c.active ? 1 : 0, id]);
        } else {
          db.run('INSERT INTO children (uuid, school_id, tutor_id, full_name, grade, photo, active, created_at) VALUES (?,?,NULL,?,?,?,?,?)', [c.uuid, sid, c.full_name, c.grade, c.photo, c.active ? 1 : 0, c.created_at || t0]);
        }
        stats.children++;
      }
      for (const k of e.cards || []) {
        if (!isUuid(k.uuid)) throw new AppError('UUID inválido', 'VALIDACION');
        const child = k.child_uuid ? need('children', k.child_uuid, 'alumno') : null;
        // UID ya registrado en OTRA escuela: no se acepta (únicos en la plataforma)
        const owner = db.get('SELECT id, school_id FROM cards WHERE uid = ? OR uuid = ?', [k.uid, k.uuid]);
        if (owner && owner.school_id !== sid) { stats.uid_conflicts.push(k.uid); continue; }
        let id = idBy('cards', k.uuid, sid);
        if (!id) { const same = db.get('SELECT id FROM cards WHERE uid = ? AND school_id = ?', [k.uid, sid]); if (same) { db.run('UPDATE cards SET uuid = ? WHERE id = ?', [k.uuid, same.id]); id = same.id; } }
        if (id) {
          const cur = db.get('SELECT status, blocked_by FROM cards WHERE id = ?', [id]);
          let status = k.status; let blockedBy = k.blocked_by;
          // Bloqueo hecho por el tutor en el servidor gana, salvo que la caja la reporte perdida
          if (k.status !== 'perdida' && serverNewer('card_status', k.uuid, cursor, device.id)) { status = cur.status; blockedBy = cur.blocked_by; stats.conflicts_server_wins++; }
          else if (cur.status !== status) recordChange('card_status', k.uuid, device.id);
          db.run('UPDATE cards SET uid=?, child_id=?, status=?, blocked_by=?, balance_cents=? WHERE id=?', [k.uid, child, status, blockedBy, k.balance_cents, id]);
        } else {
          db.run('INSERT INTO cards (uuid, school_id, uid, child_id, status, balance_cents, blocked_by, created_at) VALUES (?,?,?,?,?,?,?,?)', [k.uuid, sid, k.uid, child, k.status, k.balance_cents, k.blocked_by, k.created_at || t0]);
        }
        stats.cards++;
      }
      for (const l of e.limits || []) {
        const child = need('children', l.child_uuid, 'alumno');
        if (serverNewer('limits', l.child_uuid, cursor, device.id)) { stats.conflicts_server_wins++; continue; }
        db.run(`INSERT INTO limits (child_id, per_transaction_cents, per_day_cents, period_type, per_period_cents, updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(child_id) DO UPDATE SET per_transaction_cents=excluded.per_transaction_cents, per_day_cents=excluded.per_day_cents,
          period_type=excluded.period_type, per_period_cents=excluded.per_period_cents, updated_at=excluded.updated_at`,
        [child, l.per_transaction_cents, l.per_day_cents, l.period_type, l.per_period_cents, t0]);
        recordChange('limits', l.child_uuid, device.id);
        stats.limits++;
      }
      for (const p of e.prohibitions || []) {
        const child = need('children', p.child_uuid, 'alumno');
        if (serverNewer('prohibitions', p.child_uuid, cursor, device.id)) { stats.conflicts_server_wins++; continue; }
        db.run('DELETE FROM prohibited_products WHERE child_id = ?', [child]);
        db.run('DELETE FROM prohibited_categories WHERE child_id = ?', [child]);
        for (const u of p.product_uuids || []) { const pid = idBy('products', u, sid); if (pid) db.run('INSERT OR IGNORE INTO prohibited_products (child_id, product_id) VALUES (?,?)', [child, pid]); }
        for (const u of p.category_uuids || []) { const cid = idBy('categories', u, sid); if (cid) db.run('INSERT OR IGNORE INTO prohibited_categories (child_id, category_id) VALUES (?,?)', [child, cid]); }
        recordChange('prohibitions', p.child_uuid, device.id);
        stats.prohibitions++;
      }
      for (const t of e.transactions || []) {
        if (!isUuid(t.uuid)) throw new AppError('UUID inválido', 'VALIDACION');
        if (idBy('transactions', t.uuid, sid)) { stats.duplicates++; continue; } // idempotente: los movimientos no cambian
        guard('transactions', t.uuid);
        // Si la tarjeta se rechazó por UID de otra escuela, el movimiento se guarda sin vínculo a tarjeta
        const foreignCard = t.card_uuid && !idBy('cards', t.card_uuid, sid) && db.get('SELECT 1 AS x FROM cards WHERE uid = ? AND school_id IS NOT ?', [t.card_uid, sid]);
        const card = t.card_uuid && !foreignCard ? need('cards', t.card_uuid, 'tarjeta') : null;
        const child = t.child_uuid ? need('children', t.child_uuid, 'alumno') : null;
        const r = db.run(`INSERT INTO transactions (uuid, school_id, type, status, reason, amount_cents, balance_after_cents, card_id, card_uid, child_id, user_id, processed_by_name, note, origin_device, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,?)`, [t.uuid, sid, t.type, t.status, t.reason, t.amount_cents, t.balance_after_cents, card, t.card_uid, child, t.processed_by_name, t.note, device.id, t.created_at]);
        for (const it of t.items || []) {
          db.run(`INSERT INTO transaction_items (transaction_id, product_id, product_name, category_name, qty, unit_price_cents, subtotal_cents) VALUES (?,?,?,?,?,?,?)`,
            [r.lastId, idBy('products', it.product_uuid, sid), it.product_name, it.category_name, it.qty, it.unit_price_cents, it.subtotal_cents]);
        }
        stats.transactions++;
      }
    });
    return { ok: true, stats, server_time: t0 };
  }

  // ----- pull: el equipo descarga ajustes del servidor -----
  function pull(device, sinceCursor) {
    const since = Number(sinceCursor) || 0;
    const sid = device.school_id;
    const rows = db.all('SELECT entity, key_uuid, MAX(seq) AS seq FROM sync_changes WHERE seq > ? AND school_id = ? AND (origin_device IS NULL OR origin_device <> ?) GROUP BY entity, key_uuid ORDER BY seq',
      [since, sid, device.id]);
    const max = db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM sync_changes').m;
    const changes = [];
    for (const r of rows) {
      const u = r.key_uuid;
      if (r.entity === 'card_status') {
        const k = db.get('SELECT status, blocked_by FROM cards WHERE uuid = ? AND school_id = ?', [u, sid]);
        if (k) changes.push({ entity: 'card_status', card_uuid: u, status: k.status, blocked_by: k.blocked_by });
        continue;
      }
      const c = db.get('SELECT * FROM children WHERE uuid = ? AND school_id = ?', [u, sid]);
      if (!c) continue;
      if (r.entity === 'limits') {
        const l = db.get('SELECT per_transaction_cents, per_day_cents, period_type, per_period_cents FROM limits WHERE child_id = ?', [c.id])
          || { per_transaction_cents: null, per_day_cents: null, period_type: null, per_period_cents: null };
        changes.push({ entity: 'limits', child_uuid: u, ...l });
      } else if (r.entity === 'prohibitions') {
        changes.push({
          entity: 'prohibitions', child_uuid: u,
          product_uuids: db.all('SELECT p.uuid FROM prohibited_products x JOIN products p ON p.id = x.product_id WHERE x.child_id = ?', [c.id]).map((x) => x.uuid),
          category_uuids: db.all('SELECT k.uuid FROM prohibited_categories x JOIN categories k ON k.id = x.category_id WHERE x.child_id = ?', [c.id]).map((x) => x.uuid),
        });
      } else if (r.entity === 'child_profile') {
        changes.push({ entity: 'child_profile', child_uuid: u, full_name: c.full_name, grade: c.grade, photo: c.photo });
      } else if (r.entity === 'child_link') {
        const t = c.tutor_id ? db.get('SELECT uuid, username, full_name, email, phone, active FROM users WHERE id = ?', [c.tutor_id]) : null;
        changes.push({ entity: 'child_link', child_uuid: u, tutor: t });
      }
    }
    return { cursor: max, changes };
  }

  return { registerDevice, authDevice, listDevices, revokeDevice, setPrimary, isSynced, push, pull, recordChange, recordChild, recordCard };
}

module.exports = { createSyncServer };
