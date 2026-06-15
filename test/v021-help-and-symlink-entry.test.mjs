// SPDX-License-Identifier: MIT
//
// v0.0.21 regression tests for the two post-v0.0.20 verification findings:
//   (1) root `stratos help` advertised cost / carbon / rules validate
//   (2) entry guard fires when stratos.mjs is invoked through a symlinked
//       directory (the macOS /tmp -> /private/tmp class of bug)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, symlinkSync, copyFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');
const run = (cliPath, args, env = {}) => spawnSync(process.execPath, [cliPath, ...args],
  { env: { ...process.env, STRATOS_CI: '0', ...env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' },
    encoding: 'utf8' });

test('v0.0.21 fix #1: root help lists cost / carbon / rules validate', () => {
  const r = run(CLI, ['help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Cost & sustainability/);
  assert.match(r.stdout, /^\s+cost\s/m);
  assert.match(r.stdout, /^\s+carbon\s/m);
  assert.match(r.stdout, /^\s+rules validate\s/m);
});

test('v0.0.21 fix #1: bare-invocation help (no args) also lists the v0.0.20 commands', () => {
  const r = run(CLI, []);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Cost & sustainability/);
  assert.match(r.stdout, /rules validate/);
});

test('v0.0.21 fix #2: entry guard fires when invoked through a symlinked directory', () => {
  // Build a sandbox with a real subdir + a sibling symlink that points to it.
  // Running node on the symlinked path is the macOS /tmp -> /private/tmp
  // scenario in miniature; pre-v0.0.21 this exited 0 with no output.
  const sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'stratos-symlink-test-'));
  try {
    const realDir = join(sandbox, 'real');
    mkdirSync(realDir);
    copyFileSync(CLI, join(realDir, 'stratos.mjs'));
    const linkDir = join(sandbox, 'link');
    symlinkSync(realDir, linkDir, 'dir');

    const r = run(join(linkDir, 'stratos.mjs'), ['version']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^stratos v\d+\.\d+\.\d+/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('v0.0.21 fix #2: entry guard also handles a symlinked file (not just dir)', () => {
  const sandbox = mkdtempSync(join(realpathSync(tmpdir()), 'stratos-symlink-test-'));
  try {
    const realFile = join(sandbox, 'real-stratos.mjs');
    copyFileSync(CLI, realFile);
    const linkFile = join(sandbox, 'link-stratos.mjs');
    symlinkSync(realFile, linkFile, 'file');

    const r = run(linkFile, ['version']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^stratos v\d+\.\d+\.\d+/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
