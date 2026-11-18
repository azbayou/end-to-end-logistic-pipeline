# Logistic Performance Xpress — Google Apps Script Operations & Dashboard Suite

An end-to-end **Google Apps Script (GAS) Web Application** (`src/`) backed by Google Sheet `1vTtD4qf38J5h8SSME7Enq-r_vTV563hNmUaHrv0IePU` (*End-to-End Logistics Data Pipeline & Interactive Operations Dashboard*), featuring a live analytics dashboard and four operational workflow pages (**Input Data**, **Pickup**, **Sort**, and **Delivery**).

---

## Architecture & Data Contracts

| Sheet Tab | Range | Purpose |
|---|---|---|
| `db_orders` | `A1:J` | **Strict BigQuery (`dummy-504213`) schema preserved** — `order_id`, `resi`, `shipper_id`, `return_flag`, `status`, `current_hub`, `destination_address`, `destination_hub`, `inbound_date`, `end_date`. Columns `A:C` are immutable after creation; legacy `SHP-00x` IDs are normalized to `SHP-0x` on read without mutating historical rows. |
| `db_shippers` | `A1:C` | Master shipper directory (`shipper_id`, `shipper_name`, `pickup_address`). |
| `op_logs` | `A1:J` | **Auto-created on first operational write.** Stores audit trail (`log_id`, `timestamp`, `order_id`, `action`, `from_status`, `to_status`, `current_hub`, `courier`, `notes`, `operator_email`). |
| `order_report` | `A1:M` | Synced on demand via **Sync `order_report`** (`A2:K` updated, excess stale rows cleared in `A:K` only, preserving row 1 headers and `L1:M1` `ARRAYFORMULA`s). |

### Operational State Machine
- **Input Data (`createOrder`)**: Validates shipper, hubs (`HUB-JKT`, `HUB-BDG`, `HUB-SUB`), and destination address (`>= 5` chars); generates unique `ORD-YYMMDD-XXXX` and `RS-XXXXXXXX` under `LockService.getScriptLock()` with initial status `Pending Pickup`.
- **Pickup (`confirmPickup`)**: Single or batch `Pending Pickup -> Transit`, sets `inbound_date` (`yyyy-MM-dd` in `Asia/Bangkok`), optional hub override, logs to `op_logs`.
- **Sort (`processSort`)**: Filters `Transit` orders into *Ready for Last-Mile* (`current_hub == destination_hub`), *Inter-Hub Linehaul* (`!=`), and *Flagged / RTS* (`return_flag == 1`). Supports:
  - `TRANSFER_HUB`: updates `current_hub` while staying `Transit`
  - `DISPATCH_DELIVERY`: `Transit -> On Shipment` (triggers cross-hub confirmation modal if `current_hub != destination_hub`)
  - `FLAG_RETURN`: sets `return_flag = 1`
- **Delivery (`processDelivery`)**:
  - `MARK_DELIVERED`: `On Shipment -> Delivered`, sets `end_date`, clears `return_flag`
  - `FAILED_RTS`: `On Shipment -> Transit`, sets `return_flag = 1`, clears `end_date`
  - `MARK_RETURNED`: `On Shipment` or flagged `Transit` (`return_flag == 1`) `-> Returned`, sets `return_flag = 1` and `end_date`

---

## Deploying to a New Standalone Google Apps Script Project

> **Why Standalone?** Because your Google Sheet (`1vTtD4qf38J5h8SSME7Enq-r_vTV563hNmUaHrv0IePU`) already has an existing bound script (`Source!B2`), creating a **Standalone** Apps Script project keeps your previous project untouched. `SheetRepo.gs` automatically connects to the spreadsheet using `SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)`.

### Option A — Deploy via `clasp` CLI (Recommended)
1. Enable the **Google Apps Script API** in your Google account settings:
   `https://script.google.com/home/usersettings`
2. Clone the repository to your local machine and enter the directory:
   ```bash
   git clone https://github.com/azbayou/end-to-end-logistic-pipeline.git "/home/bay/Documents/End to end Logistic Pipeline"
   cd "/home/bay/Documents/End to end Logistic Pipeline"
   ```
3. Install `clasp` globally if needed and authenticate with the Google account that owns/edits the target Google Sheet:
   ```bash
   npm install -g @google/clasp
   clasp login
   ```
4. Create a **brand-new Standalone Apps Script project** (do not overwrite `.clasp.json` with an old Script ID), restore our manifest (`src/appsscript.json`), verify all 9 files in `src/` are tracked, and push:
   ```bash
   clasp create --type standalone --title "Logistic Performance Xpress" --rootDir src
   git checkout -- src/appsscript.json
   clasp status
   clasp push -f
   ```
   *(Alternatively, if you already created the blank standalone project in `https://script.google.com`, copy `.clasp.json.example` to `.clasp.json`, paste the **new** Script ID, and run `clasp status && clasp push -f`.)*
5. Open the Apps Script project in browser and deploy the Web App:
   ```bash
   clasp open-script
   ```
   Then click **Deploy -> New deployment -> Web app**:
   - **Execute as**: `Me`
   - **Who has access**: `Anyone` (`ANYONE_ANONYMOUS` in `src/appsscript.json`)
   - Authorize the Spreadsheet access prompt on first deploy/run.

### Option B — Manual Copy-Paste in a New Standalone Project
1. Go to `https://script.google.com` -> **New project** (this creates a standalone project separate from the sheet's old script).
2. In **Project Settings**, enable **Show "appsscript.json" manifest file in editor** and replace its contents with `src/appsscript.json`.
3. Create/replace the following script files (`.gs`):
   - `Config.gs` <- `src/Config.gs`
   - `SheetRepo.gs` <- `src/SheetRepo.gs`
   - `OperationsService.gs` <- `src/OperationsService.gs`
   - `DashboardService.gs` <- `src/DashboardService.gs`
   - `WebApp.gs` <- `src/WebApp.gs`
4. Create the following HTML files (omit `.html` when naming in the Apps Script UI):
   - `Index` <- `src/Index.html`
   - `Styles` <- `src/Styles.html`
   - `Scripts` <- `src/Scripts.html`
5. Click **Deploy -> New deployment -> Web app**, set **Execute as: Me** and **Who has access: Anyone**, authorize Spreadsheet permissions, and deploy.
   - Deep-link views are supported via `?view=dashboard`, `?view=input`, `?view=pickup`, `?view=sort`, and `?view=delivery`.

---

## Local Verification & Development

The `test/gas-mock/` harness executes the unmodified `src/*.gs` files inside a `node:vm` Apps Script runtime seeded from `test/fixtures/sheet_snapshot.json`, and runs headless Chromium Playwright E2E tests against `devServer.js`.

```bash
# Run unit tests (Config, SheetRepo, OperationsService, DashboardService, WebApp)
npm run test:unit

# Run full Playwright E2E suite (82 tests across Tiers 1-4)
npm run test:e2e

# Start local dev server manually (http://127.0.0.1:3000 by default or random port)
npm run dev
```
