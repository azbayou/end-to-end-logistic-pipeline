'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createGasRuntime } = require('../gas-mock/gasRuntime');

const SNAPSHOT_PATH = path.resolve(__dirname, '../fixtures/sheet_snapshot.json');

describe('M4 WebApp.gs', () => {
  it('doGet(e) renders Index.html with Styles & Scripts included and honors ?view=', () => {
    const rt = createGasRuntime({ snapshotPath: SNAPSHOT_PATH });
    const out = rt.invoke('doGet', { parameter: { view: 'sort' } });
    const html = out.getContent();
    assert.ok(html.includes('id="view-dashboard"'));
    assert.ok(html.includes('id="view-input"'));
    assert.ok(html.includes('id="view-pickup"'));
    assert.ok(html.includes('id="view-sort"'));
    assert.ok(html.includes('id="view-delivery"'));
    assert.ok(html.includes('initialView: "sort"'));
    assert.ok(html.includes('<style>'));
    assert.ok(html.includes('apiGetBootstrapData'));
  });

  it('apiGetBootstrapData() and apiGetOrdersQueue() return complete bootstrap state', () => {
    const rt = createGasRuntime({
      snapshotPath: SNAPSHOT_PATH,
      now: () => new Date('2026-11-18T05:00:00Z')
    });
    const boot = rt.invoke('apiGetBootstrapData', {});
    assert.equal(boot.ok, true);
    assert.equal(boot.orders.length, 532);
    assert.equal(boot.shippers.length, 4);
    assert.equal(boot.dashboard.kpis.totalOrders, 532);

    const queue = rt.invoke('apiGetOrdersQueue', { status: 'Pending Pickup' });
    assert.equal(queue.ok, true);
    assert.ok(queue.orders.every((o) => o.status === 'Pending Pickup'));
  });
});
