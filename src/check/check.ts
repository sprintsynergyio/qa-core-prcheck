import path from 'node:path';
import type { DiffResult } from '../diff/index.js';
import { loadLlmConfig, selectTests, type Selection } from '../impact/index.js';
import { DEFAULT_API_KEY_ENV, llmOffLine, rankWithLlm, type FetchLike, type LlmConfig, type Ranking, type SleepLike } from '../llm/index.js';
import { formatSummary, type Summary } from '../report/index.js';
import { cleanErrorLine, runSelection, type RunResult } from '../run/index.js';

export interface CheckOptions {
  root: string;                  // absolute repository root; diff paths are relative to it
  diff: DiffResult;
  env?: NodeJS.ProcessEnv;       // merged over process.env for both Playwright runs, then cleaned
  dryRun?: boolean;              // pick and build the command, but start no test
  playwrightCli?: string;        // for tests only: replaces the CLI found from root for the test run
  timeoutMs?: number;            // the kill timeout of the test run
  version: string;               // the tool version for the summary footer
  skipLlm?: boolean;             // pick and run, but do not rank. The action sets this so the key stays out of Playwright
  llmConfig?: LlmConfig;         // for tests only: replaces the "llm" config read from root
  fetch?: FetchLike;             // for tests only: replaces the built-in fetch of the LLM step
  sleep?: SleepLike;             // for tests only: replaces the wait before an LLM retry
}

export interface CheckResult {
  selection: Selection;
  result: RunResult;
  summary: Summary;
  llm: Ranking | null;           // null when no ranking was attempted
  llmOff: string | null;         // the stderr line when a provider is set but its key env var is empty (never on a dry run)
}

/**
 * Picks the specs once, runs them, ranks them with the optional LLM and formats the summary. It writes
 * no file; the CLI does that. Expected failures before the run throw DiffError, InventoryError,
 * ImpactError or RunError, as runSelected does. The "llm" config is read first, so a bad llm block
 * stops the check before any test runs. The LLM never changes the selection, the run or the exit code:
 * the ranking is a separate input to the summary, and any LLM failure is a skipped ranking.
 */
export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const { root, diff, env, version, llmConfig, fetch, sleep, skipLlm, ...run } = options;
  const config = llmConfig ?? loadLlmConfig(root);
  const fullEnv = { ...process.env, ...env };
  // The key never reaches Playwright: its env var is taken out of the env of both Playwright runs.
  // Removing it does not hide a key that is already in this process. The action therefore runs check
  // with skipLlm and without the key, and ranks in a later process.
  const removeEnv = [DEFAULT_API_KEY_ENV];
  const selection = await selectTests({ root, diff, env, removeEnv });
  const result = await runSelection({ ...run, root, env, removeEnv, selection });
  const holdLlm = skipLlm === true || run.dryRun === true;
  const llm = holdLlm ? null : await rankWithLlm({ config, env: fullEnv, diff, selection, result, fetch, sleep });
  const summary = formatSummary({ selection, result, error: null, version, ranking: llm });
  // A dry run never ranks, so it prints no off line either (PR 8 review). --skip-llm is the same:
  // ranking has not been attempted, and a later rank command owns the off or skipped line.
  const llmOff = holdLlm ? null : llmOffLine(config, fullEnv);
  return { selection, result, summary, llm, llmOff };
}

/**
 * An error that stopped the check before the run, as one line for the summary: cleaned like every
 * RunResult error, with any absolute root left in it shown as <root>.
 */
export function checkErrorLine(message: string, root: string): string {
  const line = cleanErrorLine(message, root);
  return root === path.parse(root).root ? line : line.split(root).join('<root>');
}
