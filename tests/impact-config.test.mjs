import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImpactError, loadConfig, loadLlmConfig } from '../dist/impact/index.js';
import { cleanup } from './helpers/git-repo.mjs';

// Each case writes qa-core-prcheck.config.json into its own temp folder. Expected values are written by hand.

function newDir(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'prcheck-'));
  t.after(() => cleanup(dir));
  return dir;
}

function withConfig(t, content) {
  const dir = newDir(t);
  fs.writeFileSync(path.join(dir, 'qa-core-prcheck.config.json'), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

function throwsImpactError(dir, ...needles) {
  assert.throws(() => loadConfig(dir), (error) => {
    assert.ok(error instanceof ImpactError, `expected ImpactError, got ${error}`);
    for (const needle of needles) assert.ok(error.message.includes(needle), `"${error.message}" should include "${needle}"`);
    return true;
  });
}

test('no config file gives the defaults', (t) => {
  assert.deepEqual(loadConfig(newDir(t)), {
    playwrightDir: 'demo/saucedemo', areas: [], fullSuiteOn: [], ignore: [],
  });
});

test('a full valid file is read', (t) => {
  const dir = withConfig(t, {
    playwrightDir: 'demo/saucedemo',
    areas: { 'demo/saucedemo/pages/cart-page.ts': ['@cart'] },
    fullSuiteOn: ['demo/saucedemo/fixtures/**'],
    ignore: ['docs/**', '**/*.md'],
  });
  assert.deepEqual(loadConfig(dir), {
    playwrightDir: 'demo/saucedemo',
    areas: [{ glob: 'demo/saucedemo/pages/cart-page.ts', tags: ['@cart'] }],
    fullSuiteOn: ['demo/saucedemo/fixtures/**'],
    ignore: ['**/*.md', 'docs/**'],
  });
});

test('areas, their tags and both lists are sorted in code unit order, without duplicates', (t) => {
  const dir = withConfig(t, {
    areas: { 'src/cart/**': ['@cart', '@Cart', '@cart'], 'src/**/*.ts': ['@login'], 'docs/**': ['@docs'] },
    fullSuiteOn: ['b/**', 'a/**', 'B/**', 'a/**'],
    ignore: ['z.md', '*.md', 'a.md'],
  });
  assert.deepEqual(loadConfig(dir), {
    playwrightDir: 'demo/saucedemo',
    areas: [
      { glob: 'docs/**', tags: ['@docs'] },
      { glob: 'src/**/*.ts', tags: ['@login'] },
      { glob: 'src/cart/**', tags: ['@Cart', '@cart'] },
    ],
    fullSuiteOn: ['B/**', 'a/**', 'b/**'],
    ignore: ['*.md', 'a.md', 'z.md'],
  });
});

for (const [raw, expected] of [['./demo/x/', 'demo/x'], ['demo\\x', 'demo/x'], ['demo//x/', 'demo/x'], ['.', '.'], ['./', '.']]) {
  test(`playwrightDir ${raw} becomes ${expected}`, (t) => {
    assert.equal(loadConfig(withConfig(t, { playwrightDir: raw })).playwrightDir, expected);
  });
}

test('invalid JSON names the file', (t) => {
  throwsImpactError(withConfig(t, '{ "playwrightDir": '), 'qa-core-prcheck.config.json is not valid JSON');
});

for (const [label, content] of [['an array', '[]'], ['a string', '"demo"'], ['null', 'null']]) {
  test(`a top level that is ${label} is rejected`, (t) => {
    throwsImpactError(withConfig(t, content), 'qa-core-prcheck.config.json', 'top level must be a JSON object');
  });
}

test('an unknown key is named, with the allowed keys', (t) => {
  throwsImpactError(withConfig(t, { playwrightDir: 'demo/saucedemo', testDir: 'tests' }),
    'unknown key "testDir"', 'Allowed keys: playwrightDir, areas, fullSuiteOn, ignore');
});

const BAD_VALUES = [
  ['an empty playwrightDir', { playwrightDir: '' }, '"playwrightDir" must be a non-empty string'],
  ['a playwrightDir that is not a string', { playwrightDir: 3 }, '"playwrightDir" must be a non-empty string'],
  ['an absolute playwrightDir', { playwrightDir: '/repo/demo' }, '"playwrightDir" must be relative to the root, not absolute'],
  ['a Windows absolute playwrightDir', { playwrightDir: 'C:\\repo\\demo' }, '"playwrightDir" must be relative to the root, not absolute'],
  ['a playwrightDir with ..', { playwrightDir: 'demo/../other' }, '"playwrightDir" must not contain ".."'],
  ['a playwrightDir that is ..', { playwrightDir: '..' }, '"playwrightDir" must not contain ".."'],
  ['areas as an array', { areas: [] }, '"areas" must be an object'],
  ['areas as a string', { areas: '@cart' }, '"areas" must be an object'],
  ['an area with an empty glob', { areas: { '': ['@cart'] } }, '"areas" has an empty glob'],
  ['an area with no tags', { areas: { 'src/**': [] } }, '"areas" value for "src/**"'],
  ['an area whose value is a string', { areas: { 'src/**': '@cart' } }, '"areas" value for "src/**"'],
  ['a tag without @', { areas: { 'src/**': ['@cart', 'cart'] } }, '"areas" value for "src/**" must be a non-empty array of tags that start with @'],
  ['fullSuiteOn as a string', { fullSuiteOn: 'docs/**' }, '"fullSuiteOn" must be an array of non-empty strings'],
  ['fullSuiteOn with an empty string', { fullSuiteOn: ['docs/**', ''] }, '"fullSuiteOn" must be an array of non-empty strings'],
  ['ignore with a number', { ignore: ['docs/**', 1] }, '"ignore" must be an array of non-empty strings'],
  ['ignore as an object', { ignore: { 'docs/**': true } }, '"ignore" must be an array of non-empty strings'],
];

for (const [label, content, message] of BAD_VALUES) {
  test(`${label} is rejected with a message that names the key`, (t) => {
    throwsImpactError(withConfig(t, content), 'qa-core-prcheck.config.json', message);
  });
}

// The optional "llm" object (PR 8). Only check reads it, with loadLlmConfig; loadConfig accepts the key
// and ignores its contents, so select never sees it.

const LLM_OFF = { provider: 'none', model: null };

test('llm: no file, or a file with no llm key, gives provider none', (t) => {
  assert.deepEqual(loadLlmConfig(newDir(t)), LLM_OFF);
  assert.deepEqual(loadLlmConfig(withConfig(t, { playwrightDir: 'demo/saucedemo' })), LLM_OFF);
});

test('llm: a full llm object is read, and loadConfig ignores it', (t) => {
  const dir = withConfig(t, { llm: { provider: 'gemini', model: 'example-model' } });
  assert.deepEqual(loadLlmConfig(dir), { provider: 'gemini', model: 'example-model' });
  assert.deepEqual(loadConfig(dir), { playwrightDir: 'demo/saucedemo', areas: [], fullSuiteOn: [], ignore: [] });
});

test('llm: provider defaults to none, and model with provider none is allowed and kept', (t) => {
  assert.deepEqual(loadLlmConfig(withConfig(t, { llm: {} })), LLM_OFF);
  assert.deepEqual(loadLlmConfig(withConfig(t, { llm: { provider: 'none', model: 'example-model' } })),
    { provider: 'none', model: 'example-model' });
  assert.deepEqual(loadLlmConfig(withConfig(t, { llm: { provider: 'openai', model: 'a.b_c:d-1' } })),
    { provider: 'openai', model: 'a.b_c:d-1' });
});

test('llm: the unknown key message now lists llm among the allowed keys', (t) => {
  throwsImpactError(withConfig(t, { nope: 1 }), 'unknown key "nope". Allowed keys: playwrightDir, areas, fullSuiteOn, ignore, llm');
});

test('llm: select (loadConfig) ignores a malformed llm block; only loadLlmConfig rejects it', (t) => {
  const dir = withConfig(t, { llm: 'anthropic' });
  assert.equal(loadConfig(dir).playwrightDir, 'demo/saucedemo');
  assert.throws(() => loadLlmConfig(dir), ImpactError);
});

const LLM_BAD = [
  ['llm as a string', { llm: 'anthropic' }, '"llm" must be a JSON object.'],
  ['llm as an array', { llm: [] }, '"llm" must be a JSON object.'],
  ['llm as null', { llm: null }, '"llm" must be a JSON object.'],
  ['an unknown llm key', { llm: { provider: 'none', apiKey: 'x' } }, 'unknown key "llm.apiKey". Allowed keys in "llm": provider, model.'],
  ['an unknown provider', { llm: { provider: 'claude', model: 'm' } }, '"llm.provider" must be one of none, anthropic, openai, gemini.'],
  ['a provider that is not a string', { llm: { provider: 1 } }, '"llm.provider" must be one of none, anthropic, openai, gemini.'],
  ['a provider without a model', { llm: { provider: 'anthropic' } }, '"llm.model" is required when "llm.provider" is anthropic.'],
  ['an empty model', { llm: { provider: 'openai', model: '' } }, '"llm.model" must be a non-empty string of letters, digits and . _ : - (at most 200 characters).'],
  ['a model with a slash', { llm: { provider: 'gemini', model: '../x' } }, '"llm.model" must be a non-empty string of letters, digits and . _ : - (at most 200 characters).'],
  ['a model with a question mark', { llm: { provider: 'gemini', model: 'm?key=x' } }, '"llm.model" must be a non-empty string of letters, digits and . _ : - (at most 200 characters).'],
  ['a model over 200 characters', { llm: { provider: 'gemini', model: 'm'.repeat(201) } }, '"llm.model" must be a non-empty string of letters, digits and . _ : - (at most 200 characters).'],
  ['a model that is a number', { llm: { provider: 'gemini', model: 4 } }, '"llm.model" must be a non-empty string of letters, digits and . _ : - (at most 200 characters).'],
  // The config comes from the pull request under check, so it may not choose which env var is sent.
  ['apiKeyEnv set to the default name', { llm: { provider: 'anthropic', model: 'm', apiKeyEnv: 'PRCHECK_LLM_API_KEY' } }, '"llm.apiKeyEnv" is not supported. The API key is read only from the env var PRCHECK_LLM_API_KEY.'],
  ['apiKeyEnv set to another name', { llm: { provider: 'openai', model: 'm', apiKeyEnv: 'MY_LLM_KEY_2' } }, '"llm.apiKeyEnv" is not supported. The API key is read only from the env var PRCHECK_LLM_API_KEY.'],
  ['apiKeyEnv GITHUB_TOKEN', { llm: { apiKeyEnv: 'GITHUB_TOKEN' } }, '"llm.apiKeyEnv" is not supported. The API key is read only from the env var PRCHECK_LLM_API_KEY.'],
  ['apiKeyEnv ACTIONS_RUNTIME_TOKEN', { llm: { apiKeyEnv: 'ACTIONS_RUNTIME_TOKEN' } }, '"llm.apiKeyEnv" is not supported. The API key is read only from the env var PRCHECK_LLM_API_KEY.'],
  ['an empty apiKeyEnv', { llm: { apiKeyEnv: '' } }, '"llm.apiKeyEnv" is not supported. The API key is read only from the env var PRCHECK_LLM_API_KEY.'],
  ['an apiKeyEnv that is not a string', { llm: { apiKeyEnv: 1 } }, '"llm.apiKeyEnv" is not supported. The API key is read only from the env var PRCHECK_LLM_API_KEY.'],
];

for (const [label, content, message] of LLM_BAD) {
  test(`llm: ${label} is rejected with "${message}"`, (t) => {
    assert.throws(() => loadLlmConfig(withConfig(t, content)), (error) => {
      assert.ok(error instanceof ImpactError, `expected ImpactError, got ${error}`);
      assert.equal(error.message, `qa-core-prcheck.config.json: ${message}`);
      return true;
    });
  });
}

test('limits: a glob with more than 8 stars is rejected', (t) => {
  throwsImpactError(withConfig(t, { ignore: ['**/**/**/**/*'] }), '"ignore" glob has more than 8 * characters');
  assert.equal(loadConfig(withConfig(t, { ignore: ['**/**/**/**'] })).ignore[0], '**/**/**/**');
});

test('a symlink config is rejected', (t) => {
  const dir = newDir(t);
  const target = path.join(dir, 'real.json');
  fs.writeFileSync(target, '{"playwrightDir":"."}');
  try {
    fs.symlinkSync(target, path.join(dir, 'qa-core-prcheck.config.json'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return;
    throw error;
  }
  throwsImpactError(dir, 'the file must be a regular file, not a symlink');
});

test('limits: too many areas, tags, globs, a long tag, a control character and a huge file are rejected', (t) => {
  const areas = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`src/${i}.ts`, ['@cart']]));
  throwsImpactError(withConfig(t, { areas }), '"areas" has more than 100 globs');
  throwsImpactError(withConfig(t, { areas: { 'src/**': Array.from({ length: 21 }, (_, i) => `@t${i}`) } }),
    '"areas" value for "src/**" has more than 20 tags');
  throwsImpactError(withConfig(t, { areas: { 'src/**': ['@'] } }),
    '"areas" tag for "src/**" must be @ followed by 1 to 63 characters and no whitespace');
  throwsImpactError(withConfig(t, { areas: { 'src/**': [`@${'a'.repeat(64)}`] } }),
    '"areas" tag for "src/**" must be @ followed by 1 to 63 characters and no whitespace');
  throwsImpactError(withConfig(t, { ignore: ['docs/**\nsecret'] }), '"ignore" glob must not contain control characters');
  throwsImpactError(withConfig(t, { fullSuiteOn: ['x'.repeat(301)] }), '"fullSuiteOn" glob is longer than 300 characters');
  throwsImpactError(withConfig(t, { ignore: Array.from({ length: 101 }, (_, i) => `f${i}.md`) }),
    '"ignore" has more than 100 globs');
  throwsImpactError(withConfig(t, { playwrightDir: 'd'.repeat(201) }),
    '"playwrightDir" must be at most 200 characters and must not contain control characters');
  const huge = withConfig(t, `{${' '.repeat(70_000)}"playwrightDir":"."}`);
  throwsImpactError(huge, 'the file is larger than 65536 bytes');
});

test('llm: loadLlmConfig keeps the file errors of loadConfig', (t) => {
  assert.throws(() => loadLlmConfig(withConfig(t, '{')), (e) => e instanceof ImpactError && e.message.startsWith('qa-core-prcheck.config.json is not valid JSON: '));
  assert.throws(() => loadLlmConfig(withConfig(t, '[]')), (e) => e.message === 'qa-core-prcheck.config.json: the top level must be a JSON object');
  assert.throws(() => loadLlmConfig(withConfig(t, { x: 1 })), (e) => e.message === 'qa-core-prcheck.config.json: unknown key "x". Allowed keys: playwrightDir, areas, fullSuiteOn, ignore, llm');
});
