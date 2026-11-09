import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DiffResult } from '../diff/index.js';
import { selectTests, type Selection } from '../impact/index.js';
import { cleanPlaywrightEnv, findPlaywrightCli, PlaywrightError, runPlaywright, type PlaywrightRun } from '../playwright/cli.js';
import { buildPlaywrightArgs } from './command.js';
import { cleanErrorLine, parseJsonReport } from './parse.js';
import { RunError, type RunCounts, type RunResult, type RunVerdict, type TestResult } from './types.js';

// How long one Playwright run may take before it is stopped. The CLI and the action accept 1 to 30
// minutes and pass the result here. The pull request config cannot set it. Callers of runSelected
// (tests) may pass a shorter timeoutMs; they cannot raise the CLI past this cap.
export const DEFAULT_KILL_TIMEOUT_MS = 30 * 60 * 1000;
const KILL_TIMEOUT_MS = DEFAULT_KILL_TIMEOUT_MS;
const TEMP_PREFIX = 'prcheck-run-';
const REPORT_NAME = 'report.json';
const NO_TESTS_RAN = 'No tests ran for the selected specs';
const FAILING = new Set(['failed', 'timedOut', 'interrupted']);

export interface RunOptions {
  root: string;                  // absolute repository root; diff paths are relative to it
  diff: DiffResult;
  env?: NodeJS.ProcessEnv;       // merged over process.env for both Playwright runs, then cleaned
  removeEnv?: readonly string[]; // env var names taken out of the Playwright env (check: the LLM key env var)
  dryRun?: boolean;              // build the command but start nothing
  playwrightCli?: string;        // for tests only: replaces the CLI found from root
  timeoutMs?: number;            // the kill timeout; default KILL_TIMEOUT_MS
}

// Plain code unit order, so the result never depends on the machine locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function countTests(tests: TestResult[]): RunCounts {
  const counts: RunCounts = { total: tests.length, passed: 0, failed: 0, flaky: 0, skipped: 0, timedOut: 0, interrupted: 0 };
  for (const test of tests) counts[test.status]++;
  return counts;
}

interface Outcome {
  command: string[] | null;
  verdict: RunVerdict;
  exitCode: 0 | 1 | 2;
  tests: TestResult[];
  durationMs: number;
  errors: string[];
  warnings: string[];
}

function toResult(selection: Selection, outcome: Outcome): RunResult {
  return {
    schemaVersion: 1,
    source: selection.source,
    mode: selection.mode,
    playwrightDir: selection.playwrightDir,
    specs: selection.selected.map((spec) => spec.file),
    command: outcome.command,
    verdict: outcome.verdict,
    exitCode: outcome.exitCode,
    counts: countTests(outcome.tests),
    durationMs: outcome.durationMs,
    tests: outcome.tests,
    errors: outcome.errors,
    warnings: [...new Set([...selection.warnings, ...outcome.warnings])].sort(compareText),
  };
}

type Report = ReturnType<typeof parseJsonReport>;

/** The parsed report, or null after adding the reason it cannot be read to errors. */
async function readReport(reportFile: string, root: string, run: PlaywrightRun, errors: string[]): Promise<Report | null> {
  let text: string;
  try {
    text = await readFile(reportFile, 'utf8');
  } catch {
    const line = cleanErrorLine(run.stderr, root);
    const missing = `Playwright wrote no JSON report (exit code ${run.exitCode})`;
    errors.push(line === '' ? missing : `${missing}: ${line}`);
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    errors.push('The Playwright JSON report is not valid JSON');
    return null;
  }
  try {
    return parseJsonReport(json, root);
  } catch (error) {
    if (!(error instanceof RunError)) throw error;
    errors.push(error.message);
    return null;
  }
}

/** Runs Playwright in a new temp folder that is always removed, and maps what happened to an outcome. */
async function runInTempFolder(
  root: string, cli: string, args: string[], command: string[], options: Pick<RunOptions, 'env' | 'removeEnv' | 'timeoutMs'>,
): Promise<Outcome> {
  let dir: string;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  } catch (error) {
    throw new RunError(`Cannot create a temp folder for the Playwright report: ${(error as Error).message}`);
  }

  try {
    const reportFile = path.join(dir, REPORT_NAME);
    const env = cleanPlaywrightEnv({ ...process.env, ...options.env }, { PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile }, options.removeEnv);
    const timeoutMs = options.timeoutMs ?? KILL_TIMEOUT_MS;
    const errors: string[] = [];

    let run: PlaywrightRun | null = null;
    try {
      run = await runPlaywright(root, [cli, ...args], env, timeoutMs);
    } catch (error) {
      if (!(error instanceof PlaywrightError)) throw error;
      errors.push(cleanErrorLine(error.message, root));
    }

    let report: Report | null = null;
    if (run !== null && run.timedOut) {
      errors.push(`Playwright was stopped after the kill timeout of ${timeoutMs} ms`);
    } else if (run !== null && run.signal !== null) {
      errors.push(`Playwright was stopped by signal ${run.signal}`);
    } else if (run !== null) {
      report = await readReport(reportFile, root, run, errors);
      if (report !== null) errors.push(...report.errors);
    }

    const tests = report?.tests ?? [];
    const outcome: Outcome = {
      command, verdict: 'passed', exitCode: 0, tests, durationMs: report?.durationMs ?? 0, errors,
      warnings: tests.length === 0 ? [NO_TESTS_RAN] : [],
    };
    // First match wins.
    if (errors.length > 0) return { ...outcome, verdict: 'error', exitCode: 2 };
    if (tests.some((test) => FAILING.has(test.status))) return { ...outcome, verdict: 'failed', exitCode: 1 };
    if (run!.exitCode !== 0) {
      return { ...outcome, verdict: 'error', exitCode: 2, errors: [`Playwright exited with code ${run!.exitCode} but no test failed`] };
    }
    return outcome;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Picks the specs the diff can affect, runs only those with Playwright and reads its JSON report.
 * Exit code 0 when every picked test passed or nothing needed to run, 1 when a picked test failed,
 * 2 for a tool problem. Expected failures before the run throw DiffError, InventoryError, ImpactError
 * or RunError; problems after Playwright started give verdict error instead.
 */
export async function runSelected(options: RunOptions): Promise<RunResult> {
  const { diff, ...rest } = options;
  return runSelection({ ...rest, selection: await selectTests({ root: options.root, diff, env: options.env, removeEnv: options.removeEnv }) });
}

/**
 * Runs a selection that selectTests already made, as runSelected does after picking. Expected failures
 * before the run throw RunError; problems after Playwright started give verdict error instead.
 */
export async function runSelection(options: Omit<RunOptions, 'diff'> & { selection: Selection }): Promise<RunResult> {
  const { root, selection } = options;
  const built = buildPlaywrightArgs(selection, root);
  const idle = { tests: [], durationMs: 0, errors: [], warnings: [] };

  if (built === null) return toResult(selection, { ...idle, command: null, verdict: 'nothing-to-run', exitCode: 0 });
  if (options.dryRun === true) return toResult(selection, { ...idle, command: built.display, verdict: 'not-run', exitCode: 0 });

  let cli = options.playwrightCli;
  if (cli === undefined) {
    try {
      cli = findPlaywrightCli(root);
    } catch (error) {
      if (error instanceof PlaywrightError) throw new RunError(error.message);
      throw error;
    }
  }
  return toResult(selection, await runInTempFolder(root, cli, built.args, built.display, options));
}
