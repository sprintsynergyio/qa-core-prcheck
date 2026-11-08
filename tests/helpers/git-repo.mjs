import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Temporary git repos for tests. Not a test file: node --test runs tests/*.test.mjs only.
 * Every git call runs with its cwd inside os.tmpdir() and the isolated environment below,
 * so nothing here can touch this repo.
 */

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const PREFIX = 'prcheck-';
// Git for Windows cannot use os.devNull (\\.\nul) as GIT_CONFIG_GLOBAL: init fails with
// "unable to access '\\.\nul'". An empty file is a config that adds nothing on every OS.
const EMPTY_GIT_CONFIG = path.join(TMP_ROOT, 'prcheck-empty-gitconfig');
if (!fs.existsSync(EMPTY_GIT_CONFIG)) fs.writeFileSync(EMPTY_GIT_CONFIG, '');

const insideTmp = (dir) => dir === TMP_ROOT || dir.startsWith(TMP_ROOT + path.sep);

/** process.env plus a fixed identity and no global or system git config. */
export function gitEnv() {
  return {
    ...process.env,
    // Cleared so an outer git (for example a hook that runs npm test) cannot send these commands to another repo.
    // Node leaves undefined values out of the child environment.
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
    GIT_CONFIG_SYSTEM: EMPTY_GIT_CONFIG,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

/** Runs git in a folder under os.tmpdir() with an argument array and returns trimmed stdout. */
export function runGit(cwd, ...args) {
  if (!insideTmp(cwd)) throw new Error(`Refusing to run git outside the temp folder: ${cwd}`);
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(TMP_ROOT, PREFIX));
}

/** A new repo on branch main with a local config that does not depend on the machine. */
export function createTempRepo() {
  const dir = makeTempDir();
  const git = (...args) => runGit(dir, ...args);
  try {
    git('init', '-q');
    git('symbolic-ref', 'HEAD', 'refs/heads/main');
    git('config', 'core.autocrlf', 'false');
    git('config', 'commit.gpgsign', 'false');
  } catch (error) {
    cleanup(dir);
    throw error;
  }
  return {
    dir,
    env: gitEnv(),
    git,
    write(relPath, content) {
      const file = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    },
    remove(relPath) {
      fs.rmSync(path.join(dir, relPath));
    },
    /** Stages everything, commits and returns the new commit sha. */
    commitAll(message) {
      git('add', '-A');
      git('commit', '-q', '-m', message);
      return git('rev-parse', 'HEAD');
    },
  };
}

/** A depth 1 clone of every branch of sourceDir, in a new temp folder. */
export function makeShallowClone(sourceDir) {
  const dir = makeTempDir();
  runGit(TMP_ROOT, 'clone', '--depth', '1', '--no-single-branch', pathToFileURL(sourceDir).href, dir);
  return dir;
}

export function cleanup(dir) {
  if (!insideTmp(dir) || dir === TMP_ROOT) throw new Error(`Refusing to delete outside the temp folder: ${dir}`);
  // Windows refuses to delete a directory that is still the cwd, and a file can stay locked briefly.
  try {
    if (process.cwd().toLowerCase().startsWith(dir.toLowerCase())) process.chdir(TMP_ROOT);
  } catch {
    // The cwd may already have been removed.
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
