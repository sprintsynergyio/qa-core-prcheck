import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanup, createTempRepo, gitEnv } from './helpers/git-repo.mjs';

/**
 * The run command, run as a process. No real Playwright test runs here: the cases use mode none,
 * --dry-run, or a made-up @playwright/test package. The demo inventory is read with --list, which
 * opens no browser.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const lines = (...ls) => ls.map((l) => `${l}\n`).join('');
// Runs that start Playwright get a generous limit; none of them waits on a timer.
const LIVE = { timeout: 120_000 };

const USAGE = `qa-core-prcheck <command> [options]

Commands:
  diff            List the files changed between two git refs, or in a saved diff
  select          Pick the Playwright specs a change can affect (does not run them)
  run             Run the picked Playwright specs and report the results
  check           Pick, run and summarize: writes the Markdown summary for the PR
  rank            Apply optional LLM ranking to a summary that check already wrote
  comment         Post or update the sticky PR comment from a summary file

Options:
  -v, --version   Print the version
  -h, --help      Print this help

Run qa-core-prcheck <command> --help for the command options.
`;

const RUN_USAGE = `qa-core-prcheck run --base <ref> [--head <ref>] [--root <dir>] [--json] [--dry-run]
qa-core-prcheck run --diff-file <path> [--root <dir>] [--json] [--dry-run]

Picks the Playwright specs a change can affect, runs them and reports the results.

Options:
  --base <ref>           Compare against the merge base of this ref and the head
  --head <ref>           The head ref (default: HEAD)
  --diff-file <path>     Read a saved unified git diff instead of running git
  --root <dir>           The repository root (default: the current folder)
  --timeout-minutes <n>  Kill timeout for Playwright, a whole number from 1 to 30 (default: 30)
  --json                 Print JSON instead of text
  --dry-run              Print the Playwright command without running it
  -h, --help             Print this help

Exit codes: 0 all picked tests passed or nothing to run, 1 a picked test failed, 2 usage or tool error.
`;
const HELP_LINE = (command) => `Run qa-core-prcheck ${command} --help for usage.\n`;

// Usage errors run from an empty temp folder where git cannot look upward,
// so even a bug could never send git to this repo.
const emptyDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
const emptyEnv = { ...gitEnv(), GIT_CEILING_DIRECTORIES: path.dirname(emptyDir) };
after(() => cleanup(emptyDir));

const runCli = (args, { cwd = repoRoot, env = process.env } = {}) => new Promise((resolve) => {
  // process.execPath, not 'node': the test must not depend on PATH.
  const child = spawn(process.execPath, [cliJs, ...args], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

const d = (file) => `demo/saucedemo/${file}`;
const CART_SPEC = d('tests/cart/cart.spec.ts');
const CHECKOUT_SPEC = d('tests/checkout/checkout.spec.ts');
const OPTIONS = ['--reporter=json', '--pass-with-no-tests', '--forbid-only'];
const SUBSET_DISPLAY = [
  'test', '--config', 'demo/saucedemo', ...OPTIONS,
  '/^<root>/demo/saucedemo/tests/cart/cart\\.spec\\.ts$/',
  '/^<root>/demo/saucedemo/tests/checkout/checkout\\.spec\\.ts$/',
];

test('the top-level help lists the run command', async () => {
  const r = await runCli(['--help'], { cwd: emptyDir, env: emptyEnv });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, USAGE);
  assert.equal(r.stderr, '');
});

for (const flag of ['--help', '-h']) {
  test(`run ${flag} prints the run help and exits 0`, async () => {
    const r = await runCli(['run', flag], { cwd: emptyDir, env: emptyEnv });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, RUN_USAGE);
    assert.equal(r.stderr, '');
  });
}

const USAGE_ERRORS = [
  [['run'], 'Missing required option: --base <ref> or --diff-file <path>'],
  [['run', '--json'], 'Missing required option: --base <ref> or --diff-file <path>'],
  [['run', '--dry-run'], 'Missing required option: --base <ref> or --diff-file <path>'],
  [['run', '--root', '.'], 'Missing required option: --base <ref> or --diff-file <path>'],
  [['run', '--nope'], 'Unknown argument: --nope'],
  [['run', '--root=.'], 'Unknown argument: --root=.'],
  [['run', '--dry-run=yes'], 'Unknown argument: --dry-run=yes'],
  [['run', '--diff-file', 'x.diff', 'extra'], 'Unknown argument: extra'],
  [['run', '--help', '--json'], 'Unknown argument: --json'],
  [['run', '--help', '--dry-run'], 'Unknown argument: --dry-run'],
  [['run', '--dry-run', '--help'], 'Unknown argument: --help'],
  [['run', '--base'], 'Missing value for --base'],
  [['run', '--diff-file'], 'Missing value for --diff-file'],
  [['run', '--root'], 'Missing value for --root'],
  [['run', '--root', '--dry-run'], 'Missing value for --root'],
  [['run', '--base', 'main', '--head'], 'Missing value for --head'],
  [['run', '--root', 'a', '--root', 'b'], 'Duplicate argument: --root'],
  [['run', '--json', '--json', '--base', 'main'], 'Duplicate argument: --json'],
  [['run', '--dry-run', '--dry-run', '--base', 'main'], 'Duplicate argument: --dry-run'],
  [['run', '--base', 'main', '--diff-file', 'x.diff'], 'Use either --base or --diff-file, not both'],
  [['run', '--diff-file', 'x.diff', '--head', 'main'], '--head can only be used with --base'],
  [['run', '--head', 'main', '--dry-run'], '--head can only be used with --base'],
  [['run', '--timeout-minutes'], 'Missing value for --timeout-minutes'],
  [['run', '--timeout-minutes', '0', '--diff-file', 'x.diff'], '--timeout-minutes must be a whole number of minutes from 1 to 30'],
  [['run', '--timeout-minutes', '31', '--diff-file', 'x.diff'], '--timeout-minutes must be a whole number of minutes from 1 to 30'],
  [['run', '--timeout-minutes', '08', '--diff-file', 'x.diff'], '--timeout-minutes must be a whole number of minutes from 1 to 30'],
  [['run', '--timeout-minutes', '30', '--timeout-minutes', '1', '--diff-file', 'x.diff'], 'Duplicate argument: --timeout-minutes'],
];

for (const [args, message] of USAGE_ERRORS) {
  test(`${args.join(' ')}: exits 2 with "${message}" and an empty stdout`, async () => {
    const r = await runCli(args, { cwd: emptyDir, env: emptyEnv });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${message}\n${HELP_LINE('run')}`);
  });
}

for (const command of ['diff', 'select']) {
  test(`${command} still rejects --dry-run as an unknown argument`, async () => {
    const r = await runCli([command, '--dry-run', '--diff-file', 'x.diff'], { cwd: emptyDir, env: emptyEnv });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `Unknown argument: --dry-run\n${HELP_LINE(command)}`);
  });
}

test('run --diff-file delete.diff prints nothing to run and exits 0', LIVE, async () => {
  const r = await runCli(['run', '--diff-file', 'tests/fixtures/diffs/delete.diff']);
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, lines(
    'Mode: none',
    'Specs: 0',
    'Result: nothing to run',
    'No specs were selected, so no tests ran.',
  ));
});

test('run --diff-file modify.diff --dry-run prints the command and starts nothing', LIVE, async () => {
  const r = await runCli(['run', '--diff-file', 'tests/fixtures/diffs/modify.diff', '--dry-run']);
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, lines(
    'Mode: subset',
    'Specs: 2',
    `Command: playwright ${SUBSET_DISPLAY.join(' ')}`,
    'Result: not run (dry run)',
  ));
});

test('run --diff-file modify.diff --dry-run --json prints the keys in the order of RunResult', LIVE, async () => {
  const r = await runCli(['run', '--diff-file', 'tests/fixtures/diffs/modify.diff', '--dry-run', '--json']);
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.ok(r.stdout.endsWith('}\n'));
  const json = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(json), [
    'schemaVersion', 'source', 'mode', 'playwrightDir', 'specs', 'command', 'verdict', 'exitCode',
    'counts', 'durationMs', 'tests', 'errors', 'warnings',
  ]);
  assert.deepEqual(Object.keys(json.counts), ['total', 'passed', 'failed', 'flaky', 'skipped', 'timedOut', 'interrupted']);
  assert.deepEqual(json, {
    schemaVersion: 1,
    source: { type: 'file', path: 'tests/fixtures/diffs/modify.diff' },
    mode: 'subset',
    playwrightDir: 'demo/saucedemo',
    specs: [CART_SPEC, CHECKOUT_SPEC],
    command: SUBSET_DISPLAY,
    verdict: 'not-run',
    exitCode: 0,
    counts: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, timedOut: 0, interrupted: 0 },
    durationMs: 0,
    tests: [],
    errors: [],
    warnings: [],
  });
});

test('run --base nope in a temp git repo exits 2 with Unknown ref and an empty stdout', async (t) => {
  const repo = createTempRepo();
  t.after(() => cleanup(repo.dir));
  const r = await runCli(['run', '--base', 'nope'], { cwd: repo.dir, env: repo.env });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `Unknown ref: nope. Fetch it first, for example git fetch origin <branch>\n${HELP_LINE('run')}`);
});

test('a runner error exits 2, prints the result on stdout and the first error on stderr', LIVE, async (t) => {
  // A made-up @playwright/test: --list prints one cart spec; a test run fails before writing a report.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
  t.after(() => cleanup(dir));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('node_modules/@playwright/test/package.json', JSON.stringify({ name: '@playwright/test', version: '0.0.0', exports: { './cli': './cli.js' } }));
  write('node_modules/@playwright/test/cli.js', lines(
    "const path = require('node:path');",
    "if (process.argv.includes('--list')) {",
    "  const spec = { title: 'adds a backpack', tags: ['cart'], tests: [{ projectName: 'chromium' }], file: 'cart/cart.spec.ts', line: 3 };",
    "  const rootDir = path.join(process.cwd(), 'demo', 'saucedemo', 'tests');",
    "  process.stdout.write(JSON.stringify({ config: { rootDir }, suites: [{ title: 'cart/cart.spec.ts', specs: [spec] }], errors: [] }));",
    '} else {',
    "  process.stderr.write('Error: chromium is not installed\\n');",
    '  process.exitCode = 1;',
    '}',
  ));
  write('demo/saucedemo/playwright.config.ts', lines('export default {};'));
  write('demo/saucedemo/tests/cart/cart.spec.ts', lines("import { test } from '@playwright/test';"));

  const mixed = path.join(repoRoot, 'tests', 'fixtures', 'diffs', 'mixed.diff');
  const r = await runCli(['run', '--diff-file', mixed, '--root', dir], { cwd: dir });
  const error = 'Playwright wrote no JSON report (exit code 1): Error: chromium is not installed';
  assert.equal(r.status, 2);
  assert.equal(r.stderr, `${error}\n`);
  assert.equal(r.stdout, lines(
    'Mode: full',
    'Specs: 1',
    `Command: playwright test --config demo/saucedemo ${OPTIONS.join(' ')}`,
    'Result: error',
    'Tests: 0 total, 0 passed, 0 failed, 0 flaky, 0 skipped, 0 timed out, 0 interrupted',
    'Duration: 0.0s',
    'Errors:',
    `  - ${error}`,
    'Warnings:',
    '  - No tests ran for the selected specs',
  ));
});
