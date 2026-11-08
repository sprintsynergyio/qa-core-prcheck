#!/usr/bin/env node
// Exit codes:
//   0  ok; for run and check: every picked test passed, or nothing needed to run
//   1  a picked test failed (run and check)
//   2  usage or tool error

import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkErrorLine, formatCheckJson, formatRankJson, rankSavedCheck, readCappedText, runCheck, type CheckResult } from './check/index.js';
import { DiffError, formatJson, formatText, readDiffFile, readGitDiff, type DiffResult } from './diff/index.js';
import {
  confirmCommentAuthor, createGitHubClient, findStickyCommentOnPullRequest, GitHubError, parseCommentAuthor, readPullRequestEvent,
  upsertStickyComment,
} from './github/index.js';
import { formatSelectionJson, formatSelectionText, ImpactError, selectTests, type Selection } from './impact/index.js';
import { InventoryError } from './inventory/index.js';
import { llmMessages } from './llm/index.js';
import { formatSummary, MAX_SUMMARY_BYTES, ReportError, SUMMARY_MARKER, shown, writeSummaryFiles, type WrittenFiles } from './report/index.js';
import { formatRunJson, formatRunText, RunError, runSelected, type RunResult } from './run/index.js';
import { VERSION } from './version.js';

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

const DIFF_USAGE = `qa-core-prcheck diff --base <ref> [--head <ref>] [--json]
qa-core-prcheck diff --diff-file <path> [--json]

Options:
  --base <ref>        Compare against the merge base of this ref and the head
  --head <ref>        The head ref (default: HEAD)
  --diff-file <path>  Read a saved unified git diff instead of running git
  --json              Print JSON instead of text
  -h, --help          Print this help

Exit codes: 0 ok, 2 usage or tool error. This command never exits 1.
`;

const SELECT_USAGE = `qa-core-prcheck select --base <ref> [--head <ref>] [--root <dir>] [--json]
qa-core-prcheck select --diff-file <path> [--root <dir>] [--json]

Picks the Playwright specs a change can affect. It does not run any test.

Options:
  --base <ref>        Compare against the merge base of this ref and the head
  --head <ref>        The head ref (default: HEAD)
  --diff-file <path>  Read a saved unified git diff instead of running git
  --root <dir>        The repository root (default: the current folder)
  --json              Print JSON instead of text
  -h, --help          Print this help

Reads qa-core-prcheck.config.json from the root when it exists.
Exit codes: 0 ok, 2 usage or tool error. This command never exits 1.
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

const DEFAULT_SUMMARY_FILE = 'prcheck-summary.md';
// Used when GITHUB_API_URL is not set, as outside GitHub Actions.
const DEFAULT_API_URL = 'https://api.github.com';

function usageError(arg: string): void {
  process.stderr.write(`Unknown argument: ${arg}\nRun qa-core-prcheck --help for usage.\n`);
  process.exitCode = 2;
}

function commandError(command: string, message: string): void {
  process.stderr.write(`${message}\nRun qa-core-prcheck ${command} --help for usage.\n`);
  process.exitCode = 2;
}

type DiffSourceRequest =
  | { source: 'git'; base: string; head: string | undefined }
  | { source: 'file'; diffFile: string };

interface ParsedArgs { values: Map<string, string>; json: boolean; dryRun: boolean; skipLlm: boolean }

const DIFF_OPTIONS = new Set(['--base', '--head', '--diff-file']);
const SELECT_OPTIONS = new Set([...DIFF_OPTIONS, '--root']);
const RUN_OPTIONS = new Set([...SELECT_OPTIONS, '--timeout-minutes']);
const RANK_OPTIONS = new Set([...SELECT_OPTIONS, '--summary-file']);
const CHECK_OPTIONS = new Set([...RUN_OPTIONS, '--summary-file']);
const COMMENT_OPTIONS = new Set(['--summary-file']);

// The kill timeout the CLI and the action allow. A whole number of minutes, 1 to 30.
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 30;

/**
 * Returns the values, or the message for the first problem found. Values follow their option; no = form.
 * --dry-run is a flag only where allowDryRun is set, and --json only where allowJson is set; elsewhere
 * each is an unknown argument.
 */
function parseArgs(
  args: string[], valueOptions: Set<string>, allowDryRun = false, allowJson = true, allowSkipLlm = false,
): ParsedArgs | string {
  const values = new Map<string, string>();
  let json = false;
  let dryRun = false;
  let skipLlm = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (allowJson && arg === '--json') {
      if (json) return 'Duplicate argument: --json';
      json = true;
    } else if (allowDryRun && arg === '--dry-run') {
      if (dryRun) return 'Duplicate argument: --dry-run';
      dryRun = true;
    } else if (allowSkipLlm && arg === '--skip-llm') {
      if (skipLlm) return 'Duplicate argument: --skip-llm';
      skipLlm = true;
    } else if (valueOptions.has(arg)) {
      if (values.has(arg)) return `Duplicate argument: ${arg}`;
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `Missing value for ${arg}`;
      values.set(arg, value);
      i++;
    } else {
      return `Unknown argument: ${arg}`;
    }
  }
  return { values, json, dryRun, skipLlm };
}

/** The kill timeout in ms, or a usage message. Missing means 30 minutes. The config file cannot set this. */
function timeoutMsOf(raw: string | undefined): number | string {
  if (raw === undefined) return MAX_TIMEOUT_MINUTES * 60 * 1000;
  if (!/^(?:[1-9]|[12]\d|30)$/.test(raw)) {
    return `--timeout-minutes must be a whole number of minutes from ${MIN_TIMEOUT_MINUTES} to ${MAX_TIMEOUT_MINUTES}`;
  }
  return Number(raw) * 60 * 1000;
}

/** Exactly one of --base and --diff-file, and --head only with --base. */
function diffSourceOf(values: Map<string, string>): DiffSourceRequest | string {
  const base = values.get('--base');
  const head = values.get('--head');
  const diffFile = values.get('--diff-file');
  if (base !== undefined && diffFile !== undefined) return 'Use either --base or --diff-file, not both';
  if (head !== undefined && base === undefined) return '--head can only be used with --base';
  if (base !== undefined) return { source: 'git', base, head };
  if (diffFile !== undefined) return { source: 'file', diffFile };
  return 'Missing required option: --base <ref> or --diff-file <path>';
}

/** Prints the command help for --help or -h as the only argument. True when the arguments were a help request. */
function handleHelp(command: string, usage: string, args: string[]): boolean {
  const [first, extra] = args;
  if (first !== '--help' && first !== '-h') return false;
  if (extra !== undefined) commandError(command, `Unknown argument: ${extra}`);
  else process.stdout.write(usage);
  return true;
}

function readDiff(request: DiffSourceRequest, cwd: string): Promise<DiffResult> {
  return request.source === 'git'
    ? readGitDiff({ base: request.base, head: request.head, cwd })
    : readDiffFile(request.diffFile);
}

async function runDiff(args: string[]): Promise<void> {
  if (handleHelp('diff', DIFF_USAGE, args)) return;

  const parsed = parseArgs(args, DIFF_OPTIONS);
  if (typeof parsed === 'string') return commandError('diff', parsed);
  const request = diffSourceOf(parsed.values);
  if (typeof request === 'string') return commandError('diff', request);

  let result: DiffResult;
  try {
    result = await readDiff(request, process.cwd());
  } catch (error) {
    if (error instanceof DiffError) return commandError('diff', error.message);
    throw error;
  }
  // Format first, then write once: stdout only gets output when everything worked.
  process.stdout.write(parsed.json ? formatJson(result) : formatText(result));
}

async function runSelect(args: string[]): Promise<void> {
  if (handleHelp('select', SELECT_USAGE, args)) return;

  const parsed = parseArgs(args, SELECT_OPTIONS);
  if (typeof parsed === 'string') return commandError('select', parsed);
  const request = diffSourceOf(parsed.values);
  if (typeof request === 'string') return commandError('select', request);
  const root = path.resolve(parsed.values.get('--root') ?? process.cwd());

  // The diff is read first, so a bad ref fails before Playwright runs. --diff-file is read from the current folder.
  let selection: Selection;
  try {
    const diff = await readDiff(request, root);
    selection = await selectTests({ root, diff });
  } catch (error) {
    if (error instanceof DiffError || error instanceof InventoryError || error instanceof ImpactError) {
      return commandError('select', error.message);
    }
    throw error;
  }
  process.stdout.write(parsed.json ? formatSelectionJson(selection) : formatSelectionText(selection));
}

async function runRun(args: string[]): Promise<void> {
  if (handleHelp('run', RUN_USAGE, args)) return;

  const parsed = parseArgs(args, RUN_OPTIONS, true);
  if (typeof parsed === 'string') return commandError('run', parsed);
  const request = diffSourceOf(parsed.values);
  if (typeof request === 'string') return commandError('run', request);
  const timeoutMs = timeoutMsOf(parsed.values.get('--timeout-minutes'));
  if (typeof timeoutMs === 'string') return commandError('run', timeoutMs);
  const root = path.resolve(parsed.values.get('--root') ?? process.cwd());

  // Problems before Playwright starts are typed errors and leave stdout empty, as for select.
  let result: RunResult;
  try {
    const diff = await readDiff(request, root);
    result = await runSelected({ root, diff, dryRun: parsed.dryRun, timeoutMs });
  } catch (error) {
    if (error instanceof DiffError || error instanceof InventoryError || error instanceof ImpactError || error instanceof RunError) {
      return commandError('run', error.message);
    }
    throw error;
  }
  // Exit codes 0, 1 and 2 all print the result. For a runner error it carries every error, and the
  // first one also goes to stderr.
  process.stdout.write(parsed.json ? formatRunJson(result) : formatRunText(result));
  if (result.verdict === 'error' && result.errors.length > 0) process.stderr.write(`${result.errors[0]}\n`);
  process.exitCode = result.exitCode;
}

async function runCheckCommand(args: string[]): Promise<void> {
  if (handleHelp('check', CHECK_USAGE, args)) return;

  const parsed = parseArgs(args, CHECK_OPTIONS, true, true, true);
  if (typeof parsed === 'string') return commandError('check', parsed);
  const request = diffSourceOf(parsed.values);
  if (typeof request === 'string') return commandError('check', request);
  const timeoutMs = timeoutMsOf(parsed.values.get('--timeout-minutes'));
  if (typeof timeoutMs === 'string') return commandError('check', timeoutMs);
  const root = path.resolve(parsed.values.get('--root') ?? process.cwd());
  // Read from the current folder, as --diff-file is.
  const summaryFile = path.resolve(parsed.values.get('--summary-file') ?? DEFAULT_SUMMARY_FILE);

  let checked: CheckResult;
  try {
    const diff = await readDiff(request, root);
    checked = await runCheck({
      root, diff, dryRun: parsed.dryRun, skipLlm: parsed.skipLlm, timeoutMs, version: VERSION, env: process.env,
    });
  } catch (error) {
    if (!(error instanceof DiffError || error instanceof InventoryError || error instanceof ImpactError || error instanceof RunError)) {
      throw error;
    }
    // Stopped before the run: the message goes to stderr and stdout stays empty, as for run. The
    // summary still says so, except in a dry run, which never writes.
    commandError('check', error.message);
    if (parsed.dryRun) return;
    const summary = formatSummary({ selection: null, result: null, error: checkErrorLine(error.message, root), version: VERSION });
    try {
      await writeSummaryFiles({ summary: summary.markdown, summaryFile, selection: null, result: null, env: process.env });
    } catch (writeError) {
      if (!(writeError instanceof ReportError)) throw writeError;
      process.stderr.write(`${writeError.message}\n`);
    }
    return;
  }

  // Exit codes 0, 1 and 2 from the run all print the summary. A write failure still prints it and exits 2.
  const { selection, result, summary, llm, llmOff } = checked;
  let files: WrittenFiles | null = null;
  let writeFailure: string | null = null;
  if (!parsed.dryRun) {
    try {
      files = await writeSummaryFiles({ summary: summary.markdown, summaryFile, selection, result, env: process.env });
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      writeFailure = error.message;
    }
  }
  const exitCode = writeFailure === null ? result.exitCode : 2;
  process.stdout.write(parsed.json ? formatCheckJson(selection, result, summary, files, exitCode, llm) : summary.markdown);
  if (result.verdict === 'error' && result.errors.length > 0) process.stderr.write(`${result.errors[0]}\n`);
  if (writeFailure !== null) process.stderr.write(`${writeFailure}\n`);
  // The LLM lines: the off line or the skipped line on stderr, and a skipped annotation on stdout only
  // in GitHub Actions without --json (action.yml reads check --json stdout as JSON).
  const messages = llmMessages(llm, llmOff, { json: parsed.json, githubActions: process.env.GITHUB_ACTIONS === 'true' });
  for (const line of messages.stderr) process.stderr.write(`${line}\n`);
  for (const line of messages.stdout) process.stdout.write(`${line}\n`);
  process.exitCode = exitCode;
}

async function runRankCommand(args: string[]): Promise<void> {
  if (handleHelp('rank', RANK_USAGE, args)) return;

  const parsed = parseArgs(args, RANK_OPTIONS);
  if (typeof parsed === 'string') return commandError('rank', parsed);
  const request = diffSourceOf(parsed.values);
  if (typeof request === 'string') return commandError('rank', request);
  const root = path.resolve(parsed.values.get('--root') ?? process.cwd());
  const summaryFile = path.resolve(parsed.values.get('--summary-file') ?? DEFAULT_SUMMARY_FILE);

  let diff;
  try {
    diff = await readDiff(request, root);
  } catch (error) {
    if (!(error instanceof DiffError)) throw error;
    // check may already have written an error summary. Keep it on the job summary when the ref is bad.
    try {
      const markdown = await readCappedText(summaryFile, MAX_SUMMARY_BYTES);
      const step = process.env.GITHUB_STEP_SUMMARY;
      if (step !== undefined && step !== '' && markdown.startsWith(SUMMARY_MARKER) && !/^::/m.test(markdown)) {
        await appendFile(step, `${markdown}\n`);
      }
    } catch {
      // The diff error is the one to report. A missing or unsafe summary is not appended.
    }
    return commandError('rank', error.message);
  }

  try {
    const ranked = await rankSavedCheck({ root, diff, summaryFile, version: VERSION, env: process.env });
    process.stdout.write(parsed.json ? formatRankJson(ranked) : ranked.markdown);
    const messages = llmMessages(ranked.ranking, ranked.offLine, { json: parsed.json, githubActions: process.env.GITHUB_ACTIONS === 'true' });
    for (const line of messages.stderr) process.stderr.write(`${line}\n`);
    for (const line of messages.stdout) process.stdout.write(`${line}\n`);
  } catch (error) {
    if (error instanceof DiffError || error instanceof ImpactError || error instanceof ReportError) {
      return commandError('rank', error.message);
    }
    throw error;
  }
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : 'unknown error';
}

async function readEventFile(file: string | undefined): Promise<unknown> {
  if (file === undefined || file === '') throw new GitHubError('GITHUB_EVENT_PATH is not set');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new GitHubError(`Cannot read the event file named by GITHUB_EVENT_PATH: ${errorCode(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubError('The event file named by GITHUB_EVENT_PATH is not valid JSON');
  }
}

async function runCommentCommand(args: string[]): Promise<void> {
  if (handleHelp('comment', COMMENT_USAGE, args)) return;

  const parsed = parseArgs(args, COMMENT_OPTIONS, true, false);
  if (typeof parsed === 'string') return commandError('comment', parsed);
  const summaryFile = parsed.values.get('--summary-file');
  if (summaryFile === undefined) return commandError('comment', 'Missing required option: --summary-file <path>');

  const env = process.env;
  const token = env.GITHUB_TOKEN ?? '';
  // Every message goes through here, so even a message that repeated the token could not print it.
  const fail = (message: string): void => commandError('comment', token === '' ? message : message.split(token).join('***'));

  let body: string;
  try {
    body = await readFile(path.resolve(summaryFile), 'utf8');
  } catch (error) {
    return fail(`Cannot read ${shown(summaryFile)}: ${errorCode(error)}`);
  }
  if (token === '') return fail('GITHUB_TOKEN is not set');
  const author = parseCommentAuthor(env.PRCHECK_COMMENT_AUTHOR);
  if (author === null) {
    // JSON quotes, so a line break in the value cannot start a workflow command in the log.
    const shownValue = JSON.stringify(env.PRCHECK_COMMENT_AUTHOR);
    return fail(`PRCHECK_COMMENT_AUTHOR is not a GitHub login (letters, digits and single hyphens, optionally ending in [bot]): ${shownValue}`);
  }
  const inActions = env.GITHUB_ACTIONS === 'true';
  const eventName = env.GITHUB_EVENT_NAME ?? '';
  if (eventName === '') return fail('GITHUB_EVENT_NAME is not set');
  if (eventName !== 'pull_request') {
    process.stdout.write('Skipped: not a pull_request event\n');
    return;
  }

  try {
    const info = readPullRequestEvent(await readEventFile(env.GITHUB_EVENT_PATH), eventName)!;
    // A fork's token is read-only, so it could not comment anyway.
    if (info.isFork) {
      process.stdout.write('Skipped: fork pull request, job summary only\n');
      return;
    }
    const repository = env.GITHUB_REPOSITORY ?? '';
    if (repository !== info.baseRepo) {
      return fail(`GITHUB_REPOSITORY is ${repository === '' ? 'not set' : repository}, but the pull request is in ${info.baseRepo}`);
    }
    const client = createGitHubClient({ token, apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL, fetch });
    const target = { client, owner: info.owner, repo: info.repo, number: info.number };
    // A person as the author is confirmed with GET /user before any comment is read.
    const confirmed = await confirmCommentAuthor(client, author);

    // A dry run reads the comments to tell create from update, and never posts or edits one.
    if (parsed.dryRun) {
      const match = await findStickyCommentOnPullRequest(target, confirmed);
      process.stdout.write(match === null ? 'Would create a comment\n' : `Would update comment ${match.comment.id}\n`);
      return;
    }
    const result = await upsertStickyComment({ ...target, body, author: confirmed });
    const n = result.duplicates;
    const duplicates = n === 0 ? '' : n === 1 ? ' (1 newer duplicate left as it is)' : ` (${n} newer duplicates left as they are)`;
    process.stdout.write(`Comment ${result.action}: ${result.url}${duplicates}\n`);
    // Another author means the next run will not find this comment, so it says how to keep one.
    if (result.action === 'created' && result.author !== null && result.author !== confirmed.login) {
      const note = `Note: the comment was written by ${result.author}, not ${confirmed.login}. Set comment-author to ${result.author} to keep one sticky comment.`;
      process.stdout.write(`${note}\n`);
      if (inActions) process.stdout.write(`::warning title=qa-core-prcheck::${note}\n`);
    }
  } catch (error) {
    // A token that may read but not write: the job summary still has the summary, so this is no failure.
    // A rate limited 403 (a rate limit header, or an API message that says rate limit, as a secondary
    // rate limit 403 may have no header), a 403 on a GET and every other status stay errors.
    if (error instanceof GitHubError && error.status === 403 && !error.rateLimited && (error.method === 'POST' || error.method === 'PATCH')) {
      process.stdout.write('Skipped: the token cannot write comments (status 403), job summary only\n');
      if (inActions) {
        process.stdout.write('::warning title=qa-core-prcheck::The token cannot write PR comments (status 403). The summary is in the job summary. Give the workflow pull-requests: write, or set comment: false.\n');
      }
      return;
    }
    if (error instanceof GitHubError) return fail(error.message);
    throw error;
  }
}

async function main(args: string[]): Promise<void> {
  const [first, extra] = args;

  if (first === 'diff') return runDiff(args.slice(1));
  if (first === 'select') return runSelect(args.slice(1));
  if (first === 'run') return runRun(args.slice(1));
  if (first === 'check') return runCheckCommand(args.slice(1));
  if (first === 'rank') return runRankCommand(args.slice(1));
  if (first === 'comment') return runCommentCommand(args.slice(1));

  if (first === undefined || first === '--help' || first === '-h') {
    if (extra !== undefined) return usageError(extra);
    process.stdout.write(USAGE);
    return;
  }

  if (first === '--version' || first === '-v') {
    if (extra !== undefined) return usageError(extra);
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  usageError(first);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`Unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
