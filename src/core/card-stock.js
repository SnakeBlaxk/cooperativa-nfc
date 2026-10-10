'use strict';
// Inventario de tarjetas del SUPERADMINISTRADOR (Zuki Company): lista blanca de UID.
// Alta una por una (lector USB 125 kHz tipo teclado) o en lote (pegar lista / CSV / TXT),
// entrega a escuelas, bloqueo, baja y conteos. Solo lo usa el servidor (panel del superadministrador).
const { AppError, fmtLocal, normUid } = require('./service');

const STATES = ['en_stock', 'entregada', 'asignada', 'bloqueada', 'danada'];
const KINDS = ['normal', 'personalizada'];
const MAX_BULK = 5000;

// Separa una lista pegada o un archivo CSV/TXT en UID (uno por línea; en CSV se toma la primera columna)
function parseUidList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const first = line.split(/[,;\t]/)[0].replace(/^"|"$/g, '').trim();
    if (!first || /^uid$/i.test(first)) continue;
    out.push(first);
  }
  return out;
}

function createCardStock(db, { security = null, now = () => new Date() } = {}) {
  const ts = () => fmtLocal(now());
  const need = (actor) => { if (!actor || actor.role !== 'superadmin') throw new AppError('Solo el superadministrador puede hacer esto', 'PROHIBIDO'); };
  const audit = (actor, action, o) => { if (security) try { security.audit(actor, action, o); } catch (e) { console.error('[inventario]', e.message); } };
  const tryNorm = (u) => { try { return normUid(String(u)); } catch (_) { return null; } };
  const getSchool = (id) => {
    const s = db.get('SELECT id, name FROM schools WHERE id = ?', [Number(id) || 0]);
    if (!s) throw new AppError('Escuela no encontrada', 'NO_ENCONTRADO');
    return s;
  };

  function list(actor, f = {}) {
    need(actor);
    const w = []; const p = [];
    if (f.status && STATES.includes(f.status)) { w.push('s.status = ?'); p.push(f.status); }
    if (f.kind && KINDS.includes(f.kind)) { w.push('s.kind = ?'); p.push(f.kind); }
    if (f.school_id === 'none') w.push('s.school_id IS NULL');
    else if (f.school_id) { w.push('s.school_id = ?'); p.push(Number(f.school_id) || 0); }
    if (f.q) { const q = String(f.q).trim(); const n = tryNorm(q); w.push('(s.uid LIKE ? OR s.batch LIKE ? OR s.note LIKE ?)'); p.push(`%${n || q.toUpperCase()}%`, `%${q}%`, `%${q}%`); }
    const limit = Math.min(Number(f.limit) || 5000, 20000);
    return db.all(`SELECT s.*, sc.name AS school_name, k.id AS card_id, c.full_name AS child_name
      FROM card_stock s LEFT JOIN schools sc ON sc.id = s.school_id LEFT JOIN cards k ON k.uid = s.uid LEFT JOIN children c ON c.id = k.child_id
      ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY s.id DESC LIMIT ${limit}`, p);
  }
  function summary(actor) {
    need(actor);
    const by = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const r of db.all('SELECT status, COUNT(*) AS n FROM card_stock GROUP BY status')) by[r.status] = r.n;
    const schools = db.all(`SELECT sc.id, sc.name,
        SUM(CASE WHEN s.status = 'entregada' THEN 1 ELSE 0 END) AS entregada, SUM(CASE WHEN s.status = 'asignada' THEN 1 ELSE 0 END) AS asignada,
        SUM(CASE WHEN s.status = 'bloqueada' THEN 1 ELSE 0 END) AS bloqueada, SUM(CASE WHEN s.status = 'danada' THEN 1 ELSE 0 END) AS danada, COUNT(s.id) AS total
      FROM schools sc LEFT JOIN card_stock s ON s.school_id = sc.id GROUP BY sc.id ORDER BY sc.name`);
    const m = db.get("SELECT value FROM meta WHERE key = 'card_stock_v1'");
    let migrated = null; try { migrated = m ? JSON.parse(m.value).migrated : null; } catch (_) { /* valor antiguo */ }
    return { total: Object.values(by).reduce((a, b) => a + b, 0), by_status: by, schools, migrated };
  }
  // Alta de UID (uno o muchos). No falla por repetidos: los informa.
  function add(actor, a = {}, ctx = {}) {
    need(actor);
    const rawList = Array.isArray(a.uids) ? a.uids : (a.text !== undefined ? parseUidList(a.text) : [a.uid]);
    if (!rawList.length || rawList.every((x) => x === undefined || x === null || String(x).trim() === '')) throw new AppError('Escriba o lea al menos un UID', 'VALIDACION');
    if (rawList.length > MAX_BULK) throw new AppError(`Máximo ${MAX_BULK} tarjetas por carga`, 'VALIDACION');
    const kind = KINDS.includes(a.kind) ? a.kind : 'normal';
    const batch = a.batch ? String(a.batch).trim().slice(0, 80) || null : null;
    const note = a.note ? String(a.note).trim().slice(0, 200) || null : null;
    let school = null;
    if (a.school_id) school = getSchool(a.school_id);
    const added = []; const duplicates = []; const invalid = []; const seen = new Set();
    const t = ts();
    db.transaction(() => {
      for (const raw of rawList) {
        const uid = tryNorm(raw);
        if (!uid) { invalid.push(String(raw).slice(0, 64)); continue; }
        if (seen.has(uid) || db.get('SELECT 1 AS x FROM card_stock WHERE uid = ?', [uid])) { duplicates.push(uid); continue; }
        seen.add(uid);
        db.run('INSERT INTO card_stock (uid, kind, status, school_id, batch, note, delivered_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
          [uid, kind, school ? 'entregada' : 'en_stock', school ? school.id : null, batch, note, school ? t : null, t]);
        added.push(uid);
      }
    });
    if (added.length) audit(actor, 'inventario_tarjetas_alta', { school_id: school ? school.id : null, ip: ctx.ip, target_type: 'card_stock', details: { cantidad: added.length, tipo: kind, lote: batch || undefined, escuela: school ? school.name : undefined, primeras: added.slice(0, 20) } });
    return { added: added.length, added_uids: added, duplicates, invalid };
  }
  // Selección: ids, uids, o rango de UID (desde/hasta, comparando como texto del mismo largo o como número)
  function select(a) {
    const ids = new Set();
    for (const id of Array.isArray(a.ids) ? a.ids : []) if (Number(id) > 0) ids.add(Number(id));
    const uids = (Array.isArray(a.uids) ? a.uids : (a.text !== undefined ? parseUidList(a.text) : [])).map(tryNorm).filter(Boolean);
    for (const u of uids) { const r = db.get('SELECT id FROM card_stock WHERE uid = ?', [u]); if (r) ids.add(r.id); }
    if (a.from || a.to) {
      const from = tryNorm(a.from); const to = tryNorm(a.to);
      if (!from || !to) throw new AppError('Indique el UID inicial y final del rango', 'VALIDACION');
      const num = /^\d+$/.test(from) && /^\d+$/.test(to);
      const rows = num
        ? db.all("SELECT id FROM card_stock WHERE uid NOT GLOB '*[^0-9]*' AND CAST(uid AS INTEGER) BETWEEN ? AND ?", [Math.min(+from, +to), Math.max(+from, +to)])
        : db.all('SELECT id FROM card_stock WHERE length(uid) = ? AND uid BETWEEN ? AND ?', [from.length, from < to ? from : to, from < to ? to : from]);
      for (const r of rows) ids.add(r.id);
    }
    if (!ids.size) throw new AppError('No se seleccionó ninguna tarjeta del inventario', 'VALIDACION');
    return [...ids].map((id) => db.get('SELECT * FROM card_stock WHERE id = ?', [id])).filter(Boolean);
  }
  // Entregar tarjetas a una escuela (quedan disponibles para su administrador)
  function deliver(actor, a = {}, ctx = {}) {
    need(actor);
    const school = getSchool(a.school_id);
    const rows = select(a);
    const t = ts(); let n = 0; const skipped = [];
    db.transaction(() => {
      for (const s of rows) {
        const inUse = db.get('SELECT school_id FROM cards WHERE uid = ?', [s.uid]);
        if (inUse && inUse.school_id !== school.id) { skipped.push({ uid: s.uid, motivo: 'ya está registrada en otra escuela' }); continue; }
        if (['bloqueada', 'danada'].includes(s.status)) { skipped.push({ uid: s.uid, motivo: s.status === 'danada' ? 'dañada' : 'bloqueada' }); continue; }
        if (s.school_id === school.id && ['entregada', 'asignada'].includes(s.status)) { skipped.push({ uid: s.uid, motivo: 'ya entregada a esta escuela' }); continue; }
        const st = inUse && db.get("SELECT 1 AS x FROM cards WHERE uid = ? AND child_id IS NOT NULL AND status IN ('activa','bloqueada')", [s.uid]) ? 'asignada' : 'entregada';
        db.run('UPDATE card_stock SET status = ?, school_id = ?, delivered_at = ?, updated_at = ? WHERE id = ?', [st, school.id, t, t, s.id]);
        n++;
      }
    });
    if (n) audit(actor, 'inventario_tarjetas_entrega', { school_id: school.id, ip: ctx.ip, target_type: 'school', target_id: school.id, details: { escuela: school.name, cantidad: n } });
    return { delivered: n, skipped, school: school.name };
  }
  // Cambiar estado: bloquear, marcar dañada, regresar a stock o desbloquear (vuelve a entregada si tiene escuela)
  function setStatus(actor, a = {}, ctx = {}) {
    need(actor);
    const status = String(a.status || '');
    if (!['bloqueada', 'danada', 'en_stock', 'desbloquear'].includes(status)) throw new AppError('Estado inválido', 'VALIDACION');
    const rows = select(a); const t = ts(); let n = 0; const skipped = [];
    db.transaction(() => {
      for (const s of rows) {
        const card = db.get('SELECT * FROM cards WHERE uid = ?', [s.uid]);
        let st = status; let sid = s.school_id;
        if (status === 'en_stock') {
          if (card) { skipped.push({ uid: s.uid, motivo: 'la escuela ya la registró; bloquéela en lugar de regresarla' }); continue; }
          sid = null;
        }
        if (status === 'desbloquear') {
          if (!['bloqueada', 'danada'].includes(s.status)) { skipped.push({ uid: s.uid, motivo: 'no está bloqueada' }); continue; }
          st = !sid ? 'en_stock' : (card && card.child_id && ['activa', 'bloqueada'].includes(card.status) ? 'asignada' : 'entregada');
        }
        db.run('UPDATE card_stock SET status = ?, school_id = ?, delivered_at = CASE WHEN ? IS NULL THEN NULL ELSE delivered_at END, updated_at = ? WHERE id = ?', [st, sid, sid, t, s.id]);
        n++;
      }
    });
    if (n) audit(actor, 'inventario_tarjetas_estado', { ip: ctx.ip, target_type: 'card_stock', details: { estado: status, cantidad: n, uids: rows.slice(0, 20).map((r) => r.uid) }, severity: ['bloqueada', 'danada'].includes(status) ? 'aviso' : 'info' });
    return { updated: n, skipped };
  }
  function update(actor, a = {}, ctx = {}) {
    need(actor);
    const s = db.get('SELECT * FROM card_stock WHERE id = ?', [Number(a.id) || 0]);
    if (!s) throw new AppError('Tarjeta no encontrada en el inventario', 'NO_ENCONTRADO');
    const kind = KINDS.includes(a.kind) ? a.kind : s.kind;
    const batch = a.batch === undefined ? s.batch : (String(a.batch || '').trim().slice(0, 80) || null);
    const note = a.note === undefined ? s.note : (String(a.note || '').trim().slice(0, 200) || null);
    db.run('UPDATE card_stock SET kind = ?, batch = ?, note = ?, updated_at = ? WHERE id = ?', [kind, batch, note, ts(), s.id]);
    audit(actor, 'inventario_tarjetas_editada', { school_id: s.school_id, ip: ctx.ip, target_type: 'card_stock', target_id: s.uid, details: { uid: s.uid, tipo: kind, lote: batch, nota: note } });
    return db.get('SELECT * FROM card_stock WHERE id = ?', [s.id]);
  }
  // Eliminar del inventario (solo si la escuela no la registró; si ya se usó, se debe bloquear)
  function remove(actor, a = {}, ctx = {}) {
    need(actor);
    const rows = select(a); let n = 0; const skipped = [];
    db.transaction(() => {
      for (const s of rows) {
        if (db.get('SELECT 1 AS x FROM cards WHERE uid = ?', [s.uid])) { skipped.push({ uid: s.uid, motivo: 'la escuela ya la registró; use Bloquear' }); continue; }
        db.run('DELETE FROM card_stock WHERE id = ?', [s.id]); n++;
      }
    });
    if (n) audit(actor, 'inventario_tarjetas_baja', { ip: ctx.ip, target_type: 'card_stock', details: { cantidad: n, uids: rows.slice(0, 20).map((r) => r.uid) }, severity: 'aviso' });
    return { removed: n, skipped };
  }
  // Eliminar definitivamente (solo superadmin): también borra el registro de la escuela (tabla cards)
  // si NO está asignada a un alumno activo. Si el alumno fue dado de baja, primero se desasigna.
  // El historial de movimientos se conserva: card_id queda en NULL y card_uid conserva el UID.
  function purge(actor, a = {}, ctx = {}) {
    need(actor);
    const rows = select(a); const done = []; const skipped = []; const detail = [];
    db.transaction(() => {
      for (const s of rows) {
        const card = db.get('SELECT * FROM cards WHERE uid = ?', [s.uid]);
        let info = { uid: s.uid, escuela_id: s.school_id };
        if (card) {
          const child = card.child_id ? db.get('SELECT id, full_name, active, deleted_at FROM children WHERE id = ?', [card.child_id]) : null;
          if (child && child.active && !child.deleted_at) { skipped.push({ uid: s.uid, motivo: `asignada a un alumno activo (${child.full_name}); desasígnela primero` }); continue; }
          if (card.balance_cents > 0) { skipped.push({ uid: s.uid, motivo: 'tiene saldo; reembolse o transfiera el saldo primero' }); continue; }
          if (card.child_id) db.run('UPDATE cards SET child_id = NULL WHERE id = ?', [card.id]);
          const tx = db.run('UPDATE transactions SET card_uid = COALESCE(card_uid, ?), card_id = NULL WHERE card_id = ?', [card.uid, card.id]);
          db.run('DELETE FROM cards WHERE id = ?', [card.id]);
          info = { ...info, card_id: card.id, escuela_tarjeta: card.school_id, alumno_dado_de_baja: child ? child.id : undefined, movimientos_conservados: tx && tx.changes !== undefined ? tx.changes : undefined };
        }
        db.run('DELETE FROM card_stock WHERE id = ?', [s.id]);
        done.push(s.uid); detail.push(info);
      }
    });
    if (done.length) audit(actor, 'inventario_tarjetas_eliminacion_definitiva', { ip: ctx.ip, target_type: 'card_stock', details: { cantidad: done.length, tarjetas: detail.slice(0, 50), omitidas: skipped.length }, severity: 'alta' });
    return { removed: done.length, removed_uids: done, skipped };
  }
  function exportCsv(actor, f = {}) {
    const rows = list(actor, f);
    const q = (v) => (v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const L = ['UID,Tipo,Estado,Escuela,Alumno,Fecha alta,Fecha entrega,Lote,Nota'];
    // El UID se exporta como texto (="0001234567") para que Excel conserve los ceros a la izquierda
    for (const r of rows) L.push([`="${r.uid}"`, r.kind, r.status, q(r.school_name), q(r.child_name), r.created_at, r.delivered_at || '', q(r.batch), q(r.note)].join(','));
    return { filename: `inventario-tarjetas-${ts().slice(0, 10)}.csv`, csv: L.join('\r\n'), count: rows.length };
  }

  const methods = {
    stockList: (u, a) => list(u, a),
    stockSummary: (u) => summary(u),
    stockAdd: (u, a, c) => add(u, a, c),
    stockDeliver: (u, a, c) => deliver(u, a, c),
    stockSetStatus: (u, a, c) => setStatus(u, a, c),
    stockUpdate: (u, a, c) => update(u, a, c),
    stockRemove: (u, a, c) => remove(u, a, c),
    stockPurge: (u, a, c) => purge(u, a, c),
    stockExport: (u, a) => exportCsv(u, a),
  };
  return { methods, list, summary, add, deliver, setStatus, update, remove, purge, exportCsv };
}

module.exports = { createCardStock, parseUidList, STATES };
