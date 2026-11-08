import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_API_KEY_ENV, PROVIDER_NAMES, type LlmConfig, type ProviderName } from '../llm/types.js';
import { ImpactError, type ImpactConfig } from './types.js';

export const CONFIG_FILE = 'qa-core-prcheck.config.json';

// Chosen limits. The file comes from the pull request under check, so an unbounded config could
// make selection or a later ranking step do unbounded work. These caps are not raised by any key.
export const CONFIG_MAX_BYTES = 65_536;
export const MAX_AREAS = 100;
export const MAX_TAGS_PER_AREA = 20;
export const MAX_TAG_CHARS = 64;
export const MAX_GLOB_CHARS = 300;
export const MAX_GLOB_LIST = 100;
export const MAX_PLAYWRIGHT_DIR_CHARS = 200;
// A chosen limit. Each * becomes a regex quantifier. A pull request config with dozens of them
// can make matching take a very long time. Real globs in this repo use at most a few.
export const MAX_GLOB_STARS = 8;

const ALLOWED_KEYS = ['playwrightDir', 'areas', 'fullSuiteOn', 'ignore', 'llm'];
const LLM_KEYS = ['provider', 'model'];
// A chosen limit and pattern: it fits the documented example model ids and keeps the Gemini URL path
// safe without encoding.
const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DEFAULT_PLAYWRIGHT_DIR = 'demo/saucedemo';

// Plain code unit order, so the result never depends on the machine locale.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function fail(message: string): never {
  throw new ImpactError(`${CONFIG_FILE}: ${message}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPlaywrightDir(value: unknown): string {
  if (typeof value !== 'string' || value === '') fail('"playwrightDir" must be a non-empty string');
  if (value.length > MAX_PLAYWRIGHT_DIR_CHARS || CONTROL_CHARS.test(value)) {
    fail(`"playwrightDir" must be at most ${MAX_PLAYWRIGHT_DIR_CHARS} characters and must not contain control characters`);
  }
  const slashed = value.replaceAll('\\', '/');
  if (path.posix.isAbsolute(slashed) || path.win32.isAbsolute(value)) {
    fail(`"playwrightDir" must be relative to the root, not absolute: ${value}`);
  }
  if (slashed.split('/').includes('..')) fail(`"playwrightDir" must not contain "..": ${value}`);
  // normalize strips ./ and doubled slashes; "." stays "." for a config at the root.
  const normalized = path.posix.normalize(slashed).replace(/\/+$/, '');
  return normalized === '' ? '.' : normalized;
}

function readGlobText(key: string, glob: string): void {
  if (glob.length > MAX_GLOB_CHARS) fail(`"${key}" glob is longer than ${MAX_GLOB_CHARS} characters`);
  if (CONTROL_CHARS.test(glob)) fail(`"${key}" glob must not contain control characters`);
  const stars = glob.split('*').length - 1;
  if (stars > MAX_GLOB_STARS) fail(`"${key}" glob has more than ${MAX_GLOB_STARS} * characters`);
}

function readAreas(value: unknown): ImpactConfig['areas'] {
  if (!isObject(value)) fail('"areas" must be an object that maps a glob to a list of tags');
  const entries = Object.entries(value);
  if (entries.length > MAX_AREAS) fail(`"areas" has more than ${MAX_AREAS} globs`);
  return entries
    .map(([glob, tags]) => {
      if (glob === '') fail('"areas" has an empty glob');
      readGlobText('areas', glob);
      const valid = Array.isArray(tags) && tags.length > 0
        && tags.every((tag) => typeof tag === 'string' && tag.startsWith('@'));
      if (!valid) fail(`"areas" value for "${glob}" must be a non-empty array of tags that start with @`);
      const list = tags as string[];
      if (list.length > MAX_TAGS_PER_AREA) fail(`"areas" value for "${glob}" has more than ${MAX_TAGS_PER_AREA} tags`);
      for (const tag of list) {
        if (tag.length < 2 || tag.length > MAX_TAG_CHARS || /[\s\u0000-\u001f\u007f]/.test(tag)) {
          fail(`"areas" tag for "${glob}" must be @ followed by 1 to ${MAX_TAG_CHARS - 1} characters and no whitespace`);
        }
      }
      return { glob, tags: sortedUnique(list) };
    })
    .sort((a, b) => compareText(a.glob, b.glob));
}

function readGlobList(key: 'fullSuiteOn' | 'ignore', value: unknown): string[] {
  const valid = Array.isArray(value) && value.every((glob) => typeof glob === 'string' && glob !== '');
  if (!valid) fail(`"${key}" must be an array of non-empty strings`);
  const globs = value as string[];
  if (globs.length > MAX_GLOB_LIST) fail(`"${key}" has more than ${MAX_GLOB_LIST} globs`);
  for (const glob of globs) readGlobText(key, glob);
  return sortedUnique(globs);
}

/** The parsed top-level object of <root>/qa-core-prcheck.config.json, or null when the file does not exist. */
function readConfigObject(root: string): Record<string, unknown> | null {
  const file = path.join(root, CONFIG_FILE);
  let text: string;
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) fail('the file must be a regular file, not a symlink');
    if (!stat.isFile()) throw new ImpactError(`Cannot read ${CONFIG_FILE}`);
    if (stat.size > CONFIG_MAX_BYTES) fail(`the file is larger than ${CONFIG_MAX_BYTES} bytes`);
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof ImpactError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ImpactError(`Cannot read ${CONFIG_FILE}`);
  }
  if (Buffer.byteLength(text) > CONFIG_MAX_BYTES) fail(`the file is larger than ${CONFIG_MAX_BYTES} bytes`);

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ImpactError(`${CONFIG_FILE} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(json)) fail('the top level must be a JSON object');
  for (const key of Object.keys(json)) {
    if (!ALLOWED_KEYS.includes(key)) fail(`unknown key "${key}". Allowed keys: ${ALLOWED_KEYS.join(', ')}`);
  }
  return json;
}

/**
 * Reads <root>/qa-core-prcheck.config.json, or returns the defaults when the file does not exist.
 * The "llm" key is accepted and not read here: check and rank read it, with loadLlmConfig.
 */
export function loadConfig(root: string): ImpactConfig {
  const json = readConfigObject(root);
  if (json === null) return { playwrightDir: DEFAULT_PLAYWRIGHT_DIR, areas: [], fullSuiteOn: [], ignore: [] };
  return {
    playwrightDir: 'playwrightDir' in json ? readPlaywrightDir(json.playwrightDir) : DEFAULT_PLAYWRIGHT_DIR,
    areas: 'areas' in json ? readAreas(json.areas) : [],
    fullSuiteOn: 'fullSuiteOn' in json ? readGlobList('fullSuiteOn', json.fullSuiteOn) : [],
    ignore: 'ignore' in json ? readGlobList('ignore', json.ignore) : [],
  };
}

/**
 * Reads the optional "llm" object of the config file. With no file or no "llm" key the provider is
 * "none", so no call is ever made. The key is never in the file, and the file cannot name its env var:
 * the key is read only from DEFAULT_API_KEY_ENV, since the file comes from the pull request under check.
 */
export function loadLlmConfig(root: string): LlmConfig {
  const json = readConfigObject(root);
  const off: LlmConfig = { provider: 'none', model: null };
  if (json === null || !('llm' in json)) return off;
  const llm = json.llm;
  if (!isObject(llm)) fail('"llm" must be a JSON object.');
  if ('apiKeyEnv' in llm) {
    fail(`"llm.apiKeyEnv" is not supported. The API key is read only from the env var ${DEFAULT_API_KEY_ENV}.`);
  }
  for (const key of Object.keys(llm)) {
    if (!LLM_KEYS.includes(key)) fail(`unknown key "llm.${key}". Allowed keys in "llm": ${LLM_KEYS.join(', ')}.`);
  }
  const provider = 'provider' in llm ? llm.provider : 'none';
  if (typeof provider !== 'string' || !(PROVIDER_NAMES as readonly string[]).includes(provider)) {
    fail(`"llm.provider" must be one of ${PROVIDER_NAMES.join(', ')}.`);
  }
  let model: string | null = null;
  if ('model' in llm) {
    if (typeof llm.model !== 'string' || !MODEL_PATTERN.test(llm.model)) {
      fail('"llm.model" must be a non-empty string of letters, digits and . _ : - (at most 200 characters).');
    }
    model = llm.model;
  }
  if (provider !== 'none' && model === null) fail(`"llm.model" is required when "llm.provider" is ${provider}.`);
  return { provider: provider as ProviderName, model };
}
