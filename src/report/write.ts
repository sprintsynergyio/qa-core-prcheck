import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { formatSelectionJson, type Selection } from '../impact/index.js';
import { formatRunJson, type RunResult } from '../run/index.js';
import { ReportError } from './types.js';

// Written beside the summary file: the same JSON as select --json and run --json.
export const SELECTION_FILE = 'prcheck-selection.json';
export const RESULTS_FILE = 'prcheck-results.json';

export interface WrittenFiles {
  summaryFile: string;   // as shown: relative to the current folder, or the file name only
  stepSummary: boolean;  // true when the summary was appended to $GITHUB_STEP_SUMMARY
  artifacts: string[];   // the JSON files written, shown the same way
}

/**
 * A file as shown in output and messages: relative to the current folder with forward slashes when
 * it is inside it, otherwise the file name only, so a home folder path is never shown.
 */
export function shown(file: string): string {
  const relative = path.relative(process.cwd(), path.resolve(file));
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return path.basename(file);
  }
  return relative.split(path.sep).join('/');
}

function codeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : 'unknown error';
}

async function overwrite(file: string, text: string): Promise<void> {
  try {
    await writeFile(file, text);
  } catch (error) {
    throw new ReportError(`Cannot write ${shown(file)}: ${codeOf(error)}`);
  }
}

/**
 * Overwrites summaryFile, writes prcheck-selection.json and prcheck-results.json beside it for the
 * parts that are not null, then appends the summary and a newline to $GITHUB_STEP_SUMMARY when env
 * sets it. Append, as the GitHub docs do with >> in
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands
 * Stops at the first failure with a ReportError that names the file but never its absolute path.
 */
export async function writeSummaryFiles(options: {
  summary: string;
  summaryFile: string;
  selection: Selection | null;
  result: RunResult | null;
  env: NodeJS.ProcessEnv;
}): Promise<WrittenFiles> {
  const { summary, summaryFile, selection, result, env } = options;
  await overwrite(summaryFile, summary);

  const artifacts: string[] = [];
  const dir = path.dirname(summaryFile);
  if (selection !== null) {
    const file = path.join(dir, SELECTION_FILE);
    await overwrite(file, formatSelectionJson(selection));
    artifacts.push(shown(file));
  }
  if (result !== null) {
    const file = path.join(dir, RESULTS_FILE);
    await overwrite(file, formatRunJson(result));
    artifacts.push(shown(file));
  }

  const stepFile = env.GITHUB_STEP_SUMMARY;
  if (stepFile === undefined || stepFile === '') return { summaryFile: shown(summaryFile), stepSummary: false, artifacts };
  try {
    await appendFile(stepFile, `${summary}\n`);
  } catch (error) {
    throw new ReportError(`Cannot append to $GITHUB_STEP_SUMMARY: ${codeOf(error)}`);
  }
  return { summaryFile: shown(summaryFile), stepSummary: true, artifacts };
}
