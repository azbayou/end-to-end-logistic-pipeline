# E2E Test Suite Ready (`TEST_READY.md`)

**Status**: READY FOR FINAL E2E EXECUTION (`M6`)  
**Track**: E2E Testing Track (`teamwork_sub_orchestrator`)  
**Specification**: `/home/antigravity/TEST_INFRA.md`  
**Verification Gate**: Iteration 2 **PASS** — Reviewer 1 (`APPROVE`), Reviewer 2 (`APPROVE`), Challenger 1 (`PASS`), Challenger 2 (`PASS`), Auditor (`CLEAN`).

---

## 1. Suite Inventory (`82` Requirement-Driven Opaque-Box E2E Tests)

| File | Tier | Count | Coverage Summary |
|---|---|---|---|
| `test/e2e/helpers.mjs` | Harness | — | `checkPrerequisites()`, lazy `playwright-core` + `devServer.js` imports, per-test temp `sheet_snapshot.json` cloning (`os.tmpdir()/e2e-snap-*`), `/usr/bin/chromium` (`--no-sandbox`), `pageerror`/`console.error` gates, event-driven waits (zero `waitForTimeout`), dynamic `computeExpectedDashboard` oracle, BigQuery 10-col `A:J` guard, `PROJECT.md § 5` DOM helpers. |
| `test/e2e/tier1_features.mjs` | Tier 1 | **34** | Happy-path coverage across all 6 functional areas: Dashboard (`T1-DASH-01..06`), Input Data (`T1-INPUT-01..05`), Pickup (`T1-PICKUP-01..05`), Sort (`T1-SORT-01..06`), Delivery (`T1-DELIV-01..06`), Sync/Shell/Logs (`T1-SHELL-01..06`) — covers every feature `F-01`..`F-22`. |
| `test/e2e/tier2_boundaries.mjs` | Tier 2 | **33** | Boundary, negative & error-handling coverage: Input validation (`T2-INPUT-01..05`), Scan & State preconditions (`T2-STATE-01..06`), Cross-Hub Confirmation Modal (`T2-MODAL-01..05`), Legacy `SHP-00x` & BigQuery `A:J` schema (`T2-LEGACY-01..05`), Dashboard SLA `< 8` vs `>= 8` & `0/0` rates (`T2-DASH-B01..06`), Batch/Concurrency/Report/Logs (`T2-BATCH-01..03`, `T2-REPORT-01..02`, `T2-LOGS-01`). |
| `test/e2e/tier3_cross_feature.mjs` | Tier 3 | **10** | Pairwise cross-feature integrations (`T3-01`..`T3-10`): Input -> Pickup/Dashboard, Pickup -> Sort Ready/Linehaul, Sort Flag Return -> Delivery -> Return Rate, Delivery Failed RTS -> Sort Flagged -> Mark Returned, `order_report` sync preserving `L1:M1` `ARRAYFORMULA`s, High Aging quick-jump, `op_logs` auto-creation & 5-step audit trail, `?view=` deep-links + `#btn-refresh-all`, multi-dim filters, and cross-tab optimistic concurrency. |
| `test/e2e/tier4_workloads.mjs` | Tier 4 | **5** | Full multi-step operational workloads (`T4-W1`..`T4-W5`): Intra-city same-hub lifecycle, Multi-hub linehaul + cross-hub modal guard, Failed delivery RTS + terminal return, High Aging Over-SLA triage, and Batch ops + `order_report` sync + `page.reload()` persistence. |
| `test/e2e/run.mjs` | Runner | **82 total** | CLI entrypoint supporting `--tier=1\|2\|3\|4`, `--filter=<substring>`, `--help`/`-h`, strict preflight check (exits `1` with structured diagnostic if M1–M4 artifacts are missing), shared Chromium execution, and isolated `E2E_ISOLATE_BROWSER=1` mode. |

---

## 2. How to Run (`M6` Final E2E Gate)

Once Implementation Track milestones `M1`–`M4` (`src/Index.html`, `src/WebApp.gs`, `src/*.gs`, `test/gas-mock/devServer.js`, `test/fixtures/sheet_snapshot.json`, `playwright-core`) are in place:

```bash
# Run full Tier 1–4 E2E suite (82 tests)
node /home/antigravity/test/e2e/run.mjs

# Run a single tier or filter
node /home/antigravity/test/e2e/run.mjs --tier=1
node /home/antigravity/test/e2e/run.mjs --tier=3,4
node /home/antigravity/test/e2e/run.mjs --filter=T4-W2
```

- **Expected Pre-M4 Behavior**: While `src/Index.html` and `src/WebApp.gs` are still being built by `M4`, `node test/e2e/run.mjs` exits `1` with a clear structured diagnostic listing missing `[M4]` artifacts.
- **Fixture Safety**: `test/fixtures/sheet_snapshot.json` is never mutated; each test clones it to an isolated `os.tmpdir()/e2e-snap-*` file and cleans up in `finally`.
