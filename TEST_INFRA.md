# Test Infrastructure Specification (`TEST_INFRA.md`)

**Track**: E2E Testing Track (`teamwork_sub_orchestrator`)  
**Scope**: Requirement-driven, opaque-box Playwright headless Chromium E2E test suite for **Logistic Performance Xpress** (Google Apps Script Web App + local GAS emulator).  
**Primary Grounding**:
- `/home/antigravity/.agents/teamwork/ORIGINAL_REQUEST.md`
- `/home/antigravity/PROJECT.md` (`§ Feature Inventory F-01..F-22`, `§ Interface Contracts`)
- `/home/antigravity/.agents/teamwork/teamwork_preview_spec_miner_survey_2/handoff.md`

---

## 1. System Under Test (SUT) & Harness Architecture

- **Emulator Server**: `test/gas-mock/devServer.js` exporting `startDevServer({ port, snapshotPath })` -> `{ server, url, port, runtime, close() }`.
  - Runs unmodified `src/*.gs` inside `node:vm` (`test/gas-mock/gasRuntime.js`) with isolated in-memory Spreadsheet tables, `LockService`, `Utilities.formatDate` (`Asia/Bangkok`), `Session.getActiveUser()`, and `HtmlService`.
  - Serves `GET /` and `GET /?view=dashboard|input|pickup|sort|delivery` and shims `window.google.script.run` over `POST /__gas_rpc`.
- **Browser Engine**: `playwright-core` launching `/usr/bin/chromium` with `{ headless: true, args: ['--no-sandbox'] }`.
- **Data Isolation**:
  - Never mutate `test/fixtures/sheet_snapshot.json`.
  - Every isolated test / scenario clones `test/fixtures/sheet_snapshot.json` to a temporary file inside `fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-snap-'))`, passes that `snapshotPath` to `startDevServer({ port: 0, snapshotPath })`, and deletes the temp directory in `finally` after `await dev.close()` and `await browser.close()`.
- **Parallel Build Guard (Pre-M4 Readiness)**:
  - `test/e2e/run.mjs` checks prerequisite paths (`test/gas-mock/devServer.js`, `test/fixtures/sheet_snapshot.json`, `src/Index.html`, and `playwright-core` resolution).
  - If any prerequisite is missing because Implementation Track milestones `M1`..`M4` are still in progress, `run.mjs` prints a structured diagnostic listing the missing artifact(s) and exits non-zero (`process.exitCode = 1`).
- **Command to Run**:
  - `node test/e2e/run.mjs` (supports optional `--tier=1|2|3|4` and `--filter=<substring>`).
  - All test modules use ESM (`.mjs`) and Node's built-in `node:assert/strict` (no extra test framework dependency required beyond `playwright-core`).

---

## 2. File Layout (`test/e2e/`)

| File | Purpose |
|---|---|
| `test/e2e/helpers.mjs` | Prerequisite preflight check, temp snapshot cloning, `startDevServer({ port: 0 })` lifecycle, Chromium launch/context helpers, `pageerror`/`console.error` capture, DOM interaction helpers strictly using `PROJECT.md § 5` selectors, sheet inspection helpers via `dev.runtime.getSheetData(...)`, and lightweight test runner utilities. |
| `test/e2e/tier1_features.mjs` | **Tier 1 — Feature Coverage**: >= 5 isolated happy-path tests per major feature area (Dashboard, Input Data, Pickup, Sort, Delivery, Sync & Audit Logs), covering `F-01`..`F-22`. |
| `test/e2e/tier2_boundaries.mjs` | **Tier 2 — Boundary & Corner Cases**: >= 5 boundary/negative/error-handling tests per major area (validation failures, terminal state rejections, cross-hub modal cancel vs proceed, `SHP-00x` normalization, SLA `< 8` vs `>= 8` vs `Not Inbounded`, `0/0` empty filter rates, duplicate/skipped batch actions, BigQuery `db_orders` `A:J` guard). |
| `test/e2e/tier3_cross_feature.mjs` | **Tier 3 — Cross-Feature Combinations**: Pairwise integration scenarios across pages, Dashboard live recalculation, `op_logs` auto-creation/appending, and `order_report` sync preserving `L1:M1` `ARRAYFORMULA`s. |
| `test/e2e/tier4_workloads.mjs` | **Tier 4 — Real-World Application Scenarios**: >= 5 full end-to-end multi-step logistics operational workloads with KPI/chart/table/log verification. |
| `test/e2e/run.mjs` | Main CLI entrypoint executing Tiers 1–4 sequentially or filtered, reporting per-tier pass/fail summaries, and exiting `0` only if all executed tests pass with zero uncaught page errors. |

---

## 3. Opaque-Box Contract & DOM Selector Surface

Tests interact with the application strictly as a real user through the UI DOM IDs defined in `PROJECT.md § 5`:
- **Navigation & Views**: `#nav-dashboard`, `#nav-input`, `#nav-pickup`, `#nav-sort`, `#nav-delivery`; `#view-dashboard`, `#view-input`, `#view-pickup`, `#view-sort`, `#view-delivery`; URL query `?view=dashboard|input|pickup|sort|delivery`.
- **Global Actions & Feedback**: `#btn-refresh-all`, `#btn-sync-report`, `#toast-container`.
- **Dashboard KPIs & Filters**: `#kpi-total-orders`, `#kpi-delivered-rate`, `#kpi-active-shipments`, `#kpi-return-rate`, `#kpi-avg-delivery-time`; `#filter-date-from`, `#filter-date-to`, `#filter-hub`, `#filter-status`, `#filter-shipper`, `#filter-sla`, `#filter-search`, `#btn-reset-filters`.
- **Input Data**: `#form-create-order`, `#input-shipper-id`, `#input-current-hub`, `#input-destination-hub`, `#input-destination-address`, `#input-courier`, `#input-notes`, `#btn-submit-order`.
- **Pickup**: `#pickup-scan-input`, `#pickup-hub-filter`, `#pickup-confirm-hub`, `#pickup-date`, `#pickup-courier`, `#pickup-notes`, `#btn-confirm-pickup-batch`.
- **Sort**: `#sort-scan-input`, `#sort-hub-filter`, `#sort-tab-ready`, `#sort-tab-linehaul`, `#sort-tab-flagged`, `#sort-target-hub`, `#sort-courier`, `#sort-notes`, `#btn-sort-transfer`, `#btn-sort-dispatch`, `#btn-sort-flag-return`.
- **Delivery**: `#delivery-scan-input`, `#delivery-hub-filter`, `#delivery-date`, `#delivery-courier`, `#delivery-notes`, `#btn-delivery-delivered`, `#btn-delivery-failed-rts`, `#btn-delivery-returned`.
- **Cross-Hub Confirmation Modal**: `#confirm-modal`, `#btn-confirm-modal-proceed`, `#btn-confirm-modal-cancel`.

For persistence assertions not directly visible in UI (e.g. `db_orders` strictly remaining 10 columns `A:J`, `op_logs` schema & contents, and `order_report!L1:M1` formula preservation), tests inspect `runtime.getSheetData(...)` through the server fixture returned by `startDevServer`.

---

## 4. Feature Coverage Matrix (`F-01` .. `F-22`)

| Feature ID | Feature | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---|---|---|---|---|
| F-01 | Live KPI Summary Cards (5 KPIs) | X | X | X | X |
| F-02 | Multi-Dimensional Filtering | X | X | X | X |
| F-03 | Order Status Breakdown Chart | X | X | X | X |
| F-04 | Volume per Hub Chart (`current_hub`/`destination_hub` toggle) | X | X | X | X |
| F-05 | Return Rate by Destination Hub Chart | X | X | X | X |
| F-06 | Shipper Breakdown & Volume per Shipper | X | X | X | X |
| F-07 | Return Rate by Shipper Chart | X | X | X | X |
| F-08 | SLA by Hub Chart (`Not Inbounded`, `Under SLA`, `Over SLA`) | X | X | X | X |
| F-09 | High Aging Monitoring Table + quick-jump | X | X | X | X |
| F-10 | Live Refresh & `order_report` Sync (`L1:M1` preserved) | X | X | X | X |
| F-11 | Input Data — Create Order Form | X | X | X | X |
| F-12 | Input Data — Validation & Uniqueness | X | X | — | — |
| F-13 | Pickup — Queue & Scan/Search | X | X | X | X |
| F-14 | Pickup — Confirm Pickup / Inbound | X | X | X | X |
| F-15 | Sort — Hub Queues & Scan/Search | X | X | X | X |
| F-16 | Sort — Transfer, Dispatch & Flag Return | X | X | X | X |
| F-17 | Delivery — Out-for-Delivery Queue | X | X | X | X |
| F-18 | Delivery — Delivered / Failed RTS / Returned | X | X | X | X |
| F-19 | Concurrency Locking & Preconditions | X | X | X | — |
| F-20 | Responsive EN WebApp Shell (`?view=...`, nav, toasts) | X | X | X | X |
| F-21 | BigQuery Schema Guard (`A:J`) & `SHP-00x` Normalization | X | X | X | X |
| F-22 | `op_logs` Operational Audit Trail | X | X | X | X |

---

## 5. Verification & Gate Policy

1. **Syntax & Static Verification**: `node --check` passes on every `test/e2e/*.mjs` file.
2. **Requirement & Contract Audit**: Every test uses only documented DOM IDs (`PROJECT.md § 5`) and requirement behavior (`ORIGINAL_REQUEST.md`, `PROJECT.md`), with >= 5 tests per area in Tier 1 and Tier 2, pairwise coverage in Tier 3, and >= 5 multi-step operational scenarios in Tier 4.
3. **Smoke Verification (Pre-M4)**: Reviewers/Challengers verify `run.mjs` preflight failure diagnostic when SUT is absent AND smoke-test `test/e2e` harness logic against a temporary stub server in `mktemp -d` (deleted before reporting).
4. **Auditor Gate**: `teamwork_preview_auditor` audits `TEST_INFRA.md` and `test/e2e/**` and returns `CLEAN` before `TEST_READY.md` is published.
