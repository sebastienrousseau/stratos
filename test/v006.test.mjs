// SPDX-License-Identifier: MIT
//
// Tests for v0.0.6: papercut fixes (explain --output yaml, doctor/bench
// --output yaml, init --output yaml) and the new make-winget / make-scoop
// generators + the composite GH Action shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, 'stratos.mjs');

function runClean(args, env = {}, opts = {}) {
  const baseEnv = { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' };
  for (const k of [
    'CLOUDCDN_URL','CLOUDCDN_ACCOUNT_KEY','CLOUDCDN_ACCESS_KEY','SIGNED_URL_SECRET',
    'CLOUDCDN_TIMEOUT','CLOUDCDN_RETRIES','STRATOS_PROFILE',
    'GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','JENKINS_URL','TF_BUILD','CI',
    'OTEL_EXPORTER_OTLP_ENDPOINT','OTEL_EXPORTER_OTLP_TRACES_ENDPOINT','OTEL_EXPORTER_OTLP_HEADERS',
  ]) delete baseEnv[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env: { ...baseEnv, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ stdout, stderr, status: code }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Papercut: explain --output <fmt> now routes through emit.
// ─────────────────────────────────────────────────────────────────────────────

test('explain --output yaml: emits YAML instead of text', async () => {
  const r = await runClean(['explain', '77', '--output', 'yaml']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^code: "77"/m);
  assert.match(r.stdout, /^name: EX_NOPERM/m);
  assert.match(r.stdout, /^fix:/m);
});

test('explain --output csv: header + single row', async () => {
  const r = await runClean(['explain', '64', '--output', 'csv']);
  assert.equal(r.status, 0);
  // CSV header includes the entry keys.
  assert.match(r.stdout, /code/);
  assert.match(r.stdout, /EX_USAGE/);
});

test('explain default (no --output, no --json): rich text mode unchanged', async () => {
  const r = await runClean(['explain', 'EX_TEMPFAIL']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /EX_TEMPFAIL/);
  assert.match(r.stdout, /Cause/);
  assert.match(r.stdout, /Fix/);
  // Not YAML (no leading "code: " key/value line).
  assert.doesNotMatch(r.stdout, /^code:/m);
});

test('doctor --output yaml: passes through emit() in YAML mode', async () => {
  // Hit an unreachable endpoint so the doctor exits 69, but assert on stdout shape.
  const r = await runClean(['doctor', '--output', 'yaml'],
    { CLOUDCDN_URL: 'http://127.0.0.1:1', CLOUDCDN_RETRIES: '0', CLOUDCDN_TIMEOUT: '500' });
  // Doctor exits 69 when any check fails; we only care that stdout is YAML.
  assert.match(r.stdout, /^-/m);  // first list entry
  assert.match(r.stdout, /name:/);
  assert.match(r.stdout, /ok:/);
});

test('bench --output yaml: summary block + samples list as YAML', async () => {
  const r = await runClean(['bench', '-n', '1', '--output', 'yaml'],
    { CLOUDCDN_URL: 'http://127.0.0.1:1', CLOUDCDN_TIMEOUT: '500', CLOUDCDN_RETRIES: '0' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^samples:/m);
  assert.match(r.stdout, /^summary:/m);
});

test('init --output yaml: emits masked profile in YAML', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-y-'));
  try {
    const r = await runClean(
      ['init', '--profile=ci', '--cdn-url=https://x', '--account-key=cdnsk_xxx_abc', '--output', 'yaml'],
      { XDG_CONFIG_HOME: tmp });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^profile: ci/m);
    assert.match(r.stdout, /^entry:/m);
    // Secret value is masked.
    assert.doesNotMatch(r.stdout, /cdnsk_xxx_abc/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// scripts/make-winget.mjs + make-scoop.mjs
// ─────────────────────────────────────────────────────────────────────────────

test('make-winget: writes three manifests under dist/winget/', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath,
      [join(REPO, 'scripts', 'make-winget.mjs'), '0.0.6'],
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO });
    let stdout = '';
    child.stdout.on('data', (d) => stdout += d);
    child.on('close', (code) => resolve({ stdout, code }));
  });
  assert.equal(r.code, 0);
  // The three manifest files now exist.
  for (const f of ['CloudCDN.Stratos.installer.yaml', 'CloudCDN.Stratos.locale.en-US.yaml', 'CloudCDN.Stratos.yaml']) {
    await access(join(REPO, 'dist', 'winget', f));
  }
  // Installer manifest has the expected URL pattern.
  const installer = await readFile(join(REPO, 'dist', 'winget', 'CloudCDN.Stratos.installer.yaml'), 'utf8');
  assert.match(installer, /PackageIdentifier: CloudCDN\.Stratos/);
  assert.match(installer, /PackageVersion: 0\.0\.6/);
  assert.match(installer, /stratos-win-x64\.exe/);
});

test('make-scoop: emits a valid-looking Scoop JSON manifest', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath,
      [join(REPO, 'scripts', 'make-scoop.mjs'), '0.0.6'],
      { stdio: ['ignore', 'pipe', 'pipe'], cwd: REPO });
    let stdout = '';
    child.stdout.on('data', (d) => stdout += d);
    child.on('close', (code) => resolve({ stdout, code }));
  });
  assert.equal(r.code, 0);
  const manifest = JSON.parse(await readFile(join(REPO, 'dist', 'stratos.scoop.json'), 'utf8'));
  assert.equal(manifest.version, '0.0.6');
  assert.equal(manifest.license, 'MIT');
  assert.ok(manifest.architecture['64bit'].url.includes('stratos-win-x64.exe'));
  assert.equal(manifest.architecture['64bit'].bin, 'stratos.exe');
});

// ─────────────────────────────────────────────────────────────────────────────
// actions/stratos/action.yml: shape check (composite action present + sane).
// ─────────────────────────────────────────────────────────────────────────────

test('composite action: action.yml exists with correct shape', async () => {
  const path = join(REPO, 'actions', 'stratos', 'action.yml');
  await access(path);
  const yaml = await readFile(path, 'utf8');
  assert.match(yaml, /name: stratos/);
  assert.match(yaml, /^description:/m);
  assert.match(yaml, /^runs:/m);
  assert.match(yaml, /using: composite/);
  assert.match(yaml, /command:/);
  assert.match(yaml, /version:/);
  assert.match(yaml, /output:/);
  // The five supported binary asset names.
  for (const asset of [
    'stratos-linux-x64', 'stratos-linux-arm64',
    'stratos-darwin-x64', 'stratos-darwin-arm64',
    'stratos-win-x64.exe',
  ]) {
    assert.ok(yaml.includes(asset), `action.yml should mention ${asset}`);
  }
});

test('composite action: README documents the inputs and outputs', async () => {
  const readme = await readFile(join(REPO, 'actions', 'stratos', 'README.md'), 'utf8');
  assert.match(readme, /## Quick start/);
  assert.match(readme, /## Inputs/);
  assert.match(readme, /## Outputs/);
  assert.match(readme, /CLOUDCDN_ACCOUNT_KEY/);
});
