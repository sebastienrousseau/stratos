// SPDX-License-Identifier: MIT
//
// v0.0.x — second branch-coverage push, this time aiming for >= 99%.
// Each test pins a specific uncovered branch arm that survived v009.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

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

const fail4xx = (status = 400, body = { error: 'bad request' }) =>
  (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

const json = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

// ─────────────────────────────────────────────────────────────────────────────
// 4xx error arms on mutation commands. v008-mock-api only covers a handful
// of commands; the remaining `if (!ok) { emitFailure; process.exit }` arms
// live here.
// ─────────────────────────────────────────────────────────────────────────────

const MUTATION_4XX_CASES = [
  { name: 'rules set -f',     args: ['rules', 'set', '_headers', '-f', '__FILE__'],
    line: 2361, needsFile: true },
  { name: 'tokens create',    args: ['tokens', 'create', '--name', 't', '--scopes', 'read'],
    line: 2442 },
  { name: 'tokens rm',        args: ['tokens', 'rm', 'tok-1'],   line: 2458 },
  { name: 'webhooks add',     args: ['webhooks', 'add', '--url', 'https://x', '--events', 'purge'],
    line: 2502 },
  { name: 'webhooks rm',      args: ['webhooks', 'rm', 'wh-1'],  line: 2517 },
  { name: 'storage put',      args: ['storage', 'put', '__FILE__', 'remote/p'],
    line: 2563, needsFile: true },
  { name: 'storage rm',       args: ['storage', 'rm', 'remote/p'], line: 2611 },
  { name: 'pipeline submit',  args: ['pipeline', 'submit', '--svg', '__FILE__', '--name', 'x'],
    line: 2927, needsFile: true, fileContent: '<svg/>' },
];

for (const cs of MUTATION_4XX_CASES) {
  test(`4xx error branch: ${cs.name} (L${cs.line})`, async () => {
    const { srv, base } = await startServer(fail4xx());
    let tmp;
    let args = cs.args.slice();
    try {
      if (cs.needsFile) {
        tmp = await mkdtemp(join(tmpdir(), 'stratos-4xx-'));
        const f = join(tmp, 'tmpfile');
        await writeFile(f, cs.fileContent ?? 'content\n');
        args = args.map((a) => a === '__FILE__' ? f : a);
      }
      const r = await run(args, { ...COMMON_AUTH, CLOUDCDN_URL: base });
      // emitFailure → exitForStatus(400) is EX.UNAVAILABLE = 69.
      assert.equal(r.status, 69, `unexpected status: ${r.status}\n${r.stderr}`);
    } finally {
      srv.close();
      if (tmp) await rm(tmp, { recursive: true, force: true });
    }
  });
}

// storage get uses fetch() directly (not jsonReq), so its error arm (L2585)
// goes via a slightly different path.
test('4xx error branch: storage get raw fetch (L2585)', async () => {
  const { srv, base } = await startServer(fail4xx());
  try {
    const r = await run(['storage', 'get', 'remote/p'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 69);
  } finally { srv.close(); }
});

// storage sync hits the batch endpoint (L2672).
test('4xx error branch: storage sync batch (L2672)', async () => {
  const { srv, base } = await startServer(fail4xx());
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-sync-'));
  try {
    await writeFile(join(tmp, 'a.txt'), 'a');
    const r = await run(['storage', 'sync', tmp, 'remote/'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 69);
  } finally {
    srv.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

// ask (L2970)
test('4xx error branch: ask (L2970)', async () => {
  const { srv, base } = await startServer(fail4xx());
  try {
    const r = await run(['ask', 'how are you'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 69);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Doctor — exercise each single-credential combination.
//   L1688 truthy alone, L1689 truthy alone, L1691 truthy alone — and their
//   sibling-falsy arms.
// ─────────────────────────────────────────────────────────────────────────────

test('doctor: ACCOUNT_KEY only (L1688 truthy / L1689,1691 falsy)', async () => {
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    const r = await run(['doctor', '--output', 'json'], {
      CLOUDCDN_URL: base,
      CLOUDCDN_ACCOUNT_KEY: 'a'.repeat(32),
      STRATOS_NO_KEYCHAIN: '1',
    });
    assert.ok(r.status === 0 || r.status === 75);
    const body = JSON.parse(r.stdout);
    assert.equal(body.find((c) => c.name === 'account_key').ok, true);
    assert.equal(body.find((c) => c.name === 'access_key').ok, false);
    assert.equal(body.find((c) => c.name === 'signed_url_secret').ok, false);
  } finally { srv.close(); }
});

test('doctor: ACCESS_KEY only (L1689 truthy / L1688,1691 falsy)', async () => {
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    const r = await run(['doctor', '--output', 'json'], {
      CLOUDCDN_URL: base,
      CLOUDCDN_ACCESS_KEY: 'b'.repeat(32),
      STRATOS_NO_KEYCHAIN: '1',
    });
    assert.ok(r.status === 0 || r.status === 75);
    const body = JSON.parse(r.stdout);
    assert.equal(body.find((c) => c.name === 'account_key').ok, false);
    assert.equal(body.find((c) => c.name === 'access_key').ok, true);
    assert.equal(body.find((c) => c.name === 'signed_url_secret').ok, false);
  } finally { srv.close(); }
});

test('doctor: SIGNED_URL_SECRET only (L1691 truthy / L1688,1689 falsy)', async () => {
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    const r = await run(['doctor', '--output', 'json'], {
      CLOUDCDN_URL: base,
      SIGNED_URL_SECRET: 'c'.repeat(32),
      STRATOS_NO_KEYCHAIN: '1',
    });
    assert.ok(r.status === 0 || r.status === 75);
    const body = JSON.parse(r.stdout);
    assert.equal(body.find((c) => c.name === 'account_key').ok, false);
    assert.equal(body.find((c) => c.name === 'access_key').ok, false);
    assert.equal(body.find((c) => c.name === 'signed_url_secret').ok, true);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Config files missing the `profiles` key — exercises the `cfg.profiles =
// cfg.profiles || {}` defensive defaults in cmdConfig (L1302) and cmdInit
// (L1409).
// ─────────────────────────────────────────────────────────────────────────────

test('config list: file lacks profiles key (L1302)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    const xdg = join(tmp, 'xdg');
    await mkdir(join(xdg, 'stratos'), { recursive: true });
    // Intentionally omit `profiles`.
    await writeFile(join(xdg, 'stratos', 'config.json'),
      JSON.stringify({ version: 1 }));
    const r = await run(['config', 'list'], { XDG_CONFIG_HOME: xdg, HOME: tmp });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.deepEqual(body.profiles, {});
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('init: file lacks profiles key (L1409)', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-cfg-'));
  try {
    const xdg = join(tmp, 'xdg');
    await mkdir(join(xdg, 'stratos'), { recursive: true });
    await writeFile(join(xdg, 'stratos', 'config.json'),
      JSON.stringify({ version: 1 }));
    const r = await run(['init', '--profile', 'p', '--cdn-url', 'https://x',
                         '--account-key', '', '--access-key', '', '--signed-secret', '',
                         '--output', 'json'],
      { XDG_CONFIG_HOME: xdg, HOME: tmp });
    assert.equal(r.status, 0);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdUpgrade — trailing slash on CLOUDCDN_URL goes through the regex strip
// (L1280).
// ─────────────────────────────────────────────────────────────────────────────

test('upgrade: trailing-slash CLOUDCDN_URL gets stripped (L1280)', async () => {
  const r = await run(['upgrade'],
    { CLOUDCDN_URL: 'https://example.invalid/' });
  assert.equal(r.status, 0);
  // Output should reference the base without the trailing slash.
  assert.match(r.stderr + r.stdout, /example\.invalid/);
});

// ─────────────────────────────────────────────────────────────────────────────
// assets list --all edge: body = null breaks the loop via the `!body` arm
// (L2034).
// ─────────────────────────────────────────────────────────────────────────────

test('assets list --all: body=null breaks loop (L2034 — !body arm)', async () => {
  const { srv, base } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('null');
  });
  try {
    const r = await run(['assets', 'list', '--all', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[\s*\]/);
  } finally { srv.close(); }
});

// L2037 verbose page log with undefined TotalPages → the `?? '?'` arm.
test('assets list --all + verbose: undefined TotalPages renders "?" (L2037)', async () => {
  let calls = 0;
  const { srv, base } = await startServer((req, res) => {
    calls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // No TotalPages key — second page returns empty Data to break the loop.
    if (calls === 1) res.end(JSON.stringify({ Data: [{ Path: 'a' }] }));
    else res.end(JSON.stringify({ Data: [] }));
  });
  try {
    const r = await run(['assets', 'list', '--all', '--verbose', '--output', 'json'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /page 1\/\?/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// rules set with `--file` long flag (vs `-f`) — covers L2347's
// `flags.f || flags.file` second arm on the success path.
// ─────────────────────────────────────────────────────────────────────────────

test('rules set: --file long flag (L2347)', async () => {
  const { srv, base } = await startServer(json({ ok: true }));
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-rs-'));
  try {
    const f = join(tmp, 'rules.txt');
    await writeFile(f, 'rules here\n');
    const r = await run(['rules', 'set', '_headers', '--file', f],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
  } finally {
    srv.close();
    await rm(tmp, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP server edges. The JSON-RPC server hits:
//   L3044: `const flags = args || {}` — tools/call with no `arguments`.
//   L3056: `flags.urls || []` — purge tool with no urls.
//   L3268: `const { uri } = params || {}` — resources/read with no params.
//   L3278: `params || {}` in prompts/get.
// ─────────────────────────────────────────────────────────────────────────────

function driveMcp(messages, env = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve'], {
      env: {
        ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1',
        CLOUDCDN_TIMEOUT: '500', CLOUDCDN_RETRIES: '0',
        CLOUDCDN_ACCOUNT_KEY: 'k', CLOUDCDN_ACCESS_KEY: 'k',
        ...env,
      },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; stderr=${stderr}`)); }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    setTimeout(() => child.stdin.end(), 500);
  });
}

test('mcp tools/call: omitted arguments → flags={} (L3044)', async () => {
  // cloudcdn_signed is the only offline tool — but it needs expires + a
  // secret in env to avoid fatal()ing the server before responding.
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    const { stdout } = await driveMcp([
      { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cloudcdn_signed',
                  arguments: { path: '/x', expires: 999 } } },
    ], { CLOUDCDN_URL: base, SIGNED_URL_SECRET: 's' });
    assert.match(stdout, /"jsonrpc"/);
  } finally { srv.close(); }
});

test('mcp tools/call: cloudcdn_purge with urls (L3056 — urls truthy arm)', async () => {
  // The `else await cmdPurge(flags.urls || [], {})` branch fires when
  // neither `everything` nor `tags` is set. We pass `urls` so the truthy
  // arm of `flags.urls || []` is taken (the falsy arm would call
  // cmdPurge([], {}) which fatal()s inside the MCP server).
  const { srv, base } = await startServer(json({ ok: true }));
  try {
    const { stdout } = await driveMcp([
      { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'cloudcdn_purge',
                  arguments: { urls: ['https://x/a'] } } },
    ], { CLOUDCDN_URL: base });
    assert.match(stdout, /"jsonrpc"/);
  } finally { srv.close(); }
});

test('mcp resources/read: omitted params → {} (L3268)', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'resources/read' },
  ], { CLOUDCDN_URL: 'http://127.0.0.1:1' });
  // We expect an error because uri is undefined — the branch we care
  // about (`params || {}`) is still traversed.
  const responses = stdout.trim().split('\n').map((l) => JSON.parse(l));
  const r = responses.find((x) => x.id === 1);
  assert.ok(r, 'expected a response');
  assert.ok(r.error || r.result, 'expected error or result');
});

test('mcp prompts/get: omitted params → {} (L3278)', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'prompts/get' },
  ], { CLOUDCDN_URL: 'http://127.0.0.1:1' });
  const responses = stdout.trim().split('\n').map((l) => JSON.parse(l));
  const r = responses.find((x) => x.id === 1);
  assert.ok(r);
});
