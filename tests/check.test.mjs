import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkErrorLine, formatCheckJson, runCheck } from '../dist/check/index.js';
import { readDiffFile } from '../dist/diff/index.js';
import { ImpactError } from '../dist/impact/index.js';
import { pickedFiles } from '../dist/llm/index.js';
import { formatSummary } from '../dist/report/index.js';
import { runSelection } from '../dist/run/index.js';
import { cleanup } from './helpers/git-repo.mjs';
import { FAKE_KEY, fakeFetch, fakeSleep, noFetch, reply, withText } from './fixtures/llm/fake-fetch.mjs';

/**
 * runCheck with the fake Playwright CLI in tests/fixtures/fake-playwright/cli.mjs for the test run.
 * The selection is real: the inventory is read from the demo suite with Playwright's --list, which
 * opens no browser. No real test runs here.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fakeCli = path.join(repoRoot, 'tests', 'fixtures', 'fake-playwright', 'cli.mjs');
const summaryDir = path.join(repoRoot, 'tests', 'fixtures', 'summary');
const LIVE = { timeout: 120_000 };
const VERSION = '0.0.0-test';
const lines = (...ls) => ls.map((l) => `${l}\n`).join('');
const goldenOf = (name) => fs.readFileSync(path.join(summaryDir, `${name}.md`), 'utf8');

function newDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
  t.after(() => cleanup(dir));
  return dir;
}

/** A copy of a recorded report with /repo/ and /project/ made into this checkout's root. */
function reportCopy(t, name) {
  const text = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'results', name), 'utf8');
  const file = path.join(newDir(t), name);
  const slashRoot = repoRoot.replaceAll('\\', '/');
  fs.writeFileSync(file, text.split('"/repo/').join(`"${slashRoot}/`).split('"/project/').join(`"${slashRoot}/`));
  return file;
}

const diffOf = (name) => readDiffFile(`tests/fixtures/diffs/${name}`, repoRoot);

/** Runs a check with the fake CLI and returns it with the fake's records, after checking the temp folder is gone. */
async function checkWithFake(t, diffName, fakeEnv = {}, options = {}) {
  const record = path.join(newDir(t), 'record.jsonl');
  const checked = await runCheck({
    root: repoRoot,
    diff: await diffOf(diffName),
    env: { FAKE_PW_RECORD: record, ...fakeEnv },
    playwrightCli: fakeCli,
    version: VERSION,
    ...options,
  });
  const records = fs.existsSync(record)
    ? fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
  for (const { env } of records) {
    const tempFolder = path.dirname(env.PLAYWRIGHT_JSON_OUTPUT_FILE);
    assert.ok(path.basename(tempFolder).startsWith('prcheck-run-'), tempFolder);
    assert.equal(fs.existsSync(tempFolder), false, `temp folder left behind: ${tempFolder}`);
  }
  return { ...checked, records };
}

test('modify.diff with the demo cart report: Passed, exit 0, and the passed golden', LIVE, async (t) => {
  const { selection, result, summary, records } = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'demo-cart.json') });
  assert.equal(records.length, 1);
  assert.equal(selection.mode, 'subset');
  assert.deepEqual([result.verdict, result.exitCode], ['passed', 0]);
  assert.equal(summary.verdict, 'passed');
  assert.equal(summary.markdown, goldenOf('passed'));
});

test('the synthetic report with a failed test and Playwright exit 1: Failed, exit 1', LIVE, async (t) => {
  const { result, summary } = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'synthetic-mixed.json'), FAKE_PW_EXIT: '1' });
  assert.deepEqual([result.verdict, result.exitCode], ['failed', 1]);
  assert.equal(summary.verdict, 'failed');
  assert.equal(summary.markdown.split('\n')[1], '## PR Check: Failed');
});

test('delete.diff: No Tests Needed, exit 0, and the fake never starts', LIVE, async (t) => {
  const { result, summary, records } = await checkWithFake(t, 'delete.diff', { FAKE_PW_EXIT: '1' });
  assert.deepEqual(records, []);
  assert.deepEqual([result.verdict, result.exitCode], ['nothing-to-run', 0]);
  assert.equal(summary.markdown, goldenOf('no-tests-needed'));
});

test('dryRun: Not Run, exit 0, and the fake never starts', LIVE, async (t) => {
  const { result, summary, records } = await checkWithFake(t, 'modify.diff', { FAKE_PW_EXIT: '1' }, { dryRun: true });
  assert.deepEqual(records, []);
  assert.deepEqual([result.verdict, result.exitCode], ['not-run', 0]);
  assert.equal(summary.markdown, goldenOf('not-run'));
});

test('the top-level error report: Error, exit 2, and the error golden', LIVE, async (t) => {
  const { result, summary, records } = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'top-level-error.json'), FAKE_PW_EXIT: '1' });
  assert.equal(records.length, 1);
  assert.deepEqual([result.verdict, result.exitCode], ['error', 2]);
  assert.equal(summary.markdown, goldenOf('error'));
});

/**
 * A made-up @playwright/test in a temp root. Its cli.js appends its arguments to FAKE_RECORD, prints a
 * one-test list for --list and writes a passing report for a test run. selectTests is the only caller
 * of --list, so one --list line per check proves the check picked the specs exactly once.
 */
function recordingProject(t) {
  const dir = newDir(t);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write('node_modules/@playwright/test/package.json', JSON.stringify({ name: '@playwright/test', version: '0.0.0', exports: { './cli': './cli.js' } }));
  write('node_modules/@playwright/test/cli.js', lines(
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.appendFileSync(process.env.FAKE_RECORD, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "if (process.env.FAKE_KEYS_RECORD) fs.appendFileSync(process.env.FAKE_KEYS_RECORD, JSON.stringify(['PRCHECK_LLM_API_KEY'].filter((k) => k in process.env)) + '\\n');",
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
  return dir;
}

test('one check runs Playwright --list once (selectTests) and the test run once', LIVE, async (t) => {
  const root = recordingProject(t);
  const record = path.join(newDir(t), 'calls.jsonl');
  const { result, summary } = await runCheck({ root, diff: await diffOf('modify.diff'), env: { FAKE_RECORD: record }, version: VERSION });
  const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.equal(calls.filter((argv) => argv.includes('--list')).length, 1);
  assert.deepEqual(calls[1].slice(0, 1), ['test']);
  assert.ok(!calls[1].includes('--list'));
  assert.deepEqual([result.verdict, result.exitCode, result.counts.total], ['passed', 0, 1]);
  assert.equal(summary.verdict, 'passed');
});

test('an error before the run is thrown, and checkErrorLine shows the absolute root as <root>', async (t) => {
  const root = path.join(newDir(t), 'missing');
  const diff = await diffOf('delete.diff');
  await assert.rejects(runCheck({ root, diff, version: VERSION }), (error) => {
    assert.ok(error instanceof ImpactError, `expected ImpactError, got ${error}`);
    assert.equal(error.message, `Root folder not found: ${root}`);
    assert.equal(checkErrorLine(error.message, root), 'Root folder not found: <root>');
    return true;
  });
});

test('checkErrorLine keeps the first line, removes color codes and makes paths in the root relative', () => {
  const root = '/work/shop';
  assert.equal(checkErrorLine('\u001b[31mError: /work/shop/demo/a.spec.ts failed\u001b[39m\nsecond line', root), 'Error: demo/a.spec.ts failed');
  assert.equal(checkErrorLine('Error: C:\\work\\shop\\demo\\a.spec.ts failed', 'C:\\work\\shop'), 'Error: demo/a.spec.ts failed');
  assert.equal(checkErrorLine('Unknown ref: nope. Fetch it first, for example git fetch origin <branch>', root), 'Unknown ref: nope. Fetch it first, for example git fetch origin <branch>');
});

test('formatCheckJson: keys in the documented order, file null and stepSummary false without files', () => {
  const { selection, result } = JSON.parse(fs.readFileSync(path.join(summaryDir, 'inputs', 'not-run.json'), 'utf8'));
  const summary = { markdown: goldenOf('not-run'), verdict: 'not-run', fullSuite: false, truncated: false, omitted: 0 };
  const text = formatCheckJson(selection, result, summary, null, 0);
  assert.ok(text.endsWith('}\n'));
  const json = JSON.parse(text);
  assert.deepEqual(Object.keys(json), ['schemaVersion', 'selection', 'result', 'summary', 'exitCode']);
  assert.deepEqual(json.summary, {
    verdict: 'not-run', fullSuite: false, truncated: false, omitted: 0,
    bytes: Buffer.byteLength(goldenOf('not-run')), file: null, stepSummary: false,
  });
  assert.deepEqual([json.schemaVersion, json.selection, json.result, json.exitCode], [1, selection, result, 0]);
  const written = JSON.parse(formatCheckJson(selection, result, summary, { summaryFile: 'prcheck-summary.md', stepSummary: true, artifacts: [] }, 2));
  assert.deepEqual([written.summary.file, written.summary.stepSummary, written.exitCode], ['prcheck-summary.md', true, 2]);
});

test('mixed.diff with a suggestion: the result, verdict, heading, lead and footer equal those of the same selection without it', LIVE, async (t) => {
  const report = reportCopy(t, 'demo-cart.json');
  const { selection, result, summary } = await checkWithFake(t, 'mixed.diff', { FAKE_PW_REPORT: report });
  assert.deepEqual(selection.suggestions.map((s) => [s.file, s.kind]), [['src/cli.ts', 'unmapped-file']]);

  const bare = { ...selection, suggestions: [] };
  const bareResult = await runSelection({
    root: repoRoot, selection: bare, env: { FAKE_PW_RECORD: path.join(newDir(t), 'record.jsonl'), FAKE_PW_REPORT: report }, playwrightCli: fakeCli,
  });
  assert.deepEqual(bareResult, result);
  const bareSummary = formatSummary({ selection: bare, result: bareResult, error: null, version: VERSION });
  assert.deepEqual([summary.verdict, summary.fullSuite, result.exitCode], [bareSummary.verdict, bareSummary.fullSuite, bareResult.exitCode]);
  // The only difference is the Suggested Tests section before the footer, written by hand.
  assert.equal(summary.markdown, bareSummary.markdown.replace('\n---\n', lines(
    '',
    '### Suggested Tests',
    '| File | Why | Suggested Test |',
    '| --- | --- | --- |',
    '| `src/cli.ts` | No rule or spec maps this file, so it falls back to the full suite. | Add a spec that covers the behaviour in src/cli.ts, or map it to a tag with an area in qa-core-prcheck.config.json. |',
    '',
    '---',
  )));
});

test('add.diff with a suggestion: No Tests Needed, exit 0, the fake never starts, and the summary is no-tests-needed.md plus the section', LIVE, async (t) => {
  const { selection, result, summary, records } = await checkWithFake(t, 'add.diff', { FAKE_PW_EXIT: '1' });
  assert.deepEqual(records, []);
  assert.deepEqual([result.verdict, result.exitCode, summary.verdict], ['nothing-to-run', 0, 'no-tests-needed']);
  const bare = formatSummary({ selection: { ...selection, suggestions: [] }, result, error: null, version: VERSION });
  assert.equal(bare.markdown, goldenOf('no-tests-needed'));
  const wishlist = 'demo/saucedemo/pages/wishlist-page.ts';
  assert.equal(summary.markdown, goldenOf('no-tests-needed').replace('\n---\n', lines(
    '',
    '### Suggested Tests',
    '| File | Why | Suggested Test |',
    '| --- | --- | --- |',
    `| \`${wishlist}\` | No spec imports this file. | Add a spec that imports ${wishlist} and uses it, or remove the file if nothing needs it. |`,
    '',
    '---',
  )));
});

// The optional LLM ranking (PR 8). The fetch is always the fake from tests/fixtures/llm/fake-fetch.mjs,
// passed through the test-only fetch option; the key is the fake key. No request leaves the process.

const ANTHROPIC = { provider: 'anthropic', model: 'example-model' };
const KEYED = { PRCHECK_LLM_API_KEY: FAKE_KEY };

/** An Anthropic reply that lists the picked specs in reverse with a note on the first, and every suggestion. */
function answerFor(selection) {
  const specs = pickedFiles(selection).reverse().map((file, i) => ({ file, note: i === 0 ? 'Checked first.' : '' }));
  const suggestions = selection.suggestions.slice(0, 10).map((_, index) => ({ index, note: '' }));
  return reply(200, withText('anthropic.json', JSON.stringify({ specs, suggestions })));
}

test('check: an applied ranking keeps the selection, the runner argv, the result and the exit code', LIVE, async (t) => {
  const report = reportCopy(t, 'demo-cart.json');
  const plain = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: report });
  assert.ok(pickedFiles(plain.selection).length > 1);
  const { fetch, calls } = fakeFetch(answerFor(plain.selection));
  const ranked = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: report, ...KEYED }, { llmConfig: ANTHROPIC, fetch });
  assert.equal(calls.length, 1);
  assert.deepEqual(ranked.selection, plain.selection);
  assert.deepEqual(ranked.records.map((r) => r.argv), plain.records.map((r) => r.argv));
  assert.deepEqual(ranked.result, plain.result);
  assert.deepEqual([ranked.result.verdict, ranked.result.exitCode], ['passed', 0]);
  assert.equal(ranked.llm.status, 'applied');
  assert.equal(ranked.llmOff, null);
  assert.equal(plain.llm, null);
  assert.equal(ranked.summary.markdown, formatSummary({ selection: plain.selection, result: plain.result, error: null, version: VERSION, ranking: ranked.llm }).markdown);
  assert.ok(ranked.summary.markdown.includes('\nRanked by LLM (advisory): anthropic, example-model.'));
  assert.ok(!ranked.summary.markdown.includes(FAKE_KEY));
  assert.equal(plain.summary.markdown, goldenOf('passed'));
});

test('check: the Playwright child env has no PRCHECK_LLM_API_KEY', LIVE, async (t) => {
  const report = reportCopy(t, 'demo-cart.json');
  const config = ANTHROPIC;
  const plain = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: report });
  const { fetch, calls } = fakeFetch(answerFor(plain.selection));
  const { records, llm } = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: report, ...KEYED }, { llmConfig: config, fetch });
  assert.equal(llm.status, 'applied');
  assert.equal(calls[0].headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(records.length, 1);
  assert.equal('PRCHECK_LLM_API_KEY' in records[0].env, false);

  // The --list child of the selection as well, in the made-up project.
  const root = recordingProject(t);
  const keys = path.join(newDir(t), 'keys.jsonl');
  const second = fakeFetch(reply(200, withText('anthropic.json', JSON.stringify({ specs: [{ file: 'demo/saucedemo/tests/cart/cart.spec.ts', note: '' }], suggestions: [] }))));
  const checked = await runCheck({
    root, diff: await diffOf('modify.diff'), version: VERSION, llmConfig: config, fetch: second.fetch,
    env: { FAKE_RECORD: path.join(newDir(t), 'calls.jsonl'), FAKE_KEYS_RECORD: keys, ...KEYED },
  });
  assert.equal(checked.result.verdict, 'passed');
  const seen = fs.readFileSync(keys, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(seen, [[], []]);
});

test('check: skipped keeps exit code 1 for a failing run', LIVE, async (t) => {
  const { fetch, calls } = fakeFetch(reply(400, { error: { type: 'invalid_request_error' } }));
  const { result, llm, summary } = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'synthetic-mixed.json'), FAKE_PW_EXIT: '1', ...KEYED }, { llmConfig: ANTHROPIC, fetch });
  assert.equal(calls.length, 1);
  assert.deepEqual([result.verdict, result.exitCode], ['failed', 1]);
  assert.deepEqual(llm, { status: 'skipped', provider: 'anthropic', model: 'example-model', reason: 'the provider returned status 400 (invalid_request_error)' });
  assert.ok(summary.markdown.includes('\n- LLM ranking skipped: the provider returned status 400 (invalid\\_request\\_error). The deterministic order is used.\n'));
  assert.equal(summary.markdown.split('\n')[1], '## PR Check: Failed');
});

test('check: an applied ranking keeps exit code 1 for a failing run', LIVE, async (t) => {
  const report = reportCopy(t, 'synthetic-mixed.json');
  const plain = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: report, FAKE_PW_EXIT: '1' });
  const { fetch } = fakeFetch(answerFor(plain.selection));
  const { result, llm } = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: report, FAKE_PW_EXIT: '1', ...KEYED }, { llmConfig: ANTHROPIC, fetch, sleep: fakeSleep().sleep });
  assert.deepEqual([result.verdict, result.exitCode, llm.status], ['failed', 1, 'applied']);
  assert.deepEqual(result, plain.result);
});

test('check: the error verdict makes no call and the summary is byte-identical to the error golden', LIVE, async (t) => {
  const { fetch, calls } = noFetch();
  const { result, summary, llm, llmOff } = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'top-level-error.json'), FAKE_PW_EXIT: '1', ...KEYED }, { llmConfig: ANTHROPIC, fetch });
  assert.deepEqual([result.verdict, result.exitCode, llm, llmOff, calls], ['error', 2, null, null, []]);
  assert.equal(summary.markdown, goldenOf('error'));
});

test('check: a dry run makes no call, even with the key set', LIVE, async (t) => {
  const { fetch, calls } = noFetch();
  const { result, summary, llm, records } = await checkWithFake(t, 'modify.diff', { FAKE_PW_EXIT: '1', ...KEYED }, { dryRun: true, llmConfig: ANTHROPIC, fetch });
  assert.deepEqual([result.verdict, llm, calls, records], ['not-run', null, [], []]);
  assert.equal(summary.markdown, goldenOf('not-run'));
});

test('check: a provider with the key unset makes no call and gives the off line', LIVE, async (t) => {
  const { fetch, calls } = noFetch();
  const { summary, llm, llmOff } = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'demo-cart.json'), PRCHECK_LLM_API_KEY: '' }, { llmConfig: ANTHROPIC, fetch });
  assert.deepEqual([llm, calls], [null, []]);
  assert.equal(llmOff, 'LLM ranking is off: the env var PRCHECK_LLM_API_KEY is not set or is empty.');
  assert.equal(summary.markdown, goldenOf('passed'));
});

test('check: a dry run with a provider set and the key unset gives no off line (PR 8 review)', LIVE, async (t) => {
  const { fetch, calls } = noFetch();
  const { result, llm, llmOff } = await checkWithFake(t, 'modify.diff', { PRCHECK_LLM_API_KEY: '' }, { dryRun: true, llmConfig: ANTHROPIC, fetch });
  assert.deepEqual([result.verdict, llm, llmOff, calls], ['not-run', null, null, []]);
});

test('check: provider none makes no call and no off line', LIVE, async (t) => {
  const { fetch, calls } = noFetch();
  const { summary, llm, llmOff } = await checkWithFake(t, 'modify.diff', { FAKE_PW_REPORT: reportCopy(t, 'demo-cart.json'), ...KEYED },
    { llmConfig: { provider: 'none', model: null }, fetch });
  assert.deepEqual([llm, llmOff, calls], [null, null, []]);
  assert.equal(summary.markdown, goldenOf('passed'));
});

test('formatCheckJson: llm comes last, after exitCode, and only when a ranking was attempted', () => {
  const { selection, result } = JSON.parse(fs.readFileSync(path.join(summaryDir, 'inputs', 'not-run.json'), 'utf8'));
  const summary = { markdown: goldenOf('not-run'), verdict: 'not-run', fullSuite: false, truncated: false, omitted: 0 };
  assert.equal(formatCheckJson(selection, result, summary, null, 0, null), formatCheckJson(selection, result, summary, null, 0));
  const applied = JSON.parse(formatCheckJson(selection, result, summary, null, 0,
    { status: 'applied', provider: 'gemini', model: 'example-model', specs: [], suggestions: [] }));
  assert.deepEqual(Object.keys(applied), ['schemaVersion', 'selection', 'result', 'summary', 'exitCode', 'llm']);
  assert.deepEqual(applied.llm, { status: 'applied', provider: 'gemini', model: 'example-model', reason: null });
  const skipped = JSON.parse(formatCheckJson(selection, result, summary, null, 1,
    { status: 'skipped', provider: 'openai', model: 'example-model', reason: 'the answer is not JSON' }));
  assert.deepEqual(skipped.llm, { status: 'skipped', provider: 'openai', model: 'example-model', reason: 'the answer is not JSON' });
});
