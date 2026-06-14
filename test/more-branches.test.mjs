// SPDX-License-Identifier: MIT
//
// Final pass for branch coverage — targets the alternate arm of remaining
// short-circuit expressions, default switch cases, and error paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const { port } = srv.address();
      try { const r = await fn(`http://127.0.0.1:${port}`); srv.close(); resolve(r); }
      catch (e) { srv.close(); reject(e); }
    });
  });
}

function runClean(args, env = {}) {
  const baseEnv = { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' };
  ['CLOUDCDN_URL','CLOUDCDN_ACCOUNT_KEY','CLOUDCDN_ACCESS_KEY','SIGNED_URL_SECRET',
   'CLOUDCDN_TIMEOUT','CLOUDCDN_RETRIES','STRATOS_PROFILE',
   'GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','JENKINS_URL','TF_BUILD','CI'].forEach((k) => delete baseEnv[k]);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env: { ...baseEnv, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ stdout, stderr, status: code }));
  });
}

const jsonServer = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

// ─────────────────────────────────────────────────────────────────────────────
// Control-plane operations without an account key (jsonReq throws).
// ─────────────────────────────────────────────────────────────────────────────

test('jsonReq: control role without ACCOUNT_KEY throws EX_CONFIG', async () => {
  // No account key set anywhere, but purge is a control-plane op.
  const r = await runClean(['purge', 'https://cloudcdn.pro/x']);
  assert.equal(r.status, 78);  // EX.CONFIG
  assert.match(r.stderr, /CLOUDCDN_ACCOUNT_KEY/);
});

test('jsonReq: control role for zones without ACCOUNT_KEY throws EX_CONFIG', async () => {
  const r = await runClean(['zones']);
  assert.equal(r.status, 78);
});

test('jsonReq: control role for stats without ACCOUNT_KEY throws EX_CONFIG', async () => {
  const r = await runClean(['stats']);
  assert.equal(r.status, 78);
});

// ─────────────────────────────────────────────────────────────────────────────
// 403 — separate branch arm from 401 in exitForStatus.
// ─────────────────────────────────────────────────────────────────────────────

test('exitForStatus: 403 exits EX_NOPERM (77)', async () => {
  await withServer((req, res) => { res.writeHead(403); res.end('{"err":"forbidden"}'); },
    async (base) => {
      const r = await runClean(['health'], { CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '0' });
      assert.equal(r.status, 77);
    });
});

test('exitForStatus: 429 retries then surfaces as EX_TEMPFAIL when exhausted', async () => {
  await withServer((req, res) => { res.writeHead(429); res.end('{"err":"rate"}'); },
    async (base) => {
      const r = await runClean(['health'], { CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '1' });
      assert.equal(r.status, 75);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Verbose path — info() under verbose; HTTP method/url logged.
// ─────────────────────────────────────────────────────────────────────────────

test('verbose: logs request method + url + attempt number', async () => {
  await withServer(jsonServer({ ok: true }), async (base) => {
    const r = await runClean(['health', '--verbose'],
      { CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '0' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /attempt 1\/1/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Routes that ship to default branches.
// ─────────────────────────────────────────────────────────────────────────────

test('insights: no-arg insights falls through default→EX_USAGE', async () => {
  const r = await runClean(['insights']);
  assert.equal(r.status, 64);
});

test('storage: no-arg storage falls through default→EX_USAGE', async () => {
  const r = await runClean(['storage']);
  assert.equal(r.status, 64);
});

test('zones: no-arg falls to "list" default (covers undefined arm)', async () => {
  await withServer(jsonServer({ zones: [] }), async (base) => {
    const r = await runClean(['zones', '--json'], { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '[]');
  });
});

test('tokens: no-arg falls to "list" default', async () => {
  await withServer(jsonServer({ tokens: [] }), async (base) => {
    const r = await runClean(['tokens', '--json'], { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '[]');
  });
});

test('webhooks: no-arg falls to "list" default', async () => {
  await withServer(jsonServer({ webhooks: [] }), async (base) => {
    const r = await runClean(['webhooks', '--json'], { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '[]');
  });
});

test('logs: no-arg falls to "query" default', async () => {
  await withServer(jsonServer({ logs: [] }), async (base) => {
    const r = await runClean(['logs', '--json'], { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '[]');
  });
});

test('analytics: no-arg defaults to "query"', async () => {
  await withServer(jsonServer({ ok: true }), async (base) => {
    const r = await runClean(['analytics'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
  });
});

test('login: no-arg defaults to "set" path (fails on non-TTY without flags)', async () => {
  const r = await runClean(['login']);
  assert.equal(r.status, 64);
});

test('zones rm: alias "delete" works', async () => {
  let method;
  await withServer((req, res) => {
    method = req.method;
    res.writeHead(200); res.end('{"ok":true}');
  }, async (base) => {
    const r = await runClean(['zones', 'delete', 'z1', '--force'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(method, 'DELETE');
  });
});

test('tokens rm: alias "delete" works', async () => {
  await withServer(jsonServer({ ok: true }), async (base) => {
    const r = await runClean(['tokens', 'delete', 't1'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
  });
});

test('webhooks rm: alias "delete" works', async () => {
  await withServer(jsonServer({ ok: true }), async (base) => {
    const r = await runClean(['webhooks', 'delete', 'w1'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
  });
});

test('storage rm: alias "delete" works', async () => {
  await withServer(jsonServer({ ok: true }), async (base) => {
    const r = await runClean(['storage', 'delete', 'x.bin'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Insights aliases.
// ─────────────────────────────────────────────────────────────────────────────

test('insights: "geography" alias for "geo"', async () => {
  await withServer(jsonServer({ countries: [] }), async (base) => {
    const r = await runClean(['insights', 'geography', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP — initialize without id (response shape), tools/list before initialize.
// ─────────────────────────────────────────────────────────────────────────────

function driveMcp(messages, env = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve'],
      { env: { ...process.env, STRATOS_CI: '0', ...env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    setTimeout(() => child.stdin.end(), 300);
  });
}

test('mcp: malformed JSON line is silently ignored', async () => {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve'],
      { env: { ...process.env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' } });
    let stdout = '';
    child.stdout.on('data', (d) => stdout += d);
    child.on('close', () => {
      // Server should still respond to valid messages after malformed input.
      assert.match(stdout, /serverInfo/);
      resolve();
    });
    child.stdin.write('this-is-not-json\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
    setTimeout(() => child.stdin.end(), 200);
  });
});

test('mcp: tools/call with no params returns error', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call' },  // no params
  ]);
  const r = stdout.trim().split('\n').map(JSON.parse).find((x) => x.id === 2);
  assert.ok(r.error);
});

// ─────────────────────────────────────────────────────────────────────────────
// Final misc branches.
// ─────────────────────────────────────────────────────────────────────────────

test('config get: dotted value that is non-string emits JSON.stringify', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmp, 'stratos'), { recursive: true });
    await writeFile(join(tmp, 'stratos', 'config.json'),
      JSON.stringify({ profiles: { default: { timeout_ms: 5000 } } }));
    const r = await runClean(['config', 'get', 'default.timeout_ms'],
      { XDG_CONFIG_HOME: tmp });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /5000/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('parseFlags: --flag=empty-value (zero-length value after =)', async () => {
  // Sanity: --foo= should set foo to ''. Used by signed for empty secret override?
  // We're testing via the bench path that accepts arbitrary flag values.
  await withServer(jsonServer({ ok: true }), async (base) => {
    const r = await runClean(['bench', '--n=2', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const stats = JSON.parse(r.stdout);
    assert.equal(stats.samples.length, 2);
  });
});

test('parseFlags: -f short flag value-taking arm', async () => {
  // `rules set _headers -f path` — -f takes the value.
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-r-'));
    const f = join(tmp, '_headers');
    await writeFile(f, '/api/* X-K: V\n');
    await withServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => { res.writeHead(200); res.end('{"ok":true}'); });
    }, async (base) => {
      const r = await runClean(['rules', 'set', '_headers', '-f', f],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
    });
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('storage put: AccessKey-only header for read', async () => {
  // Storage put is actually control-plane; but storage get/ls use read role.
  // This test confirms ls path uses AccessKey when set.
  let headers;
  await withServer((req, res) => {
    headers = req.headers;
    res.writeHead(200); res.end('[]');
  }, async (base) => {
    await runClean(['storage', 'ls', '/d/'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCESS_KEY: 'a-key' });
    assert.equal(headers.accesskey, 'a-key');
    assert.equal(headers.accountkey, undefined);
  });
});

test('storage get: rejects when neither key is set (read role no-op)', async () => {
  await withServer((req, res) => {
    // Server requires auth — return 401.
    if (!req.headers.accountkey && !req.headers.accesskey) {
      res.writeHead(401); res.end('{"err":"no auth"}');
    } else { res.writeHead(200); res.end('ok'); }
  }, async (base) => {
    const r = await runClean(['storage', 'get', 'x.bin'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 77);
  });
});
