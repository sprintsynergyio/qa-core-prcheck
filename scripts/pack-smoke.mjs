// Installs the packed tarball in a temp directory and runs the CLI. No publish. The pack is local.
// npm is npm.cmd on Windows. The script exits 0 only when the version, help, and timeout guard match.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function npmRun(args, cwd) {
  const ran = spawnSync(npm, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (ran.status !== 0) {
    throw new Error(`npm ${args.join(' ')} exited ${ran.status}\n${ran.stderr || ''}`);
  }
  return ran.stdout;
}

function listTarball(tarball) {
  const buf = zlib.gunzipSync(fs.readFileSync(tarball));
  const names = [];
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    let name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(header.subarray(124, 136).toString('utf8').trim(), 8) || 0;
    if (name) names.push(name);
    offset += 512 + (Math.ceil(size / 512) * 512);
  }
  return names;
}

const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prcheck-pack-'));
const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prcheck-install-'));
try {
  const packed = npmRun(['pack', '--pack-destination', packDir, '--json'], root);
  const info = JSON.parse(packed);
  const filename = Array.isArray(info) ? info[0].filename : info.filename;
  const tarball = path.join(packDir, filename);
  const tarList = listTarball(tarball);
  const forbidden = tarList.filter((name) => name.startsWith('package/tests/') || name.startsWith('package/src/') || name.startsWith('package/evals/') || name.includes('.env') || name.endsWith('action.yml'));
  if (forbidden.length > 0) throw new Error(`tarball has files it should not ship: ${forbidden.join(', ')}`);
  for (const required of ['package/dist/cli.js', 'package/README.md', 'package/CHANGELOG.md', 'package/LICENSE', 'package/docs/release-acceptance.md']) {
    if (!tarList.includes(required)) throw new Error(`tarball is missing ${required}`);
  }

  npmRun(['init', '-y'], installDir);
  npmRun(['install', tarball], installDir);
  const bin = path.join(installDir, 'node_modules', '@sprintsynergy', 'qa-core-prcheck', 'dist', 'cli.js');
  const version = execFileSync(process.execPath, [bin, '--version'], { encoding: 'utf8', windowsHide: true }).trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  if (version !== pkg) throw new Error(`packed version ${version} != ${pkg}`);
  const help = execFileSync(process.execPath, [bin, '--help'], { encoding: 'utf8', windowsHide: true });
  if (!help.includes('\n  rank            ')) throw new Error('help does not list rank');
  const bad = spawnSync(process.execPath, [bin, 'check', '--timeout-minutes', '99', '--diff-file', 'x.diff'], { encoding: 'utf8', windowsHide: true });
  if (bad.status !== 2) throw new Error(`timeout guard exited ${bad.status}`);
  if (bad.stdout !== '') throw new Error('timeout guard wrote stdout');
  if (!bad.stderr.includes('timeout-minutes')) throw new Error(bad.stderr);
  console.log(`pack smoke ok ${version}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
} finally {
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.rmSync(installDir, { recursive: true, force: true });
}
