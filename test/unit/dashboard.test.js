'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createGasRuntime } = require('../gas-mock/gasRuntime');

const SNAPSHOT_PATH = path.resolve(__dirname, '../fixtures/sheet_snapshot.json');

describe('M3 DashboardService.gs', () => {
  it('computeOrderAging() classifies < 8 as Under SLA, >= 8 as Over SLA, blank as Not Inbounded', () => {
    const rt = createGasRuntime({
      snapshotPath: SNAPSHOT_PATH,
      now: () => new Date('2026-11-18T05:00:00Z')
    });

    const plain = (v) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(
      plain(rt.invoke('computeOrderAging', { inbound_date: '' }, '2026-11-18')),
      { agingDays: null, agingType: 'Not Inbounded' }
    );
    assert.deepEqual(
      plain(rt.invoke('computeOrderAging', { inbound_date: '2026-11-11', end_date: '' }, '2026-11-18')),
      { agingDays: 7, agingType: 'Under SLA' }
    );
    assert.deepEqual(
      plain(rt.invoke('computeOrderAging', { inbound_date: '2026-11-10', end_date: '' }, '2026-11-18')),
      { agingDays: 8, agingType: 'Over SLA' }
    );
    assert.deepEqual(
      plain(rt.invoke('computeOrderAging', { inbound_date: '2026-11-01', end_date: '2026-11-06' }, '2026-11-18')),
      { agingDays: 5, agingType: 'Under SLA' }
    );
  });

  it('getDashboardData() computes 5 KPIs, 7 charts, filters, and High Aging sorted descending', () => {
    const rt = createGasRuntime({
      snapshotPath: SNAPSHOT_PATH,
      now: () => new Date('2026-11-18T05:00:00Z')
    });

    const dash = rt.invoke('getDashboardData', {});
    assert.equal(dash.ok, true);
    assert.equal(dash.kpis.totalOrders, 532);
    assert.equal(dash.charts.statusBreakdown.length, 5);
    assert.equal(dash.charts.volumeByHub.current.length, 3);
    assert.equal(dash.charts.volumeByHub.destination.length, 3);
    assert.equal(dash.charts.returnRateByDestinationHub.length, 3);
    assert.equal(dash.charts.shipperBreakdown.length, 4);
    assert.equal(dash.charts.slaByHub.length, 3);

    for (let i = 1; i < dash.highAgingOrders.length; i++) {
      assert.ok(
        dash.highAgingOrders[i - 1].agingDays >= dash.highAgingOrders[i].agingDays,
        'highAgingOrders must be sorted descending by agingDays'
      );
    }

    const emptyFilter = rt.invoke('getDashboardData', { search: 'NO_SUCH_ORDER_999' });
    assert.equal(emptyFilter.kpis.totalOrders, 0);
    assert.equal(emptyFilter.kpis.deliveredRate, 0);
    assert.equal(emptyFilter.kpis.returnRate, 0);
    assert.equal(emptyFilter.kpis.avgDeliveryTime, 0);
  });
});
