// SPDX-License-Identifier: MIT
//
// Tests for v0.0.7: --bin-dir mode on make-winget / make-scoop, fall-through
// to the placeholder when no binary is found, and that the release.yml
// `manifests` job depends on `binaries` (so it actually runs after the
// hashes are knowable).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

function runScript(name, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO, 'scripts', name), ...args],
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// --bin-dir mode lifts the SHA from the actual binaries.
// ─────────────────────────────────────────────────────────────────────────────

test('make-winget --bin-dir: real SHA flows through', async () => {
  let tmpBin, tmpDist;
  try {
    tmpBin  = await mkdtemp(join(tmpdir(), 'stratos-winget-bin-'));
    tmpDist = await mkdtemp(join(tmpdir(), 'stratos-winget-dist-'));
    const payload = Buffer.from('winget smoke payload', 'utf8');
    await writeFile(join(tmpBin, 'stratos-win-x64.exe'), payload);
    const expectedSha = createHash('sha256').update(payload).digest('hex').toUpperCase();

    const r = await runScript('make-winget.mjs',
      ['0.0.7', '--bin-dir', tmpBin, '--dist-dir', tmpDist]);
    assert.equal(r.code, 0);
    const installer = await readFile(
      join(tmpDist, 'winget', 'CloudCDN.Stratos.installer.yaml'), 'utf8');
    assert.match(installer, new RegExp(`InstallerSha256: ${expectedSha}`));
    assert.doesNotMatch(installer, /REPLACE_WITH_SHA256/);
  } finally {
    if (tmpBin)  await rm(tmpBin,  { recursive: true, force: true });
    if (tmpDist) await rm(tmpDist, { recursive: true, force: true });
  }
});

test('make-scoop --bin-dir: real SHA flows through', async () => {
  let tmpBin, tmpDist;
  try {
    tmpBin  = await mkdtemp(join(tmpdir(), 'stratos-scoop-bin-'));
    tmpDist = await mkdtemp(join(tmpdir(), 'stratos-scoop-dist-'));
    const payload = Buffer.from('scoop smoke payload', 'utf8');
    await writeFile(join(tmpBin, 'stratos-win-x64.exe'), payload);
    const expectedSha = createHash('sha256').update(payload).digest('hex');

    const r = await runScript('make-scoop.mjs',
      ['0.0.7', '--bin-dir', tmpBin, '--dist-dir', tmpDist]);
    assert.equal(r.code, 0);
    const manifest = JSON.parse(await readFile(
      join(tmpDist, 'stratos.scoop.json'), 'utf8'));
    assert.equal(manifest.architecture['64bit'].hash, expectedSha);
    assert.notEqual(manifest.architecture['64bit'].hash, 'REPLACE_WITH_SHA256');
  } finally {
    if (tmpBin)  await rm(tmpBin,  { recursive: true, force: true });
    if (tmpDist) await rm(tmpDist, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pre-binaries pass still produces a usable file with the placeholder.
// ─────────────────────────────────────────────────────────────────────────────

test('make-winget without --bin-dir: placeholder preserved', async () => {
  let tmpBin, tmpDist;
  try {
    tmpBin  = await mkdtemp(join(tmpdir(), 'stratos-winget-noop-bin-'));
    tmpDist = await mkdtemp(join(tmpdir(), 'stratos-winget-noop-dist-'));
    // Point at an empty bin dir so the binary lookup falls through.
    const r = await runScript('make-winget.mjs',
      ['0.0.7', '--bin-dir', tmpBin, '--dist-dir', tmpDist]);
    assert.equal(r.code, 0);
    const installer = await readFile(
      join(tmpDist, 'winget', 'CloudCDN.Stratos.installer.yaml'), 'utf8');
    assert.match(installer, /InstallerSha256: REPLACE_WITH_SHA256/);
  } finally {
    if (tmpBin)  await rm(tmpBin,  { recursive: true, force: true });
    if (tmpDist) await rm(tmpDist, { recursive: true, force: true });
  }
});

test('make-scoop without --bin-dir: placeholder preserved', async () => {
  let tmpBin, tmpDist;
  try {
    tmpBin  = await mkdtemp(join(tmpdir(), 'stratos-scoop-noop-bin-'));
    tmpDist = await mkdtemp(join(tmpdir(), 'stratos-scoop-noop-dist-'));
    const r = await runScript('make-scoop.mjs',
      ['0.0.7', '--bin-dir', tmpBin, '--dist-dir', tmpDist]);
    assert.equal(r.code, 0);
    const manifest = JSON.parse(await readFile(
      join(tmpDist, 'stratos.scoop.json'), 'utf8'));
    assert.equal(manifest.architecture['64bit'].hash, 'REPLACE_WITH_SHA256');
  } finally {
    if (tmpBin)  await rm(tmpBin,  { recursive: true, force: true });
    if (tmpDist) await rm(tmpDist, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// release.yml shape: macos-13 dropped, manifests job present + depends on
// binaries, hashes (SLSA L3) depends on manifests.
// ─────────────────────────────────────────────────────────────────────────────

test('release.yml: macos-13 no longer in the binaries matrix', async () => {
  const yaml = await readFile(
    join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.doesNotMatch(yaml, /runner: macos-13/);
  // darwin-x64 is still built — just on ubuntu now.
  assert.match(yaml, /target: darwin-x64/);
});

test('release.yml: manifests job exists + depends on binaries', async () => {
  const yaml = await readFile(
    join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(yaml, /^\s*manifests:/m);
  assert.match(yaml, /needs:\s*\[publish,\s*binaries\]/);
  // hashes (SLSA upstream) now waits on manifests too, so the SLSA L3
  // attestation covers the patched manifests, not the placeholder ones.
  assert.match(yaml, /needs:\s*\[publish,\s*binaries,\s*docker,\s*manifests\]/);
});

test('release.yml: manifests step actually runs make-{winget,scoop} with --bin-dir', async () => {
  const yaml = await readFile(
    join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(yaml, /make-winget\.mjs[\s\S]*?--bin-dir/);
  assert.match(yaml, /make-scoop\.mjs[\s\S]*?--bin-dir/);
});

test('release.yml: a guard fails the job if placeholders remain after patching', async () => {
  const yaml = await readFile(
    join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  // grep `REPLACE_WITH_SHA256` then exit 1 if found, in both the winget
  // and scoop regeneration steps.
  const guardCount = (yaml.match(/grep -F 'REPLACE_WITH_SHA256'/g) || []).length;
  assert.ok(guardCount >= 2, `expected ≥ 2 placeholder guards, found ${guardCount}`);
});
