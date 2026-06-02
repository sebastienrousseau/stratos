// SPDX-License-Identifier: MIT
//
// v0.0.8 — branch-coverage tests that drive every command's "remote
// returned 4xx" arm against a local mock HTTP server, plus a handful of
// success-path response-shape variants that exercise the three-way
// fallback chains (`body.tokens || body.Data || (Array.isArray(body) ? body : [])`).
//
// Style follows test/branches.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

// NOTE: must be async + use spawn (not spawnSync) because tests in this
// file run an HTTP server in the same process — a synchronous child wait
// blocks the event loop and the server never answers the request.
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

const json = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

const fail4xx = (status = 400, body = { error: 'bad request' }) =>
  (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

// ─────────────────────────────────────────────────────────────────────────────
// 4xx failure branch coverage — every emitFailure/process.exit(exitForStatus)
// arm should be reachable.
// ─────────────────────────────────────────────────────────────────────────────

const COMMON_AUTH = {
  CLOUDCDN_ACCOUNT_KEY: 'k',
  CLOUDCDN_ACCESS_KEY: 'k',
  CLOUDCDN_RETRIES: '0',
  CLOUDCDN_TIMEOUT: '2000',
};

const FAILURE_CASES = [
  { name: 'purge --tag',     args: ['purge', '--tag', 'x'] },
  { name: 'assets show',     args: ['assets', 'show', 'abc'] },
  { name: 'assets list',     args: ['assets'] },
  { name: 'audit',           args: ['audit'] },
  { name: 'zones list',      args: ['zones', 'list'] },
  { name: 'zones create',    args: ['zones', 'create', 'example.com'] },
  { name: 'zones show',      args: ['zones', 'show', 'example.com'] },
  { name: 'zones rm',        args: ['zones', 'rm', 'example.com', '--force'] },
  { name: 'zones domains',   args: ['zones', 'domains', 'add', 'example.com', 'foo.com'] },
  { name: 'tokens list',     args: ['tokens', 'list'] },
  { name: 'webhooks list',   args: ['webhooks', 'list'] },
  { name: 'storage rm',      args: ['storage', 'rm', 'key1'] },
  { name: 'insights geo',    args: ['insights', 'geo'] },
  { name: 'ask',             args: ['ask', 'hello'] },
];

for (const tc of FAILURE_CASES) {
  test(`4xx error branch: ${tc.name}`, async () => {
    const { srv, base } = await startServer(fail4xx(400, { error: 'no' }));
    try {
      const r = await run(tc.args, { CLOUDCDN_URL: base, ...COMMON_AUTH });
      assert.notEqual(r.status, 0, `${tc.name}: expected non-zero exit, got ${r.status}`);
      // emitFailure writes the body to stderr.
      assert.ok(r.stderr.length > 0, `${tc.name}: expected stderr output`);
    } finally { srv.close(); }
  });
}

// rules set -f <file> — same 4xx path but requires a local file. /etc/hostname
// is universally readable; we just need *some* file content.
test('4xx error branch: rules set -f', async () => {
  const { srv, base } = await startServer(fail4xx(400, { error: 'no' }));
  try {
    const r = await run(['rules', 'set', '_headers', '-f', '/etc/hostname'],
      { CLOUDCDN_URL: base, ...COMMON_AUTH });
    assert.notEqual(r.status, 0);
  } finally { srv.close(); }
});

// storage sync --dry-run — local dir doesn't exist; we expect non-zero.
// The --dry-run branch never hits the network at all, but the resolve/walk
// path on a missing local dir surfaces an error.
test('storage sync --dry-run with non-existent local dir exits non-zero', async () => {
  const r = await run(['storage', 'sync', '/no/such/path/here', '/remote', '--dry-run'],
    { CLOUDCDN_URL: 'http://127.0.0.1:1', ...COMMON_AUTH });
  assert.notEqual(r.status, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Happy-path response-shape fallback chains — `body.X || body.Data || array`.
// Each test should exit 0 and produce a parseable JSON array under --json.
// ─────────────────────────────────────────────────────────────────────────────

test('tokens list: {Data: [...]} fallback (body.Data path)', async () => {
  const { srv, base } = await startServer(json({ Data: [
    { id: 't1', name: 'ci', scopes: ['p'], createdAt: '2026', expiresAt: '2026' },
  ] }));
  try {
    const r = await run(['tokens', 'list', '--json'],
      { CLOUDCDN_URL: base, ...COMMON_AUTH });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].id, 't1');
  } finally { srv.close(); }
});

test('webhooks list: bare array fallback', async () => {
  const { srv, base } = await startServer(json([
    { id: 'w1', url: 'https://x', events: ['p'], createdAt: '2026' },
  ]));
  try {
    const r = await run(['webhooks', 'list', '--json'],
      { CLOUDCDN_URL: base, ...COMMON_AUTH });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].id, 'w1');
  } finally { srv.close(); }
});

test('insights geo: {countries: [...]} (primary key)', async () => {
  const { srv, base } = await startServer(json({
    countries: [{ country: 'GB', requests: 1, bytes: 100 }],
  }));
  try {
    const r = await run(['insights', 'geo', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].country, 'GB');
  } finally { srv.close(); }
});

test('insights geo: {Data: [...]} (secondary key)', async () => {
  const { srv, base } = await startServer(json({
    Data: [{ country: 'FR', requests: 2, bytes: 200 }],
  }));
  try {
    const r = await run(['insights', 'geo', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].country, 'FR');
  } finally { srv.close(); }
});

test('insights geo: bare array fallback', async () => {
  const { srv, base } = await startServer(json([
    { country: 'DE', requests: 3, bytes: 300 },
  ]));
  try {
    const r = await run(['insights', 'geo', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].country, 'DE');
  } finally { srv.close(); }
});

test('zones list: mixed row shape (domain singular vs domains array)', async () => {
  const { srv, base } = await startServer(json({ zones: [
    { name: 'z1', domains: ['a.com', 'b.com'], createdAt: '2026-05-01' },
    { name: 'z2', domain: 'c.com', createdAt: '2026-05-02' },
    { name: 'z3', createdAt: '2026-05-03' },  // neither — hits empty-string arm
  ] }));
  try {
    const r = await run(['zones', 'list'],
      { CLOUDCDN_URL: base, ...COMMON_AUTH, STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    // The `get` callback should render "a.com,b.com" for z1 and "c.com" for z2.
    assert.match(r.stdout, /a\.com,b\.com/);
    assert.match(r.stdout, /c\.com/);
  } finally { srv.close(); }
});

test('assets list --all: paginates through multiple pages', async () => {
  let calls = 0;
  const { srv, base } = await startServer((req, res) => {
    calls++;
    const params = new URL(req.url, 'http://x').searchParams;
    const page = Number(params.get('page') || 1);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      Page: page,
      TotalPages: 3,
      Data: [{ Path: `/p${page}.svg`, Format: 'svg', Size: page, ContentType: 'image/svg+xml' }],
    }));
  });
  try {
    const r = await run(['assets', '--all', '--json'],
      { CLOUDCDN_URL: base, ...COMMON_AUTH });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 3);
    assert.ok(calls >= 3, `expected at least 3 page fetches, got ${calls}`);
  } finally { srv.close(); }
});
