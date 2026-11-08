import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanup } from './helpers/git-repo.mjs';

/**
 * action.yml and .github/workflows/prcheck.yml, read as text (no YAML dependency). The run scripts of
 * the action are also taken out of action.yml and run with bash, the way GitHub runs shell: bash
 * (bash --noprofile --norc -eo pipefail, from the workflow syntax docs), against a fake CLI. No network.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ACTION = fs.readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'prcheck.yml'), 'utf8');
const indentOf = (line) => line.length - line.trimStart().length;

/** The keys and values of the block under a top-level or nested key, one level deep. */
function blockLines(text, header) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === header);
  assert.ok(start >= 0, `no ${header}`);
  const base = indentOf(lines[start]);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= base) break;
    out.push(line);
  }
  return out;
}

/** The direct child keys of a block, in order. */
function childKeys(text, header) {
  const lines = blockLines(text, header);
  const depth = Math.min(...lines.map(indentOf));
  return lines.filter((line) => indentOf(line) === depth).map((line) => line.trim().replace(/:.*$/, ''));
}

/** Every run: script with the name of its step: { name, script } for block and one-line forms. */
function runScripts(text) {
  const lines = text.split('\n');
  const scripts = [];
  let name = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const named = line.match(/^\s*- name: (.*)$/);
    if (named) name = named[1];
    else if (/^\s*- /.test(line)) name = null;
    const run = line.match(/^(\s*)(?:- )?run: (.*)$/);
    if (!run) continue;
    if (run[2] !== '|') {
      scripts.push({ name, script: run[2] });
      continue;
    }
    const keyIndent = run[1].length + (line.trimStart().startsWith('- ') ? 2 : 0);
    const body = [];
    for (i++; i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > keyIndent); i++) body.push(lines[i]);
    i--;
    const cut = Math.min(...body.filter((l) => l.trim() !== '').map(indentOf));
    scripts.push({ name, script: `${body.map((l) => l.slice(cut)).join('\n').trimEnd()}\n` });
  }
  return scripts;
}

const scriptOf = (name) => {
  const found = runScripts(ACTION).filter((s) => s.name === name);
  assert.equal(found.length, 1, `one run script named ${name}`);
  return found[0].script;
};

test('prcheck.yml runs on pull_request opened, synchronize and reopened, and never on pull_request_target', () => {
  assert.deepEqual(childKeys(WORKFLOW, 'on:'), ['pull_request']);
  assert.ok(WORKFLOW.includes('\n  pull_request:\n    types: [opened, synchronize, reopened]\n'));
  assert.ok(!WORKFLOW.includes('pull_request_target'));
  assert.ok(!ACTION.includes('pull_request_target'));
});

test('prcheck.yml has exactly the two permissions', () => {
  assert.deepEqual(blockLines(WORKFLOW, 'permissions:').map((l) => l.trim()), ['contents: read', 'pull-requests: write']);
});

test('prcheck.yml checks out the full history without keeping credentials, and uses Node from .nvmrc', () => {
  assert.ok(WORKFLOW.includes('\n          fetch-depth: 0\n          persist-credentials: false\n'));
  assert.ok(WORKFLOW.includes('\n          node-version-file: .nvmrc\n          cache: npm\n'));
  assert.ok(WORKFLOW.includes('\n  group: prcheck-${{ github.event.pull_request.number }}\n  cancel-in-progress: true\n'));
});

test('every uses: is pinned to the approved tags', () => {
  const uses = (text) => [...text.matchAll(/^\s*(?:- )?uses: (\S+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(uses(WORKFLOW), ['actions/checkout@v7', 'actions/setup-node@v7', './', 'actions/upload-artifact@v7']);
  assert.deepEqual(uses(ACTION), []);
});

test('no run: script in either file holds ${{', () => {
  const scripts = [...runScripts(WORKFLOW), ...runScripts(ACTION)];
  assert.deepEqual(scripts.map((s) => s.script.trim().split('\n')[0]), [
    'npm ci', 'npm run build', 'npx playwright install --with-deps chromium',
    'if [ ! -f "$GITHUB_ACTION_PATH/dist/cli.js" ]; then', 'base="$BASE_REF"', 'base="$BASE_REF"', 'code=0',
    'if [ "$CHECK_EXIT" = "2" ] || [ "$RANK_EXIT" = "2" ] || [ "$COMMENT_EXIT" = "2" ]; then',
  ]);
  for (const { name, script } of scripts) assert.ok(!script.includes('${{'), `${name}: ${script}`);
});

test('the only expressions in prcheck.yml are the PR number in the concurrency group and the boolean comment guard', () => {
  assert.deepEqual([...WORKFLOW.matchAll(/\$\{\{.*?\}\}/g)].map((m) => m[0]), [
    '${{ github.event.pull_request.number }}',
    "${{ github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]' }}",
  ]);
  assert.ok(WORKFLOW.includes("\n          comment: ${{ github.event.pull_request.head.repo.full_name == github.repository && github.actor != 'dependabot[bot]' }}\n"));
  assert.ok(!WORKFLOW.includes('base-ref'), 'no branch name is passed in with:');
});

test('action.yml reads no event value, and its expressions are only inputs, step outputs, the token default and the workspace', () => {
  assert.ok(!ACTION.includes('github.event'));
  const allowed = /^\$\{\{ (inputs\.[a-z-]+|steps\.(check|comment|rank)\.outputs\.(exit-code|verdict|base-ref|llm-status)|github\.token|github\.workspace) \}\}$/;
  for (const [expression] of ACTION.matchAll(/\$\{\{.*?\}\}/g)) assert.match(expression, allowed);
});

test('action.yml is a composite action with every input and output, and shell: bash on every run step', () => {
  assert.ok(ACTION.includes('\nruns:\n  using: composite\n'));
  assert.deepEqual(childKeys(ACTION, 'inputs:'), ['base-ref', 'root', 'summary-file', 'timeout-minutes', 'comment', 'github-token', 'comment-author', 'fail-on-test-failure', 'llm', 'llm-api-key']);
  assert.deepEqual(childKeys(ACTION, 'outputs:'), ['exit-code', 'verdict', 'llm-status']);
  assert.ok(ACTION.includes("\n  comment:\n    description: true to post or update the sticky PR comment. The comment command skips fork pull requests itself.\n    required: false\n    default: 'true'\n"));
  assert.ok(ACTION.includes("\n  fail-on-test-failure:\n    description: true to fail when a picked test fails. Off by default, because v1 is advisory.\n    required: false\n    default: 'false'\n"));
  assert.equal([...ACTION.matchAll(/^\s+run: \|$/gm)].length, 5);
  assert.equal([...ACTION.matchAll(/^\s+shell: bash$/gm)].length, 5);
  assert.ok(ACTION.includes("\n  llm:\n    description: true to allow one optional LLM ranking call after Playwright exits. Off by default. Also set llm-api-key. The pull request config chooses the provider only when this is true.\n    required: false\n    default: 'false'\n"));
  assert.ok(ACTION.includes('\n      if: steps.check.outputs.base-ref != \'\'\n'));
});

test('action.yml declares comment-author with default github-actions[bot] and describes the token rule', () => {
  assert.ok(ACTION.includes("\n  comment-author:\n    description: The login whose comment is updated in place. Set it when github-token is an App token or a personal access token.\n    required: false\n    default: 'github-actions[bot]'\n"));
  assert.ok(ACTION.includes('\n  github-token:\n    description: The token for the comment. Needs pull-requests write. With a token other than the default, also set comment-author. A token that cannot write comments gets a warning and the job summary only.\n'));
});

test('comment-author reaches only the comment step, only through env: as PRCHECK_COMMENT_AUTHOR', () => {
  const uses = [...ACTION.matchAll(/^.*inputs\.comment-author.*$/gm)].map((m) => m[0]);
  assert.deepEqual(uses, ['        PRCHECK_COMMENT_AUTHOR: ${{ inputs.comment-author }}']);
  assert.ok(ACTION.includes('\n      env:\n        GITHUB_TOKEN: ${{ inputs.github-token }}\n        PRCHECK_COMMENT_AUTHOR: ${{ inputs.comment-author }}\n        SUMMARY_FILE: ${{ inputs.summary-file }}\n      run: |\n        code=0\n'));
  for (const { script } of runScripts(ACTION)) assert.ok(!script.includes('PRCHECK_COMMENT_AUTHOR') && !script.includes('comment-author'), script);
});

test('both files are ASCII with no em or en dash', () => {
  for (const text of [ACTION, WORKFLOW]) assert.ok(/^[\t\n\x20-\x7e]*$/.test(text));
});

// The action scripts, run for real with bash and a fake CLI.

function newDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
  t.after(() => cleanup(dir));
  return dir;
}

/**
 * A fake action folder whose dist/cli.js records its arguments and whether GITHUB_TOKEN reached it,
 * then for check writes the summary, prints JSON with FAKE_VERDICT and exits FAKE_EXIT; for comment
 * exits FAKE_COMMENT_EXIT.
 */
function fakeAction(t) {
  const dir = newDir(t);
  fs.mkdirSync(path.join(dir, 'action', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(path.join(dir, 'action', 'dist', 'cli.js'), [
    "const fs = require('node:fs');",
    "const record = {",
    "  argv: process.argv.slice(2),",
    "  token: process.env.GITHUB_TOKEN === 'ghs_fake_token_for_tests',",
    "  llmKey: Object.prototype.hasOwnProperty.call(process.env, 'PRCHECK_LLM_API_KEY') ? process.env.PRCHECK_LLM_API_KEY : null,",
    "  stepSummary: Object.prototype.hasOwnProperty.call(process.env, 'GITHUB_STEP_SUMMARY') ? process.env.GITHUB_STEP_SUMMARY : null,",
    '};',
    "fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify(record) + '\\n');",
    "if (process.argv[2] === 'check') {",
    "  const file = process.argv[process.argv.indexOf('--summary-file') + 1];",
    "  fs.writeFileSync(file, '<!-- qa-core-prcheck:summary -->\\n## PR Check: From The Fake\\n');",
    "  if (process.env.FAKE_VERDICT) process.stdout.write(JSON.stringify({ summary: { verdict: process.env.FAKE_VERDICT } }));",
    "  process.exitCode = Number(process.env.FAKE_EXIT ?? '0');",
    "} else if (process.argv[2] === 'rank') {",
    "  const status = process.env.FAKE_LLM_STATUS || '';",
    "  const reason = process.env.FAKE_LLM_REASON || '';",
    "  process.stdout.write(JSON.stringify({ llm: status ? { status, reason } : null }));",
    "  process.exitCode = Number(process.env.FAKE_RANK_EXIT ?? '0');",
    '} else {',
    "  process.exitCode = Number(process.env.FAKE_COMMENT_EXIT ?? '0');",
    '}',
  ].join('\n'));
  return {
    actionPath: path.join(dir, 'action'),
    work: path.join(dir, 'work'),
    output: path.join(dir, 'output.txt'),
    record: path.join(dir, 'record.jsonl'),
    temp: dir,
  };
}

/** Runs one action script as GitHub would, with an explicit env: nothing from the host but PATH. */
function runStep(fake, name, env) {
  fs.writeFileSync(fake.output, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', scriptOf(name)], {
    cwd: fake.work,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, GITHUB_ACTION_PATH: fake.actionPath, GITHUB_OUTPUT: fake.output,
      RUNNER_TEMP: fake.temp, FAKE_RECORD: fake.record, ...env,
    },
  });
  const records = fs.existsSync(fake.record) ? fs.readFileSync(fake.record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  fs.rmSync(fake.record, { force: true });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: fs.readFileSync(fake.output, 'utf8'), records };
}

const CHECK_ENV = { BASE_REF: '', ROOT: '.', SUMMARY_FILE: 'prcheck-summary.md', GITHUB_BASE_REF: 'main', TIMEOUT_MINUTES: '30' };
const CHECK_ARGS = (base) => ['check', '--base', base, '--root', '.', '--summary-file', 'prcheck-summary.md', '--timeout-minutes', '30', '--skip-llm', '--json'];
const CHECK_RECORD = (base) => ({ argv: CHECK_ARGS(base), token: false, llmKey: null, stepSummary: '' });

for (const [code, verdict] of [['0', 'passed'], ['1', 'failed'], ['2', 'error']]) {
  test(`check step: check exit ${code} is recorded with verdict ${verdict}, the summary is printed, and the step passes`, (t) => {
    const fake = fakeAction(t);
    const r = runStep(fake, 'Run check', { ...CHECK_ENV, FAKE_EXIT: code, FAKE_VERDICT: verdict });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, `base-ref=origin/main\nexit-code=${code}\nverdict=${verdict}\n`);
    assert.equal(r.stdout, '<!-- qa-core-prcheck:summary -->\n## PR Check: From The Fake\n');
    assert.deepEqual(r.records, [CHECK_RECORD('origin/main')]);
  });
}

test('check step: no JSON (an error before the run) gives verdict error', (t) => {
  const fake = fakeAction(t);
  const r = runStep(fake, 'Run check', { ...CHECK_ENV, FAKE_EXIT: '2' });
  assert.equal(r.status, 0);
  assert.equal(r.output, 'base-ref=origin/main\nexit-code=2\nverdict=error\n');
});

test('check step: a base branch name with shell characters stays one quoted argument', (t) => {
  const fake = fakeAction(t);
  const branch = 'main"; echo injected; "$(echo also-injected)';
  const r = runStep(fake, 'Run check', { ...CHECK_ENV, GITHUB_BASE_REF: branch, FAKE_VERDICT: 'passed' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.records, [CHECK_RECORD(`origin/${branch}`)]);
  assert.ok(!r.stdout.includes('injected') && !r.stderr.includes('injected'));
});

test('check step: a base-ref input wins over GITHUB_BASE_REF', (t) => {
  const fake = fakeAction(t);
  const r = runStep(fake, 'Run check', { ...CHECK_ENV, BASE_REF: 'origin/release', FAKE_VERDICT: 'passed' });
  assert.deepEqual(r.records, [CHECK_RECORD('origin/release')]);
});

test('check step: no base ref at all records exit 2 and an error annotation without running check', (t) => {
  const fake = fakeAction(t);
  const r = runStep(fake, 'Run check', { ...CHECK_ENV, GITHUB_BASE_REF: '' });
  assert.equal(r.status, 0);
  assert.equal(r.output, 'exit-code=2\nverdict=error\n');
  assert.equal(r.stdout, '::error title=qa-core-prcheck::No base ref: base-ref is empty and GITHUB_BASE_REF is not set.\n');
  assert.deepEqual(r.records, []);
});

for (const code of ['0', '2']) {
  test(`comment step: comment exit ${code} is recorded, the token reaches it, and the step passes`, (t) => {
    const fake = fakeAction(t);
    const r = runStep(fake, 'Post or update the PR comment', {
      GITHUB_TOKEN: 'ghs_fake_token_for_tests', SUMMARY_FILE: 'prcheck-summary.md', FAKE_COMMENT_EXIT: code,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.output, `exit-code=${code}\n`);
    assert.deepEqual(r.records, [{ argv: ['comment', '--summary-file', 'prcheck-summary.md'], token: true, llmKey: null, stepSummary: null }]);
    assert.ok(!r.stdout.includes('ghs_fake_token_for_tests'));
  });
}

const TOOL_ERROR = (check, rank, comment) =>
  `::error title=qa-core-prcheck::A tool error stopped the check, the rank step or the comment (check exit ${check}, rank exit ${rank}, comment exit ${comment}). See the log above.\n`;
const WARNING = '::warning title=qa-core-prcheck::A picked test failed. The check is advisory, so this step passes.\n';

// CHECK_EXIT, RANK_EXIT ('' when rank was skipped), COMMENT_EXIT ('' when comment was skipped),
// FAIL_ON_TEST_FAILURE, step status, annotation.
const MAPPING = [
  ['0', '', '0', 'false', 0, ''],
  ['0', '', '', 'false', 0, ''],
  ['1', '', '0', 'false', 0, WARNING],
  ['1', '', '', 'false', 0, WARNING],
  ['1', '', '0', 'true', 1, '::error title=qa-core-prcheck::A picked test failed.\n'],
  ['2', '', '0', 'false', 1, TOOL_ERROR('2', 'skipped', '0')],
  ['2', '', '', 'false', 1, TOOL_ERROR('2', 'skipped', 'skipped')],
  ['0', '', '2', 'false', 1, TOOL_ERROR('0', 'skipped', '2')],
  ['0', '2', '0', 'false', 1, TOOL_ERROR('0', '2', '0')],
  ['1', '2', '0', 'false', 1, TOOL_ERROR('1', '2', '0')],
  ['', '', '', 'false', 1, '::error title=qa-core-prcheck::check gave no known exit code (none).\n'],
];

for (const [check, rank, comment, failOn, status, annotation] of MAPPING) {
  test(`mapping: check ${check || 'none'}, rank ${rank || 'skipped'}, comment ${comment || 'skipped'}, fail-on-test-failure ${failOn}: step exits ${status}`, (t) => {
    const fake = fakeAction(t);
    const r = runStep(fake, 'Map the exit codes', { CHECK_EXIT: check, RANK_EXIT: rank, COMMENT_EXIT: comment, FAIL_ON_TEST_FAILURE: failOn });
    assert.equal(r.status, status);
    assert.equal(r.stdout, annotation);
  });
}

test('check step drops an inherited API key and does not append the job summary', (t) => {
  const fake = fakeAction(t);
  const r = runStep(fake, 'Run check', { ...CHECK_ENV, FAKE_VERDICT: 'passed', PRCHECK_LLM_API_KEY: 'prcheck_fake_llm_key_for_tests', GITHUB_STEP_SUMMARY: '/tmp/should-not-be-used' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.records, [CHECK_RECORD('origin/main')]);
  assert.ok(r.output.includes('base-ref=origin/main\n'));
  assert.ok(!r.stdout.includes('prcheck_fake_llm_key_for_tests'));
});

test('check step rejects a timeout outside 1 to 30 without running check', (t) => {
  const fake = fakeAction(t);
  const r = runStep(fake, 'Run check', { ...CHECK_ENV, TIMEOUT_MINUTES: '90', FAKE_VERDICT: 'passed' });
  assert.equal(r.status, 0);
  assert.equal(r.output, 'exit-code=2\nverdict=error\n');
  assert.equal(r.stdout, '::error title=qa-core-prcheck::timeout-minutes must be a whole number from 1 to 30.\n');
  assert.deepEqual(r.records, []);
});

test('rank step with llm not true drops the key and makes no warning', (t) => {
  const fake = fakeAction(t);
  const r = runStep(fake, 'Rank the summary', {
    BASE_REF: 'origin/main', ROOT: '.', SUMMARY_FILE: 'prcheck-summary.md', LLM_ENABLED: 'false',
    PRCHECK_LLM_API_KEY: 'prcheck_fake_llm_key_for_tests',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.records, [{ argv: ['rank', '--base', 'origin/main', '--root', '.', '--summary-file', 'prcheck-summary.md', '--json'], token: false, llmKey: null, stepSummary: null }]);
  assert.equal(r.output, 'exit-code=0\nllm-status=none\n');
  assert.ok(!r.stdout.includes('prcheck_fake_llm_key_for_tests'));
  assert.ok(!r.stdout.includes('::add-mask::'));
});

test('rank step with llm true masks a single-token key and warns on a skipped ranking', (t) => {
  const fake = fakeAction(t);
  const key = 'prcheck_fake_llm_key_for_tests';
  const r = runStep(fake, 'Rank the summary', {
    BASE_REF: 'origin/main', ROOT: '.', SUMMARY_FILE: 'prcheck-summary.md', LLM_ENABLED: 'true',
    PRCHECK_LLM_API_KEY: key, FAKE_LLM_STATUS: 'skipped', FAKE_LLM_REASON: 'the provider returned status 404',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.records[0].llmKey, key);
  assert.equal(r.records[0].argv[0], 'rank');
  assert.ok(r.stdout.includes(`::add-mask::${key}\n`));
  assert.equal(r.stdout.includes('::warning title=qa-core-prcheck::LLM ranking skipped: the provider returned status 404. The deterministic order is used.\n'), true);
  assert.equal(r.output, 'exit-code=0\nllm-status=skipped\n');
});

test('rank step refuses a key that contains a percent or a line break and does not mask it', (t) => {
  const fake = fakeAction(t);
  const r = runStep(fake, 'Rank the summary', {
    BASE_REF: 'origin/main', ROOT: '.', SUMMARY_FILE: 'prcheck-summary.md', LLM_ENABLED: 'true',
    PRCHECK_LLM_API_KEY: 'bad%key',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.records[0].llmKey, null);
  assert.ok(r.stdout.startsWith('::warning title=qa-core-prcheck::LLM ranking is off: the API key is not a single token, so it was not used.\n'));
  assert.ok(!r.stdout.includes('bad%key'));
});

test('ci.yml uses the same checkout and setup-node major as prcheck.yml', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.ok(ci.includes('actions/checkout@v7'));
  assert.ok(ci.includes('actions/setup-node@v7'));
  assert.ok(!ci.includes('sprintsynergyhq'));
});

test('prcheck.yml does not pass an LLM secret: the action runs from the pull request', () => {
  assert.ok(!WORKFLOW.includes('llm-api-key'));
  assert.ok(!WORKFLOW.includes('secrets.'));
  assert.ok(!WORKFLOW.includes('sprintsynergyhq'));
});
