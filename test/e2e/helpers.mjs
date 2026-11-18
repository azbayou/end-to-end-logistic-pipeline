import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, '../..');
export const CHROMIUM_PATH = '/usr/bin/chromium';

export const EXPECTED_ORDER_HEADERS = [
  'order_id',
  'resi',
  'shipper_id',
  'return_flag',
  'status',
  'current_hub',
  'destination_address',
  'destination_hub',
  'inbound_date',
  'end_date'
];

export const EXPECTED_OP_LOG_HEADERS = [
  'log_id',
  'timestamp',
  'order_id',
  'action',
  'from_status',
  'to_status',
  'current_hub',
  'courier',
  'notes',
  'operator_email'
];

export const HUB_NAMES = {
  'HUB-JKT': 'Jakarta Central Hub',
  'HUB-BDG': 'Bandung West Hub',
  'HUB-SUB': 'Surabaya East Hub'
};

export const ACTIVE_STATUSES = new Set(['Pending Pickup', 'Transit', 'On Shipment']);

/**
 * Preflight check for M1-M4 artifacts and browser binaries.
 * Never statically imports playwright-core or devServer.js so missing
 * dependencies produce a clean structured diagnostic.
 */
export function checkPrerequisites({
  stubServerPath = process.env.E2E_STUB_DEV_SERVER,
  snapshotPathOverride = process.env.E2E_SNAPSHOT_PATH
} = {}) {
  const missing = [];
  const require = createRequire(import.meta.url);

  try {
    require.resolve('playwright-core', { paths: [REPO_ROOT, __dirname] });
  } catch {
    missing.push({
      artifact: 'node_modules/playwright-core',
      milestone: 'M1',
      reason: 'playwright-core package could not be resolved from repo root'
    });
  }

  if (!fs.existsSync(CHROMIUM_PATH)) {
    missing.push({
      artifact: CHROMIUM_PATH,
      milestone: 'ENV',
      reason: 'Chromium binary not found at /usr/bin/chromium'
    });
  }

  if (stubServerPath) {
    const resolvedStub = path.resolve(stubServerPath);
    if (!fs.existsSync(resolvedStub)) {
      missing.push({
        artifact: resolvedStub,
        milestone: 'STUB',
        reason: 'E2E_STUB_DEV_SERVER path does not exist'
      });
    }
    const snap = snapshotPathOverride
      ? path.resolve(snapshotPathOverride)
      : path.join(REPO_ROOT, 'test/fixtures/sheet_snapshot.json');
    if (!fs.existsSync(snap)) {
      missing.push({
        artifact: snap,
        milestone: 'M1/STUB',
        reason: 'Snapshot file not found (set E2E_SNAPSHOT_PATH or create test/fixtures/sheet_snapshot.json)'
      });
    }
  } else {
    const devServerPath = path.join(REPO_ROOT, 'test/gas-mock/devServer.js');
    if (!fs.existsSync(devServerPath)) {
      missing.push({
        artifact: 'test/gas-mock/devServer.js',
        milestone: 'M1',
        reason: 'GAS mock dev server not found'
      });
    }

    const snapPath = snapshotPathOverride
      ? path.resolve(snapshotPathOverride)
      : path.join(REPO_ROOT, 'test/fixtures/sheet_snapshot.json');
    if (!fs.existsSync(snapPath)) {
      missing.push({
        artifact: 'test/fixtures/sheet_snapshot.json',
        milestone: 'M1',
        reason: 'Sheet snapshot fixture not found'
      });
    }

    const indexHtmlPath = path.join(REPO_ROOT, 'src/Index.html');
    if (!fs.existsSync(indexHtmlPath)) {
      missing.push({
        artifact: 'src/Index.html',
        milestone: 'M4',
        reason: 'WebApp UI shell src/Index.html not found'
      });
    }

    const webAppGsPath = path.join(REPO_ROOT, 'src/WebApp.gs');
    if (!fs.existsSync(webAppGsPath)) {
      missing.push({
        artifact: 'src/WebApp.gs',
        milestone: 'M4',
        reason: 'WebApp GAS backend src/WebApp.gs not found'
      });
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    repoRoot: REPO_ROOT,
    chromiumPath: CHROMIUM_PATH
  };
}

export async function loadPlaywrightChromium() {
  const require = createRequire(import.meta.url);
  const resolved = require.resolve('playwright-core', { paths: [REPO_ROOT, __dirname] });
  const mod = await import(pathToFileURL(resolved).href);
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) {
    throw new Error('Could not load chromium export from playwright-core');
  }
  return chromium;
}

export async function launchChromiumBrowser() {
  const chromium = await loadPlaywrightChromium();
  return chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
}

async function loadDevServerStarter(stubServerPath) {
  const target = stubServerPath
    ? path.resolve(stubServerPath)
    : path.join(REPO_ROOT, 'test/gas-mock/devServer.js');
  const mod = await import(pathToFileURL(target).href);
  const startDevServer = mod.startDevServer ?? mod.default?.startDevServer ?? mod.default;
  if (typeof startDevServer !== 'function') {
    throw new Error(`startDevServer export not found in ${target}`);
  }
  return startDevServer;
}

/**
 * Normalizes snapshot structure so mutateSnapshot callbacks work regardless
 * of whether sheet_snapshot.json wraps sheets in `{ sheets: { ... } }` or
 * places sheet names at the top level.
 */
export function getSnapshotSheetsContainer(snapshotObj) {
  if (snapshotObj && typeof snapshotObj.sheets === 'object' && snapshotObj.sheets !== null) {
    return snapshotObj.sheets;
  }
  return snapshotObj;
}

export function getSnapshotSheetGrid(snapshotObj, sheetName) {
  const container = getSnapshotSheetsContainer(snapshotObj);
  const entry = container?.[sheetName];
  if (!entry) return null;
  if (Array.isArray(entry)) return entry;
  if (Array.isArray(entry.values)) return entry.values;
  if (Array.isArray(entry.data)) return entry.data;
  return null;
}

export function setSnapshotSheetGrid(snapshotObj, sheetName, grid) {
  const container = getSnapshotSheetsContainer(snapshotObj);
  const existing = container?.[sheetName];
  if (existing && !Array.isArray(existing) && typeof existing === 'object') {
    if (Array.isArray(existing.values)) {
      existing.values = grid;
      return;
    }
    if (Array.isArray(existing.data)) {
      existing.data = grid;
      return;
    }
  }
  container[sheetName] = grid;
}

export function deleteSnapshotSheet(snapshotObj, sheetName) {
  const container = getSnapshotSheetsContainer(snapshotObj);
  if (container && Object.prototype.hasOwnProperty.call(container, sheetName)) {
    delete container[sheetName];
  }
}

export function makeOrderRowArray({
  order_id,
  resi,
  shipper_id = 'SHP-01',
  return_flag = '',
  status = 'Pending Pickup',
  current_hub = 'HUB-JKT',
  destination_address = 'Jl. Test Address No. 1',
  destination_hub = 'HUB-JKT',
  inbound_date = '',
  end_date = ''
}) {
  return [
    order_id,
    resi,
    shipper_id,
    return_flag,
    status,
    current_hub,
    destination_address,
    destination_hub,
    inbound_date,
    end_date
  ];
}

export function appendOrderToSnapshot(snapshotObj, orderFields) {
  const grid = getSnapshotSheetGrid(snapshotObj, 'db_orders');
  if (!grid || grid.length === 0) {
    setSnapshotSheetGrid(snapshotObj, 'db_orders', [
      [...EXPECTED_ORDER_HEADERS],
      makeOrderRowArray(orderFields)
    ]);
    return;
  }
  const headers = grid[0];
  if (Array.isArray(headers)) {
    grid.push(makeOrderRowArray(orderFields));
  } else {
    grid.push({
      order_id: orderFields.order_id,
      resi: orderFields.resi,
      shipper_id: orderFields.shipper_id ?? 'SHP-01',
      return_flag: orderFields.return_flag ?? '',
      status: orderFields.status ?? 'Pending Pickup',
      current_hub: orderFields.current_hub ?? 'HUB-JKT',
      destination_address: orderFields.destination_address ?? 'Jl. Test Address No. 1',
      destination_hub: orderFields.destination_hub ?? 'HUB-JKT',
      inbound_date: orderFields.inbound_date ?? '',
      end_date: orderFields.end_date ?? ''
    });
  }
}

/**
 * Isolated per-test session:
 * - clones sheet_snapshot.json into os.tmpdir()
 * - optional mutateSnapshot(parsedSnapshot)
 * - boots startDevServer({ port: 0, snapshotPath })
 * - opens fresh Playwright BrowserContext (+ launches Chromium if no sharedBrowser)
 * - captures pageerror & console.error
 * - guarantees full cleanup in finally
 */
export async function withTestSession(optionsOrFn, maybeFn) {
  const options = typeof optionsOrFn === 'function' ? {} : (optionsOrFn || {});
  const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
  if (typeof fn !== 'function') {
    throw new Error('withTestSession requires a test callback function');
  }

  const {
    view = 'dashboard',
    mutateSnapshot = null,
    transformSnapshot = null,
    allowConsoleErrors = false,
    sharedBrowser = null,
    viewport = { width: 1280, height: 800 },
    skipInitialGoto = false
  } = options;

  const snapshotMutator = mutateSnapshot || transformSnapshot;
  const sourceSnapshotPath = process.env.E2E_SNAPSHOT_PATH
    ? path.resolve(process.env.E2E_SNAPSHOT_PATH)
    : path.join(REPO_ROOT, 'test/fixtures/sheet_snapshot.json');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-snap-'));
  const tmpSnapshotPath = path.join(tmpDir, 'sheet_snapshot.json');

  let dev = null;
  let browser = sharedBrowser;
  let ownsBrowser = !sharedBrowser;
  let context = null;

  const pageErrors = [];
  const consoleErrors = [];

  try {
    fs.copyFileSync(sourceSnapshotPath, tmpSnapshotPath);
    if (typeof snapshotMutator === 'function') {
      const parsed = JSON.parse(fs.readFileSync(tmpSnapshotPath, 'utf8'));
      const result = snapshotMutator(parsed) ?? parsed;
      fs.writeFileSync(tmpSnapshotPath, JSON.stringify(result, null, 2), 'utf8');
    }

    const startDevServer = await loadDevServerStarter(process.env.E2E_STUB_DEV_SERVER);
    dev = await startDevServer({ port: 0, snapshotPath: tmpSnapshotPath });
    const baseUrl = dev.url || `http://127.0.0.1:${dev.port}`;

    if (!browser) {
      browser = await launchChromiumBrowser();
      ownsBrowser = true;
    }

    context = await browser.newContext({ viewport });
    const page = await context.newPage();

    const attachErrorListeners = (targetPage) => {
      targetPage.on('pageerror', (err) => {
        pageErrors.push(err?.stack || err?.message || String(err));
      });
      targetPage.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });
    };
    attachErrorListeners(page);

    if (!skipInitialGoto) {
      const targetUrl = view ? `${baseUrl}/?view=${encodeURIComponent(view)}` : baseUrl;
      await gotoApp(page, targetUrl, view || 'dashboard');
    }

    const openExtraPage = async (extraView = view) => {
      const p2 = await context.newPage();
      attachErrorListeners(p2);
      if (extraView !== null) {
        const u = extraView ? `${baseUrl}/?view=${encodeURIComponent(extraView)}` : baseUrl;
        await gotoApp(p2, u, extraView || 'dashboard');
      }
      return p2;
    };

    await fn({
      page,
      context,
      browser,
      dev,
      runtime: dev.runtime,
      baseUrl,
      tmpSnapshotPath,
      pageErrors,
      consoleErrors,
      openExtraPage
    });

    assert.equal(
      pageErrors.length,
      0,
      `Expected zero uncaught pageerror events, got:\n${pageErrors.join('\n')}`
    );
    if (!allowConsoleErrors) {
      assert.equal(
        consoleErrors.length,
        0,
        `Expected zero console.error messages, got:\n${consoleErrors.join('\n')}`
      );
    }
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // ignore cleanup error
      }
    }
    if (ownsBrowser && browser) {
      try {
        await browser.close();
      } catch {
        // ignore cleanup error
      }
    }
    if (dev && typeof dev.close === 'function') {
      try {
        await dev.close();
      } catch {
        // ignore cleanup error
      }
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

export async function gotoApp(page, targetUrl, expectedView = 'dashboard', timeout = 15000) {
  const rpcPromise = page
    .waitForResponse(
      (res) => res.url().includes('/__gas_rpc') && res.request().method() === 'POST',
      { timeout }
    )
    .catch(() => null);

  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.locator(`#view-${expectedView}`).waitFor({ state: 'visible', timeout });
  await rpcPromise;
  await waitForViewReady(page, expectedView, timeout);
}

export async function waitForViewReady(page, viewKey, timeout = 15000) {
  await page.locator(`#view-${viewKey}`).waitFor({ state: 'visible', timeout });

  if (viewKey === 'dashboard') {
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#kpi-total-orders');
        if (!el) return false;
        const txt = (el.textContent || '').trim();
        return /\d/.test(txt) && txt !== '-' && txt !== '...';
      },
      null,
      { timeout }
    );
  } else if (viewKey === 'input') {
    await page.waitForFunction(
      () => {
        const sel = document.querySelector('#input-shipper-id');
        return sel && sel.querySelectorAll('option').length >= 2;
      },
      null,
      { timeout }
    );
  } else if (viewKey === 'pickup' || viewKey === 'sort' || viewKey === 'delivery') {
    await page.waitForFunction(
      (vk) => {
        const root = document.querySelector(`#view-${vk}`);
        if (!root) return false;
        if (root.querySelectorAll('table tbody tr').length > 0) return true;
        return /no orders|empty|0 orders|no matching/i.test(root.textContent || '');
      },
      viewKey,
      { timeout }
    );
  }
}

export async function navigateToView(page, viewKey, timeout = 15000) {
  await page.locator(`#nav-${viewKey}`).click();
  await waitForViewReady(page, viewKey, timeout);
}

export async function performRpcAction(page, actionFn, { timeout = 15000 } = {}) {
  const [rpcResponse] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/__gas_rpc') && res.request().method() === 'POST',
      { timeout }
    ),
    actionFn()
  ]);
  const body = await rpcResponse.json().catch(() => null);
  return { status: rpcResponse.status(), body };
}

export async function waitForToast(page, pattern = null, timeout = 10000) {
  const handle = await page.waitForFunction(
    (patSource) => {
      const container = document.querySelector('#toast-container');
      if (!container) return null;
      const text = (container.textContent || '').trim();
      if (!text) return null;
      if (patSource) {
        const re = new RegExp(patSource.source, patSource.flags);
        if (!re.test(text)) return null;
      }
      return text;
    },
    pattern ? { source: pattern.source, flags: pattern.flags } : null,
    { timeout }
  );
  return handle.jsonValue();
}

export async function waitForFeedback(page, pattern = null, timeout = 5000) {
  const handle = await page.waitForFunction(
    (patSource) => {
      const candidates = [
        ...document.querySelectorAll('#toast-container, [role="alert"], .error-banner, .form-error, .alert-error, .validation-error, .toast')
      ];
      const combined = candidates.map((el) => (el.textContent || '').trim()).filter(Boolean).join('\n');
      if (!combined) {
        const invalidEl = document.querySelector('#form-create-order :invalid');
        if (invalidEl && invalidEl.validationMessage) {
          return invalidEl.validationMessage;
        }
        return null;
      }
      if (patSource) {
        const re = new RegExp(patSource.source, patSource.flags);
        if (!re.test(combined)) return null;
      }
      return combined;
    },
    pattern ? { source: pattern.source, flags: pattern.flags } : null,
    { timeout }
  );
  return handle.jsonValue();
}

/**
 * Clicks an element and waits specifically for NEW feedback (avoiding stale
 * toasts from prior assertions without mutating/detaching app-managed DOM nodes).
 */
export async function waitForFreshFeedbackAfterClick(page, selector, pattern = null, timeout = 5000) {
  await page.evaluate(() => {
    const staleSelectors = '#toast-container > *, .toast, [role="alert"], .error-banner, .form-error, .alert-error, .validation-error';
    document.querySelectorAll(staleSelectors).forEach((el) => {
      el.setAttribute('data-e2e-seen', '1');
      el.setAttribute('data-e2e-prev-text', (el.textContent || '').trim());
    });
    const toastContainer = document.querySelector('#toast-container');
    if (toastContainer) {
      toastContainer.setAttribute('data-e2e-prev-text', (toastContainer.textContent || '').trim());
    }
    window.__e2eFeedbackMutated = false;
    if (window.__e2eFeedbackObserver) {
      window.__e2eFeedbackObserver.disconnect();
    }
    const feedbackMatch = '[role="alert"], .error-banner, .form-error, .alert-error, .validation-error, .toast';
    const obs = new MutationObserver((records) => {
      for (const rec of records) {
        if (rec.type === 'childList' && rec.addedNodes.length === 0) continue;
        if (rec.type === 'attributes' && String(rec.attributeName || '').startsWith('data-e2e-')) continue;
        const targetEl = rec.target instanceof Element ? rec.target : rec.target.parentElement;
        if (
          targetEl &&
          (targetEl.closest('#toast-container') ||
            targetEl.closest(feedbackMatch) ||
            [...(rec.addedNodes || [])].some(
              (n) =>
                n instanceof Element &&
                (n.matches(feedbackMatch) || Boolean(n.querySelector?.(feedbackMatch)))
            ))
        ) {
          window.__e2eFeedbackMutated = true;
          return;
        }
      }
    });
    obs.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
    window.__e2eFeedbackObserver = obs;
  });

  await page.locator(selector).click();

  try {
    const handle = await page.waitForFunction(
      (patSource) => {
        const re = patSource ? new RegExp(patSource.source, patSource.flags) : null;
        const freshCandidates = [];
        const allFeedback = document.querySelectorAll(
          '#toast-container > *, .toast, [role="alert"], .error-banner, .form-error, .alert-error, .validation-error'
        );
        for (const el of allFeedback) {
          const text = (el.textContent || '').trim();
          if (!text) continue;
          const isSeen = el.getAttribute('data-e2e-seen') === '1';
          const prevText = el.getAttribute('data-e2e-prev-text') || '';
          if (!isSeen || text !== prevText) {
            freshCandidates.push(text);
          }
        }
        if (freshCandidates.length === 0 && window.__e2eFeedbackMutated) {
          const tc = document.querySelector('#toast-container');
          const tcText = (tc?.textContent || '').trim();
          if (tcText) freshCandidates.push(tcText);
        }
        const combined = freshCandidates.join('\n').trim();
        if (!combined) return null;
        if (re && !re.test(combined)) return null;
        return combined;
      },
      pattern ? { source: pattern.source, flags: pattern.flags } : null,
      { timeout }
    );
    return await handle.jsonValue();
  } finally {
    await page.evaluate(() => {
      window.__e2eFeedbackObserver?.disconnect();
      delete window.__e2eFeedbackObserver;
      delete window.__e2eFeedbackMutated;
    }).catch(() => {});
  }
}

/**
 * Returns Asia/Bangkok date in yyyy-MM-dd with optional day offset.
 */
export function getBangkokDateYmd(offsetDays = 0) {
  const ms = Date.now() + offsetDays * 86400000;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ms));
}

export function normalizeYmd(val) {
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(val);
  }
  const s = String(val).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) {
    return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  }
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(parsed);
  }
  return '';
}

export function diffDaysYmd(startYmd, endYmd) {
  const s = normalizeYmd(startYmd);
  const e = normalizeYmd(endYmd);
  if (!s || !e) return null;
  const [sy, sm, sd] = s.split('-').map(Number);
  const [ey, em, ed] = e.split('-').map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86400000);
}

export function normalizeShipperId(rawId) {
  const s = String(rawId ?? '').trim();
  if (!s) return '';
  const m = s.match(/^SHP-0*(\d+)$/i);
  if (!m) return s;
  return `SHP-${m[1].padStart(2, '0')}`;
}

export function computeOrderAging(order, refDateYmd = getBangkokDateYmd(0)) {
  const inbound = normalizeYmd(order.inbound_date);
  if (!inbound) {
    return { agingDays: null, agingType: 'Not Inbounded' };
  }
  const end = normalizeYmd(order.end_date);
  const target = end || refDateYmd;
  const rawDays = diffDaysYmd(inbound, target);
  const agingDays = rawDays;
  const agingType = agingDays < 8 ? 'Under SLA' : 'Over SLA';
  return { agingDays, agingType };
}

/**
 * Reads runtime.getSheetData(sheetName) defensively regardless of whether
 * gasRuntime returns a 2D array or an array of objects.
 */
export function getSheetTable(runtime, sheetName) {
  const data = runtime.getSheetData(sheetName);
  if (!data || !Array.isArray(data) || data.length === 0) {
    return { exists: false, raw: [], headers: [], rows: [] };
  }
  if (Array.isArray(data[0])) {
    const headers = data[0].map((h) => String(h ?? '').trim());
    const rows = data
      .slice(1)
      .filter((r) => Array.isArray(r) && r.some((cell) => cell !== '' && cell !== null && cell !== undefined))
      .map((r, idx) => {
        const obj = { _rowNumber: idx + 2 };
        headers.forEach((h, i) => {
          if (h) obj[h] = r[i] ?? '';
        });
        return obj;
      });
    return { exists: true, raw: data, headers, rows };
  }
  const headers = Object.keys(data[0]);
  const rows = data.map((r, idx) => ({ _rowNumber: idx + 2, ...r }));
  const raw = [headers, ...data.map((r) => headers.map((h) => r[h] ?? ''))];
  return { exists: true, raw, headers, rows };
}

export function getSheetFormulas(runtime, sheetName) {
  if (typeof runtime.getSheetFormulas === 'function') {
    return runtime.getSheetFormulas(sheetName);
  }
  if (typeof runtime.getFormulas === 'function') {
    return runtime.getFormulas(sheetName);
  }
  return getSheetTable(runtime, sheetName).raw;
}

export function assertDbOrdersSchema10Cols(runtime) {
  const { raw, headers } = getSheetTable(runtime, 'db_orders');
  assert.ok(raw.length >= 1, 'db_orders must have header row');
  assert.deepEqual(
    headers.slice(0, 10),
    EXPECTED_ORDER_HEADERS,
    'db_orders A1:J1 headers must match BigQuery schema'
  );
  assert.equal(headers.length, 10, 'db_orders header row must remain strictly 10 columns (A:J)');
  for (let i = 0; i < raw.length; i++) {
    assert.ok(
      raw[i].length <= 10,
      `db_orders row ${i + 1} has ${raw[i].length} columns (must be <= 10 for BigQuery A:J compatibility)`
    );
    if (i > 0) {
      const rf = raw[i][3];
      assert.ok(
        rf === '' || rf === null || rf === undefined || rf === 1 || rf === '1',
        `db_orders row ${i + 1} return_flag must be 1 or empty, got ${JSON.stringify(rf)}`
      );
      const inbound = raw[i][8];
      const end = raw[i][9];
      if (inbound !== '' && inbound !== null && inbound !== undefined) {
        assert.match(normalizeYmd(inbound), /^\d{4}-\d{2}-\d{2}$/, `Row ${i + 1} inbound_date invalid`);
      }
      if (end !== '' && end !== null && end !== undefined) {
        assert.match(normalizeYmd(end), /^\d{4}-\d{2}-\d{2}$/, `Row ${i + 1} end_date invalid`);
      }
    }
  }
}

/**
 * Independent reference oracle for Dashboard KPIs, charts & SLA calculations.
 */
export function computeExpectedDashboard(ordersRows, shippersRows, filters = {}, refDateYmd = getBangkokDateYmd(0)) {
  const shipperMap = new Map();
  for (const s of shippersRows || []) {
    const norm = normalizeShipperId(s.shipper_id);
    if (norm) shipperMap.set(norm, s);
  }

  const enriched = (ordersRows || [])
    .filter((o) => String(o.order_id ?? '').trim() !== '')
    .map((o) => {
      const normShipper = normalizeShipperId(o.shipper_id);
      const shipperInfo = shipperMap.get(normShipper);
      const aging = computeOrderAging(o, refDateYmd);
      return {
        ...o,
        normalized_shipper_id: normShipper,
        shipper_name: shipperInfo?.shipper_name || o.shipper_name || `Unknown Shipper (${o.shipper_id})`,
        agingDays: aging.agingDays,
        agingType: aging.agingType,
        inboundYmd: normalizeYmd(o.inbound_date),
        endYmd: normalizeYmd(o.end_date),
        isReturnFlag: Number(o.return_flag) === 1
      };
    });

  const searchLower = String(filters.search || '').trim().toLowerCase();
  const hubFilter = filters.hub && filters.hub !== 'All' ? String(filters.hub).trim() : '';
  const hubScope = filters.hubScope || 'either';
  const statusFilter = filters.status && filters.status !== 'All' ? String(filters.status).trim() : '';
  const shipperFilter = filters.shipperId && filters.shipperId !== 'All'
    ? normalizeShipperId(filters.shipperId)
    : '';
  const slaFilter = filters.slaType && filters.slaType !== 'All' ? String(filters.slaType).trim() : '';
  const dateFrom = normalizeYmd(filters.dateFrom);
  const dateTo = normalizeYmd(filters.dateTo);

  const filtered = enriched.filter((o) => {
    if (searchLower) {
      const oid = String(o.order_id || '').toLowerCase();
      const resi = String(o.resi || '').toLowerCase();
      if (!oid.includes(searchLower) && !resi.includes(searchLower)) return false;
    }
    if (hubFilter) {
      if (hubScope === 'current' && o.current_hub !== hubFilter) return false;
      if (hubScope === 'destination' && o.destination_hub !== hubFilter) return false;
      if (hubScope === 'either' && o.current_hub !== hubFilter && o.destination_hub !== hubFilter) return false;
    }
    if (statusFilter && o.status !== statusFilter) return false;
    if (shipperFilter && o.normalized_shipper_id !== shipperFilter) return false;
    if (slaFilter && o.agingType !== slaFilter) return false;
    if (dateFrom || dateTo) {
      const refD = o.inboundYmd || o.endYmd;
      if (!refD) return false;
      if (dateFrom && refD < dateFrom) return false;
      if (dateTo && refD > dateTo) return false;
    }
    return true;
  });

  const totalOrders = filtered.length;
  const deliveredCount = filtered.filter((o) => o.status === 'Delivered').length;
  const returnedCount = filtered.filter((o) => o.status === 'Returned').length;
  const closedCount = deliveredCount + returnedCount;
  const deliveredRate = closedCount === 0 ? 0 : (deliveredCount / closedCount) * 100;
  const activeShipments = filtered.filter((o) => ACTIVE_STATUSES.has(o.status)).length;
  const returnFlagCount = filtered.filter((o) => o.isReturnFlag).length;
  const returnRate = totalOrders === 0 ? 0 : (returnFlagCount / totalOrders) * 100;
  const inboundedAges = filtered.filter((o) => o.agingDays !== null).map((o) => o.agingDays);
  const avgDeliveryTime =
    inboundedAges.length === 0
      ? 0
      : inboundedAges.reduce((acc, v) => acc + v, 0) / inboundedAges.length;

  const statusCounts = {
    'Pending Pickup': 0,
    Transit: 0,
    'On Shipment': 0,
    Delivered: 0,
    Returned: 0
  };
  const slaByHub = {};
  const shipperCounts = {};

  for (const o of filtered) {
    if (Object.prototype.hasOwnProperty.call(statusCounts, o.status)) {
      statusCounts[o.status] += 1;
    }
    const h = o.current_hub || 'UNKNOWN';
    if (!slaByHub[h]) {
      slaByHub[h] = { 'Not Inbounded': 0, 'Under SLA': 0, 'Over SLA': 0 };
    }
    slaByHub[h][o.agingType] += 1;
    shipperCounts[o.shipper_name] = (shipperCounts[o.shipper_name] || 0) + 1;
  }

  return {
    filtered,
    totalOrders,
    deliveredCount,
    returnedCount,
    closedCount,
    deliveredRate,
    activeShipments,
    returnFlagCount,
    returnRate,
    avgDeliveryTime,
    statusCounts,
    slaByHub,
    shipperCounts
  };
}

function parseKpiNumber(rawText) {
  const cleaned = String(rawText || '').replace(/,/g, '');
  const matches = cleaned.match(/[-+]?\d+(?:\.\d+)?/g);
  if (!matches || matches.length === 0) {
    throw new Error(`Could not parse numeric KPI from text: ${JSON.stringify(rawText)}`);
  }
  return Number(matches[matches.length - 1]);
}

export async function readDashboardKpis(page) {
  const [totalText, delivText, activeText, retText, avgText] = await Promise.all([
    page.locator('#kpi-total-orders').innerText(),
    page.locator('#kpi-delivered-rate').innerText(),
    page.locator('#kpi-active-shipments').innerText(),
    page.locator('#kpi-return-rate').innerText(),
    page.locator('#kpi-avg-delivery-time').innerText()
  ]);

  return {
    raw: { totalText, delivText, activeText, retText, avgText },
    totalOrders: parseKpiNumber(totalText),
    deliveredRate: parseKpiNumber(delivText),
    activeShipments: parseKpiNumber(activeText),
    returnRate: parseKpiNumber(retText),
    avgDeliveryTime: parseKpiNumber(avgText)
  };
}

export async function waitForKpiTotal(page, expectedTotal, timeout = 10000) {
  await page.waitForFunction(
    (target) => {
      const el = document.querySelector('#kpi-total-orders');
      if (!el) return false;
      const cleaned = (el.textContent || '').replace(/,/g, '');
      const m = cleaned.match(/[-+]?\d+(?:\.\d+)?/g);
      if (!m || m.length === 0) return false;
      return Number(m[m.length - 1]) === target;
    },
    expectedTotal,
    { timeout }
  );
}

/**
 * Creates an order through the Input Data UI (#nav-input -> #form-create-order).
 * Returns { orderId, resi, toastText }.
 */
export async function createOrderViaUi(
  page,
  {
    shipperId = 'SHP-01',
    currentHub = 'HUB-JKT',
    destinationHub = 'HUB-BDG',
    address = 'Jl. Sudirman No. 10, Jakarta',
    courier = '',
    notes = ''
  }
) {
  const inputVisible = await page.locator('#view-input').isVisible().catch(() => false);
  if (!inputVisible) {
    await navigateToView(page, 'input');
  }

  await page.locator('#input-shipper-id').selectOption(shipperId);
  await page.locator('#input-current-hub').selectOption(currentHub);
  await page.locator('#input-destination-hub').selectOption(destinationHub);
  await page.locator('#input-destination-address').fill(address);
  if (courier !== undefined) {
    await page.locator('#input-courier').fill(courier);
  }
  if (notes !== undefined) {
    await page.locator('#input-notes').fill(notes);
  }

  const { body } = await performRpcAction(page, () => page.locator('#btn-submit-order').click());
  const toastText = await waitForToast(page, /ORD-\d{6}-\d{4}|created|success/i).catch(() => '');

  const combinedText = `${toastText} ${JSON.stringify(body || {})}`;
  let orderIdMatch = combinedText.match(/ORD-\d{6}-\d{4}/);
  let resiMatch = combinedText.match(/RS-\d{8}/);

  if (!orderIdMatch) {
    const viewText = await page.locator('#view-input').innerText();
    orderIdMatch = viewText.match(/ORD-\d{6}-\d{4}/);
    if (!resiMatch) resiMatch = viewText.match(/RS-\d{8}/);
  }

  assert.ok(orderIdMatch, `Expected created order ID in UI/RPC response, got toast=${toastText}`);
  const orderId = orderIdMatch[0];

  if (!resiMatch) {
    const rowText = await page
      .locator('#view-input table tbody tr', { hasText: orderId })
      .first()
      .innerText()
      .catch(() => '');
    resiMatch = rowText.match(/RS-\d{8}/);
  }

  const resi = resiMatch ? resiMatch[0] : (body?.result?.order?.resi ?? body?.order?.resi ?? '');
  return { orderId, resi, toastText, rpcBody: body };
}

export async function clickQuickJumpAction(targetRow) {
  const preferred = targetRow
    .locator('button, a, [role="button"]')
    .filter({ hasText: /sort|delivery|open|go|action|triage|jump|view/i })
    .first();
  if ((await preferred.count()) > 0) {
    await preferred.click();
    return;
  }
  const fallbackBtn = targetRow.locator('button').first();
  if ((await fallbackBtn.count()) > 0) {
    await fallbackBtn.click();
    return;
  }
  await targetRow.locator('button, a, [role="button"]').last().click();
}

export async function selectQueueRow(page, viewSelector, orderIdOrResi, timeout = 10000) {
  const row = page.locator(`${viewSelector} table tbody tr`, { hasText: orderIdOrResi }).first();
  await row.waitFor({ state: 'visible', timeout });
  const cb = row.locator('input[type="checkbox"]').first();
  await cb.waitFor({ state: 'visible', timeout });
  if (!(await cb.isChecked())) {
    await cb.check();
  }
  return row;
}

export async function getHighAgingTable(page) {
  const section = page
    .locator('#view-dashboard section, #view-dashboard .card, #view-dashboard article, #view-dashboard div')
    .filter({ hasText: /High Aging/i })
    .filter({ has: page.locator('table') })
    .last();
  if ((await section.count()) > 0) {
    return section.locator('table').first();
  }
  return page.locator('#view-dashboard table').first();
}

export function assertNoBrokenNumbers(text, contextLabel = 'UI') {
  assert.ok(!/\bNaN\b/.test(text), `${contextLabel} must not contain NaN: ${text}`);
  assert.ok(!/\bInfinity\b/.test(text), `${contextLabel} must not contain Infinity: ${text}`);
  assert.ok(!/\bundefined\b/.test(text), `${contextLabel} must not contain undefined: ${text}`);
}
