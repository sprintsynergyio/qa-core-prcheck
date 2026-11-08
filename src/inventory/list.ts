// Reads the Playwright test inventory from `playwright test --list --reporter=json`.
//
// The real shape in Playwright 1.60.0 (recorded in tests/fixtures/inventory/demo-list.json):
//
//   { "config": { "configFile", "rootDir", "projects", ... }, "suites": [...], "errors": [], "stats": {...} }
//
// - config.rootDir is the test folder (testDir), not the config folder. Every "file" is relative to it.
// - suites holds one suite per spec file: { title: <file>, file, line: 0, column: 0, specs, suites }.
//   Its nested suites are describe blocks: { title, file, line, column, specs, suites }.
//   Playwright leaves the suites key out when there are none.
// - Each spec is one test: { title, ok, tags, tests, id, file, line, column }, where tests holds
//   { projectId, projectName, status: "skipped", ... } and tags lists the test's own tags plus those
//   of its describe blocks, without the leading @ ("cart" for '@cart').
// - With two projects, the same spec is printed once per project, each with one entry in tests.
// - A file with no tests is left out. A folder with no tests, or a spec that fails to load, gives
//   exit code 1, an empty stderr and the message in the errors list.
// - Nothing is printed before the JSON.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { relativeRepoPath, resolveRepoPath, toForwardSlashes } from '../paths.js';
import { cleanPlaywrightEnv, findPlaywrightCli, PlaywrightError } from '../playwright/cli.js';
import { InventoryError, type Inventory, type InventorySpec, type InventoryTest } from './types.js';

// Upper limit, in bytes, for what one Playwright list run may print.
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;

const NOT_A_REPORT = 'The Playwright output is not a JSON list report';

// Plain code unit order, so the result never depends on the machine locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? '';
}

function notAReport(): never {
  throw new InventoryError(NOT_A_REPORT);
}

/** The first line of the first error in the report, with the root folder taken out of paths. */
function reportedError(errors: unknown[], root: string): string {
  const first = errors[0];
  const message = isObject(first) && typeof first.message === 'string' ? first.message : String(first);
  const slashRoot = toForwardSlashes(root);
  const line = firstLine(message).replaceAll('\\', '/');
  const stripped = slashRoot === '' ? line : line.split(`${slashRoot}/`).join('').split(slashRoot).join('');
  return `Playwright reported an error: ${stripped}`;
}

/** The titles that tests inside a describe block carry: an anonymous describe adds no title. */
export function describeTitles(titles: string[], describeTitle: string): string[] {
  return describeTitle === '' ? titles : [...titles, describeTitle];
}

/** The describe titles and the test title joined with " > ". */
export function testTitle(titles: string[], title: string): string {
  return [...titles, title].join(' > ');
}

interface Entry { file: string; title: string; line: number; tags: Set<string>; projects: Set<string> }

function readSpec(spec: unknown, titles: string[], rootDir: string, root: string, entries: Map<string, Entry>): void {
  if (!isObject(spec)) notAReport();
  const { title, file, line, tags, tests } = spec;
  if (typeof title !== 'string' || typeof file !== 'string' || typeof line !== 'number') notAReport();
  if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) notAReport();
  if (!Array.isArray(tests)) notAReport();

  const absolute = resolveRepoPath(rootDir, file);
  const relative = relativeRepoPath(root, absolute);
  if (relative === null) {
    throw new InventoryError(`Spec file outside the root folder ${toForwardSlashes(root)}: ${toForwardSlashes(absolute)}`);
  }

  const fullTitle = testTitle(titles, title);
  const key = `${relative}\n${line}\n${fullTitle}`;
  const entry = entries.get(key) ?? { file: relative, title: fullTitle, line, tags: new Set(), projects: new Set() };
  entries.set(key, entry);
  for (const tag of tags as string[]) entry.tags.add(tag.startsWith('@') ? tag : `@${tag}`);
  for (const run of tests) {
    if (!isObject(run) || typeof run.projectName !== 'string') notAReport();
    entry.projects.add(run.projectName);
  }
}

function readSuite(suite: unknown, titles: string[], rootDir: string, root: string, entries: Map<string, Entry>): void {
  if (!isObject(suite)) notAReport();
  const { specs = [], suites = [] } = suite;
  if (!Array.isArray(specs) || !Array.isArray(suites)) notAReport();
  for (const spec of specs) readSpec(spec, titles, rootDir, root, entries);
  for (const child of suites) {
    if (!isObject(child) || typeof child.title !== 'string') notAReport();
    readSuite(child, describeTitles(titles, child.title), rootDir, root, entries);
  }
}

/**
 * Turns the JSON of `playwright test --list --reporter=json` into a sorted inventory. Pure.
 * root is the absolute repository root; spec paths in the result are relative to it.
 */
export function parsePlaywrightList(json: unknown, root: string, playwrightDir: string): Inventory {
  if (!isObject(json)) notAReport();
  if (json.errors !== undefined && !Array.isArray(json.errors)) notAReport();
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new InventoryError(reportedError(json.errors, root));
  const { config, suites } = json;
  if (!isObject(config) || typeof config.rootDir !== 'string' || !Array.isArray(suites)) notAReport();

  const entries = new Map<string, Entry>();
  // The file-level suite's title is the file name, so it is not part of a test title.
  for (const fileSuite of suites) readSuite(fileSuite, [], config.rootDir, root, entries);

  const byFile = new Map<string, InventoryTest[]>();
  for (const entry of entries.values()) {
    const tests = byFile.get(entry.file) ?? [];
    byFile.set(entry.file, tests);
    tests.push({
      title: entry.title,
      line: entry.line,
      tags: [...entry.tags].sort(compareText),
      projects: [...entry.projects].sort(compareText),
    });
  }

  const specs: InventorySpec[] = [...byFile.entries()]
    .map(([file, tests]) => ({ file, tests: tests.sort((a, b) => a.line - b.line || compareText(a.title, b.title)) }))
    .sort((a, b) => compareText(a.file, b.file));
  return { schemaVersion: 1, playwrightDir, specs };
}

interface RunResult { code: number; stdout: string; stderr: string }

/** Runs node with an argument array, never through a command string. */
function runNode(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd, env, encoding: 'utf8', maxBuffer: MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error === null) resolve({ code: 0, stdout, stderr });
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new InventoryError('The Playwright test list is too large to read'));
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr });
      else reject(new InventoryError(`Playwright failed: ${firstLine(stderr) || firstLine(error.message)}`));
    });
  });
}

/** Why a run that exited non-zero failed: the report's first error, else stderr, else the exit code. */
function failureMessage(result: RunResult, root: string): string {
  let json: unknown = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    // Not JSON: fall back to stderr.
  }
  if (isObject(json) && Array.isArray(json.errors) && json.errors.length > 0) return reportedError(json.errors, root);
  const line = firstLine(result.stderr);
  return line === '' ? `Playwright failed with exit code ${result.code}` : `Playwright failed: ${line}`;
}

/**
 * Lists the specs of the Playwright project in <root>/<playwrightDir> by running the Playwright CLI
 * found from root. env is merged over process.env, and REMOVED_ENV_KEYS in src/playwright/cli.ts and the names in
 * removeEnv are taken out.
 * --forbid-only makes a focused test (.only) anywhere in the project an error here, in every environment: Playwright
 * 1.60.0 checks it in list mode too (lib/runner/index.js:2436-2441), and the list then exits 1 with the
 * message in its errors.
 */
export async function readInventory(
  root: string, playwrightDir: string, env?: NodeJS.ProcessEnv, removeEnv: readonly string[] = [],
): Promise<Inventory> {
  let cli: string;
  try {
    cli = findPlaywrightCli(root);
  } catch (error) {
    if (error instanceof PlaywrightError) throw new InventoryError(error.message);
    throw error;
  }

  const runEnv = cleanPlaywrightEnv({ ...process.env, ...env }, {}, removeEnv);
  const args = [cli, 'test', '--list', '--reporter=json', '--forbid-only', '--config', path.resolve(root, playwrightDir)];
  const result = await runNode(args, root, runEnv);
  if (result.code !== 0) throw new InventoryError(failureMessage(result, root));

  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new InventoryError(NOT_A_REPORT);
  }
  return parsePlaywrightList(json, root, playwrightDir);
}
