'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { createGasRuntime } = require('../gas-mock/gasRuntime');
const { startDevServer } = require('../gas-mock/devServer');

const ROOT_DIR = path.resolve(__dirname, '../..');
const SNAPSHOT_PATH = path.join(ROOT_DIR, 'test/fixtures/sheet_snapshot.json');
const SRC_DIR = path.join(ROOT_DIR, 'src');

function copyValues(vmVal) {
  return JSON.parse(JSON.stringify(vmVal));
}

describe('M1 Core Repo — Config.gs, SheetRepo.gs, gasRuntime.js & devServer.js', () => {
  // ---------------------------------------------------------------------------
  // Group 1: Config.gs Constants & Pure Helpers
  // ---------------------------------------------------------------------------
  describe('Group 1: Config.gs Constants & Pure Helpers', () => {
    it('1. exposes exact schema & configuration constants in CONFIG', () => {
      const rt = createGasRuntime();
      const cfg = copyValues(rt.context.CONFIG);

      assert.equal(cfg.SPREADSHEET_ID, '1vTtD4qf38J5h8SSME7Enq-r_vTV563hNmUaHrv0IePU');
      assert.equal(cfg.TIMEZONE, 'Asia/Bangkok');
      assert.equal(cfg.SLA_DAYS, 8);
      assert.deepEqual(cfg.SHEETS, {
        ORDERS: 'db_orders',
        SHIPPERS: 'db_shippers',
        REPORT: 'order_report',
        OP_LOGS: 'op_logs'
      });
      assert.equal(cfg.ORDER_HEADERS.length, 10);
      assert.deepEqual(cfg.ORDER_HEADERS, [
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
      ]);
      assert.equal(cfg.OP_LOG_HEADERS.length, 10);
      assert.deepEqual(cfg.OP_LOG_HEADERS, [
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
      ]);
      assert.deepEqual(cfg.STATUSES, {
        PENDING_PICKUP: 'Pending Pickup',
        TRANSIT: 'Transit',
        ON_SHIPMENT: 'On Shipment',
        DELIVERED: 'Delivered',
        RETURNED: 'Returned'
      });
      assert.deepEqual(cfg.HUBS, {
        'HUB-JKT': 'Jakarta Central Hub',
        'HUB-BDG': 'Bandung West Hub',
        'HUB-SUB': 'Surabaya East Hub'
      });
    });

    it('2. normalizeShipperId() normalizes legacy SHP-00x and preserves non-matching IDs', () => {
      const rt = createGasRuntime();
      assert.equal(rt.invoke('normalizeShipperId', 'SHP-001'), 'SHP-01');
      assert.equal(rt.invoke('normalizeShipperId', 'SHP-002'), 'SHP-02');
      assert.equal(rt.invoke('normalizeShipperId', 'SHP-003'), 'SHP-03');
      assert.equal(rt.invoke('normalizeShipperId', 'shp-004'), 'SHP-04');
      assert.equal(rt.invoke('normalizeShipperId', ' SHP-001 '), 'SHP-01');
      assert.equal(rt.invoke('normalizeShipperId', 'SHP-01'), 'SHP-01');
      assert.equal(rt.invoke('normalizeShipperId', 'SHP-10'), 'SHP-10');
      assert.equal(rt.invoke('normalizeShipperId', 'SHP-010'), 'SHP-10');
      assert.equal(rt.invoke('normalizeShipperId', ''), '');
      assert.equal(rt.invoke('normalizeShipperId', null), '');
      assert.equal(rt.invoke('normalizeShipperId', undefined), '');
      assert.equal(rt.invoke('normalizeShipperId', 'OTHER-001'), 'OTHER-001');
    });

    it('3. getHubName() maps known hub codes and passes through unknown/empty values', () => {
      const rt = createGasRuntime();
      assert.equal(rt.invoke('getHubName', 'HUB-JKT'), 'Jakarta Central Hub');
      assert.equal(rt.invoke('getHubName', 'HUB-BDG'), 'Bandung West Hub');
      assert.equal(rt.invoke('getHubName', 'HUB-SUB'), 'Surabaya East Hub');
      assert.equal(rt.invoke('getHubName', 'HUB-XYZ'), 'HUB-XYZ');
      assert.equal(rt.invoke('getHubName', ''), '');
      assert.equal(rt.invoke('getHubName', null), '');

      // Regression: Object.prototype property names must pass through as strings
      for (const protoKey of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
        const res = rt.invoke('getHubName', protoKey);
        assert.equal(typeof res, 'string');
        assert.equal(res, protoKey);
      }
    });

    it('4. formatDateYmd() and getTodayYmd() handle strings, M/D/YYYY, cross-realm Dates & Asia/Bangkok TZ', () => {
      const fixedNow = new Date('2026-11-18T18:30:00.000Z'); // 2026-11-19 01:30 in Asia/Bangkok
      const rt = createGasRuntime({ now: () => fixedNow });

      assert.equal(rt.invoke('formatDateYmd', null), '');
      assert.equal(rt.invoke('formatDateYmd', undefined), '');
      assert.equal(rt.invoke('formatDateYmd', ''), '');
      assert.equal(rt.invoke('formatDateYmd', '2026-09-30'), '2026-09-30');
      assert.equal(rt.invoke('formatDateYmd', '9/30/2026'), '2026-09-30');
      assert.equal(rt.invoke('formatDateYmd', '10/6/2026'), '2026-10-06');
      assert.equal(rt.invoke('formatDateYmd', '2026-02-30'), '');
      assert.equal(rt.invoke('formatDateYmd', '2/30/2026'), '');

      // Host-realm Date objects crossing node:vm boundary
      assert.equal(
        rt.invoke('formatDateYmd', new Date('2026-09-30T17:00:00.000Z')),
        '2026-10-01'
      );
      assert.equal(
        rt.invoke('formatDateYmd', new Date('2026-09-30T00:00:00.000Z')),
        '2026-09-30'
      );

      // Google Sheets serial number (46301 -> 2026-10-06)
      assert.equal(rt.invoke('formatDateYmd', 46301), '2026-10-06');

      // Regression: ISO+offset with invalid calendar day must return '' (no V8 rollover)
      assert.equal(rt.invoke('formatDateYmd', '2026-02-30T17:00:00.000Z'), '');
      assert.equal(rt.invoke('formatDateYmd', '2026-02-29T17:00:00.000Z'), '');
      assert.equal(rt.invoke('formatDateYmd', '2024-02-29T17:00:00.000Z'), '2024-03-01');
      assert.equal(rt.invoke('formatDateYmd', '2026-11-17T17:00:00.000Z'), '2026-11-18');
      assert.equal(rt.invoke('formatDateYmd', '2026-11-17T16:59:59.999Z'), '2026-11-17');

      const today = rt.invoke('getTodayYmd');
      assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(today, '2026-11-19');
      assert.equal(today, rt.invoke('formatDateYmd', fixedNow));
    });
  });

  // ---------------------------------------------------------------------------
  // Group 2: SheetRepo.gs — Read, Normalization & BigQuery Schema Guards
  // ---------------------------------------------------------------------------
  describe('Group 2: SheetRepo.gs — Read, Normalization & BigQuery Schema Guards', () => {
    it('5. getActiveBook() returns active spreadsheet by default and falls back to openById when unbound', () => {
      const rtBound = createGasRuntime({ snapshotPath: SNAPSHOT_PATH });
      const bookBound = rtBound.invoke('getActiveBook');
      assert.equal(
        bookBound.getId(),
        '1vTtD4qf38J5h8SSME7Enq-r_vTV563hNmUaHrv0IePU'
      );

      const rtUnbound = createGasRuntime({
        snapshotPath: SNAPSHOT_PATH,
        hasActiveSpreadsheet: false
      });
      assert.equal(rtUnbound.context.SpreadsheetApp.getActiveSpreadsheet(), null);
      const bookFallback = rtUnbound.invoke('getActiveBook');
      assert.equal(
        bookFallback.getId(),
        '1vTtD4qf38J5h8SSME7Enq-r_vTV563hNmUaHrv0IePU'
      );
      assert.equal(rtUnbound.invoke('getShippers').length, 4);
    });

    it('6. getShippers() reads all 4 real shippers from sheet_snapshot.json and skips trailing blanks', () => {
      const rt = createGasRuntime({ snapshotPath: SNAPSHOT_PATH });
      const shippers = copyValues(rt.invoke('getShippers'));
      assert.equal(shippers.length, 4);
      assert.deepEqual(
        shippers.map((s) => s.shipper_id),
        ['SHP-01', 'SHP-02', 'SHP-03', 'SHP-04']
      );
      for (const s of shippers) {
        assert.ok(s.shipper_name.length > 0);
        assert.ok(s.pickup_address.length > 0);
      }
    });

    it('7. getOrders() reads all 532 real orders, normalizes SHP-00x -> SHP-0x on read without mutating raw db_orders', () => {
      const rt = createGasRuntime({ snapshotPath: SNAPSHOT_PATH });
      const orders = copyValues(rt.invoke('getOrders'));

      assert.equal(orders.length, 532);
      assert.equal(orders[0].rowNumber, 2);
      assert.equal(orders[orders.length - 1].rowNumber, 533);

      const legacyOrders = orders.filter((o) => /^SHP-00\d$/.test(o.shipper_id));
      assert.equal(legacyOrders.length, 100);
      for (const lo of legacyOrders) {
        assert.match(lo.normalized_shipper_id, /^SHP-0[1-4]$/);
        assert.ok(lo.shipper_name.length > 0, `Expected joined shipper_name for ${lo.order_id}`);
        assert.ok(lo.pickup_address.length > 0, `Expected joined pickup_address for ${lo.order_id}`);
      }

      // Raw db_orders cells must remain untouched ('SHP-001' etc.)
      const rawSheet = rt.getSheetData('db_orders');
      const firstLegacy = legacyOrders[0];
      assert.equal(rawSheet[firstLegacy.rowNumber - 1][2], firstLegacy.shipper_id);

      // All dates normalized to '' or YYYY-MM-DD, and hub names populated
      for (const o of orders) {
        assert.ok(
          o.inbound_date === '' || /^\d{4}-\d{2}-\d{2}$/.test(o.inbound_date),
          `Invalid inbound_date: ${o.inbound_date}`
        );
        assert.ok(
          o.end_date === '' || /^\d{4}-\d{2}-\d{2}$/.test(o.end_date),
          `Invalid end_date: ${o.end_date}`
        );
        assert.ok(o.current_hub_name.length > 0);
        assert.ok(o.destination_hub_name.length > 0);
      }

      // Options filtering normalizes shipper_id filter too
      const filteredByShp1 = copyValues(
        rt.invoke('getOrders', { shipper_id: 'SHP-001', status: 'Delivered' })
      );
      assert.ok(filteredByShp1.length > 0);
      assert.ok(
        filteredByShp1.every(
          (o) => o.normalized_shipper_id === 'SHP-01' && o.status === 'Delivered'
        )
      );
    });

    it('8. getOrders() handles unknown shipper_id gracefully and skips blank rows', () => {
      const rt = createGasRuntime({
        shippersRows: [['SHP-01', 'Alpha Corp', 'Jl. Sudirman 1']],
        ordersRows: [
          [
            'ORD-1',
            'RS-1',
            'SHP-99',
            '',
            'Pending Pickup',
            'HUB-JKT',
            'Jl. Merdeka 10',
            'HUB-BDG',
            '',
            ''
          ],
          ['', '', '', '', '', '', '', '', '', '']
        ]
      });

      const orders = copyValues(rt.invoke('getOrders'));
      assert.equal(orders.length, 1);
      assert.equal(orders[0].shipper_id, 'SHP-99');
      assert.equal(orders[0].normalized_shipper_id, 'SHP-99');
      assert.equal(orders[0].shipper_name, '');
      assert.equal(orders[0].pickup_address, '');
    });
  });

  // ---------------------------------------------------------------------------
  // Group 3: SheetRepo.gs — Writes, LockService, op_logs & order_report Sync
  // ---------------------------------------------------------------------------
  describe('Group 3: SheetRepo.gs — Writes, LockService, op_logs & order_report Sync', () => {
    it('9. withScriptLock() acquires/releases lock cleanly on success, error, and simulated timeout', () => {
      const rt = createGasRuntime();
      vm.runInContext(
        'function testLockOk() { return withScriptLock(function() { return 42; }, 5000); }',
        rt.context
      );
      vm.runInContext(
        'function testLockErr() { return withScriptLock(function() { throw new Error("boom"); }, 5000); }',
        rt.context
      );

      assert.equal(rt.invoke('testLockOk'), 42);
      let stats = rt.getLockStats();
      assert.equal(stats.acquireCount, 1);
      assert.equal(stats.releaseCount, 1);
      assert.equal(stats.hasLock, false);

      assert.throws(() => rt.invoke('testLockErr'), /boom/);
      stats = rt.getLockStats();
      assert.equal(stats.acquireCount, 2);
      assert.equal(stats.releaseCount, 2);
      assert.equal(stats.hasLock, false);

      // Lock remains usable immediately after an error inside callback
      assert.equal(rt.invoke('testLockOk'), 42);

      // Simulated lock timeout prevents callback execution
      rt.simulateLockFailure(1, 'Could not obtain lock after 5000 ms.');
      assert.throws(() => rt.invoke('testLockOk'), /Could not obtain lock/);
      stats = rt.getLockStats();
      assert.equal(stats.acquireCount, 3); // unchanged by failed attempt
      assert.equal(stats.hasLock, false);

      // Next call recovers automatically
      assert.equal(rt.invoke('testLockOk'), 42);
      assert.equal(rt.getLockStats().acquireCount, 4);
    });

    it('9b. withScriptLock() preserves outer lock across nested re-entrant calls and exceptions', () => {
      const rt = createGasRuntime();
      vm.runInContext(
        [
          'function testNestedLockOk() {',
          '  return withScriptLock(function() {',
          '    var before = LockService.getScriptLock().hasLock();',
          '    var innerVal = withScriptLock(function() {',
          '      var deepVal = withScriptLock(function() { return "ok"; }, 2000);',
          '      return deepVal + ":" + LockService.getScriptLock().hasLock();',
          '    }, 2000);',
          '    var after = LockService.getScriptLock().hasLock();',
          '    return { before: before, after: after, innerVal: innerVal };',
          '  }, 2000);',
          '}',
          'function testNestedLockCaughtError() {',
          '  return withScriptLock(function() {',
          '    var caught = false;',
          '    try {',
          '      withScriptLock(function() { throw new Error("inner-fail"); }, 2000);',
          '    } catch (e) {',
          '      caught = e.message === "inner-fail";',
          '    }',
          '    return { caught: caught, stillLocked: LockService.getScriptLock().hasLock() };',
          '  }, 2000);',
          '}',
          'function testNestedLockUncaughtError() {',
          '  return withScriptLock(function() {',
          '    return withScriptLock(function() { throw new Error("outer-fail"); }, 2000);',
          '  }, 2000);',
          '}'
        ].join('\n'),
        rt.context
      );

      const nested = copyValues(rt.invoke('testNestedLockOk'));
      assert.deepEqual(nested, { before: true, after: true, innerVal: 'ok:true' });
      let stats = rt.getLockStats();
      assert.equal(stats.acquireCount, 1);
      assert.equal(stats.releaseCount, 1);
      assert.equal(stats.hasLock, false);

      const caughtRes = copyValues(rt.invoke('testNestedLockCaughtError'));
      assert.deepEqual(caughtRes, { caught: true, stillLocked: true });
      stats = rt.getLockStats();
      assert.equal(stats.acquireCount, 2);
      assert.equal(stats.releaseCount, 2);
      assert.equal(stats.hasLock, false);

      assert.throws(() => rt.invoke('testNestedLockUncaughtError'), /outer-fail/);
      stats = rt.getLockStats();
      assert.equal(stats.acquireCount, 3);
      assert.equal(stats.releaseCount, 3);
      assert.equal(stats.hasLock, false);

      // Lock remains healthy after uncaught nested failure
      assert.deepEqual(copyValues(rt.invoke('testNestedLockOk')), {
        before: true,
        after: true,
        innerVal: 'ok:true'
      });
    });

    it('10. appendOrderRow() enforces 10-column A:J BigQuery schema guard and persists rows', () => {
      const rt = createGasRuntime({
        shippersRows: [['SHP-01', 'Alpha Corp', 'Jl. Sudirman 1']]
      });

      const validRow = [
        'ORD-261118-1001',
        'RS-10001001',
        'SHP-01',
        '',
        'Pending Pickup',
        'HUB-JKT',
        'Jl. Asia Afrika No. 88',
        'HUB-BDG',
        '',
        ''
      ];
      const appendedRowNum = rt.invoke('appendOrderRow', validRow);
      assert.equal(appendedRowNum, 2);

      const sheetData = rt.getSheetData('db_orders');
      assert.equal(sheetData.length, 2);
      assert.equal(sheetData[1].length, 10);
      assert.equal(sheetData[1][0], 'ORD-261118-1001');

      const orders = copyValues(rt.invoke('getOrders'));
      assert.equal(orders.length, 1);
      assert.equal(orders[0].rowNumber, 2);
      assert.equal(orders[0].shipper_name, 'Alpha Corp');

      // Reject 9-column and 11-column rows
      assert.throws(
        () => rt.invoke('appendOrderRow', validRow.slice(0, 9)),
        /exactly 10 elements/
      );
      assert.throws(
        () => rt.invoke('appendOrderRow', [...validRow, 'EXTRA_COL']),
        /exactly 10 elements/
      );
      assert.equal(rt.getSheetData('db_orders').length, 2);
    });

    it('11. updateOrderFields() mutates D:J only, preserves A:C, and rejects invalid rows/fields', () => {
      const rt = createGasRuntime({
        shippersRows: [['SHP-01', 'Alpha Corp', 'Jl. Sudirman 1']],
        ordersRows: [
          [
            'ORD-1',
            'RS-1',
            'SHP-001',
            '',
            'Pending Pickup',
            'HUB-JKT',
            'Jl. Test 123',
            'HUB-SUB',
            '',
            ''
          ]
        ]
      });

      rt.invoke('updateOrderFields', 2, {
        status: 'Transit',
        current_hub: 'HUB-BDG',
        inbound_date: '11/18/2026',
        return_flag: 1
      });

      const sheetData = rt.getSheetData('db_orders');
      assert.equal(sheetData[1].length, 10);
      assert.equal(sheetData[1][0], 'ORD-1');
      assert.equal(sheetData[1][1], 'RS-1');
      assert.equal(sheetData[1][2], 'SHP-001'); // immutable legacy ID preserved
      assert.equal(sheetData[1][3], 1);
      assert.equal(sheetData[1][4], 'Transit');
      assert.equal(sheetData[1][5], 'HUB-BDG');
      assert.equal(sheetData[1][6], 'Jl. Test 123');
      assert.equal(sheetData[1][7], 'HUB-SUB');
      assert.equal(sheetData[1][8], '2026-11-18');
      assert.equal(sheetData[1][9], '');

      // Clear return_flag and set end_date
      rt.invoke('updateOrderFields', 2, {
        return_flag: '',
        status: 'Delivered',
        end_date: '2026-11-20'
      });
      const updated = copyValues(rt.invoke('getOrders'))[0];
      assert.equal(updated.return_flag, '');
      assert.equal(updated.status, 'Delivered');
      assert.equal(updated.end_date, '2026-11-20');

      // Reject immutable or unknown columns and out-of-range rowNumbers
      assert.throws(
        () => rt.invoke('updateOrderFields', 2, { shipper_id: 'SHP-01' }),
        /immutable or not permitted/
      );
      assert.throws(
        () => rt.invoke('updateOrderFields', 2, { bogus_col: 'x' }),
        /immutable or not permitted/
      );
      // Regression: Object.prototype keys must be rejected
      for (const protoKey of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
        assert.throws(
          () => rt.invoke('updateOrderFields', 2, { [protoKey]: 'X' }),
          /immutable or not permitted/
        );
      }
      assert.throws(() => rt.invoke('updateOrderFields', 1, { status: 'Transit' }), /Invalid rowNumber/);
      assert.throws(() => rt.invoke('updateOrderFields', 99, { status: 'Transit' }), /exceeds db_orders lastRow/);
    });

    it('12. appendOpLog() auto-creates op_logs tab and getOpLogs() reads newest-first without creating on read', () => {
      const rt = createGasRuntime({
        activeUserEmail: 'ops.lead@xpress.id',
        now: () => new Date('2026-11-18T10:00:00.000Z')
      });

      assert.equal(rt.hasSheet('op_logs'), false);
      assert.deepEqual(copyValues(rt.invoke('getOpLogs')), []);
      assert.equal(rt.hasSheet('op_logs'), false);

      const log1 = copyValues(
        rt.invoke('appendOpLog', {
          order_id: 'ORD-1',
          action: 'CREATE_ORDER',
          from_status: '',
          to_status: 'Pending Pickup',
          current_hub: 'HUB-JKT',
          courier: 'Budi',
          notes: 'Initial booking'
        })
      );
      assert.equal(rt.hasSheet('op_logs'), true);
      assert.match(log1.log_id, /^LOG-/);
      assert.equal(log1.timestamp, '2026-11-18T17:00:00+07:00');
      assert.equal(log1.operator_email, 'ops.lead@xpress.id');

      rt.invoke('appendOpLog', {
        order_id: 'ORD-1',
        action: 'CONFIRM_PICKUP',
        from_status: 'Pending Pickup',
        to_status: 'Transit',
        current_hub: 'HUB-JKT',
        courier: 'Andi',
        notes: 'Picked up'
      });
      rt.invoke('appendOpLog', {
        order_id: 'ORD-1',
        action: 'DISPATCH_DELIVERY',
        from_status: 'Transit',
        to_status: 'On Shipment',
        current_hub: 'HUB-BDG',
        courier: 'Candra',
        notes: 'Out for delivery'
      });

      const sheetData = rt.getSheetData('op_logs');
      assert.equal(sheetData.length, 4); // 1 header + 3 rows
      assert.deepEqual(sheetData[0], copyValues(rt.context.CONFIG.OP_LOG_HEADERS));

      const recent2 = copyValues(rt.invoke('getOpLogs', 2));
      assert.equal(recent2.length, 2);
      assert.equal(recent2[0].action, 'DISPATCH_DELIVERY');
      assert.equal(recent2[1].action, 'CONFIRM_PICKUP');
    });

    it('13. writeOrderReportRows() updates A2:K, clears excess A:K rows, and preserves A1:M1 & L1:M1 ARRAYFORMULAs', () => {
      const l1Formula =
        '=ARRAYFORMULA(\nIFS(ROW(J:J)=1, "Aging Parcel",\nJ:J="", "",\nK:K<>"",K:K-J:J,\nTRUE,Prototype!$P$1 - J:J))';
      const m1Formula =
        '=ARRAYFORMULA(\nIFS(ROW(J:J)=1, "Aging Type",\nA:A="", "",\nJ:J="", "Not Inbounded",\nL:L<8,"Under SLA",\nTRUE,"Over SLA"))';

      const headers = [
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
        'end_date',
        'Aging Parcel',
        'Aging Type'
      ];
      const staleRow = (idx) => [
        `OLD-${idx}`,
        `RS-${idx}`,
        'Old Shipper',
        'Old Addr',
        'Transit',
        '',
        'Jakarta Central Hub',
        'Bandung West Hub',
        'Dest Addr',
        '2026-10-01',
        '',
        '',
        ''
      ];

      const rt = createGasRuntime({
        reportRows: [
          headers,
          staleRow(1),
          staleRow(2),
          staleRow(3),
          staleRow(4),
          staleRow(5)
        ],
        reportFormulas: [
          ['', '', '', '', '', '', '', '', '', '', '', l1Formula, m1Formula]
        ]
      });

      const newRows = [
        [
          'ORD-NEW-1',
          'RS-NEW-1',
          'Alpha',
          'Pickup A',
          'Delivered',
          '',
          'Jakarta Central Hub',
          'Bandung West Hub',
          'Dest 1',
          '2026-11-01',
          '2026-11-03'
        ],
        [
          'ORD-NEW-2',
          'RS-NEW-2',
          'Beta',
          'Pickup B',
          'Transit',
          1,
          'Bandung West Hub',
          'Surabaya East Hub',
          'Dest 2',
          '2026-11-10',
          ''
        ]
      ];

      const res = copyValues(rt.invoke('writeOrderReportRows', newRows));
      assert.deepEqual(res, { writtenCount: 2, clearedRows: 3 });

      const values = rt.getSheetData('order_report');
      const formulas = rt.getSheetFormulas('order_report');

      assert.deepEqual(values[0], headers);
      assert.equal(formulas[0][11], l1Formula);
      assert.equal(formulas[0][12], m1Formula);
      assert.deepEqual(values[1].slice(0, 11), newRows[0]);
      assert.deepEqual(values[2].slice(0, 11), newRows[1]);

      // Rows 4..6 (indices 3..5) must have A:K cleared
      for (let r = 3; r <= 5; r++) {
        if (values[r]) {
          assert.deepEqual(values[r].slice(0, 11), Array(11).fill(''));
        }
      }

      // Writing 0 rows clears all A2:K while preserving A1:M1 and L1:M1 formulas
      const resZero = copyValues(rt.invoke('writeOrderReportRows', []));
      assert.equal(resZero.writtenCount, 0);
      const afterZeroValues = rt.getSheetData('order_report');
      const afterZeroFormulas = rt.getSheetFormulas('order_report');
      assert.deepEqual(afterZeroValues[0], headers);
      assert.equal(afterZeroFormulas[0][11], l1Formula);
      assert.equal(afterZeroFormulas[0][12], m1Formula);
      assert.equal(afterZeroValues.length, 1);

      // Reject wrong column count
      assert.throws(
        () => rt.invoke('writeOrderReportRows', [['ONLY_10_COLS', '2', '3', '4', '5', '6', '7', '8', '9', '10']]),
        /exactly 11 columns/
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Group 4: gasRuntime.js Isolation & devServer.js HTTP/RPC Smoke Tests
  // ---------------------------------------------------------------------------
  describe('Group 4: gasRuntime.js Isolation & devServer.js HTTP/RPC Smoke Tests', () => {
    it('14. gasRuntime instances are completely isolated and never mutate sheet_snapshot.json on disk', () => {
      const beforeBuf = fs.readFileSync(SNAPSHOT_PATH);
      const beforeHash = crypto.createHash('sha256').update(beforeBuf).digest('hex');
      const beforeMtime = fs.statSync(SNAPSHOT_PATH).mtimeMs;

      const rtA = createGasRuntime({ snapshotPath: SNAPSHOT_PATH });
      const rtB = createGasRuntime({ snapshotPath: SNAPSHOT_PATH });

      rtA.invoke('appendOrderRow', [
        'ORD-ISO-1',
        'RS-ISO-1',
        'SHP-01',
        '',
        'Pending Pickup',
        'HUB-JKT',
        'Jl. Isolation',
        'HUB-BDG',
        '',
        ''
      ]);
      rtA.invoke('appendOpLog', {
        order_id: 'ORD-ISO-1',
        action: 'CREATE_ORDER',
        from_status: '',
        to_status: 'Pending Pickup',
        current_hub: 'HUB-JKT',
        courier: 'Tester',
        notes: 'Isolation test'
      });

      assert.equal(rtA.invoke('getOrders').length, 533);
      assert.equal(rtA.hasSheet('op_logs'), true);

      assert.equal(rtB.invoke('getOrders').length, 532);
      assert.equal(rtB.hasSheet('op_logs'), false);
      assert.deepEqual(copyValues(rtB.invoke('getOpLogs')), []);

      const afterBuf = fs.readFileSync(SNAPSHOT_PATH);
      const afterHash = crypto.createHash('sha256').update(afterBuf).digest('hex');
      const afterMtime = fs.statSync(SNAPSHOT_PATH).mtimeMs;
      assert.equal(afterHash, beforeHash);
      assert.equal(afterMtime, beforeMtime);
    });

    it('15. devServer.js serves HTML with include() + google.script.run shim, handles /__gas_rpc, and closes cleanly', async () => {
      const tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'm1-dev-test-'));
      try {
        fs.copyFileSync(path.join(SRC_DIR, 'Config.gs'), path.join(tmpSrc, 'Config.gs'));
        fs.copyFileSync(path.join(SRC_DIR, 'SheetRepo.gs'), path.join(tmpSrc, 'SheetRepo.gs'));
        fs.writeFileSync(
          path.join(tmpSrc, 'WebApp.gs'),
          [
            'function include(name) {',
            '  return HtmlService.createHtmlOutputFromFile(name).getContent();',
            '}',
            'function doGet(e) {',
            '  var tpl = HtmlService.createTemplateFromFile("Index");',
            '  tpl.initialView = (e && e.parameter && e.parameter.view) || "dashboard";',
            '  return tpl.evaluate().setTitle("Stub App");',
            '}'
          ].join('\n')
        );
        fs.writeFileSync(
          path.join(tmpSrc, 'Styles.html'),
          '<style>body { color: #111827; }</style>'
        );
        fs.writeFileSync(
          path.join(tmpSrc, 'Index.html'),
          [
            '<!DOCTYPE html>',
            '<html>',
            '<head><title>Test</title><?!= include("Styles"); ?></head>',
            '<body><div id="view" data-view="<?= initialView; ?>"></div></body>',
            '</html>'
          ].join('\n')
        );

        const dev = await startDevServer({
          port: 0,
          snapshotPath: SNAPSHOT_PATH,
          srcDir: tmpSrc
        });

        try {
          assert.ok(dev.url.startsWith('http://127.0.0.1:'));

          const pageRes = await fetch(`${dev.url}/?view=pickup`);
          assert.equal(pageRes.status, 200);
          assert.match(pageRes.headers.get('content-type') || '', /text\/html/);
          const html = await pageRes.text();
          assert.ok(html.includes('body { color: #111827; }'));
          assert.ok(html.includes('data-view="pickup"'));
          assert.ok(html.includes('window.google.script.run'));

          const rpcRes = await fetch(`${dev.url}/__gas_rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fn: 'getShippers', args: [] })
          });
          assert.equal(rpcRes.status, 200);
          const rpcPayload = await rpcRes.json();
          assert.equal(rpcPayload.ok, true);
          assert.equal(rpcPayload.result.length, 4);

          const badRpcRes = await fetch(`${dev.url}/__gas_rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fn: 'nonExistentFn', args: [] })
          });
          assert.equal(badRpcRes.status, 200);
          const badRpcPayload = await badRpcRes.json();
          assert.equal(badRpcPayload.ok, false);
          assert.match(badRpcPayload.error, /not defined/);

          // Server stays healthy after RPC error
          const healthRes = await fetch(`${dev.url}/__gas_rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fn: 'getHubName', args: ['HUB-JKT'] })
          });
          const healthPayload = await healthRes.json();
          assert.equal(healthPayload.ok, true);
          assert.equal(healthPayload.result, 'Jakarta Central Hub');
        } finally {
          await dev.close();
        }
      } finally {
        fs.rmSync(tmpSrc, { recursive: true, force: true });
      }
    });

    it('16. devServer.js serves diagnostic HTML fallback when WebApp.gs is absent (M1 mode)', async () => {
      const tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'lpx-m1-fallback-'));
      try {
        fs.copyFileSync(path.join(__dirname, '../../src/Config.gs'), path.join(tmpSrc, 'Config.gs'));
        fs.copyFileSync(path.join(__dirname, '../../src/SheetRepo.gs'), path.join(tmpSrc, 'SheetRepo.gs'));
        const dev = await startDevServer({
          port: 0,
          srcDir: tmpSrc,
          snapshotPath: SNAPSHOT_PATH
        });
        try {
          const res = await fetch(`${dev.url}/?view=pickup`);
          assert.equal(res.status, 200);
          const html = await res.text();
          assert.ok(html.includes('doGet(e) not implemented yet'));
          assert.ok(html.includes('pickup'));
          assert.ok(html.includes('window.google.script.run'));

          const rpcRes = await fetch(`${dev.url}/__gas_rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fn: 'getShippers', args: [] })
          });
          const rpcJson = await rpcRes.json();
          assert.equal(rpcJson.ok, true);
          assert.equal(rpcJson.result.length, 4);
        } finally {
          await dev.close();
        }
      } finally {
        fs.rmSync(tmpSrc, { recursive: true, force: true });
      }
    });

    it('17. gasRuntime.js regression: A2:K on 1-row sheet preserves Row 1, CacheService 0s TTL expires immediately, and Object.prototype RPCs are blocked', async () => {
      const headers = [
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
        'end_date',
        'Aging Parcel',
        'Aging Type'
      ];
      const l1 = '=ARRAYFORMULA(L1)';
      const m1 = '=ARRAYFORMULA(M1)';

      const rt = createGasRuntime({
        reportRows: [headers],
        reportFormulas: [['', '', '', '', '', '', '', '', '', '', '', l1, m1]]
      });

      // 1) A2:K on 1-row sheet must stay at row >= 2 and never invert to A1:K2
      const report = rt.context.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('order_report');
      const range = report.getRange('A2:K');
      assert.equal(range.getRow(), 2);
      assert.equal(range.getA1Notation(), 'A2:K2');
      range.clearContent();
      assert.deepEqual(copyValues(report.getRange('A1:K1').getValues()[0]), headers.slice(0, 11));
      assert.equal(report.getRange('L1').getFormula(), l1);
      assert.equal(report.getRange('M1').getFormula(), m1);

      // 2) CacheService.put(k, v, 0) expires immediately instead of defaulting to 600s
      const cache = rt.context.CacheService.getScriptCache();
      cache.put('zero_ttl', 'should_expire', 0);
      assert.equal(cache.get('zero_ttl'), null);
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(cache.get('zero_ttl'), null);

      cache.put('default_ttl', 'persists');
      assert.equal(cache.get('default_ttl'), 'persists');

      // 3) Object.prototype methods are blocked in hasFunction/invoke and /__gas_rpc
      for (const protoFn of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
        assert.equal(rt.hasFunction(protoFn), false);
        assert.throws(() => rt.invoke(protoFn, 'return 1'), /is not defined/);
      }

      // Legitimate const/let top-level functions remain callable
      vm.runInContext('const customConstFn = (x) => x + 1;', rt.context);
      assert.equal(rt.hasFunction('customConstFn'), true);
      assert.equal(rt.invoke('customConstFn', 41), 42);

      const dev = await startDevServer({ port: 0, snapshotPath: null });
      try {
        const res = await fetch(`${dev.url}/__gas_rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fn: 'constructor', args: ['return 1'] })
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.match(body.error, /not defined/);
      } finally {
        await dev.close();
      }
    });
  });
});
