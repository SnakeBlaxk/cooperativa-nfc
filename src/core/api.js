'use strict';
// Enrutador de llamadas IPC -> servicio. Lista blanca de métodos; el usuario de la sesión
// se toma del proceso principal (nunca del renderer), y el servicio valida permisos.
const { AppError } = require('./service');

function createApi(svc) {
  const M = {
    changePassword: (u, a) => svc.changePassword(u, a.current, a.next),
    createUser: (u, a) => svc.createUser(u, a),
    updateUser: (u, a) => svc.updateUser(u, a.id, a),
    listUsers: (u, a) => svc.listUsers(u, a),
    listChildren: (u) => svc.listChildren(u),
    createChild: (u, a) => svc.createChild(u, a),
    updateChild: (u, a) => svc.updateChild(u, a.id, a),
    requestChildChange: (u, a) => svc.requestChildChange(u, a),
    listChangeRequests: (u, a) => svc.listChangeRequests(u, a),
    changeRequestsUnread: (u) => svc.changeRequestsUnread(u),
    markChangeRequestsRead: (u) => svc.markChangeRequestsRead(u),
    resolveChangeRequest: (u, a) => svc.resolveChangeRequest(u, a),
    listCategories: (u, a) => svc.listCategories(u, a),
    createCategory: (u, a) => svc.createCategory(u, a),
    listProducts: (u, a) => svc.listProducts(u, a),
    createProduct: (u, a) => svc.createProduct(u, a),
    updateProduct: (u, a) => svc.updateProduct(u, a.id, a),
    deleteProduct: (u, a) => svc.deleteProduct(u, a.id),
    listCards: (u) => svc.listCards(u),
    registerCard: (u, a) => svc.registerCard(u, a),
    assignCard: (u, a) => svc.assignCard(u, a.card_id, a.child_id),
    assignCardByUid: (u, a) => svc.assignCardByUid(u, a),
    unassignCard: (u, a) => svc.unassignCard(u, a.card_id),
    setCardStatus: (u, a) => svc.setCardStatus(u, a.card_id, a.status),
    reportLostAndReplace: (u, a) => svc.reportLostAndReplace(u, a.card_id, a.new_uid),
    lookupCard: (u, a) => svc.lookupCard(u, a.uid),
    getLimits: (u, a) => svc.getLimits(u, a.child_id),
    setLimits: (u, a) => svc.setLimits(u, a.child_id, a),
    getProhibitions: (u, a) => svc.getProhibitions(u, a.child_id),
    setProhibitions: (u, a) => svc.setProhibitions(u, a.child_id, a),
    recharge: (u, a) => svc.recharge(u, a),
    adjust: (u, a) => svc.adjust(u, a),
    purchase: (u, a) => svc.purchase(u, a),
    listMovements: (u, a) => svc.listMovements(u, a),
    childSummary: (u, a) => svc.childSummary(u, a.child_id),
    dashboard: (u) => svc.dashboard(u),
    addStock: (u, a) => svc.addStock(u, a),
    listStockMoves: (u, a) => svc.listStockMoves(u, a),
    getInventorySettings: (u) => svc.getInventorySettings(u),
    setInventorySettings: (u, a) => svc.setInventorySettings(u, a),
    listSchoolNotices: (u) => svc.listSchoolNotices(u),
    markNoticesRead: (u) => svc.markNoticesRead(u),
    reverseSale: (u, a) => svc.reverseSale(u, a),
    report: (u, a) => svc.report(u, a),
    getPushPrefs: (u) => svc.getPushPrefs(u),
    setPushPrefs: (u, a) => svc.setPushPrefs(u, a),
    pushSubscribe: (u, a) => svc.pushSubscribe(u, a),
    pushUnsubscribe: (u, a) => svc.pushUnsubscribe(u, a),
  };
  // session: objeto mutable { user }
  function handle(session, method, args) {
    try {
      args = args && typeof args === 'object' ? args : {};
      if (method === 'login') { session.user = svc.login(args.username, args.password); return { ok: true, data: session.user }; }
      if (method === 'logout') { session.user = null; return { ok: true, data: null }; }
      if (method === 'me') return { ok: true, data: session.user || null };
      const fn = Object.prototype.hasOwnProperty.call(M, method) ? M[method] : null;
      if (!fn) throw new AppError('Operación desconocida', 'NO_ENCONTRADO');
      if (!session.user) throw new AppError('Sesión no iniciada', 'NO_AUTENTICADO');
      return { ok: true, data: fn(session.user, args) };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, error: e.message, code: e.code };
      console.error('[api]', method, e);
      return { ok: false, error: 'Error interno: ' + e.message, code: 'INTERNO' };
    }
  }
  return { handle, methods: Object.keys(M) };
}
module.exports = { createApi };
