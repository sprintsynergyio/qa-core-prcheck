// Ranks a summary that check already wrote. It does not run Playwright and does not start a child
// process. The action runs this after the check step, with the API key only in this process.

import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiffResult, DiffSource } from '../diff/index.js';
import { loadLlmConfig } from '../impact/index.js';
import type { Selection } from '../impact/index.js';
import { llmOffLine, rankWithLlm, type FetchLike, type Ranking, type SleepLike } from '../llm/index.js';
import { formatSummary, RESULTS_FILE, SELECTION_FILE, writeSummaryFiles } from '../report/index.js';
import { ReportError } from '../report/index.js';
import type { RunResult, RunVerdict } from '../run/index.js';

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

function asSelection(value: unknown): Selection | null {
  if (!isObject(value) || value.schemaVersion !== 1) return null;
  if (value.mode !== 'none' && value.mode !== 'subset' && value.mode !== 'full') return null;
  if (!Array.isArray(value.selected)) return null;
  if (!isObject(value.source) || (value.source.type !== 'git' && value.source.type !== 'file')) return null;
  return value as unknown as Selection;
}

function asResult(value: unknown): RunResult | null {
  if (!isObject(value) || value.schemaVersion !== 1) return null;
  if (typeof value.verdict !== 'string' || !VERDICTS.includes(value.verdict as RunVerdict)) return null;
  if (!Array.isArray(value.tests)) return null;
  return value as unknown as RunResult;
}

async function readOptionalJson(file: string): Promise<{ missing: boolean; value: unknown }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true, value: null };
    throw new ReportError(`Cannot read ${path.basename(file)}`);
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
    markdown = await readFile(summaryFile, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ReportError(`Cannot read ${path.basename(summaryFile)}: ${typeof code === 'string' ? code : 'unknown error'}`);
  }

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
