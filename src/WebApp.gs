/**
 * Google Apps Script Web App entrypoint & RPC endpoints for
 * Logistic Performance Xpress.
 */

var VALID_VIEWS_ = ['dashboard', 'input', 'pickup', 'sort', 'delivery'];

/**
 * Normalizes requested view parameter to a valid view key.
 *
 * @param {string=} rawView
 * @return {string}
 */
function normalizeViewKey_(rawView) {
  var v = String(rawView || 'dashboard').trim().toLowerCase();
  return VALID_VIEWS_.indexOf(v) !== -1 ? v : 'dashboard';
}

/**
 * Web App HTTP GET entrypoint.
 * Supports ?view=dashboard|input|pickup|sort|delivery.
 *
 * @param {Object=} e
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var template = HtmlService.createTemplateFromFile('Index');
  template.initialView = normalizeViewKey_(params.view);
  template.initialSearch = params.search ? String(params.search).trim() : '';
  return template
    .evaluate()
    .setTitle('Logistic Performance Xpress — Operations & Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Includes partial HTML files (Styles, Scripts) inside Index.html.
 *
 * @param {string} filename
 * @return {string}
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Enriches an array of order objects with agingDays and agingType.
 *
 * @param {Array<Object>} orders
 * @return {Array<Object>}
 */
function enrichOrdersWithAging_(orders) {
  var refDate = getTodayYmd();
  var out = [];
  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    var aging = computeOrderAging(o, refDate);
    out.push({
      rowNumber: o.rowNumber,
      order_id: o.order_id,
      resi: o.resi,
      shipper_id: o.shipper_id,
      normalized_shipper_id: o.normalized_shipper_id,
      shipper_name: o.shipper_name,
      pickup_address: o.pickup_address,
      return_flag: o.return_flag,
      status: o.status,
      current_hub: o.current_hub,
      current_hub_name: o.current_hub_name,
      destination_address: o.destination_address,
      destination_hub: o.destination_hub,
      destination_hub_name: o.destination_hub_name,
      inbound_date: o.inbound_date,
      end_date: o.end_date,
      agingDays: aging.agingDays,
      agingType: aging.agingType
    });
  }
  return out;
}

/**
 * Returns full initial state for SPA bootstrap: dashboard, orders, shippers, hubs, statuses.
 *
 * @param {Object=} filters
 * @return {Object}
 */
function apiGetBootstrapData(filters) {
  var f = filters || {};
  var dashboard = getDashboardData(f);
  var orders = enrichOrdersWithAging_(getOrders());
  var shippers = getShippers();
  return {
    ok: true,
    todayYmd: getTodayYmd(),
    dashboard: dashboard,
    orders: orders,
    shippers: shippers,
    hubs: CONFIG.HUBS,
    statuses: Object.values(CONFIG.STATUSES),
    opLogs: dashboard.recentLogs || []
  };
}

/**
 * RPC: Returns filtered Dashboard KPIs, 7 charts, High Aging table, and recent logs.
 *
 * @param {Object=} filters
 * @return {Object}
 */
function apiGetDashboardData(filters) {
  return getDashboardData(filters || {});
}

/**
 * RPC: Returns operational orders list (optionally filtered) with aging fields and recent logs.
 *
 * @param {Object=} filters
 * @return {Object}
 */
function apiGetOrdersQueue(filters) {
  var orders = enrichOrdersWithAging_(getOrders(filters || {}));
  return {
    ok: true,
    todayYmd: getTodayYmd(),
    orders: orders,
    opLogs: getOpLogs(25)
  };
}

/**
 * RPC: Creates a new order in db_orders.
 *
 * @param {Object} payload
 * @return {Object}
 */
function apiCreateOrder(payload) {
  return createOrder(payload);
}

/**
 * RPC: Confirms pickup (Pending Pickup -> Transit).
 *
 * @param {Object} payload
 * @return {Object}
 */
function apiConfirmPickup(payload) {
  return confirmPickup(payload);
}

/**
 * RPC: Processes Sort actions (TRANSFER_HUB, DISPATCH_DELIVERY, FLAG_RETURN).
 *
 * @param {Object} payload
 * @return {Object}
 */
function apiProcessSort(payload) {
  return processSort(payload);
}

/**
 * RPC: Processes Delivery actions (MARK_DELIVERED, FAILED_RTS, MARK_RETURNED).
 *
 * @param {Object} payload
 * @return {Object}
 */
function apiProcessDelivery(payload) {
  return processDelivery(payload);
}

/**
 * RPC: Syncs live db_orders + db_shippers into order_report!A2:K.
 *
 * @return {Object}
 */
function apiSyncOrderReport() {
  return syncOrderReport();
}
