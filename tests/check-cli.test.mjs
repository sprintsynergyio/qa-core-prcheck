import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanup, createTempRepo, gitEnv } from './helpers/git-repo.mjs';

/**
 * The check command, run as a process with its current folder in a temp folder, so no summary or JSON
 * file can land in this repo. No real Playwright test runs here: the cases use mode none, --dry-run,
 * or a made-up @playwright/test package. The demo inventory is read with --list, which opens no browser.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const summaryDir = path.join(repoRoot, 'tests', 'fixtures', 'summary');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const lines = (...ls) => ls.map((l) => `${l}\n`).join('');
// Runs that start Playwright get a generous limit; none of them waits on a timer.
const LIVE = { timeout: 120_000 };
const diffFile = (name) => path.join(repoRoot, 'tests', 'fixtures', 'diffs', name);

/** A golden with the test version replaced by the real one, as the CLI prints it. */
const goldenOf = (name) => fs.readFileSync(path.join(summaryDir, `${name}.md`), 'utf8')
  .replace('qa-core-prcheck 0.0.0-test._', `qa-core-prcheck ${pkgVersion}._`);

// Taken out of every child env unless a case sets them: the CI and reporter keys, written here rather
// than taken from src, and GITHUB_STEP_SUMMARY, so a CI host's own job summary is never written to.
const HOST_KEYS = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL', 'BUILD_URL', 'PW_TEST_REPORTER',
  'PLAYWRIGHT_JSON_OUTPUT_NAME', 'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JSON_OUTPUT_DIR', 'GITHUB_STEP_SUMMARY',
  'PRCHECK_LLM_API_KEY',
];
function withoutHostKeys(env) {
  const copy = { ...env };
  for (const key of HOST_KEYS) delete copy[key];
  return copy;
}

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

const CHECK_USAGE = `qa-core-prcheck check --base <ref> [--head <ref>] [--root <dir>] [--summary-file <path>] [--json] [--dry-run] [--skip-llm]
qa-core-prcheck check --diff-file <path> [--root <dir>] [--summary-file <path>] [--json] [--dry-run] [--skip-llm]

Picks the Playwright specs a change can affect, runs them and writes one Markdown summary.

Options:
  --base <ref>           Compare against the merge base of this ref and the head
  --head <ref>           The head ref (default: HEAD)
  --diff-file <path>     Read a saved unified git diff instead of running git
  --root <dir>           The repository root (default: the current folder)
  --summary-file <path>  Where to write the summary (default: prcheck-summary.md)
  --timeout-minutes <n>  Kill timeout for Playwright, a whole number from 1 to 30 (default: 30)
  --json                 Print JSON instead of the Markdown summary
  --dry-run              Build the command and summary without running tests or writing files
  --skip-llm             Do not rank. The action uses this so the API key stays out of Playwright
  -h, --help             Print this help

Also appends the summary to $GITHUB_STEP_SUMMARY when it is set.
Reads "llm" from qa-core-prcheck.config.json for optional advisory LLM ranking (off by default).
The API key is read only from the env var PRCHECK_LLM_API_KEY. --skip-llm makes no ranking call.
Exit codes: 0 all picked tests passed or nothing to run, 1 a picked test failed, 2 usage or tool error.
`;
const HELP_LINE = 'Run qa-core-prcheck check --help for usage.\n';

// Usage errors run from an empty temp folder where git cannot look upward,
// so even a bug could never send git to this repo.
const emptyDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
const emptyEnv = { ...withoutHostKeys(gitEnv()), GIT_CEILING_DIRECTORIES: path.dirname(emptyDir) };
after(() => cleanup(emptyDir));

const runCli = (args, { cwd, env = withoutHostKeys(process.env) }) => new Promise((resolve) => {
  // process.execPath, not 'node': the test must not depend on PATH.
  const child = spawn(process.execPath, [cliJs, ...args], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

function newDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
  t.after(() => cleanup(dir));
  return dir;
}

const read = (file) => fs.readFileSync(file, 'utf8');

test('the top-level help lists the check command and no longer promises it', async () => {
  const r = await runCli(['--help'], { cwd: emptyDir, env: emptyEnv });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, USAGE);
  assert.equal(r.stderr, '');
});

for (const flag of ['--help', '-h']) {
  test(`check ${flag} prints the check help and exits 0`, async () => {
    const r = await runCli(['check', flag], { cwd: emptyDir, env: emptyEnv });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, CHECK_USAGE);
    assert.equal(r.stderr, '');
  });
}

const USAGE_ERRORS = [
  [['check'], 'Missing required option: --base <ref> or --diff-file <path>'],
  [['check', '--json'], 'Missing required option: --base <ref> or --diff-file <path>'],
  [['check', '--dry-run'], 'Missing required option: --base <ref> or --diff-file <path>'],
  [['check', '--summary-file', 's.md'], 'Missing required option: --base <ref> or --diff-file <path>'],
  [['check', '--nope'], 'Unknown argument: --nope'],
  [['check', '--summary-file=s.md'], 'Unknown argument: --summary-file=s.md'],
  [['check', '--diff-file', 'x.diff', 'extra'], 'Unknown argument: extra'],
  [['check', '--help', '--json'], 'Unknown argument: --json'],
  [['check', '--dry-run', '--help'], 'Unknown argument: --help'],
  [['check', '--base'], 'Missing value for --base'],
  [['check', '--diff-file'], 'Missing value for --diff-file'],
  [['check', '--root'], 'Missing value for --root'],
  [['check', '--summary-file'], 'Missing value for --summary-file'],
  [['check', '--summary-file', '--json', '--diff-file', 'x.diff'], 'Missing value for --summary-file'],
  [['check', '--base', 'main', '--head'], 'Missing value for --head'],
  [['check', '--summary-file', 'a.md', '--summary-file', 'b.md', '--diff-file', 'x.diff'], 'Duplicate argument: --summary-file'],
  [['check', '--root', 'a', '--root', 'b'], 'Duplicate argument: --root'],
  [['check', '--json', '--json', '--base', 'main'], 'Duplicate argument: --json'],
  [['check', '--dry-run', '--dry-run', '--base', 'main'], 'Duplicate argument: --dry-run'],
  [['check', '--base', 'main', '--diff-file', 'x.diff'], 'Use either --base or --diff-file, not both'],
  [['check', '--diff-file', 'x.diff', '--head', 'main'], '--head can only be used with --base'],
  [['check', '--timeout-minutes'], 'Missing value for --timeout-minutes'],
  [['check', '--timeout-minutes', '0', '--diff-file', 'x.diff'], '--timeout-minutes must be a whole number of minutes from 1 to 30'],
  [['check', '--timeout-minutes', '90', '--diff-file', 'x.diff'], '--timeout-minutes must be a whole number of minutes from 1 to 30'],
  [['check', '--skip-llm', '--skip-llm', '--diff-file', 'x.diff'], 'Duplicate argument: --skip-llm'],
];

for (const [args, message] of USAGE_ERRORS) {
  test(`${args.join(' ')}: exits 2 with "${message}", an empty stdout and no file written`, async () => {
    const r = await runCli(args, { cwd: emptyDir, env: emptyEnv });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${message}\n${HELP_LINE}`);
    assert.deepEqual(fs.readdirSync(emptyDir), []);
  });
}

test('delete.diff: prints the no-tests-needed summary, writes it and the two JSON files, exits 0', LIVE, async (t) => {
  const cwd = newDir(t);
  const r = await runCli(['check', '--diff-file', diffFile('delete.diff'), '--root', repoRoot], { cwd });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, goldenOf('no-tests-needed'));
  assert.deepEqual(fs.readdirSync(cwd).sort(), ['prcheck-results.json', 'prcheck-selection.json', 'prcheck-summary.md']);
  assert.equal(read(path.join(cwd, 'prcheck-summary.md')), r.stdout);
  assert.equal(JSON.parse(read(path.join(cwd, 'prcheck-selection.json'))).mode, 'none');
  assert.equal(JSON.parse(read(path.join(cwd, 'prcheck-results.json'))).verdict, 'nothing-to-run');
});

test('delete.diff with GITHUB_STEP_SUMMARY set: the summary is appended there too', LIVE, async (t) => {
  const cwd = newDir(t);
  const step = path.join(cwd, 'step.md');
  fs.writeFileSync(step, 'text from an earlier command\n');
  const env = { ...withoutHostKeys(process.env), GITHUB_STEP_SUMMARY: step };
  const r = await runCli(['check', '--diff-file', diffFile('delete.diff'), '--root', repoRoot, '--summary-file', 's3.md'], { cwd, env });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, goldenOf('no-tests-needed'));
  assert.equal(read(path.join(cwd, 's3.md')), r.stdout);
  assert.equal(read(step), `text from an earlier command\n${r.stdout}\n`);
});

test('modify.diff --dry-run: prints the not-run summary and writes no file, even with GITHUB_STEP_SUMMARY set', LIVE, async (t) => {
  const cwd = newDir(t);
  const env = { ...withoutHostKeys(process.env), GITHUB_STEP_SUMMARY: path.join(cwd, 'step.md') };
  const r = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', repoRoot, '--dry-run'], { cwd, env });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, goldenOf('not-run'));
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('--dry-run --json: keys in the documented order, file null and stepSummary false', LIVE, async (t) => {
  const cwd = newDir(t);
  const r = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', repoRoot, '--dry-run', '--json'], { cwd });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.ok(r.stdout.endsWith('}\n'));
  const json = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(json), ['schemaVersion', 'selection', 'result', 'summary', 'exitCode']);
  assert.deepEqual(Object.keys(json.summary), ['verdict', 'fullSuite', 'truncated', 'omitted', 'bytes', 'file', 'stepSummary']);
  assert.deepEqual(json.summary, {
    verdict: 'not-run', fullSuite: false, truncated: false, omitted: 0,
    bytes: Buffer.byteLength(goldenOf('not-run')), file: null, stepSummary: false,
  });
  assert.deepEqual([json.schemaVersion, json.selection.mode, json.result.verdict, json.exitCode], [1, 'subset', 'not-run', 0]);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('--json without --dry-run names the summary file relative to the current folder', LIVE, async (t) => {
  const cwd = newDir(t);
  const r = await runCli(['check', '--diff-file', diffFile('delete.diff'), '--root', repoRoot, '--json'], { cwd });
  assert.equal(r.status, 0);
  const json = JSON.parse(r.stdout);
  assert.deepEqual([json.summary.file, json.summary.stepSummary, json.exitCode], ['prcheck-summary.md', false, 0]);
  assert.equal(read(path.join(cwd, 'prcheck-summary.md')), goldenOf('no-tests-needed'));
});

test('a summary file in a missing folder: the summary is still printed, the error goes to stderr, exit 2', LIVE, async (t) => {
  const cwd = newDir(t);
  const r = await runCli(['check', '--diff-file', diffFile('delete.diff'), '--root', repoRoot, '--summary-file', 'missing/s.md'], { cwd });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, goldenOf('no-tests-needed'));
  assert.equal(r.stderr, 'Cannot write missing/s.md: ENOENT\n');
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('check --base nope in a temp git repo: exit 2, empty stdout, the message on stderr and the pre-run-error summary', async (t) => {
  const repo = createTempRepo();
  t.after(() => cleanup(repo.dir));
  const r = await runCli(['check', '--base', 'nope'], { cwd: repo.dir, env: withoutHostKeys(repo.env) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `Unknown ref: nope. Fetch it first, for example git fetch origin <branch>\n${HELP_LINE}`);
  assert.deepEqual(fs.readdirSync(repo.dir).filter((name) => name !== '.git'), ['prcheck-summary.md']);
  assert.equal(read(path.join(repo.dir, 'prcheck-summary.md')), goldenOf('pre-run-error'));
});

test('check --base nope --dry-run writes no summary', async (t) => {
  const repo = createTempRepo();
  t.after(() => cleanup(repo.dir));
  const r = await runCli(['check', '--base', 'nope', '--dry-run'], { cwd: repo.dir, env: withoutHostKeys(repo.env) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.deepEqual(fs.readdirSync(repo.dir), ['.git']);
});

test('a runner error exits 2, prints the summary on stdout and the first error on stderr', LIVE, async (t) => {
  // A made-up @playwright/test: --list prints one cart spec; a test run fails before writing a report.
  const dir = newDir(t);
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

  const cwd = newDir(t);
  const r = await runCli(['check', '--diff-file', diffFile('mixed.diff'), '--root', dir], { cwd });
  const error = 'Playwright wrote no JSON report (exit code 1): Error: chromium is not installed';
  assert.equal(r.status, 2);
  assert.equal(r.stderr, `${error}\n`);
  // The full suite reasons depend on the mixed.diff rules and are asserted in the select tests.
  assert.ok(r.stdout.startsWith(lines(
    '<!-- qa-core-prcheck:summary -->',
    '## PR Check: Error (Full Suite Run)',
    '',
    'The check could not finish, so the test result is unknown. See Errors below.',
    '',
    '### Why The Full Suite Was Picked',
  )));
  assert.ok(r.stdout.includes(lines(
    '### Picked Specs',
    '| Spec | Tests | Result | Reasons |',
    '| --- | ---: | --- | --- |',
    // mixed.diff changes the cart spec too, so rule 3 adds its own reason before the full suite one.
    '| `demo/saucedemo/tests/cart/cart.spec.ts` | 1 | not run | Spec changed: demo/saucedemo/tests/cart/cart.spec.ts<br>Part of the full suite run |',
    '',
    '### Errors',
    `- ${error}`,
    '',
    '### Warnings',
    '- No tests ran for the selected specs',
    '',
    // In this made-up root no spec imports users.ts or cart-page.ts (rule 8), and src/cli.ts is rule 11.
    '### Suggested Tests',
    '| File | Why | Suggested Test |',
    '| --- | --- | --- |',
    '| `demo/saucedemo/fixtures/users.ts` | No spec imports this file. | Add a spec that imports demo/saucedemo/fixtures/users.ts and uses it, or remove the file if nothing needs it. |',
    '| `demo/saucedemo/pages/cart-page.ts` | No spec imports this file. | Add a spec that imports demo/saucedemo/pages/cart-page.ts and uses it, or remove the file if nothing needs it. |',
    '| `src/cli.ts` | No rule or spec maps this file, so it falls back to the full suite. | Add a spec that covers the behaviour in src/cli.ts, or map it to a tag with an area in qa-core-prcheck.config.json. |',
    '',
    '---',
    `_Advisory check, exit code 2. Mode full, 1 of 1 specs picked. qa-core-prcheck ${pkgVersion}._`,
  )));
  assert.equal(read(path.join(cwd, 'prcheck-summary.md')), r.stdout);
});

test('add.diff --dry-run with a suggestion: exit 0, No Tests Needed, and the section is the only addition', LIVE, async (t) => {
  const cwd = newDir(t);
  const wishlist = 'demo/saucedemo/pages/wishlist-page.ts';
  const section = [
    '### Suggested Tests',
    '| File | Why | Suggested Test |',
    '| --- | --- | --- |',
    `| \`${wishlist}\` | No spec imports this file. | Add a spec that imports ${wishlist} and uses it, or remove the file if nothing needs it. |`,
  ];
  const r = await runCli(['check', '--diff-file', diffFile('add.diff'), '--root', repoRoot, '--dry-run'], { cwd });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, goldenOf('no-tests-needed').replace('\n---\n', lines('', ...section, '', '---')));

  const j = await runCli(['check', '--diff-file', diffFile('add.diff'), '--root', repoRoot, '--dry-run', '--json'], { cwd });
  assert.equal(j.status, 0);
  const json = JSON.parse(j.stdout);
  assert.deepEqual([json.summary.verdict, json.summary.fullSuite, json.result.verdict, json.result.exitCode, json.exitCode], [
    'no-tests-needed', false, 'nothing-to-run', 0, 0,
  ]);
  assert.equal(Object.keys(json.selection).at(-1), 'suggestions');
  assert.deepEqual(json.selection.suggestions.map((s) => [s.file, s.kind]), [[wishlist, 'unimported-support']]);
  assert.equal(json.summary.bytes, Buffer.byteLength(r.stdout));
  assert.deepEqual(fs.readdirSync(cwd), []);
});

// The optional LLM ranking (PR 8). The CLI cannot take a fake fetch, so these cases either make no
// request (key unset, bad config, --dry-run) or load tests/fixtures/llm/no-network.mjs with --import,
// which replaces the built-in fetch with one that records the URL and throws. No request leaves the process.

const FAKE_KEY = 'prcheck_fake_llm_key_for_tests';
const noNetwork = path.join(repoRoot, 'tests', 'fixtures', 'llm', 'no-network.mjs');
const OFF_LINE = 'LLM ranking is off: the env var PRCHECK_LLM_API_KEY is not set or is empty.\n';

/**
 * A made-up @playwright/test root with one cart spec that passes, and an optional config file. The
 * fake cli.js records, for each call, whether --list was given and which LLM key names it could see.
 */
function llmRoot(t, config) {
  const dir = newDir(t);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('node_modules/@playwright/test/package.json', JSON.stringify({ name: '@playwright/test', version: '0.0.0', exports: { './cli': './cli.js' } }));
  write('node_modules/@playwright/test/cli.js', lines(
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const keys = ['PRCHECK_LLM_API_KEY'].filter((k) => k in process.env);",
    "fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ list: process.argv.includes('--list'), keys }) + '\\n');",
    "const rootDir = path.join(process.cwd(), 'demo', 'saucedemo', 'tests');",
    "const results = [{ status: 'passed', duration: 5 }];",
    "const spec = { title: 'adds a backpack', ok: true, tags: ['cart'], file: 'cart/cart.spec.ts', line: 3,",
    "  tests: [{ projectName: 'chromium', status: 'expected', expectedStatus: 'passed', results }] };",
    "const report = { config: { rootDir }, suites: [{ title: 'cart/cart.spec.ts', file: 'cart/cart.spec.ts', specs: [spec] }], errors: [], stats: { duration: 12 } };",
    "if (process.argv.includes('--list')) process.stdout.write(JSON.stringify(report));",
    'else fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify(report));',
  ));
  write('demo/saucedemo/playwright.config.ts', lines('export default {};'));
  write('demo/saucedemo/pages/cart-page.ts', lines('export class CartPage {}'));
  write('demo/saucedemo/tests/cart/cart.spec.ts', lines("import { CartPage } from '../../pages/cart-page';"));
  if (config !== undefined) write('qa-core-prcheck.config.json', JSON.stringify(config));
  const calls = () => {
    const file = path.join(dir, 'node_modules', '@playwright', 'test', 'calls.jsonl');
    return fs.existsSync(file) ? read(file).trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  return { dir, calls };
}

const LLM_CONFIG = { llm: { provider: 'anthropic', model: 'example-model' } };
const readAll = (cwd) => Object.fromEntries(fs.readdirSync(cwd).sort().map((name) => [name, read(path.join(cwd, name))]));
/** The results JSON with its timing fields made fixed, since two runs never take the same time. */
const steadyFiles = (files) => JSON.parse(JSON.stringify(files, (key, value) => (key === 'prcheck-results.json'
  ? JSON.stringify({ ...JSON.parse(value), durationMs: 0 }) : value)));

test('check: provider set but key unset: stdout and files byte-identical to no llm config, plus the stderr off line', LIVE, async (t) => {
  const plainRoot = llmRoot(t);
  const llmRootDir = llmRoot(t, LLM_CONFIG);
  const record = path.join(newDir(t), 'fetch.txt');
  const env = { ...withoutHostKeys(process.env), NODE_OPTIONS: `--import=${noNetwork}`, PRCHECK_TEST_FETCH_RECORD: record };
  const plainCwd = newDir(t);
  const llmCwd = newDir(t);
  const plain = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', plainRoot.dir], { cwd: plainCwd, env });
  const off = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', llmRootDir.dir], { cwd: llmCwd, env: { ...env, PRCHECK_LLM_API_KEY: '' } });
  assert.deepEqual([plain.status, plain.stderr], [0, '']);
  assert.deepEqual([off.status, off.stderr], [0, OFF_LINE]);
  assert.equal(off.stdout, plain.stdout);
  assert.ok(off.stdout.startsWith('<!-- qa-core-prcheck:summary -->\n## PR Check: Passed\n'));
  assert.deepEqual(steadyFiles(readAll(llmCwd)), steadyFiles(readAll(plainCwd)));
  assert.equal(fs.existsSync(record), false, 'no fetch');
  // --json --dry-run: the same JSON, with no llm key, and no off line, since a dry run never ranks (PR 8 review).
  const j = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', llmRootDir.dir, '--json', '--dry-run'], { cwd: llmCwd, env });
  assert.equal(j.stderr, '');
  assert.deepEqual(Object.keys(JSON.parse(j.stdout)), ['schemaVersion', 'selection', 'result', 'summary', 'exitCode']);
});

test('check: a bad llm config exits 2 with the config error, before any Playwright call', LIVE, async (t) => {
  const root = llmRoot(t, { llm: { provider: 'claude', model: 'example-model' } });
  const cwd = newDir(t);
  const r = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', root.dir], { cwd });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.split('\n')[0], 'qa-core-prcheck.config.json: "llm.provider" must be one of none, anthropic, openai, gemini.');
  assert.deepEqual(root.calls(), []);
  // select ignores the llm block (Q1).
  const s = await runCli(['select', '--diff-file', diffFile('modify.diff'), '--root', root.dir, '--json'], { cwd });
  assert.equal(s.status, 0, s.stderr);
});

test('check: an llm config that names apiKeyEnv exits 2 before any Playwright call or fetch', LIVE, async (t) => {
  const root = llmRoot(t, { llm: { provider: 'openai', model: 'example-model', apiKeyEnv: 'GITHUB_TOKEN' } });
  const record = path.join(newDir(t), 'fetch.txt');
  const env = {
    ...withoutHostKeys(process.env), NODE_OPTIONS: `--import=${noNetwork}`, PRCHECK_TEST_FETCH_RECORD: record,
    PRCHECK_LLM_API_KEY: FAKE_KEY,
  };
  const r = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', root.dir], { cwd: newDir(t), env });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr.split('\n')[0], 'qa-core-prcheck.config.json: "llm.apiKeyEnv" is not supported. The API key is read only from the env var PRCHECK_LLM_API_KEY.');
  assert.equal(fs.existsSync(record), false, 'no fetch');
  assert.deepEqual(root.calls(), []);
});

test('check: a dry run with the key set makes no fetch, and the inventory child has no key', LIVE, async (t) => {
  const plainRoot = llmRoot(t);
  const root = llmRoot(t, { llm: { provider: 'openai', model: 'example-model' } });
  const record = path.join(newDir(t), 'fetch.txt');
  const env = {
    ...withoutHostKeys(process.env), NODE_OPTIONS: `--import=${noNetwork}`, PRCHECK_TEST_FETCH_RECORD: record,
    PRCHECK_LLM_API_KEY: FAKE_KEY, GITHUB_ACTIONS: 'true',
  };
  const cwd = newDir(t);
  const r = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', root.dir, '--dry-run'], { cwd, env });
  const plain = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', plainRoot.dir, '--dry-run'], { cwd, env: withoutHostKeys(process.env) });
  assert.deepEqual([r.status, r.stderr], [0, '']);
  assert.equal(r.stdout, plain.stdout);
  assert.equal(fs.existsSync(record), false, 'no fetch');
  assert.deepEqual(root.calls(), [{ list: true, keys: [] }]);
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('check --skip-llm with a provider and a key makes no fetch and prints no off line', LIVE, async (t) => {
  const plainRoot = llmRoot(t);
  const root = llmRoot(t, LLM_CONFIG);
  const record = path.join(newDir(t), 'fetch.txt');
  const env = {
    ...withoutHostKeys(process.env), NODE_OPTIONS: `--import=${noNetwork}`, PRCHECK_TEST_FETCH_RECORD: record,
    PRCHECK_LLM_API_KEY: FAKE_KEY, GITHUB_ACTIONS: 'true',
  };
  const skipped = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', root.dir, '--skip-llm'], { cwd: newDir(t), env });
  const plain = await runCli(
    ['check', '--diff-file', diffFile('modify.diff'), '--root', plainRoot.dir, '--skip-llm'],
    { cwd: newDir(t), env: withoutHostKeys(process.env) },
  );
  assert.deepEqual([skipped.status, skipped.stderr], [0, '']);
  assert.equal(skipped.stdout, plain.stdout);
  assert.equal(fs.existsSync(record), false, 'no fetch');
  assert.ok(root.calls().every((call) => call.keys.length === 0));
});

test('check: a dry run with a provider set and the key unset prints no off line, with or without --json', LIVE, async (t) => {
  const plainRoot = llmRoot(t);
  const root = llmRoot(t, LLM_CONFIG);
  const record = path.join(newDir(t), 'fetch.txt');
  const env = { ...withoutHostKeys(process.env), NODE_OPTIONS: `--import=${noNetwork}`, PRCHECK_TEST_FETCH_RECORD: record, PRCHECK_LLM_API_KEY: '' };
  const cwd = newDir(t);
  for (const extra of [[], ['--json']]) {
    const r = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', root.dir, '--dry-run', ...extra], { cwd, env });
    const plain = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', plainRoot.dir, '--dry-run', ...extra], { cwd, env });
    assert.deepEqual([r.status, r.stderr], [0, ''], extra.join(' '));
    assert.equal(r.stdout, plain.stdout);
  }
  assert.equal(fs.existsSync(record), false, 'no fetch');
  assert.deepEqual(fs.readdirSync(cwd), []);
});

test('check: a failed request is a skipped ranking: exit 0, the stderr line, and ::warning only without --json in Actions', LIVE, async (t) => {
  const root = llmRoot(t, LLM_CONFIG);
  const record = path.join(newDir(t), 'fetch.txt');
  const env = {
    ...withoutHostKeys(process.env), NODE_OPTIONS: `--import=${noNetwork}`, PRCHECK_TEST_FETCH_RECORD: record,
    PRCHECK_LLM_API_KEY: FAKE_KEY, GITHUB_ACTIONS: 'true',
  };
  const skipped = 'LLM ranking skipped: the provider could not be reached: ENETUNREACH (2 attempts). The deterministic order is used.';
  const cwd = newDir(t);
  const j = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', root.dir, '--json'], { cwd, env });
  assert.equal(j.status, 0);
  assert.equal(j.stderr, `${skipped}\n`);
  assert.ok(!j.stdout.includes('::warning'));
  const json = JSON.parse(j.stdout);
  assert.deepEqual(Object.keys(json), ['schemaVersion', 'selection', 'result', 'summary', 'exitCode', 'llm']);
  assert.deepEqual(json.llm, { status: 'skipped', provider: 'anthropic', model: 'example-model', reason: 'the provider could not be reached: ENETUNREACH (2 attempts)' });
  assert.deepEqual(read(record).trim().split('\n'), ['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/messages']);
  // Without --json, the summary on stdout, then the annotation.
  const m = await runCli(['check', '--diff-file', diffFile('modify.diff'), '--root', root.dir], { cwd, env });
  assert.equal(m.status, 0);
  assert.equal(m.stderr, `${skipped}\n`);
  const summary = read(path.join(cwd, 'prcheck-summary.md'));
  assert.equal(m.stdout, `${summary}::warning title=qa-core-prcheck::${skipped}\n`);
  assert.ok(summary.includes(`\n- ${skipped}\n`));
  // Every Playwright child, --list and the run, had no key.
  assert.ok(root.calls().length >= 2);
  for (const call of root.calls()) assert.deepEqual(call.keys, []);
  for (const text of [j.stdout, j.stderr, m.stdout, m.stderr, summary]) assert.ok(!text.includes(FAKE_KEY));
});
