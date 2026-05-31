// SPDX-License-Identifier: MIT
//
// Tests for doctor, bench, login status — environment-introspection commands.

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
      try { const r = await fn(`http://127.0.0.1:${port}`); srv.close(); resolve(r); }
      catch (e) { srv.close(); reject(e); }
    });
  });
}

function runAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env: { ...process.env, ...env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ stdout, stderr, status: code }));
  });
}

test('doctor: reports node version, config, keychain, reachability', async () => {
  await withServer((req, res) => {
    res.writeHead(200); res.end('{"status":"ok"}');
  }, async (base) => {
    const r = await runAsync(['doctor', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0, `stderr was: ${r.stderr}`);
    const checks = JSON.parse(r.stdout);
    assert.ok(Array.isArray(checks));
    assert.ok(checks.find((c) => c.name.startsWith('Node')));
    assert.ok(checks.find((c) => c.name.startsWith('Config file')));
    assert.ok(checks.find((c) => c.name.startsWith('Reach')));
    assert.ok(checks.find((c) => c.name.startsWith('Reach')).ok);
  });
});

test('doctor: fails (exit 69) when network is down', async () => {
  const r = await runAsync(['doctor'],
    { CLOUDCDN_URL: 'http://127.0.0.1:1', CLOUDCDN_RETRIES: '0', CLOUDCDN_TIMEOUT: '500' });
  assert.equal(r.status, 69);
});

test('doctor: text mode renders table with green/red statuses', async () => {
  await withServer((req, res) => { res.writeHead(200); res.end('{"status":"ok"}'); },
    async (base) => {
      const r = await runAsync(['doctor'], { CLOUDCDN_URL: base });
      assert.match(r.stdout, /CHECK\s+STATUS\s+DETAIL/);
      assert.match(r.stdout, /Node ≥ 20/);
    });
});

test('bench: samples N + 1 latencies, emits JSON with summary', async () => {
  let hits = 0;
  await withServer((req, res) => {
    hits++;
    res.writeHead(200); res.end('{"status":"ok"}');
  }, async (base) => {
    const r = await runAsync(['bench', '-n', '3', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const stats = JSON.parse(r.stdout);
    assert.equal(stats.samples.length, 3);
    assert.equal(stats.summary.n_ok, 3);
    assert.ok(stats.summary.cold_start_ms > 0);
    assert.ok(stats.summary.p50_ms >= 0);
    // The bench function makes 3 calls, then spawns a child which loads the
    // module but `cmdBench` only runs when called as `bench`, so the
    // version subprocess does NOT call the server.
    assert.equal(hits, 3);
  });
});

test('bench: text mode renders summary line', async () => {
  await withServer((req, res) => { res.writeHead(200); res.end('{"status":"ok"}'); },
    async (base) => {
      const r = await runAsync(['bench', '-n', '2'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /cold start/);
      assert.match(r.stdout, /requests.*2\/2 ok/);
    });
});

test('login status: prints masked keys and never leaks the raw value', async () => {
  const r = await runAsync(['login', 'status', '--json'], {
    CLOUDCDN_ACCOUNT_KEY: 'cdnsk_supersecretkeyvalue123',
    CLOUDCDN_ACCESS_KEY: 'cdnsk_anothersecretkey',
    SIGNED_URL_SECRET: 'extremely-confidential',
  });
  assert.equal(r.status, 0);
  const rows = JSON.parse(r.stdout);
  // None of the row VALUES contain the raw secret in full.
  for (const row of rows) {
    assert.ok(!/supersecretkeyvalue/.test(row.value),
      `value leaked raw secret: ${row.value}`);
    assert.ok(!/extremely-confidential/.test(row.value));
  }
  // But the prefix + suffix pattern *is* visible.
  const accRow = rows.find((r) => r.key === 'account_key');
  assert.match(accRow.value, /cdnsk_/);
  assert.match(accRow.value, /23$/);
});

test('login status: unset keys show "(unset)"', async () => {
  const r = await runAsync(['login', 'status'], {
    CLOUDCDN_ACCOUNT_KEY: '',
    CLOUDCDN_ACCESS_KEY: '',
    SIGNED_URL_SECRET: '',
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\(unset\)/);
});
