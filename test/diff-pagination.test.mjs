// SPDX-License-Identifier: MIT
//
// Tests for `rules diff` (with the LCS line diff) and `assets --all` (auto-pagination).

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

function runAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env: { ...process.env, STRATOS_CI: '0', ...env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ stdout, stderr, status: code }));
  });
}

test('rules diff: identical content exits 0 (no drift)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-'));
  const local = join(tmp, '_headers');
  await writeFile(local, '/api/*\n  Cache-Control: no-store\n');
  try {
    await withServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Content: '/api/*\n  Cache-Control: no-store\n' }));
    }, async (base) => {
      const r = await runAsync(['rules', 'diff', '_headers', '-f', local],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /identical/);
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('rules diff: drift exits 69 and prints +/- lines', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-'));
  const local = join(tmp, '_headers');
  await writeFile(local, '/api/*\n  Cache-Control: no-store\n  X-New: yes\n');
  try {
    await withServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Content: '/api/*\n  Cache-Control: public\n' }));
    }, async (base) => {
      const r = await runAsync(['rules', 'diff', '_headers', '-f', local],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      assert.equal(r.status, 69);
      assert.match(r.stdout, /--- remote\/_headers/);
      assert.match(r.stdout, /\+\+\+ local\//);
      // No-store should be added, public removed
      assert.match(r.stdout, /\+\s*Cache-Control: no-store/);
      assert.match(r.stdout, /-\s*Cache-Control: public/);
      assert.match(r.stdout, /\+\s*X-New: yes/);
    });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('rules diff: rejects invalid filename', async () => {
  const r = await runAsync(['rules', 'diff', 'bogus', '-f', '/dev/null'],
    { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 64);
});

test('assets --all: walks pages until TotalPages reached', async () => {
  let pageHits = 0;
  await withServer((req, res) => {
    const m = req.url.match(/page=(\d+)/);
    const page = m ? Number(m[1]) : 1;
    pageHits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      Page: page,
      TotalPages: 3,
      Data: [{ Path: `/p${page}-a.svg`, Format: 'svg', Size: 1, ContentType: 'image/svg+xml' }],
    }));
  }, async (base) => {
    const r = await runAsync(['assets', '--all', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.Path),
      ['/p1-a.svg', '/p2-a.svg', '/p3-a.svg']);
    assert.equal(pageHits, 3);
  });
});

test('assets --all: stops on empty page even without TotalPages', async () => {
  await withServer((req, res) => {
    const m = req.url.match(/page=(\d+)/);
    const page = m ? Number(m[1]) : 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      Page: page,
      Data: page <= 2 ? [{ Path: `/x${page}.svg`, Format: 'svg', Size: 1, ContentType: 'i/s' }] : [],
    }));
  }, async (base) => {
    const r = await runAsync(['assets', '--all', '--json'], { CLOUDCDN_URL: base });
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 2);
  });
});

test('assets: single-page (no --all) hits one URL', async () => {
  let hits = 0;
  await withServer((req, res) => {
    hits++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Page: 1, TotalPages: 10, Data: [{ Path: '/x.svg', Format: 'svg', Size: 1, ContentType: 'i/s' }] }));
  }, async (base) => {
    const r = await runAsync(['assets', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.equal(hits, 1);
  });
});
