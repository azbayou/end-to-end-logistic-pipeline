/**
 * Live Dashboard Analytics & SLA Monitoring Service for
 * Logistic Performance Xpress (Google Apps Script V8).
 */

/**
 * Computes day difference between two 'yyyy-MM-dd' strings using UTC dates
 * to avoid DST / local offset skew.
 *
 * @param {string} startYmd
 * @param {string} endYmd
 * @return {number|null}
 */
function diffDaysYmd_(startYmd, endYmd) {
  if (!startYmd || !endYmd) {
    return null;
  }
  var sp = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startYmd);
  var ep = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endYmd);
  if (!sp || !ep) {
    return null;
  }
  var sMs = Date.UTC(
    parseInt(sp[1], 10),
    parseInt(sp[2], 10) - 1,
    parseInt(sp[3], 10)
  );
  var eMs = Date.UTC(
    parseInt(ep[1], 10),
    parseInt(ep[2], 10) - 1,
    parseInt(ep[3], 10)
  );
  return Math.round((eMs - sMs) / 86400000);
}

/**
 * Computes order aging days and SLA classification.
 * Aging < CONFIG.SLA_DAYS (8) => 'Under SLA'; >= 8 => 'Over SLA'; blank inbound_date => 'Not Inbounded'.
 *
 * @param {Object} order
 * @param {string=} refDateYmd
 * @return {{agingDays: number|null, agingType: string}}
 */
function computeOrderAging(order, refDateYmd) {
  var inbound = formatDateYmd(order && order.inbound_date);
  if (!inbound) {
    return { agingDays: null, agingType: 'Not Inbounded' };
  }
  var end = formatDateYmd(order && order.end_date);
  var target = end || formatDateYmd(refDateYmd) || getTodayYmd();
  var agingDays = diffDaysYmd_(inbound, target);
  if (agingDays === null) {
    return { agingDays: null, agingType: 'Not Inbounded' };
  }
  var agingType = agingDays < CONFIG.SLA_DAYS ? 'Under SLA' : 'Over SLA';
  return { agingDays: agingDays, agingType: agingType };
}

/**
 * Computes live dashboard KPIs, 7 chart datasets, High Aging Monitoring rows,
 * and recent operational logs from db_orders + db_shippers.
 *
 * @param {Object=} filters
 * @return {Object}
 */
function getDashboardData(filters) {
  var f = filters || {};
  var refDateYmd = formatDateYmd(f.refDate) || getTodayYmd();
  var rawOrders = getOrders();
  var shippers = getShippers();
  var recentLogs = getOpLogs(25);

  var shipperLookup = {};
  for (var s = 0; s < shippers.length; s++) {
    shipperLookup[normalizeShipperId(shippers[s].shipper_id)] = shippers[s];
  }

  var enriched = [];
  for (var i = 0; i < rawOrders.length; i++) {
    var o = rawOrders[i];
    var aging = computeOrderAging(o, refDateYmd);
    var normShp = o.normalized_shipper_id || normalizeShipperId(o.shipper_id);
    var shpInfo = shipperLookup[normShp] || null;
    var shipperName =
      (shpInfo && shpInfo.shipper_name) ||
      o.shipper_name ||
      (o.shipper_id ? 'Unknown Shipper (' + o.shipper_id + ')' : 'Unknown Shipper');

    enriched.push({
      rowNumber: o.rowNumber,
      order_id: o.order_id,
      resi: o.resi,
      shipper_id: o.shipper_id,
      normalized_shipper_id: normShp,
      shipper_name: shipperName,
      pickup_address: o.pickup_address || (shpInfo ? shpInfo.pickup_address : ''),
      return_flag: o.return_flag,
      isReturnFlag: Number(o.return_flag) === 1,
      status: o.status,
      current_hub: o.current_hub,
      current_hub_name: o.current_hub_name || getHubName(o.current_hub),
      destination_address: o.destination_address,
      destination_hub: o.destination_hub,
      destination_hub_name: o.destination_hub_name || getHubName(o.destination_hub),
      inbound_date: o.inbound_date,
      end_date: o.end_date,
      agingDays: aging.agingDays,
      agingType: aging.agingType
    });
  }

  var searchLower = f.search ? String(f.search).trim().toLowerCase() : '';
  var hubFilter = f.hub && f.hub !== 'All' ? String(f.hub).trim() : '';
  var hubScope = f.hubScope || 'either';
  var statusFilter = f.status && f.status !== 'All' ? String(f.status).trim() : '';
  var shipperFilter =
    f.shipperId && f.shipperId !== 'All' ? normalizeShipperId(f.shipperId) : '';
  var slaFilter = f.slaType && f.slaType !== 'All' ? String(f.slaType).trim() : '';
  var dateFrom = f.dateFrom ? formatDateYmd(f.dateFrom) : '';
  var dateTo = f.dateTo ? formatDateYmd(f.dateTo) : '';

  var filtered = [];
  for (var j = 0; j < enriched.length; j++) {
    var row = enriched[j];
    if (searchLower) {
      var oidL = String(row.order_id || '').toLowerCase();
      var resiL = String(row.resi || '').toLowerCase();
      if (oidL.indexOf(searchLower) === -1 && resiL.indexOf(searchLower) === -1) {
        continue;
      }
    }
    if (hubFilter) {
      if (hubScope === 'current' && row.current_hub !== hubFilter) continue;
      if (hubScope === 'destination' && row.destination_hub !== hubFilter) continue;
      if (
        hubScope === 'either' &&
        row.current_hub !== hubFilter &&
        row.destination_hub !== hubFilter
      ) {
        continue;
      }
    }
    if (statusFilter && row.status !== statusFilter) continue;
    if (shipperFilter && row.normalized_shipper_id !== shipperFilter) continue;
    if (slaFilter && row.agingType !== slaFilter) continue;
    if (dateFrom || dateTo) {
      var refD = row.inbound_date || row.end_date;
      if (!refD) continue;
      if (dateFrom && refD < dateFrom) continue;
      if (dateTo && refD > dateTo) continue;
    }
    filtered.push(row);
  }

  var totalOrders = filtered.length;
  var deliveredCount = 0;
  var returnedCount = 0;
  var activeShipments = 0;
  var returnFlagCount = 0;
  var agingSum = 0;
  var agingCount = 0;

  var statusOrder = [
    CONFIG.STATUSES.PENDING_PICKUP,
    CONFIG.STATUSES.TRANSIT,
    CONFIG.STATUSES.ON_SHIPMENT,
    CONFIG.STATUSES.DELIVERED,
    CONFIG.STATUSES.RETURNED
  ];
  var statusCounts = {};
  for (var st = 0; st < statusOrder.length; st++) {
    statusCounts[statusOrder[st]] = 0;
  }

  var hubKeys = Object.keys(CONFIG.HUBS);
  var curHubVol = {};
  var destHubVol = {};
  var destHubReturn = {};
  var slaHubMap = {};

  function ensureHubBucket_(hubCode) {
    var code = hubCode || 'UNKNOWN';
    if (!Object.prototype.hasOwnProperty.call(curHubVol, code)) curHubVol[code] = 0;
    if (!Object.prototype.hasOwnProperty.call(destHubVol, code)) destHubVol[code] = 0;
    if (!Object.prototype.hasOwnProperty.call(destHubReturn, code)) {
      destHubReturn[code] = { total: 0, normal: 0, returned: 0 };
    }
    if (!Object.prototype.hasOwnProperty.call(slaHubMap, code)) {
      slaHubMap[code] = { 'Not Inbounded': 0, 'Under SLA': 0, 'Over SLA': 0 };
    }
    if (hubKeys.indexOf(code) === -1) {
      hubKeys.push(code);
    }
  }

  for (var h0 = 0; h0 < hubKeys.length; h0++) {
    ensureHubBucket_(hubKeys[h0]);
  }

  var shipperAgg = {};
  var shipperOrder = [];
  for (var s0 = 0; s0 < shippers.length; s0++) {
    var sid0 = normalizeShipperId(shippers[s0].shipper_id);
    shipperAgg[sid0] = {
      shipper_id: sid0,
      shipper_name: shippers[s0].shipper_name,
      total: 0,
      normal: 0,
      returned: 0
    };
    shipperOrder.push(sid0);
  }

  var highAgingCandidates = [];

  for (var k = 0; k < filtered.length; k++) {
    var item = filtered[k];

    if (item.status === CONFIG.STATUSES.DELIVERED) {
      deliveredCount += 1;
    } else if (item.status === CONFIG.STATUSES.RETURNED) {
      returnedCount += 1;
    } else if (
      item.status === CONFIG.STATUSES.PENDING_PICKUP ||
      item.status === CONFIG.STATUSES.TRANSIT ||
      item.status === CONFIG.STATUSES.ON_SHIPMENT
    ) {
      activeShipments += 1;
    }

    if (item.isReturnFlag) {
      returnFlagCount += 1;
    }

    if (item.agingDays !== null) {
      agingSum += item.agingDays;
      agingCount += 1;
    }

    if (Object.prototype.hasOwnProperty.call(statusCounts, item.status)) {
      statusCounts[item.status] += 1;
    }

    var ch = item.current_hub || 'UNKNOWN';
    var dh = item.destination_hub || 'UNKNOWN';
    ensureHubBucket_(ch);
    ensureHubBucket_(dh);

    curHubVol[ch] += 1;
    destHubVol[dh] += 1;

    destHubReturn[dh].total += 1;
    if (item.isReturnFlag) {
      destHubReturn[dh].returned += 1;
    } else {
      destHubReturn[dh].normal += 1;
    }

    slaHubMap[ch][item.agingType] += 1;

    var shpKey = item.normalized_shipper_id || 'UNKNOWN';
    if (!Object.prototype.hasOwnProperty.call(shipperAgg, shpKey)) {
      shipperAgg[shpKey] = {
        shipper_id: shpKey,
        shipper_name: item.shipper_name,
        total: 0,
        normal: 0,
        returned: 0
      };
      shipperOrder.push(shpKey);
    }
    shipperAgg[shpKey].total += 1;
    if (item.isReturnFlag) {
      shipperAgg[shpKey].returned += 1;
    } else {
      shipperAgg[shpKey].normal += 1;
    }

    var isActive =
      item.status === CONFIG.STATUSES.PENDING_PICKUP ||
      item.status === CONFIG.STATUSES.TRANSIT ||
      item.status === CONFIG.STATUSES.ON_SHIPMENT;
    if (isActive && item.agingDays !== null) {
      highAgingCandidates.push(item);
    }
  }

  var closedCount = deliveredCount + returnedCount;
  var deliveredRate =
    closedCount === 0 ? 0 : Math.round((deliveredCount / closedCount) * 10000) / 100;
  var returnRate =
    totalOrders === 0 ? 0 : Math.round((returnFlagCount / totalOrders) * 10000) / 100;
  var avgDeliveryTime =
    agingCount === 0 ? 0 : Math.round((agingSum / agingCount) * 10) / 10;

  var statusBreakdown = [];
  for (var sb = 0; sb < statusOrder.length; sb++) {
    var stName = statusOrder[sb];
    var cnt = statusCounts[stName];
    statusBreakdown.push({
      status: stName,
      count: cnt,
      pct: totalOrders === 0 ? 0 : Math.round((cnt / totalOrders) * 1000) / 10
    });
  }

  var volumeByCurrentHub = [];
  var volumeByDestinationHub = [];
  var returnRateByDestinationHub = [];
  var slaByHub = [];

  for (var hi = 0; hi < hubKeys.length; hi++) {
    var hk = hubKeys[hi];
    var hName = hk === 'UNKNOWN' ? 'Unknown Hub' : getHubName(hk);
    if (hk === 'UNKNOWN' && curHubVol[hk] === 0 && destHubVol[hk] === 0) {
      continue;
    }
    volumeByCurrentHub.push({ hub: hk, hubName: hName, count: curHubVol[hk] });
    volumeByDestinationHub.push({ hub: hk, hubName: hName, count: destHubVol[hk] });

    var dr = destHubReturn[hk];
    returnRateByDestinationHub.push({
      hub: hk,
      hubName: hName,
      total: dr.total,
      normal: dr.normal,
      returned: dr.returned,
      returnRate: dr.total === 0 ? 0 : Math.round((dr.returned / dr.total) * 1000) / 10
    });

    var sl = slaHubMap[hk];
    slaByHub.push({
      hub: hk,
      hubName: hName,
      notInbounded: sl['Not Inbounded'],
      underSla: sl['Under SLA'],
      overSla: sl['Over SLA'],
      total: sl['Not Inbounded'] + sl['Under SLA'] + sl['Over SLA']
    });
  }

  var shipperMetrics = [];
  for (var si = 0; si < shipperOrder.length; si++) {
    var sk = shipperOrder[si];
    var sa = shipperAgg[sk];
    shipperMetrics.push({
      shipper_id: sa.shipper_id,
      shipper_name: sa.shipper_name,
      total: sa.total,
      normal: sa.normal,
      returned: sa.returned,
      pct: totalOrders === 0 ? 0 : Math.round((sa.total / totalOrders) * 1000) / 10,
      returnRate: sa.total === 0 ? 0 : Math.round((sa.returned / sa.total) * 1000) / 10
    });
  }

  highAgingCandidates.sort(function (a, b) {
    if (b.agingDays !== a.agingDays) {
      return b.agingDays - a.agingDays;
    }
    return String(a.order_id).localeCompare(String(b.order_id));
  });

  return {
    ok: true,
    meta: {
      refDate: refDateYmd,
      totalUnfiltered: enriched.length,
      filteredCount: filtered.length,
      hubs: CONFIG.HUBS,
      statuses: statusOrder,
      shippers: shippers
    },
    kpis: {
      totalOrders: totalOrders,
      deliveredCount: deliveredCount,
      returnedCount: returnedCount,
      closedCount: closedCount,
      deliveredRate: deliveredRate,
      activeShipments: activeShipments,
      returnFlagCount: returnFlagCount,
      returnRate: returnRate,
      avgDeliveryTime: avgDeliveryTime
    },
    charts: {
      statusBreakdown: statusBreakdown,
      volumeByHub: {
        current: volumeByCurrentHub,
        destination: volumeByDestinationHub
      },
      returnRateByDestinationHub: returnRateByDestinationHub,
      shipperBreakdown: shipperMetrics,
      volumeByShipper: shipperMetrics,
      returnRateByShipper: shipperMetrics,
      slaByHub: slaByHub
    },
    highAgingOrders: highAgingCandidates.slice(0, 50),
    recentLogs: recentLogs
  };
}
