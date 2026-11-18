import assert from 'node:assert/strict';
import {
  assertDbOrdersSchema10Cols,
  assertNoBrokenNumbers,
  clickQuickJumpAction,
  computeExpectedDashboard,
  createOrderViaUi,
  getBangkokDateYmd,
  getHighAgingTable,
  getSheetFormulas,
  getSheetTable,
  navigateToView,
  normalizeYmd,
  performRpcAction,
  readDashboardKpis,
  selectQueueRow,
  waitForKpiTotal,
  waitForToast,
  waitForViewReady,
  withTestSession
} from './helpers.mjs';

function makeTests(sharedBrowserGetter) {
  const runSession = (opts, fn) =>
    withTestSession({ ...opts, sharedBrowser: sharedBrowserGetter?.() || null }, fn);

  return [
    // T4-W1: Workload 1 — Intra-City Same-Hub Full Lifecycle
    {
      name: 'T4-W1 Intra-city same-hub full lifecycle (Input -> Pickup -> Sort Ready -> Dispatch -> Delivered)',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const todayBangkok = getBangkokDateYmd(0);
          const { rows: baseOrders } = getSheetTable(runtime, 'db_orders');
          const { rows: shippers } = getSheetTable(runtime, 'db_shippers');
          const baseOracle = computeExpectedDashboard(baseOrders, shippers);
          const baseKpis = await readDashboardKpis(page);
          assert.equal(baseKpis.totalOrders, baseOracle.totalOrders);

          // Input Data
          await navigateToView(page, 'input');
          await page.locator('#input-shipper-id').selectOption('SHP-01');
          await page.waitForFunction(() =>
            document.querySelector('#view-input')?.textContent?.includes('Jl. Merdeka No. 1, Jakarta')
          );
          const { orderId, resi } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-JKT',
            address: 'Jl. Kuningan Mulia No. 15, Jakarta Selatan',
            courier: 'Op-JKT-01',
            notes: 'Same-day intra-city'
          });

          // Pickup
          await navigateToView(page, 'pickup');
          await page.locator('#pickup-hub-filter').selectOption('HUB-JKT');
          await page.locator('#pickup-scan-input').fill(resi || orderId);
          await selectQueueRow(page, '#view-pickup', orderId);
          await page.locator('#pickup-confirm-hub').selectOption('HUB-JKT');
          await page.locator('#pickup-date').fill(todayBangkok);
          await page.locator('#pickup-courier').fill('Driver-JKT-02');
          await page.locator('#pickup-notes').fill('Picked up from PT Toko Maju');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|confirmed|picked up|1/i);

          // Sort (Ready for Last-Mile)
          await navigateToView(page, 'sort');
          await page.locator('#sort-hub-filter').selectOption('HUB-JKT');
          await page.locator('#sort-tab-ready').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await page.locator('#sort-courier').fill('Sort-JKT-03');
          await page.locator('#sort-notes').fill('Sorted to van JKT-07');
          await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
          await waitForToast(page, /dispatch|on shipment/i);
          assert.equal(await page.locator('#confirm-modal').isVisible(), false);

          // Delivery
          await navigateToView(page, 'delivery');
          await page.locator('#delivery-hub-filter').selectOption('HUB-JKT');
          await page.locator('#delivery-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-delivery', orderId);
          await page.locator('#delivery-date').fill(todayBangkok);
          await page.locator('#delivery-courier').fill('Courier-JKT-09');
          await page.locator('#delivery-notes').fill('Delivered to Receptionist');
          await performRpcAction(page, () => page.locator('#btn-delivery-delivered').click());
          await waitForToast(page, /delivered/i);

          // Dashboard Verification
          await navigateToView(page, 'dashboard');
          await waitForKpiTotal(page, baseOracle.totalOrders + 1);
          const finalKpis = await readDashboardKpis(page);
          assertNoBrokenNumbers(JSON.stringify(finalKpis.raw), 'T4-W1 Final KPIs');
          assert.equal(finalKpis.totalOrders, baseOracle.totalOrders + 1);
          assert.equal(finalKpis.activeShipments, baseOracle.activeShipments);

          const expectedDelivRate =
            ((baseOracle.deliveredCount + 1) / (baseOracle.closedCount + 1)) * 100;
          const expectedRetRate =
            (baseOracle.returnFlagCount / (baseOracle.totalOrders + 1)) * 100;
          assert.ok(Math.abs(finalKpis.deliveredRate - expectedDelivRate) <= 0.05);
          assert.ok(Math.abs(finalKpis.returnRate - expectedRetRate) <= 0.05);
          assert.ok(finalKpis.avgDeliveryTime >= 0);

          const dashCharts = await page.locator('#view-dashboard svg, #view-dashboard canvas').count();
          assert.ok(dashCharts >= 5, 'Dashboard charts must render after workload');

          assertDbOrdersSchema10Cols(runtime);
          const dbRow = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === orderId);
          assert.equal(dbRow.status, 'Delivered');
          assert.equal(dbRow.return_flag, '');
          assert.equal(normalizeYmd(dbRow.inbound_date), todayBangkok);
          assert.equal(normalizeYmd(dbRow.end_date), todayBangkok);

          const logs = getSheetTable(runtime, 'op_logs').rows.filter((l) => l.order_id === orderId);
          assert.equal(logs.length, 4);
        })
    },

    // T4-W2: Workload 2 — Multi-Hub Linehaul Lifecycle + Cross-Hub Modal Guard
    {
      name: 'T4-W2 Multi-hub linehaul lifecycle (BDG -> JKT -> Modal Cancel -> SUB -> Dispatch -> Delivered)',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const todayBangkok = getBangkokDateYmd(0);
          const { rows: baseOrders } = getSheetTable(runtime, 'db_orders');
          const { rows: shippers } = getSheetTable(runtime, 'db_shippers');
          const baseOracle = computeExpectedDashboard(baseOrders, shippers);

          // 1. Input
          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-02',
            currentHub: 'HUB-BDG',
            destinationHub: 'HUB-SUB',
            address: 'Jl. Tunjungan No. 101, Surabaya',
            courier: 'Intake-BDG',
            notes: 'Bandung to Surabaya'
          });

          // 2. Pickup
          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-pickup', orderId);
          await page.locator('#pickup-confirm-hub').selectOption('HUB-BDG');
          await page.locator('#pickup-date').fill(todayBangkok);
          await page.locator('#pickup-courier').fill('Pickup-BDG');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|confirmed|picked up|1/i);

          // 3. Sort Leg 1 Transfer BDG -> JKT
          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-linehaul').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await page.locator('#sort-target-hub').selectOption('HUB-JKT');
          await page.locator('#sort-courier').fill('Linehaul-BDG-JKT');
          await page.locator('#sort-notes').fill('Arrived Jakarta hub');
          await performRpcAction(page, () => page.locator('#btn-sort-transfer').click());
          await waitForToast(page, /transfer|hub|transit/i);

          // 4. Cross-hub Modal Guard Check -> Cancel
          await page.locator('#sort-tab-linehaul').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await page.locator('#btn-sort-dispatch').click();
          await page.locator('#confirm-modal').waitFor({ state: 'visible' });
          await page.locator('#btn-confirm-modal-cancel').click();
          await page.locator('#confirm-modal').waitFor({ state: 'hidden' });

          assert.equal(
            getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === orderId).status,
            'Transit'
          );

          // 5. Sort Leg 2 Transfer JKT -> SUB
          await selectQueueRow(page, '#view-sort', orderId);
          await page.locator('#sort-target-hub').selectOption('HUB-SUB');
          await page.locator('#sort-courier').fill('Linehaul-JKT-SUB');
          await page.locator('#sort-notes').fill('Arrived Surabaya hub');
          await performRpcAction(page, () => page.locator('#btn-sort-transfer').click());
          await waitForToast(page, /transfer|hub|transit/i);

          // 6. Sort Last-Mile Dispatch (now Ready at HUB-SUB)
          await page.locator('#sort-tab-ready').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await page.locator('#sort-courier').fill('Dispatch-SUB');
          await page.locator('#sort-notes').fill('Dispatched in Surabaya');
          await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
          await waitForToast(page, /dispatch|on shipment/i);
          assert.equal(await page.locator('#confirm-modal').isVisible(), false);

          // 7. Delivery
          await navigateToView(page, 'delivery');
          await page.locator('#delivery-hub-filter').selectOption('HUB-SUB');
          await page.locator('#delivery-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-delivery', orderId);
          await page.locator('#delivery-date').fill(todayBangkok);
          await page.locator('#delivery-courier').fill('Courier-SUB-04');
          await page.locator('#delivery-notes').fill('Signed at Surabaya office');
          await performRpcAction(page, () => page.locator('#btn-delivery-delivered').click());
          await waitForToast(page, /delivered/i);

          // 8. Dashboard & Audit Verification
          await navigateToView(page, 'dashboard');
          await waitForKpiTotal(page, baseOracle.totalOrders + 1);
          const finalKpis = await readDashboardKpis(page);
          assert.equal(finalKpis.totalOrders, baseOracle.totalOrders + 1);
          assert.equal(finalKpis.activeShipments, baseOracle.activeShipments);
          const expectedDelivRate =
            ((baseOracle.deliveredCount + 1) / (baseOracle.closedCount + 1)) * 100;
          assert.ok(Math.abs(finalKpis.deliveredRate - expectedDelivRate) <= 0.05);

          const logs = getSheetTable(runtime, 'op_logs').rows.filter((l) => l.order_id === orderId);
          assert.equal(logs.length, 6, 'Cancelled modal attempt must NOT write any op_log entry');
        })
    },

    // T4-W3: Workload 3 — Failed Delivery RTS & Terminal Return Cycle
    {
      name: 'T4-W3 Failed Delivery RTS -> Sort Flagged -> Terminal Returned & Dashboard rates',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const todayBangkok = getBangkokDateYmd(0);
          const { rows: baseOrders } = getSheetTable(runtime, 'db_orders');
          const { rows: shippers } = getSheetTable(runtime, 'db_shippers');
          const baseOracle = computeExpectedDashboard(baseOrders, shippers);

          // 1. Input
          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-03',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-BDG',
            address: 'Jl. Setiabudi No. 200, Bandung'
          });

          // 2. Pickup
          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-pickup', orderId);
          await page.locator('#pickup-confirm-hub').selectOption('HUB-JKT');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|confirmed|picked up|1/i);

          // 3. Sort Transfer -> Dispatch
          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-linehaul').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await page.locator('#sort-target-hub').selectOption('HUB-BDG');
          await performRpcAction(page, () => page.locator('#btn-sort-transfer').click());
          await waitForToast(page, /transfer|hub|transit/i);

          await page.locator('#sort-tab-ready').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
          await waitForToast(page, /dispatch|on shipment/i);

          // 4. Failed Delivery RTS
          await navigateToView(page, 'delivery');
          await page.locator('#delivery-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-delivery', orderId);
          await page.locator('#delivery-courier').fill('Driver-Fail-01');
          await page.locator('#delivery-notes').fill('Address incomplete, initiate RTS');
          await performRpcAction(page, () => page.locator('#btn-delivery-failed-rts').click());
          await waitForToast(page, /rts|transit|return/i);

          // 5. Verify Sort Flagged & Intermediate Dashboard
          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-flagged').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await page.locator('#view-sort table tbody tr', { hasText: orderId }).first().waitFor({ state: 'visible' });

          await navigateToView(page, 'dashboard');
          await waitForKpiTotal(page, baseOracle.totalOrders + 1);
          const midKpis = await readDashboardKpis(page);
          const expectedRetRate = ((baseOracle.returnFlagCount + 1) / (baseOracle.totalOrders + 1)) * 100;
          assert.equal(midKpis.activeShipments, baseOracle.activeShipments + 1);
          assert.ok(Math.abs(midKpis.returnRate - expectedRetRate) <= 0.05);
          assert.ok(Math.abs(midKpis.deliveredRate - baseOracle.deliveredRate) <= 0.05);

          // 6. Delivery -> Mark Returned
          await navigateToView(page, 'delivery');
          await page.locator('#delivery-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-delivery', orderId);
          await page.locator('#delivery-date').fill(todayBangkok);
          await page.locator('#delivery-courier').fill('RTS-Final-02');
          await page.locator('#delivery-notes').fill('Returned to PT Maju Jaya Sejahtera');
          await performRpcAction(page, () => page.locator('#btn-delivery-returned').click());
          await waitForToast(page, /returned/i);

          // 7. Final Dashboard & Sheet Verification
          await navigateToView(page, 'dashboard');
          await waitForKpiTotal(page, baseOracle.totalOrders + 1);
          const finalKpis = await readDashboardKpis(page);
          const expectedFinalDelivRate =
            (baseOracle.deliveredCount / (baseOracle.closedCount + 1)) * 100;
          assert.equal(finalKpis.totalOrders, baseOracle.totalOrders + 1);
          assert.equal(finalKpis.activeShipments, baseOracle.activeShipments);
          assert.ok(Math.abs(finalKpis.returnRate - expectedRetRate) <= 0.05);
          assert.ok(Math.abs(finalKpis.deliveredRate - expectedFinalDelivRate) <= 0.05);

          const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === orderId);
          assert.equal(row.status, 'Returned');
          assert.equal(Number(row.return_flag), 1);
          assert.equal(normalizeYmd(row.end_date), todayBangkok);

          const logs = getSheetTable(runtime, 'op_logs').rows.filter((l) => l.order_id === orderId);
          const transitions = logs.map((l) => `${l.from_status}->${l.to_status}`);
          assert.ok(transitions.includes('On Shipment->Transit'));
          assert.ok(transitions.includes('Transit->Returned'));
        })
    },

    // T4-W4: Workload 4 — High Aging Over-SLA Triage & Resolution
    {
      name: 'T4-W4 High Aging Over-SLA triage (Dashboard quick-jump -> Delivery -> SLA & KPI recovery)',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const aging14Date = getBangkokDateYmd(-14);
          const todayBangkok = getBangkokDateYmd(0);

          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-JKT',
            address: 'Jl. Thamrin Over-SLA Test'
          });

          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-pickup', orderId);
          await page.locator('#pickup-date').fill(aging14Date);
          await page.locator('#pickup-courier').fill('OverSLA-Pickup');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|confirmed|picked up|1/i);

          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-ready').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
          await waitForToast(page, /dispatch|on shipment/i);

          await navigateToView(page, 'dashboard');
          const kpisBefore = await readDashboardKpis(page);
          const tableBefore = await getHighAgingTable(page);
          const initialHighAgingCount = await tableBefore.locator('tbody tr').count();
          const targetRow = tableBefore.locator('tbody tr', { hasText: orderId }).first();
          await targetRow.waitFor({ state: 'visible' });
          assert.match(await targetRow.innerText(), /Over SLA|14/i);

          // Quick-jump to Delivery
          await clickQuickJumpAction(targetRow);
          await waitForViewReady(page, 'delivery');
          assert.equal(await page.locator('#view-delivery').isVisible(), true);

          await page.locator('#delivery-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-delivery', orderId);
          await page.locator('#delivery-date').fill(todayBangkok);
          await page.locator('#delivery-courier').fill('SLA-Escalation-Courier');
          await page.locator('#delivery-notes').fill('Priority Over-SLA delivery completed');
          await performRpcAction(page, () => page.locator('#btn-delivery-delivered').click());
          await waitForToast(page, /delivered/i);

          await navigateToView(page, 'dashboard');
          await performRpcAction(page, () => page.locator('#btn-refresh-all').click());
          await waitForKpiTotal(page, kpisBefore.totalOrders);

          const kpisAfter = await readDashboardKpis(page);
          assertNoBrokenNumbers(JSON.stringify(kpisAfter.raw), 'T4-W4 KPIs');
          assert.equal(kpisAfter.activeShipments, kpisBefore.activeShipments - 1);
          assert.ok(kpisAfter.deliveredRate > kpisBefore.deliveredRate);

          const tableAfter = await getHighAgingTable(page);
          assert.equal(await tableAfter.locator('tbody tr', { hasText: orderId }).count(), 0);
          const afterHighAgingCount = await tableAfter.locator('tbody tr').count();
          assert.ok(
            afterHighAgingCount <= initialHighAgingCount,
            `High Aging row count should not increase after resolution (before=${initialHighAgingCount}, after=${afterHighAgingCount})`
          );

          const escalationLog = getSheetTable(runtime, 'op_logs').rows.find(
            (l) => l.order_id === orderId && l.courier === 'SLA-Escalation-Courier'
          );
          assert.ok(escalationLog);
        })
    },

    // T4-W5: Workload 5 — Batch Operations + order_report Sync + Page Reload Persistence
    {
      name: 'T4-W5 Batch operations + order_report sync + page.reload() persistence',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const todayBangkok = getBangkokDateYmd(0);
          const { rows: baseOrders } = getSheetTable(runtime, 'db_orders');
          const { rows: shippers } = getSheetTable(runtime, 'db_shippers');
          const baseOracle = computeExpectedDashboard(baseOrders, shippers);
          const beforeFormulas = getSheetFormulas(runtime, 'order_report');
          const l1Before = beforeFormulas[0]?.[11];
          const m1Before = beforeFormulas[0]?.[12];

          // 1. Create 3 Orders
          const { orderId: ord1 } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-JKT',
            address: 'Jl. Batch 1 Jakarta'
          });
          const { orderId: ord2 } = await createOrderViaUi(page, {
            shipperId: 'SHP-02',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-BDG',
            address: 'Jl. Batch 2 Bandung'
          });
          const { orderId: ord3 } = await createOrderViaUi(page, {
            shipperId: 'SHP-03',
            currentHub: 'HUB-SUB',
            destinationHub: 'HUB-SUB',
            address: 'Jl. Batch 3 Surabaya'
          });

          // 2. Batch Pickup ord1 + ord2 at HUB-JKT (leave ord3 Pending Pickup)
          await navigateToView(page, 'pickup');
          await page.locator('#pickup-hub-filter').selectOption('HUB-JKT');
          await selectQueueRow(page, '#view-pickup', ord1);
          await selectQueueRow(page, '#view-pickup', ord2);
          await page.locator('#pickup-confirm-hub').selectOption('HUB-JKT');
          await page.locator('#pickup-date').fill(todayBangkok);
          await page.locator('#pickup-courier').fill('Batch-Driver-1');
          await page.locator('#pickup-notes').fill('Batch morning pickup');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /2|transit|confirmed|picked up/i);

          await page.locator('#view-pickup table tbody tr', { hasText: ord1 }).waitFor({ state: 'hidden' });
          await page.locator('#view-pickup table tbody tr', { hasText: ord2 }).waitFor({ state: 'hidden' });
          await page.locator('#pickup-hub-filter').selectOption('HUB-SUB');
          await page.locator('#view-pickup table tbody tr', { hasText: ord3 }).first().waitFor({ state: 'visible' });

          // 3. Sort Mix: ord1 dispatch, ord2 flag return
          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-ready').click();
          await page.locator('#sort-scan-input').fill(ord1);
          await selectQueueRow(page, '#view-sort', ord1);
          await page.locator('#sort-courier').fill('Sort-Batch-A');
          await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
          await waitForToast(page, /dispatch|on shipment/i);

          await page.locator('#sort-scan-input').fill('');
          await page.locator('#sort-tab-linehaul').click();
          await page.locator('#sort-scan-input').fill(ord2);
          await selectQueueRow(page, '#view-sort', ord2);
          await page.locator('#sort-courier').fill('Sort-Batch-B');
          await page.locator('#sort-notes').fill('Hold for return inspection');
          await performRpcAction(page, () => page.locator('#btn-sort-flag-return').click());
          await waitForToast(page, /flag|return/i);

          await page.locator('#sort-tab-flagged').click();
          await page.locator('#view-sort table tbody tr', { hasText: ord2 }).first().waitFor({ state: 'visible' });

          // 4. Sync order_report
          const expectedTotal = baseOracle.totalOrders + 3;
          await performRpcAction(page, () => page.locator('#btn-sync-report').click());
          await waitForToast(page, new RegExp(`${expectedTotal}|sync`, 'i'));

          // 5. Full Page Reload Persistence
          const reloadRpc = page
            .waitForResponse(
              (res) => res.url().includes('/__gas_rpc') && res.request().method() === 'POST',
              { timeout: 15000 }
            )
            .catch(() => null);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await reloadRpc;
          await waitForViewReady(page, 'dashboard');
          await waitForKpiTotal(page, expectedTotal);

          const reloadedKpis = await readDashboardKpis(page);
          assert.equal(reloadedKpis.totalOrders, expectedTotal);
          assert.equal(reloadedKpis.activeShipments, baseOracle.activeShipments + 3);
          const expectedRetRate = ((baseOracle.returnFlagCount + 1) / expectedTotal) * 100;
          assert.ok(Math.abs(reloadedKpis.returnRate - expectedRetRate) <= 0.05);
          assert.ok(Math.abs(reloadedKpis.deliveredRate - baseOracle.deliveredRate) <= 0.05);

          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(ord3);
          await page.locator('#view-pickup table tbody tr', { hasText: ord3 }).first().waitFor({ state: 'visible' });

          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-flagged').click();
          await page.locator('#sort-scan-input').fill(ord2);
          await page.locator('#view-sort table tbody tr', { hasText: ord2 }).first().waitFor({ state: 'visible' });

          await navigateToView(page, 'delivery');
          await page.locator('#delivery-scan-input').fill(ord1);
          await page.locator('#view-delivery table tbody tr', { hasText: ord1 }).first().waitFor({ state: 'visible' });
          await page.locator('#delivery-scan-input').fill(ord2);
          await page.locator('#view-delivery table tbody tr', { hasText: ord2 }).first().waitFor({ state: 'visible' });

          // 6. Sheet Persistence Checks
          assertDbOrdersSchema10Cols(runtime);
          assert.equal(getSheetTable(runtime, 'db_orders').rows.length, expectedTotal);

          const reportTable = getSheetTable(runtime, 'order_report');
          assert.equal(reportTable.rows.length, expectedTotal);
          const afterFormulas = getSheetFormulas(runtime, 'order_report');
          assert.equal(afterFormulas[0]?.[11], l1Before);
          assert.equal(afterFormulas[0]?.[12], m1Before);

          const batchLogs = getSheetTable(runtime, 'op_logs').rows.filter(
            (l) => l.order_id === ord1 || l.order_id === ord2 || l.order_id === ord3
          );
          assert.equal(batchLogs.length, 7, 'Expected 3 creates + 2 batch pickups + 1 dispatch + 1 flag_return = 7 op_logs');
        })
    }
  ];
}

export const tier = 4;
export const title = 'Tier 4 — Real-World Multi-Step Operational Workloads';
export const tests = makeTests(null);
export function getTests(sharedBrowserGetter) {
  return makeTests(sharedBrowserGetter);
}
