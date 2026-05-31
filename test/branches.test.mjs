// SPDX-License-Identifier: MIT
//
// Branch-coverage tests — exercises the alternate arm of every short-circuit
// fallback chain that isn't already covered by the functional tests.

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
  // IMPORTANT: clear inherited CLOUDCDN_* env vars by default so each test
  // can control its own configuration source. Tests must set CLOUDCDN_URL
  // explicitly via env if they want it.
  const baseEnv = { ...process.env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' };
  delete baseEnv.CLOUDCDN_URL;
  delete baseEnv.CLOUDCDN_ACCOUNT_KEY;
  delete baseEnv.CLOUDCDN_ACCESS_KEY;
  delete baseEnv.SIGNED_URL_SECRET;
  delete baseEnv.CLOUDCDN_TIMEOUT;
  delete baseEnv.CLOUDCDN_RETRIES;
  delete baseEnv.STRATOS_PROFILE;
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

const jsonServer = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

// ─────────────────────────────────────────────────────────────────────────────
// envConfig fallback chains: every arm should be exercised somewhere.
// ─────────────────────────────────────────────────────────────────────────────

test('envConfig: --cdn-url flag overrides CLOUDCDN_URL env', async () => {
  let receivedHost;
  await withServer((req, res) => {
    receivedHost = req.headers.host;
    jsonServer({ status: 'ok' })(req, res);
  }, async (base) => {
    const r = await runAsync(['health', '--cdn-url', base],
      { CLOUDCDN_URL: 'https://wrong.example.invalid' });
    assert.equal(r.status, 0);
    // The host header proves we hit the --cdn-url server, not the env one.
    assert.match(receivedHost, /127\.0\.0\.1/);
  });
});

test('envConfig: --account-key flag overrides env', async () => {
  let receivedKey;
  await withServer((req, res) => {
    receivedKey = req.headers.accountkey;
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => { res.writeHead(200); res.end('{"ok":true}'); });
  }, async (base) => {
    const r = await runAsync(['purge', 'https://x', '--account-key', 'flag-key'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'env-key' });
    assert.equal(r.status, 0);
    assert.equal(receivedKey, 'flag-key');
  });
});

test('envConfig: --access-key flag overrides env', async () => {
  let receivedKey;
  await withServer((req, res) => {
    receivedKey = req.headers.accesskey;
    jsonServer({ status: 'ok' })(req, res);
  }, async (base) => {
    await runAsync(['health', '--access-key', 'flag-access'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCESS_KEY: 'env-access' });
    assert.equal(receivedKey, 'flag-access');
  });
});

test('envConfig: profile.url is used when nothing else is set', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    await withServer(jsonServer({ status: 'ok' }), async (base) => {
      // Write a profile that points at our mock server.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(tmp, 'stratos'), { recursive: true });
      await writeFile(join(tmp, 'stratos', 'config.json'),
        JSON.stringify({ profiles: { default: { url: base, account_key: 'pkey', timeout_ms: 5000, max_retries: 1 } } }),
        { mode: 0o600 });
      const r = await runAsync(['health'], { XDG_CONFIG_HOME: tmp });
      assert.equal(r.status, 0);
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('envConfig: profile.account_key used in jsonReq when env/flag absent', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    let receivedKey;
    await withServer((req, res) => {
      receivedKey = req.headers.accountkey;
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => { res.writeHead(200); res.end('{"ok":true}'); });
    }, async (base) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(tmp, 'stratos'), { recursive: true });
      await writeFile(join(tmp, 'stratos', 'config.json'),
        JSON.stringify({ profiles: { default: { url: base, account_key: 'profile-key' } } }),
        { mode: 0o600 });
      await runAsync(['purge', 'https://x'], { XDG_CONFIG_HOME: tmp });
      assert.equal(receivedKey, 'profile-key');
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('envConfig: STRATOS_PROFILE env selects a profile', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    await withServer(jsonServer({ status: 'ok' }), async (base) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(tmp, 'stratos'), { recursive: true });
      await writeFile(join(tmp, 'stratos', 'config.json'),
        JSON.stringify({ profiles: { other: { url: base } } }),
        { mode: 0o600 });
      const r = await runAsync(['health'],
        { XDG_CONFIG_HOME: tmp, STRATOS_PROFILE: 'other' });
      assert.equal(r.status, 0);
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('envConfig: --timeout flag overrides env', async () => {
  // Use a hanging server with --timeout 100 → fast EX_TEMPFAIL.
  await withServer(() => { /* never respond */ }, async (base) => {
    const start = Date.now();
    const r = await runAsync(['health', '--timeout', '150', '--retries', '0'],
      { CLOUDCDN_URL: base, CLOUDCDN_TIMEOUT: '60000' });
    assert.equal(r.status, 75);
    assert.ok(Date.now() - start < 5000, 'flag --timeout should beat env');
  });
});

test('envConfig: --retries flag overrides env', async () => {
  let hits = 0;
  await withServer((req, res) => {
    hits++;
    res.writeHead(503); res.end('{"err":"x"}');
  }, async (base) => {
    await runAsync(['health', '--retries', '0'],
      { CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '5' });
    // 0 retries means 1 attempt total.
    assert.equal(hits, 1);
  });
});

test('envConfig: SIGNED_URL_SECRET env is used when no --secret flag', async () => {
  const r = await runAsync(['signed', '/x', '--expires', '999'],
    { SIGNED_URL_SECRET: 'envsecret' });
  assert.equal(r.status, 0);
});

test('envConfig: profile.signed_url_secret falls back when neither flag nor env set', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(tmp, 'stratos'), { recursive: true });
    await writeFile(join(tmp, 'stratos', 'config.json'),
      JSON.stringify({ profiles: { default: { signed_url_secret: 'profile-secret' } } }),
      { mode: 0o600 });
    const r = await runAsync(['signed', '/x', '--expires', '999'],
      { XDG_CONFIG_HOME: tmp });
    assert.equal(r.status, 0);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// jsonReq edge cases.
// ─────────────────────────────────────────────────────────────────────────────

test('jsonReq: read role with neither ACCESS_KEY nor ACCOUNT_KEY → no auth headers', async () => {
  let receivedHeaders;
  await withServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200); res.end('{"ok":true}');
  }, async (base) => {
    await runAsync(['health'], { CLOUDCDN_URL: base });
    assert.equal(receivedHeaders.accountkey, undefined);
    assert.equal(receivedHeaders.accesskey, undefined);
  });
});

test('jsonReq: read role with ACCOUNT_KEY only sends AccountKey (fallback path)', async () => {
  let receivedHeaders;
  await withServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200); res.end('{"ok":true}');
  }, async (base) => {
    await runAsync(['health'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'kk' });
    assert.equal(receivedHeaders.accountkey, 'kk');
    assert.equal(receivedHeaders.accesskey, undefined);
  });
});

test('jsonReq: returns text body when response is not JSON', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('plain-text-not-json');
  }, async (base) => {
    const r = await runAsync(['health'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /plain-text-not-json/);
  });
});

test('jsonReq: 429 retries then succeeds', async () => {
  let hits = 0;
  await withServer((req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(429); res.end('{"err":"rate"}'); }
    else { res.writeHead(200); res.end('{"ok":true}'); }
  }, async (base) => {
    const r = await runAsync(['health'], { CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '1' });
    assert.equal(r.status, 0);
    assert.equal(hits, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Misc small branches.
// ─────────────────────────────────────────────────────────────────────────────

test('info(): --quiet suppresses the "info:" prefix path', async () => {
  await withServer(jsonServer({ Page: 1, TotalPages: 1, Data: [{ Path: '/x.svg', Format: 'svg', Size: 1, ContentType: 'i/s' }] }),
    async (base) => {
      const r = await runAsync(['assets', '-q'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /info:/);
    });
});

test('emitList: empty list with --json emits []', async () => {
  await withServer(jsonServer({ webhooks: [] }), async (base) => {
    const r = await runAsync(['webhooks', 'list', '--json'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '[]');
  });
});

test('audit: response body as plain array (no `logs` wrapper)', async () => {
  await withServer(jsonServer([
    { timestamp: '2026-05-30', action: 'x', actor: 'a', target: 't' },
  ]), async (base) => {
    const r = await runAsync(['audit', '--json'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].action, 'x');
  });
});

test('search: response body as plain array (no `results` wrapper)', async () => {
  await withServer(jsonServer([{ path: '/a', score: 1, type: 'i' }]),
    async (base) => {
      const r = await runAsync(['search', 'q', '--json'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.equal(rows[0].path, '/a');
    });
});

test('insights top: response body as plain array', async () => {
  await withServer(jsonServer([{ path: '/x', requests: 10, bytes: 100 }]),
    async (base) => {
      const r = await runAsync(['insights', 'top', '--json'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.equal(rows.length, 1);
    });
});

test('insights geo: response body as plain array', async () => {
  await withServer(jsonServer([{ country: 'GB', requests: 1, bytes: 100 }]),
    async (base) => {
      const r = await runAsync(['insights', 'geo', '--json'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.equal(rows[0].country, 'GB');
    });
});

test('zones list: response body as plain array', async () => {
  await withServer(jsonServer([{ name: 'z', domains: ['a.com'], createdAt: '2026' }]),
    async (base) => {
      const r = await runAsync(['zones', 'list', '--json'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.equal(rows[0].name, 'z');
    });
});

test('tokens list: response body as plain array', async () => {
  await withServer(jsonServer([{ id: 't', name: 'x', scopes: [], createdAt: '2026', expiresAt: '2026' }]),
    async (base) => {
      const r = await runAsync(['tokens', 'list', '--json'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.equal(rows[0].id, 't');
    });
});

test('webhooks list: response body as plain array', async () => {
  await withServer(jsonServer([{ id: 'w', url: 'https://x', events: [], createdAt: '2026' }]),
    async (base) => {
      const r = await runAsync(['webhooks', 'list', '--json'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.equal(rows[0].id, 'w');
    });
});

test('logs query: response body as plain array', async () => {
  await withServer(jsonServer([{ timestamp: '2026', level: 'info', message: 'hello' }]),
    async (base) => {
      const r = await runAsync(['logs', 'query', '--json'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      const rows = JSON.parse(r.stdout);
      assert.equal(rows[0].message, 'hello');
    });
});

test('storage ls: AccountKey fallback when AccessKey unset', async () => {
  let headers;
  await withServer((req, res) => {
    headers = req.headers;
    res.writeHead(200); res.end('[]');
  }, async (base) => {
    await runAsync(['storage', 'ls', '/d/'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(headers.accountkey, 'k');
  });
});

test('storage sync: empty directory makes 0 batches', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-empty-'));
  try {
    const r = await runAsync(['storage', 'sync', tmp, '/site'],
      { CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /0 file/);
    assert.match(r.stderr, /sync complete/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('storage sync: nested dirs walked recursively', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-nest-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(tmp, 'sub'), { recursive: true });
  await writeFile(join(tmp, 'a.html'), 'a');
  await writeFile(join(tmp, 'sub', 'b.html'), 'b');
  try {
    let received;
    await withServer((req, res) => {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200); res.end('{"ok":true}');
      });
    }, async (base) => {
      const r = await runAsync(['storage', 'sync', tmp, '/x'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      const paths = received.files.map((f) => f.path).sort();
      assert.deepEqual(paths, ['/x/a.html', '/x/sub/b.html']);
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('pipeline submit: flags map alternate names (--gen-favicons etc)', async () => {
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
        res.writeHead(200); res.end('{"ok":true}');
      });
    }, async (base) => {
      const r = await runAsync(
        ['pipeline', 'submit', '--svg', svg, '--name', 'a',
         '--gen-favicons', '--gen-icons', '--gen-banners'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.equal(received.generateFavicon, true);
      assert.equal(received.generateIcons, true);
      assert.equal(received.generateBanners, true);
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('insights summary: --zone forwarded', async () => {
  let url;
  await withServer((req, res) => { url = req.url; res.writeHead(200); res.end('{"x":1}'); },
    async (base) => {
      await runAsync(['insights', 'summary', '--zone', 'akande'], { CLOUDCDN_URL: base });
      assert.match(url, /zone=akande/);
    });
});

test('image transform: no options builds bare URL', async () => {
  const r = await runAsync(['image', 'transform', 'https://x/i.jpg'],
    { CLOUDCDN_URL: 'https://example.com' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\/api\/transform\?url=/);
  assert.doesNotMatch(r.stdout, /w=/);
});

test('image blurhash: no --size uses server default', async () => {
  let url;
  await withServer((req, res) => { url = req.url; res.writeHead(200); res.end('{"hash":"x"}'); },
    async (base) => {
      await runAsync(['image', 'blurhash', 'https://x/i.jpg'], { CLOUDCDN_URL: base });
      assert.doesNotMatch(url, /size=/);
    });
});

test('image lqip: no flags emits just the url param', async () => {
  let url;
  await withServer((req, res) => { url = req.url; res.writeHead(200); res.end('{"d":"x"}'); },
    async (base) => {
      await runAsync(['image', 'lqip', 'https://x/i.jpg'], { CLOUDCDN_URL: base });
      assert.match(url, /url=/);
      assert.doesNotMatch(url, /size=/);
    });
});

test('image auto: no --anim flag', async () => {
  let url;
  await withServer((req, res) => { url = req.url; res.writeHead(200); res.end('{"f":"webp"}'); },
    async (base) => {
      await runAsync(['image', 'auto', '/x.gif'], { CLOUDCDN_URL: base });
      assert.match(url, /path=/);
      assert.doesNotMatch(url, /anim=/);
    });
});

test('stream: no quality/segment → bare URL', async () => {
  const r = await runAsync(['stream', 'nature'], { CLOUDCDN_URL: 'https://example.com' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\/api\/stream\?video=nature/);
  assert.doesNotMatch(r.stdout, /quality=/);
});

test('insights asset: response body unstructured falls through to emit', async () => {
  await withServer(jsonServer({ requests: 42 }), async (base) => {
    const r = await runAsync(['insights', 'asset', '/x.svg'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"requests"/);
  });
});
