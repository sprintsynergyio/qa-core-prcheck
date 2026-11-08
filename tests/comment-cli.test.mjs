import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanup } from './helpers/git-repo.mjs';

/**
 * The comment command, run as a process against a fake GitHub API: a node:http server on 127.0.0.1
 * that this test starts and passes in through GITHUB_API_URL. No internet. The summary is the
 * no-tests-needed golden from PR 5, a real check summary. Every output is kept and scanned for the
 * token at the end. Retry cases answer with retry-after: 0, so they wait 0 ms; only the case with an
 * API that cannot be reached waits through the real backoff (2000 and 4000 ms), as there is no answer
 * to carry a header.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const SUMMARY = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'summary', 'no-tests-needed.md'), 'utf8');
const MARKER = '<!-- qa-core-prcheck:summary -->';
const TOKEN = 'ghs_fake_token_for_tests';
const LIST = '/repos/demo-owner/demo-shop/issues/7/comments';
const HELP_LINE = 'Run qa-core-prcheck comment --help for usage.\n';
const captured = [];

// Taken out of every child env unless a case sets them: the CI and reporter keys, and the GitHub
// variables the comment command reads, so a CI host's own values never reach a case.
const HOST_KEYS = [
  'CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL', 'BUILD_URL', 'PW_TEST_REPORTER',
  'PLAYWRIGHT_JSON_OUTPUT_NAME', 'PLAYWRIGHT_JSON_OUTPUT_FILE', 'PLAYWRIGHT_JSON_OUTPUT_DIR',
  'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_PATH', 'GITHUB_EVENT_NAME', 'GITHUB_API_URL', 'GITHUB_STEP_SUMMARY',
  'PRCHECK_COMMENT_AUTHOR', 'PRCHECK_LLM_API_KEY',
];
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of HOST_KEYS) delete env[key];
  return { ...env, ...extra };
}

const COMMENT_USAGE = `qa-core-prcheck comment --summary-file <path> [--dry-run]

Posts the summary as one sticky comment on the pull request, or updates the one posted before.

Options:
  --summary-file <path>  The summary written by check
  --dry-run              Show what would happen without posting or editing a comment
  -h, --help             Print this help

Reads GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_EVENT_PATH and GITHUB_API_URL.
Reads PRCHECK_COMMENT_AUTHOR: the login whose comment is updated (default github-actions[bot]).
Fork pull requests are skipped: they get the job summary only.
A token that cannot write comments (status 403) is skipped with a warning.
Exit codes: 0 posted, updated or skipped, 2 usage, GitHub or file error.
`;

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

const runCli = (args, { cwd, env }) => new Promise((resolve) => {
  // process.execPath, not 'node': the test must not depend on PATH.
  const child = spawn(process.execPath, [cliJs, ...args], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => {
    captured.push(stdout, stderr);
    resolve({ status, stdout, stderr });
  });
});

const emptyDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
after(() => cleanup(emptyDir));

function newDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
  t.after(() => cleanup(dir));
  return dir;
}

const commentUrl = (id) => `https://github.com/demo-owner/demo-shop/pull/7#issuecomment-${id}`;
const GITHUB_ACTIONS_BOT = { login: 'github-actions[bot]', type: 'Bot' };
const byUser = (id, body, user) => ({ id, body, html_url: commentUrl(id), user });
const bot = (id, body) => byUser(id, body, GITHUB_ACTIONS_BOT);

/**
 * The fake API: GET and POST on the comment list of pull request 7, PATCH on a comment, and GET /user,
 * which answers state.user or 404 without it. POST answers id 101 and adds the comment to the list;
 * POST and PATCH answer as written by state.writer. state.fail makes every request with that method
 * answer with its status and message. state.queue holds answers used first, one per request, for a
 * method: { GET: [{ status, message, headers }] }.
 */
async function startApi(t, comments = []) {
  const state = { comments, requests: [], fail: null, queue: {}, user: undefined, writer: GITHUB_ACTIONS_BOT };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    state.requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: raw === '' ? undefined : JSON.parse(raw) });
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(json));
    };
    if (state.fail !== null && state.fail.method === req.method) return send(state.fail.status, { message: state.fail.message });
    const queued = state.queue[req.method]?.shift();
    if (queued !== undefined) return send(queued.status, { message: queued.message }, queued.headers);
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && pathname === '/user' && state.user !== undefined) return send(200, state.user);
    if (req.method === 'GET' && pathname === LIST) return send(200, state.comments);
    if (req.method === 'POST' && pathname === LIST) {
      const created = byUser(101, JSON.parse(raw).body, state.writer);
      state.comments = [...state.comments, created];
      return send(201, created);
    }
    const patched = pathname.match(/^\/repos\/demo-owner\/demo-shop\/issues\/comments\/(\d+)$/);
    if (req.method === 'PATCH' && patched) return send(200, byUser(Number(patched[1]), JSON.parse(raw).body, state.writer));
    return send(404, { message: 'Not Found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { url: `http://127.0.0.1:${server.address().port}`, state };
}

/** A temp folder with the summary and a pull_request event for demo-owner/demo-shop number 7. */
function setup(t, { head = 'demo-owner/demo-shop', summary = SUMMARY } = {}) {
  const dir = newDir(t);
  fs.writeFileSync(path.join(dir, 's.md'), summary);
  const event = {
    action: 'synchronize',
    number: 7,
    pull_request: { number: 7, head: { repo: { full_name: head } }, base: { repo: { full_name: 'demo-owner/demo-shop' } } },
  };
  fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify(event));
  return dir;
}

const prEnv = (dir, apiUrl, extra = {}) => cleanEnv({
  GITHUB_TOKEN: TOKEN,
  GITHUB_REPOSITORY: 'demo-owner/demo-shop',
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
  GITHUB_API_URL: apiUrl,
  ...extra,
});

const GET_LIST = { method: 'GET', url: `${LIST}?per_page=100`, authorization: `Bearer ${TOKEN}`, body: undefined };

test('the top-level help lists the comment command', async () => {
  const r = await runCli(['--help'], { cwd: emptyDir, env: cleanEnv() });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, USAGE);
  assert.equal(r.stderr, '');
});

for (const flag of ['--help', '-h']) {
  test(`comment ${flag} prints the comment help and exits 0`, async () => {
    const r = await runCli(['comment', flag], { cwd: emptyDir, env: cleanEnv() });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, COMMENT_USAGE);
    assert.equal(r.stderr, '');
  });
}

const USAGE_ERRORS = [
  [['comment'], 'Missing required option: --summary-file <path>'],
  [['comment', '--dry-run'], 'Missing required option: --summary-file <path>'],
  [['comment', '--json', '--summary-file', 's.md'], 'Unknown argument: --json'],
  [['comment', '--base', 'main'], 'Unknown argument: --base'],
  [['comment', 's.md'], 'Unknown argument: s.md'],
  [['comment', '--summary-file=s.md'], 'Unknown argument: --summary-file=s.md'],
  [['comment', '--help', '--dry-run'], 'Unknown argument: --dry-run'],
  [['comment', '--summary-file'], 'Missing value for --summary-file'],
  [['comment', '--summary-file', '--dry-run'], 'Missing value for --summary-file'],
  [['comment', '--summary-file', 'a.md', '--summary-file', 'b.md'], 'Duplicate argument: --summary-file'],
  [['comment', '--dry-run', '--dry-run', '--summary-file', 's.md'], 'Duplicate argument: --dry-run'],
];

for (const [args, message] of USAGE_ERRORS) {
  test(`${args.join(' ')}: exits 2 with "${message}" and an empty stdout`, async () => {
    const r = await runCli(args, { cwd: emptyDir, env: cleanEnv({ GITHUB_TOKEN: TOKEN }) });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${message}\n${HELP_LINE}`);
  });
}

test('no sticky comment yet: one GET, one POST with the summary, "Comment created", exit 0', async (t) => {
  const api = await startApi(t);
  const dir = setup(t);
  const r = await runCli(['comment', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, api.url) });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `Comment created: ${commentUrl(101)}\n`);
  assert.deepEqual(api.state.requests, [GET_LIST, { method: 'POST', url: LIST, authorization: `Bearer ${TOKEN}`, body: { body: SUMMARY } }]);
});

test('a sticky comment exists: one PATCH to its id, "Comment updated", exit 0', async (t) => {
  const api = await startApi(t, [bot(55, `${MARKER}\n## PR Check: Failed\n`)]);
  const dir = setup(t);
  const r = await runCli(['comment', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, api.url) });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `Comment updated: ${commentUrl(55)}\n`);
  assert.deepEqual(api.state.requests, [
    GET_LIST,
    { method: 'PATCH', url: '/repos/demo-owner/demo-shop/issues/comments/55', authorization: `Bearer ${TOKEN}`, body: { body: SUMMARY } },
  ]);
});

test('two sticky comments: the oldest is updated and the duplicate is named', async (t) => {
  const api = await startApi(t, [bot(66, `${MARKER}\nold`), bot(55, `${MARKER}\nolder`)]);
  const dir = setup(t);
  const r = await runCli(['comment', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, api.url) });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `Comment updated: ${commentUrl(55)} (1 newer duplicate left as it is)\n`);
});

test('--dry-run reads the comments and says what it would do, with no POST or PATCH', async (t) => {
  const api = await startApi(t, [bot(55, `${MARKER}\nold`)]);
  const dir = setup(t);
  const r = await runCli(['comment', '--summary-file', 's.md', '--dry-run'], { cwd: dir, env: prEnv(dir, api.url) });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'Would update comment 55\n', '']);
  api.state.comments = [];
  const r2 = await runCli(['comment', '--dry-run', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, api.url) });
  assert.deepEqual([r2.status, r2.stdout, r2.stderr], [0, 'Would create a comment\n', '']);
  assert.deepEqual(api.state.requests, [GET_LIST, GET_LIST]);
});

test('a fork pull request is skipped with no API request, exit 0', async (t) => {
  const api = await startApi(t);
  const dir = setup(t, { head: 'fork-owner/demo-shop' });
  const r = await runCli(['comment', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, api.url) });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'Skipped: fork pull request, job summary only\n', '']);
  assert.deepEqual(api.state.requests, []);
});

test('an event that is not pull_request is skipped with no API request, exit 0', async (t) => {
  const api = await startApi(t);
  const dir = setup(t);
  for (const eventName of ['push', 'pull_request_target']) {
    const r = await runCli(['comment', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, api.url, { GITHUB_EVENT_NAME: eventName }) });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'Skipped: not a pull_request event\n', '']);
  }
  assert.deepEqual(api.state.requests, []);
});

// Each case: label, extra env or a change to the setup, the fake API failure, and the exact message.
const ERRORS = [
  ['a missing token', { env: { GITHUB_TOKEN: '' } }, 'GITHUB_TOKEN is not set'],
  ['no GITHUB_EVENT_NAME', { env: { GITHUB_EVENT_NAME: '' } }, 'GITHUB_EVENT_NAME is not set'],
  ['no GITHUB_EVENT_PATH', { env: { GITHUB_EVENT_PATH: '' } }, 'GITHUB_EVENT_PATH is not set'],
  ['a missing event file', { eventFile: null }, 'Cannot read the event file named by GITHUB_EVENT_PATH: ENOENT'],
  ['an event file that is not JSON', { eventFile: '{ "pull_request": ' }, 'The event file named by GITHUB_EVENT_PATH is not valid JSON'],
  ['an event without a number', { eventFile: '{ "pull_request": { "head": {}, "base": {} } }' }, 'The pull_request event has no pull_request.number'],
  ['another GITHUB_REPOSITORY', { env: { GITHUB_REPOSITORY: 'other-owner/demo-shop' } }, 'GITHUB_REPOSITORY is other-owner/demo-shop, but the pull request is in demo-owner/demo-shop'],
  ['a missing summary file', { args: ['comment', '--summary-file', 'missing.md'] }, 'Cannot read missing.md: ENOENT'],
  ['a summary without the marker', { summary: '## PR Check: Passed\n' }, 'The summary does not start with the qa-core-prcheck marker'],
  ['a plain http API URL that is not this machine', { env: { GITHUB_API_URL: 'http://api.example.invalid' } }, 'GITHUB_API_URL must use https (plain http only for 127.0.0.1, ::1 or localhost)'],
  ['an API 403 on the list', { fail: { method: 'GET', status: 403, message: 'Resource not accessible by integration' } },
    'GitHub API GET /repos/demo-owner/demo-shop/issues/7/comments failed with status 403: Resource not accessible by integration'],
  ['an API 422 on the POST', { fail: { method: 'POST', status: 422, message: 'Validation Failed' } },
    'GitHub API POST /repos/demo-owner/demo-shop/issues/7/comments failed with status 422: Validation Failed'],
  ['an API message that repeats the token', { fail: { method: 'GET', status: 401, message: `Bad credentials for ${TOKEN}` } },
    'GitHub API GET /repos/demo-owner/demo-shop/issues/7/comments failed with status 401: Bad credentials for ***'],
];

for (const [label, change, message] of ERRORS) {
  test(`${label}: exit 2, empty stdout, "${message}" on stderr, no token`, async (t) => {
    const api = await startApi(t);
    api.state.fail = change.fail ?? null;
    const dir = setup(t, { summary: change.summary ?? SUMMARY });
    if (change.eventFile === null) fs.rmSync(path.join(dir, 'event.json'));
    else if (change.eventFile !== undefined) fs.writeFileSync(path.join(dir, 'event.json'), change.eventFile);
    const r = await runCli(change.args ?? ['comment', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, api.url, change.env) });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `${message}\n${HELP_LINE}`);
    if (change.fail === undefined) assert.deepEqual(api.state.requests, []);
  });
}

test('an API that cannot be reached: exit 2 with the error code', async (t) => {
  // A port that was free a moment ago: listen, read it, close.
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const dir = setup(t);
  const r = await runCli(['comment', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, `http://127.0.0.1:${port}`) });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  // The one case that waits through the real backoff (2000 and 4000 ms): there is no answer to carry retry-after.
  assert.equal(r.stderr, `GitHub API GET /repos/demo-owner/demo-shop/issues/7/comments could not be reached: ECONNREFUSED (3 attempts)\n${HELP_LINE}`);
});

test('the token goes only into the Authorization header, never into a URL or a body', async (t) => {
  const api = await startApi(t, [bot(55, `${MARKER}\nold`)]);
  const dir = setup(t);
  await runCli(['comment', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, api.url) });
  assert.equal(api.state.requests.length, 2);
  for (const request of api.state.requests) {
    assert.equal(request.authorization, `Bearer ${TOKEN}`);
    assert.ok(!request.url.includes(TOKEN));
    assert.ok(!JSON.stringify(request.body ?? '').includes(TOKEN));
  }
});

// The configured author (S1), the read-only token (S3) and retries (S2).

const APP_BOT = { login: 'my-app[bot]', type: 'Bot' };
const PATCH_OF = (id) => ({ method: 'PATCH', url: `/repos/demo-owner/demo-shop/issues/comments/${id}`, authorization: `Bearer ${TOKEN}`, body: { body: SUMMARY } });
const POST_LIST = { method: 'POST', url: LIST, authorization: `Bearer ${TOKEN}`, body: { body: SUMMARY } };
const GET_USER = { method: 'GET', url: '/user', authorization: `Bearer ${TOKEN}`, body: undefined };
const SKIPPED = 'Skipped: the token cannot write comments (status 403), job summary only\n';
const SKIP_WARNING = '::warning title=qa-core-prcheck::The token cannot write PR comments (status 403). The summary is in the job summary. Give the workflow pull-requests: write, or set comment: false.\n';
const comment = (dir, api, extra) => runCli(['comment', '--summary-file', 's.md'], { cwd: dir, env: prEnv(dir, api.url, extra) });

test('default author: the first run creates the comment and the next run updates it', async (t) => {
  const api = await startApi(t);
  const dir = setup(t);
  const first = await comment(dir, api);
  assert.deepEqual([first.status, first.stdout, first.stderr], [0, `Comment created: ${commentUrl(101)}\n`, '']);
  const second = await comment(dir, api);
  assert.deepEqual([second.status, second.stdout, second.stderr], [0, `Comment updated: ${commentUrl(101)}\n`, '']);
  assert.deepEqual(api.state.requests, [GET_LIST, POST_LIST, GET_LIST, PATCH_OF(101)]);
});

test('PRCHECK_COMMENT_AUTHOR=my-app[bot] updates its own comment, not the github-actions[bot] one, with no GET /user', async (t) => {
  const api = await startApi(t, [bot(55, `${MARKER}\nold`), byUser(66, `${MARKER}\nold`, APP_BOT)]);
  api.state.writer = APP_BOT;
  const dir = setup(t);
  const r = await comment(dir, api, { PRCHECK_COMMENT_AUTHOR: 'my-app[bot]' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, `Comment updated: ${commentUrl(66)}\n`, '']);
  assert.deepEqual(api.state.requests, [GET_LIST, PATCH_OF(66)]);
});

for (const value of ['bad name', 'demo--reviewer', 'my-app[bot]\n::error::injected']) {
  test(`an invalid PRCHECK_COMMENT_AUTHOR ${JSON.stringify(value)}: exit 2, a usage message with the value quoted, no request`, async (t) => {
    const api = await startApi(t);
    const dir = setup(t);
    const r = await comment(dir, api, { PRCHECK_COMMENT_AUTHOR: value });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, `PRCHECK_COMMENT_AUTHOR is not a GitHub login (letters, digits and single hyphens, optionally ending in [bot]): ${JSON.stringify(value)}\n${HELP_LINE}`);
    assert.deepEqual(api.state.requests, []);
  });
}

test('a human author: GET /user confirms the login, then that person\'s comment is updated', async (t) => {
  const reviewer = { login: 'demo-reviewer', type: 'User' };
  const api = await startApi(t, [bot(55, `${MARKER}\nold`), byUser(77, `${MARKER}\nold`, reviewer)]);
  api.state.user = reviewer;
  api.state.writer = reviewer;
  const dir = setup(t);
  const r = await comment(dir, api, { PRCHECK_COMMENT_AUTHOR: 'Demo-Reviewer' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, `Comment updated: ${commentUrl(77)}\n`, '']);
  assert.deepEqual(api.state.requests, [GET_USER, GET_LIST, PATCH_OF(77)]);
});

test('a human author that GET /user does not confirm: exit 2, no list, POST or PATCH', async (t) => {
  const api = await startApi(t, [byUser(77, `${MARKER}\nold`, { login: 'demo-reviewer', type: 'User' })]);
  api.state.user = { login: 'someone-else', type: 'User' };
  const dir = setup(t);
  const r = await comment(dir, api, { PRCHECK_COMMENT_AUTHOR: 'demo-reviewer' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `PRCHECK_COMMENT_AUTHOR is demo-reviewer, but the token's account could not be confirmed as demo-reviewer (GET /user returned someone-else)\n${HELP_LINE}`);
  assert.deepEqual(api.state.requests, [GET_USER]);
});

test('a human author with GET /user answering 403: exit 2, not skipped', async (t) => {
  const api = await startApi(t);
  api.state.queue = { GET: [{ status: 403, message: 'Resource not accessible by integration' }] };
  const dir = setup(t);
  const r = await comment(dir, api, { PRCHECK_COMMENT_AUTHOR: 'demo-reviewer', GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `PRCHECK_COMMENT_AUTHOR is demo-reviewer, but the token's account could not be confirmed as demo-reviewer (GitHub API GET /user failed with status 403: Resource not accessible by integration)\n${HELP_LINE}`);
});

test('--dry-run with a human author calls GET /user and the list, and never posts or edits', async (t) => {
  const reviewer = { login: 'demo-reviewer', type: 'User' };
  const api = await startApi(t, [byUser(77, `${MARKER}\nold`, reviewer)]);
  api.state.user = reviewer;
  const dir = setup(t);
  const r = await runCli(['comment', '--summary-file', 's.md', '--dry-run'], { cwd: dir, env: prEnv(dir, api.url, { PRCHECK_COMMENT_AUTHOR: 'demo-reviewer' }) });
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'Would update comment 77\n', '']);
  assert.deepEqual(api.state.requests, [GET_USER, GET_LIST]);
});

for (const [label, comments, method] of [['POST', [], 'POST'], ['PATCH', [bot(55, `${MARKER}\nold`)], 'PATCH']]) {
  for (const actions of [undefined, 'true']) {
    test(`a ${label} 403 Resource not accessible by integration: Skipped, exit 0, ${actions === 'true' ? 'with' : 'no'} ::warning (GITHUB_ACTIONS ${actions ?? 'unset'})`, async (t) => {
      const api = await startApi(t, comments);
      api.state.fail = { method, status: 403, message: 'Resource not accessible by integration' };
      const dir = setup(t);
      const r = await comment(dir, api, actions === undefined ? {} : { GITHUB_ACTIONS: actions });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, actions === 'true' ? `${SKIPPED}${SKIP_WARNING}` : SKIPPED);
      assert.equal(r.stderr, '');
      assert.deepEqual(api.state.requests.map((q) => q.method), ['GET', method]);
    });
  }
}

test('a 403 on the list GET still exits 2 with GITHUB_ACTIONS set, and is not skipped', async (t) => {
  const api = await startApi(t);
  api.state.fail = { method: 'GET', status: 403, message: 'Resource not accessible by integration' };
  const dir = setup(t);
  const r = await comment(dir, api, { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `GitHub API GET ${LIST} failed with status 403: Resource not accessible by integration\n${HELP_LINE}`);
});

test('a 403 with retry-after: 0 on the list is rate limited and retried, then the comment is created', async (t) => {
  const api = await startApi(t);
  api.state.queue = { GET: [{ status: 403, message: 'You have exceeded a secondary rate limit', headers: { 'retry-after': '0' } }] };
  const dir = setup(t);
  const r = await comment(dir, api);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, `Comment created: ${commentUrl(101)}\n`, '']);
  assert.deepEqual(api.state.requests, [GET_LIST, GET_LIST, POST_LIST]);
});

test('a rate limited 403 on the POST is not skipped: the list is read again and one more POST is sent', async (t) => {
  const api = await startApi(t);
  api.state.queue = { POST: [{ status: 403, message: 'You have exceeded a secondary rate limit', headers: { 'retry-after': '0' } }] };
  const dir = setup(t);
  const r = await comment(dir, api);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, `Comment created: ${commentUrl(101)}\n`, '']);
  assert.deepEqual(api.state.requests.map((q) => q.method), ['GET', 'POST', 'GET', 'POST']);
});

test('a rate limited 403 on both POSTs exits 2, not skipped', async (t) => {
  const api = await startApi(t);
  const limited = { status: 403, message: 'You have exceeded a secondary rate limit', headers: { 'retry-after': '0' } };
  api.state.queue = { POST: [limited, limited] };
  const dir = setup(t);
  const r = await comment(dir, api, { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `GitHub API POST ${LIST} failed with status 403: You have exceeded a secondary rate limit\n${HELP_LINE}`);
});

test('list 502 then 200, with retry-after: 0: the retry succeeds and the comment is created', async (t) => {
  const api = await startApi(t);
  api.state.queue = { GET: [{ status: 502, message: 'Server Error', headers: { 'retry-after': '0' } }] };
  const dir = setup(t);
  const r = await comment(dir, api);
  assert.deepEqual([r.status, r.stdout, r.stderr], [0, `Comment created: ${commentUrl(101)}\n`, '']);
  assert.deepEqual(api.state.requests, [GET_LIST, GET_LIST, POST_LIST]);
});

test('three 503s with retry-after: 0 on the list: exit 2 with the attempt count, no POST', async (t) => {
  const api = await startApi(t);
  const unavailable = { status: 503, message: 'Service Unavailable', headers: { 'retry-after': '0' } };
  api.state.queue = { GET: [unavailable, unavailable, unavailable] };
  const dir = setup(t);
  const r = await comment(dir, api);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, `GitHub API GET ${LIST} failed with status 503: Service Unavailable (3 attempts)\n${HELP_LINE}`);
  assert.deepEqual(api.state.requests, [GET_LIST, GET_LIST, GET_LIST]);
});

const NOTE = 'Note: the comment was written by other-app[bot], not github-actions[bot]. Set comment-author to other-app[bot] to keep one sticky comment.';

for (const actions of [undefined, 'true']) {
  test(`a comment created under another login prints the Note line, exit 0, ${actions === 'true' ? 'with' : 'no'} ::warning (GITHUB_ACTIONS ${actions ?? 'unset'})`, async (t) => {
    const api = await startApi(t);
    api.state.writer = { login: 'other-app[bot]', type: 'Bot' };
    const dir = setup(t);
    const r = await comment(dir, api, actions === undefined ? {} : { GITHUB_ACTIONS: actions });
    const warning = actions === 'true' ? `::warning title=qa-core-prcheck::${NOTE}\n` : '';
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, `Comment created: ${commentUrl(101)}\n${NOTE}\n${warning}`, '']);
  });
}
// Runs last: node:test runs the tests of a file in order.
test('token scan: no stdout or stderr of any case above holds the token', (t) => {
  assert.ok(captured.length >= 60, `${captured.length} outputs`);
  const hits = captured.filter((text) => text.includes(TOKEN));
  t.diagnostic(`scanned ${captured.length} captured outputs (stdout and stderr) for ${TOKEN}: ${hits.length} hits`);
  assert.deepEqual(hits, []);
});
