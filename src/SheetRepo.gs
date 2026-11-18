/**
 * Spreadsheet persistence layer and ScriptLock wrapper for
 * Logistic Performance Xpress (Google Apps Script V8).
 */

/**
 * Returns the bound Spreadsheet or opens CONFIG.SPREADSHEET_ID as fallback.
 *
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getActiveBook() {
  return (
    SpreadsheetApp.getActiveSpreadsheet() ||
    SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
  );
}

var scriptLockDepth_ = 0;

/**
 * Executes fn under LockService.getScriptLock(), supporting safe nested
 * re-entrancy and always releasing the outermost lock in finally.
 *
 * @param {Function} fn
 * @param {number=} timeoutMs
 * @return {*}
 */
function withScriptLock(fn, timeoutMs) {
  if (typeof fn !== 'function') {
    throw new Error('withScriptLock requires a callback function.');
  }
  if (scriptLockDepth_ > 0) {
    scriptLockDepth_ += 1;
    try {
      return fn();
    } finally {
      scriptLockDepth_ -= 1;
    }
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(timeoutMs || 10000);
  scriptLockDepth_ = 1;
  try {
    return fn();
  } finally {
    scriptLockDepth_ = 0;
    lock.releaseLock();
  }
}

/**
 * Builds header -> column index map from header row.
 *
 * @param {Array} headerRow
 * @return {Object}
 */
function buildHeaderIndex_(headerRow) {
  var map = {};
  if (!Array.isArray(headerRow)) {
    return map;
  }
  for (var i = 0; i < headerRow.length; i++) {
    var key = String(headerRow[i] || '').trim().toLowerCase();
    if (key && !(key in map)) {
      map[key] = i;
    }
  }
  return map;
}

/**
 * Reads all shippers from db_shippers!A:C with normalized shipper_id.
 *
 * @return {Array<{shipper_id: string, shipper_name: string, pickup_address: string}>}
 */
function getShippers() {
  var book = getActiveBook();
  var sheet = book.getSheetByName(CONFIG.SHEETS.SHIPPERS);
  if (!sheet) {
    throw new Error('Required sheet missing: ' + CONFIG.SHEETS.SHIPPERS);
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  var numCols = Math.max(3, sheet.getLastColumn());
  var values = sheet.getRange(1, 1, lastRow, numCols).getValues();
  var hdr = buildHeaderIndex_(values[0]);
  var idxId = 'shipper_id' in hdr ? hdr.shipper_id : 0;
  var idxName = 'shipper_name' in hdr ? hdr.shipper_name : 1;
  var idxAddr = 'pickup_address' in hdr ? hdr.pickup_address : 2;

  var shippers = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var rawId = String(row[idxId] || '').trim();
    var name = String(row[idxName] || '').trim();
    var addr = String(row[idxAddr] || '').trim();
    if (!rawId && !name) {
      continue;
    }
    shippers.push({
      shipper_id: normalizeShipperId(rawId),
      shipper_name: name,
      pickup_address: addr
    });
  }
  return shippers;
}

/**
 * Reads orders from db_orders!A:J, joins db_shippers via normalized shipper_id
 * without mutating legacy SHP-00x values in db_orders, and applies optional filters.
 *
 * @param {Object=} options
 * @return {Array<Object>}
 */
function getOrders(options) {
  var book = getActiveBook();
  var sheet = book.getSheetByName(CONFIG.SHEETS.ORDERS);
  if (!sheet) {
    throw new Error('Required sheet missing: ' + CONFIG.SHEETS.ORDERS);
  }
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  // Strictly read 10 columns (A:J) for BigQuery schema compatibility
  var values = sheet.getRange(1, 1, lastRow, 10).getValues();
  var hdr = buildHeaderIndex_(values[0]);
  var idxOrderId = 'order_id' in hdr ? hdr.order_id : 0;
  var idxResi = 'resi' in hdr ? hdr.resi : 1;
  var idxShipperId = 'shipper_id' in hdr ? hdr.shipper_id : 2;
  var idxReturnFlag = 'return_flag' in hdr ? hdr.return_flag : 3;
  var idxStatus = 'status' in hdr ? hdr.status : 4;
  var idxCurrentHub = 'current_hub' in hdr ? hdr.current_hub : 5;
  var idxDestAddress = 'destination_address' in hdr ? hdr.destination_address : 6;
  var idxDestHub = 'destination_hub' in hdr ? hdr.destination_hub : 7;
  var idxInboundDate = 'inbound_date' in hdr ? hdr.inbound_date : 8;
  var idxEndDate = 'end_date' in hdr ? hdr.end_date : 9;

  var shippers = getShippers();
  var shipperMap = {};
  for (var s = 0; s < shippers.length; s++) {
    shipperMap[normalizeShipperId(shippers[s].shipper_id)] = shippers[s];
  }

  var opts = options || {};
  var filterStatus = opts.status ? String(opts.status).trim() : '';
  var filterCurrentHub = opts.current_hub ? String(opts.current_hub).trim() : '';
  var filterDestHub = opts.destination_hub ? String(opts.destination_hub).trim() : '';
  var filterShipperId = opts.shipper_id ? normalizeShipperId(opts.shipper_id) : '';
  var hasReturnFlagFilter =
    opts.return_flag !== undefined && opts.return_flag !== null && opts.return_flag !== '';
  var filterReturnFlag = hasReturnFlagFilter ? (Number(opts.return_flag) === 1 ? 1 : '') : null;
  var filterSearch = opts.search ? String(opts.search).trim().toLowerCase() : '';

  var orders = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var orderId = String(row[idxOrderId] || '').trim();
    var resi = String(row[idxResi] || '').trim();
    if (!orderId && !resi) {
      continue;
    }

    var rawShipperId = String(row[idxShipperId] || '').trim();
    var normalizedShipperId = normalizeShipperId(rawShipperId);
    var shipper = shipperMap[normalizedShipperId] || null;
    var returnFlag =
      row[idxReturnFlag] === 1 || String(row[idxReturnFlag]).trim() === '1' ? 1 : '';
    var status = String(row[idxStatus] || '').trim();
    var currentHub = String(row[idxCurrentHub] || '').trim();
    var destAddress = String(row[idxDestAddress] || '').trim();
    var destHub = String(row[idxDestHub] || '').trim();
    var inboundDate = formatDateYmd(row[idxInboundDate]);
    var endDate = formatDateYmd(row[idxEndDate]);

    var orderObj = {
      rowNumber: i + 1,
      order_id: orderId,
      resi: resi,
      shipper_id: rawShipperId,
      normalized_shipper_id: normalizedShipperId,
      shipper_name: shipper ? shipper.shipper_name : '',
      pickup_address: shipper ? shipper.pickup_address : '',
      return_flag: returnFlag,
      status: status,
      current_hub: currentHub,
      current_hub_name: getHubName(currentHub),
      destination_address: destAddress,
      destination_hub: destHub,
      destination_hub_name: getHubName(destHub),
      inbound_date: inboundDate,
      end_date: endDate
    };

    if (filterStatus && orderObj.status !== filterStatus) continue;
    if (filterCurrentHub && orderObj.current_hub !== filterCurrentHub) continue;
    if (filterDestHub && orderObj.destination_hub !== filterDestHub) continue;
    if (filterShipperId && orderObj.normalized_shipper_id !== filterShipperId) continue;
    if (hasReturnFlagFilter && orderObj.return_flag !== filterReturnFlag) continue;
    if (
      filterSearch &&
      orderObj.order_id.toLowerCase().indexOf(filterSearch) === -1 &&
      orderObj.resi.toLowerCase().indexOf(filterSearch) === -1
    ) {
      continue;
    }

    orders.push(orderObj);
  }

  return orders;
}

/**
 * Appends a strictly 10-column row to db_orders!A:J.
 *
 * @param {Array<*>} rowValues10
 * @return {number} Appended 1-based row number
 */
function appendOrderRow(rowValues10) {
  if (!Array.isArray(rowValues10) || rowValues10.length !== 10) {
    throw new Error(
      'BigQuery schema guard: appendOrderRow requires an array of exactly 10 elements (A:J).'
    );
  }
  var book = getActiveBook();
  var sheet = book.getSheetByName(CONFIG.SHEETS.ORDERS);
  if (!sheet) {
    throw new Error('Required sheet missing: ' + CONFIG.SHEETS.ORDERS);
  }

  var sanitized = [];
  for (var i = 0; i < 10; i++) {
    var val = rowValues10[i];
    sanitized.push(val === null || val === undefined ? '' : val);
  }

  var nextRow = Math.max(sheet.getLastRow() + 1, 2);
  if (
    typeof sheet.getMaxRows === 'function' &&
    typeof sheet.insertRowAfter === 'function' &&
    nextRow > sheet.getMaxRows()
  ) {
    sheet.insertRowAfter(sheet.getMaxRows());
  }

  sheet.getRange(nextRow, 1, 1, 10).setValues([sanitized]);
  SpreadsheetApp.flush();
  return nextRow;
}

/**
 * Updates allowed fields strictly within db_orders!D:J at rowNumber.
 * Columns A:C (order_id, resi, shipper_id) are immutable.
 *
 * @param {number} rowNumber 1-based sheet row (>= 2)
 * @param {Object} fieldMap
 * @return {Object}
 */
function updateOrderFields(rowNumber, fieldMap) {
  if (
    typeof rowNumber !== 'number' ||
    !isFinite(rowNumber) ||
    Math.floor(rowNumber) !== rowNumber ||
    rowNumber < 2
  ) {
    throw new Error('Invalid rowNumber for updateOrderFields: ' + rowNumber);
  }
  if (!fieldMap || typeof fieldMap !== 'object' || Array.isArray(fieldMap)) {
    throw new Error('updateOrderFields requires a plain fieldMap object.');
  }

  var book = getActiveBook();
  var sheet = book.getSheetByName(CONFIG.SHEETS.ORDERS);
  if (!sheet) {
    throw new Error('Required sheet missing: ' + CONFIG.SHEETS.ORDERS);
  }
  var lastRow = sheet.getLastRow();
  if (rowNumber > lastRow) {
    throw new Error(
      'rowNumber ' + rowNumber + ' exceeds db_orders lastRow (' + lastRow + ').'
    );
  }

  var allowedCols = {
    return_flag: 4,
    status: 5,
    current_hub: 6,
    destination_address: 7,
    destination_hub: 8,
    inbound_date: 9,
    end_date: 10
  };

  var keys = Object.keys(fieldMap);
  for (var k = 0; k < keys.length; k++) {
    if (!Object.prototype.hasOwnProperty.call(allowedCols, keys[k])) {
      throw new Error(
        'Field "' +
          keys[k] +
          '" is immutable or not permitted in db_orders!D:J.'
      );
    }
  }
  if (keys.length === 0) {
    return { rowNumber: rowNumber, updatedFields: [] };
  }

  var slice = sheet.getRange(rowNumber, 4, 1, 7).getValues()[0];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var col = allowedCols[key];
    var val = fieldMap[key];
    var formatted;
    if (key === 'return_flag') {
      formatted = Number(val) === 1 ? 1 : '';
    } else if (key === 'inbound_date' || key === 'end_date') {
      formatted = val ? formatDateYmd(val) : '';
    } else {
      formatted = val === null || val === undefined ? '' : String(val).trim();
    }
    slice[col - 4] = formatted;
  }

  sheet.getRange(rowNumber, 4, 1, 7).setValues([slice]);
  SpreadsheetApp.flush();
  return { rowNumber: rowNumber, updatedFields: keys };
}

/**
 * Ensures the op_logs sheet exists with headers in row 1.
 *
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} book
 * @return {GoogleAppsScript.Spreadsheet.Sheet}
 */
function ensureOpLogsSheet_(book) {
  var sheet = book.getSheetByName(CONFIG.SHEETS.OP_LOGS);
  if (!sheet) {
    sheet = book.insertSheet(CONFIG.SHEETS.OP_LOGS);
  }
  if (sheet.getLastRow() === 0) {
    sheet
      .getRange(1, 1, 1, CONFIG.OP_LOG_HEADERS.length)
      .setValues([CONFIG.OP_LOG_HEADERS.slice()]);
    if (typeof sheet.setFrozenRows === 'function') {
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

/**
 * Safely reads operator email from Session, falling back to 'anonymous'.
 *
 * @return {string}
 */
function getSafeOperatorEmail_() {
  try {
    var active = Session.getActiveUser && Session.getActiveUser();
    var email = active && active.getEmail ? active.getEmail() : '';
    if (email) {
      return email;
    }
  } catch (err) {
    // Ignore restricted Session scope errors in anonymous webapps
  }
  try {
    var effective = Session.getEffectiveUser && Session.getEffectiveUser();
    var effEmail = effective && effective.getEmail ? effective.getEmail() : '';
    if (effEmail) {
      return effEmail;
    }
  } catch (err2) {
    // Ignore
  }
  return 'anonymous';
}

/**
 * Appends an operational audit log row to op_logs (auto-creating the tab if absent).
 *
 * @param {Object} entry
 * @return {Object} Created log entry
 */
function appendOpLog(entry) {
  var e = entry || {};
  var book = getActiveBook();
  var sheet = ensureOpLogsSheet_(book);

  var logObj = {
    log_id:
      e.log_id ||
      'LOG-' +
        Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyMMddHHmmss') +
        '-' +
        Math.floor(1000 + Math.random() * 9000),
    timestamp: e.timestamp || getNowTimestamp(),
    order_id: e.order_id ? String(e.order_id).trim() : '',
    action: e.action ? String(e.action).trim() : '',
    from_status: e.from_status ? String(e.from_status).trim() : '',
    to_status: e.to_status ? String(e.to_status).trim() : '',
    current_hub: e.current_hub ? String(e.current_hub).trim() : '',
    courier: e.courier ? String(e.courier).trim() : '',
    notes: e.notes ? String(e.notes).trim() : '',
    operator_email: e.operator_email
      ? String(e.operator_email).trim()
      : getSafeOperatorEmail_()
  };

  var rowValues = [
    logObj.log_id,
    logObj.timestamp,
    logObj.order_id,
    logObj.action,
    logObj.from_status,
    logObj.to_status,
    logObj.current_hub,
    logObj.courier,
    logObj.notes,
    logObj.operator_email
  ];

  var nextRow = Math.max(sheet.getLastRow() + 1, 2);
  if (
    typeof sheet.getMaxRows === 'function' &&
    typeof sheet.insertRowAfter === 'function' &&
    nextRow > sheet.getMaxRows()
  ) {
    sheet.insertRowAfter(sheet.getMaxRows());
  }

  sheet.getRange(nextRow, 1, 1, 10).setValues([rowValues]);
  SpreadsheetApp.flush();
  return logObj;
}

/**
 * Returns recent operational audit logs (newest first), or [] if op_logs is absent.
 * Does NOT auto-create op_logs on read.
 *
 * @param {number=} limit
 * @return {Array<Object>}
 */
function getOpLogs(limit) {
  var book = getActiveBook();
  var sheet = book.getSheetByName(CONFIG.SHEETS.OP_LOGS);
  if (!sheet || sheet.getLastRow() < 2) {
    return [];
  }

  var lastRow = sheet.getLastRow();
  var values = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  var logs = [];
  for (var i = 0; i < values.length; i++) {
    var r = values[i];
    if (!r[0] && !r[2] && !r[3]) {
      continue;
    }
    logs.push({
      log_id: String(r[0] || ''),
      timestamp: String(r[1] || ''),
      order_id: String(r[2] || ''),
      action: String(r[3] || ''),
      from_status: String(r[4] || ''),
      to_status: String(r[5] || ''),
      current_hub: String(r[6] || ''),
      courier: String(r[7] || ''),
      notes: String(r[8] || ''),
      operator_email: String(r[9] || '')
    });
  }

  logs.reverse();
  if (typeof limit === 'number' && limit > 0) {
    return logs.slice(0, limit);
  }
  return logs;
}

/**
 * Writes rows11 (A2:K{N+1}) to order_report and clears excess rows below N+1
 * strictly within columns A:K. Row 1 (A1:M1) and columns L:M ARRAYFORMULAs
 * are never touched.
 *
 * @param {Array<Array<*>>} rows11
 * @return {{writtenCount: number, clearedRows: number}}
 */
function writeOrderReportRows(rows11) {
  if (!Array.isArray(rows11)) {
    throw new Error('writeOrderReportRows requires an array of 11-column rows.');
  }
  var sanitizedRows = [];
  for (var i = 0; i < rows11.length; i++) {
    var row = rows11[i];
    if (!Array.isArray(row) || row.length !== 11) {
      throw new Error(
        'writeOrderReportRows row ' +
          i +
          ' must have exactly 11 columns (order_report!A:K).'
      );
    }
    var out = [];
    for (var c = 0; c < 11; c++) {
      var val = row[c];
      out.push(val === null || val === undefined ? '' : val);
    }
    sanitizedRows.push(out);
  }

  var book = getActiveBook();
  var sheet = book.getSheetByName(CONFIG.SHEETS.REPORT);
  if (!sheet) {
    throw new Error('Required sheet missing: ' + CONFIG.SHEETS.REPORT);
  }

  var n = sanitizedRows.length;
  var lastRow = sheet.getLastRow();

  if (n > 0) {
    if (
      typeof sheet.getMaxRows === 'function' &&
      typeof sheet.insertRowsAfter === 'function' &&
      n + 1 > sheet.getMaxRows()
    ) {
      sheet.insertRowsAfter(sheet.getMaxRows(), n + 1 - sheet.getMaxRows());
    }
    sheet.getRange(2, 1, n, 11).setValues(sanitizedRows);
  }

  var clearedRows = 0;
  if (lastRow > n + 1) {
    clearedRows = lastRow - (n + 1);
    sheet.getRange(n + 2, 1, clearedRows, 11).clearContent();
  }

  SpreadsheetApp.flush();
  return {
    writtenCount: n,
    clearedRows: clearedRows
  };
}
