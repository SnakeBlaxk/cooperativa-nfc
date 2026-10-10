'use strict';
// Bajas (borrado lógico) de alumnos y de papás/tutores, con Papelera.
// - El administrador de la escuela (solo su escuela) y el superadministrador pueden dar de baja y restaurar.
// - Solo el superadministrador elimina definitivamente desde la Papelera.
// - El cajero (y el tutor) no pueden dar de baja a nadie.
// Al dar de baja a un alumno: si tiene saldo se exige reembolso en efectivo (movimiento "reembolso" que deja
// el saldo en $0) o se cancela; su tarjeta se quita y vuelve a las tarjetas libres de la escuela
// (inventario: "entregada a escuela"). El historial de movimientos se conserva para los reportes.
const { AppError, fmtLocal } = require('./service');

function createRemovals(db, { security = null, now = () => new Date() } = {}) {
  const ts = () => fmtLocal(now());
  const audit = (actor, action, o) => { if (security) try { security.audit(actor, action, o); } catch (e) { console.error('[bajas]', e.message); } };
  const isSuper = (a) => a && a.role === 'superadmin';
  function need(actor) {
    if (!actor) throw new AppError('Sesión no iniciada', 'NO_AUTENTICADO');
    if (isSuper(actor)) return null;
    if (actor.role !== 'admin') throw new AppError('Solo el administrador de la escuela puede dar de baja alumnos o papás/tutores', 'PROHIBIDO');
    if (!actor.school_id) throw new AppError('Tu usuario no tiene escuela asignada', 'PROHIBIDO');
    return Number(actor.school_id);
  }
  const needSuper = (actor) => { if (!isSuper(actor)) throw new AppError('Solo el superadministrador puede eliminar definitivamente', 'PROHIBIDO'); };
  const idOf = (v) => { const n = Number(v); if (!Number.isInteger(n) || n < 1) throw new AppError('Identificador inválido', 'VALIDACION'); return n; };
  const actorName = (a) => a.full_name || a.username || 'Sistema';

  function getChild(actor, id, { deleted = false } = {}) {
    const sid = need(actor);
    const c = db.get(`SELECT * FROM children WHERE id = ? AND deleted_at IS ${deleted ? 'NOT ' : ''}NULL${sid ? ' AND school_id = ' + sid : ''}`, [idOf(id)]);
    if (!c) throw new AppError(deleted ? 'El alumno no está en la Papelera' : 'Alumno no encontrado', 'NO_ENCONTRADO');
    return c;
  }
  const currentCard = (childId) => db.get("SELECT * FROM cards WHERE child_id = ? AND status IN ('activa','bloqueada') ORDER BY id DESC LIMIT 1", [childId]);
  const otherChildren = (tutorId, exceptId) => db.get('SELECT COUNT(*) AS n FROM children WHERE tutor_id = ? AND id <> ? AND deleted_at IS NULL', [tutorId, exceptId]).n;

  // Lo que pasará al dar de baja (para el diálogo de confirmación)
  function previewDeleteChild(actor, a = {}) {
    const c = getChild(actor, a.child_id);
    const k = currentCard(c.id);
    const t = c.tutor_id ? db.get("SELECT id, full_name, username FROM users WHERE id = ? AND role = 'tutor' AND deleted_at IS NULL", [c.tutor_id]) : null;
    return {
      child: { id: c.id, full_name: c.full_name, grade: c.grade },
      card: k ? { id: k.id, uid: k.uid, balance_cents: k.balance_cents } : null,
      balance_cents: k ? k.balance_cents : 0,
      tutor: t ? { ...t, other_children: otherChildren(t.id, c.id) } : null,
    };
  }

  // a: { child_id, refund: 'efectivo' (si hay saldo), delete_tutor: bool }
  function deleteChild(actor, a = {}, ctx = {}) {
    const c = getChild(actor, a.child_id);
    const k = currentCard(c.id);
    const bal = k ? k.balance_cents : 0;
    if (bal > 0 && a.refund !== 'efectivo') {
      throw new AppError(`El alumno tiene saldo de $${(bal / 100).toFixed(2)}. Entregue el reembolso en efectivo y márquelo, o cancele.`, 'SALDO_PENDIENTE');
    }
    const t = ts();
    let tutorDeleted = null;
    const out = db.transaction(() => {
      let refundTx = null;
      if (k && bal > 0) {
        refundTx = db.run(`INSERT INTO transactions (school_id, type, subtype, status, amount_cents, balance_after_cents, card_id, card_uid, child_id, user_id, processed_by_name, note, created_at)
          VALUES (?, 'ajuste', 'reembolso', 'aprobado', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [c.school_id, -bal, k.id, k.uid, c.id, isSuper(actor) ? null : actor.id, actorName(actor), 'Reembolso en efectivo por baja del alumno', t]).lastId;
        db.run('UPDATE cards SET balance_cents = 0 WHERE id = ?', [k.id]);
      }
      // La tarjeta se quita y regresa a las tarjetas libres de la escuela (el trigger deja el inventario en "entregada")
      if (k) db.run("UPDATE cards SET child_id = NULL, status = 'sin_asignar', blocked_by = NULL WHERE id = ?", [k.id]);
      db.run('UPDATE children SET active = 0, deleted_at = ?, deleted_by = ? WHERE id = ?', [t, actorName(actor), c.id]);
      return { refund_transaction_id: refundTx };
    });
    audit(actor, 'alumno_baja', { school_id: c.school_id, ip: ctx.ip, target_type: 'child', target_id: c.id,
      details: { alumno: c.full_name, grado: c.grade || undefined, tarjeta: k ? k.uid : undefined, reembolso_efectivo: bal > 0 ? bal : undefined }, severity: 'aviso' });
    if (a.delete_tutor && c.tutor_id) {
      const tu = db.get("SELECT * FROM users WHERE id = ? AND role = 'tutor' AND deleted_at IS NULL", [c.tutor_id]);
      if (tu && otherChildren(tu.id, c.id) === 0) tutorDeleted = deleteTutor(actor, { user_id: tu.id, _schoolHint: c.school_id }, ctx);
    }
    return { deleted: true, child_id: c.id, refunded_cents: bal, card_uid: k ? k.uid : null, ...out, tutor_deleted: tutorDeleted ? tutorDeleted.user_id : null,
      message: 'Alumno enviado a la Papelera (se puede restaurar).' };
  }

  function restoreChild(actor, a = {}, ctx = {}) {
    const c = getChild(actor, a.child_id, { deleted: true });
    // Si su tutor también está dado de baja, el alumno vuelve sin tutor
    const tutorOk = c.tutor_id && db.get('SELECT 1 AS x FROM users WHERE id = ? AND deleted_at IS NULL', [c.tutor_id]);
    db.run('UPDATE children SET active = 1, deleted_at = NULL, deleted_by = NULL, tutor_id = ? WHERE id = ?', [tutorOk ? c.tutor_id : null, c.id]);
    audit(actor, 'alumno_restaurado', { school_id: c.school_id, ip: ctx.ip, target_type: 'child', target_id: c.id, details: { alumno: c.full_name } });
    return { restored: true, child_id: c.id, message: 'Alumno restaurado. Asígnele una tarjeta para que vuelva a comprar.' };
  }

  // Tutores: el administrador solo puede con tutores de su escuela (con hijos en ella o creados en ella)
  function getTutor(actor, id, { deleted = false } = {}) {
    const sid = need(actor);
    const u = db.get(`SELECT * FROM users WHERE id = ? AND role = 'tutor' AND deleted_at IS ${deleted ? 'NOT ' : ''}NULL`, [idOf(id)]);
    if (!u) throw new AppError(deleted ? 'El papá/tutor no está en la Papelera' : 'Papá/tutor no encontrado', 'NO_ENCONTRADO');
    if (sid) {
      const inSchool = deleted
        ? u.deleted_school_id === sid
        : (u.school_id === sid || db.get('SELECT 1 AS x FROM children WHERE tutor_id = ? AND school_id = ? AND deleted_at IS NULL', [u.id, sid]));
      if (!inSchool) throw new AppError('Papá/tutor no encontrado', 'NO_ENCONTRADO');
      if (!deleted && db.get('SELECT 1 AS x FROM children WHERE tutor_id = ? AND school_id <> ? AND deleted_at IS NULL', [u.id, sid])) {
        throw new AppError('Este papá/tutor también tiene hijos en otra escuela. Solo el superadministrador puede darlo de baja.', 'PROHIBIDO');
      }
    }
    return u;
  }
  function deleteTutor(actor, a = {}, ctx = {}) {
    const u = getTutor(actor, a.user_id);
    const sid = need(actor);
    const kids = db.all('SELECT id, full_name, school_id FROM children WHERE tutor_id = ? AND deleted_at IS NULL', [u.id]);
    const school = sid || a._schoolHint || u.school_id || (kids[0] && kids[0].school_id) || null;
    const t = ts();
    db.transaction(() => {
      db.run('UPDATE children SET tutor_id = NULL WHERE tutor_id = ? AND deleted_at IS NULL', [u.id]);
      db.run('UPDATE users SET active = 0, token_version = token_version + 1, deleted_at = ?, deleted_by = ?, deleted_school_id = ?, deleted_info = ? WHERE id = ?',
        [t, actorName(actor), school, JSON.stringify({ children: kids.map((k) => k.id) }), u.id]);
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', [u.id]);
      db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [u.id]);
    });
    audit(actor, 'tutor_baja', { school_id: school, ip: ctx.ip, target_type: 'user', target_id: u.id,
      details: { tutor: u.full_name, cuenta: u.username, hijos_desvinculados: kids.map((k) => k.full_name) }, severity: 'aviso' });
    return { deleted: true, user_id: u.id, unlinked_children: kids.length, message: 'Papá/tutor enviado a la Papelera. Ya no puede entrar; sus hijos siguen inscritos.' };
  }
  function restoreTutor(actor, a = {}, ctx = {}) {
    const u = getTutor(actor, a.user_id, { deleted: true });
    let info = {}; try { info = JSON.parse(u.deleted_info || '{}'); } catch (_) { /* nada */ }
    let relinked = 0;
    db.transaction(() => {
      db.run('UPDATE users SET active = 1, deleted_at = NULL, deleted_by = NULL, deleted_school_id = NULL, deleted_info = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?', [u.id]);
      // Se vuelven a vincular los hijos que siguen sin tutor
      for (const cid of Array.isArray(info.children) ? info.children : []) relinked += db.run('UPDATE children SET tutor_id = ? WHERE id = ? AND tutor_id IS NULL', [u.id, Number(cid) || 0]).changes;
    });
    audit(actor, 'tutor_restaurado', { school_id: u.deleted_school_id, ip: ctx.ip, target_type: 'user', target_id: u.id, details: { tutor: u.full_name, cuenta: u.username, hijos_vinculados: relinked } });
    return { restored: true, user_id: u.id, relinked_children: relinked, message: 'Papá/tutor restaurado; ya puede entrar de nuevo.' };
  }

  const daysSince = (s) => Math.max(0, Math.floor((now().getTime() - new Date(String(s).replace(' ', 'T')).getTime()) / 86400000));
  function listRemoved(actor, f = {}) {
    const sid = need(actor);
    const fs = sid || (f.school_id ? Number(f.school_id) || 0 : null);
    const children = db.all(`SELECT c.id, c.full_name, c.grade, c.school_id, s.name AS school_name, c.deleted_at, c.deleted_by, u.full_name AS tutor_name,
        (SELECT COUNT(*) FROM transactions t WHERE t.child_id = c.id) AS movements
      FROM children c LEFT JOIN schools s ON s.id = c.school_id LEFT JOIN users u ON u.id = c.tutor_id
      WHERE c.deleted_at IS NOT NULL${fs ? ' AND c.school_id = ' + fs : ''} ORDER BY c.deleted_at DESC LIMIT 1000`).map((r) => ({ ...r, type: 'alumno', days: daysSince(r.deleted_at) }));
    const tutors = db.all(`SELECT u.id, u.full_name, u.username, u.email, u.phone, u.deleted_school_id AS school_id, s.name AS school_name, u.deleted_at, u.deleted_by
      FROM users u LEFT JOIN schools s ON s.id = u.deleted_school_id
      WHERE u.role = 'tutor' AND u.deleted_at IS NOT NULL${fs ? ' AND u.deleted_school_id = ' + fs : ''} ORDER BY u.deleted_at DESC LIMIT 1000`).map((r) => ({ ...r, type: 'tutor', days: daysSince(r.deleted_at) }));
    const staff = sid ? [] : db.all(`SELECT u.id, u.full_name, u.username, u.email, u.phone, u.role, u.deleted_school_id AS school_id, s.name AS school_name, u.deleted_at, u.deleted_by,
        (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id) AS movements
      FROM users u LEFT JOIN schools s ON s.id = u.deleted_school_id
      WHERE u.role IN ('admin','cajero') AND u.deleted_at IS NOT NULL${fs ? ' AND u.deleted_school_id = ' + fs : ''} ORDER BY u.deleted_at DESC LIMIT 1000`).map((r) => ({ ...r, type: 'personal', days: daysSince(r.deleted_at) }));
    return { children, tutors, staff, can_purge: !sid };
  }

  // Eliminación definitiva (solo superadministrador, solo desde la Papelera).
  // Los movimientos se conservan para los reportes con el nombre del alumno guardado en el movimiento.
  function purgeChild(actor, a = {}, ctx = {}) {
    needSuper(actor);
    const c = getChild(actor, a.child_id, { deleted: true });
    db.transaction(() => {
      db.run('UPDATE transactions SET child_name = COALESCE(child_name, ?), child_id = NULL WHERE child_id = ?', [c.full_name, c.id]);
      db.run('UPDATE cards SET child_id = NULL WHERE child_id = ?', [c.id]);
      for (const tb of ['limits', 'prohibited_products', 'prohibited_categories', 'low_balance_state', 'invitations', 'child_change_requests']) db.run(`DELETE FROM ${tb} WHERE child_id = ?`, [c.id]);
      db.run('DELETE FROM meta WHERE key = ?', [`saldo_pendiente_child_${c.id}`]);
      db.run('DELETE FROM children WHERE id = ?', [c.id]);
    });
    audit(actor, 'alumno_eliminado_definitivo', { school_id: c.school_id, ip: ctx.ip, target_type: 'child', target_id: c.id, details: { alumno: c.full_name, grado: c.grade || undefined }, severity: 'alta' });
    return { purged: true };
  }
  function purgeTutor(actor, a = {}, ctx = {}) {
    needSuper(actor);
    const u = getTutor(actor, a.user_id, { deleted: true });
    db.transaction(() => {
      db.run('UPDATE children SET tutor_id = NULL WHERE tutor_id = ?', [u.id]);
      db.run('UPDATE transactions SET processed_by_name = COALESCE(processed_by_name, ?), user_id = NULL WHERE user_id = ?', [u.full_name, u.id]);
      db.run('UPDATE invitations SET used_by = NULL WHERE used_by = ?', [u.id]);
      db.run('UPDATE invitations SET created_by = NULL WHERE created_by = ?', [u.id]);
      db.run('UPDATE child_change_requests SET tutor_id = NULL WHERE tutor_id = ?', [u.id]);
      db.run('UPDATE child_change_requests SET resolved_by = NULL WHERE resolved_by = ?', [u.id]);
      db.run('UPDATE devices SET created_by = NULL WHERE created_by = ?', [u.id]);
      for (const tb of ['refresh_tokens', 'password_resets', 'push_subscriptions', 'push_prefs']) db.run(`DELETE FROM ${tb} WHERE user_id = ?`, [u.id]);
      db.run('DELETE FROM users WHERE id = ?', [u.id]);
    });
    audit(actor, 'tutor_eliminado_definitivo', { school_id: u.deleted_school_id, ip: ctx.ip, target_type: 'user', target_id: u.id, details: { tutor: u.full_name, cuenta: u.username }, severity: 'alta' });
    return { purged: true };
  }

  // ---------- Personal de escuela (administrador de escuela y cajero): solo el superadministrador ----------
  // Baja = Papelera (restaurable). La cuenta se desliga de la escuela (school_id NULL, se guarda en deleted_school_id)
  // para que no cuente como personal en ningún lado; se cierran sus sesiones. Ventas y movimientos se conservan.
  const STAFF = ['admin', 'cajero'];
  const ROLE_LABEL = { admin: 'administrador de escuela', cajero: 'cajero' };
  function getStaff(actor, id, { deleted = false } = {}) {
    if (!actor) throw new AppError('Sesión no iniciada', 'NO_AUTENTICADO');
    if (!isSuper(actor)) throw new AppError('Solo el superadministrador puede eliminar cuentas de personal', 'PROHIBIDO');
    const u = db.get(`SELECT * FROM users WHERE id = ? AND deleted_at IS ${deleted ? 'NOT ' : ''}NULL`, [idOf(id)]);
    if (u && u.role === 'superadmin') throw new AppError('La cuenta del superadministrador no se puede eliminar', 'PROHIBIDO');
    if (!u || !STAFF.includes(u.role)) throw new AppError(deleted ? 'La cuenta no está en la Papelera' : 'Cuenta de personal no encontrada', 'NO_ENCONTRADO');
    return u;
  }
  const activeAdmins = (sid, exceptId) => (sid ? db.get("SELECT COUNT(*) AS n FROM users WHERE school_id = ? AND role = 'admin' AND active = 1 AND deleted_at IS NULL AND id <> ?", [sid, exceptId]).n : 0);
  function previewDeleteStaff(actor, a = {}) {
    const u = getStaff(actor, a.user_id);
    const s = u.school_id ? db.get('SELECT id, name FROM schools WHERE id = ?', [u.school_id]) : null;
    const sales = db.get('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ?', [u.id]).n;
    const last = u.role === 'admin' && !!s && activeAdmins(s.id, u.id) === 0;
    return { user: { id: u.id, username: u.username, full_name: u.full_name, role: u.role, active: !!u.active }, school: s, movements: sales,
      last_admin: last, warning: last ? `Es el último administrador activo de ${s.name}. La escuela se quedará sin administrador hasta que cree o restaure otro.` : null };
  }
  // a: { user_id, confirm: nombre de usuario exacto }
  function deleteStaff(actor, a = {}, ctx = {}) {
    const u = getStaff(actor, a.user_id);
    if (String(a.confirm || '').trim() !== u.username) throw new AppError(`Para confirmar escriba exactamente el usuario: ${u.username}`, 'VALIDACION');
    const pv = previewDeleteStaff(actor, a);
    const t = ts();
    db.transaction(() => {
      db.run('UPDATE users SET active = 0, token_version = token_version + 1, school_id = NULL, deleted_at = ?, deleted_by = ?, deleted_school_id = ?, deleted_info = ? WHERE id = ?',
        [t, actorName(actor), u.school_id, JSON.stringify({ role: u.role, was_active: !!u.active }), u.id]);
      db.run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', [u.id]);
      db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [u.id]);
    });
    audit(actor, 'personal_baja', { school_id: u.school_id, ip: ctx.ip, target_type: 'user', target_id: u.id,
      details: { cuenta: u.username, nombre: u.full_name, rol: u.role, escuela: pv.school ? pv.school.name : undefined, ultimo_admin: pv.last_admin || undefined }, severity: pv.last_admin ? 'alta' : 'aviso' });
    return { deleted: true, user_id: u.id, last_admin: pv.last_admin, warning: pv.warning,
      message: `Cuenta de ${ROLE_LABEL[u.role]} enviada a la Papelera. Ya no puede entrar; sus ventas y movimientos se conservan.` };
  }
  function restoreStaff(actor, a = {}, ctx = {}) {
    const u = getStaff(actor, a.user_id, { deleted: true });
    let info = {}; try { info = JSON.parse(u.deleted_info || '{}'); } catch (_) { /* nada */ }
    const sid = u.deleted_school_id && db.get('SELECT id FROM schools WHERE id = ?', [u.deleted_school_id]) ? u.deleted_school_id : null;
    if (!sid) throw new AppError('La escuela de esta cuenta ya no existe; no se puede restaurar', 'CONFLICTO');
    const reactivate = info.was_active !== false;
    db.run('UPDATE users SET active = ?, school_id = ?, deleted_at = NULL, deleted_by = NULL, deleted_school_id = NULL, deleted_info = NULL, failed_logins = 0, locked_until = NULL WHERE id = ?',
      [reactivate ? 1 : 0, sid, u.id]);
    audit(actor, 'personal_restaurado', { school_id: sid, ip: ctx.ip, target_type: 'user', target_id: u.id, details: { cuenta: u.username, nombre: u.full_name, rol: u.role } });
    return { restored: true, user_id: u.id, message: reactivate ? 'Cuenta restaurada; ya puede entrar de nuevo.' : 'Cuenta restaurada (sigue desactivada, como estaba).' };
  }
  function purgeStaff(actor, a = {}, ctx = {}) {
    needSuper(actor);
    const u = getStaff(actor, a.user_id, { deleted: true });
    db.transaction(() => {
      // Historial intacto: el nombre queda guardado en el movimiento / existencia
      db.run('UPDATE transactions SET processed_by_name = COALESCE(processed_by_name, ?), user_id = NULL WHERE user_id = ?', [u.full_name, u.id]);
      db.run('UPDATE stock_moves SET user_name = COALESCE(user_name, ?), user_id = NULL WHERE user_id = ?', [u.full_name, u.id]);
      db.run('UPDATE invitations SET used_by = NULL WHERE used_by = ?', [u.id]);
      db.run('UPDATE invitations SET created_by = NULL WHERE created_by = ?', [u.id]);
      db.run('UPDATE child_change_requests SET tutor_id = NULL WHERE tutor_id = ?', [u.id]);
      db.run('UPDATE child_change_requests SET resolved_by = NULL WHERE resolved_by = ?', [u.id]);
      db.run('UPDATE devices SET created_by = NULL WHERE created_by = ?', [u.id]);
      db.run('UPDATE children SET tutor_id = NULL WHERE tutor_id = ?', [u.id]);
      for (const tb of ['refresh_tokens', 'password_resets', 'push_subscriptions', 'push_prefs']) db.run(`DELETE FROM ${tb} WHERE user_id = ?`, [u.id]);
      db.run('DELETE FROM users WHERE id = ?', [u.id]);
    });
    audit(actor, 'personal_eliminado_definitivo', { school_id: u.deleted_school_id, ip: ctx.ip, target_type: 'user', target_id: u.id, details: { cuenta: u.username, nombre: u.full_name, rol: u.role }, severity: 'alta' });
    return { purged: true };
  }

  const methods = {
    previewDeleteChild: (u, a) => previewDeleteChild(u, a),
    deleteChild: (u, a, c) => deleteChild(u, a, c),
    restoreChild: (u, a, c) => restoreChild(u, a, c),
    deleteTutor: (u, a, c) => deleteTutor(u, { user_id: a.user_id }, c),
    restoreTutor: (u, a, c) => restoreTutor(u, a, c),
    listRemoved: (u, a) => listRemoved(u, a),
    purgeChild: (u, a, c) => purgeChild(u, a, c),
    purgeTutor: (u, a, c) => purgeTutor(u, a, c),
    previewDeleteStaff: (u, a) => previewDeleteStaff(u, a),
    deleteStaff: (u, a, c) => deleteStaff(u, a, c),
    restoreStaff: (u, a, c) => restoreStaff(u, a, c),
    purgeStaff: (u, a, c) => purgeStaff(u, a, c),
  };
  return { methods, previewDeleteStaff, deleteStaff, restoreStaff, purgeStaff, previewDeleteChild, deleteChild, restoreChild, deleteTutor, restoreTutor, listRemoved, purgeChild, purgeTutor };
}

module.exports = { createRemovals };
