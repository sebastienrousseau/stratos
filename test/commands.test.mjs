// SPDX-License-Identifier: MIT
//
// End-to-end coverage for every CLI command. Spawned subprocesses run under
// NODE_V8_COVERAGE (set by c8 in `npm run coverage`) so their execution
// contributes to the coverage report.

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

// ─────────────────────────────────────────────────────────────────────────────
// Output mode coverage — table renderer via STRATOS_FORCE_TTY.
// ─────────────────────────────────────────────────────────────────────────────

test('output: STRATOS_FORCE_TTY renders a table (assets)', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Page: 1, TotalPages: 1, Data: [
      { Path: '/a.svg', Format: 'svg', Size: 100, ContentType: 'image/svg+xml' },
      { Path: '/b.png', Format: 'png', Size: 200, ContentType: 'image/png' },
    ] }));
  }, async (base) => {
    const r = await runAsync(['assets'], { CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PATH\s+FORMAT\s+SIZE\s+TYPE/);
    assert.match(r.stdout, /\/a\.svg/);
    assert.match(r.stdout, /\/b\.png/);
  });
});

test('output: TTY mode renders empty-rows table cleanly', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"Page":1,"TotalPages":1,"Data":[]}');
  }, async (base) => {
    const r = await runAsync(['assets'], { CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no rows/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Completions — fish + powershell branches.
// ─────────────────────────────────────────────────────────────────────────────

test('completion: fish emits fish syntax', async () => {
  const r = await runAsync(['completion', 'fish']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /complete -c stratos/);
});

test('completion: powershell emits Register-ArgumentCompleter', async () => {
  const r = await runAsync(['completion', 'powershell']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Register-ArgumentCompleter/);
});

test('completion: no shell arg fails EX_USAGE', async () => {
  const r = await runAsync(['completion']);
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Config get / set / list.
// ─────────────────────────────────────────────────────────────────────────────

test('config: set / get / list round-trip via XDG_CONFIG_HOME', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    const env = { XDG_CONFIG_HOME: tmp };
    // set
    const s = await runAsync(['config', 'set', 'staging.url', 'https://staging.example'], env);
    assert.equal(s.status, 0);
    // get
    const g = await runAsync(['config', 'get', 'staging.url'], env);
    assert.equal(g.status, 0);
    assert.match(g.stdout, /https:\/\/staging\.example/);
    // list
    const l = await runAsync(['config', 'list'], env);
    assert.equal(l.status, 0);
    assert.match(l.stdout, /staging/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('config: get on missing key exits 69', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    const r = await runAsync(['config', 'get', 'nope.url'], { XDG_CONFIG_HOME: tmp });
    assert.equal(r.status, 69);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('config: get without key fails EX_USAGE', async () => {
  const r = await runAsync(['config', 'get']);
  assert.equal(r.status, 64);
});

test('config: set without value fails EX_USAGE', async () => {
  const r = await runAsync(['config', 'set', 'p.k']);
  assert.equal(r.status, 64);
});

test('config: unknown action fails EX_USAGE', async () => {
  const r = await runAsync(['config', 'nope']);
  assert.equal(r.status, 64);
});

test('config: profile selection round-trips through envConfig', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    await runAsync(['config', 'set', 'prod.url', 'http://localhost:65535'],
      { XDG_CONFIG_HOME: tmp });
    // Use --profile to select 'prod' — doctor reach attempt should target it.
    const r = await runAsync(['doctor', '--json', '--profile', 'prod'],
      { XDG_CONFIG_HOME: tmp, CLOUDCDN_RETRIES: '0', CLOUDCDN_TIMEOUT: '500' });
    // Reach check should fail (no server on :65535); but the URL in the
    // "Reach" check name should reflect the profile.
    const checks = JSON.parse(r.stdout);
    const reach = checks.find((c) => c.name.startsWith('Reach'));
    assert.match(reach.name, /localhost:65535/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Login / logout — status path + safety guard for non-interactive set.
// ─────────────────────────────────────────────────────────────────────────────

test('login: non-interactive without --account-key fails EX_USAGE on a pipe', async () => {
  // stdin is not a TTY in spawnAsync, so login should refuse.
  const r = await runAsync(['login']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /interactive/);
});

test('login: unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['login', 'bogus']);
  assert.equal(r.status, 64);
});

test('logout: top-level command exits cleanly', async () => {
  const r = await runAsync(['logout']);
  // STRATOS_NO_KEYCHAIN doesn't skip keychainDel; on macOS `security delete-…`
  // returns non-zero when the entry doesn't exist but execCapture swallows it.
  // The wrapper itself is c8-ignored, so we just check the routing.
  assert.equal(r.status, 0);
  assert.match(r.stderr, /cleared/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Upgrade — prints installer command.
// ─────────────────────────────────────────────────────────────────────────────

test('upgrade: prints install.sh URL on POSIX hosts', async () => {
  const r = await runAsync(['upgrade'], { CLOUDCDN_URL: 'https://example.com' });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Re-running installer/);
  assert.match(r.stderr, /example\.com\/dist\/stratos/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Insights — every subcommand path.
// ─────────────────────────────────────────────────────────────────────────────

function jsonServer(body) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
  };
}

test('insights asset: hits /api/insights/asset with path + days', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ data: 1 })(req, res); },
    async (base) => {
      const r = await runAsync(['insights', 'asset', '/x.svg', '--days', '14'],
        { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      assert.match(url, /\/api\/insights\/asset\?path=%2Fx\.svg&days=14/);
    });
});

test('insights asset: missing path fails EX_USAGE', async () => {
  const r = await runAsync(['insights', 'asset']);
  assert.equal(r.status, 64);
});

test('insights errors: passes days', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ errors: [] })(req, res); },
    async (base) => {
      const r = await runAsync(['insights', 'errors', '--days', '3'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      assert.match(url, /\/api\/insights\/errors\?days=3/);
    });
});

test('insights geo: renders rows', async () => {
  await withServer(jsonServer({ countries: [{ country: 'FR', requests: 10, bytes: 100 }] }),
    async (base) => {
      const r = await runAsync(['insights', 'geo', '--json'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.equal(rows[0].country, 'FR');
    });
});

test('insights top: passes limit', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ assets: [] })(req, res); },
    async (base) => {
      await runAsync(['insights', 'top', '--limit', '5'], { CLOUDCDN_URL: base });
      assert.match(url, /\/api\/insights\/top-assets\?days=7&limit=5/);
    });
});

test('insights unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['insights', 'bogus']);
  assert.equal(r.status, 64);
});

test('insights: --days out of range fails EX_USAGE', async () => {
  const r = await runAsync(['insights', 'summary', '--days', '999']);
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Stats / analytics / audit.
// ─────────────────────────────────────────────────────────────────────────────

test('stats: passes days + zone', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ ok: true })(req, res); },
    async (base) => {
      const r = await runAsync(['stats', '--days', '30', '--zone', 'akande'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.match(url, /\/api\/core\/statistics\?days=30&zone=akande/);
    });
});

test('analytics query: forwards filter params', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ ok: true })(req, res); },
    async (base) => {
      const r = await runAsync(
        ['analytics', 'query', '--days', '14', '--country', 'FR', '--bytes', '1000'],
        { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      assert.match(url, /country=FR/);
      assert.match(url, /bytes=1000/);
    });
});

test('analytics unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['analytics', 'bogus']);
  assert.equal(r.status, 64);
});

test('audit: passes action + limit; renders table headers', async () => {
  await withServer(jsonServer({ logs: [
    { timestamp: '2026-05-30', action: 'token.create', actor: 'admin', target: 'cdnsk_x' },
  ] }), async (base) => {
    const r = await runAsync(['audit', '--days', '5', '--action', 'token.create', '--limit', '10', '--json'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].action, 'token.create');
  });
});

test('audit: --days > 7 fails EX_USAGE', async () => {
  const r = await runAsync(['audit', '--days', '10']);
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Zones — list, create, show, rm, domains.
// ─────────────────────────────────────────────────────────────────────────────

test('zones create: POSTs Name', async () => {
  let received;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      received = JSON.parse(body);
      jsonServer({ id: 'z1', name: received.Name })(req, res);
    });
  }, async (base) => {
    const r = await runAsync(['zones', 'create', 'akande'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(received.Name, 'akande');
  });
});

test('zones create: missing name fails EX_USAGE', async () => {
  const r = await runAsync(['zones', 'create'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('zones show: hits /api/core/zones/<id>', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ name: 'z1' })(req, res); },
    async (base) => {
      const r = await runAsync(['zones', 'show', 'z1'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.equal(url, '/api/core/zones/z1');
    });
});

test('zones show: missing id fails EX_USAGE', async () => {
  const r = await runAsync(['zones', 'show'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('zones rm: requires --force on TTY', async () => {
  const r = await runAsync(['zones', 'rm', 'z1'],
    { CLOUDCDN_ACCOUNT_KEY: 'k', STRATOS_FORCE_TTY: '1' });
  assert.equal(r.status, 64);
});

test('zones rm: --force sends DELETE', async () => {
  let method;
  await withServer((req, res) => {
    method = req.method;
    jsonServer({ ok: true })(req, res);
  }, async (base) => {
    const r = await runAsync(['zones', 'rm', 'z1', '--force'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(method, 'DELETE');
  });
});

test('zones rm: missing id fails EX_USAGE', async () => {
  const r = await runAsync(['zones', 'rm'],
    { CLOUDCDN_ACCOUNT_KEY: 'k', STRATOS_FORCE_TTY: '1' });
  assert.equal(r.status, 64);
});

test('zones domains add: POSTs Hostname', async () => {
  let received; let url;
  await withServer((req, res) => {
    url = req.url;
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      received = JSON.parse(body);
      jsonServer({ ok: true })(req, res);
    });
  }, async (base) => {
    const r = await runAsync(['zones', 'domains', 'add', 'z1', 'example.com'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(received.Hostname, 'example.com');
    assert.equal(url, '/api/core/zones/z1/domains');
  });
});

test('zones domains add: missing args fails EX_USAGE', async () => {
  const r = await runAsync(['zones', 'domains', 'add', 'z1'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('zones unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['zones', 'bogus'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rules — get + set + diff edge cases.
// ─────────────────────────────────────────────────────────────────────────────

test('rules get: prints Content field', async () => {
  await withServer(jsonServer({ Content: '/api/* Cache-Control: no-store\n' }),
    async (base) => {
      const r = await runAsync(['rules', 'get', '_headers'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /Cache-Control: no-store/);
    });
});

test('rules set: POSTs File + Content from -f flag', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-rules-'));
  const f = join(tmp, '_headers');
  await writeFile(f, '/api/* X-New: 1\n');
  try {
    let received;
    await withServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        received = JSON.parse(body);
        jsonServer({ ok: true })(req, res);
      });
    }, async (base) => {
      const r = await runAsync(['rules', 'set', '_headers', '-f', f],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.equal(received.File, '_headers');
      assert.match(received.Content, /X-New: 1/);
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('rules set: reads from stdin when no -f', async () => {
  let received;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      received = JSON.parse(body);
      jsonServer({ ok: true })(req, res);
    });
  }, async (base) => {
    const r = await runAsync(['rules', 'set', '_redirects'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' },
      { input: '/old /new 301\n' });
    assert.equal(r.status, 0);
    assert.match(received.Content, /\/old \/new 301/);
  });
});

test('rules set: rejects invalid filename', async () => {
  const r = await runAsync(['rules', 'set', 'bogus', '-f', '/dev/null'],
    { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('rules: unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['rules', 'bogus', '_headers'],
    { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tokens — list, create, rm.
// ─────────────────────────────────────────────────────────────────────────────

test('tokens list: renders rows', async () => {
  await withServer(jsonServer({ tokens: [
    { id: 't1', name: 'ci', scopes: ['purge:write'], createdAt: '2026-05-01', expiresAt: '2026-06-01' },
  ] }), async (base) => {
    const r = await runAsync(['tokens', 'list', '--json'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].id, 't1');
  });
});

test('tokens create: POSTs name + scopes + expiresInDays', async () => {
  let received;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      received = JSON.parse(body);
      jsonServer({ id: 't2', token: 'cdnsk_xxx' })(req, res);
    });
  }, async (base) => {
    const r = await runAsync(
      ['tokens', 'create', '--name', 'ci', '--scopes', 'purge:write,assets:read', '--expires-in', '30'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(received.name, 'ci');
    assert.deepEqual(received.scopes, ['purge:write', 'assets:read']);
    assert.equal(received.expiresInDays, 30);
  });
});

test('tokens create: missing --name fails EX_USAGE', async () => {
  const r = await runAsync(['tokens', 'create', '--scopes', 'x'],
    { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('tokens create: missing --scopes fails EX_USAGE', async () => {
  const r = await runAsync(['tokens', 'create', '--name', 'ci'],
    { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('tokens rm: DELETE with id', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ ok: true })(req, res); },
    async (base) => {
      const r = await runAsync(['tokens', 'rm', 't1'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.match(url, /\/api\/tokens\?id=t1/);
    });
});

test('tokens rm: missing id fails EX_USAGE', async () => {
  const r = await runAsync(['tokens', 'rm'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('tokens unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['tokens', 'bogus'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks — list, add, rm.
// ─────────────────────────────────────────────────────────────────────────────

test('webhooks list: renders rows', async () => {
  await withServer(jsonServer({ webhooks: [
    { id: 'w1', url: 'https://hook.example/x', events: ['purge'], createdAt: '2026-05-01' },
  ] }), async (base) => {
    const r = await runAsync(['webhooks', 'list', '--json'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].id, 'w1');
  });
});

test('webhooks add: POSTs payload', async () => {
  let received;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      received = JSON.parse(body);
      jsonServer({ id: 'w2' })(req, res);
    });
  }, async (base) => {
    const r = await runAsync(
      ['webhooks', 'add', '--url', 'https://hook.example/y', '--events', 'purge,deploy', '--secret', 's'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(received.url, 'https://hook.example/y');
    assert.deepEqual(received.events, ['purge', 'deploy']);
    assert.equal(received.secret, 's');
  });
});

test('webhooks add: missing --url fails EX_USAGE', async () => {
  const r = await runAsync(['webhooks', 'add', '--events', 'x'],
    { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('webhooks add: missing --events fails EX_USAGE', async () => {
  const r = await runAsync(['webhooks', 'add', '--url', 'https://x'],
    { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('webhooks rm: DELETE with id', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ ok: true })(req, res); },
    async (base) => {
      const r = await runAsync(['webhooks', 'rm', 'w1'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.match(url, /\/api\/webhooks\?id=w1/);
    });
});

test('webhooks rm: missing id fails EX_USAGE', async () => {
  const r = await runAsync(['webhooks', 'rm'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('webhooks unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['webhooks', 'bogus'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Storage — put, get, rm, ls, sync.
// ─────────────────────────────────────────────────────────────────────────────

test('storage put: PUTs file bytes to /api/storage/<encoded-path>', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-st-'));
  const local = join(tmp, 'file.txt');
  await writeFile(local, 'hello world');
  try {
    let received;
    await withServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received = { url: req.url, method: req.method, body: Buffer.concat(chunks).toString() };
        jsonServer({ ok: true })(req, res);
      });
    }, async (base) => {
      const r = await runAsync(['storage', 'put', local, 'site/index.html'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.equal(received.method, 'PUT');
      assert.match(received.url, /\/api\/storage\/site\/index\.html/);
      assert.equal(received.body, 'hello world');
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('storage put: missing args fails EX_USAGE', async () => {
  const r = await runAsync(['storage', 'put'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('storage get: writes to local path', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-st-'));
  const out = join(tmp, 'download.bin');
  try {
    await withServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from([1, 2, 3, 4]));
    }, async (base) => {
      const r = await runAsync(['storage', 'get', 'site/x.bin', out],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCESS_KEY: 'k' });
      assert.equal(r.status, 0);
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('storage get: streams to stdout when local omitted', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end(Buffer.from('blob-bytes'));
  }, async (base) => {
    const r = await runAsync(['storage', 'get', 'x.bin'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCESS_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'blob-bytes');
  });
});

test('storage get: missing remote fails EX_USAGE', async () => {
  const r = await runAsync(['storage', 'get'], { CLOUDCDN_ACCESS_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('storage get: 4xx surfaces as exit code', async () => {
  await withServer((req, res) => { res.writeHead(404); res.end('not found'); },
    async (base) => {
      const r = await runAsync(['storage', 'get', 'missing.bin'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCESS_KEY: 'k' });
      assert.equal(r.status, 69);
    });
});

test('storage rm: DELETE', async () => {
  let method;
  await withServer((req, res) => {
    method = req.method;
    jsonServer({ ok: true })(req, res);
  }, async (base) => {
    const r = await runAsync(['storage', 'rm', 'site/x.bin'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(method, 'DELETE');
  });
});

test('storage rm: missing remote fails EX_USAGE', async () => {
  const r = await runAsync(['storage', 'rm'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('storage ls: renders rows', async () => {
  await withServer(jsonServer([
    { Path: '/site/a.html', Length: 100, ContentType: 'text/html' },
    { Path: '/site/b.css', Length: 200, ContentType: 'text/css' },
  ]), async (base) => {
    const r = await runAsync(['storage', 'ls', 'site/', '--json'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCESS_KEY: 'k' });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 2);
  });
});

test('storage ls: non-array body is emitted as object', async () => {
  await withServer(jsonServer({ note: 'directory' }),
    async (base) => {
      const r = await runAsync(['storage', 'ls', 'dir/'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCESS_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /directory/);
    });
});

test('storage sync: dry-run lists local→remote plan', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-st-'));
  await writeFile(join(tmp, 'a.html'), 'a');
  await writeFile(join(tmp, 'b.css'), 'b');
  try {
    const r = await runAsync(['storage', 'sync', tmp, '/site', '--dry-run', '--json'],
      { CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 2);
    assert.match(rows[0].remote, /^\/site\//);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('storage sync: missing args fails EX_USAGE', async () => {
  const r = await runAsync(['storage', 'sync'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('storage sync: posts batch to /api/storage/batch', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-st-'));
  await writeFile(join(tmp, 'a.html'), 'hello');
  try {
    let received;
    await withServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        received = { url: req.url, body: JSON.parse(body) };
        jsonServer({ ok: true })(req, res);
      });
    }, async (base) => {
      const r = await runAsync(['storage', 'sync', tmp, '/site'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.equal(received.url, '/api/storage/batch');
      assert.equal(received.body.files[0].path, '/site/a.html');
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('storage unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['storage', 'bogus'], { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Logs — query + tail (SSE).
// ─────────────────────────────────────────────────────────────────────────────

test('logs query: passes days + level + limit', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ logs: [
    { timestamp: '2026-05-30', level: 'error', message: 'oops' },
  ] })(req, res); },
    async (base) => {
      const r = await runAsync(['logs', 'query', '--days', '3', '--level', 'error', '--limit', '50', '--json'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.match(url, /days=3/);
      assert.match(url, /level=error/);
      assert.match(url, /limit=50/);
      const rows = JSON.parse(r.stdout);
      assert.equal(rows[0].message, 'oops');
    });
});

test('logs unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['logs', 'bogus']);
  assert.equal(r.status, 64);
});

test('logs tail: streams SSE events and parses data: payloads', async () => {
  await withServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"level":"info","timestamp":"2026-05-30T00:00:00Z","message":"first"}\n\n');
    res.write('data: {"level":"error","timestamp":"2026-05-30T00:00:01Z","message":"oops"}\n\n');
    res.write('data: {"level":"warn","message":"watch"}\n\n');
    res.write('data: {"level":"debug","message":"dbg"}\n\n');
    res.write('data: not-json\n\n');
    res.end();
  }, async (base) => {
    const r = await runAsync(['logs', 'tail'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /INFO.*first/);
    assert.match(r.stdout, /ERROR.*oops/);
    assert.match(r.stdout, /WARN.*watch/);
    assert.match(r.stdout, /DEBUG.*dbg/);
    assert.match(r.stdout, /INFO.*not-json/);
  });
});

test('logs tail: 4xx fails fast', async () => {
  await withServer((req, res) => {
    res.writeHead(403); res.end('forbidden');
  }, async (base) => {
    const r = await runAsync(['logs', 'tail'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 77);
  });
});

test('logs tail: --level forwarded as query param', async () => {
  let url;
  await withServer((req, res) => {
    url = req.url;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end();
  }, async (base) => {
    await runAsync(['logs', 'tail', '--level', 'error'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.match(url, /tail=true/);
    assert.match(url, /level=error/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI commands.
// ─────────────────────────────────────────────────────────────────────────────

test('ai alt: GETs /api/ai/alt-text?url=…', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ alt: 'a tree' })(req, res); },
    async (base) => {
      const r = await runAsync(['ai', 'alt', 'https://x/img.jpg'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      assert.match(url, /\/api\/ai\/alt-text\?url=https%3A%2F%2Fx%2Fimg\.jpg/);
    });
});

test('ai moderate: GETs /api/ai/moderate', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ score: 0.1 })(req, res); },
    async (base) => {
      await runAsync(['ai', 'moderate', 'https://x/img.jpg'], { CLOUDCDN_URL: base });
      assert.match(url, /\/api\/ai\/moderate/);
    });
});

test('ai crop: GETs /api/ai/smart-crop', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ gravity: 'face' })(req, res); },
    async (base) => {
      await runAsync(['ai', 'crop', 'https://x/img.jpg'], { CLOUDCDN_URL: base });
      assert.match(url, /\/api\/ai\/smart-crop/);
    });
});

test('ai bg-remove: GETs /api/ai/background-remove', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ stub: true })(req, res); },
    async (base) => {
      await runAsync(['ai', 'bg-remove', 'https://x/img.jpg'], { CLOUDCDN_URL: base });
      assert.match(url, /\/api\/ai\/background-remove/);
    });
});

test('ai: missing args fails EX_USAGE', async () => {
  const r = await runAsync(['ai']);
  assert.equal(r.status, 64);
});

test('ai: unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['ai', 'bogus', 'https://x']);
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Image + stream commands.
// ─────────────────────────────────────────────────────────────────────────────

test('image transform: emits a transform URL with options', async () => {
  const r = await runAsync(['image', 'transform', 'https://x/i.jpg',
    '--w', '800', '--h', '600', '--fit', 'cover', '--format', 'avif', '--q', '80'],
    { CLOUDCDN_URL: 'https://example.com' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^https:\/\/example\.com\/api\/transform\?/);
  assert.match(r.stdout, /url=https%3A%2F%2Fx%2Fi\.jpg/);
  assert.match(r.stdout, /w=800/);
  assert.match(r.stdout, /h=600/);
  assert.match(r.stdout, /format=avif/);
});

test('image transform: missing url fails EX_USAGE', async () => {
  const r = await runAsync(['image', 'transform']);
  assert.equal(r.status, 64);
});

test('image blurhash: hits /api/blurhash with size', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ hash: 'L9A' })(req, res); },
    async (base) => {
      await runAsync(['image', 'blurhash', 'https://x/i.jpg', '--size', '24'],
        { CLOUDCDN_URL: base });
      assert.match(url, /\/api\/blurhash\?url=/);
      assert.match(url, /size=24/);
    });
});

test('image blurhash: missing url fails EX_USAGE', async () => {
  const r = await runAsync(['image', 'blurhash']);
  assert.equal(r.status, 64);
});

test('image lqip: hits /api/lqip with size + blur', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ data: 'data:…' })(req, res); },
    async (base) => {
      await runAsync(['image', 'lqip', 'https://x/i.jpg', '--size', '16', '--blur', '20'],
        { CLOUDCDN_URL: base });
      assert.match(url, /size=16/);
      assert.match(url, /blur=20/);
    });
});

test('image lqip: missing url fails EX_USAGE', async () => {
  const r = await runAsync(['image', 'lqip']);
  assert.equal(r.status, 64);
});

test('image auto: hits /api/auto with path + anim', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ format: 'avif' })(req, res); },
    async (base) => {
      await runAsync(['image', 'auto', '/site/img.gif', '--anim'], { CLOUDCDN_URL: base });
      assert.match(url, /path=%2Fsite%2Fimg\.gif/);
      assert.match(url, /anim=1/);
    });
});

test('image auto: missing path fails EX_USAGE', async () => {
  const r = await runAsync(['image', 'auto']);
  assert.equal(r.status, 64);
});

test('image: missing subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['image']);
  assert.equal(r.status, 64);
});

test('image: unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['image', 'bogus', 'https://x']);
  assert.equal(r.status, 64);
});

test('stream: builds HLS URL with quality + segment', async () => {
  const r = await runAsync(['stream', 'nature', '--quality', '720', '--segment', '3'],
    { CLOUDCDN_URL: 'https://example.com' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\/api\/stream\?video=nature/);
  assert.match(r.stdout, /quality=720/);
  assert.match(r.stdout, /segment=3/);
});

test('stream: missing video fails EX_USAGE', async () => {
  const r = await runAsync(['stream']);
  assert.equal(r.status, 64);
});

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline, search, ask, passkey.
// ─────────────────────────────────────────────────────────────────────────────

test('pipeline submit: POSTs base64 SVG + name + flags', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-pl-'));
  const svg = join(tmp, 'logo.svg');
  await writeFile(svg, '<svg/>');
  try {
    let received;
    await withServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        received = JSON.parse(body);
        jsonServer({ ok: true })(req, res);
      });
    }, async (base) => {
      const r = await runAsync(
        ['pipeline', 'submit', '--svg', svg, '--name', 'acme', '--mode', 'client', '--favicons', '--icons', '--banners'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.equal(received.name, 'acme');
      assert.equal(received.mode, 'client');
      assert.equal(received.generateFavicon, true);
      assert.equal(received.generateIcons, true);
      assert.equal(received.generateBanners, true);
      assert.equal(Buffer.from(received.svg, 'base64').toString(), '<svg/>');
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('pipeline submit: missing --svg fails EX_USAGE', async () => {
  const r = await runAsync(['pipeline', 'submit', '--name', 'x']);
  assert.equal(r.status, 64);
});

test('pipeline: unknown subcommand fails EX_USAGE', async () => {
  const r = await runAsync(['pipeline', 'bogus']);
  assert.equal(r.status, 64);
});

test('search: GETs /api/search with q + limit, renders rows', async () => {
  let url;
  await withServer((req, res) => {
    url = req.url;
    jsonServer({ results: [{ path: '/x.svg', score: 0.9, type: 'image' }] })(req, res);
  }, async (base) => {
    const r = await runAsync(['search', 'logo', '--limit', '5', '--json'],
      { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(url, /q=logo/);
    assert.match(url, /limit=5/);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].path, '/x.svg');
  });
});

test('search: missing query fails EX_USAGE', async () => {
  const r = await runAsync(['search']);
  assert.equal(r.status, 64);
});

test('ask: prints reply when present', async () => {
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      jsonServer({ reply: 'echo:' + parsed.message })(req, res);
    });
  }, async (base) => {
    const r = await runAsync(['ask', 'how', 'do', 'I', 'purge'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^echo:how do I purge/);
  });
});

test('ask: falls back to emit when reply field missing', async () => {
  await withServer(jsonServer({ other: 'thing' }), async (base) => {
    const r = await runAsync(['ask', 'hello'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"other"/);
  });
});

test('ask: missing message fails EX_USAGE', async () => {
  const r = await runAsync(['ask']);
  assert.equal(r.status, 64);
});

test('passkey: stub exits EX_UNAVAILABLE with dashboard URL', async () => {
  const r = await runAsync(['passkey', 'register'], { CLOUDCDN_URL: 'https://example.com' });
  assert.equal(r.status, 69);
  assert.match(r.stderr, /dashboard\/passkeys/);
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP — tools/call dispatch for each registered tool.
// ─────────────────────────────────────────────────────────────────────────────

function driveMcp(messages, env = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve'],
      { env: { ...process.env, STRATOS_CI: '0', ...env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; stderr=${stderr}`)); }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    setTimeout(() => child.stdin.end(), 300);
  });
}

test('mcp: tools/call cloudcdn_health forwards to /api/health', async () => {
  let url;
  await withServer((req, res) => { url = req.url; jsonServer({ status: 'ok' })(req, res); },
    async (base) => {
      const { stdout } = await driveMcp([
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'cloudcdn_health', arguments: { deep: true } } },
      ], { CLOUDCDN_URL: base });
      const lines = stdout.trim().split('\n').map(JSON.parse);
      const r = lines.find((x) => x.id === 2);
      assert.ok(r.result.content[0].text.includes('"status":'));
      assert.match(url, /deep=1/);
    });
});

test('mcp: tools/call cloudcdn_purge routes tags vs urls vs everything', async () => {
  const bodies = [];
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      bodies.push(JSON.parse(body));
      jsonServer({ ok: true })(req, res);
    });
  }, async (base) => {
    await driveMcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'cloudcdn_purge', arguments: { tags: ['a', 'b'] } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'cloudcdn_purge', arguments: { urls: ['https://x/y'] } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'cloudcdn_purge', arguments: { everything: true } } },
    ], { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.deepEqual(bodies[0].tags, ['a', 'b']);
    assert.deepEqual(bodies[1].urls, ['https://x/y']);
    assert.equal(bodies[2].purge_everything, true);
  });
});

test('mcp: tools/call exercises every registered tool', async () => {
  await withServer(jsonServer({ ok: true }), async (base) => {
    const calls = [
      { name: 'cloudcdn_assets', arguments: { project: 'akande' } },
      { name: 'cloudcdn_insights_summary', arguments: { days: 7 } },
      { name: 'cloudcdn_insights_top', arguments: { limit: 5 } },
      { name: 'cloudcdn_ai_alt', arguments: { url: 'https://x/i.jpg' } },
      { name: 'cloudcdn_ai_moderate', arguments: { url: 'https://x/i.jpg' } },
      { name: 'cloudcdn_search', arguments: { q: 'logo' } },
      { name: 'cloudcdn_signed', arguments: { path: '/p', expires: 999, secret: 's' } },
      { name: 'cloudcdn_logs_query', arguments: { days: 1 } },
    ];
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      ...calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: c })),
    ];
    const { stdout } = await driveMcp(messages,
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k', CLOUDCDN_ACCESS_KEY: 'k' });
    const responses = stdout.trim().split('\n').map(JSON.parse);
    // Each request should have a corresponding response.
    for (let i = 0; i < calls.length; i++) {
      const r = responses.find((x) => x.id === i + 2);
      assert.ok(r, `no response for tool call ${calls[i].name}`);
      assert.ok(r.result || r.error, `bad envelope for ${calls[i].name}`);
    }
  });
});

test('mcp: tools/call with unknown tool returns error envelope', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'nope', arguments: {} } },
  ]);
  const r = stdout.trim().split('\n').map(JSON.parse).find((x) => x.id === 2);
  assert.ok(r.error);
  assert.equal(r.error.code, -32000);
});

test('mcp: notifications/initialized is a no-op', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  ]);
  const lines = stdout.trim().split('\n').map(JSON.parse);
  assert.ok(lines.find((x) => x.id === 1));
  assert.ok(lines.find((x) => x.id === 3));
});

// ─────────────────────────────────────────────────────────────────────────────
// Router & global-flag edge cases.
// ─────────────────────────────────────────────────────────────────────────────

test('global: --json forces JSON even on TTY', async () => {
  await withServer(jsonServer({ Page: 1, Data: [{ Path: '/x.svg', Format: 'svg', Size: 1, ContentType: 'i/s' }] }),
    async (base) => {
      const r = await runAsync(['assets', '--json'],
        { CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1' });
      assert.equal(r.status, 0);
      // Should be JSON, not a table
      const rows = JSON.parse(r.stdout);
      assert.equal(rows[0].Path, '/x.svg');
    });
});

test('global: --quiet suppresses info logs', async () => {
  await withServer(jsonServer({ Page: 1, TotalPages: 1, Data: [{ Path: '/x.svg', Format: 'svg', Size: 1, ContentType: 'i/s' }] }),
    async (base) => {
      const r = await runAsync(['assets', '-q'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /info:/);
    });
});

test('router: signed --help shows command-level help', async () => {
  const r = await runAsync(['signed', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stratos signed/);
});

test('router: -h shortcut works', async () => {
  const r = await runAsync(['-h']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stratos v\d/);
});

test('mcp: bare mcp without serve fails EX_USAGE', async () => {
  const r = await runAsync(['mcp']);
  assert.equal(r.status, 64);
});
