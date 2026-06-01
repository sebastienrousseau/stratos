// SPDX-License-Identifier: MIT
//
// Tests for v0.0.3 features: fuzzy "did you mean?", CI mode auto-detect,
// GitHub workflow-command framing, --dry-run symmetry on destructive ops,
// MCP protocol version bump.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

function runClean(args, env = {}) {
  // Strip all inherited CLOUDCDN_*/CI/GITHUB_*/etc env so each test
  // controls its own context.
  const baseEnv = { ...process.env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' };
  for (const k of [
    'CLOUDCDN_URL','CLOUDCDN_ACCOUNT_KEY','CLOUDCDN_ACCESS_KEY','SIGNED_URL_SECRET',
    'CLOUDCDN_TIMEOUT','CLOUDCDN_RETRIES','STRATOS_PROFILE',
    'GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','JENKINS_URL','TF_BUILD','CI','STRATOS_CI',
  ]) delete baseEnv[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env: { ...baseEnv, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ stdout, stderr, status: code }));
  });
}

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      try { const r = await fn(`http://127.0.0.1:${srv.address().port}`); srv.close(); resolve(r); }
      catch (e) { srv.close(); reject(e); }
    });
  });
}

const jsonServer = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy "did you mean?"
// ─────────────────────────────────────────────────────────────────────────────

test('suggest: close typo suggests the closest command', async () => {
  const r = await runClean(['prge']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Did you mean "purge"\?/);
});

test('suggest: subtle typo (heath → health)', async () => {
  const r = await runClean(['heath']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Did you mean "health"\?/);
});

test('suggest: longer typo with one transposition (assests → assets)', async () => {
  const r = await runClean(['assests']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Did you mean "assets"\?/);
});

test('suggest: nothing close enough → no suggestion', async () => {
  const r = await runClean(['xyzqqq']);
  assert.equal(r.status, 64);
  assert.doesNotMatch(r.stderr, /Did you mean/);
});

test('suggest: one-character input → no suggestion (too short)', async () => {
  const r = await runClean(['x']);
  assert.equal(r.status, 64);
  assert.doesNotMatch(r.stderr, /Did you mean/);
});

// ─────────────────────────────────────────────────────────────────────────────
// CI mode auto-detect.
// ─────────────────────────────────────────────────────────────────────────────

test('CI: GITHUB_ACTIONS auto-enables --json (compact, single line)', async () => {
  await withServer(jsonServer({ status: 'ok', deep: false }), async (base) => {
    const r = await runClean(['health'], { CLOUDCDN_URL: base, GITHUB_ACTIONS: 'true' });
    assert.equal(r.status, 0);
    // Compact JSON → single line, no leading newline.
    assert.match(r.stdout, /^\{"status":"ok"/);
  });
});

test('CI: GITHUB_ACTIONS auto-enables --quiet (info: suppressed)', async () => {
  await withServer(jsonServer({ Page: 1, TotalPages: 1, Data: [{ Path: '/x.svg', Format: 'svg', Size: 1, ContentType: 'image/svg+xml' }] }),
    async (base) => {
      const r = await runClean(['assets'], { CLOUDCDN_URL: base, GITHUB_ACTIONS: 'true' });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /info:/);
    });
});

test('CI: generic CI env (CI=true) also triggers auto-mode', async () => {
  await withServer(jsonServer({ ok: true }), async (base) => {
    const r = await runClean(['health'], { CLOUDCDN_URL: base, CI: 'true' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^\{/);
  });
});

test('CI: GitLab, CircleCI, Jenkins, Azure are recognised', async () => {
  for (const env of [
    { GITLAB_CI: 'true' },
    { CIRCLECI: 'true' },
    { JENKINS_URL: 'http://j.example/' },
    { TF_BUILD: 'True' },
  ]) {
    await withServer(jsonServer({ ok: 1 }), async (base) => {
      const r = await runClean(['health'], { CLOUDCDN_URL: base, ...env });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^\{/);
    });
  }
});

test('CI: STRATOS_CI=0 opts out even when GITHUB_ACTIONS is set', async () => {
  await withServer(jsonServer({ ok: true }), async (base) => {
    const r = await runClean(['health'],
      { CLOUDCDN_URL: base, GITHUB_ACTIONS: 'true', STRATOS_CI: '0' });
    assert.equal(r.status, 0);
    // No GH auto-mode → not piped, but stdout still isn't TTY → JSON still
    // emitted compact via the existing non-TTY default; the difference is
    // that --quiet is NOT forced. We just verify it ran cleanly.
    assert.match(r.stdout, /"ok"/);
  });
});

test('CI: STRATOS_CI=1 forces generic CI mode without a known host', async () => {
  await withServer(jsonServer({ Page: 1, TotalPages: 1, Data: [{ Path: '/x.svg', Format: 'svg', Size: 1, ContentType: 'i/s' }] }),
    async (base) => {
      const r = await runClean(['assets'], { CLOUDCDN_URL: base, STRATOS_CI: '1' });
      assert.equal(r.status, 0);
      assert.doesNotMatch(r.stderr, /info:/);
    });
});

test('CI: --no-json overrides the CI auto-default', async () => {
  await withServer(jsonServer({ Page: 1, TotalPages: 1, Data: [{ Path: '/x.svg', Format: 'svg', Size: 1, ContentType: 'i/s' }] }),
    async (base) => {
      const r = await runClean(['assets', '--no-json'],
        { CLOUDCDN_URL: base, CI: 'true', STRATOS_FORCE_TTY: '1' });
      assert.equal(r.status, 0);
      // With JSON disabled + TTY forced, we get the table renderer.
      assert.match(r.stdout, /PATH\s+FORMAT/);
    });
});

test('CI: --no-quiet overrides the CI auto-default', async () => {
  await withServer(jsonServer({ Page: 1, TotalPages: 1, Data: [{ Path: '/x.svg', Format: 'svg', Size: 1, ContentType: 'i/s' }] }),
    async (base) => {
      const r = await runClean(['assets', '--no-quiet'],
        { CLOUDCDN_URL: base, CI: 'true' });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /info:/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Actions workflow-command framing.
// ─────────────────────────────────────────────────────────────────────────────

test('GH workflow command: ::error:: emitted on fatal', async () => {
  const r = await runClean(['bogus-command'], { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /::error title=stratos \(exit 64\)::unknown command: bogus-command/);
});

test('GH workflow command: NOT emitted outside GitHub Actions', async () => {
  const r = await runClean(['bogus-command']);
  assert.equal(r.status, 64);
  assert.doesNotMatch(r.stderr, /::error/);
});

test('GH workflow command: multi-line error message collapsed to one line', async () => {
  // Trigger a multi-line error via fuzzy suggestion.
  const r = await runClean(['prge'], { GITHUB_ACTIONS: 'true' });
  assert.equal(r.status, 64);
  // Workflow command line is single-line.
  const wf = r.stderr.split('\n').find((l) => l.startsWith('::error'));
  assert.ok(wf, `no ::error line in:\n${r.stderr}`);
  assert.doesNotMatch(wf, /\n/);
  assert.match(wf, /Did you mean "purge"/);
});

// ─────────────────────────────────────────────────────────────────────────────
// --dry-run symmetry on destructive ops.
// ─────────────────────────────────────────────────────────────────────────────

test('zones rm --dry-run: prints would-DELETE, no server hit', async () => {
  let hit = false;
  await withServer((req, res) => { hit = true; res.end('{}'); }, async (base) => {
    const r = await runClean(['zones', 'rm', 'z1', '--dry-run'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.dry_run, true);
    assert.equal(body.would_send.method, 'DELETE');
    assert.match(body.would_send.path, /\/api\/core\/zones\/z1/);
    assert.equal(hit, false, 'server must not be contacted in --dry-run');
  });
});

test('tokens rm --dry-run: prints would-DELETE, no server hit', async () => {
  let hit = false;
  await withServer((req, res) => { hit = true; res.end('{}'); }, async (base) => {
    const r = await runClean(['tokens', 'rm', 't1', '--dry-run'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.dry_run, true);
    assert.match(body.would_send.path, /\/api\/tokens\?id=t1/);
    assert.equal(hit, false);
  });
});

test('webhooks rm --dry-run: prints would-DELETE, no server hit', async () => {
  let hit = false;
  await withServer((req, res) => { hit = true; res.end('{}'); }, async (base) => {
    const r = await runClean(['webhooks', 'rm', 'w1', '--dry-run'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.dry_run, true);
    assert.match(body.would_send.path, /\/api\/webhooks\?id=w1/);
    assert.equal(hit, false);
  });
});

test('storage rm --dry-run: prints would-DELETE, no server hit', async () => {
  let hit = false;
  await withServer((req, res) => { hit = true; res.end('{}'); }, async (base) => {
    const r = await runClean(['storage', 'rm', 'site/x.bin', '--dry-run'],
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.dry_run, true);
    assert.match(body.would_send.path, /\/api\/storage\/site\/x\.bin/);
    assert.equal(hit, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP protocol version bump.
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

test('mcp: initialize reports protocolVersion 2025-11-25 (stable spec)', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(r.result.protocolVersion, '2025-11-25');
});
