import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanup } from './helpers/git-repo.mjs';

/**
 * The rank command. It reads files check already wrote and does not run Playwright. The cases that
 * would call a provider load tests/fixtures/llm/no-network.mjs, so no request leaves the process.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const noNetwork = path.join(repoRoot, 'tests', 'fixtures', 'llm', 'no-network.mjs');
const diffPath = path.join(repoRoot, 'tests', 'fixtures', 'diffs', 'modify.diff');
const passed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'summary', 'inputs', 'passed.json'), 'utf8'));
const FAKE_KEY = 'prcheck_fake_llm_key_for_tests';
const SUMMARY = '<!-- qa-core-prcheck:summary -->\n## PR Check: Passed\n\nstub\n';
const HELP_LINE = 'Run qa-core-prcheck rank --help for usage.\n';

const RANK_USAGE = `qa-core-prcheck rank --base <ref> [--head <ref>] [--root <dir>] [--summary-file <path>] [--json]
qa-core-prcheck rank --diff-file <path> [--root <dir>] [--summary-file <path>] [--json]

Applies optional LLM ranking to the summary that check already wrote. It does not run Playwright.

Options:
  --base <ref>           Compare against the merge base of this ref and the head
  --head <ref>           The head ref (default: HEAD)
  --diff-file <path>     Read a saved unified git diff instead of running git
  --root <dir>           The repository root (default: the current folder)
  --summary-file <path>  The summary written by check (default: prcheck-summary.md)
  --json                 Print JSON instead of the summary
  -h, --help             Print this help

Pass the same --base or --diff-file that check used. Reads "llm" from qa-core-prcheck.config.json.
The API key is read only from the env var PRCHECK_LLM_API_KEY. Off by default.
Appends the summary to $GITHUB_STEP_SUMMARY when it is set.
Exit codes: 0 ranked, skipped or off, 2 usage or tool error. This command never exits 1.
`;

function newDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
  t.after(() => cleanup(dir));
  return dir;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of ['GITHUB_STEP_SUMMARY', 'PRCHECK_LLM_API_KEY', 'GITHUB_ACTIONS', 'NODE_OPTIONS']) delete env[key];
  return { ...env, ...extra };
}

const runCli = (args, { cwd, env = cleanEnv() }) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cliJs, ...args], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

function writeCheckFiles(dir, sourcePath) {
  const selection = { ...passed.selection, source: { type: 'file', path: sourcePath } };
  fs.writeFileSync(path.join(dir, 'prcheck-selection.json'), `${JSON.stringify(selection, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'prcheck-results.json'), `${JSON.stringify(passed.result, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'prcheck-summary.md'), SUMMARY);
}

test('rank --help prints the rank help and exits 0', async () => {
  const r = await runCli(['rank', '--help'], { cwd: repoRoot });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, RANK_USAGE);
  assert.equal(r.stderr, '');
});

test('rank without a summary file exits 2 and does not need Playwright', async (t) => {
  const dir = newDir(t);
  const r = await runCli(['rank', '--diff-file', diffPath, '--root', dir, '--json'], { cwd: dir });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Cannot read prcheck-summary.md: ENOENT\n/);
});

test('rank with provider none leaves the summary unchanged and makes no call', async (t) => {
  const dir = newDir(t);
  writeCheckFiles(dir, diffPath);
  const record = path.join(dir, 'fetch.txt');
  const step = path.join(dir, 'step.md');
  const env = cleanEnv({ NODE_OPTIONS: `--import=${noNetwork}`, PRCHECK_TEST_FETCH_RECORD: record, GITHUB_STEP_SUMMARY: step });
  const r = await runCli(['rank', '--diff-file', diffPath, '--root', dir, '--json'], { cwd: dir, env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const json = JSON.parse(r.stdout);
  assert.deepEqual(json, { schemaVersion: 1, llm: null, summaryRewritten: false, stepSummary: true });
  assert.equal(fs.readFileSync(path.join(dir, 'prcheck-summary.md'), 'utf8'), SUMMARY);
  assert.equal(fs.readFileSync(step, 'utf8'), `${SUMMARY}\n`);
  assert.equal(fs.existsSync(record), false);
});

test('rank with a provider and no key reports off and does not rewrite the summary', async (t) => {
  const dir = newDir(t);
  writeCheckFiles(dir, diffPath);
  fs.writeFileSync(path.join(dir, 'qa-core-prcheck.config.json'), JSON.stringify({ llm: { provider: 'anthropic', model: 'example-model' } }));
  const r = await runCli(['rank', '--diff-file', diffPath, '--root', dir, '--json'], { cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, 'LLM ranking is off: the env var PRCHECK_LLM_API_KEY is not set or is empty.\n');
  const json = JSON.parse(r.stdout);
  assert.equal(json.llm.status, 'off');
  assert.equal(json.summaryRewritten, false);
  assert.equal(fs.readFileSync(path.join(dir, 'prcheck-summary.md'), 'utf8'), SUMMARY);
  assert.ok(!r.stdout.includes(FAKE_KEY));
});

test('rank refuses a diff that does not match the selection', async (t) => {
  const dir = newDir(t);
  writeCheckFiles(dir, 'other.diff');
  const r = await runCli(['rank', '--diff-file', diffPath, '--root', dir], { cwd: dir });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `The diff does not match prcheck-selection.json. Pass the same --base or --diff-file that check used.\n${HELP_LINE}`);
  assert.equal(fs.readFileSync(path.join(dir, 'prcheck-summary.md'), 'utf8'), SUMMARY);
});

test('rank with a key skips when the provider cannot be reached, and the key is not in the output', async (t) => {
  const dir = newDir(t);
  writeCheckFiles(dir, diffPath);
  fs.writeFileSync(path.join(dir, 'qa-core-prcheck.config.json'), JSON.stringify({ llm: { provider: 'openai', model: 'example-model' } }));
  const record = path.join(dir, 'fetch.txt');
  const env = cleanEnv({
    NODE_OPTIONS: `--import=${noNetwork}`, PRCHECK_TEST_FETCH_RECORD: record, PRCHECK_LLM_API_KEY: FAKE_KEY,
  });
  const r = await runCli(['rank', '--diff-file', diffPath, '--root', dir, '--json'], { cwd: dir, env });
  assert.equal(r.status, 0, r.stderr);
  const json = JSON.parse(r.stdout);
  assert.equal(json.llm.status, 'skipped');
  assert.equal(json.summaryRewritten, true);
  assert.ok(r.stderr.includes('LLM ranking skipped:'));
  assert.ok(!r.stdout.includes(FAKE_KEY) && !r.stderr.includes(FAKE_KEY));
  const summary = fs.readFileSync(path.join(dir, 'prcheck-summary.md'), 'utf8');
  assert.ok(summary.includes('LLM ranking skipped:'));
  assert.ok(!summary.includes(FAKE_KEY));
  assert.ok(fs.readFileSync(record, 'utf8').includes('https://api.openai.com/'));
});

test('rank of a summary with no selection JSON appends it and does not fail', async (t) => {
  const dir = newDir(t);
  fs.writeFileSync(path.join(dir, 'prcheck-summary.md'), SUMMARY);
  const step = path.join(dir, 'step.md');
  const r = await runCli(['rank', '--diff-file', diffPath, '--root', dir, '--json'], { cwd: dir, env: cleanEnv({ GITHUB_STEP_SUMMARY: step }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).llm, null);
  assert.equal(fs.readFileSync(step, 'utf8'), `${SUMMARY}\n`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['prcheck-summary.md', 'step.md']);
});

test('rank rejects a summary that is a workflow command, oversized, or not a real selection', async (t) => {
  const command = newDir(t);
  fs.writeFileSync(path.join(command, 'prcheck-summary.md'), '<!-- qa-core-prcheck:summary -->\n::error::injected\n');
  const injected = await runCli(['rank', '--diff-file', diffPath, '--root', command], { cwd: command });
  assert.equal(injected.status, 2);
  assert.match(injected.stderr, /workflow command line/);
  assert.equal(injected.stdout, '');

  const hugeDir = newDir(t);
  fs.writeFileSync(path.join(hugeDir, 'prcheck-summary.md'), `<!-- qa-core-prcheck:summary -->\n${'x'.repeat(70_000)}\n`);
  const huge = await runCli(['rank', '--diff-file', diffPath, '--root', hugeDir], { cwd: hugeDir });
  assert.equal(huge.status, 2);
  assert.match(huge.stderr, /larger than 60000 bytes/);

  const bad = newDir(t);
  fs.writeFileSync(path.join(bad, 'prcheck-summary.md'), SUMMARY);
  fs.writeFileSync(path.join(bad, 'prcheck-selection.json'), `${JSON.stringify({
    schemaVersion: 1, mode: 'subset', selected: [{}], source: { type: 'file', path: diffPath },
  })}\n`);
  fs.writeFileSync(path.join(bad, 'prcheck-results.json'), `${JSON.stringify(passed.result)}\n`);
  const rejected = await runCli(['rank', '--diff-file', diffPath, '--root', bad], { cwd: bad });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /not a selection written by check/);
  assert.equal(fs.readFileSync(path.join(bad, 'prcheck-summary.md'), 'utf8'), SUMMARY);
});

test('rank rejects --timeout-minutes and --dry-run', async (t) => {
  const dir = newDir(t);
  const timeout = await runCli(['rank', '--timeout-minutes', '5', '--diff-file', diffPath], { cwd: dir });
  assert.equal(timeout.status, 2);
  assert.match(timeout.stderr, /Unknown argument: --timeout-minutes/);
  const dry = await runCli(['rank', '--dry-run', '--diff-file', diffPath], { cwd: dir });
  assert.equal(dry.status, 2);
  assert.match(dry.stderr, /Unknown argument: --dry-run/);
});
