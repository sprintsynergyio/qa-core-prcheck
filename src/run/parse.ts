// Reads the report that `playwright test --reporter=json` writes to PLAYWRIGHT_JSON_OUTPUT_FILE.
//
// The real shape in Playwright 1.60.0 (recorded in tests/fixtures/results/):
//
//   { "config": { "configFile", "rootDir", "projects", ... }, "suites": [...], "errors": [...],
//     "stats": { "startTime", "duration", "expected", "skipped", "unexpected", "flaky" } }
//
// - config.rootDir is the test folder, with forward slashes. Every "file" in suites and specs is relative to it.
// - suites holds one suite per spec file: { title, file, line: 0, column: 0, specs, suites }. Its nested
//   suites are describe blocks. Playwright leaves the suites key out when there are none.
// - Each spec is one test: { title, ok, tags, tests, id, file, line, column }. tags lists the test's own
//   tags plus those of its describe blocks, without the leading @.
// - tests has one entry per project that ran the spec: { timeout, annotations, expectedStatus, projectId,
//   projectName, results, status }. status is expected, unexpected, flaky or skipped. The same spec in a
//   second project may come as a second spec entry with the same title, file and line.
// - results has one entry per attempt: { workerIndex, parallelIndex, status, duration, error, errors,
//   stdout, stderr, retry, startTime, annotations, attachments, errorLocation }. status is passed,
//   failed, timedOut, skipped or interrupted; duration is in ms. error is { message, stack, location,
//   snippet } and errors is [{ message, location }]. Messages keep ANSI color codes, and the first line
//   of an expect() failure is the matcher line ("Expected:" and "Received:" come later).
// - A test.skip() test has one result with status skipped. A test.fail() test that failed has
//   expectedStatus failed and status expected.
// - errors at the top level holds load and worker errors: { message, stack, location, snippet }. A spec
//   that throws while it loads gives suites [] and one error whose location names the file.
// - stats.duration is the run time in ms, with a fraction.
// - Playwright gives status skipped to a test whose results are all interrupted, so the last result
//   decides interrupted below.

import { relativeRepoPath, resolveRepoPath, toForwardSlashes } from '../paths.js';
import { describeTitles, testTitle } from '../inventory/list.js';
import { RunError, type TestResult, type TestStatus } from './types.js';

// Longest error line kept, in characters; longer lines are cut and end in "...". A chosen limit.
const ERROR_LINE_MAX = 200;

const NOT_A_REPORT = 'The Playwright JSON report does not have the expected shape';
const OUTCOMES = ['expected', 'unexpected', 'flaky', 'skipped'];
// Terminal color and cursor codes: ESC [ parameters, intermediates, final byte.
const ANSI = /\u001b\[[0-?]*[ -\/]*[@-~]/g;

// Plain code unit order, so the result never depends on the machine locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notAReport(): never {
  throw new RunError(NOT_A_REPORT);
}

/**
 * The first non-empty line, with color codes removed and the root taken out of paths. Not cut.
 * Playwright and git may use either slash. A Windows root is removed from both forms, and a
 * backslash that remains in the line becomes /, so the summary does not depend on the OS.
 */
function cleanFirstLine(text: string, root: string): string {
  let clean = text.replace(ANSI, '');
  const forms = new Set([toForwardSlashes(root), root]);
  for (const form of forms) {
    if (form === '') continue;
    clean = clean.split(`${form}/`).join('').split(`${form}\\`).join('');
  }
  clean = clean.replaceAll('\\', '/');
  return clean.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

function cut(line: string): string {
  return line.length > ERROR_LINE_MAX ? `${line.slice(0, ERROR_LINE_MAX)}...` : line;
}

/** The first non-empty line of text, cleaned and cut the way every error line in a RunResult is. */
export function cleanErrorLine(text: string, root: string): string {
  return cut(cleanFirstLine(text, root));
}

/** The repo-relative POSIX path of file, or null when it is not inside root. */
function insideRoot(root: string, file: string): string | null {
  return relativeRepoPath(root, file);
}

function messageOf(error: unknown): string | null {
  if (!isObject(error)) return null;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  if (typeof error.value === 'string' && error.value !== '') return error.value;
  return null;
}

/**
 * A top-level error as one line. When the error's location is a file inside the root and the line does
 * not already name it, the line starts with "<file>:<line>: ".
 */
function topLevelError(error: unknown, root: string): string {
  const line = cleanFirstLine(messageOf(error) ?? String(error), root);
  const location = isObject(error) && isObject(error.location) ? error.location : null;
  if (location !== null && typeof location.file === 'string' && typeof location.line === 'number') {
    const file = insideRoot(root, location.file);
    if (file !== null && !line.includes(file)) return cut(`${file}:${location.line}: ${line}`);
  }
  return cut(line);
}

interface RawResult { status: string | undefined; duration: number; message: string | null }

function readResult(result: unknown): RawResult {
  if (!isObject(result) || typeof result.duration !== 'number') notAReport();
  if (result.status !== undefined && typeof result.status !== 'string') notAReport();
  if (result.errors !== undefined && !Array.isArray(result.errors)) notAReport();
  const errors = (result.errors ?? []) as unknown[];
  return { status: result.status, duration: result.duration, message: messageOf(result.error) ?? messageOf(errors[0]) };
}

/** The order is part of the contract: flaky, passed, interrupted from the last result, skipped, then timedOut or failed. */
function statusOf(outcome: string, results: RawResult[]): TestStatus {
  if (outcome === 'flaky') return 'flaky';
  if (outcome === 'expected') return 'passed';
  const last = results.at(-1)?.status;
  if (last === 'interrupted') return 'interrupted';
  if (outcome === 'skipped') return 'skipped';
  return last === 'timedOut' ? 'timedOut' : 'failed';
}

/** The first line of the error of the last attempt that did not end as expected and has one. */
function failureLine(results: RawResult[], expectedStatus: unknown, root: string): string | null {
  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i]!;
    if (result.status !== expectedStatus && result.message !== null) return cleanErrorLine(result.message, root);
  }
  return null;
}

interface Context { rootDir: string; root: string; tests: TestResult[] }

function readSpec(spec: unknown, titles: string[], context: Context): void {
  if (!isObject(spec)) notAReport();
  const { title, file, line, tags, tests } = spec;
  if (typeof title !== 'string' || typeof file !== 'string' || typeof line !== 'number') notAReport();
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) notAReport();
  if (!Array.isArray(tests)) notAReport();

  const relative = insideRoot(context.root, resolveRepoPath(context.rootDir, file));
  if (relative === null) throw new RunError(`Test file outside the root folder: ${file}`);
  const fullTitle = testTitle(titles, title);
  const sortedTags = [...new Set((tags as string[]).map((tag) => (tag.startsWith('@') ? tag : `@${tag}`)))].sort(compareText);

  for (const run of tests) {
    if (!isObject(run) || typeof run.projectName !== 'string') notAReport();
    if (typeof run.status !== 'string' || !OUTCOMES.includes(run.status) || !Array.isArray(run.results)) notAReport();
    const results = run.results.map(readResult);
    const status = statusOf(run.status, results);
    context.tests.push({
      file: relative,
      line,
      title: fullTitle,
      project: run.projectName,
      tags: sortedTags,
      status,
      attempts: results.length,
      durationMs: Math.round(results.reduce((sum, result) => sum + result.duration, 0)),
      error: status === 'passed' || status === 'skipped' ? null : failureLine(results, run.expectedStatus, context.root),
    });
  }
}

function readSuite(suite: unknown, titles: string[], context: Context): void {
  if (!isObject(suite)) notAReport();
  const { specs = [], suites = [] } = suite;
  if (!Array.isArray(specs) || !Array.isArray(suites)) notAReport();
  for (const spec of specs) readSpec(spec, titles, context);
  for (const child of suites) {
    if (!isObject(child) || typeof child.title !== 'string') notAReport();
    readSuite(child, describeTitles(titles, child.title), context);
  }
}

function compareTests(a: TestResult, b: TestResult): number {
  return compareText(a.file, b.file) || a.line - b.line || compareText(a.title, b.title) || compareText(a.project, b.project);
}

/**
 * Turns a Playwright JSON report into sorted test results, the top-level errors as cleaned lines and
 * the run duration. Pure. root is the absolute repository root; files in the result are relative to it.
 */
export function parseJsonReport(json: unknown, root: string): { tests: TestResult[]; errors: string[]; durationMs: number } {
  if (!isObject(json)) notAReport();
  const { config, suites, errors, stats } = json;
  if (!isObject(config) || typeof config.rootDir !== 'string') notAReport();
  if (!Array.isArray(suites) || !Array.isArray(errors)) notAReport();
  if (!isObject(stats) || typeof stats.duration !== 'number') notAReport();

  const context: Context = { rootDir: config.rootDir, root, tests: [] };
  // The file-level suite's title is the file name, so it is not part of a test title.
  for (const fileSuite of suites) readSuite(fileSuite, [], context);
  return {
    tests: context.tests.sort(compareTests),
    errors: errors.map((error) => topLevelError(error, root)),
    durationMs: Math.round(stats.duration),
  };
}
