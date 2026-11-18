/**
 * Global configuration constants and pure helper utilities for
 * Logistic Performance Xpress (Google Apps Script V8).
 */

var CONFIG = {
  SPREADSHEET_ID: '1vTtD4qf38J5h8SSME7Enq-r_vTV563hNmUaHrv0IePU',
  TIMEZONE: 'Asia/Bangkok',
  SLA_DAYS: 8,
  SHEETS: {
    ORDERS: 'db_orders',
    SHIPPERS: 'db_shippers',
    REPORT: 'order_report',
    OP_LOGS: 'op_logs'
  },
  ORDER_HEADERS: [
    'order_id',
    'resi',
    'shipper_id',
    'return_flag',
    'status',
    'current_hub',
    'destination_address',
    'destination_hub',
    'inbound_date',
    'end_date'
  ],
  REPORT_HEADERS: [
    'order_id',
    'resi',
    'shipper_name',
    'pickup_address',
    'status',
    'return_flag',
    'current_hub_location',
    'destination_hub_location',
    'destination_address',
    'inbound_date',
    'end_date'
  ],
  OP_LOG_HEADERS: [
    'log_id',
    'timestamp',
    'order_id',
    'action',
    'from_status',
    'to_status',
    'current_hub',
    'courier',
    'notes',
    'operator_email'
  ],
  STATUSES: {
    PENDING_PICKUP: 'Pending Pickup',
    TRANSIT: 'Transit',
    ON_SHIPMENT: 'On Shipment',
    DELIVERED: 'Delivered',
    RETURNED: 'Returned'
  },
  HUBS: {
    'HUB-JKT': 'Jakarta Central Hub',
    'HUB-BDG': 'Bandung West Hub',
    'HUB-SUB': 'Surabaya East Hub'
  }
};

/**
 * Normalizes legacy 3-digit shipper IDs (e.g. 'SHP-001' -> 'SHP-01').
 * Only transforms strings matching /^SHP-0*(\d+)$/i.
 *
 * @param {string|null|undefined} rawId
 * @return {string}
 */
function normalizeShipperId(rawId) {
  if (rawId === null || rawId === undefined) {
    return '';
  }
  var s = String(rawId).trim();
  if (!s) {
    return '';
  }
  var match = /^SHP-0*(\d+)$/i.exec(s);
  if (!match) {
    return s;
  }
  var num = parseInt(match[1], 10);
  var padded = num < 10 ? '0' + num : String(num);
  return 'SHP-' + padded;
}

/**
 * Maps a hub code to its human-readable hub name.
 *
 * @param {string|null|undefined} hubCode
 * @return {string}
 */
function getHubName(hubCode) {
  if (hubCode === null || hubCode === undefined) {
    return '';
  }
  var code = String(hubCode).trim();
  if (!code) {
    return '';
  }
  return Object.prototype.hasOwnProperty.call(CONFIG.HUBS, code)
    ? CONFIG.HUBS[code]
    : code;
}

/**
 * Validates Gregorian calendar year/month/day without rollover.
 *
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day 1-31
 * @return {boolean}
 */
function isValidCalendarYmd_(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  var d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() + 1 === month &&
    d.getUTCDate() === day
  );
}

/**
 * Formats a Date, Sheets serial number, or date string to 'yyyy-MM-dd'
 * in CONFIG.TIMEZONE ('Asia/Bangkok'). Returns '' for empty/invalid inputs.
 *
 * @param {Date|number|string|null|undefined} dateOrStr
 * @return {string}
 */
function formatDateYmd(dateOrStr) {
  if (dateOrStr === null || dateOrStr === undefined) {
    return '';
  }

  // Cross-realm safe Date check (works across node:vm realm boundary and GAS V8)
  if (Object.prototype.toString.call(dateOrStr) === '[object Date]') {
    if (isNaN(dateOrStr.getTime())) {
      return '';
    }
    return Utilities.formatDate(dateOrStr, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  if (typeof dateOrStr === 'number') {
    if (!isFinite(dateOrStr)) {
      return '';
    }
    if (dateOrStr > 1000000000) {
      return Utilities.formatDate(new Date(dateOrStr), CONFIG.TIMEZONE, 'yyyy-MM-dd');
    }
    if (dateOrStr > 0 && dateOrStr < 100000) {
      return new Date(Math.round((Math.floor(dateOrStr) - 25569) * 86400000))
        .toISOString()
        .slice(0, 10);
    }
    return '';
  }

  var s = String(dateOrStr).trim();
  if (!s) {
    return '';
  }

  var ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (ymdMatch) {
    var y = parseInt(ymdMatch[1], 10);
    var m = parseInt(ymdMatch[2], 10);
    var d = parseInt(ymdMatch[3], 10);
    return isValidCalendarYmd_(y, m, d) ? s : '';
  }

  // Handle Google Sheets en_US M/D/YYYY display format (e.g. '10/6/2026')
  var usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (usMatch) {
    var m2 = parseInt(usMatch[1], 10);
    var d2 = parseInt(usMatch[2], 10);
    var y2 = parseInt(usMatch[3], 10);
    if (!isValidCalendarYmd_(y2, m2, d2)) {
      return '';
    }
    var mm = m2 < 10 ? '0' + m2 : String(m2);
    var dd = d2 < 10 ? '0' + d2 : String(d2);
    return String(y2) + '-' + mm + '-' + dd;
  }

  // ISO timestamp with explicit timezone offset -> convert to Asia/Bangkok calendar day
  var isoOffsetMatch = /^(\d{4})-(\d{2})-(\d{2})T.*(Z|[+-]\d{2}:?\d{2})$/i.exec(s);
  if (isoOffsetMatch) {
    var yIso = parseInt(isoOffsetMatch[1], 10);
    var mIso = parseInt(isoOffsetMatch[2], 10);
    var dIso = parseInt(isoOffsetMatch[3], 10);
    if (!isValidCalendarYmd_(yIso, mIso, dIso)) {
      return '';
    }
    var dt = new Date(s);
    if (isNaN(dt.getTime())) {
      return '';
    }
    return Utilities.formatDate(dt, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  // ISO timestamp without timezone offset -> preserve calendar date prefix
  var isoLocal = /^(\d{4})-(\d{2})-(\d{2})T/.exec(s);
  if (isoLocal) {
    var y3 = parseInt(isoLocal[1], 10);
    var m3 = parseInt(isoLocal[2], 10);
    var d3 = parseInt(isoLocal[3], 10);
    return isValidCalendarYmd_(y3, m3, d3)
      ? isoLocal[1] + '-' + isoLocal[2] + '-' + isoLocal[3]
      : '';
  }

  var parsed = new Date(s);
  if (isNaN(parsed.getTime())) {
    return '';
  }
  return Utilities.formatDate(parsed, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Returns today's date formatted as 'yyyy-MM-dd' in CONFIG.TIMEZONE.
 *
 * @return {string}
 */
function getTodayYmd() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Returns current ISO-8601 timestamp with offset in CONFIG.TIMEZONE.
 *
 * @return {string}
 */
function getNowTimestamp() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}
