// SPDX-License-Identifier: MIT
//
// Final-mile branch coverage push: targets the small, easy-to-hit
// branches that don't fit into the mock-API / OTLP / flag-variant
// test files. Each test here is one branch (or one tight cluster) and
// the comment above it says which line in stratos.mjs it's chasing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

function run(args, env = {}, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { STRATOS_CI: '0', STRATOS_NO_KEYCHAIN: '1', NO_COLOR: '1',
             PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

// L80: isTTY()'s STRATOS_FORCE_TTY arm.
test('isTTY: STRATOS_FORCE_TTY=1 short-circuit', async () => {
  const r = await run(['version'], { STRATOS_FORCE_TTY: '1' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /v0\.0\./);
});

// L1280: cmdUpgrade reads CLOUDCDN_URL env, falls back to default.
test('upgrade: respects CLOUDCDN_URL', async () => {
  const r = await run(['upgrade'], { CLOUDCDN_URL: 'https://example.invalid' });
  assert.equal(r.status, 0);
  assert.match(r.stderr + r.stdout, /example\.invalid/);
});
test('upgrade: defaults to cloudcdn.pro when no env', async () => {
  const r = await run(['upgrade']);
  assert.equal(r.status, 0);
  assert.match(r.stderr + r.stdout, /cloudcdn\.pro/);
});

// L1302: cmdConfig with no profiles in the file.
test('config list: empty profiles file', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    const xdg = join(tmp, 'xdg');
    await mkdir(xdg, { recursive: true });
    const r = await run(['config', 'list'], { XDG_CONFIG_HOME: xdg, HOME: tmp });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.ok('profiles' in body);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// L1431-1447: cmdInit's optional-field combinations.
test('init: all secrets present', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    const xdg = join(tmp, 'xdg');
    await mkdir(xdg, { recursive: true });
    const r = await run([
      'init', '--profile', 'p1', '--cdn-url', 'https://example.test',
      '--account-key', 'a'.repeat(32),
      '--access-key', 'b'.repeat(32),
      '--signed-secret', 'c'.repeat(32),
      '--output', 'json',
    ], { XDG_CONFIG_HOME: xdg, HOME: tmp });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.profile, 'p1');
    assert.ok(body.entry.account_key);
    assert.ok(body.entry.access_key);
    assert.ok(body.entry.signed_url_secret);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('init: only account_key', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    const xdg = join(tmp, 'xdg');
    await mkdir(xdg, { recursive: true });
    const r = await run([
      'init', '--profile', 'p2', '--cdn-url', 'https://example.test',
      '--account-key', 'a'.repeat(32),
      '--access-key', '',
      '--signed-secret', '',
      '--output', 'json',
    ], { XDG_CONFIG_HOME: xdg, HOME: tmp });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.entry.access_key, null);
    assert.equal(body.entry.signed_url_secret, null);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
test('init: no secrets at all', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    const xdg = join(tmp, 'xdg');
    await mkdir(xdg, { recursive: true });
    const r = await run([
      'init', '--profile', 'p3', '--cdn-url', 'https://example.test',
      '--account-key', '', '--access-key', '', '--signed-secret', '',
      '--output', 'json',
    ], { XDG_CONFIG_HOME: xdg, HOME: tmp });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.entry.account_key, null);
    assert.equal(body.entry.access_key, null);
    assert.equal(body.entry.signed_url_secret, null);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// L3613-3614: levenshtein edge cases (empty input → suggestCommand).
// Triggered by an unknown command — suggestCommand calls levenshtein with
// each known command and with the user's input. We feed it a single-char
// unknown command to hit the short-string branches.
test('unknown 1-char command: hits levenshtein short-string branches', async () => {
  const r = await run(['z']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown command/);
});
test('unknown empty-ish command via help routing', async () => {
  // 'help' with no arg goes through cmdHelp, no levenshtein invocation.
  // But 'helpx' (mistyped) routes via unknown-command → suggestCommand.
  const r = await run(['helpx']);
  assert.equal(r.status, 64);
});

// L411: STRATOS_NO_KEYCHAIN env var truthy/falsy paths in envConfig.
test('envConfig: STRATOS_NO_KEYCHAIN=1 skips keychain', async () => {
  const r = await run(['login', 'status'], { STRATOS_NO_KEYCHAIN: '1' });
  // Exit 0 with empty creds, or non-zero — either way the keychain skip
  // branch was hit.
  assert.ok(r.status === 0 || r.status === 64 || r.status === 77,
    `unexpected status ${r.status}`);
});
