// SPDX-License-Identifier: MIT
//
// v0.0.x — third branch-coverage push targeting >= 99%. Focuses on
// table-render paths (FORCE_TTY=1 default output), single-object
// CSV/YAML emits, and the column-getter functions that previous JSON-
// output tests skipped.

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
// FORCE_TTY=1 + default output routes through emitList's table-renderer
// (L777). The column `get` functions for tokens (L2424 scopes), webhooks
// (L2485 events), and zones (domain shapes) fire only here, not on JSON.
// ─────────────────────────────────────────────────────────────────────────────

test('tokens list (TTY/table): row without scopes → get()=[].join() (L2424)', async () => {
  const { srv, base } = await startServer(
    json({ tokens: [{ id: 'tk', name: 'n' /* no scopes key */ }] }));
  try {
    const r = await run(['tokens', 'list'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /tk/);
  } finally { srv.close(); }
});

test('webhooks list (TTY/table): row without events (L2485)', async () => {
  const { srv, base } = await startServer(
    json({ webhooks: [{ id: 'wh', url: 'https://x' /* no events */ }] }));
  try {
    const r = await run(['webhooks', 'list'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /wh/);
  } finally { srv.close(); }
});

test('zones list (TTY/table): row with array domains', async () => {
  const { srv, base } = await startServer(
    json({ zones: [{ name: 'z1', domains: ['a.test', 'b.test'] }] }));
  try {
    const r = await run(['zones', 'list'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /a\.test/);
  } finally { srv.close(); }
});

test('zones list (TTY/table): row with singular domain string', async () => {
  const { srv, base } = await startServer(
    json({ zones: [{ name: 'z2', domain: 'single.test' }] }));
  try {
    const r = await run(['zones', 'list'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /single\.test/);
  } finally { srv.close(); }
});

test('audit (TTY/table): exercise renderTable arm (L777)', async () => {
  const { srv, base } = await startServer(
    json({ logs: [{ timestamp: 't', action: 'a', actor: 'u', target: 'x' }] }));
  try {
    const r = await run(['audit'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ACTION/);
  } finally { srv.close(); }
});

test('insights geo (TTY/table)', async () => {
  const { srv, base } = await startServer(
    json({ countries: [{ country: 'FR', requests: 10, bytes: 100 }] }));
  try {
    const r = await run(['insights', 'geo'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /FR/);
  } finally { srv.close(); }
});

test('storage ls (TTY/table)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ Path: 'a.txt', Length: 1, ContentType: 't' }]));
  });
  try {
    const r = await run(['storage', 'ls'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /a\.txt/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// emit (non-list) with --output csv — covers L686's
// `Array.isArray(piped) ? piped : [piped]` right arm (single-object body).
// emitList always receives an array, but emit() of a single object goes
// through L686 with `piped` non-array → wrapped in `[piped]`.
// ─────────────────────────────────────────────────────────────────────────────

test('stats --output csv: single-object body wrapped in [body] (L686)', async () => {
  const { srv, base } = await startServer(json({ total: 1, ok: 1, bytes: 100 }));
  try {
    const r = await run(['stats', '--output', 'csv'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    // CSV header + one row.
    assert.match(r.stdout, /total/);
    assert.match(r.stdout, /1,1,100/);
  } finally { srv.close(); }
});

test('stats --output yaml: single-object body', async () => {
  const { srv, base } = await startServer(json({ total: 1, ok: 1 }));
  try {
    const r = await run(['stats', '--output', 'yaml'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /total:\s*1/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// CSV cell edge cases: null, undefined, object value, array value.
// Triggered via mock body content + --output csv.
// ─────────────────────────────────────────────────────────────────────────────

test('--output csv: rows with null cells (L957 — null/undefined arm)', async () => {
  const { srv, base } = await startServer(
    json({ tokens: [{ id: 'tk', name: null, scopes: null }] }));
  try {
    const r = await run(['tokens', 'list', '--output', 'csv'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^id,/);
  } finally { srv.close(); }
});

// emitList with empty rows goes to toCsv([]) → L933 right arm. Earlier
// added but ensure once more with a list endpoint that returns an empty
// list under the primary key.
test('--output csv: emitList of empty array → "" (L933)', async () => {
  const { srv, base } = await startServer(json({ tokens: [] }));
  try {
    const r = await run(['tokens', 'list', '--output', 'csv'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// assets show 4xx error branch (L2009).
// ─────────────────────────────────────────────────────────────────────────────

test('4xx error branch: assets show (L2009)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(400);
    res.end('{}');
  });
  try {
    const r = await run(['assets', 'show', 'somepath'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 69);
  } finally { srv.close(); }
});

// assets list --all 4xx (L2023).
test('4xx error branch: assets list --all (L2023)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(403);
    res.end('{}');
  });
  try {
    const r = await run(['assets', 'list', '--all'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 77);
  } finally { srv.close(); }
});

// health raw fetch 4xx (L1916).
test('4xx error branch: health (L1916)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(500);
    res.end('{}');
  });
  try {
    const r = await run(['health'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    // 500 → 75 (tempfail). Retries=0 so it doesn't loop.
    assert.equal(r.status, 75);
  } finally { srv.close(); }
});

// health deep 4xx (L1956 — possibly).
test('4xx error branch: health --deep (L1956)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(403);
    res.end('{}');
  });
  try {
    const r = await run(['health', '--deep'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 77);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// jsonReq retries-exhausted throw (L655). Force a network error so all
// attempts fail. With CLOUDCDN_RETRIES=0, maxAttempts=1, single failure
// triggers L655.
// ─────────────────────────────────────────────────────────────────────────────

test('jsonReq: retries exhausted → throws httpErr (L655)', async () => {
  // Closed port → fetch() rejects → loop exhausts → L655.
  const r = await run(['health'], {
    ...COMMON_AUTH,
    CLOUDCDN_URL: 'http://127.0.0.1:1',
    CLOUDCDN_RETRIES: '0',
    CLOUDCDN_TIMEOUT: '300',
  });
  // Exit code 75 = EX.TEMPFAIL.
  assert.equal(r.status, 75);
  assert.match(r.stderr, /request failed after|network/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Direct unit tests on exported functions.
// ─────────────────────────────────────────────────────────────────────────────

const { _parseFlags, MCP_TOOLS } = await import('../stratos.mjs');

test('parseFlags: -- end-of-flags marker (L274)', () => {
  const { positional, flags } = _parseFlags(['--foo', 'x', '--', '--not-a-flag', 'y']);
  assert.equal(flags.foo, 'x');
  assert.deepEqual(positional, ['--not-a-flag', 'y']);
});

test('parseFlags: --key=value inline form (L277)', () => {
  const { flags } = _parseFlags(['--key=value', '--empty=']);
  assert.equal(flags.key, 'value');
  assert.equal(flags.empty, '');
});

test('parseFlags: --bool then next --flag → boolean true (L281)', () => {
  const { flags } = _parseFlags(['--first', '--second', 'v']);
  assert.equal(flags.first, true);
  assert.equal(flags.second, 'v');
});

test('parseFlags: short flag without value followed by --flag → true (L292)', () => {
  // -n is a value-taking short. With nothing after → true.
  const { flags } = _parseFlags(['-n', '--next']);
  assert.equal(flags.iterations || flags.n, true);
});

test('parseFlags: unknown short flag is treated as positional (L287)', () => {
  const { positional } = _parseFlags(['-Z']);
  assert.deepEqual(positional, ['-Z']);
});

test('parseFlags: repeated flag accumulates into array (set k-in-flags arm)', () => {
  const { flags } = _parseFlags(['--tag', 'a', '--tag', 'b', '--tag', 'c']);
  assert.deepEqual(flags.tag, ['a', 'b', 'c']);
});

test('MCP_TOOLS: every tool has a name + description + schema', () => {
  for (const t of MCP_TOOLS) {
    assert.ok(t.name, `tool ${JSON.stringify(t)} missing name`);
    assert.ok(t.desc, `tool ${t.name} missing desc`);
    assert.ok(t.schema, `tool ${t.name} missing schema`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tokens list: row with scopes as actual array (other arm of `r.scopes
// || []`).
// ─────────────────────────────────────────────────────────────────────────────

test('tokens list (TTY/table): row with scopes array', async () => {
  const { srv, base } = await startServer(
    json({ tokens: [{ id: 'tk', name: 'n', scopes: ['read', 'write'] }] }));
  try {
    const r = await run(['tokens', 'list'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /read,write/);
  } finally { srv.close(); }
});

test('webhooks list (TTY/table): row with events array', async () => {
  const { srv, base } = await startServer(
    json({ webhooks: [{ id: 'wh', url: 'https://x', events: ['purge', 'invalidate'] }] }));
  try {
    const r = await run(['webhooks', 'list'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /purge,invalidate/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// emit with TTY pretty-print → L771's isTTY()-true arm in emitList JSON
// branch is already covered; this hits L682 for emit() of a single body
// (stats) under TTY.
// ─────────────────────────────────────────────────────────────────────────────

test('FORCE_TTY=1 + bare invocation: assets list non-Data body emits (L2063)', async () => {
  // assets list (no --all) hits the `else { emit(body, status) }` branch
  // when body is not in Data shape.
  const { srv, base } = await startServer(json({ random: 'shape' }));
  try {
    const r = await run(['assets', 'list', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"random"/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// rules diff via `--file` returns 0 on no diff (success arm of process.exit
// after diff render — covers L2336/2337 if uncovered).
// ─────────────────────────────────────────────────────────────────────────────

test('rules diff: identical remote/local exits 0', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('same\n');
  });
  const tmp = await import('node:fs/promises').then((m) => m.mkdtemp(
    join(process.env.TMPDIR || '/tmp', 'stratos-diff-')));
  const fs = await import('node:fs/promises');
  try {
    const file = join(tmp, '_headers');
    await fs.writeFile(file, 'same\n');
    const r = await run(['rules', 'diff', '_headers', '-f', file],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
  } finally {
    srv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

// Logs query via mock; also exercises the body.logs primary key arm (L2740).
test('logs query: body.logs primary key + TTY/table', async () => {
  const { srv, base } = await startServer(
    json({ logs: [{ timestamp: 't', level: 'info', message: 'hi' }] }));
  try {
    const r = await run(['logs', 'query'], {
      ...COMMON_AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /hi/);
  } finally { srv.close(); }
});

test('logs query: bare-array body fallback', async () => {
  const { srv, base } = await startServer(
    json([{ timestamp: 't', level: 'warn', message: 'bare' }]));
  try {
    const r = await run(['logs', 'query', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /bare/);
  } finally { srv.close(); }
});
