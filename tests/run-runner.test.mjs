import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDiffFile } from '../dist/diff/index.js';
import { runSelected } from '../dist/run/index.js';
import { cleanup } from './helpers/git-repo.mjs';

/**
 * runSelected with the fake Playwright CLI in tests/fixtures/fake-playwright/cli.mjs. The selection is
 * real: the diffs come from tests/fixtures/diffs/ and the inventory is read from the demo suite by
 * Playwright's --list, which opens no browser. No real test runs here.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fakeCli = path.join(repoRoot, 'tests', 'fixtures', 'fake-playwright', 'cli.mjs');
const LIVE = { timeout: 120_000 };
// The kill timeout used against the hanging fake. A chosen limit, long enough for node to start.
const HANG_TIMEOUT_MS = 2_000;

const d = (file) => `demo/saucedemo/${file}`;
const CART_SPEC = d('tests/cart/cart.spec.ts');
const CHECKOUT_SPEC = d('tests/checkout/checkout.spec.ts');
const ALL_SPECS = [CART_SPEC, CHECKOUT_SPEC, d('tests/inventory/inventory.spec.ts'), d('tests/login/login.spec.ts')];
const OPTIONS = ['--reporter=json', '--pass-with-no-tests', '--forbid-only'];
// Nine keys a caller may set: the runner removes eight of them and passes CI through.
const NINE_KEYS = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL', 'BUILD_URL', 'PW_TEST_REPORTER',
  'PLAYWRIGHT_JSON_OUTPUT_NAME', 'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JSON_OUTPUT_DIR',
];
const ZERO = { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, timedOut: 0, interrupted: 0 };

const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const configArg = path.resolve(repoRoot, 'demo/saucedemo');
const fileArg = (file) => `/^${escapeRegExp(path.resolve(repoRoot, file))}$/`;

function newDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
  t.after(() => cleanup(dir));
  return dir;
}

/**
 * A copy of a recorded report with the documented path replacements undone for this checkout:
 * /repo/ and /project/ become the repo root, so every test file is inside the root.
 */
function reportCopy(t, name) {
  const text = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'results', name), 'utf8');
  const file = path.join(newDir(t), name);
  const slashRoot = repoRoot.replaceAll('\\', '/');
  fs.writeFileSync(file, text.split('"/repo/').join(`"${slashRoot}/`).split('"/project/').join(`"${slashRoot}/`));
  return file;
}

const diffOf = (name) => readDiffFile(`tests/fixtures/diffs/${name}`, repoRoot);

/** Runs with the fake CLI and returns the result plus the fake's records, after checking the temp folder is gone. */
async function runFake(t, diffName, fakeEnv = {}, options = {}) {
  const record = path.join(newDir(t), 'record.jsonl');
  const result = await runSelected({
    root: repoRoot,
    diff: await diffOf(diffName),
    env: { FAKE_PW_RECORD: record, ...fakeEnv },
    playwrightCli: fakeCli,
    ...options,
  });
  const records = fs.existsSync(record)
    ? fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
  for (const { env } of records) {
    const tempFolder = path.dirname(env.PLAYWRIGHT_JSON_OUTPUT_FILE);
    assert.equal(path.dirname(tempFolder), os.tmpdir());
    assert.ok(path.basename(tempFolder).startsWith('prcheck-run-'), tempFolder);
    assert.equal(fs.existsSync(tempFolder), false, `temp folder left behind: ${tempFolder}`);
  }
  return { result, records };
}

const DEMO_CART_TESTS = [
  { file: CART_SPEC, line: 12, title: 'cart > adds a product to the cart', project: 'chromium', tags: ['@cart'], status: 'passed', attempts: 1, error: null },
  { file: CART_SPEC, line: 24, title: 'cart > removes a product from the cart', project: 'chromium', tags: ['@cart'], status: 'passed', attempts: 1, error: null },
];

function withoutDurations(tests) {
  return tests.map(({ durationMs, ...rest }) => {
    assert.ok(Number.isInteger(durationMs) && durationMs >= 0, `durationMs ${durationMs}`);
    return rest;
  });
}

test('modify.diff: the fake gets exactly the subset arguments and a cleaned env with the report file, and CI as given', LIVE, async (t) => {
  const junk = Object.fromEntries(NINE_KEYS.map((key) => [key, 'from the caller']));
  const { result, records } = await runFake(t, 'modify.diff', { ...junk, FAKE_PW_REPORT: reportCopy(t, 'demo-cart.json') });

  assert.equal(records.length, 1);
  assert.deepEqual(records[0].argv, [
    'test', '--config', configArg, ...OPTIONS,
    fileArg(CART_SPEC),
    fileArg(CHECKOUT_SPEC),
  ]);
  // CI is passed through as the caller set it; the other eight keys are removed.
  assert.deepEqual(Object.keys(records[0].env), ['CI', 'PLAYWRIGHT_JSON_OUTPUT_FILE']);
  assert.equal(records[0].env.CI, 'from the caller');
  assert.equal(path.basename(records[0].env.PLAYWRIGHT_JSON_OUTPUT_FILE), 'report.json');

  assert.equal(result.verdict, 'passed');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.specs, [CART_SPEC, CHECKOUT_SPEC]);
  assert.deepEqual(result.command, [
    'test', '--config', 'demo/saucedemo', ...OPTIONS,
    '/^<root>/demo/saucedemo/tests/cart/cart\\.spec\\.ts$/',
    '/^<root>/demo/saucedemo/tests/checkout/checkout\\.spec\\.ts$/',
  ]);
  assert.deepEqual(withoutDurations(result.tests), DEMO_CART_TESTS);
  assert.deepEqual(result.counts, { ...ZERO, total: 2, passed: 2 });
  assert.deepEqual([result.errors, result.warnings], [[], []]);
});

test('mixed.diff gives mode full: every spec, and no file filter in the arguments', LIVE, async (t) => {
  const { result, records } = await runFake(t, 'mixed.diff', { FAKE_PW_REPORT: reportCopy(t, 'demo-cart.json') });
  assert.equal(result.mode, 'full');
  assert.deepEqual(result.specs, ALL_SPECS);
  assert.deepEqual(records.map((r) => r.argv), [['test', '--config', configArg, ...OPTIONS]]);
  assert.deepEqual(result.command, ['test', '--config', 'demo/saucedemo', ...OPTIONS]);
  assert.deepEqual([result.verdict, result.exitCode], ['passed', 0]);
});

test('delete.diff gives nothing-to-run with exit 0, and the fake never starts', LIVE, async (t) => {
  const { result, records } = await runFake(t, 'delete.diff', { FAKE_PW_EXIT: '1' });
  assert.deepEqual(records, []);
  assert.deepEqual(result, {
    schemaVersion: 1,
    source: { type: 'file', path: 'tests/fixtures/diffs/delete.diff' },
    mode: 'none',
    playwrightDir: 'demo/saucedemo',
    specs: [],
    command: null,
    verdict: 'nothing-to-run',
    exitCode: 0,
    counts: ZERO,
    durationMs: 0,
    tests: [],
    errors: [],
    warnings: [],
  });
});

test('dryRun gives not-run with exit 0 and the command, and the fake never starts', LIVE, async (t) => {
  const { result, records } = await runFake(t, 'modify.diff', { FAKE_PW_EXIT: '1' }, { dryRun: true });
  assert.deepEqual(records, []);
  assert.deepEqual(result, {
    schemaVersion: 1,
    source: { type: 'file', path: 'tests/fixtures/diffs/modify.diff' },
    mode: 'subset',
    playwrightDir: 'demo/saucedemo',
    specs: [CART_SPEC, CHECKOUT_SPEC],
    command: [
      'test', '--config', 'demo/saucedemo', ...OPTIONS,
      '/^<root>/demo/saucedemo/tests/cart/cart\\.spec\\.ts$/',
      '/^<root>/demo/saucedemo/tests/checkout/checkout\\.spec\\.ts$/',
    ],
    verdict: 'not-run',
    exitCode: 0,
    counts: ZERO,
    durationMs: 0,
    tests: [],
    errors: [],
    warnings: [],
  });
});

// Counted by hand from the spec sources in tests/fixtures/results/README.md: three passed (the @cart test
// in two projects and the test.fail() test), one flaky, one skipped, one failed, one timed out.
const SYNTHETIC_COUNTS = { total: 7, passed: 3, failed: 1, flaky: 1, skipped: 1, timedOut: 1, interrupted: 0 };

for (const exit of ['1', '0']) {
  test(`a report with a failed test gives verdict failed and exit 1 when Playwright exits ${exit}`, LIVE, async (t) => {
    const { result, records } = await runFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'synthetic-mixed.json'), FAKE_PW_EXIT: exit });
    assert.equal(records.length, 1);
    assert.deepEqual([result.verdict, result.exitCode], ['failed', 1]);
    assert.deepEqual(result.counts, SYNTHETIC_COUNTS);
    assert.deepEqual([result.errors, result.warnings], [[], []]);
  });
}

test('a missing report gives exit 2 with the first stderr line', LIVE, async (t) => {
  const stderr = '\nError: browserType.launch: Executable does not exist\nsecond line\n';
  const { result, records } = await runFake(t, 'modify.diff', { FAKE_PW_STDERR: stderr, FAKE_PW_EXIT: '1' });
  assert.equal(records.length, 1);
  assert.deepEqual([result.verdict, result.exitCode, result.durationMs, result.tests], ['error', 2, 0, []]);
  assert.deepEqual(result.errors, ['Playwright wrote no JSON report (exit code 1): Error: browserType.launch: Executable does not exist']);
  assert.deepEqual(result.warnings, ['No tests ran for the selected specs']);
});

test('a report that is not valid JSON gives exit 2', LIVE, async (t) => {
  const bad = path.join(newDir(t), 'bad.json');
  fs.writeFileSync(bad, '{ "suites": [');
  const { result } = await runFake(t, 'modify.diff', { FAKE_PW_REPORT: bad });
  assert.deepEqual([result.verdict, result.exitCode], ['error', 2]);
  assert.deepEqual(result.errors, ['The Playwright JSON report is not valid JSON']);
});

test('a valid JSON file that is not a report gives exit 2', LIVE, async (t) => {
  const other = path.join(newDir(t), 'other.json');
  fs.writeFileSync(other, '{ "cart": ["sauce-labs-backpack"] }');
  const { result } = await runFake(t, 'modify.diff', { FAKE_PW_REPORT: other });
  assert.deepEqual([result.verdict, result.exitCode], ['error', 2]);
  assert.deepEqual(result.errors, ['The Playwright JSON report does not have the expected shape']);
});

test('top-level-error.json gives exit 2 with the repo-relative error line', LIVE, async (t) => {
  const { result } = await runFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'top-level-error.json'), FAKE_PW_EXIT: '1' });
  assert.deepEqual([result.verdict, result.exitCode, result.tests], ['error', 2, []]);
  assert.deepEqual(result.errors, ['demo/shop/tests/inventory/inventory.spec.ts:3: Error: inventory data file is missing']);
});

test('exit 1 with an all-passed report gives exit 2 with the exact message', LIVE, async (t) => {
  const { result } = await runFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'demo-cart.json'), FAKE_PW_EXIT: '1' });
  assert.deepEqual([result.verdict, result.exitCode], ['error', 2]);
  assert.deepEqual(result.errors, ['Playwright exited with code 1 but no test failed']);
  assert.deepEqual(withoutDurations(result.tests), DEMO_CART_TESTS);
});

test('a hanging Playwright is stopped at the kill timeout with exit 2', LIVE, async (t) => {
  const { result, records } = await runFake(t, 'modify.diff', { FAKE_PW_HANG: '1' }, { timeoutMs: HANG_TIMEOUT_MS });
  assert.equal(records.length, 1);
  assert.deepEqual([result.verdict, result.exitCode, result.tests], ['error', 2, []]);
  assert.deepEqual(result.errors, [`Playwright was stopped after the kill timeout of ${HANG_TIMEOUT_MS} ms`]);
});
