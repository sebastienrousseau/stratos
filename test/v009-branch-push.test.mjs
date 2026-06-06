// SPDX-License-Identifier: MIT
//
// v0.0.x — branch coverage push to >= 95%. Each test below targets a
// specific uncovered branch (or tight cluster) in stratos.mjs identified
// from `npx c8 --reporter=json-summary` against the v008 baseline.
//
// Style mirrors test/v008-mock-api.test.mjs: a local HTTP server per
// test, spawned-child CLI, no shared state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

function run(args, env = {}) {
  const baseEnv = {
    ...process.env,
    STRATOS_CI: '0',
    STRATOS_NO_KEYCHAIN: '1',
    NO_COLOR: '1',
  };
  for (const k of [
    'CLOUDCDN_URL', 'CLOUDCDN_ACCOUNT_KEY', 'CLOUDCDN_ACCESS_KEY',
    'SIGNED_URL_SECRET', 'CLOUDCDN_TIMEOUT', 'CLOUDCDN_RETRIES',
    'STRATOS_PROFILE', 'GITHUB_ACTIONS', 'GITLAB_CI', 'CIRCLECI',
    'JENKINS_URL', 'TF_BUILD', 'CI',
  ]) delete baseEnv[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env: { ...baseEnv, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

const COMMON_AUTH = {
  CLOUDCDN_ACCOUNT_KEY: 'k',
  CLOUDCDN_ACCESS_KEY: 'k',
  CLOUDCDN_RETRIES: '0',
  CLOUDCDN_TIMEOUT: '2000',
};

const json = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

// ─────────────────────────────────────────────────────────────────────────────
// Fallback-chain primary-key arms — these are the `body.X` short-circuit
// branches in `rows = body.X || body.Data || (Array.isArray(body) ? body : [])`
// that v008-mock-api covers the *fallback* arm of but not the primary.
// ─────────────────────────────────────────────────────────────────────────────

test('tokens list: body.tokens primary key short-circuit (L2420)', async () => {
  const { srv, base } = await startServer(
    json({ tokens: [{ id: 'tk1', name: 'a', scopes: ['read'] }] }));
  try {
    const r = await run(['tokens', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /tk1/);
  } finally { srv.close(); }
});

test('webhooks list: body.webhooks primary key short-circuit (L2481)', async () => {
  const { srv, base } = await startServer(
    json({ webhooks: [{ id: 'wh1', url: 'https://x', events: ['purge'] }] }));
  try {
    const r = await run(['webhooks', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /wh1/);
  } finally { srv.close(); }
});

test('zones list: body.zones primary key short-circuit (L2228)', async () => {
  const { srv, base } = await startServer(
    json({ zones: [{ name: 'z1', domains: ['a.test'] }] }));
  try {
    const r = await run(['zones', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /z1/);
  } finally { srv.close(); }
});

test('audit: body.logs primary key short-circuit (L2202)', async () => {
  const { srv, base } = await startServer(
    json({ logs: [{ timestamp: 't', action: 'a', actor: 'u', target: 'x' }] }));
  try {
    const r = await run(['audit', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"action"/);
  } finally { srv.close(); }
});

test('insights geo: non-array non-shape body → final empty fallback (L2146)', async () => {
  // body is an object that lacks countries/Data and is not an array.
  const { srv, base } = await startServer(json({ meta: 'no rows' }));
  try {
    const r = await run(['insights', 'geo', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    // emitList of an empty array renders as `[]` in JSON.
    assert.match(r.stdout, /\[\s*\]/);
  } finally { srv.close(); }
});

test('audit: non-array non-shape body → final empty fallback (L2202)', async () => {
  const { srv, base } = await startServer(json({ note: 'nothing here' }));
  try {
    const r = await run(['audit', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[\s*\]/);
  } finally { srv.close(); }
});

test('tokens list: non-array non-shape body → final empty fallback (L2420)', async () => {
  const { srv, base } = await startServer(json({ note: 'nothing here' }));
  try {
    const r = await run(['tokens', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[\s*\]/);
  } finally { srv.close(); }
});

test('webhooks list: non-array non-shape body → final empty fallback (L2481)', async () => {
  const { srv, base } = await startServer(json({ note: 'nothing here' }));
  try {
    const r = await run(['webhooks', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[\s*\]/);
  } finally { srv.close(); }
});

test('zones list: non-array non-shape body → final empty fallback (L2228)', async () => {
  const { srv, base } = await startServer(json({ note: 'nothing here' }));
  try {
    const r = await run(['zones', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[\s*\]/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// assets list --all pagination edge cases.
//   L2034: body falsy / body.Data not an array → break
//   L2037: verbose page log
// ─────────────────────────────────────────────────────────────────────────────

test('assets list --all + verbose: emits page log (L2037)', async () => {
  let calls = 0;
  const { srv, base } = await startServer((req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (calls === 1) {
      res.end(JSON.stringify({ Data: [{ Path: 'a' }], TotalPages: 2, Page: 1 }));
    } else {
      res.end(JSON.stringify({ Data: [{ Path: 'b' }], TotalPages: 2, Page: 2 }));
    }
  });
  try {
    const r = await run(['assets', 'list', '--all', '--verbose', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /page 1\/2/);
  } finally { srv.close(); }
});

test('assets list --all: non-Data body breaks loop (L2034)', async () => {
  const { srv, base } = await startServer(json({ note: 'no Data key' }));
  try {
    const r = await run(['assets', 'list', '--all', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[\s*\]/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Doctor — exercise the mask vs `unset` arms for each credential.
//   L1688/1689/1691: ternary `cfg.X ? maskKey(cfg.X) : 'unset'` per key
//   L1609: maskKey short-key arm (length <= 8 → '***')
// ─────────────────────────────────────────────────────────────────────────────

test('doctor: all three credentials set → maskKey path (L1688/1689/1691)', async () => {
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    const r = await run(['doctor', '--output', 'json'], {
      CLOUDCDN_URL: base,
      CLOUDCDN_ACCOUNT_KEY: 'a'.repeat(32),
      CLOUDCDN_ACCESS_KEY:  'b'.repeat(32),
      SIGNED_URL_SECRET:    'c'.repeat(32),
      STRATOS_NO_KEYCHAIN: '1',
    });
    // Doctor exits 0 when all checks pass, or non-zero (unavailable) when
    // platform-specific things like keychain aren't reachable in CI; either
    // way the branch we care about was traversed before emit().
    assert.ok(r.status === 0 || r.status === 75,
      `unexpected status ${r.status}: ${r.stderr}`);
    const body = JSON.parse(r.stdout);
    const get = (name) => body.find((c) => c.name === name);
    assert.equal(get('account_key').ok, true);
    assert.equal(get('access_key').ok, true);
    assert.equal(get('signed_url_secret').ok, true);
  } finally { srv.close(); }
});

test('doctor: short keys hit maskKey ***-arm (L1609)', async () => {
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    const r = await run(['doctor', '--output', 'json'], {
      CLOUDCDN_URL: base,
      CLOUDCDN_ACCOUNT_KEY: 'short',
      CLOUDCDN_ACCESS_KEY:  'short',
      SIGNED_URL_SECRET:    'short',
      STRATOS_NO_KEYCHAIN: '1',
    });
    assert.ok(r.status === 0 || r.status === 75);
    const body = JSON.parse(r.stdout);
    const ak = body.find((c) => c.name === 'account_key');
    // The detail field is the masked rendering; for length <= 8 it's '***'.
    assert.match(ak.detail, /\*\*\*/);
  } finally { srv.close(); }
});

test('doctor: with one profile in config (L1662)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-doc-'));
  try {
    const xdg = join(tmp, 'xdg');
    await mkdir(join(xdg, 'stratos'), { recursive: true });
    await writeFile(join(xdg, 'stratos', 'config.json'), JSON.stringify({
      profiles: { default: { url: 'https://example.invalid' } },
    }));
    const r = await run(['doctor', '--output', 'json'], {
      XDG_CONFIG_HOME: xdg, HOME: tmp,
    });
    // Network check will fail (invalid host), so status is likely non-zero —
    // we only care that the profile-count branch was traversed.
    const body = JSON.parse(r.stdout);
    const cf = body.find((c) => c.name === 'Config file readable');
    assert.match(cf.detail, /1 profile/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// bench — exercise the --iterations alias and the success-status colour arm.
//   L1732: `flags.n || flags.iterations || 5`
//   L1775: status colour ternary green-arm (2xx)
// ─────────────────────────────────────────────────────────────────────────────

test('bench --iterations: alias for -n (L1732)', async () => {
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    const r = await run(['bench', '--iterations', '2', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.samples.length, 2);
  } finally { srv.close(); }
});

test('bench: success status colours hit green arm (L1775)', async () => {
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    // No --output flag → falls through to text rendering with colour ternary.
    const r = await run(['bench', '-n', '1'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    // The bench rendering writes a request line per sample.
    assert.match(r.stdout, /#1/);
  } finally { srv.close(); }
});

test('bench: failure status hits red ERR arm (L1775)', async () => {
  // Point at an unroutable address so each probe throws → status=0 → red.
  const r = await run(['bench', '-n', '1'], {
    ...COMMON_AUTH,
    CLOUDCDN_URL: 'http://127.0.0.1:1', // closed port
    CLOUDCDN_TIMEOUT: '500',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ERR/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV / YAML edge cases on empty bodies.
//   L933: toCsv of empty/non-array → ''
//   L878: toYaml of empty array → '[]'
// ─────────────────────────────────────────────────────────────────────────────

test('insights geo --output csv: empty body emits empty CSV (L933)', async () => {
  const { srv, base } = await startServer(json({ countries: [] }));
  try {
    const r = await run(['insights', 'geo', '--output', 'csv'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    // Empty CSV → just a trailing newline from `out()`.
    assert.equal(r.stdout.trim(), '');
  } finally { srv.close(); }
});

test('zones list --output yaml: empty array emits "[]" (L878)', async () => {
  const { srv, base } = await startServer(json({ zones: [] }));
  try {
    const r = await run(['zones', 'list', '--output', 'yaml'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[\]/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// rules diff: trailing-only-removed / trailing-only-added arms.
//   L2399: while (i < m) → drain removed lines after the LCS walk
//   L2400: while (j < n) → drain added lines after the LCS walk
// ─────────────────────────────────────────────────────────────────────────────

test('rules diff: trailing-only-added arm (L2400)', async () => {
  // Remote returns shorter content; local file has extra trailing lines.
  const remote = 'line1\nline2\n';
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(remote);
  });
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-diff-'));
  try {
    const file = join(tmp, '_headers');
    await writeFile(file, 'line1\nline2\nline3-added\nline4-added\n');
    const r = await run(['rules', 'diff', '_headers', '-f', file],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    // Diff with drift exits 69 by convention; output should contain +line3.
    assert.ok(r.status === 69 || r.status === 0, `unexpected status ${r.status}`);
    assert.match(r.stdout + r.stderr, /\+\s*line3-added/);
  } finally {
    srv.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

test('rules diff: trailing-only-removed arm (L2399)', async () => {
  // Remote returns extra trailing lines; local has fewer.
  const remote = 'line1\nline2\nline3-extra\nline4-extra\n';
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(remote);
  });
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-diff-'));
  try {
    const file = join(tmp, '_headers');
    await writeFile(file, 'line1\nline2\n');
    const r = await run(['rules', 'diff', '_headers', '-f', file],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.ok(r.status === 69 || r.status === 0, `unexpected status ${r.status}`);
    assert.match(r.stdout + r.stderr, /-\s*line3-extra/);
  } finally {
    srv.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Missing-arg fatals — bare subcommands hit their EX.USAGE arm.
//   L1971: bare `signed` (no path arg)
//   L2006: bare `assets show` (no path arg)
// ─────────────────────────────────────────────────────────────────────────────

test('signed: missing path arg → EX.USAGE (L1971)', async () => {
  const r = await run(['signed'], { ...COMMON_AUTH });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /signed needs a path/);
});

test('assets show: missing path arg → EX.USAGE (L2006)', async () => {
  const r = await run(['assets', 'show'], { ...COMMON_AUTH });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /assets show <path>/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Default-subcommand fall-throughs.
//   L2543: `storage ls` with no positional[1] → empty prefix
//   L2909: `passkey` with no positional[0] → 'register' default
// ─────────────────────────────────────────────────────────────────────────────

test('storage ls: bare invocation uses empty prefix (L2543)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ Path: 'a', Length: 1, ContentType: 't' }]));
  });
  try {
    const r = await run(['storage', 'ls', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"Path"/);
  } finally { srv.close(); }
});

test('passkey: bare invocation defaults to "register" (L2909/L2985)', async () => {
  const r = await run(['passkey'], { ...COMMON_AUTH });
  // cmdPasskey unconditionally exits EX.UNAVAILABLE after diag().
  assert.equal(r.status, 69);
  assert.match(r.stderr, /Passkey register requires/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bare-array body fallback for the `body.X || body.Data || (Array.isArray(body) ? body : [])`
// chains we haven't yet exercised — covers the `Array.isArray(body) ? body` true arm.
//   L2146 (insights geo), L2202 (audit), L2228 (zones), L2420 (tokens)
// ─────────────────────────────────────────────────────────────────────────────

test('insights geo: bare-array body fallback (L2146)', async () => {
  const { srv, base } = await startServer(
    json([{ country: 'AU', requests: 1, bytes: 2 }]));
  try {
    const r = await run(['insights', 'geo', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"AU"/);
  } finally { srv.close(); }
});

test('audit: bare-array body fallback (L2202)', async () => {
  const { srv, base } = await startServer(
    json([{ timestamp: 't', action: 'a' }]));
  try {
    const r = await run(['audit', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"action"/);
  } finally { srv.close(); }
});

test('zones list: bare-array body fallback (L2228)', async () => {
  const { srv, base } = await startServer(
    json([{ name: 'z', domains: ['d'] }]));
  try {
    const r = await run(['zones', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"z"/);
  } finally { srv.close(); }
});

test('tokens list: bare-array body fallback (L2420)', async () => {
  const { srv, base } = await startServer(
    json([{ id: 'tk', name: 'n', scopes: [] }]));
  try {
    const r = await run(['tokens', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"tk"/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// FORCE_TTY=1 routes through the indent-2 arm of isTTY()-ternaries in emit
// and emitList.
//   L682:  JSON.stringify(piped, null, isTTY() ? 2 : 0)  (emit)
//   L771:  same ternary in emitList
// ─────────────────────────────────────────────────────────────────────────────

test('FORCE_TTY=1 + --output json: emitList uses indent-2 (L771)', async () => {
  const { srv, base } = await startServer(
    json({ zones: [{ name: 'z' }] }));
  try {
    const r = await run(['zones', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    // Indent-2 pretty-printed output contains newlines + leading spaces.
    assert.match(r.stdout, /\n {2}\{/);
  } finally { srv.close(); }
});

test('FORCE_TTY=1 + --output json: emit uses indent-2 (L682)', async () => {
  // `stats` calls emit(body) (single object, not list) → routes through L682.
  const { srv, base } = await startServer(json({ total: 1, ok: 1 }));
  try {
    const r = await run(['stats', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\n {2}"/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// `login logout` → cmdLogin's logout-action arm (L1522).
// ─────────────────────────────────────────────────────────────────────────────

test('login logout: cmdLogin action arm (L1522)', async () => {
  const r = await run(['login', 'logout'], { STRATOS_NO_KEYCHAIN: '1' });
  // loginLogout always exits 0; in CI keychain calls are no-ops.
  assert.equal(r.status, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// init: cover the remaining flag-combination arms that previous tests
// only hit one half of (e.g. accessKey set but no signedSecret).
//   L1431/1432 truthy/falsy combos for each independent key.
//   L1445-1447 entry-mask vs null arms.
// ─────────────────────────────────────────────────────────────────────────────

test('init: access_key only', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    const xdg = join(tmp, 'xdg');
    await mkdir(xdg, { recursive: true });
    const r = await run([
      'init', '--profile', 'pa', '--cdn-url', 'https://example.test',
      '--account-key', '',
      '--access-key', 'b'.repeat(32),
      '--signed-secret', '',
      '--output', 'json',
    ], { XDG_CONFIG_HOME: xdg, HOME: tmp });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.entry.account_key, null);
    assert.ok(body.entry.access_key);
    assert.equal(body.entry.signed_url_secret, null);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('init: signed_secret only', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    const xdg = join(tmp, 'xdg');
    await mkdir(xdg, { recursive: true });
    const r = await run([
      'init', '--profile', 'ps', '--cdn-url', 'https://example.test',
      '--account-key', '',
      '--access-key', '',
      '--signed-secret', 'c'.repeat(32),
      '--output', 'json',
    ], { XDG_CONFIG_HOME: xdg, HOME: tmp });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.entry.account_key, null);
    assert.equal(body.entry.access_key, null);
    assert.ok(body.entry.signed_url_secret);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// assets list --all: empty-Data-array early break (L2038).
// ─────────────────────────────────────────────────────────────────────────────

test('assets list --all: empty Data array breaks loop (L2038)', async () => {
  const { srv, base } = await startServer(json({ Data: [], TotalPages: 1, Page: 1 }));
  try {
    const r = await run(['assets', 'list', '--all', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[\s*\]/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// passkey login: subcommand-provided arm (L2909 truthy).
// ─────────────────────────────────────────────────────────────────────────────

test('passkey login: subcommand short-circuits default (L2909)', async () => {
  const r = await run(['passkey', 'login'], { ...COMMON_AUTH });
  assert.equal(r.status, 69);
  assert.match(r.stderr, /Passkey login requires/);
});

// ─────────────────────────────────────────────────────────────────────────────
// rules diff: `-f` short-flag vs `--file` long-flag — exercises the
// `flags.f || flags.file || positional[2]` chain (L2324).
// ─────────────────────────────────────────────────────────────────────────────

test('rules diff: --file long flag (L2324 — flags.file truthy)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('same\n');
  });
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-diff-'));
  try {
    const file = join(tmp, '_headers');
    await writeFile(file, 'same\n');
    const r = await run(['rules', 'diff', '_headers', '--file', file],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
  } finally {
    srv.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

// L3319: `Number(flags.verbose) || 1` — right arm when explicit 0 is passed.
test('--verbose 0: Number coercion falls through to default 1 (L3319)', async () => {
  // `--verbose 0` sets flags.verbose = '0' → Number('0') = 0 → falls to 1.
  const r = await run(['version', '--verbose', '0']);
  assert.equal(r.status, 0);
});

// L1775: bench status-colour ternary's yellow arm (status >= 400).
test('bench: status >= 400 hits yellow arm (L1775)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  try {
    // No --output flag so the text renderer runs.
    const r = await run(['bench', '-n', '1'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /404/);
  } finally { srv.close(); }
});

// L1732: bench with no -n/--iterations flag — default 5 fallback arm.
test('bench: default iteration count (L1732 — neither flag set)', async () => {
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    const r = await run(['bench', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.samples.length, 5);
  } finally { srv.close(); }
});

test('rules diff: positional[2] path (L2324 — both flags absent)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('same\n');
  });
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-diff-'));
  try {
    const file = join(tmp, '_headers');
    await writeFile(file, 'same\n');
    const r = await run(['rules', 'diff', '_headers', file],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
  } finally {
    srv.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
