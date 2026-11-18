import assert from 'node:assert/strict';
import {
  assertDbOrdersSchema10Cols,
  assertNoBrokenNumbers,
  appendOrderToSnapshot,
  computeExpectedDashboard,
  createOrderViaUi,
  deleteSnapshotSheet,
  EXPECTED_OP_LOG_HEADERS,
  EXPECTED_ORDER_HEADERS,
  getBangkokDateYmd,
  getHighAgingTable,
  getSheetFormulas,
  getSheetTable,
  getSnapshotSheetGrid,
  navigateToView,
  normalizeYmd,
  performRpcAction,
  readDashboardKpis,
  selectQueueRow,
  setSnapshotSheetGrid,
  waitForFeedback,
  waitForFreshFeedbackAfterClick,
  waitForKpiTotal,
  waitForToast,
  withTestSession
} from './helpers.mjs';

async function invokeGasRpcFromPage(page, fnName, payload) {
  return page.evaluate(
    ({ fn, arg }) =>
      new Promise((resolve) => {
        window.google.script.run
          .withSuccessHandler((res) => resolve({ ok: true, res }))
          .withFailureHandler((err) => resolve({ ok: false, err: err?.message || String(err) }))
          [fn](arg);
      }),
    { fn: fnName, arg: payload }
  );
}

function makeTests(sharedBrowserGetter) {
  const runSession = (opts, fn) =>
    withTestSession({ ...opts, sharedBrowser: sharedBrowserGetter?.() || null }, fn);

  return [
    // =========================================================================
    // Area 1: Input Validation & Uniqueness (F-11, F-12, F-19) — 5 Tests
    // =========================================================================
    {
      name: 'T2-INPUT-01 [F-12] Reject empty / whitespace-only destination_address',
      fn: () =>
        runSession({ view: 'input', allowConsoleErrors: true }, async ({ page, runtime }) => {
          const beforeOrders = getSheetTable(runtime, 'db_orders').rows.length;
          const beforeLogs = getSheetTable(runtime, 'op_logs').rows.length;

          await page.locator('#input-shipper-id').selectOption('SHP-01');
          await page.locator('#input-current-hub').selectOption('HUB-JKT');
          await page.locator('#input-destination-hub').selectOption('HUB-BDG');
          await page.locator('#input-destination-address').fill('    ');
          await page.locator('#btn-submit-order').click();

          const feedback = await waitForFeedback(page, /address|required|min|length|5|invalid|please/i);
          assert.ok(feedback.length > 0, 'Expected validation feedback for whitespace address');
          assert.equal(getSheetTable(runtime, 'db_orders').rows.length, beforeOrders);
          assert.equal(getSheetTable(runtime, 'op_logs').rows.length, beforeLogs);
        })
    },
    {
      name: 'T2-INPUT-02 [F-12] Enforce destination_address length boundary (< 5 rejected, === 5 accepted)',
      fn: () =>
        runSession({ view: 'input', allowConsoleErrors: true }, async ({ page, runtime }) => {
          const beforeOrders = getSheetTable(runtime, 'db_orders').rows.length;

          await page.locator('#input-shipper-id').selectOption('SHP-01');
          await page.locator('#input-current-hub').selectOption('HUB-JKT');
          await page.locator('#input-destination-hub').selectOption('HUB-BDG');
          await page.locator('#input-destination-address').fill('Jl.1');
          await page.locator('#btn-submit-order').click();

          const errMsg = await waitForFeedback(page, /5|address|short|min|length|invalid/i);
          assert.ok(errMsg.length > 0);
          assert.equal(getSheetTable(runtime, 'db_orders').rows.length, beforeOrders);

          const { orderId } = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-BDG',
            address: 'Jl.12'
          });
          const afterRows = getSheetTable(runtime, 'db_orders').rows;
          assert.equal(afterRows.length, beforeOrders + 1);
          assert.equal(afterRows.find((r) => r.order_id === orderId).destination_address, 'Jl.12');
        })
    },
    {
      name: 'T2-INPUT-03 [F-12] Reject missing / unselected shipper_id',
      fn: () =>
        runSession({ view: 'input', allowConsoleErrors: true }, async ({ page, runtime }) => {
          const beforeOrders = getSheetTable(runtime, 'db_orders').rows.length;

          const hasBlankOption = await page.evaluate(() => {
            const sel = document.querySelector('#input-shipper-id');
            return sel && [...sel.options].some((o) => o.value === '');
          });
          if (hasBlankOption) {
            await page.locator('#input-shipper-id').selectOption('');
            await page.locator('#input-current-hub').selectOption('HUB-JKT');
            await page.locator('#input-destination-hub').selectOption('HUB-BDG');
            await page.locator('#input-destination-address').fill('Jl. Merdeka No. 10');
            await page.locator('#btn-submit-order').click();
            await waitForFeedback(page);
          } else {
            const rpcRes = await invokeGasRpcFromPage(page, 'apiCreateOrder', {
              shipper_id: '',
              current_hub: 'HUB-JKT',
              destination_hub: 'HUB-BDG',
              destination_address: 'Jl. Merdeka No. 10'
            });
            assert.ok(rpcRes.ok === false || rpcRes.res?.ok === false, 'Empty shipper_id must be rejected');
          }

          assert.equal(getSheetTable(runtime, 'db_orders').rows.length, beforeOrders);
        })
    },
    {
      name: 'T2-INPUT-04 [F-12] Reject missing / invalid hub code (HUB-XYZ)',
      fn: () =>
        runSession({ view: 'input', allowConsoleErrors: true }, async ({ page, runtime }) => {
          const beforeOrders = getSheetTable(runtime, 'db_orders').rows.length;

          const hasBlankHub = await page.evaluate(() => {
            const sel = document.querySelector('#input-current-hub');
            return sel && [...sel.options].some((o) => o.value === '');
          });
          if (hasBlankHub) {
            await page.locator('#input-shipper-id').selectOption('SHP-01');
            await page.locator('#input-current-hub').selectOption('');
            await page.locator('#input-destination-hub').selectOption('HUB-BDG');
            await page.locator('#input-destination-address').fill('Jl. Valid Address 10');
            await page.locator('#btn-submit-order').click();
            await waitForFeedback(page);
          }

          const badHubRpc = await invokeGasRpcFromPage(page, 'apiCreateOrder', {
            shipper_id: 'SHP-01',
            current_hub: 'HUB-XYZ',
            destination_hub: 'HUB-BDG',
            destination_address: 'Jl. Valid Address 10'
          });
          assert.ok(badHubRpc.ok === false || badHubRpc.res?.ok === false, 'Invalid hub HUB-XYZ must be rejected');
          assert.equal(getSheetTable(runtime, 'db_orders').rows.length, beforeOrders);
        })
    },
    {
      name: 'T2-INPUT-05 [F-12, F-19] Rapid sequential 5-order creation maintains unique order_id & resi',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const beforeCount = getSheetTable(runtime, 'db_orders').rows.length;
          const created = [];
          for (let i = 1; i <= 5; i++) {
            const res = await createOrderViaUi(page, {
              shipperId: 'SHP-02',
              currentHub: 'HUB-JKT',
              destinationHub: 'HUB-SUB',
              address: `Jl. Rapid Uniqueness No. ${i}`,
              courier: `Rapid-${i}`
            });
            created.push(res);
            assert.match(res.orderId, /^ORD-\d{6}-\d{4}$/);
            assert.match(res.resi, /^RS-\d{8}$/);
          }

          const allRows = getSheetTable(runtime, 'db_orders').rows;
          assert.equal(allRows.length, beforeCount + 5);
          assert.equal(new Set(allRows.map((r) => r.order_id)).size, allRows.length);
          assert.equal(new Set(allRows.map((r) => r.resi)).size, allRows.length);
        })
    },

    // =========================================================================
    // Area 2: Scan/Search & State Preconditions (F-13..F-19) — 6 Tests
    // =========================================================================
    {
      name: 'T2-STATE-01 [F-13, F-15, F-17] Non-existent order_id / resi scan leaves queues empty & mutates 0 rows',
      fn: () =>
        runSession({ view: 'pickup', allowConsoleErrors: true }, async ({ page, runtime }) => {
          const beforeOrders = getSheetTable(runtime, 'db_orders').rows.length;

          await page.locator('#pickup-scan-input').fill('ORD-999999-9999');
          assert.equal(await page.locator('#view-pickup table tbody tr', { hasText: 'ORD-999999-9999' }).count(), 0);

          const pRes = await invokeGasRpcFromPage(page, 'apiConfirmPickup', {
            query: 'RS-00000000',
            current_hub: 'HUB-JKT'
          });
          assert.ok(pRes.ok === false || pRes.res?.ok === false);

          await navigateToView(page, 'sort');
          await page.locator('#sort-scan-input').fill('RS-00000000');
          assert.equal(await page.locator('#view-sort table tbody tr', { hasText: 'RS-00000000' }).count(), 0);

          await navigateToView(page, 'delivery');
          await page.locator('#delivery-scan-input').fill('ORD-999999-9999');
          assert.equal(await page.locator('#view-delivery table tbody tr', { hasText: 'ORD-999999-9999' }).count(), 0);

          assert.equal(getSheetTable(runtime, 'db_orders').rows.length, beforeOrders);
          assert.equal(getSheetTable(runtime, 'op_logs').rows.length, 0);
        })
    },
    {
      name: 'T2-STATE-02 [F-19] Terminal Delivered order rejected across Pickup, Sort, & Delivery',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            allowConsoleErrors: true,
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261115-9002',
                resi: 'RS-90020002',
                status: 'Delivered',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: getBangkokDateYmd(-3),
                end_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#pickup-scan-input').fill('ORD-261115-9002');
            assert.equal(await page.locator('#view-pickup table tbody tr', { hasText: 'ORD-261115-9002' }).count(), 0);

            await navigateToView(page, 'sort');
            await page.locator('#sort-scan-input').fill('ORD-261115-9002');
            assert.equal(await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261115-9002' }).count(), 0);

            await navigateToView(page, 'delivery');
            await page.locator('#delivery-scan-input').fill('ORD-261115-9002');
            assert.equal(await page.locator('#view-delivery table tbody tr', { hasText: 'ORD-261115-9002' }).count(), 0);

            for (const [fn, payload] of [
              ['apiConfirmPickup', { orderIds: ['ORD-261115-9002'], current_hub: 'HUB-JKT' }],
              ['apiProcessSort', { orderIds: ['ORD-261115-9002'], action: 'DISPATCH_DELIVERY' }],
              ['apiProcessDelivery', { orderIds: ['ORD-261115-9002'], action: 'MARK_RETURNED' }]
            ]) {
              const r = await invokeGasRpcFromPage(page, fn, payload);
              assert.ok(
                r.ok === false || r.res?.ok === false || (r.res?.updatedOrders?.length || 0) === 0,
                `${fn} must reject/skip terminal Delivered order`
              );
            }

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261115-9002');
            assert.equal(row.status, 'Delivered');
            assert.equal(getSheetTable(runtime, 'op_logs').rows.length, 0);
          }
        )
    },
    {
      name: 'T2-STATE-03 [F-19] Terminal Returned order rejected across Pickup, Sort, & Delivery',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            allowConsoleErrors: true,
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261115-9003',
                resi: 'RS-90030003',
                status: 'Returned',
                return_flag: 1,
                current_hub: 'HUB-BDG',
                destination_hub: 'HUB-JKT',
                inbound_date: getBangkokDateYmd(-4),
                end_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#pickup-scan-input').fill('ORD-261115-9003');
            assert.equal(await page.locator('#view-pickup table tbody tr', { hasText: 'ORD-261115-9003' }).count(), 0);

            await navigateToView(page, 'sort');
            await page.locator('#sort-scan-input').fill('ORD-261115-9003');
            assert.equal(await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261115-9003' }).count(), 0);

            await navigateToView(page, 'delivery');
            await page.locator('#delivery-scan-input').fill('ORD-261115-9003');
            assert.equal(await page.locator('#view-delivery table tbody tr', { hasText: 'ORD-261115-9003' }).count(), 0);

            for (const [fn, payload] of [
              ['apiConfirmPickup', { orderIds: ['ORD-261115-9003'], current_hub: 'HUB-BDG' }],
              ['apiProcessSort', { orderIds: ['ORD-261115-9003'], action: 'TRANSFER_HUB', target_hub: 'HUB-JKT' }],
              ['apiProcessDelivery', { orderIds: ['ORD-261115-9003'], action: 'MARK_DELIVERED' }]
            ]) {
              const r = await invokeGasRpcFromPage(page, fn, payload);
              assert.ok(
                r.ok === false || r.res?.ok === false || (r.res?.updatedOrders?.length || 0) === 0,
                `${fn} must reject/skip terminal Returned order`
              );
            }

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261115-9003');
            assert.equal(row.status, 'Returned');
            assert.equal(getSheetTable(runtime, 'op_logs').rows.length, 0);
          }
        )
    },
    {
      name: 'T2-STATE-04 [F-19] Wrong-status precondition rejections across Pickup, Sort, & Delivery',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            allowConsoleErrors: true,
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-9004',
                resi: 'RS-90040004',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT'
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-9005',
                resi: 'RS-90050005',
                status: 'Transit',
                return_flag: '',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: getBangkokDateYmd(-1)
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-9006',
                resi: 'RS-90060006',
                status: 'On Shipment',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            const checks = [
              ['apiProcessSort', { orderIds: ['ORD-261118-9004'], action: 'DISPATCH_DELIVERY' }],
              ['apiProcessDelivery', { orderIds: ['ORD-261118-9004'], action: 'MARK_DELIVERED' }],
              ['apiConfirmPickup', { orderIds: ['ORD-261117-9005'], current_hub: 'HUB-JKT' }],
              ['apiProcessDelivery', { orderIds: ['ORD-261117-9005'], action: 'MARK_DELIVERED' }],
              ['apiConfirmPickup', { orderIds: ['ORD-261117-9006'], current_hub: 'HUB-JKT' }],
              ['apiProcessSort', { orderIds: ['ORD-261117-9006'], action: 'FLAG_RETURN' }]
            ];
            for (const [fn, payload] of checks) {
              const r = await invokeGasRpcFromPage(page, fn, payload);
              assert.ok(
                r.ok === false || r.res?.ok === false || (r.res?.updatedOrders?.length || 0) === 0,
                `Expected ${fn} with ${JSON.stringify(payload)} to reject/skip`
              );
            }

            const rows = getSheetTable(runtime, 'db_orders').rows;
            assert.equal(rows.find((r) => r.order_id === 'ORD-261118-9004').status, 'Pending Pickup');
            assert.equal(rows.find((r) => r.order_id === 'ORD-261117-9005').status, 'Transit');
            assert.equal(rows.find((r) => r.order_id === 'ORD-261117-9006').status, 'On Shipment');
            assert.equal(getSheetTable(runtime, 'op_logs').rows.length, 0);
          }
        )
    },
    {
      name: 'T2-STATE-05 [F-18, F-19] Unflagged Transit order rejected for MARK_RETURNED in Delivery',
      fn: () =>
        runSession(
          {
            view: 'delivery',
            allowConsoleErrors: true,
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-9007',
                resi: 'RS-90070007',
                status: 'Transit',
                return_flag: '',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#delivery-scan-input').fill('ORD-261117-9007');
            assert.equal(await page.locator('#view-delivery table tbody tr', { hasText: 'ORD-261117-9007' }).count(), 0);

            const r = await invokeGasRpcFromPage(page, 'apiProcessDelivery', {
              orderIds: ['ORD-261117-9007'],
              action: 'MARK_RETURNED'
            });
            assert.ok(r.ok === false || r.res?.ok === false || (r.res?.updatedOrders?.length || 0) === 0);

            const row = getSheetTable(runtime, 'db_orders').rows.find((x) => x.order_id === 'ORD-261117-9007');
            assert.equal(row.status, 'Transit');
            assert.equal(row.return_flag, '');
            assert.equal(row.end_date, '');
            assert.equal(getSheetTable(runtime, 'op_logs').rows.length, 0);
          }
        )
    },
    {
      name: 'T2-STATE-06 [F-13] Case-insensitive & whitespace-trimmed resi scan matches Pending Pickup order',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-9008',
                resi: 'RS-90080008',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG'
              });
            }
          },
          async ({ page }) => {
            await page.locator('#pickup-scan-input').fill('  rs-90080008  ');
            await page.locator('#view-pickup table tbody tr', { hasText: 'ORD-261118-9008' }).first().waitFor({ state: 'visible' });
          }
        )
    },

    // =========================================================================
    // Area 3: Sort Cross-Hub Confirmation Modal (#confirm-modal, F-16) — 5 Tests
    // =========================================================================
    {
      name: 'T2-MODAL-01 [F-16] Cross-hub dispatch opens #confirm-modal without mutating db_orders before Proceed',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-9101',
                resi: 'RS-91010001',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-SUB',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-linehaul').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-9101');
            await page.locator('#btn-sort-dispatch').click();

            await page.locator('#confirm-modal').waitFor({ state: 'visible' });
            const modalText = await page.locator('#confirm-modal').innerText();
            assert.match(modalText, /HUB-JKT|HUB-SUB|ORD-261117-9101|mismatch|hub/i);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261117-9101');
            assert.equal(row.status, 'Transit');
          }
        )
    },
    {
      name: 'T2-MODAL-02 [F-16] #btn-confirm-modal-cancel aborts cross-hub dispatch & writes 0 op_logs',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-9102',
                resi: 'RS-91020002',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-SUB',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-linehaul').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-9102');
            await page.locator('#btn-sort-dispatch').click();

            await page.locator('#confirm-modal').waitFor({ state: 'visible' });
            await page.locator('#btn-confirm-modal-cancel').click();
            await page.locator('#confirm-modal').waitFor({ state: 'hidden' });

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261117-9102');
            assert.equal(row.status, 'Transit');
            assert.equal(row.current_hub, 'HUB-JKT');
            assert.equal(row.end_date, '');
            assert.equal(getSheetTable(runtime, 'op_logs').rows.length, 0);
            await page.locator('#view-sort table tbody tr', { hasText: 'ORD-261117-9102' }).first().waitFor({ state: 'visible' });
          }
        )
    },
    {
      name: 'T2-MODAL-03 [F-16] #btn-confirm-modal-proceed overrides cross-hub warning & dispatches to Delivery',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-9103',
                resi: 'RS-91030003',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-SUB',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-linehaul').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-9103');
            await page.locator('#sort-courier').fill('Override Courier');
            await page.locator('#btn-sort-dispatch').click();

            await page.locator('#confirm-modal').waitFor({ state: 'visible' });
            await performRpcAction(page, () => page.locator('#btn-confirm-modal-proceed').click());
            await page.locator('#confirm-modal').waitFor({ state: 'hidden' });
            await waitForToast(page, /dispatch|on shipment|updated/i);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261117-9103');
            assert.equal(row.status, 'On Shipment');
            assert.equal(getSheetTable(runtime, 'op_logs').rows.filter((l) => l.order_id === 'ORD-261117-9103').length, 1);

            await navigateToView(page, 'delivery');
            await page.locator('#delivery-scan-input').fill('ORD-261117-9103');
            await page.locator('#view-delivery table tbody tr', { hasText: 'ORD-261117-9103' }).first().waitFor({ state: 'visible' });
          }
        )
    },
    {
      name: 'T2-MODAL-04 [F-16] Same-hub dispatch bypasses #confirm-modal and immediately moves to On Shipment',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-9104',
                resi: 'RS-91040004',
                status: 'Transit',
                current_hub: 'HUB-BDG',
                destination_hub: 'HUB-BDG',
                inbound_date: getBangkokDateYmd(-1)
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-ready').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-9104');
            await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
            await waitForToast(page, /dispatch|on shipment|updated/i);
            assert.equal(await page.locator('#confirm-modal').isVisible(), false);

            const row = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261117-9104');
            assert.equal(row.status, 'On Shipment');
            assert.equal(getSheetTable(runtime, 'op_logs').rows.filter((l) => l.order_id === 'ORD-261117-9104').length, 1);
          }
        )
    },
    {
      name: 'T2-MODAL-05 [F-16] Mixed same-hub + cross-hub selection & Cancel aborts both orders (no partial dispatch)',
      fn: () =>
        runSession(
          {
            view: 'sort',
            mutateSnapshot: (snap) => {
              const d = getBangkokDateYmd(-1);
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-9105',
                resi: 'RS-91050005',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: d
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261117-9106',
                resi: 'RS-91060006',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-SUB',
                inbound_date: d
              });
            }
          },
          async ({ page, runtime }) => {
            await page.locator('#sort-tab-ready').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-9105');

            await page.locator('#sort-tab-linehaul').click();
            await selectQueueRow(page, '#view-sort', 'ORD-261117-9106');
            await page.locator('#btn-sort-dispatch').click();

            await page.locator('#confirm-modal').waitFor({ state: 'visible' });
            await page.locator('#btn-confirm-modal-cancel').click();
            await page.locator('#confirm-modal').waitFor({ state: 'hidden' });

            // Also verify direct mixed batch RPC with force_cross_hub: false aborts BOTH atomically
            const mixedRpc = await invokeGasRpcFromPage(page, 'apiProcessSort', {
              orderIds: ['ORD-261117-9105', 'ORD-261117-9106'],
              action: 'DISPATCH_DELIVERY',
              force_cross_hub: false
            });
            assert.equal(mixedRpc.res?.ok, false);
            assert.equal(mixedRpc.res?.code, 'CROSS_HUB_CONFIRM_REQUIRED');

            const rows = getSheetTable(runtime, 'db_orders').rows;
            assert.equal(rows.find((r) => r.order_id === 'ORD-261117-9105').status, 'Transit');
            assert.equal(rows.find((r) => r.order_id === 'ORD-261117-9106').status, 'Transit');
            assert.equal(getSheetTable(runtime, 'op_logs').rows.length, 0);
          }
        )
    },

    // =========================================================================
    // Area 4: Legacy & Schema Edge Cases (F-21, F-01, F-06) — 5 Tests
    // =========================================================================
    {
      name: 'T2-LEGACY-01 [F-21, F-06] SHP-00x normalizes on read across Dashboard/Report without mutating db_orders',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-260825-9201',
                resi: 'RS-92010001',
                shipper_id: 'SHP-001',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG'
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-260825-9202',
                resi: 'RS-92020002',
                shipper_id: 'SHP-002',
                status: 'Delivered',
                current_hub: 'HUB-BDG',
                destination_hub: 'HUB-BDG',
                inbound_date: getBangkokDateYmd(-5),
                end_date: getBangkokDateYmd(-2)
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-260825-9203',
                resi: 'RS-92030003',
                shipper_id: 'SHP-003',
                status: 'Delivered',
                current_hub: 'HUB-SUB',
                destination_hub: 'HUB-SUB',
                inbound_date: getBangkokDateYmd(-5),
                end_date: getBangkokDateYmd(-2)
              });
            }
          },
          async ({ page, runtime }) => {
            await navigateToView(page, 'pickup');
            await page.locator('#pickup-scan-input').fill('ORD-260825-9201');
            const pickupRow = page.locator('#view-pickup table tbody tr', { hasText: 'ORD-260825-9201' }).first();
            await pickupRow.waitFor({ state: 'visible' });
            assert.match(await pickupRow.innerText(), /PT Toko Maju/);

            await selectQueueRow(page, '#view-pickup', 'ORD-260825-9201');
            await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(page, /transit|confirmed|picked up|1/i);

            await navigateToView(page, 'dashboard');
            await performRpcAction(page, () => page.locator('#btn-sync-report').click());
            await waitForToast(page, /sync/i);

            const dbRows = getSheetTable(runtime, 'db_orders').rows;
            assert.equal(dbRows.find((r) => r.order_id === 'ORD-260825-9201').shipper_id, 'SHP-001');
            assert.equal(dbRows.find((r) => r.order_id === 'ORD-260825-9202').shipper_id, 'SHP-002');
            assert.equal(dbRows.find((r) => r.order_id === 'ORD-260825-9203').shipper_id, 'SHP-003');

            const repRows = getSheetTable(runtime, 'order_report').rows;
            assert.equal(repRows.find((r) => r.order_id === 'ORD-260825-9201').shipper_name, 'PT Toko Maju');
            assert.equal(repRows.find((r) => r.order_id === 'ORD-260825-9202').shipper_name, 'CV Berkah Jaya');
            assert.equal(repRows.find((r) => r.order_id === 'ORD-260825-9203').shipper_name, 'PT Maju Jaya Sejahtera');
          }
        )
    },
    {
      name: 'T2-LEGACY-02 [F-21] BigQuery db_orders strictly retains 10 columns (A:J) after all lifecycle mutations',
      fn: () =>
        runSession({ view: 'input' }, async ({ page, runtime }) => {
          const o1 = await createOrderViaUi(page, {
            shipperId: 'SHP-01',
            currentHub: 'HUB-JKT',
            destinationHub: 'HUB-JKT',
            address: 'Jl. BigQuery Guard 1',
            courier: 'GuardOp',
            notes: 'Must stay in op_logs'
          });
          const o2 = await createOrderViaUi(page, {
            shipperId: 'SHP-02',
            currentHub: 'HUB-BDG',
            destinationHub: 'HUB-BDG',
            address: 'Jl. BigQuery Guard 2'
          });

          await navigateToView(page, 'pickup');
          await selectQueueRow(page, '#view-pickup', o1.orderId);
          await selectQueueRow(page, '#view-pickup', o2.orderId);
          await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
          await waitForToast(page, /transit|picked up|confirmed|2/i);

          await navigateToView(page, 'sort');
          await page.locator('#sort-tab-ready').click();
          await selectQueueRow(page, '#view-sort', o1.orderId);
          await performRpcAction(page, () => page.locator('#btn-sort-dispatch').click());
          await waitForToast(page, /dispatch|on shipment/i);

          await selectQueueRow(page, '#view-sort', o2.orderId);
          await performRpcAction(page, () => page.locator('#btn-sort-flag-return').click());
          await waitForToast(page, /flag|return/i);

          await navigateToView(page, 'delivery');
          await selectQueueRow(page, '#view-delivery', o1.orderId);
          await performRpcAction(page, () => page.locator('#btn-delivery-delivered').click());
          await waitForToast(page, /delivered/i);

          await selectQueueRow(page, '#view-delivery', o2.orderId);
          await performRpcAction(page, () => page.locator('#btn-delivery-returned').click());
          await waitForToast(page, /returned/i);

          assertDbOrdersSchema10Cols(runtime);
        })
    },
    {
      name: 'T2-LEGACY-03 [F-01, F-18] Legacy Delivered+return_flag=1 counts consistently while MARK_DELIVERED clears return_flag',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-098-LEGACY',
                resi: 'JX90000098',
                shipper_id: 'SHP-01',
                return_flag: 1,
                status: 'Delivered',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: getBangkokDateYmd(-10),
                end_date: getBangkokDateYmd(-7)
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261116-9204',
                resi: 'RS-92040004',
                shipper_id: 'SHP-01',
                return_flag: 1,
                status: 'On Shipment',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: getBangkokDateYmd(-2)
              });
            }
          },
          async ({ page, runtime }) => {
            const { rows: beforeRows } = getSheetTable(runtime, 'db_orders');
            const { rows: shippers } = getSheetTable(runtime, 'db_shippers');
            const beforeOracle = computeExpectedDashboard(beforeRows, shippers);
            const kpisBefore = await readDashboardKpis(page);

            assert.equal(kpisBefore.totalOrders, beforeOracle.totalOrders);
            assert.ok(Math.abs(kpisBefore.deliveredRate - beforeOracle.deliveredRate) <= 0.1);
            assert.ok(Math.abs(kpisBefore.returnRate - beforeOracle.returnRate) <= 0.1);

            await navigateToView(page, 'delivery');
            await page.locator('#delivery-scan-input').fill('ORD-261116-9204');
            await selectQueueRow(page, '#view-delivery', 'ORD-261116-9204');
            await performRpcAction(page, () => page.locator('#btn-delivery-delivered').click());
            await waitForToast(page, /delivered/i);

            const afterRow = getSheetTable(runtime, 'db_orders').rows.find((r) => r.order_id === 'ORD-261116-9204');
            assert.equal(afterRow.status, 'Delivered');
            assert.equal(afterRow.return_flag, '');
            assert.match(normalizeYmd(afterRow.end_date), /^\d{4}-\d{2}-\d{2}$/);
          }
        )
    },
    {
      name: 'T2-LEGACY-04 [F-11, F-13] Legacy 6-digit unpadded resi RS-992051 searches cleanly while new orders pad 8 digits',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-9205',
                resi: 'RS-992051',
                shipper_id: 'SHP-01',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG'
              });
            }
          },
          async ({ page }) => {
            await page.locator('#filter-search').fill('RS-992051');
            await waitForKpiTotal(page, 1);

            await navigateToView(page, 'pickup');
            await page.locator('#pickup-scan-input').fill('RS-992051');
            await page.locator('#view-pickup table tbody tr', { hasText: 'RS-992051' }).first().waitFor({ state: 'visible' });

            const created = await createOrderViaUi(page, {
              shipperId: 'SHP-01',
              currentHub: 'HUB-JKT',
              destinationHub: 'HUB-BDG',
              address: 'Jl. 8-Digit Pad Check'
            });
            assert.match(created.resi, /^RS-\d{8}$/);
          }
        )
    },
    {
      name: 'T2-LEGACY-05 [F-01, F-09] Anomalous dates (inbound_date > end_date) render without NaN or pageerror',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261110-9206',
                resi: 'RS-92060006',
                shipper_id: 'SHP-01',
                status: 'Delivered',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-JKT',
                inbound_date: '2026-11-10',
                end_date: '2026-11-01'
              });
            }
          },
          async ({ page }) => {
            const kpis = await readDashboardKpis(page);
            assertNoBrokenNumbers(JSON.stringify(kpis.raw), 'T2-LEGACY-05 KPIs');
            assert.equal(Number.isFinite(kpis.avgDeliveryTime), true);
            const dashText = await page.locator('#view-dashboard').innerText();
            assertNoBrokenNumbers(dashText, 'T2-LEGACY-05 Dashboard');
          }
        )
    },

    // =========================================================================
    // Area 5: Dashboard Boundaries (F-01, F-02, F-08, F-09) — 6 Tests
    // =========================================================================
    {
      name: 'T2-DASH-B01 [F-08, F-09] Exact SLA boundary: 7 days Under SLA vs 8 days Over SLA vs blank Not Inbounded',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              setSnapshotSheetGrid(snap, 'db_orders', [
                [...EXPECTED_ORDER_HEADERS],
                [
                  'ORD-SLA-07',
                  'RS-00000007',
                  'SHP-01',
                  '',
                  'Transit',
                  'HUB-JKT',
                  'Jl. Seven Days',
                  'HUB-JKT',
                  getBangkokDateYmd(-7),
                  ''
                ],
                [
                  'ORD-SLA-08',
                  'RS-00000008',
                  'SHP-01',
                  '',
                  'Transit',
                  'HUB-JKT',
                  'Jl. Eight Days',
                  'HUB-JKT',
                  getBangkokDateYmd(-8),
                  ''
                ],
                [
                  'ORD-SLA-00',
                  'RS-00000000',
                  'SHP-01',
                  '',
                  'Pending Pickup',
                  'HUB-JKT',
                  'Jl. Not Inbounded',
                  'HUB-JKT',
                  '',
                  ''
                ]
              ]);
            }
          },
          async ({ page }) => {
            await waitForKpiTotal(page, 3);

            await page.locator('#filter-sla').selectOption('Under SLA');
            await waitForKpiTotal(page, 1);

            await page.locator('#filter-sla').selectOption('Over SLA');
            await waitForKpiTotal(page, 1);
            const highAging = await getHighAgingTable(page);
            assert.ok((await highAging.innerText()).includes('ORD-SLA-08'));

            await page.locator('#filter-sla').selectOption('Not Inbounded');
            await waitForKpiTotal(page, 1);
          }
        )
    },
    {
      name: 'T2-DASH-B02 [F-01, F-02] 0/0 empty filter returns 0, 0.00%, 0.0 without NaN/Infinity',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page }) => {
          await page.locator('#filter-search').fill('NON-EXISTENT-ORDER-XYZ-999');
          await waitForKpiTotal(page, 0);
          const kpis = await readDashboardKpis(page);
          assertNoBrokenNumbers(JSON.stringify(kpis.raw), 'T2-DASH-B02');
          assert.equal(kpis.totalOrders, 0);
          assert.equal(kpis.activeShipments, 0);
          assert.equal(kpis.deliveredRate, 0);
          assert.equal(kpis.returnRate, 0);
          assert.equal(kpis.avgDeliveryTime, 0);
          assert.match(kpis.raw.delivText, /0\.00%/);
          assert.match(kpis.raw.retText, /0\.00%/);
        })
    },
    {
      name: 'T2-DASH-B03 [F-01] 0/0 Delivered Rate when only active orders exist -> 0.00%',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              setSnapshotSheetGrid(snap, 'db_orders', [
                [...EXPECTED_ORDER_HEADERS],
                ['ORD-ACT-1', 'RS-11111111', 'SHP-01', '', 'Pending Pickup', 'HUB-JKT', 'Jl. A1', 'HUB-BDG', '', ''],
                [
                  'ORD-ACT-2',
                  'RS-22222222',
                  'SHP-02',
                  '',
                  'Transit',
                  'HUB-BDG',
                  'Jl. A2',
                  'HUB-SUB',
                  getBangkokDateYmd(-2),
                  ''
                ]
              ]);
            }
          },
          async ({ page }) => {
            await waitForKpiTotal(page, 2);
            const kpis = await readDashboardKpis(page);
            assertNoBrokenNumbers(JSON.stringify(kpis.raw), 'T2-DASH-B03');
            assert.equal(kpis.totalOrders, 2);
            assert.equal(kpis.activeShipments, 2);
            assert.equal(kpis.deliveredRate, 0);
            assert.match(kpis.raw.delivText, /0\.00%/);
          }
        )
    },
    {
      name: 'T2-DASH-B04 [F-02] #btn-reset-filters clears all 7 filter inputs & restores full KPIs',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const { rows: ordersRows } = getSheetTable(runtime, 'db_orders');
          const { rows: shippersRows } = getSheetTable(runtime, 'db_shippers');
          const fullOracle = computeExpectedDashboard(ordersRows, shippersRows);

          await page.locator('#filter-hub').selectOption('HUB-SUB');
          await page.locator('#filter-status').selectOption('Returned');
          await page.locator('#filter-shipper').selectOption('SHP-02');
          await page.locator('#filter-sla').selectOption('Over SLA');
          await page.locator('#filter-date-from').fill('2026-10-01');
          await page.locator('#filter-date-to').fill('2026-10-15');
          await page.locator('#filter-search').fill('ORD-NONMATCH');
          await waitForKpiTotal(page, 0);

          await page.locator('#btn-reset-filters').click();
          await waitForKpiTotal(page, fullOracle.totalOrders);

          assert.equal(await page.locator('#filter-date-from').inputValue(), '');
          assert.equal(await page.locator('#filter-date-to').inputValue(), '');
          assert.equal(await page.locator('#filter-search').inputValue(), '');
          for (const id of ['#filter-hub', '#filter-status', '#filter-shipper', '#filter-sla']) {
            const val = await page.locator(id).inputValue();
            assert.ok(val === '' || /^all$/i.test(val), `${id} should reset to default, got ${val}`);
          }
        })
    },
    {
      name: 'T2-DASH-B05 [F-02] Single-day inclusive date range vs inverted date range returns 0 safely',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              const targetDate = getBangkokDateYmd(0);
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-9305',
                resi: 'RS-93050005',
                shipper_id: 'SHP-01',
                status: 'Transit',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG',
                inbound_date: targetDate
              });
            }
          },
          async ({ page }) => {
            const targetDate = getBangkokDateYmd(0);
            await page.locator('#filter-date-from').fill(targetDate);
            await page.locator('#filter-date-to').fill(targetDate);
            await page.waitForFunction(() => {
              const el = document.querySelector('#kpi-total-orders');
              return el && Number((el.textContent || '').replace(/\D/g, '')) >= 1;
            });
            const singleDayKpis = await readDashboardKpis(page);
            assert.ok(singleDayKpis.totalOrders >= 1);

            await page.locator('#filter-date-from').fill('2026-12-01');
            await page.locator('#filter-date-to').fill('2026-11-01');
            await waitForKpiTotal(page, 0);
            const invertedKpis = await readDashboardKpis(page);
            assertNoBrokenNumbers(JSON.stringify(invertedKpis.raw), 'T2-DASH-B05');
            assert.equal(invertedKpis.totalOrders, 0);
            assert.equal(invertedKpis.deliveredRate, 0);
          }
        )
    },
    {
      name: 'T2-DASH-B06 [F-01] Average Delivery Time excludes Not Inbounded (Pending Pickup) rows',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              setSnapshotSheetGrid(snap, 'db_orders', [
                [...EXPECTED_ORDER_HEADERS],
                [
                  'ORD-AVG-1',
                  'RS-70000001',
                  'SHP-01',
                  '',
                  'Delivered',
                  'HUB-JKT',
                  'Jl. Avg 1',
                  'HUB-JKT',
                  getBangkokDateYmd(-6),
                  getBangkokDateYmd(-2)
                ],
                ['ORD-AVG-2', 'RS-70000002', 'SHP-01', '', 'Pending Pickup', 'HUB-JKT', 'Jl. Avg 2', 'HUB-JKT', '', ''],
                ['ORD-AVG-3', 'RS-70000003', 'SHP-01', '', 'Pending Pickup', 'HUB-JKT', 'Jl. Avg 3', 'HUB-JKT', '', ''],
                ['ORD-AVG-4', 'RS-70000004', 'SHP-01', '', 'Pending Pickup', 'HUB-JKT', 'Jl. Avg 4', 'HUB-JKT', '', '']
              ]);
            }
          },
          async ({ page }) => {
            await waitForKpiTotal(page, 4);
            const kpis = await readDashboardKpis(page);
            assert.ok(
              Math.abs(kpis.avgDeliveryTime - 4.0) <= 0.1,
              `Expected Average Delivery Time 4.0 (excluding 3 Pending Pickup rows), got ${kpis.avgDeliveryTime}`
            );
          }
        )
    },

    // =========================================================================
    // Area 6: Batch Operations & op_logs / order_report Edge Cases — 6 Tests
    // =========================================================================
    {
      name: 'T2-BATCH-01 [F-14, F-16, F-18] Empty selection action guard across Pickup, Sort, & Delivery',
      fn: () =>
        runSession({ view: 'pickup', allowConsoleErrors: true }, async ({ page, runtime }) => {
          const beforeOrders = JSON.stringify(getSheetTable(runtime, 'db_orders').raw);

          const fbPickup = await waitForFreshFeedbackAfterClick(
            page,
            '#btn-confirm-pickup-batch',
            /select|order|empty|required|choose|none/i
          );
          assert.ok(fbPickup.length > 0);

          await navigateToView(page, 'sort');
          for (const btnId of ['#btn-sort-transfer', '#btn-sort-dispatch', '#btn-sort-flag-return']) {
            const fbSort = await waitForFreshFeedbackAfterClick(
              page,
              btnId,
              /select|order|empty|required|choose|none/i
            );
            assert.ok(fbSort.length > 0, `Expected fresh feedback after clicking ${btnId}`);
          }

          await navigateToView(page, 'delivery');
          for (const btnId of ['#btn-delivery-delivered', '#btn-delivery-failed-rts', '#btn-delivery-returned']) {
            const fbDeliv = await waitForFreshFeedbackAfterClick(
              page,
              btnId,
              /select|order|empty|required|choose|none/i
            );
            assert.ok(fbDeliv.length > 0, `Expected fresh feedback after clicking ${btnId}`);
          }

          assert.equal(JSON.stringify(getSheetTable(runtime, 'db_orders').raw), beforeOrders);
          assert.equal(getSheetTable(runtime, 'op_logs').rows.length, 0);
        })
    },
    {
      name: 'T2-BATCH-02 [F-14, F-19] Mixed valid + stale order in batch Pickup skips stale order safely',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            allowConsoleErrors: true,
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-9401',
                resi: 'RS-94010001',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG'
              });
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-9402',
                resi: 'RS-94020002',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG'
              });
            }
          },
          async ({ page, runtime }) => {
            await selectQueueRow(page, '#view-pickup', 'ORD-261118-9401');
            await selectQueueRow(page, '#view-pickup', 'ORD-261118-9402');

            // Simulate another operator confirming ord2 with yesterday's inbound_date before Page 1 submits
            const earlierDate = getBangkokDateYmd(-1);
            runtime.invoke('apiConfirmPickup', {
              orderIds: ['ORD-261118-9402'],
              current_hub: 'HUB-JKT',
              inbound_date: earlierDate,
              courier: 'OtherOp'
            });

            await page.locator('#pickup-date').fill(getBangkokDateYmd(0));
            await page.locator('#pickup-courier').fill('BatchOp1');
            await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(page, /1|skip|transit|confirmed|partial/i);

            const orders = getSheetTable(runtime, 'db_orders').rows;
            const r1 = orders.find((r) => r.order_id === 'ORD-261118-9401');
            const r2 = orders.find((r) => r.order_id === 'ORD-261118-9402');
            assert.equal(r1.status, 'Transit');
            assert.equal(normalizeYmd(r1.inbound_date), getBangkokDateYmd(0));
            assert.equal(r2.status, 'Transit');
            assert.equal(normalizeYmd(r2.inbound_date), earlierDate, 'Stale order inbound_date must not be overwritten');

            const ord2Logs = getSheetTable(runtime, 'op_logs').rows.filter((l) => l.order_id === 'ORD-261118-9402');
            assert.equal(ord2Logs.length, 1, 'Stale ord2 must not receive a duplicate Pickup log');
          }
        )
    },
    {
      name: 'T2-BATCH-03 [F-19] Optimistic concurrency conflict across 2 tabs rejects stale Tab B pickup',
      fn: () =>
        runSession(
          {
            view: 'pickup',
            allowConsoleErrors: true,
            mutateSnapshot: (snap) => {
              appendOrderToSnapshot(snap, {
                order_id: 'ORD-261118-9403',
                resi: 'RS-94030003',
                status: 'Pending Pickup',
                current_hub: 'HUB-JKT',
                destination_hub: 'HUB-BDG'
              });
            }
          },
          async ({ page: pageA, openExtraPage, runtime }) => {
            const pageB = await openExtraPage('pickup');

            await pageA.locator('#pickup-scan-input').fill('ORD-261118-9403');
            await selectQueueRow(pageA, '#view-pickup', 'ORD-261118-9403');
            await pageA.locator('#pickup-courier').fill('OpA');

            await pageB.locator('#pickup-scan-input').fill('ORD-261118-9403');
            await selectQueueRow(pageB, '#view-pickup', 'ORD-261118-9403');
            await pageB.locator('#pickup-courier').fill('OpB');

            await performRpcAction(pageA, () => pageA.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(pageA, /transit|confirmed|picked up|1/i);

            await performRpcAction(pageB, () => pageB.locator('#btn-confirm-pickup-batch').click());
            await waitForFeedback(pageB, /already|skip|status|conflict|no .*updated|0|error/i);

            const logs = getSheetTable(runtime, 'op_logs').rows.filter((l) => l.order_id === 'ORD-261118-9403');
            assert.equal(logs.length, 1);
            assert.equal(logs[0].courier, 'OpA');
          }
        )
    },
    {
      name: 'T2-REPORT-01 [F-10, F-21] order_report sync preserves L1:M1 ARRAYFORMULA and A1:M1 headers',
      fn: () =>
        runSession({ view: 'dashboard' }, async ({ page, runtime }) => {
          const beforeFormulas = getSheetFormulas(runtime, 'order_report');
          const beforeHeaders = getSheetTable(runtime, 'order_report').headers;
          const l1Before = beforeFormulas[0]?.[11];
          const m1Before = beforeFormulas[0]?.[12];

          await performRpcAction(page, () => page.locator('#btn-sync-report').click());
          await waitForToast(page, /sync/i);

          const afterFormulas = getSheetFormulas(runtime, 'order_report');
          const afterHeaders = getSheetTable(runtime, 'order_report').headers;
          assert.deepEqual(afterHeaders, beforeHeaders);
          assert.equal(afterFormulas[0]?.[11], l1Before);
          assert.equal(afterFormulas[0]?.[12], m1Before);
        })
    },
    {
      name: 'T2-REPORT-02 [F-10] order_report sync clears excess stale rows in A:K ONLY while keeping L1:M1',
      fn: () =>
        runSession(
          {
            view: 'dashboard',
            mutateSnapshot: (snap) => {
              const orders = [
                [...EXPECTED_ORDER_HEADERS],
                ['ORD-R1', 'RS-10000001', 'SHP-01', '', 'Pending Pickup', 'HUB-JKT', 'Jl. 1', 'HUB-BDG', '', ''],
                ['ORD-R2', 'RS-10000002', 'SHP-02', '', 'Delivered', 'HUB-BDG', 'Jl. 2', 'HUB-BDG', '2026-11-10', '2026-11-12'],
                ['ORD-R3', 'RS-10000003', 'SHP-03', '', 'Transit', 'HUB-SUB', 'Jl. 3', 'HUB-JKT', '2026-11-15', ''],
                ['ORD-R4', 'RS-10000004', 'SHP-04', '', 'On Shipment', 'HUB-JKT', 'Jl. 4', 'HUB-JKT', '2026-11-16', ''],
                ['ORD-R5', 'RS-10000005', 'SHP-01', 1, 'Returned', 'HUB-BDG', 'Jl. 5', 'HUB-BDG', '2026-11-10', '2026-11-14']
              ];
              setSnapshotSheetGrid(snap, 'db_orders', orders);

              const existingReport = getSnapshotSheetGrid(snap, 'order_report');
              const header = existingReport?.[0] || [
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
                '=ARRAYFORMULA(IFS(ROW(J:J)=1, "Aging Parcel"))',
                '=ARRAYFORMULA(IFS(ROW(J:J)=1, "Aging Type"))'
              ];
              const staleRows = [header];
              for (let i = 1; i <= 21; i++) {
                staleRows.push([
                  `STALE-${i}`,
                  `RS-999900${String(i).padStart(2, '0')}`,
                  'Stale Shipper',
                  'Stale Addr',
                  'Pending Pickup',
                  '',
                  'Jakarta Central Hub',
                  'Bandung West Hub',
                  'Stale Dest',
                  '',
                  '',
                  String(i),
                  'Under SLA'
                ]);
              }
              setSnapshotSheetGrid(snap, 'order_report', staleRows);
            }
          },
          async ({ page, runtime }) => {
            const beforeFormulas = getSheetFormulas(runtime, 'order_report');
            const l1Before = beforeFormulas[0]?.[11];
            const m1Before = beforeFormulas[0]?.[12];

            await performRpcAction(page, () => page.locator('#btn-sync-report').click());
            await waitForToast(page, /5|sync/i);

            const afterTable = getSheetTable(runtime, 'order_report');
            const syncedOrderRows = afterTable.rows.filter((r) => String(r.order_id || '').trim() !== '');
            assert.equal(syncedOrderRows.length, 5, 'Synced order_report must contain exactly 5 order rows');
            assert.equal(afterTable.raw.length, 22, 'Cached L:M values must keep raw grid length at 22 rows');
            for (let r = 6; r < afterTable.raw.length; r++) {
              const aToK = afterTable.raw[r].slice(0, 11);
              assert.ok(
                aToK.every((cell) => cell === '' || cell === null || cell === undefined),
                `Stale row ${r + 1} cols A:K must be cleared`
              );
              assert.equal(
                String(afterTable.raw[r][11]),
                String(r),
                `Stale row ${r + 1} col L cached value must be preserved`
              );
              assert.equal(
                afterTable.raw[r][12],
                'Under SLA',
                `Stale row ${r + 1} col M cached value must be preserved`
              );
            }

            const afterFormulas = getSheetFormulas(runtime, 'order_report');
            assert.equal(afterFormulas[0]?.[11], l1Before);
            assert.equal(afterFormulas[0]?.[12], m1Before);
          }
        )
    },
    {
      name: 'T2-LOGS-01 [F-22] op_logs auto-created when absent and appends sequentially without overwriting',
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
              shipperId: 'SHP-01',
              currentHub: 'HUB-JKT',
              destinationHub: 'HUB-BDG',
              address: 'Jl. Auto OpLogs Test 1',
              courier: 'OpCreate',
              notes: 'First log'
            });

            const afterCreate = getSheetTable(runtime, 'op_logs');
            assert.equal(afterCreate.exists, true);
            assert.deepEqual(afterCreate.headers.slice(0, 10), EXPECTED_OP_LOG_HEADERS);
            assert.equal(afterCreate.rows.length, 1);
            assert.equal(afterCreate.rows[0].order_id, orderId);

            await navigateToView(page, 'pickup');
            await page.locator('#pickup-scan-input').fill(orderId);
            await selectQueueRow(page, '#view-pickup', orderId);
            await page.locator('#pickup-courier').fill('OpPickup');
            await page.locator('#pickup-notes').fill('Second log');
            await performRpcAction(page, () => page.locator('#btn-confirm-pickup-batch').click());
            await waitForToast(page, /transit|picked up|confirmed|1/i);

            const afterPickup = getSheetTable(runtime, 'op_logs');
            assert.equal(afterPickup.rows.length, 2);
            assert.equal(afterPickup.rows[0].order_id, orderId);
            assert.equal(afterPickup.rows[0].notes, 'First log');
            assert.equal(afterPickup.rows[1].order_id, orderId);
            assert.equal(afterPickup.rows[1].notes, 'Second log');
          }
        )
    }
  ];
}

export const tier = 2;
export const title = 'Tier 2 — Boundary, Negative & Error-Handling Cases';
export const tests = makeTests(null);
export function getTests(sharedBrowserGetter) {
  return makeTests(sharedBrowserGetter);
}
