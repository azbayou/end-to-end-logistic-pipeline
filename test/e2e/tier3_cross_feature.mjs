import assert from 'node:assert/strict';
import {
  assertDbOrdersSchema10Cols,
  appendOrderToSnapshot,
  clickQuickJumpAction,
  computeExpectedDashboard,
  createOrderViaUi,
  deleteSnapshotSheet,
  EXPECTED_OP_LOG_HEADERS,
  getBangkokDateYmd,
  getHighAgingTable,
  getSheetFormulas,
  getSheetTable,
  gotoApp,
  HUB_NAMES,
  navigateToView,
  normalizeYmd,
  performRpcAction,
  readDashboardKpis,
  selectQueueRow,
  waitForFeedback,
  waitForKpiTotal,
  waitForToast,
  waitForViewReady,
  withTestSession
} from './helpers.mjs';

function makeTests(sharedBrowserGetter) {
  const runSession = (opts, fn) =>
    withTestSession({ ...opts, sharedBrowser: sharedBrowserGetter?.() || null }, fn);

  return [
    // T3-01: Input Data -> Immediate Pickup Queue Visibility & Dashboard KPI Increment
    {
      name: 'T3-01 [F-01, F-11, F-13, F-20] Input Data -> Pickup Queue visibility & Dashboard KPI increment',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const { rows: baseOrders } = getSheetTable(runtime, 'db_orders');
          const { rows: shippers } = getSheetTable(runtime, 'db_shippers');
          const baseOracle = computeExpectedDashboard(baseOrders, shippers);
          const base = await readDashboardKpis(page);
          assert.equal(base.totalOrders, baseOracle.totalOrders);
          assert.equal(base.activeShipments, baseOracle.activeShipments);

          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-BDG',
            address: 'Jl. Sudirman Kav 52, Bandung',
            courier: 'Budi-IN',
            notes: 'T3-01 fragile electronics'
          });

          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderId);
          const pickupRow = page.locator('#view-pickup table tbody tr', { hasText: orderId }).first();
          await pickupRow.waitFor({ state: 'visible' });
          const rowText = await pickupRow.innerText();
          assert.match(rowText, /Pending Pickup/);
          assert.match(rowText, /PT Toko Maju/);

          await navigateToView(page, 'dashboard');
          await waitForKpiTotal(page, base.totalOrders + 1);
          const updated = await readDashboardKpis(page);
          assert.equal(updated.totalOrders, base.totalOrders + 1);
          assert.equal(updated.activeShipments, base.activeShipments + 1);
          assert.ok(Math.abs(updated.deliveredRate - base.deliveredRate) <= 0.05);
        })
    },

    // T3-02: Pickup -> Sort Queue Split (#sort-tab-ready vs #sort-tab-linehaul)
    {
      name: 'T3-02 [F-13, F-14, F-15, F-20] Pickup -> Sort Queue split (Ready vs Linehaul)',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const todayBangkok = getBangkokDateYmd(0);
          const { orderId: orderA } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-JKT',
            address: 'Jl. Thamrin No. 8, Jakarta'
          });
          const { orderId: orderB } = await createOrderViaUi(page, {
            shipperId: 'SHP-02',
            currentHub: 'HUB-BDG',
            destinationHub: 'HUB-SUB',
            address: 'Jl. Basuki Rahmat No. 12, Surabaya'
          });

          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderA);
          await selectQueueRow(page, '#view-pickup', orderA);
          await page.locator('#pickup-confirm-hub').selectOption('HUB-JKT');
          await page.locator('#pickup-date').fill(todayBangkok);
          await page.locator('#pickup-courier').fill('Driver-A');
          await page.locator('#pickup-notes').fill('Pickup intra');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|picked up|confirmed|1/i);
          await page.locator('#view-pickup table tbody tr', { hasText: orderA }).waitFor({ state: 'hidden' });

          await page.locator('#pickup-scan-input').fill(orderB);
          await selectQueueRow(page, '#view-pickup', orderB);
          await page.locator('#pickup-confirm-hub').selectOption('HUB-BDG');
          await page.locator('#pickup-date').fill(todayBangkok);
          await page.locator('#pickup-courier').fill('Driver-B');
          await page.locator('#pickup-notes').fill('Pickup linehaul');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|picked up|confirmed|1/i);
          await page.locator('#view-pickup table tbody tr', { hasText: orderB }).waitFor({ state: 'hidden' });

          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-ready').click();
          await page.locator('#sort-scan-input').fill(orderA);
          await page.locator('#view-sort table tbody tr', { hasText: orderA }).first().waitFor({ state: 'visible' });
          await page.locator('#sort-scan-input').fill(orderB);
          assert.equal(await page.locator('#view-sort table tbody tr', { hasText: orderB }).count(), 0);

          await page.locator('#sort-scan-input').fill('');
          await page.locator('#sort-tab-linehaul').click();
          await page.locator('#sort-scan-input').fill(orderB);
          await page.locator('#view-sort table tbody tr', { hasText: orderB }).first().waitFor({ state: 'visible' });
          await page.locator('#sort-scan-input').fill(orderA);
          assert.equal(await page.locator('#view-sort table tbody tr', { hasText: orderA }).count(), 0);

          const dbOrders = getSheetTable(runtime, 'db_orders').rows;
          const rowA = dbOrders.find((r) => r.order_id === orderA);
          const rowB = dbOrders.find((r) => r.order_id === orderB);
          assert.equal(rowA.status, 'Transit');
          assert.equal(normalizeYmd(rowA.inbound_date), todayBangkok);
          assert.equal(rowB.status, 'Transit');
          assert.equal(normalizeYmd(rowB.inbound_date), todayBangkok);
        })
    },

    // T3-03: Sort Flag Return -> #sort-tab-flagged & Delivery Queue -> Mark Returned -> Dashboard Rates
    {
      name: 'T3-03 [F-01, F-15..F-18] Sort Flag Return -> Delivery Mark Returned -> Dashboard rates update',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const todayBangkok = getBangkokDateYmd(0);
          const { rows: baseOrders } = getSheetTable(runtime, 'db_orders');
          const { rows: shippers } = getSheetTable(runtime, 'db_shippers');
          const baseOracle = computeExpectedDashboard(baseOrders, shippers);

          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-BDG',
            address: 'Jl. Braga No. 9, Bandung'
          });

          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-pickup', orderId);
          await page.locator('#pickup-courier').fill('Driver-C');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|confirmed|picked up|1/i);

          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-linehaul').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await page.locator('#sort-courier').fill('Sorter-1');
          await page.locator('#sort-notes').fill('Damaged packaging at hub');
          await performRpcAction(page, () => page.locator('#btn-sort-flag-return').click());
          await waitForToast(page, /flag|return/i);

          await page.locator('#sort-tab-flagged').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await page.locator('#view-sort table tbody tr', { hasText: orderId }).first().waitFor({ state: 'visible' });

          await navigateToView(page, 'dashboard');
          await waitForKpiTotal(page, baseOracle.totalOrders + 1);
          const midKpis = await readDashboardKpis(page);
          const expectedMidRetRate = ((baseOracle.returnFlagCount + 1) / (baseOracle.totalOrders + 1)) * 100;
          assert.ok(Math.abs(midKpis.returnRate - expectedMidRetRate) <= 0.05);
          assert.ok(Math.abs(midKpis.deliveredRate - baseOracle.deliveredRate) <= 0.05);

          await navigateToView(page, 'delivery');
          await page.locator('#delivery-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-delivery', orderId);
          await page.locator('#delivery-date').fill(todayBangkok);
          await page.locator('#delivery-courier').fill('RTS-Driver');
          await page.locator('#delivery-notes').fill('Returned to shipper warehouse');
          await performRpcAction(page, () => page.locator('#btn-delivery-returned').click());
          await waitForToast(page, /returned/i);
          await page.locator('#view-delivery table tbody tr', { hasText: orderId }).waitFor({ state: 'hidden' });

          await navigateToView(page, 'dashboard');
          await waitForKpiTotal(page, baseOracle.totalOrders + 1);
          const finalKpis = await readDashboardKpis(page);
          const expectedFinalDelivRate =
            (baseOracle.deliveredCount / (baseOracle.closedCount + 1)) * 100;
          assert.equal(finalKpis.activeShipments, baseOracle.activeShipments);
          assert.ok(Math.abs(finalKpis.returnRate - expectedMidRetRate) <= 0.05);
          assert.ok(Math.abs(finalKpis.deliveredRate - expectedFinalDelivRate) <= 0.05);

          const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === orderId);
          assert.equal(row.status, 'Returned');
          assert.equal(Number(row.return_flag), 1);
          assert.equal(normalizeYmd(row.end_date), todayBangkok);
        })
    },

    // T3-04: Delivery Failed RTS -> Transit (return_flag=1) in #sort-tab-flagged -> Mark Returned
    {
      name: 'T3-04 [F-15, F-17, F-18, F-22] Delivery Failed RTS -> Sort Flagged -> Mark Returned',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const todayBangkok = getBangkokDateYmd(0);
          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-JKT',
            address: 'Jl. Gatot Subroto No. 45'
          });

          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-pickup', orderId);
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|confirmed|picked up|1/i);

          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-ready').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await page.locator('#sort-courier').fill('Dispatcher-1');
          await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
          await waitForToast(page, /dispatch|on shipment/i);

          await navigateToView(page, 'delivery');
          await page.locator('#delivery-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-delivery', orderId);
          await page.locator('#delivery-courier').fill('Courier-Fail');
          await page.locator('#delivery-notes').fill('Recipient moved / RTS');
          await performRpcAction(page, () => page.locator('#btn-delivery-failed-rts').click());
          await waitForToast(page, /rts|transit|return/i);

          const midRow = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === orderId);
          assert.equal(midRow.status, 'Transit');
          assert.equal(Number(midRow.return_flag), 1);
          assert.equal(midRow.end_date, '');

          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-flagged').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await page.locator('#view-sort table tbody tr', { hasText: orderId }).first().waitFor({ state: 'visible' });

          await navigateToView(page, 'delivery');
          await page.locator('#delivery-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-delivery', orderId);
          await page.locator('#delivery-date').fill(todayBangkok);
          await page.locator('#delivery-courier').fill('RTS-Closer');
          await page.locator('#delivery-notes').fill('Shipper signed return POD');
          await performRpcAction(page, () => page.locator('#btn-delivery-returned').click());
          await waitForToast(page, /returned/i);

          const finalRow = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === orderId);
          assert.equal(finalRow.status, 'Returned');
          assert.equal(Number(finalRow.return_flag), 1);
          assert.equal(normalizeYmd(finalRow.end_date), todayBangkok);
          assert.equal(await page.locator('#view-delivery table tbody tr', { hasText: orderId }).count(), 0);
        })
    },

    // T3-05: #btn-sync-report updates order_report!A2:K with normalized shippers & preserves L1:M1
    {
      name: 'T3-05 [F-10, F-21] #btn-sync-report updates order_report!A2:K & preserves L1:M1 ARRAYFORMULA',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-260825-9526',
                resi: 'RS-95260001',
                shipper_id: 'SHP-003',
                status: 'Delivered',
                current_hub: 'HUB-BDG',
                destination_hub: 'HUB-JKT',
                destination_address: 'Jl. Legacy SHP003 Sync',
                inbound_date: '2026-08-25',
                end_date: '2026-08-27'
              });
            }
          },
          async ({ page, runtime }) => {
            const beforeOrdersCount = getSheetTable(runtime, 'db_orders').rows.length;
            const beforeFormulas = getSheetFormulas(runtime, 'order_report');
            const l1Before = beforeFormulas[0]?.[11];
            const m1Before = beforeFormulas[0]?.[12];

            const { orderId: newOrderId } = await createOrderViaUi(page, {
              shipperId: 'SHP-04',
              currentHub: 'HUB-SUB',
              destinationHub: 'HUB-JKT',
              address: 'Jl. Pemuda No. 1, Jakarta'
            });

            const expectedSyncCount = beforeOrdersCount + 1;
            await performRpcAction(page, () => page.locator('#btn-sync-report').click());
            await waitForToast(page, new RegExp(`${expectedSyncCount}|sync`, 'i'));

            const reportTable = getSheetTable(runtime, 'order_report');
            assert.equal(reportTable.rows.length, expectedSyncCount);

            const syncedNew = reportTable.rows.find((r) => r.order_id === newOrderId);
            assert.ok(syncedNew);
            assert.equal(syncedNew.status, 'Pending Pickup');
            assert.equal(syncedNew.shipper_name, 'PT Mencari Cinta Sejati');
            assert.equal(syncedNew.pickup_address, 'Jl. Jalan aja ga tau mau kemana, Surabaya');

            const legacyDbRow = getSheetTable(runtime, 'db_orders').rows.find(
              (r) => r.order_id === 'ORD-260825-9526'
            );
            assert.equal(legacyDbRow.shipper_id, 'SHP-003');

            const legacyReportRow = reportTable.rows.find((r) => r.order_id === 'ORD-260825-9526');
            assert.equal(legacyReportRow.shipper_name, 'PT Maju Jaya Sejahtera');
            assert.ok(String(legacyReportRow.pickup_address || '').length > 0);
            assert.equal(legacyReportRow.current_hub_location, HUB_NAMES['HUB-BDG']);
            assert.equal(legacyReportRow.destination_hub_location, HUB_NAMES['HUB-JKT']);

            const afterFormulas = getSheetFormulas(runtime, 'order_report');
            assert.equal(afterFormulas[0]?.[11], l1Before);
            assert.equal(afterFormulas[0]?.[12], m1Before);
          }
        )
    },

    // T3-06: High Aging Monitoring Table Quick-Jump -> Sort / Delivery with Target Order Context
    {
      name: 'T3-06 [F-09, F-15, F-17, F-20] High Aging table quick-jump navigates to Sort/Delivery with target context',
      fn: () =>
        runSession({ view: 'input' }, async ({ page }) => {
          const oldInbound = getBangkokDateYmd(-12);

          const { orderId: orderTransitSla } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-JKT',
            address: 'Jl. Aging Transit 12d'
          });
          const { orderId: orderDeliverySla } = await createOrderViaUi(page, {
            shipperId: 'SHP-02',
            currentHub: 'HUB-BDG',
            destinationHub: 'HUB-BDG',
            address: 'Jl. Aging Delivery 12d'
          });

          await navigateToView(page, 'pickup');
          await selectQueueRow(page, '#view-pickup', orderTransitSla);
          await selectQueueRow(page, '#view-pickup', orderDeliverySla);
          await page.locator('#pickup-date').fill(oldInbound);
          await page.locator('#pickup-courier').fill('AgingPickup');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /2|transit|confirmed|picked up/i);

          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-ready').click();
          await selectQueueRow(page, '#view-sort', orderDeliverySla);
          await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
          await waitForToast(page, /dispatch|on shipment/i);

          await navigateToView(page, 'dashboard');
          const table = await getHighAgingTable(page);
          const transitRow = table.locator('tbody tr', { hasText: orderTransitSla }).first();
          await transitRow.waitFor({ state: 'visible' });
          assert.match(await transitRow.innerText(), /Over SLA|12/i);

          await clickQuickJumpAction(transitRow);
          await waitForViewReady(page, 'sort');
          assert.equal(await page.locator('#view-sort').isVisible(), true);
          const sortContent = `${await page.locator('#sort-scan-input').inputValue()} ${await page.locator('#view-sort').innerText()}`;
          assert.ok(sortContent.includes(orderTransitSla));

          await navigateToView(page, 'dashboard');
          const delivRow = (await getHighAgingTable(page)).locator('tbody tr', { hasText: orderDeliverySla }).first();
          await delivRow.waitFor({ state: 'visible' });
          await clickQuickJumpAction(delivRow);
          await waitForViewReady(page, 'delivery');
          assert.equal(await page.locator('#view-delivery').isVisible(), true);
          const delivContent = `${await page.locator('#delivery-scan-input').inputValue()} ${await page.locator('#view-delivery').innerText()}`;
          assert.ok(delivContent.includes(orderDeliverySla));
        })
    },

    // T3-07: op_logs Auto-Creation & Sequential Audit Entries Across Full 5-Step Lifecycle
    {
      name: 'T3-07 [F-19, F-21, F-22] op_logs auto-creation & 5 sequential entries across full lifecycle',
      fn: () =>
        runSession(
          {
            view: 'input',
            mutateSnapshot: (snap) => {
              deleteSnapshotSheet(snap, 'op_logs');
            }
          },
          async ({ page, runtime }) => {
            assert.equal(getSheetTable(runtime, 'op_logs').exists, false);

            const { orderId } = await createOrderViaUi(page, {
              shipperId: 'SHP-02',
              currentHub: 'HUB-BDG',
              destinationHub: 'HUB-JKT',
              address: 'Jl. Merdeka Barat No. 3',
              courier: 'Intake-Op',
              notes: 'Note 1: created'
            });

            await navigateToView(page, 'pickup');
            await page.locator('#pickup-scan-input').fill(orderId);
            await selectQueueRow(page, '#view-pickup', orderId);
            await page.locator('#pickup-confirm-hub').selectOption('HUB-BDG');
            await page.locator('#pickup-courier').fill('Driver-Pick');
            await page.locator('#pickup-notes').fill('Note 2: picked up');
            await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(page, /transit|confirmed|picked up|1/i);

            await navigateToView(page, 'sort');
            await page.locator('#sort-tab-linehaul').click();
            await page.locator('#sort-scan-input').fill(orderId);
            await selectQueueRow(page, '#view-sort', orderId);
            await page.locator('#sort-target-hub').selectOption('HUB-JKT');
            await page.locator('#sort-courier').fill('Linehaul-Truck');
            await page.locator('#sort-notes').fill('Note 3: arrived JKT');
            await performRpcAction(page, () => page.locator('#btn-sort-transfer').click());
            await waitForToast(page, /transfer|hub|transit/i);

            await page.locator('#sort-tab-ready').click();
            await page.locator('#sort-scan-input').fill(orderId);
            await selectQueueRow(page, '#view-sort', orderId);
            await page.locator('#sort-courier').fill('Dispatcher-JKT');
            await page.locator('#sort-notes').fill('Note 4: out for delivery');
            await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
            await waitForToast(page, /dispatch|on shipment/i);

            await navigateToView(page, 'delivery');
            await page.locator('#delivery-scan-input').fill(orderId);
            await selectQueueRow(page, '#view-delivery', orderId);
            await page.locator('#delivery-courier').fill('Rider-POD');
            await page.locator('#delivery-notes').fill('Note 5: signed by Budi');
            await performRpcAction(page, () => page.locator('#btn-delivery-delivered').click());
            await waitForToast(page, /delivered/i);

            const logsTable = getSheetTable(runtime, 'op_logs');
            assert.equal(logsTable.exists, true);
            assert.deepEqual(logsTable.headers.slice(0, 10), EXPECTED_OP_LOG_HEADERS);

            const logs = logsTable.rows.filter((l) => l.order_id === orderId);
            assert.equal(logs.length, 5);
            assert.equal(logs[0].to_status, 'Pending Pickup');
            assert.equal(logs[0].courier, 'Intake-Op');
            assert.equal(logs[0].notes, 'Note 1: created');

            assert.equal(logs[1].from_status, 'Pending Pickup');
            assert.equal(logs[1].to_status, 'Transit');
            assert.equal(logs[1].courier, 'Driver-Pick');

            assert.equal(logs[2].from_status, 'Transit');
            assert.equal(logs[2].to_status, 'Transit');
            assert.equal(logs[2].current_hub, 'HUB-JKT');
            assert.equal(logs[2].courier, 'Linehaul-Truck');

            assert.equal(logs[3].from_status, 'Transit');
            assert.equal(logs[3].to_status, 'On Shipment');
            assert.equal(logs[3].courier, 'Dispatcher-JKT');

            assert.equal(logs[4].from_status, 'On Shipment');
            assert.equal(logs[4].to_status, 'Delivered');
            assert.equal(logs[4].courier, 'Rider-POD');

            for (const entry of logs) {
              assert.ok(String(entry.log_id || '').length > 0);
              assert.ok(String(entry.timestamp || '').length > 0);
              assert.ok(String(entry.operator_email || '').length > 0);
            }
            assertDbOrdersSchema10Cols(runtime);
          }
        )
    },

    // T3-08: ?view=... Deep-Linking & #btn-refresh-all State Reload across tabs
    {
      name: 'T3-08 [F-10, F-20] ?view= deep-linking & cross-tab #btn-refresh-all state reload',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page: page1, openExtraPage, baseUrl, runtime }) => {
          const baseTotal = getSheetTable(runtime, 'db_orders').rows.length;
          const allViews = ['input', 'pickup', 'sort', 'delivery', 'dashboard'];

          for (const viewName of allViews) {
            await gotoApp(page1, `${baseUrl}/?view=${viewName}`, viewName);
            for (const checkView of allViews) {
              assert.equal(await page1.locator(`#view-${checkView}`).isVisible(), checkView === viewName);
            }
          }

          await gotoApp(page1, `${baseUrl}/?view=pickup`, 'pickup');
          const page2 = await openExtraPage('input');
          const { orderId } = await createOrderViaUi(page2, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-BDG',
            address: 'Jl. Deep Link No. 10'
          });

          assert.equal(await page1.locator('#view-pickup table tbody tr', { hasText: orderId }).count(), 0);
          await performRpcAction(page1, () => page1.locator('#btn-refresh-all').click());
          await page1.locator('#view-pickup table tbody tr', { hasText: orderId }).first().waitFor({ state: 'visible' });

          await navigateToView(page1, 'dashboard');
          await waitForKpiTotal(page1, baseTotal + 1);
        })
    },

    // T3-09: Dashboard Multi-Dimensional Filters Reflect Cross-Page Mutations Live
    {
      name: 'T3-09 [F-01, F-02, F-04, F-06, F-08] Dashboard combined filters reflect cross-page created/inbounded order',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const baseTotal = getSheetTable(runtime, 'db_orders').rows.length;
          const today = getBangkokDateYmd(0);

          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-04',
            currentHub: 'HUB-SUB',
            destinationHub: 'HUB-BDG',
            address: 'Jl. Dago No. 88, Bandung'
          });

          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-pickup', orderId);
          await page.locator('#pickup-date').fill(today);
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|confirmed|picked up|1/i);

          await navigateToView(page, 'dashboard');
          await page.locator('#filter-hub').selectOption('HUB-SUB');
          await page.locator('#filter-status').selectOption('Transit');
          await page.locator('#filter-shipper').selectOption('SHP-04');
          await page.locator('#filter-sla').selectOption('Under SLA');
          await page.locator('#filter-search').fill(orderId);
          await waitForKpiTotal(page, 1);

          const filteredKpis = await readDashboardKpis(page);
          assert.equal(filteredKpis.totalOrders, 1);
          assert.equal(filteredKpis.activeShipments, 1);
          assert.equal(filteredKpis.returnRate, 0);
          assert.equal(filteredKpis.deliveredRate, 0);

          await page.locator('#btn-reset-filters').click();
          await waitForKpiTotal(page, baseTotal + 1);
        })
    },

    // T3-10: Cross-Tab Optimistic Precondition Guard & #btn-refresh-all Recovery
    {
      name: 'T3-10 [F-14, F-19, F-20] Cross-tab optimistic precondition guard & #btn-refresh-all recovery',
      fn: () =>
        runSession(
          { view: 'input', allowConsoleErrors: true },
          async ({ page: page1, openExtraPage, baseUrl, runtime }) => {
            const { orderId } = await createOrderViaUi(page1, {
              shipperId: 'SHP-01',
              currentHub: 'HUB-JKT',
              destinationHub: 'HUB-BDG',
              address: 'Jl. Concurrency Recovery 10'
            });

            await gotoApp(page1, `${baseUrl}/?view=pickup`, 'pickup');
            const page2 = await openExtraPage('pickup');

            await page1.locator('#pickup-scan-input').fill(orderId);
            await selectQueueRow(page1, '#view-pickup', orderId);
            await performRpcAction(page1, () => page1.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(page1, /transit|confirmed|picked up|1/i);

            await page2.locator('#pickup-scan-input').fill(orderId);
            await selectQueueRow(page2, '#view-pickup', orderId);
            await performRpcAction(page2, () => page2.locator('#btn-confirm-pickup-batch').click());
            await waitForFeedback(page2, /already|skip|status|conflict|no .*updated|0|error/i);

            await performRpcAction(page2, () => page2.locator('#btn-refresh-all').click());
            await page2.locator('#view-pickup table tbody tr', { hasText: orderId }).waitFor({ state: 'hidden' });

            const pickupLogs = getSheetTable(runtime, 'op_logs').rows.filter(
              (l) => l.order_id === orderId && l.to_status === 'Transit'
            );
            assert.equal(pickupLogs.length, 1);
          }
        )
    }
  ];
}

export const tier = 3;
export const title = 'Tier 3 — Cross-Feature Combinations';
export const tests = makeTests(null);
export function getTests(sharedBrowserGetter) {
  return makeTests(sharedBrowserGetter);
}
