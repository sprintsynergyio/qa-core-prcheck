import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliJs = path.join(repoRoot, 'dist', 'cli.js');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

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

const runCli = (args) => new Promise((resolve) => {
  // process.execPath, not 'node': the test must not depend on PATH.
  const child = spawn(process.execPath, [cliJs, ...args], { cwd: repoRoot });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('--version prints exactly the version in package.json', async () => {
  const r = await runCli(['--version']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${pkgVersion}\n`);
  assert.equal(r.stderr, '');
});

test('-v prints the same version', async () => {
  const r = await runCli(['-v']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, `${pkgVersion}\n`);
  assert.equal(r.stderr, '');
});

for (const args of [['--help'], ['-h'], []]) {
  const label = args.length ? args.join(' ') : 'no arguments';
  test(`${label} prints the usage text and exits 0`, async () => {
    const r = await runCli(args);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, USAGE);
    assert.equal(r.stderr, '');
  });
}

test('an unknown argument exits 2 and names it on stderr', async () => {
  const r = await runCli(['--nope']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Unknown argument: --nope/);
  assert.match(r.stderr, /Run qa-core-prcheck --help for usage\./);
});

test('a valid flag plus an extra argument exits 2 and names the extra one', async () => {
  const r = await runCli(['--version', 'extra']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /Unknown argument: extra/);
});
