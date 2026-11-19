'use strict';
// Eliminación DEFINITIVA de una escuela (solo superadministrador).
// - Confirmación fuerte: nombre exacto de la escuela + contraseña del superadministrador.
// - Antes de borrar se guarda una copia JSON completa de la escuela en la tabla `deleted_schools`
//   (dentro de la misma base, que se replica a Turso/disco como el resto) para poder restaurarla a mano.
// - Todo ocurre en UNA transacción: si algo falla no se borra nada. No toca otras escuelas.
// - La bitácora (audit_log) de la escuela se conserva para auditoría; se agrega la entrada "escuela_eliminada".
// - Las tarjetas del inventario de Zuki que estaban en la escuela quedan BLOQUEADAS y sin escuela
//   (físicamente siguen allá); se pueden desbloquear desde Inventario si se recuperan.
const bcrypt = require('bcryptjs');
const { AppError, fmtLocal } = require('./service');

// Tablas que NUNCA se tocan con el barrido genérico por school_id
const KEEP_TABLES = new Set(['audit_log', 'deleted_schools', 'schools', 'card_stock', 'users']);
const MAX_PASS_FAILS = 5; // intentos fallidos de contraseña en 15 min antes de pedir esperar

function createSchoolDelete(db, { security = null, now = () => new Date() } = {}) {
  const ts = () => fmtLocal(now());
  const audit = (actor, action, o) => { if (security) try { security.audit(actor, action, o); } catch (e) { console.error('[escuela]', e.message); } };
  const need = (actor) => { if (!actor || actor.role !== 'superadmin') throw new AppError('Solo el superadministrador puede eliminar una escuela', 'PROHIBIDO'); };
  const getSchool = (id) => {
    const s = db.get('SELECT * FROM schools WHERE id = ?', [Number(id) || 0]);
    if (!s) throw new AppError('Escuela no encontrada', 'NO_ENCONTRADO');
    return s;
  };
  const tables = () => db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
  const colsOf = (t) => db.all(`PRAGMA table_info(${t})`).map((c) => c.name);
  const inList = (ids) => (ids.length ? ids.map(Number).join(',') : 'NULL'); // solo enteros (vienen de la base)
  const ids = (sql, p = []) => db.all(sql, p).map((r) => r.id);

  // Qué filas pertenecen a la escuela (se usa para la vista previa, la copia y el borrado)
  function scope(sid) {
    const C = ids('SELECT id FROM children WHERE school_id = ?', [sid]);
    const K = ids('SELECT id FROM cards WHERE school_id = ?', [sid]);
    const P = ids('SELECT id FROM products WHERE school_id = ?', [sid]);
    const G = ids('SELECT id FROM categories WHERE school_id = ?', [sid]);
    const T = ids(`SELECT id FROM transactions WHERE school_id = ? OR child_id IN (${inList(C)}) OR card_id IN (${inList(K)})`, [sid]);
    const staff = ids("SELECT id FROM users WHERE role IN ('admin','cajero') AND (school_id = ? OR deleted_school_id = ?)", [sid, sid]);
    // Papás/tutores de la escuela: se borran solo si NO tienen hijos en otra escuela; si sí tienen, se quedan
    // y pasan a esa otra escuela.
    // (Un tutor registrado en OTRA escuela no se borra aunque tenga un hijo aquí: solo se desliga.)
    const tutorCand = ids(`SELECT id FROM users WHERE role = 'tutor' AND (school_id = ? OR deleted_school_id = ? OR (school_id IS NULL AND id IN (SELECT tutor_id FROM children WHERE school_id = ? AND tutor_id IS NOT NULL)))`, [sid, sid, sid]);
    const tutors = []; const tutorsKept = [];
    for (const id of tutorCand) {
      const other = db.get('SELECT school_id FROM children WHERE tutor_id = ? AND school_id <> ? ORDER BY id LIMIT 1', [id, sid]);
      if (other) tutorsKept.push({ id, school_id: other.school_id });
      else tutors.push(id);
    }
    return { C, K, P, G, T, staff, tutors, tutorsKept, U: [...staff, ...tutors] };
  }

  function counts(sid, sc) {
    const n = (sql, p = []) => db.get(sql, p).n;
    return {
      alumnos: sc.C.length,
      papas_tutores: sc.tutors.length,
      papas_tutores_conservados: sc.tutorsKept.length,
      cuentas_personal: sc.staff.length,
      tarjetas: sc.K.length,
      productos: sc.P.length,
      categorias: sc.G.length,
      movimientos: sc.T.length,
      mensualidades_alumnos: n('SELECT COUNT(*) AS n FROM swimmer_payments WHERE school_id = ?', [sid]),
      pagos_escuela: n('SELECT COUNT(*) AS n FROM school_payments WHERE school_id = ?', [sid]),
      avisos: n('SELECT COUNT(*) AS n FROM school_notices WHERE school_id = ?', [sid]) + n('SELECT COUNT(*) AS n FROM whatsapp_broadcasts WHERE school_id = ?', [sid]),
      cajas: n('SELECT COUNT(*) AS n FROM devices WHERE school_id = ?', [sid]),
      tarjetas_inventario: n('SELECT COUNT(*) AS n FROM card_stock WHERE school_id = ?', [sid]),
    };
  }

  function preview(actor, a = {}) {
    need(actor);
    const s = getSchool(a.school_id);
    const sc = scope(s.id);
    const balance = db.get('SELECT COALESCE(SUM(balance_cents),0) AS s FROM cards WHERE school_id = ?', [s.id]).s;
    return { school: { id: s.id, name: s.name, status: s.status }, counts: counts(s.id, sc), balance_cents: balance };
  }

  // Copia JSON de todo lo de la escuela (sin tokens de sesión ni suscripciones push)
  function snapshot(s, sc) {
    const all = (sql, p = []) => db.all(sql, p);
    const U = inList(sc.U); const C = inList(sc.C); const P = inList(sc.P); const G = inList(sc.G); const T = inList(sc.T);
    const data = {
      schools: [s],
      users: all(`SELECT * FROM users WHERE id IN (${U})`),
      tutors_kept: sc.tutorsKept,
      children: all(`SELECT * FROM children WHERE id IN (${C})`),
      cards: all(`SELECT * FROM cards WHERE id IN (${inList(sc.K)})`),
      categories: all(`SELECT * FROM categories WHERE id IN (${G})`),
      products: all(`SELECT * FROM products WHERE id IN (${P})`),
      transactions: all(`SELECT * FROM transactions WHERE id IN (${T})`),
      transaction_items: all(`SELECT * FROM transaction_items WHERE transaction_id IN (${T})`),
      limits: all(`SELECT * FROM limits WHERE child_id IN (${C})`),
      prohibited_products: all(`SELECT * FROM prohibited_products WHERE child_id IN (${C}) OR product_id IN (${P})`),
      prohibited_categories: all(`SELECT * FROM prohibited_categories WHERE child_id IN (${C}) OR category_id IN (${G})`),
      low_balance_state: all(`SELECT * FROM low_balance_state WHERE child_id IN (${C})`),
      invitations: all(`SELECT * FROM invitations WHERE child_id IN (${C})`),
      child_change_requests: all(`SELECT * FROM child_change_requests WHERE school_id = ? OR child_id IN (${C})`, [s.id]),
      swimmer_plans: all(`SELECT * FROM swimmer_plans WHERE school_id = ? OR child_id IN (${C})`, [s.id]),
      swimmer_payments: all(`SELECT * FROM swimmer_payments WHERE school_id = ? OR child_id IN (${C})`, [s.id]),
      stock_moves: all(`SELECT * FROM stock_moves WHERE school_id = ? OR product_id IN (${P})`, [s.id]),
      push_prefs: all(`SELECT * FROM push_prefs WHERE user_id IN (${U})`),
      card_stock: all('SELECT * FROM card_stock WHERE school_id = ?', [s.id]),
      meta: all(`SELECT * FROM meta WHERE key IN (${sc.C.map(() => '?').join(',') || 'NULL'})`, sc.C.map((c) => `saldo_pendiente_child_${c}`)),
    };
    // Cualquier otra tabla con school_id (pagos, avisos, cajas, WhatsApp, alertas, seguridad, etc.)
    for (const t of tables()) {
      if (data[t] || KEEP_TABLES.has(t) || !colsOf(t).includes('school_id')) continue;
      data[t] = all(`SELECT * FROM ${t} WHERE school_id = ?`, [s.id]);
    }
    data.audit_log_reference = 'La bitácora de la escuela se conserva en audit_log (school_id = ' + s.id + ').';
    return data;
  }

  // Revisa la contraseña del superadministrador (con límite de intentos)
  function checkPassword(actor, password, ctx, s) {
    const u = db.get("SELECT * FROM users WHERE id = ? AND role = 'superadmin'", [actor.id]);
    if (!u) throw new AppError('Solo el superadministrador puede eliminar una escuela', 'PROHIBIDO');
    const since = fmtLocal(new Date(now().getTime() - 15 * 60000));
    const fails = db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'escuela_eliminar_rechazada' AND actor_id = ? AND created_at >= ? AND details LIKE '%contraseña%'", [u.id, since]).n;
    if (fails >= MAX_PASS_FAILS) throw new AppError('Demasiados intentos con contraseña incorrecta. Espere 15 minutos.', 'LIMITE_INTENTOS');
    if (!password || !bcrypt.compareSync(String(password), u.password_hash)) {
      audit(actor, 'escuela_eliminar_rechazada', { school_id: s.id, ip: ctx.ip, target_type: 'school', target_id: s.id, details: { escuela: s.name, motivo: 'contraseña incorrecta' }, severity: 'alta' });
      if (security && fails + 1 >= 3) security.alert({ kind: 'eliminar_escuela_rechazada', severity: 'alta', school_id: null, message: `${fails + 1} intentos de eliminar la escuela "${s.name}" con contraseña incorrecta.`, dedupe: 'deldel:' + s.id });
      throw new AppError('Contraseña incorrecta', 'VALIDACION');
    }
  }

  // a: { school_id, confirm_name, password }
  function deleteSchool(actor, a = {}, ctx = {}) {
    need(actor);
    const s = getSchool(a.school_id);
    if (String(a.confirm_name || '').trim() !== s.name.trim()) {
      audit(actor, 'escuela_eliminar_rechazada', { school_id: s.id, ip: ctx.ip, target_type: 'school', target_id: s.id, details: { escuela: s.name, motivo: 'nombre no coincide' }, severity: 'aviso' });
      throw new AppError(`Para confirmar escriba exactamente el nombre de la escuela: ${s.name}`, 'VALIDACION');
    }
    checkPassword(actor, a.password, ctx, s);
    const lockdown = security && security.isLockdown ? security.isLockdown() : false;
    const t = ts();
    const result = db.transaction(() => {
      const fkBefore = db.all('PRAGMA foreign_key_check').length; // referencias rotas que ya existían (no se culpan a este borrado)
      const sc = scope(s.id);
      const cnt = counts(s.id, sc);
      const data = snapshot(s, sc);
      const json = JSON.stringify({ version: 1, deleted_at: t, deleted_by: actor.username || actor.full_name, school_id: s.id, data });
      const backupId = db.run('INSERT INTO deleted_schools (original_school_id, school_uuid, school_name, deleted_at, deleted_by, counts, bytes, data) VALUES (?,?,?,?,?,?,?,?)',
        [s.id, s.uuid || null, s.name, t, actor.full_name || actor.username || 'superadmin', JSON.stringify(cnt), Buffer.byteLength(json), json]).lastId;

      const U = inList(sc.U); const C = inList(sc.C); const P = inList(sc.P); const G = inList(sc.G); const T = inList(sc.T); const K = inList(sc.K);
      const run = (sql, p = []) => db.run(sql, p);
      // 1) Sesiones de todas las cuentas de la escuela (también de los tutores que se conservan)
      const sessionUsers = [...sc.U, ...sc.tutorsKept.map((x) => x.id)];
      for (const id of sessionUsers) {
        run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [id]);
        run('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ? AND revoked = 0', [id]);
      }
      // 2) Ventas, recargas y detalle
      run(`DELETE FROM transaction_items WHERE transaction_id IN (${T})`);
      run(`UPDATE transaction_items SET product_id = NULL WHERE product_id IN (${P})`); // (otra escuela; no debería pasar)
      run(`DELETE FROM transactions WHERE id IN (${T})`);
      run(`DELETE FROM stock_moves WHERE school_id = ? OR product_id IN (${P})`, [s.id]);
      // 3) Datos por alumno
      run(`DELETE FROM prohibited_products WHERE child_id IN (${C}) OR product_id IN (${P})`);
      run(`DELETE FROM prohibited_categories WHERE child_id IN (${C}) OR category_id IN (${G})`);
      for (const tb of ['limits', 'low_balance_state', 'invitations']) run(`DELETE FROM ${tb} WHERE child_id IN (${C})`);
      for (const tb of ['child_change_requests', 'swimmer_plans', 'swimmer_payments']) run(`DELETE FROM ${tb} WHERE school_id = ? OR child_id IN (${C})`, [s.id]);
      for (const c of sc.C) run('DELETE FROM meta WHERE key = ?', [`saldo_pendiente_child_${c}`]);
      // 4) Tarjetas, alumnos, productos y categorías
      run(`UPDATE cards SET child_id = NULL WHERE child_id IN (${C}) AND id NOT IN (${K})`);
      run(`DELETE FROM cards WHERE id IN (${K})`);
      run(`UPDATE children SET tutor_id = NULL WHERE tutor_id IN (${U}) AND id NOT IN (${C})`);
      run(`DELETE FROM children WHERE id IN (${C})`);
      run(`DELETE FROM products WHERE id IN (${P})`);
      run(`DELETE FROM categories WHERE id IN (${G})`);
      // 5) Inventario de tarjetas de Zuki: quedan bloqueadas y sin escuela (se desbloquean desde Inventario)
      run("UPDATE card_stock SET status = CASE WHEN status = 'danada' THEN 'danada' ELSE 'bloqueada' END, school_id = NULL, delivered_at = NULL, note = TRIM(COALESCE(note,'') || ' · Escuela eliminada: ' || ?), updated_at = ? WHERE school_id = ?", [s.name, t, s.id]);
      // 6) Todo lo demás con school_id (pagos de mensualidad, avisos, cajas, sincronización, WhatsApp, alertas,
      //    seguridad de la escuela y tablas futuras). La bitácora (audit_log) se conserva.
      for (const tb of tables()) {
        if (KEEP_TABLES.has(tb) || !colsOf(tb).includes('school_id')) continue;
        run(`DELETE FROM ${tb} WHERE school_id = ?`, [s.id]);
      }
      // 7) Cuentas: referencias en filas que se conservan (otras escuelas) quedan sin usuario
      run(`UPDATE transactions SET processed_by_name = COALESCE(processed_by_name, (SELECT full_name FROM users u WHERE u.id = transactions.user_id)), user_id = NULL WHERE user_id IN (${U})`);
      run(`UPDATE stock_moves SET user_id = NULL WHERE user_id IN (${U})`);
      run(`UPDATE invitations SET used_by = NULL WHERE used_by IN (${U})`);
      run(`UPDATE invitations SET created_by = NULL WHERE created_by IN (${U})`);
      run(`UPDATE child_change_requests SET tutor_id = NULL WHERE tutor_id IN (${U})`);
      run(`UPDATE child_change_requests SET resolved_by = NULL WHERE resolved_by IN (${U})`);
      run(`UPDATE devices SET created_by = NULL WHERE created_by IN (${U}) AND school_id <> ?`, [s.id]);
      for (const tb of ['refresh_tokens', 'password_resets', 'push_subscriptions', 'push_prefs']) run(`DELETE FROM ${tb} WHERE user_id IN (${U})`);
      // Tutores con hijos en otra escuela: se quedan y pasan a esa escuela
      for (const x of sc.tutorsKept) run('UPDATE users SET school_id = ?, deleted_school_id = CASE WHEN deleted_school_id = ? THEN ? ELSE deleted_school_id END WHERE id = ?', [x.school_id, s.id, x.school_id, x.id]);
      run(`DELETE FROM users WHERE id IN (${U}) AND role <> 'superadmin'`);
      // Cuentas de personal desligadas que aún apunten a la escuela (no debería quedar ninguna)
      const left = db.get("SELECT COUNT(*) AS n FROM users WHERE (school_id = ? OR deleted_school_id = ?) AND role <> 'superadmin'", [s.id, s.id]).n;
      if (left) throw new AppError('Quedaron cuentas ligadas a la escuela; no se eliminó nada', 'CONFLICTO');
      run('DELETE FROM schools WHERE id = ?', [s.id]);
      // 8) Verificación: ninguna referencia rota (si la hay, se deshace todo)
      const broken = db.all('PRAGMA foreign_key_check');
      if (broken.length > fkBefore) throw new AppError(`No se eliminó la escuela: quedarían referencias rotas (${broken.slice(0, 3).map((b) => b.table).join(', ')})`, 'CONFLICTO');
      return { backupId, cnt, sessions: sessionUsers.length };
    });
    audit(actor, 'escuela_eliminada', { school_id: s.id, ip: ctx.ip, target_type: 'school', target_id: s.id,
      details: { escuela: s.name, respaldo: result.backupId, borrado: result.cnt, sesiones_cerradas: result.sessions, alerta_roja: lockdown || undefined }, severity: 'critica' });
    if (security) try { security.alert({ kind: 'escuela_eliminada', severity: 'alta', school_id: null, message: `${actor.full_name || actor.username} eliminó definitivamente la escuela "${s.name}". Respaldo #${result.backupId} guardado.`, ref_type: 'deleted_school', ref_id: result.backupId }); } catch (e) { console.error('[escuela]', e.message); }
    return { deleted: true, school_id: s.id, name: s.name, backup_id: result.backupId, counts: result.cnt,
      message: `La escuela "${s.name}" se eliminó definitivamente. Se guardó un respaldo (#${result.backupId}) por si fue un error.` };
  }

  function listDeleted(actor) {
    need(actor);
    return db.all('SELECT id, original_school_id AS school_id, school_name, deleted_at, deleted_by, counts, bytes FROM deleted_schools ORDER BY id DESC LIMIT 200')
      .map((r) => ({ ...r, counts: (() => { try { return JSON.parse(r.counts); } catch (_) { return null; } })() }));
  }
  function getDeletedBackup(actor, a = {}, ctx = {}) {
    need(actor);
    const r = db.get('SELECT * FROM deleted_schools WHERE id = ?', [Number(a.id) || 0]);
    if (!r) throw new AppError('Respaldo no encontrado', 'NO_ENCONTRADO');
    audit(actor, 'respaldo_escuela_descargado', { school_id: null, ip: ctx.ip, target_type: 'deleted_school', target_id: r.id, details: { escuela: r.school_name }, severity: 'aviso' });
    return { id: r.id, school_name: r.school_name, deleted_at: r.deleted_at, backup: JSON.parse(r.data) };
  }

  const methods = {
    previewDeleteSchool: (u, a) => preview(u, a),
    deleteSchool: (u, a, c) => deleteSchool(u, a, c),
    listDeletedSchools: (u) => listDeleted(u),
    getDeletedSchoolBackup: (u, a, c) => getDeletedBackup(u, a, c),
  };
  return { methods, preview, deleteSchool, listDeleted, getDeletedBackup };
}

module.exports = { createSchoolDelete };
