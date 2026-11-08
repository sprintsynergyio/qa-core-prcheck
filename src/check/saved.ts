// Ranks a summary that check already wrote. It does not run Playwright and does not start a child
// process. The action runs this after the check step, with the API key only in this process.

import { appendFile, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiffResult, DiffSource } from '../diff/index.js';
import { loadLlmConfig } from '../impact/index.js';
import type { Selection } from '../impact/index.js';
import { llmOffLine, rankWithLlm, type FetchLike, type Ranking, type SleepLike } from '../llm/index.js';
import { formatSummary, MAX_SUMMARY_BYTES, RESULTS_FILE, SELECTION_FILE, SUMMARY_MARKER, writeSummaryFiles } from '../report/index.js';
import { ReportError } from '../report/index.js';
import type { RunResult, RunVerdict } from '../run/index.js';

// Chosen limits. check writes a summary under MAX_SUMMARY_BYTES. A larger file, or a JSON file of
// unbounded size, is refused so a replaced artifact cannot exhaust memory or the job summary.
export const MAX_SAVED_JSON_BYTES = 2 * 1024 * 1024;

const VERDICTS: readonly RunVerdict[] = ['passed', 'failed', 'nothing-to-run', 'not-run', 'error'];

export interface RankLlmReport {
  status: 'applied' | 'skipped' | 'off';
  provider: string;
  model: string | null;
  reason: string | null;
}

export interface SavedRankResult {
  llm: RankLlmReport | null;     // null when no ranking was attempted
  ranking: Ranking | null;       // the applied or skipped ranking, when there is one
  offLine: string | null;        // stderr line when the provider is set and the key is empty
  markdown: string;              // the summary text after this command
  rewritten: boolean;            // true when the summary file was changed to add a ranking
  stepSummary: boolean;
}

export interface SavedRankOptions {
  root: string;
  diff: DiffResult;
  summaryFile: string;
  version: string;
  env: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  sleep?: SleepLike;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameSource(a: DiffSource, b: DiffSource): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'git' && b.type === 'git') {
    return a.baseSha === b.baseSha && a.headSha === b.headSha && a.mergeBaseSha === b.mergeBaseSha;
  }
  return a.type === 'file' && b.type === 'file' && a.path === b.path;
}

function stringList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function asSelection(value: unknown): Selection | null {
  if (!isObject(value) || value.schemaVersion !== 1) return null;
  if (value.mode !== 'none' && value.mode !== 'subset' && value.mode !== 'full') return null;
  if (!Array.isArray(value.selected)) return null;
  if (!value.selected.every((spec) => isObject(spec) && typeof spec.file === 'string' && typeof spec.testCount === 'number' && stringList(spec.reasons))) {
    return null;
  }
  if ('suggestions' in value && value.suggestions !== undefined) {
    if (!Array.isArray(value.suggestions)) return null;
    const suggestionsOk = value.suggestions.every((item) => isObject(item)
      && typeof item.file === 'string' && typeof item.reason === 'string' && typeof item.idea === 'string');
    if (!suggestionsOk) return null;
  }
  if (value.mode === 'full' && !stringList(value.fullSuiteReasons)) return null;
  const source = value.source;
  if (!isObject(source)) return null;
  if (source.type === 'git') {
    const shas = ['baseSha', 'headSha', 'mergeBaseSha'];
    if (!shas.every((key) => typeof source[key] === 'string' && source[key] !== '')) return null;
  } else if (source.type !== 'file' || typeof source.path !== 'string') {
    return null;
  }
  return value as unknown as Selection;
}

function asResult(value: unknown): RunResult | null {
  if (!isObject(value) || value.schemaVersion !== 1) return null;
  if (typeof value.verdict !== 'string' || !VERDICTS.includes(value.verdict as RunVerdict)) return null;
  if (!Array.isArray(value.tests)) return null;
  const testsOk = value.tests.every((test) => isObject(test) && typeof test.file === 'string' && typeof test.title === 'string' && typeof test.status === 'string');
  if (!testsOk) return null;
  return value as unknown as RunResult;
}

/** Reads a regular file up to maxBytes. A symlink is refused so the path cannot point outside the workspace. */
export async function readCappedText(file: string, maxBytes: number): Promise<string> {
  const name = path.basename(file);
  let stat;
  try {
    stat = await lstat(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ReportError(`Cannot read ${name}: ${typeof code === 'string' ? code : 'unknown error'}`);
  }
  if (stat.isSymbolicLink()) throw new ReportError(`${name} must be a regular file, not a symlink`);
  if (!stat.isFile()) throw new ReportError(`Cannot read ${name}`);
  if (stat.size > maxBytes) throw new ReportError(`${name} is larger than ${maxBytes} bytes`);
  return readFile(file, 'utf8');
}

function assertSummaryText(markdown: string): void {
  if (!markdown.startsWith(SUMMARY_MARKER)) throw new ReportError('The summary does not start with the qa-core-prcheck marker');
  // A line that starts with :: is a GitHub Actions workflow command. cat of the summary would run it.
  if (/^::/m.test(markdown)) throw new ReportError('The summary contains a workflow command line');
}

async function readOptionalJson(file: string): Promise<{ missing: boolean; value: unknown }> {
  let text: string;
  try {
    text = await readCappedText(file, MAX_SAVED_JSON_BYTES);
  } catch (error) {
    if (error instanceof ReportError && error.message.endsWith(': ENOENT')) return { missing: true, value: null };
    throw error;
  }
  try {
    return { missing: false, value: JSON.parse(text) };
  } catch {
    throw new ReportError(`${path.basename(file)} is not valid JSON`);
  }
}

/** Appends markdown to the job summary. Used when ranking itself cannot finish. */
async function appendStep(markdown: string, env: NodeJS.ProcessEnv): Promise<void> {
  const step = env.GITHUB_STEP_SUMMARY;
  if (step === undefined || step === '') return;
  try {
    await appendFile(step, `${markdown}\n`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ReportError(`Cannot append to $GITHUB_STEP_SUMMARY: ${typeof code === 'string' ? code : 'unknown error'}`);
  }
}

/**
 * Reads the summary check wrote, ranks it when a call is due, and rewrites the summary only when a
 * ranking was applied or skipped. The selection and the result JSON are not changed. Any failure
 * after the summary has been read still appends that summary to the job summary.
 */
export async function rankSavedCheck(options: SavedRankOptions): Promise<SavedRankResult> {
  const { root, diff, summaryFile, version, env, fetch, sleep } = options;
  let markdown: string;
  try {
    markdown = await readCappedText(summaryFile, MAX_SUMMARY_BYTES);
  } catch (error) {
    if (error instanceof ReportError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new ReportError(`Cannot read ${path.basename(summaryFile)}: ${typeof code === 'string' ? code : 'unknown error'}`);
  }
  assertSummaryText(markdown);

  let published = false;
  try {
    const dir = path.dirname(summaryFile);
    const selectionFile = await readOptionalJson(path.join(dir, SELECTION_FILE));
    const resultFile = await readOptionalJson(path.join(dir, RESULTS_FILE));
    if (selectionFile.missing && resultFile.missing) {
      const files = await writeSummaryFiles({ summary: markdown, summaryFile, selection: null, result: null, env });
      published = true;
      return { llm: null, ranking: null, offLine: null, markdown, rewritten: false, stepSummary: files.stepSummary };
    }
    if (selectionFile.missing || resultFile.missing) {
      throw new ReportError(`Both ${SELECTION_FILE} and ${RESULTS_FILE} are required beside the summary`);
    }
    const selection = asSelection(selectionFile.value);
    const result = asResult(resultFile.value);
    if (selection === null) throw new ReportError(`${SELECTION_FILE} is not a selection written by check`);
    if (result === null) throw new ReportError(`${RESULTS_FILE} is not a result written by check`);
    if (!sameSource(selection.source, diff.source)) {
      throw new ReportError('The diff does not match prcheck-selection.json. Pass the same --base or --diff-file that check used.');
    }

    const config = loadLlmConfig(root);
    const offLine = llmOffLine(config, env);
    const ranking = await rankWithLlm({ config, env, diff, selection, result, fetch, sleep });
    let rewritten = false;
    if (ranking !== null) {
      markdown = formatSummary({ selection, result, error: null, version, ranking }).markdown;
      rewritten = true;
    }
    const files = await writeSummaryFiles({ summary: markdown, summaryFile, selection, result, env });
    published = true;
    const llm: RankLlmReport | null = ranking !== null
      ? {
        status: ranking.status,
        provider: ranking.provider,
        model: ranking.model,
        reason: ranking.status === 'skipped' ? ranking.reason : null,
      }
      : offLine === null
        ? null
        : { status: 'off', provider: config.provider, model: config.model, reason: offLine };
    return { llm, ranking, offLine, markdown, rewritten, stepSummary: files.stepSummary };
  } catch (error) {
    if (!published) await appendStep(markdown, env);
    throw error;
  }
}

/** The rank --json object. Keys stay in this order. llm is null when ranking was not attempted. */
export function formatRankJson(result: SavedRankResult): string {
  return `${JSON.stringify({ schemaVersion: 1, llm: result.llm, summaryRewritten: result.rewritten, stepSummary: result.stepSummary }, null, 2)}\n`;
}
