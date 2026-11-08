import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readDiffFile, readGitDiff } from '../dist/diff/index.js';
import { InventoryError } from '../dist/inventory/index.js';
import { cleanPlaywrightEnv, findPlaywrightCli, runPlaywright } from '../dist/playwright/cli.js';
import { formatSummary } from '../dist/report/index.js';
import { buildPlaywrightArgs, runSelected, runSelection } from '../dist/run/index.js';
import { cleanup, createTempRepo } from './helpers/git-repo.mjs';

/**
 * runSelected with the real Playwright 1.60.0. The first tests use a made-up project in a temp folder
 * whose specs open no browser and use no network, so they run in npm test and in CI. The last test runs
 * the demo suite against saucedemo.com and only runs when PRCHECK_LIVE=1.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lines = (...ls) => ls.map((l) => `${l}\n`).join('');
// Real Playwright runs get a generous node:test limit; no test waits on a timer.
const REAL = { timeout: 120_000 };

// The synthetic project, the same sources as in tests/fixtures/results/README.md, plus two decoy specs
// whose paths a loose file filter would also match.
const CONFIG = lines(
  "import { defineConfig } from '@playwright/test';",
  '',
  'export default defineConfig({',
  "  testDir: './tests',",
  '  retries: 1,',
  '  projects: [',
  "    { name: 'desktop' },",
  "    { name: 'smoke', grep: /@cart/ },",
  '  ],',
  '});',
);
const CART_SOURCE = lines(
  "import { expect, test } from '@playwright/test';",
  '',
  "test.describe('cart', () => {",
  "  test('adds a backpack to the cart', { tag: '@cart' }, () => {",
  "    const cart = ['sauce-labs-backpack'];",
  '    expect(cart).toHaveLength(1);',
  '  });',
  '',
  "  test('shows the badge after a retry', ({}, testInfo) => {",
  '    expect(testInfo.retry).toBe(1);',
  '  });',
  '',
  "  test.skip('applies a promo code', () => {",
  '    expect(true).toBe(true);',
  '  });',
  '',
  "  test('sells the onesie for free', () => {",
  '    test.fail();',
  '    expect(7.99).toBe(0);',
  '  });',
  '});',
);
const CHECKOUT_SOURCE = lines(
  "import { expect, test } from '@playwright/test';",
  '',
  "test.describe('checkout', () => {",
  "  test('counts the items in the cart', () => {",
  '    const cartCount = 1;',
  '    expect(cartCount).toBe(2);',
  '  });',
  '',
  "  test('waits for the payment page', async () => {",
  '    test.setTimeout(500);',
  '    await new Promise(() => {});',
  '  });',
  '});',
);
const DECOY_SOURCE = (title) => lines("import { test } from '@playwright/test';", '', `test('${title}', () => {});`);

const CART = 'demo/shop/tests/cart/cart.spec.ts';
const CHECKOUT = 'demo/shop/tests/checkout/checkout.spec.ts';
const OPTIONS = ['--reporter=json', '--pass-with-no-tests', '--forbid-only'];
const TO_BE = 'Error: expect(received).toBe(expected) // Object.is equality';

// Written by hand from the sources above: retries 1, the smoke project runs only the @cart test.
const CHECKOUT_TESTS = [
  { file: CHECKOUT, line: 4, title: 'checkout > counts the items in the cart', project: 'desktop', tags: [], status: 'failed', attempts: 2, error: TO_BE },
  { file: CHECKOUT, line: 9, title: 'checkout > waits for the payment page', project: 'desktop', tags: [], status: 'timedOut', attempts: 2, error: 'Test timeout of 500ms exceeded.' },
];
const CART_TESTS = [
  { file: CART, line: 4, title: 'cart > adds a backpack to the cart', project: 'desktop', tags: ['@cart'], status: 'passed', attempts: 1, error: null },
  { file: CART, line: 4, title: 'cart > adds a backpack to the cart', project: 'smoke', tags: ['@cart'], status: 'passed', attempts: 1, error: null },
  { file: CART, line: 9, title: 'cart > shows the badge after a retry', project: 'desktop', tags: [], status: 'flaky', attempts: 2, error: TO_BE },
  { file: CART, line: 13, title: 'cart > applies a promo code', project: 'desktop', tags: [], status: 'skipped', attempts: 1, error: null },
  { file: CART, line: 17, title: 'cart > sells the onesie for free', project: 'desktop', tags: [], status: 'passed', attempts: 1, error: null },
];

function newDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
  t.after(() => cleanup(dir));
  return dir;
}

function writeTo(dir) {
  return (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
}

/** The synthetic project, with node_modules linked to this repo's so the real Playwright runs. */
function writeProject(dir, write) {
  fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  write('qa-core-prcheck.config.json', JSON.stringify({ playwrightDir: 'demo/shop' }));
  write('demo/shop/playwright.config.ts', CONFIG);
  write(CART, CART_SOURCE);
  write(CHECKOUT, CHECKOUT_SOURCE);
  write('demo/shop/tests/cart/mini-cart.spec.ts', DECOY_SOURCE('shows the mini cart'));
  write('demo/shop/tests/checkout/checkout.spec.tsx', DECOY_SOURCE('opens the express checkout'));
}

/** A fake git, first on PATH, that records each call in a marker file and fails. A node script, not a shell script. */
function fakeGit(t) {
  const dir = newDir(t);
  const marker = path.join(dir, 'git-calls.txt');
  fs.writeFileSync(marker, '');
  assert.ok(!process.execPath.includes(' '), `a #! line cannot hold a path with spaces: ${process.execPath}`);
  fs.writeFileSync(path.join(dir, 'git'), lines(
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n');`,
    'process.exitCode = 1;',
  ), { mode: 0o755 });
  return { path: `${dir}${path.delimiter}${process.env.PATH}`, marker };
}

const subsetOf = (file) => ({ mode: 'subset', playwrightDir: 'demo/shop', selected: [{ file }] });

function withoutDurations(tests) {
  return tests.map(({ durationMs, ...rest }) => {
    assert.ok(Number.isInteger(durationMs) && durationMs >= 0, `durationMs ${durationMs}`);
    return rest;
  });
}

test('real Playwright: a change to the failing spec runs only it and exits 1, a change to the passing spec exits 0, and no git runs', REAL, async (t) => {
  const repo = createTempRepo();
  t.after(() => cleanup(repo.dir));
  // Ignored first, so the linked packages and Playwright's output folder are never committed.
  repo.write('.gitignore', lines('node_modules', 'test-results'));
  writeProject(repo.dir, repo.write);
  repo.commitAll('base');
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write(CHECKOUT, CHECKOUT_SOURCE.replace('const cartCount = 1;', 'const cartCount = 1; // one backpack'));
  repo.commitAll('feature');

  // readGitDiff needs the real git, so it runs first. runSelected takes the diff and runs Playwright
  // twice (the --list inventory and the test run), both with the fake git first on PATH and with the
  // CI variables that would make Playwright run git if they were not removed.
  const diff = await readGitDiff({ base: 'main', head: 'feature', cwd: repo.dir, env: repo.env });
  const git = fakeGit(t);
  const env = { PATH: git.path, GITHUB_ACTIONS: 'true', GITLAB_CI: 'true', JENKINS_URL: 'http://jenkins.invalid', BUILD_URL: 'http://jenkins.invalid/1', CI: 'true' };

  const failing = await runSelected({ root: repo.dir, diff, env });
  assert.deepEqual(failing.errors, []);
  assert.equal(failing.source.type, 'git');
  assert.equal(failing.mode, 'subset');
  assert.deepEqual(failing.specs, [CHECKOUT]);
  assert.deepEqual(failing.command, ['test', '--config', 'demo/shop', ...OPTIONS, '/^<root>/demo/shop/tests/checkout/checkout\\.spec\\.ts$/']);
  assert.deepEqual([failing.verdict, failing.exitCode], ['failed', 1]);
  // Only checkout.spec.ts ran: checkout.spec.tsx would have matched a plain path.
  assert.deepEqual(withoutDurations(failing.tests), CHECKOUT_TESTS);
  assert.deepEqual(failing.counts, { total: 2, passed: 0, failed: 1, flaky: 0, skipped: 0, timedOut: 1, interrupted: 0 });
  assert.deepEqual(failing.warnings, []);

  repo.git('checkout', '-q', 'main');
  repo.git('checkout', '-q', '-b', 'feature-cart');
  repo.write(CART, CART_SOURCE.replace("['sauce-labs-backpack']", "['sauce-labs-bike-light']"));
  repo.commitAll('cart');
  const cartDiff = await readGitDiff({ base: 'main', head: 'feature-cart', cwd: repo.dir, env: repo.env });

  const passing = await runSelected({ root: repo.dir, diff: cartDiff, env });
  assert.deepEqual(passing.errors, []);
  assert.deepEqual(passing.specs, [CART]);
  assert.deepEqual([passing.verdict, passing.exitCode], ['passed', 0]);
  // Only cart.spec.ts ran, not mini-cart.spec.ts. The flaky test passes the run but is counted.
  assert.deepEqual(withoutDurations(passing.tests), CART_TESTS);
  assert.deepEqual(passing.counts, { total: 5, passed: 3, failed: 0, flaky: 1, skipped: 1, timedOut: 0, interrupted: 0 });

  assert.equal(fs.readFileSync(git.marker, 'utf8'), '', 'Playwright ran git');
});

test('control: real Playwright lists the .tsx decoy for a plain path, and only the selected file for the built filter', REAL, async (t) => {
  const dir = newDir(t);
  writeProject(dir, writeTo(dir));
  const cli = findPlaywrightCli(dir);
  const listFiles = async (filter) => {
    const args = [cli, 'test', '--list', '--reporter=json', '--config', path.join(dir, 'demo', 'shop'), filter];
    const run = await runPlaywright(dir, args, cleanPlaywrightEnv(process.env), 0);
    assert.equal(run.exitCode, 0, run.stderr);
    return JSON.parse(run.stdout).suites.map((suite) => suite.file).sort();
  };
  assert.deepEqual(await listFiles(CHECKOUT), ['checkout/checkout.spec.ts', 'checkout/checkout.spec.tsx']);
  assert.deepEqual(await listFiles(buildPlaywrightArgs(subsetOf(CHECKOUT), dir).args.at(-1)), ['checkout/checkout.spec.ts']);
});

// The CI and reporter keys, written here rather than taken from src, so the control does not lean on the code it checks.
const HOST_KEYS_REMOVED = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL', 'BUILD_URL', 'PW_TEST_REPORTER',
  'PLAYWRIGHT_JSON_OUTPUT_NAME', 'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JSON_OUTPUT_DIR',
];

test('control: with GITHUB_ACTIONS kept, Playwright 1.60.0 runs git by itself, so the marker can catch it', REAL, async (t) => {
  // Playwright looks up git.exe or git.cmd on Windows. A shebang file named git is not selected, so
  // this control cannot see the call there. Linux and macOS still prove that keeping GITHUB_ACTIONS
  // makes Playwright 1.60.0 run git, which is why the runner removes that variable.
  if (process.platform === 'win32') {
    t.skip('Playwright on Windows does not execute a shebang file named git');
    return;
  }
  const dir = newDir(t);
  writeProject(dir, writeTo(dir));
  const git = fakeGit(t);
  // The host keys are removed so that only GITHUB_ACTIONS can trigger git; it is then set on purpose.
  const hostEnv = { ...process.env };
  for (const key of HOST_KEYS_REMOVED) delete hostEnv[key];
  const env = { ...hostEnv, PATH: git.path, GITHUB_ACTIONS: 'true', PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(newDir(t), 'report.json') };
  const args = buildPlaywrightArgs(subsetOf(CART), dir).args;
  const run = await runPlaywright(dir, [findPlaywrightCli(dir), ...args], env, 0);
  assert.equal(run.exitCode, 0, run.stderr);
  const calls = fs.readFileSync(git.marker, 'utf8');
  assert.ok(calls.startsWith('log -1 --pretty=format:'), calls);
});

// A spec with one passing focused test and one failing plain test. CONFIG does not set forbidOnly.
const FOCUS = 'demo/shop/tests/focus/focus.spec.ts';
const FOCUS_SOURCE = lines(
  "import { expect, test } from '@playwright/test';",
  '',
  "test.only('adds a backpack', () => {",
  '  expect(1).toBe(1);',
  '});',
  '',
  "test('counts the cart', () => {",
  '  expect(1).toBe(2);',
  '});',
);
// Written by hand from createForbidOnlyErrors in playwright 1.60.0 (lib/runner/index.js:2508-2520): the
// title path after the project, which starts with the file relative to testDir.
const FOCUS_ERROR = `Error: item focused with '.only' is not allowed due to the '--forbid-only' CLI flag: "focus/focus.spec.ts adds a backpack"`;
// CI removed (an undefined value is left out of a child env, even when the host sets CI), and CI set.
const CI_CASES = [['without CI', { CI: undefined }], ['with CI', { CI: 'true' }]];

/** A selection of one spec of the synthetic project, as selectTests gives for a change to it. */
const oneSpecSelection = (file, totalSpecs, totalTests) => ({
  schemaVersion: 1,
  source: { type: 'file', path: 'change.diff' },
  mode: 'subset',
  playwrightDir: 'demo/shop',
  totalSpecs,
  totalTests,
  selected: [{ file, testCount: 1, tags: [], reasons: [`Spec changed: ${file}`] }],
  fullSuiteReasons: [],
  decisions: [{ path: file, fileClass: 'spec', status: 'added', outcome: 'specs', reason: `Spec changed: ${file}`, specs: [file] }],
  warnings: [],
});

for (const [label, extra] of CI_CASES) {
  test(`real Playwright, ${label}: a passing test.only next to a failing test gives Error, exit 2, and a summary that never says Passed`, REAL, async (t) => {
    const dir = newDir(t);
    const write = writeTo(dir);
    writeProject(dir, write);
    write(FOCUS, FOCUS_SOURCE);
    // writeProject's 4 specs and 8 tests, plus the focused spec's 2 tests.
    const selection = { ...oneSpecSelection(FOCUS, 5, 10), selected: [{ file: FOCUS, testCount: 2, tags: [], reasons: [`Spec changed: ${FOCUS}`] }] };

    // runSelection skips the inventory, so this is the --forbid-only of the test run itself.
    const result = await runSelection({ root: dir, selection, env: extra });
    assert.deepEqual(result.command, ['test', '--config', 'demo/shop', ...OPTIONS, '/^<root>/demo/shop/tests/focus/focus\\.spec\\.ts$/']);
    assert.deepEqual([result.verdict, result.exitCode], ['error', 2]);
    assert.deepEqual(result.errors, [`${FOCUS}:3: ${FOCUS_ERROR}`]);
    assert.deepEqual(result.tests, []);

    const summary = formatSummary({ selection, result, error: null, version: '0.0.0-test' });
    assert.equal(summary.verdict, 'error');
    assert.equal(summary.markdown.split('\n')[1], '## PR Check: Error');
    assert.ok(summary.markdown.includes(`\n### Errors\n- ${FOCUS}:3: ${FOCUS_ERROR}\n`), summary.markdown);
    assert.ok(!summary.markdown.includes('Passed'), summary.markdown);
  });
}

test('real Playwright: a test.only anywhere stops the inventory with the --forbid-only error, from runSelected and the check CLI, with and without CI', REAL, async (t) => {
  const repo = createTempRepo();
  t.after(() => cleanup(repo.dir));
  // Ignored first, so the linked packages and Playwright's output folder are never committed.
  repo.write('.gitignore', lines('node_modules', 'test-results'));
  writeProject(repo.dir, repo.write);
  repo.commitAll('base');
  repo.git('checkout', '-q', '-b', 'feature');
  repo.write(FOCUS, FOCUS_SOURCE);
  repo.commitAll('focus');
  const diff = await readGitDiff({ base: 'main', head: 'feature', cwd: repo.dir, env: repo.env });
  const message = `Playwright reported an error: ${FOCUS_ERROR}`;

  for (const [label, extra] of CI_CASES) {
    await assert.rejects(runSelected({ root: repo.dir, diff, env: extra }), (error) => {
      assert.ok(error instanceof InventoryError, `${label}: ${error}`);
      assert.equal(error.message, message);
      return true;
    });
  }

  // The CLI reads the same change from a saved diff. The flags are those readGitDiff uses.
  const work = newDir(t);
  const diffPath = path.join(work, 'change.diff');
  fs.writeFileSync(diffPath, `${repo.git(
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--find-renames',
    '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', 'main', 'feature', '--',
  )}\n`);
  const cliJs = path.join(repoRoot, 'dist', 'cli.js');
  for (const [label, extra] of CI_CASES) {
    // The host's CI and reporter keys and its job summary never reach the child; the case sets CI.
    const env = { ...process.env };
    for (const key of [...HOST_KEYS_REMOVED, 'GITHUB_STEP_SUMMARY']) delete env[key];
    const summaryFile = path.join(work, `summary-${extra.CI ?? 'none'}.md`);
    const r = await new Promise((resolve) => {
      const child = spawn(process.execPath, [cliJs, 'check', '--diff-file', diffPath, '--root', repo.dir, '--summary-file', summaryFile], { cwd: work, env: { ...env, ...extra } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', `${message}\nRun qa-core-prcheck check --help for usage.\n`], label);
    const summary = fs.readFileSync(summaryFile, 'utf8');
    assert.equal(summary.split('\n')[1], '## PR Check: Error', label);
    assert.ok(summary.includes(`\n### Errors\n- ${message}\n`), summary);
  }
});

// A spec that passes only when CI reached the test worker and the git capture keys did not.
const ENV_PROBE = 'demo/shop/tests/env/env.spec.ts';
const ENV_PROBE_SOURCE = lines(
  "import { expect, test } from '@playwright/test';",
  '',
  "test('sees CI and no git capture keys', () => {",
  "  expect(process.env.CI).toBe('true');",
  '  const gitKeys = [process.env.GITHUB_ACTIONS, process.env.GITLAB_CI, process.env.JENKINS_URL, process.env.BUILD_URL];',
  '  expect(gitKeys).toEqual([undefined, undefined, undefined, undefined]);',
  '});',
);

test('control: with CI kept and the git keys removed, real Playwright runs no git, and CI reaches the test', REAL, async (t) => {
  const dir = newDir(t);
  const write = writeTo(dir);
  writeProject(dir, write);
  write(ENV_PROBE, ENV_PROBE_SOURCE);
  const git = fakeGit(t);

  // Playwright itself, without src: the host keys are removed, then only CI is set, as the runner now leaves it.
  const hostEnv = { ...process.env };
  for (const key of HOST_KEYS_REMOVED) delete hostEnv[key];
  const env = { ...hostEnv, PATH: git.path, CI: 'true', PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(newDir(t), 'report.json') };
  const run = await runPlaywright(dir, [findPlaywrightCli(dir), ...buildPlaywrightArgs(subsetOf(ENV_PROBE), dir).args], env, 0);
  assert.equal(run.exitCode, 0, run.stdout);

  // The runner, given every CI variable: it removes the git keys and passes CI through.
  // writeProject's 4 specs and 8 tests, plus the probe.
  const ciEnv = { PATH: git.path, GITHUB_ACTIONS: 'true', GITLAB_CI: 'true', JENKINS_URL: 'http://jenkins.invalid', BUILD_URL: 'http://jenkins.invalid/1', CI: 'true' };
  const result = await runSelection({ root: dir, selection: oneSpecSelection(ENV_PROBE, 5, 9), env: ciEnv });
  assert.deepEqual(result.errors, []);
  assert.deepEqual([result.verdict, result.exitCode], ['passed', 0]);
  assert.deepEqual(result.tests.map(({ title, status }) => ({ title, status })), [{ title: 'sees CI and no git capture keys', status: 'passed' }]);

  assert.equal(fs.readFileSync(git.marker, 'utf8'), '', 'Playwright ran git');
});

const LIVE_ON = process.env.PRCHECK_LIVE === '1';
// The node:test limit for the live run. A chosen limit; Playwright's own timeouts are the demo config's.
const LIVE_LIMIT_MS = 300_000;
const DEMO_CART = 'demo/saucedemo/tests/cart/cart.spec.ts';
const DEMO_CHECKOUT = 'demo/saucedemo/tests/checkout/checkout.spec.ts';

test('live: modify.diff runs the cart and checkout specs against saucedemo.com and they pass', {
  skip: LIVE_ON ? false : 'set PRCHECK_LIVE=1 to run against saucedemo.com',
  timeout: LIVE_LIMIT_MS,
}, async () => {
  const diff = await readDiffFile('tests/fixtures/diffs/modify.diff', repoRoot);
  const result = await runSelected({ root: repoRoot, diff });
  assert.deepEqual(result.errors, []);
  assert.equal(result.mode, 'subset');
  // The specs PR 3 selects for modify.diff: both import pages/cart-page.ts.
  assert.deepEqual(result.specs, [DEMO_CART, DEMO_CHECKOUT]);
  assert.deepEqual([result.verdict, result.exitCode], ['passed', 0]);
  // 4: two tests in each of the two specs, one project (the demo inventory in tests/inventory.test.mjs).
  assert.equal(result.counts.total, 4);
  assert.deepEqual(result.tests.map(({ file, line, title, project, status }) => ({ file, line, title, project, status })), [
    { file: DEMO_CART, line: 12, title: 'cart > adds a product to the cart', project: 'chromium', status: 'passed' },
    { file: DEMO_CART, line: 24, title: 'cart > removes a product from the cart', project: 'chromium', status: 'passed' },
    { file: DEMO_CHECKOUT, line: 18, title: 'checkout > completes an order', project: 'chromium', status: 'passed' },
    { file: DEMO_CHECKOUT, line: 29, title: 'checkout > requires a first name', project: 'chromium', status: 'passed' },
  ]);
});
