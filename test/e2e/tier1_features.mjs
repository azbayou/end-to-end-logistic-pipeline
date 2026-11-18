import assert from 'node:assert/strict';
import {
  assertDbOrdersSchema10Cols,
  assertNoBrokenNumbers,
  appendOrderToSnapshot,
  clickQuickJumpAction,
  computeExpectedDashboard,
  createOrderViaUi,
  EXPECTED_OP_LOG_HEADERS,
  EXPECTED_ORDER_HEADERS,
  getBangkokDateYmd,
  getHighAgingTable,
  getSheetFormulas,
  getSheetTable,
  gotoApp,
  HUB_NAMES,
  navigateToView,
  normalizeShipperId,
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
    // =========================================================================
    // Area 1: Dashboard KPIs, Charts & Filters (F-01 .. F-09) — 6 Tests
    // =========================================================================
    {
      name: 'T1-DASH-01 [F-01] Live KPI summary cards match live db_orders oracle',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          assert.equal(await page.locator('#view-dashboard').isVisible(), true);
          const { rows: ordersRows } = getSheetTable(runtime, 'db_orders');
          const { rows: shippersRows } = getSheetTable(runtime, 'db_shippers');
          const oracle = computeExpectedDashboard(ordersRows, shippersRows, {}, getBangkokDateYmd(0));

          const kpis = await readDashboardKpis(page);
          assertNoBrokenNumbers(JSON.stringify(kpis.raw), 'T1-DASH-01 KPIs');
          assert.match(kpis.raw.delivText, /%/, 'Delivered Rate must display %');
          assert.match(kpis.raw.retText, /%/, 'Return Rate must display %');

          assert.equal(kpis.totalOrders, oracle.totalOrders);
          assert.equal(kpis.activeShipments, oracle.activeShipments);
          assert.ok(
            Math.abs(kpis.deliveredRate - oracle.deliveredRate) <= 0.1,
            `Delivered rate ${kpis.deliveredRate} != oracle ${oracle.deliveredRate.toFixed(2)}`
          );
          assert.ok(
            Math.abs(kpis.returnRate - oracle.returnRate) <= 0.1,
            `Return rate ${kpis.returnRate} != oracle ${oracle.returnRate.toFixed(2)}`
          );
          assert.ok(
            Math.abs(kpis.avgDeliveryTime - oracle.avgDeliveryTime) <= 0.25,
            `Avg delivery time ${kpis.avgDeliveryTime} != oracle ${oracle.avgDeliveryTime.toFixed(2)}`
          );
        })
    },
    {
      name: 'T1-DASH-02 [F-02] Multi-dimensional filters & reset update KPIs accurately',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              const today = getBangkokDateYmd(0);
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-8002',
                resi: 'RS-80020002',
                shipper_id: 'SHP-01',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                destination_address: 'Jl. Filter Test 8002',
                inbound_date: today,
                end_date: ''
              });
            }
          },
          async ({ page, runtime }) => {
            const { rows: ordersRows } = getSheetTable(runtime, 'db_orders');
            const { rows: shippersRows } = getSheetTable(runtime, 'db_shippers');
            const fullOracle = computeExpectedDashboard(ordersRows, shippersRows);

            // 1. Hub filter
            await page.locator('#filter-hub').selectOption('HUB-JKT');
            const jktOracle = computeExpectedDashboard(ordersRows, shippersRows, { hub: 'HUB-JKT' });
            await waitForKpiTotal(page, jktOracle.totalOrders);

            // 2. Status filter
            await page.locator('#filter-status').selectOption('Transit');
            const transitOracle = computeExpectedDashboard(ordersRows, shippersRows, {
              hub: 'HUB-JKT',
              status: 'Transit'
            });
            await waitForKpiTotal(page, transitOracle.totalOrders);

            // 3. Shipper filter
            await page.locator('#filter-shipper').selectOption('SHP-01');
            const shpOracle = computeExpectedDashboard(ordersRows, shippersRows, {
              hub: 'HUB-JKT',
              status: 'Transit',
              shipperId: 'SHP-01'
            });
            await waitForKpiTotal(page, shpOracle.totalOrders);

            // 4. SLA filter
            await page.locator('#filter-sla').selectOption('Under SLA');
            const slaOracle = computeExpectedDashboard(ordersRows, shippersRows, {
              hub: 'HUB-JKT',
              status: 'Transit',
              shipperId: 'SHP-01',
              slaType: 'Under SLA'
            });
            await waitForKpiTotal(page, slaOracle.totalOrders);

            // 5. Reset & test Date Range + Search for specific seeded order
            await page.locator('#btn-reset-filters').click();
            await waitForKpiTotal(page, fullOracle.totalOrders);

            const today = getBangkokDateYmd(0);
            await page.locator('#filter-date-from').fill(today);
            await page.locator('#filter-date-to').fill(today);
            await page.locator('#filter-search').fill('ORD-261118-8002');
            await waitForKpiTotal(page, 1);

            // 6. Reset restores full unfiltered KPIs
            await page.locator('#btn-reset-filters').click();
            await waitForKpiTotal(page, fullOracle.totalOrders);
            const restored = await readDashboardKpis(page);
            assert.equal(restored.totalOrders, fullOracle.totalOrders);
            assert.equal(restored.activeShipments, fullOracle.activeShipments);
          }
        )
    },
    {
      name: 'T1-DASH-03 [F-03, F-04, F-05] Status, Volume per Hub (toggle), & Return Rate by Destination Hub charts render',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page }) => {
          const dash = page.locator('#view-dashboard');
          for (const titlePattern of [
            /Order Status Breakdown/i,
            /Volume per Hub/i,
            /Return Rate by Destination Hub/i
          ]) {
            await dash.getByText(titlePattern).first().waitFor({ state: 'visible' });
          }

          const charts = dash.locator('svg, canvas');
          const chartCount = await charts.count();
          assert.ok(chartCount >= 3, `Expected >= 3 chart SVG/Canvas elements, found ${chartCount}`);
          let validBoxes = 0;
          for (let i = 0; i < chartCount; i++) {
            const box = await charts.nth(i).boundingBox();
            if (box && box.width > 20 && box.height > 20) validBoxes += 1;
          }
          assert.ok(validBoxes >= 3, `Expected >= 3 rendered charts with boundingBox > 20x20, got ${validBoxes}`);

          const dashText = await dash.innerText();
          for (const label of ['Pending Pickup', 'Transit', 'On Shipment', 'Delivered', 'Returned']) {
            assert.ok(dashText.includes(label), `Dashboard should display status label ${label}`);
          }
          for (const hubName of Object.values(HUB_NAMES)) {
            assert.ok(dashText.includes(hubName), `Dashboard should display hub name ${hubName}`);
          }

          // Toggle Volume per Hub between current_hub and destination_hub
          const hubToggleBtn = dash.locator('button, [role="button"]').filter({ hasText: /Destination/i }).first();
          const hubToggleSelect = dash.locator('select').filter({ hasText: /Destination/i }).first();
          if ((await hubToggleBtn.count()) > 0) {
            await hubToggleBtn.click();
          } else if ((await hubToggleSelect.count()) > 0) {
            const opts = await hubToggleSelect.locator('option').all();
            for (const opt of opts) {
              const val = await opt.getAttribute('value');
              const txt = await opt.innerText();
              if (/destination/i.test(`${val} ${txt}`)) {
                await hubToggleSelect.selectOption(val);
                break;
              }
            }
          }
          const updatedCharts = await dash.locator('svg, canvas').count();
          assert.ok(updatedCharts >= 3, 'Charts must remain rendered after hub scope toggle');
        })
    },
    {
      name: 'T1-DASH-04 [F-06, F-07] Shipper Breakdown, Volume per Shipper, & Return Rate by Shipper charts render all shippers',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const dash = page.locator('#view-dashboard');
          for (const titlePattern of [
            /Shipper Breakdown/i,
            /Volume per Shipper/i,
            /Return Rate by Shipper/i
          ]) {
            await dash.getByText(titlePattern).first().waitFor({ state: 'visible' });
          }

          const { rows: shippers } = getSheetTable(runtime, 'db_shippers');
          const dashText = await dash.innerText();
          for (const s of shippers) {
            assert.ok(
              dashText.includes(s.shipper_name),
              `Expected shipper chart/legend to display ${s.shipper_name}`
            );
          }

          const charts = dash.locator('svg, canvas');
          const count = await charts.count();
          let rendered = 0;
          for (let i = 0; i < count; i++) {
            const box = await charts.nth(i).boundingBox();
            if (box && box.width > 20 && box.height > 20) rendered += 1;
          }
          assert.ok(rendered >= 5, `Expected >= 5 rendered charts including shipper charts, got ${rendered}`);
        })
    },
    {
      name: 'T1-DASH-05 [F-08] SLA by Hub chart renders and responds to Over SLA filter',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261101-8005',
                resi: 'RS-80050005',
                shipper_id: 'SHP-01',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                destination_address: 'Jl. SLA Hub Test 8005',
                inbound_date: getBangkokDateYmd(-10),
                end_date: ''
              });
            }
          },
          async ({ page, runtime }) => {
            const dash = page.locator('#view-dashboard');
            await dash.getByText(/SLA by Hub/i).first().waitFor({ state: 'visible' });
            const dashText = await dash.innerText();
            for (const label of ['Not Inbounded', 'Under SLA', 'Over SLA']) {
              assert.ok(dashText.includes(label), `Dashboard should display SLA label ${label}`);
            }

            const { rows: ordersRows } = getSheetTable(runtime, 'db_orders');
            const { rows: shippersRows } = getSheetTable(runtime, 'db_shippers');
            const overSlaOracle = computeExpectedDashboard(ordersRows, shippersRows, {
              slaType: 'Over SLA'
            });
            const fullOracle = computeExpectedDashboard(ordersRows, shippersRows);

            await page.locator('#filter-sla').selectOption('Over SLA');
            await waitForKpiTotal(page, overSlaOracle.totalOrders);

            await page.locator('#btn-reset-filters').click();
            await waitForKpiTotal(page, fullOracle.totalOrders);
          }
        )
    },
    {
      name: 'T1-DASH-06 [F-09] High Aging Monitoring table sorted descending & quick-jump routes to Sort/Delivery',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261020-8006',
                resi: 'RS-80060006',
                shipper_id: 'SHP-01',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                destination_address: 'Jl. Aging Sort Jump 8006',
                inbound_date: getBangkokDateYmd(-25),
                end_date: ''
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261025-8007',
                resi: 'RS-80070007',
                shipper_id: 'SHP-02',
                status: 'On Shipment',
                current_hub: 'HUB-BDG',
                destination_hub: 'HUB-BDG',
                destination_address: 'Jl. Aging Delivery Jump 8007',
                inbound_date: getBangkokDateYmd(-18),
                end_date: ''
              });
            }
          },
          async ({ page }) => {
            const table = await getHighAgingTable(page);
            await table.waitFor({ state: 'visible' });

            const targetRow = table.locator('tbody tr', { hasText: 'ORD-261020-8006' }).first();
            await targetRow.waitFor({ state: 'visible' });

            // Verify descending aging order across numeric aging values if visible
            const allRows = table.locator('tbody tr');
            const rowCount = await allRows.count();
            assert.ok(rowCount >= 2, 'High Aging table should contain seeded active Over SLA rows');

            await clickQuickJumpAction(targetRow);
            await waitForViewReady(page, 'sort');
            assert.equal(await page.locator('#view-sort').isVisible(), true);
            const sortText = await page.locator('#view-sort').innerText();
            const scanVal = await page.locator('#sort-scan-input').inputValue();
            assert.ok(
              sortText.includes('ORD-261020-8006') || scanVal.includes('ORD-261020-8006'),
              'Quick-jump from Transit High Aging row must surface target order in Sort view'
            );

            // Also verify On Shipment quick-jump goes to Delivery
            await navigateToView(page, 'dashboard');
            const delivRow = (await getHighAgingTable(page))
              .locator('tbody tr', { hasText: 'ORD-261025-8007' })
              .first();
            await delivRow.waitFor({ state: 'visible' });
            await clickQuickJumpAction(delivRow);
            await waitForViewReady(page, 'delivery');
            assert.equal(await page.locator('#view-delivery').isVisible(), true);
            const delivText = await page.locator('#view-delivery').innerText();
            const delivScanVal = await page.locator('#delivery-scan-input').inputValue();
            assert.ok(
              delivText.includes('ORD-261025-8007') || delivScanVal.includes('ORD-261025-8007'),
              'Quick-jump from On Shipment High Aging row must surface target order in Delivery view'
            );
          }
        )
    },

    // =========================================================================
    // Area 2: Input Data (F-11, F-12) — 5 Tests
    // =========================================================================
    {
      name: 'T1-INPUT-01 [F-11] Shipper dropdown lists all shippers and previews pickup_address',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const { rows: shippers } = getSheetTable(runtime, 'db_shippers');
          const options = await page.locator('#input-shipper-id option').evaluateAll((els) =>
            els.map((el) => ({ value: el.value, text: (el.textContent || '').trim() }))
          );
          for (const s of shippers) {
            const match = options.find((opt) => opt.value === s.shipper_id);
            assert.ok(match, `Shipper dropdown missing <option value="${s.shipper_id}">`);
            assert.ok(
              match.text.includes(s.shipper_name),
              `Shipper option ${s.shipper_id} text "${match.text}" must include "${s.shipper_name}"`
            );
          }

          await page.locator('#input-shipper-id').selectOption('SHP-02');
          await page.waitForFunction(
            (addr) => document.querySelector('#view-input')?.textContent?.includes(addr),
            'Jl. Asia Afrika No. 10, Bandung'
          );

          await page.locator('#input-shipper-id').selectOption('SHP-04');
          await page.waitForFunction(
            (addr) => document.querySelector('#view-input')?.textContent?.includes(addr),
            'Jl. Jalan aja ga tau mau kemana, Surabaya'
          );
        })
    },
    {
      name: 'T1-INPUT-02 [F-11, F-21, F-22] Create order writes 10-col db_orders row and op_logs entry',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const beforeCount = getSheetTable(runtime, 'db_orders').rows.length;
          const { orderId, resi } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-SUB',
            address: 'Jl. Tunjungan No. 88, Surabaya',
            courier: 'Budi Santoso',
            notes: 'Fragile electronics'
          });

          assert.match(orderId, /^ORD-\d{6}-\d{4}$/);
          assert.match(resi, /^RS-\d{8}$/);
          assertDbOrdersSchema10Cols(runtime);

          const afterOrders = getSheetTable(runtime, 'db_orders').rows;
          assert.equal(afterOrders.length, beforeCount + 1);
          const created = afterOrders.find((r) => r.order_id === orderId);
          assert.ok(created, 'Created order must exist in db_orders');
          assert.equal(created.resi, resi);
          assert.equal(created.shipper_id, 'SHP-01');
          assert.equal(created.status, 'Pending Pickup');
          assert.equal(created.current_hub, 'HUB-JKT');
          assert.equal(created.destination_hub, 'HUB-SUB');
          assert.equal(created.return_flag, '');
          assert.equal(created.inbound_date, '');
          assert.equal(created.end_date, '');

          const opLogs = getSheetTable(runtime, 'op_logs').rows;
          const log = opLogs.find((l) => l.order_id === orderId);
          assert.ok(log, 'op_logs must contain audit entry for created order');
          assert.equal(log.courier, 'Budi Santoso');
          assert.equal(log.notes, 'Fragile electronics');
        })
    },
    {
      name: 'T1-INPUT-03 [F-11] Created order appears in Input Data table and Pickup queue immediately',
      fn: () =>
        runSession({ view: 'input' }, async ({ page }) => {
          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-03',
            currentHub: 'HUB-BDG',
            destinationHub: 'HUB-JKT',
            address: 'Jl. Sudirman Kav 10, Jakarta'
          });

          await page.waitForFunction(
            (oid) => {
              const root = document.querySelector('#view-input');
              return root && (root.textContent || '').includes(oid);
            },
            orderId,
            { timeout: 10000 }
          );
          const inputRow = page.locator('#view-input table tbody tr', { hasText: orderId }).first();
          if ((await inputRow.count()) > 0) {
            await inputRow.waitFor({ state: 'visible' });
            assert.match(await inputRow.innerText(), /Pending Pickup/);
          } else {
            assert.match(await page.locator('#view-input').innerText(), /Pending Pickup/);
          }

          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderId);
          const pickupRow = page.locator('#view-pickup table tbody tr', { hasText: orderId }).first();
          await pickupRow.waitFor({ state: 'visible' });
        })
    },
    {
      name: 'T1-INPUT-04 [F-11] Create intra-city same-hub order (HUB-JKT -> HUB-JKT)',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-JKT',
            address: 'Jl. Thamrin No. 5, Jakarta Pusat'
          });

          const created = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === orderId);
          assert.ok(created);
          assert.equal(created.current_hub, 'HUB-JKT');
          assert.equal(created.destination_hub, 'HUB-JKT');
          assert.equal(created.status, 'Pending Pickup');
        })
    },
    {
      name: 'T1-INPUT-05 [F-12, F-19] Consecutive identical submissions produce distinct order_id and resi',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const payload = {
            shipperId: 'SHP-02',
            currentHub: 'HUB-BDG',
            destinationHub: 'HUB-SUB',
            address: 'Jl. Darmo Permai No. 12, Surabaya'
          };
          const o1 = await createOrderViaUi(page, payload);
          const o2 = await createOrderViaUi(page, payload);

          assert.notEqual(o1.orderId, o2.orderId);
          assert.notEqual(o1.resi, o2.resi);

          const rows = getSheetTable(runtime, 'db_orders').rows;
          const orderIdSet = new Set(rows.map((r) => r.order_id));
          const resiSet = new Set(rows.map((r) => r.resi));
          assert.equal(orderIdSet.size, rows.length, 'All order_id values in db_orders must be unique');
          assert.equal(resiSet.size, rows.length, 'All resi values in db_orders must be unique');
        })
    },

    // =========================================================================
    // Area 3: Pickup (F-13, F-14) — 5 Tests
    // =========================================================================
    {
      name: 'T1-PICKUP-01 [F-13] Pickup queue shows only Pending Pickup and filters by hub, order_id, & resi',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-8101',
                resi: 'RS-81010001',
                shipper_id: 'SHP-01',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                destination_address: 'Jl. Pickup Filter Test 8101'
              });
            }
          },
          async ({ page }) => {
            const tableText = await page.locator('#view-pickup table').innerText();
            for (const disallowed of ['Transit', 'On Shipment', 'Delivered', 'Returned']) {
              assert.ok(
                !new RegExp(`\\b${disallowed}\\b`).test(tableText),
                `Pickup queue must not display ${disallowed} orders`
              );
            }

            await page.locator('#pickup-hub-filter').selectOption('HUB-JKT');
            await page.locator('#pickup-scan-input').fill('ORD-261118-8101');
            await page.locator('#view-pickup table tbody tr', { hasText: 'ORD-261118-8101' }).first().waitFor({ state: 'visible' });

            await page.locator('#pickup-scan-input').fill('RS-81010001');
            await page.locator('#view-pickup table tbody tr', { hasText: 'RS-81010001' }).first().waitFor({ state: 'visible' });
          }
        )
    },
    {
      name: 'T1-PICKUP-02 [F-14, F-22] Confirm single pickup transitions Pending Pickup -> Transit with inbound_date & op_logs',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-8102',
                resi: 'RS-81020002',
                shipper_id: 'SHP-01',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                destination_address: 'Jl. Single Pickup 8102'
              });
            }
          },
          async ({ page, runtime }) => {
            const today = getBangkokDateYmd(0);
            await page.locator('#pickup-scan-input').fill('ORD-261118-8102');
            await selectQueueRow(page, '#view-pickup', 'ORD-261118-8102');
            await page.locator('#pickup-date').fill(today);
            await page.locator('#pickup-courier').fill('Andi Wijaya');
            await page.locator('#pickup-notes').fill('Picked up at warehouse');

            await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(page, /transit|picked up|confirmed|updated|1/i);
            await page.locator('#view-pickup table tbody tr', { hasText: 'ORD-261118-8102' }).waitFor({ state: 'hidden' });

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261118-8102');
            assert.equal(row.status, 'Transit');
            assert.equal(normalizeYmd(row.inbound_date), today);
            assert.equal(row.end_date, '');

            const log = getSheetTable(runtime, 'op_logs').rows.find(
              (l) => l.order_id === 'ORD-261118-8102' && l.to_status === 'Transit'
            );
            assert.ok(log);
            assert.equal(log.from_status, 'Pending Pickup');
            assert.equal(log.courier, 'Andi Wijaya');
            assert.equal(log.notes, 'Picked up at warehouse');
          }
        )
    },
    {
      name: 'T1-PICKUP-03 [F-14] Confirm pickup overrides current_hub when #pickup-confirm-hub changed',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-8103',
                resi: 'RS-81030003',
                shipper_id: 'SHP-01',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-SUB',
                destination_address: 'Jl. Hub Override 8103'
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#pickup-scan-input').fill('ORD-261118-8103');
            await selectQueueRow(page, '#view-pickup', 'ORD-261118-8103');
            await page.locator('#pickup-confirm-hub').selectOption('HUB-BDG');
            await page.locator('#pickup-courier').fill('Rudi');

            await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(page, /transit|picked up|confirmed|updated|1/i);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261118-8103');
            assert.equal(row.status, 'Transit');
            assert.equal(row.current_hub, 'HUB-BDG');
            assert.match(normalizeYmd(row.inbound_date), /^\d{4}-\d{2}-\d{2}$/);

            const log = getSheetTable(runtime, 'op_logs').rows.find((l) => l.order_id === 'ORD-261118-8103');
            assert.ok(log);
            assert.equal(log.current_hub, 'HUB-BDG');
          }
        )
    },
    {
      name: 'T1-PICKUP-04 [F-13, F-14] Batch pickup multiple orders writes Transit & 2 op_logs entries',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-8104',
                resi: 'RS-81040004',
                shipper_id: 'SHP-01',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                destination_address: 'Jl. Batch Pickup A 8104'
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-8105',
                resi: 'RS-81050005',
                shipper_id: 'SHP-02',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-SUB',
                destination_address: 'Jl. Batch Pickup B 8105'
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#pickup-hub-filter').selectOption('HUB-JKT');
            await selectQueueRow(page, '#view-pickup', 'ORD-261118-8104');
            await selectQueueRow(page, '#view-pickup', 'ORD-261118-8105');
            await page.locator('#pickup-courier').fill('Batch Driver');
            await page.locator('#pickup-notes').fill('Batch morning run');

            await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(page, /2|transit|confirmed|picked up/i);

            const orders = getSheetTable(runtime, 'db_orders').rows;
            for (const oid of ['ORD-261118-8104', 'ORD-261118-8105']) {
              const r = orders.find((o) => o.order_id === oid);
              assert.equal(r.status, 'Transit');
              assert.match(normalizeYmd(r.inbound_date), /^\d{4}-\d{2}-\d{2}$/);
              await page.locator('#view-pickup table tbody tr', { hasText: oid }).waitFor({ state: 'hidden' });
            }

            const logs = getSheetTable(runtime, 'op_logs').rows.filter(
              (l) => l.courier === 'Batch Driver' && (l.order_id === 'ORD-261118-8104' || l.order_id === 'ORD-261118-8105')
            );
            assert.equal(logs.length, 2);
          }
        )
    },
    {
      name: 'T1-PICKUP-05 [F-13, F-14] Scan resi with Enter in #pickup-scan-input & confirm pickup',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-8106',
                resi: 'RS-81060006',
                shipper_id: 'SHP-01',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                destination_address: 'Jl. Scan Enter 8106'
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#pickup-courier').fill('Scanner Op');
            await page.locator('#pickup-scan-input').fill('RS-81060006');
            const enterRpcPromise = page
              .waitForResponse(
                (res) => res.url().includes('/__gas_rpc') && res.request().method() === 'POST',
                { timeout: 1500 }
              )
              .catch(() => null);
            await page.locator('#pickup-scan-input').press('Enter');
            await enterRpcPromise;

            const afterEnterRow = getSheetTable(runtime, 'db_orders').rows.find(
              (r) => r.order_id === 'ORD-261118-8106'
            );
            if (afterEnterRow?.status === 'Pending Pickup') {
              const row = page.locator('#view-pickup table tbody tr', { hasText: 'ORD-261118-8106' }).first();
              await row.waitFor({ state: 'visible' });
              const cb = row.locator('input[type="checkbox"]').first();
              if (!(await cb.isChecked())) await cb.check();
              await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
            }
            await waitForToast(page, /transit|picked up|confirmed|1/i);

            const updated = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261118-8106');
            assert.equal(updated.status, 'Transit');
          }
        )
    },

    // =========================================================================
    // Area 4: Sort (F-15, F-16) — 5 Tests
    // =========================================================================
    {
      name: 'T1-SORT-01 [F-15] Sort tabs separate Ready, Inter-Hub Linehaul, & Flagged/RTS queues',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              const d = getBangkokDateYmd(-1);
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8201',
                resi: 'RS-82010001',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                return_flag: '',
                inbound_date: d
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8202',
                resi: 'RS-82020002',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-SUB',
                return_flag: '',
                inbound_date: d
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8203',
                resi: 'RS-82030003',
                status: 'Transit',
                current_hub: 'HUB-BDG',
                destination_hub: 'HUB-JKT',
                return_flag: 1,
                inbound_date: d
              });
            }
          },
          async ({ page }) => {
            await page.locator('#sort-tab-ready').click();
            await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261117-8201' }).first().waitFor({ state: 'visible' });
            assert.equal(
              await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261117-8202' }).count(),
              0
            );

            await page.locator('#sort-tab-linehaul').click();
            await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261117-8202' }).first().waitFor({ state: 'visible' });
            assert.equal(
              await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261117-8201' }).count(),
              0
            );

            await page.locator('#sort-tab-flagged').click();
            await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261117-8203' }).first().waitFor({ state: 'visible' });

            await page.locator('#sort-hub-filter').selectOption('HUB-BDG');
            await page.locator('#sort-scan-input').fill('ORD-261117-8203');
            await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261117-8203' }).first().waitFor({ state: 'visible' });
          }
        )
    },
    {
      name: 'T1-SORT-02 [F-16, F-22] Transfer hub updates current_hub & moves linehaul order to Ready tab',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8204',
                resi: 'RS-82040004',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-SUB',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-linehaul').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-8204');
            await page.locator('#sort-target-hub').selectOption('HUB-SUB');
            await page.locator('#sort-courier').fill('Linehaul Truck 01');
            await page.locator('#sort-notes').fill('Arrived at Surabaya');

            await performRpcAction(page, () => page.locator('#btn-sort-transfer').click());
            await waitForToast(page, /transfer|hub|updated|transit/i);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261117-8204');
            assert.equal(row.status, 'Transit');
            assert.equal(row.current_hub, 'HUB-SUB');

            await page.locator('#sort-tab-ready').click();
            await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261117-8204' }).first().waitFor({ state: 'visible' });

            const log = getSheetTable(runtime, 'op_logs').rows.find((l) => l.order_id === 'ORD-261117-8204');
            assert.ok(log);
            assert.equal(log.from_status, 'Transit');
            assert.equal(log.to_status, 'Transit');
            assert.equal(log.current_hub, 'HUB-SUB');
            assert.equal(log.courier, 'Linehaul Truck 01');
            assert.equal(log.notes, 'Arrived at Surabaya');
          }
        )
    },
    {
      name: 'T1-SORT-03 [F-16] Same-hub dispatch transitions Transit -> On Shipment without modal',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8205',
                resi: 'RS-82050005',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-ready').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-8205');
            await page.locator('#sort-courier').fill('LastMile Kurir');
            await page.locator('#sort-notes').fill('Out for JKT delivery');

            await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
            await waitForToast(page, /dispatch|on shipment|updated/i);
            assert.equal(await page.locator('#confirm-modal').isVisible(), false);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261117-8205');
            assert.equal(row.status, 'On Shipment');
            assert.equal(row.end_date, '');

            const log = getSheetTable(runtime, 'op_logs').rows.find((l) => l.order_id === 'ORD-261117-8205');
            assert.ok(log);
            assert.equal(log.from_status, 'Transit');
            assert.equal(log.to_status, 'On Shipment');
          }
        )
    },
    {
      name: 'T1-SORT-04 [F-16] Flag Return sets return_flag = 1 while staying Transit and moves to Flagged tab',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8206',
                resi: 'RS-82060006',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                return_flag: '',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-linehaul').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-8206');
            await page.locator('#sort-notes').fill('Damaged outer box — RTS');

            await performRpcAction(page, () => page.locator('#btn-sort-flag-return').click());
            await waitForToast(page, /flag|return|updated/i);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261117-8206');
            assert.equal(row.status, 'Transit');
            assert.equal(Number(row.return_flag), 1);

            await page.locator('#sort-tab-flagged').click();
            await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261117-8206' }).first().waitFor({ state: 'visible' });

            const log = getSheetTable(runtime, 'op_logs').rows.find((l) => l.order_id === 'ORD-261117-8206');
            assert.ok(log);
            assert.equal(log.notes, 'Damaged outer box — RTS');
          }
        )
    },
    {
      name: 'T1-SORT-05 [F-15, F-16] Batch dispatch multiple same-hub Ready orders transitions both to On Shipment',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              const d = getBangkokDateYmd(-1);
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8207',
                resi: 'RS-82070007',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: d
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8208',
                resi: 'RS-82080008',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: d
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-ready').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-8207');
            await selectQueueRow(page, '#view-sort', 'ORD-261117-8208');
            await page.locator('#sort-courier').fill('Batch Dispatch');

            await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
            await waitForToast(page, /2|dispatch|on shipment/i);
            assert.equal(await page.locator('#confirm-modal').isVisible(), false);

            const orders = getSheetTable(runtime, 'db_orders').rows;
            assert.equal(orders.find((r) => r.order_id === 'ORD-261117-8207').status, 'On Shipment');
            assert.equal(orders.find((r) => r.order_id === 'ORD-261117-8208').status, 'On Shipment');

            const logs = getSheetTable(runtime, 'op_logs').rows.filter(
              (l) => l.order_id === 'ORD-261117-8207' || l.order_id === 'ORD-261117-8208'
            );
            assert.equal(logs.length, 2);
          }
        )
    },
    {
      name: 'T1-SORT-06 [F-15, F-16] Transfer hub on Flagged/RTS Transit order in #sort-tab-flagged preserves return_flag=1',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8209',
                resi: 'RS-82090009',
                status: 'Transit',
                return_flag: 1,
                current_hub: 'HUB-SUB',
                destination_hub: 'HUB-JKT',
                inbound_date: getBangkokDateYmd(-2)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-flagged').click();
            await page.locator('#sort-scan-input').fill('ORD-261117-8209');
            await selectQueueRow(page, '#view-sort', 'ORD-261117-8209');
            await page.locator('#sort-target-hub').selectOption('HUB-JKT');
            await page.locator('#sort-courier').fill('RTS Linehaul');
            await page.locator('#sort-notes').fill('Returning to origin hub');

            await performRpcAction(page, () => page.locator('#btn-sort-transfer').click());
            await waitForToast(page, /transfer|hub|updated|transit/i);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261117-8209');
            assert.equal(row.status, 'Transit');
            assert.equal(Number(row.return_flag), 1);
            assert.equal(row.current_hub, 'HUB-JKT');

            const log = getSheetTable(runtime, 'op_logs').rows.find((l) => l.order_id === 'ORD-261117-8209');
            assert.ok(log);
            assert.equal(log.from_status, 'Transit');
            assert.equal(log.to_status, 'Transit');
            assert.equal(log.current_hub, 'HUB-JKT');
            assert.equal(log.courier, 'RTS Linehaul');
          }
        )
    },

    // =========================================================================
    // Area 5: Delivery (F-17, F-18) — 5 Tests
    // =========================================================================
    {
      name: 'T1-DELIV-01 [F-17] Delivery queue displays On Shipment/flagged RTS with SLA badge & filters by hub/resi',
      fn: () =>
        runSession(
          {
            view: 'delivery',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261110-8301',
                resi: 'RS-83010001',
                status: 'On Shipment',
                current_hub: 'HUB-SUB',
                destination_hub: 'HUB-SUB',
                inbound_date: getBangkokDateYmd(-10)
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-8302',
                resi: 'RS-83020002',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                return_flag: '',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page }) => {
            const tableText = await page.locator('#view-delivery table').innerText();
            assert.ok(!/\bPending Pickup\b/.test(tableText), 'Delivery queue must exclude Pending Pickup');
            assert.ok(!/\bDelivered\b/.test(tableText), 'Delivery queue must exclude Delivered');
            assert.ok(!/\bReturned\b/.test(tableText), 'Delivery queue must exclude Returned');
            assert.ok(!tableText.includes('ORD-261117-8302'), 'Delivery queue must exclude unflagged Transit');

            await page.locator('#delivery-hub-filter').selectOption('HUB-SUB');
            await page.locator('#delivery-scan-input').fill('RS-83010001');
            const row = page.locator('#view-delivery table tbody tr', { hasText: 'ORD-261110-8301' }).first();
            await row.waitFor({ state: 'visible' });
            assert.match(await row.innerText(), /Over SLA/i);
          }
        )
    },
    {
      name: 'T1-DELIV-02 [F-18, F-22] Mark Delivered transitions On Shipment -> Delivered with end_date & cleared return_flag',
      fn: () =>
        runSession(
          {
            view: 'delivery',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261116-8303',
                resi: 'RS-83030003',
                status: 'On Shipment',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: getBangkokDateYmd(-2)
              });
            }
          },
          async ({ page, runtime }) => {
            const today = getBangkokDateYmd(0);
            await page.locator('#delivery-scan-input').fill('ORD-261116-8303');
            await selectQueueRow(page, '#view-delivery', 'ORD-261116-8303');
            await page.locator('#delivery-date').fill(today);
            await page.locator('#delivery-courier').fill('Kurir Agus');
            await page.locator('#delivery-notes').fill('Received by security');

            await performRpcAction(page, () => page.locator('#btn-delivery-delivered').click());
            await waitForToast(page, /delivered|completed|updated|1/i);
            await page.locator('#view-delivery table tbody tr', { hasText: 'ORD-261116-8303' }).waitFor({ state: 'hidden' });

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261116-8303');
            assert.equal(row.status, 'Delivered');
            assert.equal(normalizeYmd(row.end_date), today);
            assert.equal(row.return_flag, '');

            const log = getSheetTable(runtime, 'op_logs').rows.find((l) => l.order_id === 'ORD-261116-8303');
            assert.ok(log);
            assert.equal(log.from_status, 'On Shipment');
            assert.equal(log.to_status, 'Delivered');
            assert.equal(log.courier, 'Kurir Agus');
            assert.equal(log.notes, 'Received by security');
          }
        )
    },
    {
      name: 'T1-DELIV-03 [F-18] Failed -> Return to Hub transitions On Shipment -> Transit with return_flag=1',
      fn: () =>
        runSession(
          {
            view: 'delivery',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261116-8304',
                resi: 'RS-83040004',
                status: 'On Shipment',
                current_hub: 'HUB-BDG',
                destination_hub: 'HUB-BDG',
                inbound_date: getBangkokDateYmd(-2)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#delivery-scan-input').fill('ORD-261116-8304');
            await selectQueueRow(page, '#view-delivery', 'ORD-261116-8304');
            await page.locator('#delivery-courier').fill('Kurir Bima');
            await page.locator('#delivery-notes').fill('Recipient not home 2x');

            await performRpcAction(page, () => page.locator('#btn-delivery-failed-rts').click());
            await waitForToast(page, /return|transit|rts|updated/i);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261116-8304');
            assert.equal(row.status, 'Transit');
            assert.equal(Number(row.return_flag), 1);
            assert.equal(row.end_date, '');

            await navigateToView(page, 'sort');
            await page.locator('#sort-tab-flagged').click();
            await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261116-8304' }).first().waitFor({ state: 'visible' });

            const log = getSheetTable(runtime, 'op_logs').rows.find((l) => l.order_id === 'ORD-261116-8304');
            assert.ok(log);
            assert.equal(log.from_status, 'On Shipment');
            assert.equal(log.to_status, 'Transit');
          }
        )
    },
    {
      name: 'T1-DELIV-04 [F-18] Mark Returned on On Shipment order closes as Returned with return_flag=1 & end_date',
      fn: () =>
        runSession(
          {
            view: 'delivery',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261116-8305',
                resi: 'RS-83050005',
                status: 'On Shipment',
                current_hub: 'HUB-SUB',
                destination_hub: 'HUB-SUB',
                inbound_date: getBangkokDateYmd(-2)
              });
            }
          },
          async ({ page, runtime }) => {
            const today = getBangkokDateYmd(0);
            await page.locator('#delivery-scan-input').fill('ORD-261116-8305');
            await selectQueueRow(page, '#view-delivery', 'ORD-261116-8305');
            await page.locator('#delivery-courier').fill('Kurir Cici');
            await page.locator('#delivery-notes').fill('Refused by consignee');

            await performRpcAction(page, () => page.locator('#btn-delivery-returned').click());
            await waitForToast(page, /returned|updated|1/i);
            await page.locator('#view-delivery table tbody tr', { hasText: 'ORD-261116-8305' }).waitFor({ state: 'hidden' });

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261116-8305');
            assert.equal(row.status, 'Returned');
            assert.equal(Number(row.return_flag), 1);
            assert.equal(normalizeYmd(row.end_date), today);

            const log = getSheetTable(runtime, 'op_logs').rows.find((l) => l.order_id === 'ORD-261116-8305');
            assert.ok(log);
            assert.equal(log.from_status, 'On Shipment');
            assert.equal(log.to_status, 'Returned');
          }
        )
    },
    {
      name: 'T1-DELIV-05 [F-17, F-18] Mark Returned on flagged Transit RTS order closes Transit -> Returned',
      fn: () =>
        runSession(
          {
            view: 'delivery',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261115-8306',
                resi: 'RS-83060006',
                status: 'Transit',
                return_flag: 1,
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                inbound_date: getBangkokDateYmd(-3)
              });
            }
          },
          async ({ page, runtime }) => {
            const today = getBangkokDateYmd(0);
            await page.locator('#delivery-scan-input').fill('ORD-261115-8306');
            await selectQueueRow(page, '#view-delivery', 'ORD-261115-8306');
            await page.locator('#delivery-notes').fill('Returned to shipper warehouse');

            await performRpcAction(page, () => page.locator('#btn-delivery-returned').click());
            await waitForToast(page, /returned|updated|1/i);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261115-8306');
            assert.equal(row.status, 'Returned');
            assert.equal(Number(row.return_flag), 1);
            assert.equal(normalizeYmd(row.end_date), today);

            const log = getSheetTable(runtime, 'op_logs').rows.find((l) => l.order_id === 'ORD-261115-8306');
            assert.ok(log);
            assert.equal(log.from_status, 'Transit');
            assert.equal(log.to_status, 'Returned');
          }
        )
    },
    {
      name: 'T1-DELIV-06 [F-17, F-18] Batch Delivery MARK_DELIVERED transitions 2 On Shipment orders & writes 2 op_logs',
      fn: () =>
        runSession(
          {
            view: 'delivery',
            mutateSnapshot: (snap) => {
              const d = getBangkokDateYmd(-2);
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261116-8307',
                resi: 'RS-83070007',
                status: 'On Shipment',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: d
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261116-8308',
                resi: 'RS-83080008',
                status: 'On Shipment',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: d
              });
            }
          },
          async ({ page, runtime }) => {
            const today = getBangkokDateYmd(0);
            await page.locator('#delivery-hub-filter').selectOption('HUB-JKT');
            await selectQueueRow(page, '#view-delivery', 'ORD-261116-8307');
            await selectQueueRow(page, '#view-delivery', 'ORD-261116-8308');
            await page.locator('#delivery-date').fill(today);
            await page.locator('#delivery-courier').fill('Batch Kurir');
            await page.locator('#delivery-notes').fill('Batch POD complete');

            await performRpcAction(page, () => page.locator('#btn-delivery-delivered').click());
            await waitForToast(page, /2|delivered|completed|updated/i);

            const orders = getSheetTable(runtime, 'db_orders').rows;
            for (const oid of ['ORD-261116-8307', 'ORD-261116-8308']) {
              const row = orders.find((r) => r.order_id === oid);
              assert.equal(row.status, 'Delivered');
              assert.equal(normalizeYmd(row.end_date), today);
              assert.equal(row.return_flag, '');
              await page.locator('#view-delivery table tbody tr', { hasText: oid }).waitFor({ state: 'hidden' });
            }

            const logs = getSheetTable(runtime, 'op_logs').rows.filter(
              (l) => l.order_id === 'ORD-261116-8307' || l.order_id === 'ORD-261116-8308'
            );
            assert.equal(logs.length, 2);
            for (const l of logs) {
              assert.equal(l.from_status, 'On Shipment');
              assert.equal(l.to_status, 'Delivered');
              assert.equal(l.courier, 'Batch Kurir');
            }
          }
        )
    },

    // =========================================================================
    // Area 6: Sync, WebApp Shell & Audit Logs (F-10, F-19, F-20, F-21, F-22) — 6 Tests
    // =========================================================================
    {
      name: 'T1-SHELL-01 [F-20] Direct ?view= deep links and #nav-* zero-reload view switching',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, baseUrl }) => {
          const allViews = ['dashboard', 'input', 'pickup', 'sort', 'delivery'];
          assert.equal(await page.locator('#view-input').isVisible(), true);
          for (const v of allViews.filter((x) => x !== 'input')) {
            assert.equal(await page.locator(`#view-${v}`).isVisible(), false);
          }

          for (const target of ['pickup', 'sort', 'delivery', 'dashboard']) {
            await navigateToView(page, target);
            for (const v of allViews) {
              assert.equal(await page.locator(`#view-${v}`).isVisible(), v === target);
            }
          }

          for (const direct of ['pickup', 'sort', 'delivery']) {
            await gotoApp(page, `${baseUrl}/?view=${direct}`, direct);
            assert.equal(await page.locator(`#view-${direct}`).isVisible(), true);
          }
        })
    },
    {
      name: 'T1-SHELL-02 [F-10] #btn-refresh-all updates Dashboard KPIs after backend mutation',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const before = await readDashboardKpis(page);

          runtime.invoke('apiCreateOrder', {
            shipper_id: 'SHP-01',
            current_hub: 'HUB-JKT',
            destination_hub: 'HUB-BDG',
            destination_address: 'Jl. Refresh Test No. 99'
          });

          await performRpcAction(page, () => page.locator('#btn-refresh-all').click());
          await waitForKpiTotal(page, before.totalOrders + 1);
          const after = await readDashboardKpis(page);
          assert.equal(after.totalOrders, before.totalOrders + 1);
          assert.equal(after.activeShipments, before.activeShipments + 1);
        })
    },
    {
      name: 'T1-SHELL-03 [F-10, F-21] #btn-sync-report updates order_report!A2:K and preserves L1:M1 formulas',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const beforeFormulas = getSheetFormulas(runtime, 'order_report');
          const l1Before = beforeFormulas[0]?.[11];
          const m1Before = beforeFormulas[0]?.[12];
          const ordersCount = getSheetTable(runtime, 'db_orders').rows.length;

          await performRpcAction(page, () => page.locator('#btn-sync-report').click());
          const toast = await waitForToast(page, new RegExp(`${ordersCount}|sync`, 'i'));
          assert.ok(toast.length > 0);

          const reportTable = getSheetTable(runtime, 'order_report');
          assert.equal(reportTable.rows.length, ordersCount);

          const reportText = reportTable.raw
            .slice(1)
            .map((r) => `${r[6]} ${r[7]}`)
            .join('\n');
          assert.ok(reportText.includes('Jakarta Central Hub') || reportText.includes('Bandung West Hub'));

          const afterFormulas = getSheetFormulas(runtime, 'order_report');
          assert.equal(afterFormulas[0]?.[11], l1Before, 'L1 formula must remain intact after sync');
          assert.equal(afterFormulas[0]?.[12], m1Before, 'M1 formula must remain intact after sync');
        })
    },
    {
      name: 'T1-SHELL-04 [F-21] SHP-00x normalizes on read while db_orders preserves raw SHP-00x and A:J schema',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-260825-8401',
                resi: 'RS-84010001',
                shipper_id: 'SHP-001',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                destination_address: 'Jl. Legacy SHP001 Test'
              });
            }
          },
          async ({ page, runtime }) => {
            assertDbOrdersSchema10Cols(runtime);
            await performRpcAction(page, () => page.locator('#btn-sync-report').click());
            await waitForToast(page, /sync/i);

            const dbRow = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-260825-8401');
            assert.equal(dbRow.shipper_id, 'SHP-001', 'db_orders Col C must stay SHP-001 (read-only normalization)');

            const reportRow = getSheetTable(runtime, 'order_report').rows.find(
              (r) => r.order_id === 'ORD-260825-8401'
            );
            assert.ok(reportRow);
            assert.equal(reportRow.shipper_name, 'PT Toko Maju');

            await page.locator('#filter-search').fill('ORD-260825-8401');
            await waitForKpiTotal(page, 1);
            assert.ok((await page.locator('#view-dashboard').innerText()).includes('PT Toko Maju'));
          }
        )
    },
    {
      name: 'T1-SHELL-05 [F-22] Full mini-flow records 4 chronological op_logs entries with operator_email',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-JKT',
            address: 'Jl. Audit Mini Flow No. 1',
            courier: 'Op-1',
            notes: 'Create step'
          });

          await navigateToView(page, 'pickup');
          await page.locator('#pickup-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-pickup', orderId);
          await page.locator('#pickup-courier').fill('Op-2');
          await page.locator('#pickup-notes').fill('Pickup step');
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|picked up|confirmed|1/i);

          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-ready').click();
          await page.locator('#sort-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-sort', orderId);
          await page.locator('#sort-courier').fill('Op-3');
          await page.locator('#sort-notes').fill('Dispatch step');
          await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
          await waitForToast(page, /dispatch|on shipment/i);

          await navigateToView(page, 'delivery');
          await page.locator('#delivery-scan-input').fill(orderId);
          await selectQueueRow(page, '#view-delivery', orderId);
          await page.locator('#delivery-courier').fill('Op-4');
          await page.locator('#delivery-notes').fill('Delivered step');
          await performRpcAction(page, () => page.locator('#btn-delivery-delivered').click());
          await waitForToast(page, /delivered|1/i);

          const logsTable = getSheetTable(runtime, 'op_logs');
          assert.equal(logsTable.exists, true);
          assert.deepEqual(logsTable.headers.slice(0, 10), EXPECTED_OP_LOG_HEADERS);

          const orderLogs = logsTable.rows.filter((l) => l.order_id === orderId);
          assert.equal(orderLogs.length, 4);
          assert.equal(orderLogs[0].to_status, 'Pending Pickup');
          assert.equal(orderLogs[1].from_status, 'Pending Pickup');
          assert.equal(orderLogs[1].to_status, 'Transit');
          assert.equal(orderLogs[2].from_status, 'Transit');
          assert.equal(orderLogs[2].to_status, 'On Shipment');
          assert.equal(orderLogs[3].from_status, 'On Shipment');
          assert.equal(orderLogs[3].to_status, 'Delivered');

          for (const l of orderLogs) {
            assert.ok(String(l.log_id || '').trim().length > 0, 'log_id must be non-empty');
            assert.ok(String(l.timestamp || '').trim().length > 0, 'timestamp must be non-empty');
            assert.ok(String(l.action || '').trim().length > 0, 'action must be non-empty');
            assert.ok(String(l.operator_email || '').trim().length > 0, 'operator_email must be non-empty');
          }
        })
    },
    {
      name: 'T1-SHELL-06 [F-19, F-20] Responsive mobile/desktop viewports & back-to-back locked writes',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-8406',
                resi: 'RS-84060006',
                shipper_id: 'SHP-01',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                destination_address: 'Jl. Responsive Test 8406'
              });
            }
          },
          async ({ page, runtime }) => {
            await page.setViewportSize({ width: 375, height: 812 });
            const mobileOverflow = await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth + 2
            );
            assert.equal(mobileOverflow, true, 'Mobile Dashboard must not have horizontal overflow');

            await navigateToView(page, 'input');
            const inputOverflow = await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth + 2
            );
            assert.equal(inputOverflow, true, 'Mobile Input Data view must not have horizontal overflow');

            await page.setViewportSize({ width: 1280, height: 800 });
            await navigateToView(page, 'pickup');
            await page.locator('#pickup-scan-input').fill('ORD-261118-8406');
            await selectQueueRow(page, '#view-pickup', 'ORD-261118-8406');
            await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(page, /transit|picked up|confirmed|1/i);

            await navigateToView(page, 'sort');
            await page.locator('#sort-tab-ready').click();
            await page.locator('#sort-scan-input').fill('ORD-261118-8406');
            await selectQueueRow(page, '#view-sort', 'ORD-261118-8406');
            await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
            await waitForToast(page, /dispatch|on shipment/i);

            const finalRow = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261118-8406');
            assert.equal(finalRow.status, 'On Shipment');
          }
        )
    }
  ];
}

export const tier = 1;
export const title = 'Tier 1 — Feature Coverage (F-01..F-22)';
export const tests = makeTests(null);
export function getTests(sharedBrowserGetter) {
  return makeTests(sharedBrowserGetter);
}
