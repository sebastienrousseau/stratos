// SPDX-License-Identifier: MIT
//
// Integration tests against an in-process mock server.
// Uses async spawn so the event loop stays free to service mock-server I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      const { port } = srv.address();
      try {
        const result = await fn(`http://127.0.0.1:${port}`);
        srv.close();
        resolve(result);
      } catch (e) { srv.close(); reject(e); }
    });
  });
}

function runAsync(args, env = {}, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env: { ...process.env, ...env, NO_COLOR: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ stdout, stderr, status: code }));
    if (opts.input) { child.stdin.end(opts.input); }
  });
}

test('health: 200 → exit 0, JSON body emitted', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/api/health');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  }, async (base) => {
    const r = await runAsync(['health'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"status":\s*"ok"/);
  });
});

test('health: 503 → exit EX_TEMPFAIL (75) after retries, error on stderr', async () => {
  let hits = 0;
  await withServer((req, res) => {
    hits++;
    res.writeHead(503); res.end('{"err":"down"}');
  }, async (base) => {
    const r = await runAsync(['health'], { CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '1' });
    assert.equal(r.status, 75);
    assert.match(r.stderr, /down/);
    assert.ok(hits >= 2, `expected at least 2 hits, got ${hits}`);
  });
});

test('health: 401 → exit EX_NOPERM (77)', async () => {
  await withServer((req, res) => {
    res.writeHead(401); res.end('{"err":"no key"}');
  }, async (base) => {
    const r = await runAsync(['health'], { CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '0' });
    assert.equal(r.status, 77);
  });
});

test('health: errors go to stderr, not stdout (regression for v0.0.1 bug)', async () => {
  await withServer((req, res) => {
    res.writeHead(404); res.end('{"err":"missing"}');
  }, async (base) => {
    const r = await runAsync(['health'], { CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '0' });
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /missing/);
  });
});

test('purge: sends AccountKey + x-api-key headers', async () => {
  let received;
  await withServer((req, res) => {
    received = { url: req.url, method: req.method, headers: req.headers };
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      received.body = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  }, async (base) => {
    const r = await runAsync(['purge', 'https://cloudcdn.pro/a'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'secret-key' });
    assert.equal(r.status, 0);
    assert.equal(received.method, 'POST');
    assert.equal(received.headers.accountkey, 'secret-key');
    assert.equal(received.headers['x-api-key'], 'secret-key');
    assert.deepEqual(JSON.parse(received.body), { urls: ['https://cloudcdn.pro/a'] });
  });
});

test('purge: multi-tag actually sends every tag (the v0.0.1 bug)', async () => {
  let received;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200); res.end('{"ok":true}');
    });
  }, async (base) => {
    await runAsync(['purge', '--tag', 'a', '--tag', 'b', '--tag', 'c'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.deepEqual(received.tags, ['a', 'b', 'c']);
  });
});

test('assets: GET with query params', async () => {
  let receivedUrl;
  await withServer((req, res) => {
    receivedUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Data: [{ Path: '/a.svg', Format: 'svg', Size: 1024, ContentType: 'image/svg+xml' }] }));
  }, async (base) => {
    const r = await runAsync(['assets', '--project=akande', '--format=svg', '--page=2', '--json'],
      { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(receivedUrl, /project=akande/);
    assert.match(receivedUrl, /format=svg/);
    assert.match(receivedUrl, /page=2/);
  });
});

test('assets show: hits /api/assets/metadata?path=…', async () => {
  let receivedUrl;
  await withServer((req, res) => {
    receivedUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"Path":"/x.svg"}');
  }, async (base) => {
    const r = await runAsync(['assets', 'show', '/x.svg'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(receivedUrl, /\/api\/assets\/metadata\?path=%2Fx\.svg/);
  });
});

test('insights summary: passes days param', async () => {
  let receivedUrl;
  await withServer((req, res) => {
    receivedUrl = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"total":1}');
  }, async (base) => {
    const r = await runAsync(['insights', 'summary', '--days', '30'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(receivedUrl, /\/api\/insights\/summary\?days=30/);
  });
});

test('zones list: hits /api/core/zones with AccountKey', async () => {
  let receivedHeaders;
  await withServer((req, res) => {
    receivedHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"zones":[{"name":"a","domains":["a.com"],"createdAt":"2026-05-01"}]}');
  }, async (base) => {
    const r = await runAsync(['zones', '--json'], { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    assert.equal(receivedHeaders.accountkey, 'k');
  });
});

test('verbose mode traces requests to stderr', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end('{"ok":true}');
  }, async (base) => {
    const r = await runAsync(['health', '--verbose'], { CLOUDCDN_URL: base });
    assert.match(r.stderr, /GET .+\/api\/health/);
  });
});

test('--timeout aborts a hanging request', async () => {
  await withServer(() => {
    // Never respond.
  }, async (base) => {
    const r = await runAsync(['health', '--timeout', '200', '--retries', '0'],
      { CLOUDCDN_URL: base });
    assert.equal(r.status, 75);
  });
});

test('purge: stdin URLs (async)', async () => {
  let received;
  await withServer((req, res) => {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => {
      received = JSON.parse(body);
      res.writeHead(200); res.end('{"ok":true}');
    });
  }, async (base) => {
    await runAsync(['purge', '-'], { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' },
      { input: 'https://cloudcdn.pro/a\nhttps://cloudcdn.pro/b\n' });
    assert.deepEqual(received.urls, ['https://cloudcdn.pro/a', 'https://cloudcdn.pro/b']);
  });
});

test('user-agent identifies stratos', async () => {
  let received;
  await withServer((req, res) => {
    received = req.headers['user-agent'];
    res.writeHead(200); res.end('{"ok":true}');
  }, async (base) => {
    await runAsync(['health'], { CLOUDCDN_URL: base });
    assert.match(received, /^stratos\//);
  });
});
