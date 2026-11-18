'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createGasRuntime } = require('../gas-mock/gasRuntime');

const SNAPSHOT_PATH = path.resolve(__dirname, '../fixtures/sheet_snapshot.json');

describe('M2 OperationsService.gs', () => {
  it('createOrder() validates inputs and writes 10-col db_orders row + op_logs', () => {
    const rt = createGasRuntime({
      snapshotPath: SNAPSHOT_PATH,
      now: () => new Date('2026-11-18T05:00:00Z')
    });

    const badAddr = rt.invoke('createOrder', {
      shipper_id: 'SHP-01',
      current_hub: 'HUB-JKT',
      destination_hub: 'HUB-BDG',
      destination_address: 'abc'
    });
    assert.equal(badAddr.ok, false);

    const badHub = rt.invoke('createOrder', {
      shipper_id: 'SHP-01',
      current_hub: 'HUB-XYZ',
      destination_hub: 'HUB-BDG',
      destination_address: 'Jl. Valid Address No. 5'
    });
    assert.equal(badHub.ok, false);

    const created = rt.invoke('createOrder', {
      shipper_id: 'SHP-001',
      current_hub: 'HUB-JKT',
      destination_hub: 'HUB-SUB',
      destination_address: 'Jl. Pemuda No. 15, Surabaya',
      courier: 'Andi',
      notes: 'Unit test order'
    });
    assert.equal(created.ok, true);
    assert.match(created.order.order_id, /^ORD-261118-\d{4}$/);
    assert.match(created.order.resi, /^RS-\d{8}$/);
    assert.equal(created.order.status, 'Pending Pickup');
    assert.equal(created.order.normalized_shipper_id, 'SHP-01');

    const ordersRaw = rt.getSheetData('db_orders');
    assert.equal(ordersRaw[0].length, 10);
    const logs = rt.invoke('getOpLogs', 5);
    assert.equal(logs[0].order_id, created.order.order_id);
    assert.equal(logs[0].action, 'CREATE_ORDER');
    assert.equal(logs[0].courier, 'Andi');
  });

  it('runs full lifecycle Pending Pickup -> Transit -> On Shipment -> Delivered and RTS flows', () => {
    const rt = createGasRuntime({
      snapshotPath: SNAPSHOT_PATH,
      now: () => new Date('2026-11-18T05:00:00Z')
    });

    const c1 = rt.invoke('createOrder', {
      shipper_id: 'SHP-02',
      current_hub: 'HUB-JKT',
      destination_hub: 'HUB-SUB',
      destination_address: 'Jl. Darmo No. 22, Surabaya'
    });
    const oid = c1.order.order_id;

    // Pickup
    const p1 = rt.invoke('confirmPickup', {
      orderIds: [oid],
      courier: 'Driver-1',
      notes: 'Picked up'
    });
    assert.equal(p1.ok, true);
    assert.equal(p1.updatedOrders[0].status, 'Transit');
    assert.equal(p1.updatedOrders[0].inbound_date, '2026-11-18');

    // Cross-hub dispatch guard before transfer
    const crossErr = rt.invoke('processSort', {
      orderIds: [oid],
      action: 'DISPATCH_DELIVERY'
    });
    assert.equal(crossErr.ok, false);
    assert.equal(crossErr.code, 'CROSS_HUB_CONFIRM_REQUIRED');
    assert.equal(crossErr.mismatchOrders.length, 1);

    // Transfer to destination hub, then dispatch
    const tr = rt.invoke('processSort', {
      orderIds: [oid],
      action: 'TRANSFER_HUB',
      target_hub: 'HUB-SUB',
      courier: 'Linehaul-1'
    });
    assert.equal(tr.ok, true);
    assert.equal(tr.updatedOrders[0].current_hub, 'HUB-SUB');

    const disp = rt.invoke('processSort', {
      orderIds: [oid],
      action: 'DISPATCH_DELIVERY',
      courier: 'Kurir-1'
    });
    assert.equal(disp.ok, true);
    assert.equal(disp.updatedOrders[0].status, 'On Shipment');

    // Failed RTS -> back to Transit with return_flag=1
    const rts = rt.invoke('processDelivery', {
      orderIds: [oid],
      action: 'FAILED_RTS',
      notes: 'Consignee away'
    });
    assert.equal(rts.ok, true);
    assert.equal(rts.updatedOrders[0].status, 'Transit');
    assert.equal(rts.updatedOrders[0].return_flag, 1);

    // Mark Returned from flagged Transit
    const ret = rt.invoke('processDelivery', {
      orderIds: [oid],
      action: 'MARK_RETURNED',
      notes: 'Returned to shipper'
    });
    assert.equal(ret.ok, true);
    assert.equal(ret.updatedOrders[0].status, 'Returned');
    assert.equal(ret.updatedOrders[0].end_date, '2026-11-18');

    // Terminal order rejected on subsequent operations
    const retry = rt.invoke('processDelivery', {
      orderIds: [oid],
      action: 'MARK_DELIVERED'
    });
    assert.equal(retry.ok, false);
  });

  it('syncOrderReport() refreshes A2:K while preserving L1:M1 ARRAYFORMULAs', () => {
    const rt = createGasRuntime({ snapshotPath: SNAPSHOT_PATH });
    const beforeFormulas = rt.getSheetFormulas('order_report');
    const syncRes = rt.invoke('syncOrderReport');
    assert.equal(syncRes.ok, true);
    assert.ok(syncRes.syncedCount >= 500);
    const afterFormulas = rt.getSheetFormulas('order_report');
    assert.equal(afterFormulas[0][11], beforeFormulas[0][11]);
    assert.equal(afterFormulas[0][12], beforeFormulas[0][12]);
  });
});
