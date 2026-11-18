# Project: Logistic Performance Xpress — Google Apps Script Operations & Dashboard Suite

## Overview
Build a Google Apps Script (GAS) Web Application (`src/`) backed by Google Sheet `1vTtD4qf38J5h8SSME7Enq-r_vTV563hNmUaHrv0IePU` (`End-to-End Logistics Data Pipeline & Interactive Operations Dashboard`), plus a local Node VM GAS emulator + Playwright headless browser E2E suite (`test/`), deployment documentation (`README.md`, `.clasp.json`), and a standalone `/generative_ui` interactive HTML dashboard preview artifact (`preview/dashboard_preview.html`).

### Confirmed Design Decisions (from `/grill-me` alignment)
1. **Strict BigQuery Schema Preservation**: `db_orders` (`A:J`) stays untouched for BigQuery (`dummy-504213`) compatibility. Extra operational metadata (`operator_email`, `courier`, `notes`, action timestamps) is written to a separate auto-created `op_logs` tab.
2. **`Sort` & `Delivery` Routing/Return Flows**:
   - `Sort` supports: (a) Hub transfer (`current_hub` update while `Transit`), (b) Last-mile dispatch (`Transit -> On Shipment`, requiring explicit confirmation/override if `current_hub != destination_hub`), and (c) Exception flag (`return_flag = 1`).
   - `Delivery` supports: (a) **Mark Delivered** (`On Shipment -> Delivered`, `end_date = today`, clears `return_flag`), (b) **Failed -> Return to Hub** (`On Shipment -> Transit` with `return_flag = 1`, `end_date` blank), and (c) **Mark Returned** (`On Shipment` or flagged `Transit` -> `Returned`, `return_flag = 1`, `end_date = today`).
3. **`order_report` Sync & Legacy `SHP-00x` Normalization**: Dashboard & operational queues read `db_orders` + `db_shippers` live (normalizing `SHP-00x -> SHP-0x` on read without mutating historical `db_orders` rows). Includes an optional **"Sync `order_report`"** utility that refreshes `order_report!A2:K` while strictly preserving `order_report!L1:M1` `ARRAYFORMULA`s.
4. **Language, Access & `/generative_ui`**: English-only (`EN`) UI matching spreadsheet labels/statuses, standard Web App (`Execute as: Me`), plus a standalone `/generative_ui` preview artifact (`preview/dashboard_preview.html`).

---

## Architecture
- **Data Layer (`db_orders`, `db_shippers`, `op_logs`, `order_report`)**:
  - `db_orders` (`A1:J`): `order_id`, `resi`, `shipper_id`, `return_flag`, `status`, `current_hub`, `destination_address`, `destination_hub`, `inbound_date`, `end_date`.
  - `db_shippers` (`A1:C`): `shipper_id`, `shipper_name`, `pickup_address`.
  - `op_logs` (`A1:J`, auto-created): `log_id`, `timestamp`, `order_id`, `action`, `from_status`, `to_status`, `current_hub`, `courier`, `notes`, `operator_email`.
  - `order_report` (`A1:M`): `A2:K` synced on demand; `L1` (`Aging Parcel`) and `M1` (`Aging Type`: `< 8` days = `Under SLA`, `>= 8` = `Over SLA`, blank `inbound_date` = `Not Inbounded`) `ARRAYFORMULA`s preserved.
- **GAS Backend (`src/*.gs`)**: Shared GAS V8 global scope (`Config.gs`, `SheetRepo.gs`, `OperationsService.gs`, `DashboardService.gs`, `WebApp.gs`), wrapped with `LockService.getScriptLock()` for all writes and optimistic status preconditions.
- **GAS Frontend (`src/Index.html`, `src/Styles.html`, `src/Scripts.html`)**: Single-page responsive HTML5/Vanilla CSS/Vanilla JS Web App using `<?!= include('...') ?>`, `google.script.run` RPCs, and zero-dependency inline SVG/Canvas charts.
- **Local Verification Harness (`test/gas-mock/`)**: `node:vm` GAS runtime executing unmodified `src/*.gs` against an in-memory Spreadsheet model seeded from `test/fixtures/sheet_snapshot.json` (exported from the real Google Sheet), paired with `devServer.js` (`node:http`) shimming `HtmlService` + `google.script.run` for `playwright-core` + `/usr/bin/chromium` E2E verification.

---

## Code Layout
```text
/home/antigravity/
├── PROJECT.md
├── TEST_INFRA.md                     # (E2E Testing Track)
├── TEST_READY.md                     # (E2E Testing Track)
├── README.md                         # Deployment guide (clasp + manual copy-paste)
├── .clasp.json                       # Template pointing rootDir: "src", scriptId from Source!B2
├── .claspignore                      # Excludes test/, preview/, node_modules/, docs
├── package.json                      # Scripts: test:unit, test:e2e, test, dev
├── src/                              # 100% pure GAS-native files (no require/module.exports)
│   ├── appsscript.json               # V8 runtime, Asia/Bangkok timezone, webapp config
│   ├── Config.gs                     # Sheet names, headers, hubs, statuses, SLA=8, date/id helpers
│   ├── SheetRepo.gs                  # SpreadsheetApp CRUD, LockService, SHP-00x norm, op_logs
│   ├── OperationsService.gs          # Input Data, Pickup, Sort, Delivery, syncOrderReport
│   ├── DashboardService.gs           # KPIs, 7 charts, High Aging table, multi-dim filters
│   ├── WebApp.gs                     # doGet(e), include(fn), api* RPC endpoints
│   ├── Index.html                    # EN shell: Dashboard, Input Data, Pickup, Sort, Delivery
│   ├── Styles.html                   # Vanilla CSS design system (responsive, accessible)
│   └── Scripts.html                  # State, google.script.run client, SVG/Canvas charts
├── preview/
│   └── dashboard_preview.html        # Standalone /generative_ui interactive dashboard preview
└── test/
    ├── fixtures/
    │   └── sheet_snapshot.json       # Real schema + sample/full snapshot from gsheets CLI
    ├── gas-mock/
    │   ├── gasRuntime.js             # node:vm loader + SpreadsheetApp/LockService/HtmlService mocks
    │   └── devServer.js              # HTTP server rendering Index.html + POST /__gas_rpc
    ├── unit/
    │   ├── sheetRepo.test.js         # M1 unit tests
    │   ├── operations.test.js        # M2 unit tests
    │   ├── dashboard.test.js         # M3 unit tests
    │   └── webapp.test.js            # M4 RPC & HTML render unit tests
    └── e2e/                          # (Owned by E2E Testing Track)
```

---

## Feature Inventory
Every Survey & user-requested feature assigned to a milestone (none unassigned):

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F-01 | Live KPI Summary Cards | 5 KPIs from live `db_orders` + `db_shippers`: Total Orders, Delivered Rate (%), Active Shipments, Return Rate (%), Average Delivery Time (days) | M3 (calc), M4 (UI) | `Prototype!B3:N4`, Spec Miner |
| F-02 | Multi-Dimensional Filtering | Filter KPIs, charts, and High Aging table by Date Range, Hub (`current_hub`/`destination_hub`), Status, Shipper, SLA Type, Search (`order_id`/`resi`) | M3 (calc), M4 (UI) | `Prototype` slicers, Spec Miner |
| F-03 | Order Status Breakdown Chart | Interactive Donut/Pie chart across 5 statuses (`Pending Pickup`, `Transit`, `On Shipment`, `Delivered`, `Returned`) | M3 (data), M4 (SVG) | `Prototype!B6` |
| F-04 | Volume per Hub Chart | Bar chart of volume by Hub (`HUB-JKT`, `HUB-BDG`, `HUB-SUB`) with `current_hub` / `destination_hub` toggle | M3 (data), M4 (SVG) | `Prototype!G6` |
| F-05 | Return Rate by Destination Hub Chart | Stacked bar/column chart of normal vs `return_flag=1` + return rate % per `destination_hub` | M3 (data), M4 (SVG) | `Prototype!M6` |
| F-06 | Shipper Breakdown & Volume per Shipper | Donut + Horizontal Bar charts joining normalized `shipper_id` to `db_shippers.shipper_name` | M3 (data), M4 (SVG) | `Prototype!B23, G23` |
| F-07 | Return Rate by Shipper Chart | Stacked chart of normal vs `return_flag=1` + return rate % per shipper | M3 (data), M4 (SVG) | `Prototype!M23` |
| F-08 | SLA by Hub Chart | Stacked column chart per hub: `Not Inbounded`, `Under SLA` (`< 8` days), `Over SLA` (`>= 8` days) | M3 (data), M4 (SVG) | `Prototype!G41`, `Pivot Table 1` |
| F-09 | High Aging Monitoring Table | Actionable table of active / `Over SLA` orders sorted by descending aging days with quick-jump to Sort/Delivery | M3 (data), M4 (UI) | `Prototype!B41` |
| F-10 | Live Refresh & `order_report` Sync | Manual Refresh + auto-refresh toggle + "Sync `order_report`" button updating `order_report!A2:K` while preserving `L1:M1` `ARRAYFORMULA`s | M2 (`syncOrderReport`), M4 (UI) | Survey 1 & 2, User Q3 |
| F-11 | Input Data — Create Order Form | Create order with Shipper dropdown (`db_shippers` + pickup address preview), Origin Hub, Destination Hub, Destination Address; auto `ORD-YYMMDD-XXXX`, `RS-XXXXXXXX`, `Pending Pickup` | M2 (service), M4 (UI) | `ORIGINAL_REQUEST`, Spec Miner |
| F-12 | Input Data — Validation & Uniqueness | Validate shipper existence, valid hub codes, address length >= 5, unique `order_id`/`resi` under `LockService` | M2 | Spec Miner |
| F-13 | Pickup — Queue & Scan/Search | Filterable `Pending Pickup` queue + `order_id`/`resi` scan/search + batch selection | M2 (query), M4 (UI) | `ORIGINAL_REQUEST`, Spec Miner |
| F-14 | Pickup — Confirm Pickup / Inbound | Single/batch `Pending Pickup -> Transit`, sets `inbound_date` (`yyyy-MM-dd` `Asia/Bangkok`), optional hub confirmation, logs `op_logs` | M2 (service), M4 (UI) | Spec Miner |
| F-15 | Sort — Hub Queues & Scan/Search | Filterable `Transit` queue split into Ready for Last-Mile (`current_hub == destination_hub`), Inter-Hub Linehaul (`!=`), and Flagged/RTS (`return_flag == 1`) | M2 (query), M4 (UI) | Spec Miner, User Q2 |
| F-16 | Sort — Transfer, Dispatch & Flag Return | (a) Update `current_hub`, (b) Dispatch `Transit -> On Shipment` (with cross-hub warning/confirmation), (c) Set `return_flag = 1`, log `op_logs` | M2 (service), M4 (UI) | Spec Miner, User Q2 |
| F-17 | Delivery — Out-for-Delivery Queue | Filterable `On Shipment` (+ flagged `Transit` RTS) queue with Aging SLA badges & scan/search | M2 (query), M4 (UI) | Spec Miner, User Q2 |
| F-18 | Delivery — Delivered / Failed RTS / Returned | Mark Delivered (`Delivered` + `end_date`), Failed -> Return to Hub (`Transit` + `return_flag=1`), Mark Returned (`Returned` + `return_flag=1` + `end_date`), log `op_logs` | M2 (service), M4 (UI) | Spec Miner, User Q2 |
| F-19 | Concurrency Locking & Preconditions | `LockService.getScriptLock()` + optimistic expected-status check on every write | M1 (`withScriptLock`), M2 (preconditions) | Spec Miner |
| F-20 | Responsive EN WebApp Shell | `doGet(e)` (`?view=...`) SPA shell with top nav (`Dashboard`, `Input Data`, `Pickup`, `Sort`, `Delivery`), toasts, error banners | M4 | User Q4 |
| F-21 | BigQuery Schema Guard & `SHP-00x` Norm | Preserve `db_orders` `A:J` strictly; normalize `SHP-00x -> SHP-0x` on read; `Asia/Bangkok` `yyyy-MM-dd` dates | M1 | Survey 1 & 2, User Q1 & Q3 |
| F-22 | `op_logs` Operational Audit Trail | Auto-create `op_logs` tab if missing; record `courier`, `notes`, `operator_email`, `from_status -> to_status`, `timestamp` on every op | M1 (`SheetRepo`), M2 (calls), M4 (UI) | User Q1 |
| F-23 | Standalone `/generative_ui` Preview | Interactive HTML dashboard preview (`preview/dashboard_preview.html`) using `gstatic` Tailwind + CSS semantic tokens + `themechange` + inline SVG/Canvas charts | M5 | User Q4, `generative_ui` |
| F-24 | Deployment Config & Guide | `.clasp.json`, `.claspignore`, `appsscript.json`, `README.md` with backup warning + `clasp` & manual copy-paste deployment steps | M1 (`.clasp*`/`appsscript.json`), M4 (`README.md`) | Survey 3 |

---

## Milestones

| # | Name | Scope | Dependencies | Status |
|---|---|---|---|---|
| M1 | `core_repo` | `package.json`, `.clasp.json`, `.claspignore`, `src/appsscript.json`, `src/Config.gs`, `src/SheetRepo.gs`, `test/fixtures/sheet_snapshot.json`, `test/gas-mock/gasRuntime.js`, `test/gas-mock/devServer.js`, `test/unit/sheetRepo.test.js` | none | IN_PROGRESS (`37a90cb0dda6f2b534dfb5d3ec5e3c6b`) |
| M2 | `ops_services` | `src/OperationsService.gs` (Input Data, Pickup, Sort, Delivery, `syncOrderReport`, `op_logs`, `LockService` preconditions) + `test/unit/operations.test.js` | M1 | PLANNED |
| M3 | `dashboard_analytics` | `src/DashboardService.gs` (5 KPIs, 7 Prototype charts, High Aging table, multi-dim filters) + `test/unit/dashboard.test.js` | M1 | PLANNED |
| M4 | `webapp_ui` | `src/WebApp.gs`, `src/Index.html`, `src/Styles.html`, `src/Scripts.html`, `README.md`, `test/unit/webapp.test.js` | M2, M3 | PLANNED |
| M5 | `generative_ui_preview` | `preview/dashboard_preview.html` (standalone `/generative_ui` interactive dashboard preview artifact verified in headless Chromium) | M3 | PLANNED |
| M6 | `final_e2e` | Pass 100% of E2E Testing Track suite (`TEST_READY.md`, Tiers 1–4) + Tier 5 Adversarial Coverage Hardening | M4, M5, E2E Track | PLANNED |

*(Parallel Track)*: **E2E Testing Track** (`E2E Testing Orchestrator`, conv ID `8191060cc6ddf9e2b71c4be5ce31cf44`) runs independently from `ORIGINAL_REQUEST.md` + `PROJECT.md` Interface Contracts to produce `TEST_INFRA.md`, `test/e2e/*` (Tiers 1–4), and `TEST_READY.md`.

---

## Interface Contracts

### 1. `Config.gs` (Global Constants & Pure Helpers)
- `CONFIG.SPREADSHEET_ID = '1vTtD4qf38J5h8SSME7Enq-r_vTV563hNmUaHrv0IePU'`
- `CONFIG.TIMEZONE = 'Asia/Bangkok'`
- `CONFIG.SLA_DAYS = 8`
- `CONFIG.SHEETS = { ORDERS: 'db_orders', SHIPPERS: 'db_shippers', REPORT: 'order_report', OP_LOGS: 'op_logs' }`
- `CONFIG.ORDER_HEADERS = ['order_id', 'resi', 'shipper_id', 'return_flag', 'status', 'current_hub', 'destination_address', 'destination_hub', 'inbound_date', 'end_date']`
- `CONFIG.OP_LOG_HEADERS = ['log_id', 'timestamp', 'order_id', 'action', 'from_status', 'to_status', 'current_hub', 'courier', 'notes', 'operator_email']`
- `CONFIG.STATUSES = { PENDING_PICKUP: 'Pending Pickup', TRANSIT: 'Transit', ON_SHIPMENT: 'On Shipment', DELIVERED: 'Delivered', RETURNED: 'Returned' }`
- `CONFIG.HUBS = { 'HUB-JKT': 'Jakarta Central Hub', 'HUB-BDG': 'Bandung West Hub', 'HUB-SUB': 'Surabaya East Hub' }`
- `normalizeShipperId(rawId)` -> normalizes `'SHP-001'` -> `'SHP-01'` (only when matching `/^SHP-0*(\d+)$/i`)
- `getHubName(hubCode)` -> returns `CONFIG.HUBS[hubCode] || hubCode`
- `formatDateYmd(dateOrStr)` -> `'yyyy-MM-dd'` in `Asia/Bangkok` (returns `''` for null/empty)
- `getTodayYmd()` -> current `'yyyy-MM-dd'` in `Asia/Bangkok`

### 2. `SheetRepo.gs` (Spreadsheet Persistence & Locking)
- `getActiveBook()` -> `SpreadsheetApp.getActiveSpreadsheet() || SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)`
- `withScriptLock(fn, timeoutMs)` -> acquires `LockService.getScriptLock().waitLock(timeoutMs || 10000)` and releases in `finally`
- `getShippers()` -> returns `Array<{ shipper_id, shipper_name, pickup_address }>`
- `getOrders(options)` -> reads `db_orders!A:J`, joins `db_shippers` via `normalizeShipperId(row.shipper_id)`, returns `Array<{ rowNumber, order_id, resi, shipper_id, normalized_shipper_id, shipper_name, pickup_address, return_flag, status, current_hub, current_hub_name, destination_address, destination_hub, destination_hub_name, inbound_date, end_date }>`
- `appendOrderRow(rowValues10)` -> appends 10-column row to `db_orders`
- `updateOrderFields(rowNumber, fieldMap)` -> updates specific cells (`return_flag`, `status`, `current_hub`, `inbound_date`, `end_date`) in `db_orders` row `rowNumber`
- `appendOpLog(entry)` -> creates `op_logs` sheet with `CONFIG.OP_LOG_HEADERS` if missing, appends 10-column row (`log_id`, `timestamp` ISO/Asia-Bangkok, `order_id`, `action`, `from_status`, `to_status`, `current_hub`, `courier`, `notes`, `operator_email`)
- `getOpLogs(limit)` -> returns recent `op_logs` objects (`[]` if tab absent)
- `writeOrderReportRows(rows11)` -> writes `rows11` (`A2:K{N+1}`) to `order_report` and clears excess rows below `N+1` in `A:K` ONLY (never overwrites row 1 `A1:M1` or `L:M` formulas)

### 3. `OperationsService.gs`
- `createOrder({ shipper_id, current_hub, destination_hub, destination_address, courier, notes })`
  - Returns `{ ok: true, order }` or `{ ok: false, error, code }`
- `confirmPickup({ orderIds, query, current_hub, inbound_date, courier, notes })`
  - Accepts `orderIds: string[]` (or single `query` matching `order_id` or `resi`)
  - Precondition: `status === 'Pending Pickup'`
  - Updates: `status = 'Transit'`, `current_hub`, `inbound_date = inbound_date || getTodayYmd()`
  - Returns `{ ok: true, updatedOrders, skipped }` or `{ ok: false, error, code }`
- `processSort({ orderIds, query, action, target_hub, force_cross_hub, courier, notes })`
  - `action` in `['TRANSFER_HUB', 'DISPATCH_DELIVERY', 'FLAG_RETURN']`
  - Precondition: `status === 'Transit'`
  - `DISPATCH_DELIVERY` when `current_hub !== destination_hub` and `!force_cross_hub` returns `{ ok: false, code: 'CROSS_HUB_CONFIRM_REQUIRED', error, mismatchOrders }`
  - Returns `{ ok: true, updatedOrders, skipped }` or `{ ok: false, error, code }`
- `processDelivery({ orderIds, query, action, end_date, courier, notes })`
  - `action` in `['MARK_DELIVERED', 'FAILED_RTS', 'MARK_RETURNED']`
  - `MARK_DELIVERED`: requires `status === 'On Shipment'`; sets `status = 'Delivered'`, `end_date = end_date || getTodayYmd()`, `return_flag = ''`
  - `FAILED_RTS`: requires `status === 'On Shipment'`; sets `status = 'Transit'`, `return_flag = 1`, `end_date = ''`
  - `MARK_RETURNED`: allows `status === 'On Shipment'` or (`status === 'Transit'` && `Number(return_flag) === 1`); sets `status = 'Returned'`, `return_flag = 1`, `end_date = end_date || getTodayYmd()`
  - Returns `{ ok: true, updatedOrders, skipped }` or `{ ok: false, error, code }`
- `syncOrderReport()` -> returns `{ ok: true, syncedCount, syncedAt }`

### 4. `DashboardService.gs`
- `computeOrderAging(order, refDateYmd)` -> `{ agingDays: number|null, agingType: 'Not Inbounded'|'Under SLA'|'Over SLA' }` (`agingDays < 8` -> `'Under SLA'`, `>= 8` -> `'Over SLA'`)
- `getDashboardData(filters)`
  - `filters`: `{ dateFrom?, dateTo?, hub?, hubScope?: 'current'|'destination'|'either', status?, shipperId?, slaType?, search? }`
  - Returns `{ ok: true, meta, kpis, charts, highAgingOrders, recentLogs }`

### 5. `WebApp.gs` & `Index.html` UI Contract
- `doGet(e)`: supports `?view=dashboard|input|pickup|sort|delivery` (default `dashboard`).
- `include(filename)`: returns `HtmlService.createHtmlOutputFromFile(filename).getContent()`.
- RPC Functions exposed for `google.script.run`:
  - `apiGetBootstrapData(filters)` -> `{ ok: true, dashboard, orders, shippers, hubs, statuses }`
  - `apiGetDashboardData(filters)`
  - `apiGetOrdersQueue(filters)`
  - `apiCreateOrder(payload)`
  - `apiConfirmPickup(payload)`
  - `apiProcessSort(payload)`
  - `apiProcessDelivery(payload)`
  - `apiSyncOrderReport()`
- **DOM IDs (for UI & E2E Tests)**:
  - Nav buttons: `#nav-dashboard`, `#nav-input`, `#nav-pickup`, `#nav-sort`, `#nav-delivery`
  - Views: `#view-dashboard`, `#view-input`, `#view-pickup`, `#view-sort`, `#view-delivery`
  - Global header actions: `#btn-refresh-all`, `#btn-sync-report`, `#toast-container`
  - Dashboard KPIs: `#kpi-total-orders`, `#kpi-delivered-rate`, `#kpi-active-shipments`, `#kpi-return-rate`, `#kpi-avg-delivery-time`
  - Dashboard Filters: `#filter-date-from`, `#filter-date-to`, `#filter-hub`, `#filter-status`, `#filter-shipper`, `#filter-sla`, `#filter-search`, `#btn-reset-filters`
  - Input Form: `#form-create-order`, `#input-shipper-id`, `#input-current-hub`, `#input-destination-hub`, `#input-destination-address`, `#input-courier`, `#input-notes`, `#btn-submit-order`
  - Pickup Page: `#pickup-scan-input`, `#pickup-hub-filter`, `#pickup-confirm-hub`, `#pickup-date`, `#pickup-courier`, `#pickup-notes`, `#btn-confirm-pickup-batch`
  - Sort Page: `#sort-scan-input`, `#sort-hub-filter`, `#sort-tab-ready`, `#sort-tab-linehaul`, `#sort-tab-flagged`, `#sort-target-hub`, `#sort-courier`, `#sort-notes`, `#btn-sort-transfer`, `#btn-sort-dispatch`, `#btn-sort-flag-return`
  - Delivery Page: `#delivery-scan-input`, `#delivery-hub-filter`, `#delivery-date`, `#delivery-courier`, `#delivery-notes`, `#btn-delivery-delivered`, `#btn-delivery-failed-rts`, `#btn-delivery-returned`
  - Confirmation Dialog (for cross-hub dispatch override): `#confirm-modal`, `#btn-confirm-modal-proceed`, `#btn-confirm-modal-cancel`

### 6. Local GAS Emulator (`test/gas-mock/`)
- `gasRuntime.js`: `createGasRuntime({ snapshotPath?, ordersRows?, shippersRows? })` loads `src/*.gs` in a fresh `node:vm` context with isolated in-memory Spreadsheet tables, `LockService`, `Utilities.formatDate`, `Session.getActiveUser()`, `HtmlService`, and exposes `invoke(fnName, ...args)` + `getSheetData(sheetName)`.
- `devServer.js`: `startDevServer({ port?, snapshotPath? })` serves `GET /` and `GET /?view=...` (evaluating `doGet(e)` and injecting `window.google.script.run` proxy over `POST /__gas_rpc`) and returns `{ server, url, port, runtime, close() }`.
