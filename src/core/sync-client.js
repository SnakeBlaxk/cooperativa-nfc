'use strict';
// Sincronización — lado ESCRITORIO. Independiente de Electron (probado con node:test).
// Ciclo: 1) pull de ajustes del servidor (límites, prohibiciones, bloqueos, perfil y vínculo tutor)
//        2) push de la cola local (sync_outbox): movimientos, tarjetas/saldos, alumnos, productos, categorías,
//           y también límites/prohibiciones editados en la caja (el servidor decide si ganan).
// Si no hay internet, los cambios quedan en sync_outbox y se envían en el siguiente ciclo.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const CHUNK = 400;

function createSyncClient({ db, getConfig, fetchImpl = globalThis.fetch, timeoutMs = 15000, onStatus = () => {} }) {
  const meta = (k) => { const r = db.get('SELECT value FROM meta WHERE key = ?', [k]); return r ? r.value : null; };
  const setMeta = (k, v) => db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', [k, v === null ? null : String(v)]);
  const status = { state: 'desactivado', last_sync_at: null, last_error: null, pending: 0, is_primary: null, last_stats: null };
  let running = null;

  function deviceId() {
    let id = meta('device_id');
    if (!id) { id = crypto.randomBytes(16).toString('hex'); setMeta('device_id', id); }
    return id;
  }
  const pendingCount = () => db.get('SELECT COUNT(*) AS n FROM sync_outbox').n;
  function emit(patch) { Object.assign(status, patch, { pending: pendingCount() }); onStatus({ ...status }); }
  function getStatus() {
    const cfg = getConfig();
    if (!cfg.serverUrl || !cfg.deviceToken) status.state = status.state === 'sincronizando' ? status.state : 'desactivado';
    else if (status.state === 'desactivado') status.state = 'pendiente';
    return { ...status, pending: pendingCount(), last_sync_at: status.last_sync_at || meta('sync_last_at'), device_id: deviceId(), server_url: cfg.serverUrl || null, linked: !!cfg.deviceToken, school_name: meta('linked_school_name') };
  }

  async function http(cfg, method, path, body, headers = {}) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(cfg.serverUrl.replace(/\/+$/, '') + path, {
        method, signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', ...(cfg.deviceToken ? { 'X-Device-Token': cfg.deviceToken } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const err = new Error(e.name === 'AbortError' ? 'Tiempo de espera agotado' : 'Sin conexión con el servidor'); err.offline = true; throw err;
    } finally { clearTimeout(timer); }
    let j; try { j = await res.json(); } catch (_) { j = null; }
    if (!j || !j.ok) {
      const err = new Error((j && j.error) || `Error del servidor (${res.status})`); err.code = j && j.code; err.status = res.status;
      if (res.status >= 500) err.offline = true;
      throw err;
    }
    return j.data;
  }

  // ----- serialización de filas locales -----
  const uuidOf = (table, id) => { if (!id) return null; const r = db.get(`SELECT uuid FROM ${table} WHERE id = ?`, [id]); return r ? r.uuid : null; };
  const ser = {
    category: (id) => db.get('SELECT uuid, name FROM categories WHERE id = ?', [id]),
    product: (id) => { const p = db.get('SELECT p.uuid, p.name, c.uuid AS category_uuid, p.price_cents, p.active, p.created_at FROM products p JOIN categories c ON c.id = p.category_id WHERE p.id = ?', [id]); return p; },
    child: (id) => db.get('SELECT uuid, full_name, grade, photo, active, created_at FROM children WHERE id = ?', [id]),
    card: (id) => { const k = db.get('SELECT * FROM cards WHERE id = ?', [id]); if (!k) return null; return { uuid: k.uuid, uid: k.uid, child_uuid: uuidOf('children', k.child_id), status: k.status, balance_cents: k.balance_cents, blocked_by: k.blocked_by, created_at: k.created_at }; },
    limits: (childId) => {
      const cu = uuidOf('children', childId); if (!cu) return null;
      const l = db.get('SELECT per_transaction_cents, per_day_cents, period_type, per_period_cents FROM limits WHERE child_id = ?', [childId]) || { per_transaction_cents: null, per_day_cents: null, period_type: null, per_period_cents: null };
      return { child_uuid: cu, ...l };
    },
    prohibitions: (childId) => {
      const cu = uuidOf('children', childId); if (!cu) return null;
      return {
        child_uuid: cu,
        product_uuids: db.all('SELECT p.uuid FROM prohibited_products x JOIN products p ON p.id = x.product_id WHERE x.child_id = ?', [childId]).map((r) => r.uuid),
        category_uuids: db.all('SELECT k.uuid FROM prohibited_categories x JOIN categories k ON k.id = x.category_id WHERE x.child_id = ?', [childId]).map((r) => r.uuid),
      };
    },
    transaction: (id) => {
      const t = db.get(`SELECT t.*, u.full_name AS uname FROM transactions t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?`, [id]);
      if (!t) return null;
      return {
        uuid: t.uuid, type: t.type, status: t.status, reason: t.reason, amount_cents: t.amount_cents, balance_after_cents: t.balance_after_cents,
        card_uuid: uuidOf('cards', t.card_id), card_uid: t.card_uid, child_uuid: uuidOf('children', t.child_id), processed_by_name: t.uname || t.processed_by_name, note: t.note, created_at: t.created_at,
        items: db.all('SELECT p.uuid AS product_uuid, ti.product_name, ti.category_name, ti.qty, ti.unit_price_cents, ti.subtotal_cents FROM transaction_items ti LEFT JOIN products p ON p.id = ti.product_id WHERE ti.transaction_id = ?', [id]),
      };
    },
  };
  const KEY = { category: 'categories', product: 'products', child: 'children', card: 'cards', limits: 'limits', prohibitions: 'prohibitions', transaction: 'transactions' };
  function payloadFrom(pairs) {
    const ent = { categories: [], products: [], children: [], cards: [], limits: [], prohibitions: [], transactions: [] };
    const seen = new Set();
    for (const [entity, id] of pairs) {
      const k = entity + ':' + id; if (seen.has(k) || !ser[entity]) continue; seen.add(k);
      const row = ser[entity](id); if (row) ent[KEY[entity]].push(row);
    }
    return ent;
  }

  // ----- aplicar cambios descargados (sin volver a encolarlos) -----
  function applyPull(changes) {
    const idBy = (table, uuid) => { const r = db.get(`SELECT id FROM ${table} WHERE uuid = ?`, [uuid]); return r ? r.id : null; };
    let applied = 0;
    db.transaction(() => {
      setMeta('sync_applying', '1');
      try {
        for (const c of changes) {
          if (c.entity === 'card_status') {
            const k = db.get('SELECT id, status FROM cards WHERE uuid = ?', [c.card_uuid]);
            if (!k || k.status === 'perdida' || c.status === 'perdida' || c.status === 'sin_asignar') continue;
            db.run('UPDATE cards SET status = ?, blocked_by = ? WHERE id = ?', [c.status, c.blocked_by, k.id]); applied++;
            continue;
          }
          const childId = idBy('children', c.child_uuid);
          if (!childId) continue;
          if (c.entity === 'limits') {
            db.run(`INSERT INTO limits (child_id, per_transaction_cents, per_day_cents, period_type, per_period_cents, updated_at) VALUES (?,?,?,?,?,datetime('now','localtime'))
              ON CONFLICT(child_id) DO UPDATE SET per_transaction_cents=excluded.per_transaction_cents, per_day_cents=excluded.per_day_cents,
              period_type=excluded.period_type, per_period_cents=excluded.per_period_cents, updated_at=excluded.updated_at`,
            [childId, c.per_transaction_cents, c.per_day_cents, c.period_type, c.per_period_cents]);
          } else if (c.entity === 'prohibitions') {
            db.run('DELETE FROM prohibited_products WHERE child_id = ?', [childId]);
            db.run('DELETE FROM prohibited_categories WHERE child_id = ?', [childId]);
            for (const u of c.product_uuids || []) { const id = idBy('products', u); if (id) db.run('INSERT OR IGNORE INTO prohibited_products (child_id, product_id) VALUES (?,?)', [childId, id]); }
            for (const u of c.category_uuids || []) { const id = idBy('categories', u); if (id) db.run('INSERT OR IGNORE INTO prohibited_categories (child_id, category_id) VALUES (?,?)', [childId, id]); }
          } else if (c.entity === 'child_profile') {
            db.run('UPDATE children SET full_name = ?, grade = ?, photo = ? WHERE id = ?', [c.full_name, c.grade, c.photo, childId]);
          } else if (c.entity === 'child_link') {
            let tutorId = null;
            if (c.tutor) {
              const t = c.tutor;
              let u = db.get('SELECT id FROM users WHERE uuid = ?', [t.uuid]);
              if (!u) {
                const same = db.get("SELECT id FROM users WHERE username = ? AND role = 'tutor'", [t.username]);
                if (same) { db.run('UPDATE users SET uuid = ? WHERE id = ?', [t.uuid, same.id]); u = same; }
              }
              if (u) db.run('UPDATE users SET full_name = ?, email = ?, phone = ?, active = ? WHERE id = ?', [t.full_name, t.email, t.phone, t.active ? 1 : 0, u.id]);
              else {
                let username = t.username; if (db.get('SELECT id FROM users WHERE username = ?', [username])) username = `${t.username}.${t.uuid.slice(0, 6)}`;
                // Cuenta local sin contraseña utilizable: el tutor usa la app web; el admin puede asignarle una
                const r = db.run("INSERT INTO users (uuid, username, password_hash, role, full_name, email, phone, must_change_password, created_at) VALUES (?,?,?,'tutor',?,?,?,1,datetime('now','localtime'))",
                  [t.uuid, username, bcrypt.hashSync(crypto.randomBytes(18).toString('hex'), 8), t.full_name, t.email, t.phone]);
                u = { id: r.lastId };
              }
              tutorId = u.id;
            }
            db.run('UPDATE children SET tutor_id = ? WHERE id = ?', [tutorId, childId]);
          }
          applied++;
        }
      } finally { setMeta('sync_applying', '0'); }
    });
    return applied;
  }

  // Envía la cola local en lotes. Si el servidor no conoce una referencia, se hace un envío completo.
  async function pushAll(cfg) {
    const totals = { transactions: 0, duplicates: 0, conflicts_server_wins: 0, batches: 0, uid_conflicts: [] };
    const add = (st) => { totals.transactions += st.transactions; totals.duplicates += st.duplicates; totals.conflicts_server_wins += st.conflicts_server_wins; totals.batches++; for (const u of st.uid_conflicts || []) if (!totals.uid_conflicts.includes(u)) totals.uid_conflicts.push(u); };
    if (meta('sync_full_push_done') !== '1') {
      // Envío completo inicial (o recuperación): todo lo existente, con movimientos paginados
      const maxOb = db.get('SELECT COALESCE(MAX(id), 0) AS m FROM sync_outbox').m;
      const base = [
        ...db.all('SELECT id FROM categories').map((r) => ['category', r.id]),
        ...db.all('SELECT id FROM products').map((r) => ['product', r.id]),
        ...db.all('SELECT id FROM children').map((r) => ['child', r.id]),
        ...db.all('SELECT id FROM cards').map((r) => ['card', r.id]),
        ...db.all('SELECT child_id FROM limits').map((r) => ['limits', r.child_id]),
        ...db.all('SELECT DISTINCT child_id FROM prohibited_products UNION SELECT DISTINCT child_id FROM prohibited_categories').map((r) => ['prohibitions', r.child_id]),
      ];
      const txIds = db.all('SELECT id FROM transactions ORDER BY id').map((r) => r.id);
      let i = 0; let first = true;
      do {
        const page = txIds.slice(i, i + 1000).map((id) => ['transaction', id]);
        const r = await http(cfg, 'POST', '/api/sync/push', { pulled_cursor: Number(meta('sync_pull_cursor') || 0), entities: payloadFrom(first ? [...base, ...page] : page) });
        add(r.stats); first = false; i += 1000;
      } while (i < txIds.length);
      db.run('DELETE FROM sync_outbox WHERE id <= ?', [maxOb]);
      setMeta('sync_full_push_done', '1');
    }
    for (let round = 0; round < 50; round++) {
      const rows = db.all('SELECT id, entity, row_id FROM sync_outbox ORDER BY id LIMIT ?', [CHUNK]);
      if (!rows.length) break;
      const maxId = rows[rows.length - 1].id;
      const r = await http(cfg, 'POST', '/api/sync/push', { pulled_cursor: Number(meta('sync_pull_cursor') || 0), entities: payloadFrom(rows.map((x) => [x.entity, x.row_id])) });
      add(r.stats);
      db.run('DELETE FROM sync_outbox WHERE id <= ?', [maxId]);
    }
    return totals;
  }

  async function doSync() {
    const cfg = getConfig();
    if (!cfg.serverUrl || !cfg.deviceToken) { emit({ state: 'desactivado' }); return getStatus(); }
    emit({ state: 'sincronizando' });
    try {
      const st = await http(cfg, 'GET', '/api/sync/status');
      status.is_primary = st.is_primary;
      if (st.school_name) rememberSchool(st.school_uuid, st.school_name);
      const p = await http(cfg, 'GET', '/api/sync/pull?cursor=' + encodeURIComponent(meta('sync_pull_cursor') || 0));
      const applied = applyPull(p.changes);
      setMeta('sync_pull_cursor', p.cursor);
      let pushed = null;
      if (st.is_primary) {
        try { pushed = await pushAll(cfg); } catch (e) {
          if (e.code !== 'REFERENCIA_FALTANTE') throw e;
          setMeta('sync_full_push_done', '0'); pushed = await pushAll(cfg); // recuperación: reenviar todo (idempotente)
        }
      }
      const now = new Date().toISOString();
      setMeta('sync_last_at', now);
      const uidc = pushed && pushed.uid_conflicts && pushed.uid_conflicts.length ? `Tarjetas ya registradas en otra escuela (no se enviaron): ${pushed.uid_conflicts.join(', ')}` : null;
      emit({ state: st.is_primary ? 'ok' : 'solo_lectura', last_sync_at: now, last_error: st.is_primary ? uidc : 'Este equipo no es el principal: solo descarga ajustes (sus ventas no se envían).', last_stats: { pulled: applied, ...(pushed || {}) } });
    } catch (e) {
      const state = e.offline ? 'sin_conexion' : (e.code === 'OTRO_EQUIPO_PRINCIPAL' ? 'conflicto' : 'error');
      emit({ state, last_error: e.message });
    }
    return getStatus();
  }
  // Evita ciclos simultáneos
  function syncNow() { if (!running) running = doSync().finally(() => { running = null; }); return running; }

  // Vincula este equipo con credenciales de administrador del servidor y devuelve el token de equipo
  async function linkDevice({ serverUrl, username, password, name }) {
    const cfg = { serverUrl: String(serverUrl || '').trim() };
    if (!/^https?:\/\/\S+$/.test(cfg.serverUrl)) throw new Error('URL del servidor inválida');
    const login = await http(cfg, 'POST', '/api/auth/login', { identifier: username, password });
    if (login.user.role !== 'admin') throw new Error('Se requiere una cuenta de administrador del servidor');
    if (login.must_change_password) throw new Error('Cambie primero la contraseña temporal en la app web');
    const auth = { Authorization: 'Bearer ' + login.access_token };
    const prev = meta('linked_school_uuid');
    if (prev && login.user.school_uuid && prev !== login.user.school_uuid) throw new Error(`Este equipo ya trabaja con la escuela "${meta('linked_school_name') || ''}". Para otra escuela use una base de datos nueva.`);
    const r = await http(cfg, 'POST', '/api/sync/devices', { device_id: deviceId(), name: name || 'Caja de escritorio' }, auth);
    rememberSchool(r.school_uuid, r.school_name);
    return { serverUrl: cfg.serverUrl, deviceToken: r.device_token, primary_device: r.primary_device, access_token: login.access_token, school_name: r.school_name, school_uuid: r.school_uuid };
  }
  // La caja trabaja con UNA escuela: se guarda cuál es y se usa su nombre en pantalla
  function rememberSchool(uuid, name) {
    if (uuid) setMeta('linked_school_uuid', uuid);
    if (name) {
      setMeta('linked_school_name', name);
      db.run('UPDATE schools SET name = ? WHERE id = (SELECT id FROM schools ORDER BY id LIMIT 1)', [name]);
    }
  }
  // Pide al servidor los códigos de invitación (para padres) de los alumnos indicados (por uuid)
  async function requestInvitations(childIds, { includeLinked = false } = {}) {
    const cfg = getConfig();
    if (!cfg.serverUrl || !cfg.deviceToken) throw new Error('Este equipo no está vinculado a un servidor (Ajustes → Sincronización)');
    const uuids = childIds.map((id) => uuidOf('children', id)).filter(Boolean);
    return http(cfg, 'POST', '/api/sync/invitations', { child_uuids: uuids, include_linked: includeLinked });
  }
  async function makePrimary({ serverUrl, username, password }) {
    const cfg = { serverUrl };
    const login = await http(cfg, 'POST', '/api/auth/login', { identifier: username, password });
    await http(cfg, 'POST', `/api/sync/devices/${deviceId()}/primary`, {}, { Authorization: 'Bearer ' + login.access_token });
    return { ok: true };
  }

  return { syncNow, getStatus, linkDevice, makePrimary, requestInvitations, deviceId, applyPull, pendingCount };
}

module.exports = { createSyncClient };
