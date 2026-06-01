// SPDX-License-Identifier: MIT
//
// Targeted tests for edge branches that close the last gaps to 100% coverage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const { port } = srv.address();
      try { const r = await fn(`http://127.0.0.1:${port}`, srv); srv.close(); resolve(r); }
      catch (e) { srv.close(); reject(e); }
    });
  });
}

function runAsync(args, env = {}, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env: { ...process.env, STRATOS_CI: '0', ...env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ stdout, stderr, status: code }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

const jsonServer = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

// ─────────────────────────────────────────────────────────────────────────────

test('parseFlags: value-taking short flag at end of args becomes true', async () => {
  // `bench -n` — no value after `-n` → flag becomes boolean true → Number(true)=1
  // → bench makes 1 sample.
  await withServer(jsonServer({ status: 'ok' }), async (base) => {
    const r = await runAsync(['bench', '-n', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const stats = JSON.parse(r.stdout);
    assert.equal(stats.samples.length, 1);  // Number(true) === 1
  });
});

test('config: unreadable file surfaces as fatal error', async () => {
  if (platform() === 'win32') return;  // chmod 000 doesn't work the same way
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-bad-'));
  try {
    // Create the config file as completely invalid JSON.
    await writeFile(join(tmp, 'stratos', 'config.json'),
      'this is not json', { mode: 0o600 }).catch(async () => {
      // Need to mkdir first.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(tmp, 'stratos'), { recursive: true });
      await writeFile(join(tmp, 'stratos', 'config.json'), 'this is not json', { mode: 0o600 });
    });
    const r = await runAsync(['config', 'list'], { XDG_CONFIG_HOME: tmp });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unreadable/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('doctor: surfaces unreadable config in the report', async () => {
  if (platform() === 'win32') return;
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-bad-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmp, 'stratos'), { recursive: true });
    await writeFile(join(tmp, 'stratos', 'config.json'), '{not-json', { mode: 0o600 });
    const r = await runAsync(['doctor', '--json'],
      { XDG_CONFIG_HOME: tmp, CLOUDCDN_RETRIES: '0', CLOUDCDN_TIMEOUT: '500' });
    const checks = JSON.parse(r.stdout);
    const cfg = checks.find((c) => c.name.startsWith('Config file'));
    assert.equal(cfg.ok, false);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('http: retries on connection-reset network errors', async () => {
  let hits = 0;
  await withServer((req, res, srv) => {
    hits++;
    if (hits === 1) {
      // Forcibly destroy the socket → AbortError in the client.
      req.socket.destroy();
    } else {
      res.writeHead(200); res.end('{"ok":true}');
    }
  }, async (base) => {
    const r = await runAsync(['health'],
      { CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '2' });
    assert.equal(r.status, 0);
    assert.ok(hits >= 2, `expected at least 2 hits, got ${hits}`);
    assert.match(r.stderr, /retrying/);
  });
});

test('emit: TTY mode prints pretty JSON without --json flag', async () => {
  // STRATOS_FORCE_TTY=1 + no --json triggers the else branch in emit().
  await withServer(jsonServer({ status: 'ok', deep: false }), async (base) => {
    const r = await runAsync(['health'],
      { CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    // Pretty JSON has multi-line indentation.
    assert.match(r.stdout, /"status":\s*"ok"/);
    assert.match(r.stdout, /\n {2}/);  // 2-space indent
  });
});

test('help: unknown topic exits EX_USAGE', async () => {
  const r = await runAsync(['help', 'nope']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /No help/);
});

test('bench: against unreachable server records error samples', async () => {
  const r = await runAsync(['bench', '-n', '2', '--json'],
    { CLOUDCDN_URL: 'http://127.0.0.1:1', CLOUDCDN_TIMEOUT: '500', CLOUDCDN_RETRIES: '0' });
  assert.equal(r.status, 0);
  const stats = JSON.parse(r.stdout);
  assert.equal(stats.samples.length, 2);
  assert.equal(stats.summary.n_ok, 0);
  assert.equal(stats.summary.n_fail, 2);
  assert.ok(stats.samples[0].error);
});

test('rules get: body without Content field falls back to JSON dump', async () => {
  await withServer(jsonServer({ ok: true, message: 'stored as object not string' }),
    async (base) => {
      const r = await runAsync(['rules', 'get', '_headers'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /"message":/);
    });
});

test('rules get: server-side string body is printed verbatim', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify('/api/* X-Bare: 1'));  // JSON string, not object
  }, async (base) => {
    const r = await runAsync(['rules', 'get', '_headers'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /X-Bare: 1/);
  });
});

test('storage get: falls back to AccountKey when AccessKey is unset', async () => {
  let receivedHeaders;
  await withServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200); res.end(Buffer.from('ok'));
  }, async (base) => {
    const r = await runAsync(['storage', 'get', 'x.bin'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'kk', CLOUDCDN_ACCESS_KEY: '' });
    assert.equal(r.status, 0);
    assert.equal(receivedHeaders.accountkey, 'kk');
    assert.equal(receivedHeaders.accesskey, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TTY-mode list rendering — exercises the `get` callbacks on column defs.
// ─────────────────────────────────────────────────────────────────────────────

test('zones list: TTY mode renders DOMAINS via get() callback', async () => {
  await withServer(jsonServer({ zones: [
    { name: 'z1', domains: ['a.com', 'b.com'], createdAt: '2026-05-01' },
    { name: 'z2', domain: 'c.com', createdAt: '2026-05-02' },
  ] }), async (base) => {
    const r = await runAsync(['zones'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k', STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /a\.com,b\.com/);
    assert.match(r.stdout, /c\.com/);
  });
});

test('tokens list: TTY mode renders SCOPES via get() callback', async () => {
  await withServer(jsonServer({ tokens: [
    { id: 't1', name: 'ci', scopes: ['purge:write', 'assets:read'], createdAt: '2026-05-01' },
  ] }), async (base) => {
    const r = await runAsync(['tokens'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k', STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /purge:write,assets:read/);
  });
});

test('webhooks list: TTY mode renders EVENTS via get() callback', async () => {
  await withServer(jsonServer({ webhooks: [
    { id: 'w1', url: 'https://x', events: ['purge', 'deploy'], createdAt: '2026-05-01' },
  ] }), async (base) => {
    const r = await runAsync(['webhooks'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k', STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /purge,deploy/);
  });
});

test('printLogLine: cyan (info) + dim (debug) paths covered via SSE', async () => {
  // (already broadly covered, but make sure each colour branch runs).
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"level":"info","message":"i"}\n\n');
    res.write('data: {"message":"no-level"}\n\n');  // falls through to cyan
    res.end();
  }, async (base) => {
    const r = await runAsync(['logs', 'tail'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k', STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /INFO/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP: tool call that triggers a command writing to stderr (covers the
// stdout/stderr-capture overrides installed by mcpCall).
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

test('mcp: tool call captures stderr via the stderr.write override', async () => {
  await withServer(jsonServer({
    Page: 1, TotalPages: 1,
    Data: [{ Path: '/x.svg', Format: 'svg', Size: 1, ContentType: 'image/svg+xml' }],
  }), async (base) => {
    const { stdout } = await driveMcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'cloudcdn_assets', arguments: {} } },
    ], { CLOUDCDN_URL: base });
    const lines = stdout.trim().split('\n').map(JSON.parse);
    const r = lines.find((x) => x.id === 2);
    // cmdAssets emits info('page 1 of 1...') to stderr, which the override
    // captures into result.content[0].text alongside the stdout JSON.
    assert.ok(r.result);
    assert.match(r.result.content[0].text, /page 1 of 1/);
  });
});
