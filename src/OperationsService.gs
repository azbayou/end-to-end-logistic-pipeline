/**
 * Operational business logic and state machine for Logistic Performance Xpress.
 * Covers Input Data, Pickup, Sort, Delivery, and order_report Sync.
 * Pure Google Apps Script V8 (global scope).
 */

/**
 * Checks whether a hub code is defined in CONFIG.HUBS.
 *
 * @param {string} hubCode
 * @return {boolean}
 */
function isValidHubCode_(hubCode) {
  var code = String(hubCode || '').trim();
  return Boolean(code && Object.prototype.hasOwnProperty.call(CONFIG.HUBS, code));
}

/**
 * Generates a unique order_id (ORD-YYMMDD-XXXX) and resi (RS-XXXXXXXX).
 *
 * @param {Object} existingOrderIds Map of existing order_id -> true
 * @param {Object} existingResis Map of existing resi -> true
 * @return {{orderId: string, resi: string}}
 */
function generateUniqueOrderIdentifiers_(existingOrderIds, existingResis) {
  var yymmdd = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyMMdd');
  var orderId = '';
  var resi = '';

  for (var attempt = 0; attempt < 200; attempt++) {
    var suffix = String(Math.floor(1000 + Math.random() * 9000));
    var candidate = 'ORD-' + yymmdd + '-' + suffix;
    if (!existingOrderIds[candidate]) {
      orderId = candidate;
      existingOrderIds[candidate] = true;
      break;
    }
  }
  if (!orderId) {
    throw new Error('Unable to generate unique order_id after 200 attempts.');
  }

  for (var rAttempt = 0; rAttempt < 200; rAttempt++) {
    var digits = String(Math.floor(10000000 + Math.random() * 90000000));
    var rCandidate = 'RS-' + digits;
    if (!existingResis[rCandidate]) {
      resi = rCandidate;
      existingResis[rCandidate] = true;
      break;
    }
  }
  if (!resi) {
    throw new Error('Unable to generate unique resi after 200 attempts.');
  }

  return { orderId: orderId, resi: resi };
}

/**
 * Resolves target orders from orderIds array or query (order_id / resi).
 *
 * @param {Array<Object>} allOrders
 * @param {Array<string>=} orderIds
 * @param {string=} query
 * @return {Array<Object>}
 */
function resolveTargetOrders_(allOrders, orderIds, query) {
  var targets = [];
  var seenRow = {};

  if (Array.isArray(orderIds) && orderIds.length > 0) {
    var wanted = {};
    for (var i = 0; i < orderIds.length; i++) {
      var id = String(orderIds[i] || '').trim().toUpperCase();
      if (id) {
        wanted[id] = true;
      }
    }
    for (var j = 0; j < allOrders.length; j++) {
      var o = allOrders[j];
      var oid = String(o.order_id || '').trim().toUpperCase();
      var resi = String(o.resi || '').trim().toUpperCase();
      if ((wanted[oid] || wanted[resi]) && !seenRow[o.rowNumber]) {
        seenRow[o.rowNumber] = true;
        targets.push(o);
      }
    }
    return targets;
  }

  var q = String(query || '').trim().toUpperCase();
  if (!q) {
    return [];
  }

  for (var k = 0; k < allOrders.length; k++) {
    var ord = allOrders[k];
    var ordId = String(ord.order_id || '').trim().toUpperCase();
    var ordResi = String(ord.resi || '').trim().toUpperCase();
    if ((ordId === q || ordResi === q) && !seenRow[ord.rowNumber]) {
      seenRow[ord.rowNumber] = true;
      targets.push(ord);
    }
  }
  return targets;
}

/**
 * Creates a new order in db_orders (strictly A:J) with Pending Pickup status
 * and records an audit row in op_logs.
 *
 * @param {Object} payload
 * @return {Object}
 */
function createOrder(payload) {
  var p = payload || {};
  var rawShipper = String(p.shipper_id || '').trim();
  var normalizedShipper = normalizeShipperId(rawShipper);
  var currentHub = String(p.current_hub || '').trim();
  var destinationHub = String(p.destination_hub || '').trim();
  var destinationAddress = String(p.destination_address || '').trim();
  var courier = String(p.courier || '').trim();
  var notes = String(p.notes || '').trim();

  if (!normalizedShipper) {
    return { ok: false, code: 'VALIDATION_ERROR', error: 'Shipper is required.' };
  }
  if (!isValidHubCode_(currentHub)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Invalid or missing Origin / Current Hub: ' + (currentHub || '(empty)')
    };
  }
  if (!isValidHubCode_(destinationHub)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Invalid or missing Destination Hub: ' + (destinationHub || '(empty)')
    };
  }
  if (destinationAddress.length < 5) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Destination address must be at least 5 characters.'
    };
  }

  return withScriptLock(function () {
    var shippers = getShippers();
    var shipperObj = null;
    for (var s = 0; s < shippers.length; s++) {
      if (normalizeShipperId(shippers[s].shipper_id) === normalizedShipper) {
        shipperObj = shippers[s];
        break;
      }
    }
    if (!shipperObj) {
      return {
        ok: false,
        code: 'INVALID_SHIPPER',
        error: 'Unknown shipper_id: ' + rawShipper
      };
    }

    var existingOrders = getOrders();
    var existingOrderIds = {};
    var existingResis = {};
    for (var i = 0; i < existingOrders.length; i++) {
      if (existingOrders[i].order_id) {
        existingOrderIds[existingOrders[i].order_id] = true;
      }
      if (existingOrders[i].resi) {
        existingResis[existingOrders[i].resi] = true;
      }
    }

    var ids = generateUniqueOrderIdentifiers_(existingOrderIds, existingResis);
    var status = CONFIG.STATUSES.PENDING_PICKUP;

    var row10 = [
      ids.orderId,
      ids.resi,
      normalizedShipper,
      '',
      status,
      currentHub,
      destinationAddress,
      destinationHub,
      '',
      ''
    ];
    var rowNumber = appendOrderRow(row10);

    appendOpLog({
      order_id: ids.orderId,
      action: 'CREATE_ORDER',
      from_status: '',
      to_status: status,
      current_hub: currentHub,
      courier: courier,
      notes: notes
    });

    return {
      ok: true,
      order: {
        rowNumber: rowNumber,
        order_id: ids.orderId,
        resi: ids.resi,
        shipper_id: normalizedShipper,
        normalized_shipper_id: normalizedShipper,
        shipper_name: shipperObj.shipper_name,
        pickup_address: shipperObj.pickup_address,
        return_flag: '',
        status: status,
        current_hub: currentHub,
        current_hub_name: getHubName(currentHub),
        destination_address: destinationAddress,
        destination_hub: destinationHub,
        destination_hub_name: getHubName(destinationHub),
        inbound_date: '',
        end_date: ''
      }
    };
  });
}

/**
 * Confirms pickup / inbound for one or more Pending Pickup orders.
 * Transitions Pending Pickup -> Transit and sets inbound_date.
 *
 * @param {Object} payload
 * @return {Object}
 */
function confirmPickup(payload) {
  var p = payload || {};
  var orderIds = Array.isArray(p.orderIds) ? p.orderIds : [];
  var query = p.query ? String(p.query).trim() : '';
  var overrideHub = p.current_hub ? String(p.current_hub).trim() : '';
  var rawInboundDate = p.inbound_date ? String(p.inbound_date).trim() : '';
  var courier = String(p.courier || '').trim();
  var notes = String(p.notes || '').trim();

  if (orderIds.length === 0 && !query) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Please select at least one order or scan an order ID / resi.'
    };
  }
  if (overrideHub && !isValidHubCode_(overrideHub)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Invalid current_hub: ' + overrideHub
    };
  }

  var inboundDate = rawInboundDate ? formatDateYmd(rawInboundDate) : getTodayYmd();
  if (rawInboundDate && !inboundDate) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Invalid inbound_date format.'
    };
  }

  return withScriptLock(function () {
    var allOrders = getOrders();
    var targets = resolveTargetOrders_(allOrders, orderIds, query);
    if (targets.length === 0) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        error: 'No matching order found for pickup.',
        updatedOrders: [],
        skipped: []
      };
    }

    var updatedOrders = [];
    var skipped = [];

    for (var i = 0; i < targets.length; i++) {
      var ord = targets[i];
      if (ord.status !== CONFIG.STATUSES.PENDING_PICKUP) {
        skipped.push({
          order_id: ord.order_id,
          status: ord.status,
          reason: 'Expected status Pending Pickup, got ' + ord.status
        });
        continue;
      }

      var targetHub = overrideHub || ord.current_hub;
      updateOrderFields(ord.rowNumber, {
        status: CONFIG.STATUSES.TRANSIT,
        current_hub: targetHub,
        inbound_date: inboundDate
      });

      appendOpLog({
        order_id: ord.order_id,
        action: 'CONFIRM_PICKUP',
        from_status: ord.status,
        to_status: CONFIG.STATUSES.TRANSIT,
        current_hub: targetHub,
        courier: courier,
        notes: notes
      });

      updatedOrders.push({
        order_id: ord.order_id,
        resi: ord.resi,
        status: CONFIG.STATUSES.TRANSIT,
        current_hub: targetHub,
        inbound_date: inboundDate
      });
    }

    if (updatedOrders.length === 0) {
      return {
        ok: false,
        code: 'INVALID_STATUS',
        error:
          'No orders updated: ' +
          (skipped[0] ? skipped[0].reason : 'status precondition failed.'),
        updatedOrders: [],
        skipped: skipped
      };
    }

    return {
      ok: true,
      updatedOrders: updatedOrders,
      skipped: skipped
    };
  });
}

/**
 * Processes Sort hub actions on Transit orders:
 * - TRANSFER_HUB: updates current_hub while keeping Transit
 * - DISPATCH_DELIVERY: Transit -> On Shipment (requires force_cross_hub if current_hub !== destination_hub)
 * - FLAG_RETURN: sets return_flag = 1 while keeping Transit
 *
 * @param {Object} payload
 * @return {Object}
 */
function processSort(payload) {
  var p = payload || {};
  var orderIds = Array.isArray(p.orderIds) ? p.orderIds : [];
  var query = p.query ? String(p.query).trim() : '';
  var action = String(p.action || '').trim();
  var targetHub = p.target_hub ? String(p.target_hub).trim() : '';
  var forceCrossHub = Boolean(p.force_cross_hub);
  var courier = String(p.courier || '').trim();
  var notes = String(p.notes || '').trim();

  if (orderIds.length === 0 && !query) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Please select at least one order or scan an order ID / resi.'
    };
  }
  if (
    action !== 'TRANSFER_HUB' &&
    action !== 'DISPATCH_DELIVERY' &&
    action !== 'FLAG_RETURN'
  ) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Unsupported sort action: ' + action
    };
  }
  if (action === 'TRANSFER_HUB' && !isValidHubCode_(targetHub)) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Target hub is required for hub transfer.'
    };
  }

  return withScriptLock(function () {
    var allOrders = getOrders();
    var targets = resolveTargetOrders_(allOrders, orderIds, query);
    if (targets.length === 0) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        error: 'No matching order found for sort.',
        updatedOrders: [],
        skipped: []
      };
    }

    var eligible = [];
    var skipped = [];
    for (var i = 0; i < targets.length; i++) {
      var ord = targets[i];
      if (ord.status !== CONFIG.STATUSES.TRANSIT) {
        skipped.push({
          order_id: ord.order_id,
          status: ord.status,
          reason: 'Expected status Transit, got ' + ord.status
        });
      } else {
        eligible.push(ord);
      }
    }

    if (eligible.length === 0) {
      return {
        ok: false,
        code: 'INVALID_STATUS',
        error:
          'No orders updated: ' +
          (skipped[0] ? skipped[0].reason : 'status precondition failed.'),
        updatedOrders: [],
        skipped: skipped
      };
    }

    // Check cross-hub mismatch BEFORE mutating any order (atomic guard)
    if (action === 'DISPATCH_DELIVERY' && !forceCrossHub) {
      var mismatchOrders = [];
      for (var m = 0; m < eligible.length; m++) {
        var eo = eligible[m];
        if (eo.current_hub !== eo.destination_hub) {
          mismatchOrders.push({
            order_id: eo.order_id,
            resi: eo.resi,
            current_hub: eo.current_hub,
            destination_hub: eo.destination_hub
          });
        }
      }
      if (mismatchOrders.length > 0) {
        return {
          ok: false,
          code: 'CROSS_HUB_CONFIRM_REQUIRED',
          error:
            mismatchOrders.length +
            ' order(s) have current_hub different from destination_hub.',
          mismatchOrders: mismatchOrders
        };
      }
    }

    var updatedOrders = [];
    for (var j = 0; j < eligible.length; j++) {
      var cur = eligible[j];
      if (action === 'TRANSFER_HUB') {
        updateOrderFields(cur.rowNumber, {
          current_hub: targetHub
        });
        appendOpLog({
          order_id: cur.order_id,
          action: 'SORT_TRANSFER_HUB',
          from_status: cur.status,
          to_status: CONFIG.STATUSES.TRANSIT,
          current_hub: targetHub,
          courier: courier,
          notes:
            notes ||
            'Transferred from ' + cur.current_hub + ' to ' + targetHub
        });
        updatedOrders.push({
          order_id: cur.order_id,
          resi: cur.resi,
          status: CONFIG.STATUSES.TRANSIT,
          current_hub: targetHub
        });
      } else if (action === 'DISPATCH_DELIVERY') {
        updateOrderFields(cur.rowNumber, {
          status: CONFIG.STATUSES.ON_SHIPMENT
        });
        appendOpLog({
          order_id: cur.order_id,
          action: 'SORT_DISPATCH_DELIVERY',
          from_status: cur.status,
          to_status: CONFIG.STATUSES.ON_SHIPMENT,
          current_hub: cur.current_hub,
          courier: courier,
          notes:
            notes ||
            (cur.current_hub !== cur.destination_hub
              ? 'Cross-hub override dispatch (' +
                cur.current_hub +
                ' -> ' +
                cur.destination_hub +
                ')'
              : '')
        });
        updatedOrders.push({
          order_id: cur.order_id,
          resi: cur.resi,
          status: CONFIG.STATUSES.ON_SHIPMENT,
          current_hub: cur.current_hub
        });
      } else if (action === 'FLAG_RETURN') {
        updateOrderFields(cur.rowNumber, {
          return_flag: 1
        });
        appendOpLog({
          order_id: cur.order_id,
          action: 'SORT_FLAG_RETURN',
          from_status: cur.status,
          to_status: CONFIG.STATUSES.TRANSIT,
          current_hub: cur.current_hub,
          courier: courier,
          notes: notes || 'Flagged for Return to Shipper'
        });
        updatedOrders.push({
          order_id: cur.order_id,
          resi: cur.resi,
          status: CONFIG.STATUSES.TRANSIT,
          return_flag: 1,
          current_hub: cur.current_hub
        });
      }
    }

    return {
      ok: true,
      updatedOrders: updatedOrders,
      skipped: skipped
    };
  });
}

/**
 * Processes Delivery terminal / exception actions:
 * - MARK_DELIVERED: On Shipment -> Delivered, sets end_date, clears return_flag
 * - FAILED_RTS: On Shipment -> Transit, sets return_flag = 1, clears end_date
 * - MARK_RETURNED: On Shipment or flagged Transit (return_flag == 1) -> Returned, sets return_flag = 1 and end_date
 *
 * @param {Object} payload
 * @return {Object}
 */
function processDelivery(payload) {
  var p = payload || {};
  var orderIds = Array.isArray(p.orderIds) ? p.orderIds : [];
  var query = p.query ? String(p.query).trim() : '';
  var action = String(p.action || '').trim();
  var rawEndDate = p.end_date ? String(p.end_date).trim() : '';
  var courier = String(p.courier || '').trim();
  var notes = String(p.notes || '').trim();

  if (orderIds.length === 0 && !query) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Please select at least one order or scan an order ID / resi.'
    };
  }
  if (
    action !== 'MARK_DELIVERED' &&
    action !== 'FAILED_RTS' &&
    action !== 'MARK_RETURNED'
  ) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Unsupported delivery action: ' + action
    };
  }

  var endDate = rawEndDate ? formatDateYmd(rawEndDate) : getTodayYmd();
  if (rawEndDate && !endDate) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      error: 'Invalid end_date format.'
    };
  }

  return withScriptLock(function () {
    var allOrders = getOrders();
    var targets = resolveTargetOrders_(allOrders, orderIds, query);
    if (targets.length === 0) {
      return {
        ok: false,
        code: 'NOT_FOUND',
        error: 'No matching order found for delivery action.',
        updatedOrders: [],
        skipped: []
      };
    }

    var updatedOrders = [];
    var skipped = [];

    for (var i = 0; i < targets.length; i++) {
      var ord = targets[i];
      if (action === 'MARK_DELIVERED') {
        if (ord.status !== CONFIG.STATUSES.ON_SHIPMENT) {
          skipped.push({
            order_id: ord.order_id,
            status: ord.status,
            reason: 'MARK_DELIVERED requires status On Shipment, got ' + ord.status
          });
          continue;
        }
        updateOrderFields(ord.rowNumber, {
          status: CONFIG.STATUSES.DELIVERED,
          end_date: endDate,
          return_flag: ''
        });
        appendOpLog({
          order_id: ord.order_id,
          action: 'DELIVERY_MARK_DELIVERED',
          from_status: ord.status,
          to_status: CONFIG.STATUSES.DELIVERED,
          current_hub: ord.current_hub,
          courier: courier,
          notes: notes
        });
        updatedOrders.push({
          order_id: ord.order_id,
          resi: ord.resi,
          status: CONFIG.STATUSES.DELIVERED,
          end_date: endDate,
          return_flag: ''
        });
      } else if (action === 'FAILED_RTS') {
        if (ord.status !== CONFIG.STATUSES.ON_SHIPMENT) {
          skipped.push({
            order_id: ord.order_id,
            status: ord.status,
            reason: 'FAILED_RTS requires status On Shipment, got ' + ord.status
          });
          continue;
        }
        updateOrderFields(ord.rowNumber, {
          status: CONFIG.STATUSES.TRANSIT,
          return_flag: 1,
          end_date: ''
        });
        appendOpLog({
          order_id: ord.order_id,
          action: 'DELIVERY_FAILED_RTS',
          from_status: ord.status,
          to_status: CONFIG.STATUSES.TRANSIT,
          current_hub: ord.current_hub,
          courier: courier,
          notes: notes || 'Failed delivery, returned to hub'
        });
        updatedOrders.push({
          order_id: ord.order_id,
          resi: ord.resi,
          status: CONFIG.STATUSES.TRANSIT,
          return_flag: 1,
          end_date: ''
        });
      } else if (action === 'MARK_RETURNED') {
        var isEligibleForReturn =
          ord.status === CONFIG.STATUSES.ON_SHIPMENT ||
          (ord.status === CONFIG.STATUSES.TRANSIT && Number(ord.return_flag) === 1);
        if (!isEligibleForReturn) {
          skipped.push({
            order_id: ord.order_id,
            status: ord.status,
            reason:
              'MARK_RETURNED requires On Shipment or flagged Transit (return_flag=1), got ' +
              ord.status
          });
          continue;
        }
        updateOrderFields(ord.rowNumber, {
          status: CONFIG.STATUSES.RETURNED,
          return_flag: 1,
          end_date: endDate
        });
        appendOpLog({
          order_id: ord.order_id,
          action: 'DELIVERY_MARK_RETURNED',
          from_status: ord.status,
          to_status: CONFIG.STATUSES.RETURNED,
          current_hub: ord.current_hub,
          courier: courier,
          notes: notes || 'Returned to shipper'
        });
        updatedOrders.push({
          order_id: ord.order_id,
          resi: ord.resi,
          status: CONFIG.STATUSES.RETURNED,
          return_flag: 1,
          end_date: endDate
        });
      }
    }

    if (updatedOrders.length === 0) {
      return {
        ok: false,
        code: 'INVALID_STATUS',
        error:
          'No orders updated: ' +
          (skipped[0] ? skipped[0].reason : 'status precondition failed.'),
        updatedOrders: [],
        skipped: skipped
      };
    }

    return {
      ok: true,
      updatedOrders: updatedOrders,
      skipped: skipped
    };
  });
}

/**
 * Syncs live db_orders + db_shippers into order_report!A2:K while preserving
 * row 1 headers and L1:M1 ARRAYFORMULAs.
 *
 * @return {Object}
 */
function syncOrderReport() {
  return withScriptLock(function () {
    var orders = getOrders();
    var rows11 = [];
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      rows11.push([
        o.order_id,
        o.resi,
        o.shipper_name || o.normalized_shipper_id,
        o.pickup_address || '',
        o.status,
        o.return_flag === 1 ? 1 : '',
        o.current_hub_name || o.current_hub,
        o.destination_hub_name || o.destination_hub,
        o.destination_address,
        o.inbound_date || '',
        o.end_date || ''
      ]);
    }

    var res = writeOrderReportRows(rows11);
    var syncedAt = getNowTimestamp();

    appendOpLog({
      order_id: 'ALL',
      action: 'SYNC_ORDER_REPORT',
      from_status: '',
      to_status: '',
      current_hub: '',
      courier: '',
      notes: 'Synced ' + res.writtenCount + ' rows to order_report!A2:K'
    });

    return {
      ok: true,
      syncedCount: res.writtenCount,
      clearedRows: res.clearedRows,
      syncedAt: syncedAt
    };
  });
}
