// Rule eval for the demo tree. Each case has a hand-written expected outcome from the select rules.
// The printed counts are how many cases matched. They are not a model quality score.
// No network and no browser: select uses playwright test --list, which does not download Chromium.
// Saved diffs are applied to the current demo checkout, not to the commits that produced the diffs.
// A rename in a saved diff therefore still sees the old file in the tree.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeText } from '../dist/report/markdown.js';
import { SUMMARY_MARKER } from '../dist/report/summary.js';
import { readPullRequestEvent } from '../dist/github/index.js';
import { WORKFLOW_COMMENT_EXPR, commentStepRuns, workflowCommentInput } from '../tests/helpers/comment-policy.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'dist', 'cli.js');
const diffs = path.join(root, 'tests', 'fixtures', 'diffs');

const results = [];

function run(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
}

function select(name) {
  const ran = run(['select', '--diff-file', path.join(diffs, name), '--json']);
  if (ran.status !== 0) throw new Error(`select ${name} exited ${ran.status}: ${ran.stderr}`);
  return JSON.parse(ran.stdout);
}

function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`pass  ${name}`);
  } catch (error) {
    results.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) });
    console.log(`fail  ${name}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function same(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label}\n      actual   ${left}\n      expected ${right}`);
}

check('positive: cart page change selects the cart and checkout specs', () => {
  const json = select('modify.diff');
  same(json.mode, 'subset', 'mode');
  same(json.selected.map((spec) => spec.file), [
    'demo/saucedemo/tests/cart/cart.spec.ts',
    'demo/saucedemo/tests/checkout/checkout.spec.ts',
  ], 'specs');
  same(json.suggestions, [], 'suggestions');
  if ('llm' in json) throw new Error('select JSON must not have an llm key');
});

check('negative: deleting a doc selects nothing and suggests nothing', () => {
  const json = select('delete.diff');
  same(json.mode, 'none', 'mode');
  same(json.selected, [], 'specs');
  same(json.suggestions, [], 'suggestions');
  same(json.decisions.map((row) => row.reason), ['Documentation only: docs/old-notes.md'], 'reasons');
});

check('negative: an empty diff selects nothing', () => {
  const json = select('empty.diff');
  same([json.mode, json.selected.length, json.decisions.length, json.suggestions.length], ['none', 0, 0, 0], 'counts');
});

check('negative: binary docs stay documentation and do not run the suite', () => {
  const json = select('binary.diff');
  same(json.mode, 'none', 'mode');
  same(json.decisions.every((row) => row.outcome === 'none' && row.reason.startsWith('Documentation only:')), true, 'docs');
});

check('boundary: a new page that no spec imports suggests a test and runs nothing', () => {
  const json = select('add.diff');
  same(json.mode, 'none', 'mode');
  same(json.suggestions.map((row) => [row.kind, row.file]), [
    ['unimported-support', 'demo/saucedemo/pages/wishlist-page.ts'],
  ], 'suggestions');
});

check('boundary: an unmapped source file runs the full suite and suggests that file only', () => {
  const json = select('mixed.diff');
  same(json.mode, 'full', 'mode');
  same(json.selected.map((spec) => spec.file), [
    'demo/saucedemo/tests/cart/cart.spec.ts',
    'demo/saucedemo/tests/checkout/checkout.spec.ts',
    'demo/saucedemo/tests/inventory/inventory.spec.ts',
    'demo/saucedemo/tests/login/login.spec.ts',
  ], 'specs');
  same(json.suggestions.map((row) => [row.kind, row.file]), [['unmapped-file', 'src/cli.ts']], 'suggestions');
  const triggers = json.fullSuiteReasons.filter((reason) => reason.startsWith('No rule maps src/cli.ts'));
  same(triggers, ['No rule maps src/cli.ts (app-source) to a test'], 'full suite reason');
});

check('boundary: a saved rename still sees the old page in this checkout', () => {
  // The diff renames cart-page.ts to basket-page.ts. The demo tree still has cart-page.ts, and the
  // cart and checkout specs still import it. The new path is not in the tree, so it is unimported.
  const json = select('rename.diff');
  same(json.mode, 'subset', 'mode');
  same(json.selected.map((spec) => spec.file), [
    'demo/saucedemo/tests/cart/cart.spec.ts',
    'demo/saucedemo/tests/checkout/checkout.spec.ts',
  ], 'specs');
  same(json.decisions.map((row) => [row.path, row.outcome]), [
    ['demo/saucedemo/pages/basket-page.ts', 'none'],
    ['demo/saucedemo/pages/cart-page.ts', 'specs'],
  ], 'decisions');
  same(json.suggestions.map((row) => row.file), ['demo/saucedemo/pages/basket-page.ts'], 'suggestion');
  if (json.decisions.some((row) => row.reason.startsWith('Spec deleted'))) throw new Error('a page rename is not a deleted spec');
});

check('boundary: paths with spaces that are docs do not select specs', () => {
  const json = select('spaces-in-path.diff');
  same(json.mode, 'none', 'mode');
  same(json.decisions.map((row) => row.path), [
    'docs/my folder/team notes.md',
    'docs/new name.md',
    'docs/old name.md',
    'docs/release notes.md',
  ], 'paths');
  same(json.decisions.every((row) => row.outcome === 'none'), true, 'outcomes');
});

check('boundary: a timeout outside 1 to 30 exits 2 before any test', () => {
  const ran = run(['check', '--timeout-minutes', '0', '--diff-file', path.join(diffs, 'empty.diff')]);
  if (ran.status !== 2) throw new Error(`exit ${ran.status}`);
  if (!ran.stderr.includes('--timeout-minutes must be a whole number of minutes from 1 to 30')) throw new Error(ran.stderr);
  if (ran.stdout !== '') throw new Error('stdout was not empty');
});

check('boundary: an oversized config exits 2 before Playwright', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prcheck-eval-'));
  try {
    fs.writeFileSync(path.join(dir, 'qa-core-prcheck.config.json'), `{${' '.repeat(70_000)}"playwrightDir":"."}`);
    const ran = run(['select', '--diff-file', path.join(diffs, 'empty.diff'), '--root', dir]);
    if (ran.status !== 2) throw new Error(`exit ${ran.status}: ${ran.stderr}`);
    if (!ran.stderr.includes('larger than 65536 bytes')) throw new Error(ran.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('fork guard: same-repo comments, a fork or a null head does not, Dependabot is workflow-only', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/prcheck.yml'), 'utf8');
  const action = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
  if (!workflow.includes(`comment: \${{ ${WORKFLOW_COMMENT_EXPR} }}`)) throw new Error('workflow comment expression changed');
  if (workflow.includes('pull_request_target')) throw new Error('pull_request_target is present');
  if (!action.includes("if: inputs.comment == 'true'")) throw new Error('comment step gate changed');
  const base = 'demo-owner/demo-shop';
  const rows = [
    ['same-repo', base, 'sardar-usman', 'true', false],
    ['fork', 'fork-owner/demo-shop', 'fork-owner', 'false', true],
    ['null head', null, 'fork-owner', 'false', true],
    ['dependabot', base, 'dependabot[bot]', 'false', false],
  ];
  for (const [name, head, actor, input, isFork] of rows) {
    const commentInput = workflowCommentInput({ headFullName: head, repository: base, actor });
    if (commentInput !== input) throw new Error(`${name} input ${commentInput}`);
    if (commentStepRuns(commentInput) !== (input === 'true')) throw new Error(`${name} step`);
    const event = {
      pull_request: {
        number: 7,
        head: { repo: head === null ? null : { full_name: head } },
        base: { repo: { full_name: base } },
      },
    };
    if (readPullRequestEvent(event, 'pull_request').isFork !== isFork) throw new Error(`${name} isFork`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prcheck-eval-fork-'));
  try {
    fs.writeFileSync(path.join(dir, 's.md'), `${SUMMARY_MARKER}\n## PR Check: Passed\n`);
    const eventPath = path.join(dir, 'event.json');
    const runComment = (head) => {
      fs.writeFileSync(eventPath, JSON.stringify({
        pull_request: {
          number: 7,
          head: { repo: head === null ? null : { full_name: head } },
          base: { repo: { full_name: base } },
        },
      }));
      return spawnSync(process.execPath, [cli, 'comment', '--summary-file', 's.md'], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GITHUB_TOKEN: 'ghs_eval_fork_guard',
          GITHUB_REPOSITORY: base,
          GITHUB_EVENT_NAME: 'pull_request',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_API_URL: 'http://127.0.0.1:1',
        },
      });
    };
    const fork = runComment('fork-owner/demo-shop');
    if (fork.status !== 0 || fork.stdout !== 'Skipped: fork pull request, job summary only\n') {
      throw new Error(`fork command ${fork.status} ${fork.stdout} ${fork.stderr}`);
    }
    const deleted = runComment(null);
    if (deleted.status !== 0 || deleted.stdout !== 'Skipped: fork pull request, job summary only\n') {
      throw new Error(`null head command ${deleted.status} ${deleted.stdout} ${deleted.stderr}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('comment contract: mentions, issue refs, and math are escaped, and a URL hash stays raw', () => {
  const text = 'mentions @sardar-usman in #1, GH-1 and sprintsynergyio/qa-core-prcheck#1 with $x$ and https://example.com/docs#1-intro';
  const escaped = escapeText(text);
  if (escaped.includes('@sardar-usman')) throw new Error('raw mention survived');
  if (!escaped.includes('&#64;&#8203;sardar-usman')) throw new Error('mention was not escaped');
  if (!escaped.includes('\\#&#8203;1')) throw new Error('issue ref was not escaped');
  if (!escaped.includes('<span>$</span>')) throw new Error('dollar was not wrapped');
  if (!escaped.includes('https://example.com/docs#1-intro')) throw new Error('URL hash was rewritten');
  if (!SUMMARY_MARKER.startsWith('<!--') || !SUMMARY_MARKER.endsWith('-->')) throw new Error('marker is not an HTML comment');
});

const failed = results.filter((row) => !row.pass).length;
console.log(`cases ${results.length}`);
console.log(`passed ${results.length - failed}`);
console.log(`failed ${failed}`);
process.exitCode = failed === 0 ? 0 : 1;
