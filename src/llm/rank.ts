// The optional LLM ranking step of check. It runs after the test run and only reorders and annotates:
// it gets copies of facts, returns a separate Ranking, and never touches the Selection or RunResult.
// Every failure becomes a skipped Ranking with one short reason; nothing here throws.

import type { DiffResult } from '../diff/index.js';
import type { Selection } from '../impact/index.js';
import { MAX_SUGGESTION_ROWS } from '../report/summary.js';
import type { RunResult } from '../run/index.js';
import { anthropic } from './anthropic.js';
import { gemini } from './gemini.js';
import { postJson, type FetchLike, type SleepLike } from './http.js';
import { openai } from './openai.js';
import { buildPromptData, LLM_INSTRUCTION, LLM_MAX_INPUT_BYTES, pickedFiles } from './prompt.js';
import { DEFAULT_API_KEY_ENV, LlmError, type LlmAdapter, type LlmConfig, type LlmProvider, type Ranking } from './types.js';
import { validateAnswer } from './validate.js';

const ADAPTERS: Record<LlmProvider, LlmAdapter> = { anthropic, openai, gemini };

// A chosen limit. The config cannot name another env var or raise this cap. A key outside this
// shape is not sent: it could break log masking or be a pasted multi-line secret.
export const LLM_KEY_MAX_CHARS = 4096;

export interface RankInput {
  config: LlmConfig;
  env: NodeJS.ProcessEnv;       // where the key is read: env[DEFAULT_API_KEY_ENV]
  diff: DiffResult;
  selection: Selection;
  result: RunResult;
  fetch?: FetchLike;            // for tests: replaces the built-in fetch
  sleep?: SleepLike;            // for tests: replaces the wait before the retry
  timeoutMs?: number;           // for tests: replaces LLM_TIMEOUT_MS
}

const realSleep: SleepLike = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The key value, or '' when the env var is unset. */
function keyOf(env: NodeJS.ProcessEnv): string {
  return env[DEFAULT_API_KEY_ENV] ?? '';
}

/**
 * Why this key must not be sent, or null when it is one line of printable ASCII.
 * The reason never includes the key.
 */
export function llmKeyProblem(key: string): string | null {
  if (key.length > LLM_KEY_MAX_CHARS) return `the API key is longer than ${LLM_KEY_MAX_CHARS} characters`;
  if (!/^[\x21-\x7e]+$/.test(key)) return 'the API key is not a single printable token';
  return null;
}

/** The one stderr line for a provider with no key, or null. */
export function llmOffLine(config: LlmConfig, env: NodeJS.ProcessEnv): string | null {
  if (config.provider === 'none' || keyOf(env) !== '') return null;
  return `LLM ranking is off: the env var ${DEFAULT_API_KEY_ENV} is not set or is empty.`;
}

/** The Warnings, stderr and annotation text of a skipped ranking. */
export function skippedLine(reason: string): string {
  return `LLM ranking skipped: ${reason}. The deterministic order is used.`;
}

/**
 * Ranks the picked specs and the shown suggestions, or returns null when no call is due: provider
 * "none", an unset or empty key, a dry run or error verdict (no ranking then, Q2), or nothing to rank.
 */
export async function rankWithLlm(input: RankInput): Promise<Ranking | null> {
  const { config, env, diff, selection, result } = input;
  if (config.provider === 'none' || config.model === null) return null;
  const key = keyOf(env);
  if (key === '') return null;
  if (result.verdict === 'not-run' || result.verdict === 'error') return null;
  const picked = pickedFiles(selection);
  // A Selection recorded before PR 7 has no suggestions key, which counts as none, as in the summary.
  const shown = (selection.suggestions ?? []).slice(0, MAX_SUGGESTION_ROWS);
  if (picked.length + shown.length === 0) return null;

  const provider = config.provider;
  const model = config.model;
  const problem = llmKeyProblem(key);
  if (problem !== null) return { status: 'skipped', provider, model, reason: problem };
  const scrub = (text: string): string => text.split(key).join('***');
  try {
    // The key is removed from the data before the size check and before the request, in case a
    // path, title or reason from the pull request repeats it.
    const data = scrub(buildPromptData(diff, selection, result, shown));
    if (Buffer.byteLength(LLM_INSTRUCTION) + Buffer.byteLength(data) > LLM_MAX_INPUT_BYTES) {
      throw new LlmError(`the input is over ${LLM_MAX_INPUT_BYTES} bytes`);
    }
    const adapter = ADAPTERS[provider];
    const request = adapter.buildRequest(model, key, LLM_INSTRUCTION, data);
    if (!request.url.startsWith(`${adapter.origin}/`)) throw new LlmError('the request URL is not the provider origin');
    const json = await postJson(request, { key, fetch: input.fetch ?? globalThis.fetch, sleep: input.sleep ?? realSleep, timeoutMs: input.timeoutMs });
    const answer = validateAnswer(adapter.readAnswer(json), picked, shown.length);
    return {
      status: 'applied', provider, model,
      specs: answer.specs.map((s) => ({ file: s.file, note: scrub(s.note) })),
      suggestions: answer.suggestions.map((s) => ({ index: s.index, note: scrub(s.note) })),
    };
  } catch (error) {
    const reason = error instanceof LlmError ? error.message : `of an unexpected error (${error instanceof Error ? error.name : 'unknown'})`;
    return { status: 'skipped', provider, model, reason: scrub(reason) };
  }
}

/** Escapes the message of a GitHub workflow command: % first, then CR and LF. */
function workflowData(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

export interface LlmMessages { stderr: string[]; stdout: string[] }

/**
 * The lines the CLI prints for the LLM step. stderr: the off line, or the skipped line. stdout: a
 * ::warning annotation for a skipped ranking, only in GitHub Actions and only without --json, since
 * action.yml reads check --json stdout as JSON.
 */
export function llmMessages(ranking: Ranking | null, offLine: string | null, options: { json: boolean; githubActions: boolean }): LlmMessages {
  if (offLine !== null) return { stderr: [offLine], stdout: [] };
  if (ranking === null || ranking.status === 'applied') return { stderr: [], stdout: [] };
  const line = skippedLine(ranking.reason);
  const stdout = options.githubActions && !options.json ? [`::warning title=qa-core-prcheck::${workflowData(line)}`] : [];
  return { stderr: [line], stdout };
}
