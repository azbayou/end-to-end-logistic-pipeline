import { checkPrerequisites, launchChromiumBrowser } from './helpers.mjs';
import * as tier1 from './tier1_features.mjs';
import * as tier2 from './tier2_boundaries.mjs';
import * as tier3 from './tier3_cross_feature.mjs';
import * as tier4 from './tier4_workloads.mjs';

const TIER_MODULES = new Map([
  [1, tier1],
  [2, tier2],
  [3, tier3],
  [4, tier4]
]);

function printUsage() {
  console.log(`Logistic Performance Xpress — Playwright E2E Runner

Usage:
  node test/e2e/run.mjs [options]

Options:
  --tier=<1|2|3|4>      Run specific tier(s), e.g. --tier=1 or --tier=1,2 (default: 1,2,3,4)
  --filter=<substring>  Case-insensitive substring filter on test name
  -h, --help            Show this help message

Environment:
  E2E_STUB_DEV_SERVER   Optional path to a stub devServer module for pre-M4 smoke testing
  E2E_SNAPSHOT_PATH     Optional path to override test/fixtures/sheet_snapshot.json
  E2E_ISOLATE_BROWSER=1 Launch a fresh Chromium process per test instead of sharing one browser
`);
}

function parseArgs(argv) {
  let tiers = [1, 2, 3, 4];
  let tiersProvided = false;
  let filter = '';
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }

    if (arg.startsWith('--tier=') || arg === '--tier') {
      const rawVal = arg.startsWith('--tier=') ? arg.slice('--tier='.length) : argv[++i];
      if (!rawVal || (arg === '--tier' && rawVal.startsWith('--'))) {
        throw new Error('Missing value for --tier');
      }
      const rawParts = rawVal.split(',').map((s) => s.trim());
      if (rawParts.some((p) => p === '')) {
        throw new Error(`Invalid --tier value "${rawVal}". Empty segments are not allowed.`);
      }
      const parsed = rawParts
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 4);
      if (parsed.length === 0 || parsed.length !== rawParts.length) {
        throw new Error(`Invalid --tier value "${rawVal}". Expected comma-separated integers in 1..4.`);
      }
      tiers = tiersProvided ? [...new Set([...tiers, ...parsed])] : [...new Set(parsed)];
      tiersProvided = true;
      continue;
    }

    if (arg.startsWith('--filter=') || arg === '--filter') {
      const rawVal = arg.startsWith('--filter=') ? arg.slice('--filter='.length) : argv[++i];
      if (rawVal === undefined || (arg === '--filter' && rawVal.startsWith('--'))) {
        throw new Error('Missing value for --filter');
      }
      filter = rawVal.trim().toLowerCase();
      continue;
    }

    throw new Error(`Unknown CLI argument: ${arg}`);
  }

  return { tiers, filter, help };
}

function printPreflightDiagnostic(preflight) {
  console.error('E2E Preflight Failed — Required SUT / Test Harness artifacts are missing:');
  console.error(`  Repo Root : ${preflight.repoRoot}`);
  console.error(`  Chromium  : ${preflight.chromiumPath}`);
  console.error('  Missing Artifacts:');
  for (const item of preflight.missing) {
    console.error(`    - [${item.milestone}] ${item.artifact}: ${item.reason}`);
  }
  console.error('');
  console.error('Remediation: Complete Implementation Track M1-M4 (or set E2E_STUB_DEV_SERVER for harness smoke testing).');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`CLI Error: ${err.message}`);
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (opts.help) {
    printUsage();
    return;
  }

  const preflight = checkPrerequisites({
    stubServerPath: process.env.E2E_STUB_DEV_SERVER,
    snapshotPathOverride: process.env.E2E_SNAPSHOT_PATH
  });

  if (!preflight.ok) {
    printPreflightDiagnostic(preflight);
    process.exitCode = 1;
    return;
  }

  let sharedBrowser = null;
  const isolateBrowser = process.env.E2E_ISOLATE_BROWSER === '1';
  const getSharedBrowser = () => sharedBrowser;

  const selectedEntries = [];
  for (const tierNum of opts.tiers) {
    const mod = TIER_MODULES.get(tierNum);
    const tierTests = typeof mod.getTests === 'function' ? mod.getTests(getSharedBrowser) : mod.tests;
    for (const t of tierTests) {
      const label = `[Tier ${tierNum}] ${t.name}`;
      if (!opts.filter || label.toLowerCase().includes(opts.filter) || t.name.toLowerCase().includes(opts.filter)) {
        selectedEntries.push({ tier: tierNum, tierTitle: mod.title, label, test: t });
      }
    }
  }

  if (selectedEntries.length === 0) {
    console.error(`No tests matched --tier=${opts.tiers.join(',')} --filter=${opts.filter || '(none)'}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Running ${selectedEntries.length} E2E test(s) across tier(s) [${opts.tiers.join(', ')}]...`);

  const tierStats = new Map();
  for (const tierNum of opts.tiers) {
    tierStats.set(tierNum, { passed: 0, failed: 0, durationMs: 0 });
  }

  const failures = [];
  const suiteStart = Date.now();

  try {
    if (!isolateBrowser) {
      sharedBrowser = await launchChromiumBrowser();
    }

    for (const entry of selectedEntries) {
      const start = Date.now();
      const stats = tierStats.get(entry.tier);
      try {
        await entry.test.fn();
        const dur = Date.now() - start;
        stats.passed += 1;
        stats.durationMs += dur;
        console.log(`  PASS  ${entry.label} (${dur}ms)`);
      } catch (err) {
        const dur = Date.now() - start;
        stats.failed += 1;
        stats.durationMs += dur;
        console.error(`  FAIL  ${entry.label} (${dur}ms)`);
        console.error(err?.stack || err?.message || String(err));
        failures.push({ label: entry.label, error: err });
      }
    }
  } finally {
    if (sharedBrowser) {
      try {
        await sharedBrowser.close();
      } catch {
        // ignore close errors
      }
    }
  }

  const totalMs = Date.now() - suiteStart;
  console.log('\n=== E2E Summary ===');
  for (const [tierNum, stats] of tierStats.entries()) {
    const total = stats.passed + stats.failed;
    if (total === 0) continue;
    console.log(
      `  Tier ${tierNum}: ${stats.passed}/${total} passed, ${stats.failed} failed (${stats.durationMs}ms)`
    );
  }
  const totalPassed = selectedEntries.length - failures.length;
  console.log(
    `Total: ${totalPassed}/${selectedEntries.length} passed, ${failures.length} failed (${totalMs}ms)`
  );

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

await main();
