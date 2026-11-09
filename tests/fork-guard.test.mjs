import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPullRequestEvent } from '../dist/github/index.js';
import { SUMMARY_MARKER } from '../dist/report/summary.js';
import { ACTION_COMMENT_IF, WORKFLOW_COMMENT_EXPR, commentStepRuns, workflowCommentInput } from './helpers/comment-policy.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, 'dist', 'cli.js');
const BASE = 'demo-owner/demo-shop';

const workflow = fs.readFileSync(path.join(root, '.github/workflows/prcheck.yml'), 'utf8');
const action = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');

test('the workflow comment expression and the action step gate are the locked strings', () => {
  assert.equal(workflow.includes('pull_request_target'), false);
  assert.match(workflow, /^on:\n {2}pull_request:\n/m);
  assert.equal(
    workflow.includes(`comment: \${{ ${WORKFLOW_COMMENT_EXPR} }}`),
    true,
  );
  assert.equal(action.includes(`if: ${ACTION_COMMENT_IF}`), true);
  assert.equal(fs.readFileSync(path.join(root, 'src/cli.ts'), 'utf8').includes('dependabot'), false);
});

const CASES = [
  {
    name: 'same repository, a person',
    head: BASE,
    actor: 'sardar-usman',
    input: 'true',
    command: 'comments',
  },
  {
    name: 'a fork',
    head: 'fork-owner/demo-shop',
    actor: 'fork-owner',
    input: 'false',
    command: 'skip-fork',
  },
  {
    name: 'a deleted fork (null head repo)',
    head: null,
    actor: 'fork-owner',
    input: 'false',
    command: 'skip-fork',
  },
  {
    name: 'Dependabot on the same repository',
    head: BASE,
    actor: 'dependabot[bot]',
    input: 'false',
    command: 'comments',
  },
  {
    name: 'Dependabot from a fork',
    head: 'fork-owner/demo-shop',
    actor: 'dependabot[bot]',
    input: 'false',
    command: 'skip-fork',
  },
  {
    name: 'same repository with different letter case',
    head: 'Demo-Owner/demo-shop',
    actor: 'sardar-usman',
    input: 'false',
    command: 'skip-fork',
  },
];

for (const row of CASES) {
  test(`${row.name}: workflow input ${row.input}, command ${row.command}`, () => {
    const input = workflowCommentInput({ headFullName: row.head, repository: BASE, actor: row.actor });
    assert.equal(input, row.input);
    assert.equal(commentStepRuns(input), row.input === 'true');
    assert.equal(commentStepRuns('false'), false);
    assert.equal(commentStepRuns(''), false);
    const info = readPullRequestEvent(payload(row.head), 'pull_request');
    if (row.command === 'skip-fork') assert.equal(info.isFork, true);
    else assert.equal(info.isFork, false);
  });
}

test('pull_request_target is not a pull_request, so the command does not read it as one', () => {
  assert.equal(readPullRequestEvent(payload(BASE), 'pull_request_target'), null);
  assert.equal(readPullRequestEvent(payload('fork-owner/demo-shop'), 'push'), null);
});

test('a missing head.repo key is an error, not a same-repo pull request', () => {
  const event = payload(BASE);
  delete event.pull_request.head.repo;
  assert.throws(() => readPullRequestEvent(event, 'pull_request'), /pull_request\.head\.repo\.full_name/);
  assert.equal(workflowCommentInput({ headFullName: undefined, repository: BASE, actor: 'sardar-usman' }), 'false');
});

test('the comment command skips a fork and a null head with no request, and a same-repo event reaches the API', async () => {
  const closed = await closedPort();
  const fork = comment(['comment', '--summary-file', 's.md'], payload('fork-owner/demo-shop'), closed);
  assert.deepEqual([fork.status, fork.stdout], [0, 'Skipped: fork pull request, job summary only\n']);
  assert.equal(fork.stderr, '');

  const deleted = comment(['comment', '--summary-file', 's.md'], payload(null), closed);
  assert.deepEqual([deleted.status, deleted.stdout], [0, 'Skipped: fork pull request, job summary only\n']);
  assert.equal(deleted.stderr, '');

  const mismatched = comment(['comment', '--summary-file', 's.md'], payload('Demo-Owner/demo-shop'), closed);
  assert.deepEqual([mismatched.status, mismatched.stdout], [0, 'Skipped: fork pull request, job summary only\n']);

  const missing = payload(BASE);
  delete missing.pull_request.head.repo;
  const broken = comment(['comment', '--summary-file', 's.md'], missing, closed);
  assert.equal(broken.status, 2);
  assert.equal(broken.stdout, '');
  assert.match(broken.stderr, /pull_request\.head\.repo\.full_name/);

  const bothFork = payload('fork-owner/demo-shop');
  bothFork.pull_request.base.repo.full_name = 'fork-owner/demo-shop';
  const forged = comment(['comment', '--summary-file', 's.md'], bothFork, closed);
  assert.equal(forged.status, 2);
  assert.equal(forged.stdout, '');
  assert.match(forged.stderr, /GITHUB_REPOSITORY is demo-owner\/demo-shop/);

  const same = comment(['comment', '--summary-file', 's.md'], payload(BASE), closed);
  assert.equal(same.status, 2);
  assert.equal(same.stdout, '');
  assert.match(same.stderr, /ECONNREFUSED|ECONNRESET|connect/);
});

function payload(head) {
  return {
    action: 'synchronize',
    pull_request: {
      number: 7,
      head: { ref: 'feature', repo: head === null ? null : { full_name: head } },
      base: { ref: 'main', repo: { full_name: BASE } },
    },
  };
}

function comment(args, event, apiUrl) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-fork-'));
  try {
    fs.writeFileSync(path.join(dir, 's.md'), `${SUMMARY_MARKER}\n## PR Check: Passed\n`);
    fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify(event));
    return spawnSync(process.execPath, [cli, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GITHUB_TOKEN: 'ghs_fork_guard_test',
        GITHUB_REPOSITORY: BASE,
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
        GITHUB_API_URL: apiUrl,
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function closedPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(`http://127.0.0.1:${port}`)));
    });
  });
}
