// SPDX-License-Identifier: MIT
//
// Tests for v0.0.4 features: `stratos explain`, `stratos init`,
// `stratos config edit`, MCP Resources, MCP Prompts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

function runClean(args, env = {}, opts = {}) {
  const baseEnv = { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' };
  for (const k of [
    'CLOUDCDN_URL','CLOUDCDN_ACCOUNT_KEY','CLOUDCDN_ACCESS_KEY','SIGNED_URL_SECRET',
    'CLOUDCDN_TIMEOUT','CLOUDCDN_RETRIES','STRATOS_PROFILE',
    'GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','JENKINS_URL','TF_BUILD','CI',
  ]) delete baseEnv[k];
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

function withServer(handler, fn) {
  return new Promise((resolve, reject) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', async () => {
      try { const r = await fn(`http://127.0.0.1:${srv.address().port}`); srv.close(); resolve(r); }
      catch (e) { srv.close(); reject(e); }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// stratos explain
// ─────────────────────────────────────────────────────────────────────────────

test('explain: numeric exit code (77) prints cause + fix', async () => {
  const r = await runClean(['explain', '77']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /EX_NOPERM/);
  assert.match(r.stdout, /Permission denied/);
  assert.match(r.stdout, /Fix/);
});

test('explain: symbolic alias (EX_TEMPFAIL) resolves to 75', async () => {
  const r = await runClean(['explain', 'EX_TEMPFAIL']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /EX_TEMPFAIL/);
  assert.match(r.stdout, /\(75\)/);
});

test('explain: HTTP status (429) prints cause', async () => {
  const r = await runClean(['explain', '429']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Rate-limited/);
});

test('explain: --json mode emits machine-readable record', async () => {
  const r = await runClean(['explain', '78', '--json']);
  assert.equal(r.status, 0);
  const body = JSON.parse(r.stdout);
  assert.equal(body.code, '78');
  assert.equal(body.name, 'EX_CONFIG');
  assert.ok(Array.isArray(body.fix));
  assert.ok(body.fix.length > 0);
});

test('explain: case-insensitive aliases', async () => {
  const r = await runClean(['explain', 'ex_noperm']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /EX_NOPERM/);
});

test('explain: missing argument fails EX_USAGE (64)', async () => {
  const r = await runClean(['explain']);
  assert.equal(r.status, 64);
});

test('explain: unknown code fails EX_UNAVAILABLE (69) with the list of known keys', async () => {
  const r = await runClean(['explain', '9999']);
  assert.equal(r.status, 69);
  assert.match(r.stderr, /no explanation for/);
  assert.match(r.stderr, /Try one of/);
});

test('explain: 0 (success) prints empty fix array', async () => {
  const r = await runClean(['explain', '0', '--json']);
  const body = JSON.parse(r.stdout);
  assert.equal(body.name, 'EX_OK');
  assert.deepEqual(body.fix, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// stratos init (non-interactive, flag-driven)
// ─────────────────────────────────────────────────────────────────────────────

test('init: non-interactive --profile + --cdn-url + --account-key writes config', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    const r = await runClean(
      ['init', '--profile=ci', '--cdn-url=https://staging.example', '--account-key=cdnsk_abc123'],
      { XDG_CONFIG_HOME: tmp });
    assert.equal(r.status, 0);
    const cfg = JSON.parse(await readFile(join(tmp, 'stratos', 'config.json'), 'utf8'));
    assert.equal(cfg.profiles.ci.url, 'https://staging.example');
    assert.equal(cfg.profiles.ci.account_key, 'cdnsk_abc123');
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('init: refuses to clobber an existing profile without --force', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    await runClean(['init', '--profile=p', '--cdn-url=https://a.example'], { XDG_CONFIG_HOME: tmp });
    const r = await runClean(['init', '--profile=p', '--cdn-url=https://b.example'], { XDG_CONFIG_HOME: tmp });
    assert.equal(r.status, 64);
    assert.match(r.stderr, /already exists/);
    const cfg = JSON.parse(await readFile(join(tmp, 'stratos', 'config.json'), 'utf8'));
    // First write wins.
    assert.equal(cfg.profiles.p.url, 'https://a.example');
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('init: --force overwrites an existing profile', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    await runClean(['init', '--profile=p', '--cdn-url=https://a.example'], { XDG_CONFIG_HOME: tmp });
    const r = await runClean(['init', '--profile=p', '--cdn-url=https://b.example', '--force'], { XDG_CONFIG_HOME: tmp });
    assert.equal(r.status, 0);
    const cfg = JSON.parse(await readFile(join(tmp, 'stratos', 'config.json'), 'utf8'));
    assert.equal(cfg.profiles.p.url, 'https://b.example');
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('init: stdout secrets are masked in the JSON envelope', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    const r = await runClean(
      ['init', '--profile=p', '--cdn-url=https://a.example',
       '--account-key=cdnsk_supersecret_xyz', '--json'],
      { XDG_CONFIG_HOME: tmp });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /supersecret_xyz/);
    assert.match(r.stdout, /cdnsk_/); // prefix shows
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

test('init: non-TTY without flags uses default profile name + default URL', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-init-'));
  try {
    const r = await runClean(['init'], { XDG_CONFIG_HOME: tmp });
    assert.equal(r.status, 0);
    const cfg = JSON.parse(await readFile(join(tmp, 'stratos', 'config.json'), 'utf8'));
    assert.equal(cfg.profiles.default.url, 'https://cloudcdn.pro');
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// stratos config — new subcommands
// ─────────────────────────────────────────────────────────────────────────────

test('config: unknown action lists `edit` in usage', async () => {
  const r = await runClean(['config', 'bogus']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /list\|get\|set\|edit/);
});

test('config edit: with EDITOR=true (no-op) scaffolds and validates the config', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-edit-'));
  try {
    const r = await runClean(['config', 'edit'],
      { XDG_CONFIG_HOME: tmp, EDITOR: 'true' });
    assert.equal(r.status, 0);
    const cfg = JSON.parse(await readFile(join(tmp, 'stratos', 'config.json'), 'utf8'));
    assert.deepEqual(cfg, { profiles: {} });
    assert.match(r.stderr, /valid · 0 profile/);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP Resources + Prompts
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

test('mcp: initialize advertises resources + prompts capabilities', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').pop());
  assert.ok(r.result.capabilities.tools);
  assert.ok(r.result.capabilities.resources);
  assert.ok(r.result.capabilities.prompts);
});

test('mcp: resources/list returns 6 CloudCDN resources', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'resources/list' },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
  assert.ok(Array.isArray(r.result.resources));
  assert.equal(r.result.resources.length, 6);
  const uris = r.result.resources.map((res) => res.uri);
  assert.ok(uris.includes('cloudcdn://health'));
  assert.ok(uris.includes('cloudcdn://insights/summary'));
  assert.ok(uris.includes('cloudcdn://zones'));
});

test('mcp: resources/read hits the live API and returns a content record', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', deep: false }));
  }, async (base) => {
    const { stdout } = await driveMcp([
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'cloudcdn://health' } },
    ], { CLOUDCDN_URL: base });
    const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
    assert.equal(r.result.contents[0].uri, 'cloudcdn://health');
    assert.equal(r.result.contents[0].mimeType, 'application/json');
    const body = JSON.parse(r.result.contents[0].text);
    assert.equal(body.status, 'ok');
  });
});

test('mcp: resources/read covers every registered URI', async () => {
  // Mock server returns a different stub for each path so we can verify
  // each resource's resolve callback fires.
  await withServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/api/insights/summary'))     res.end('{"summary":1}');
    else if (req.url.startsWith('/api/insights/top'))    res.end('{"top":[]}');
    else if (req.url.startsWith('/api/insights/errors')) res.end('{"errors":[]}');
    else if (req.url.startsWith('/api/core/zones'))      res.end('{"zones":[]}');
    else if (req.url.startsWith('/api/assets'))          res.end('{"Data":[],"Page":1}');
    else                                                  res.end('{"ok":true}');
  }, async (base) => {
    const uris = [
      'cloudcdn://insights/summary',
      'cloudcdn://insights/top',
      'cloudcdn://insights/errors',
      'cloudcdn://zones',
      'cloudcdn://assets',
    ];
    const msgs = [{ jsonrpc: '2.0', id: 1, method: 'initialize' }];
    uris.forEach((uri, i) => msgs.push({ jsonrpc: '2.0', id: i + 10, method: 'resources/read', params: { uri } }));
    const { stdout } = await driveMcp(msgs,
      { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
    const lines = stdout.trim().split('\n').map((l) => JSON.parse(l));
    for (let i = 0; i < uris.length; i++) {
      const r = lines.find((x) => x.id === i + 10);
      assert.ok(r, `no response for ${uris[i]}`);
      assert.ok(r.result, `${uris[i]} returned an error: ${JSON.stringify(r.error)}`);
      assert.equal(r.result.contents[0].uri, uris[i]);
    }
  });
});

test('mcp: resources/read unknown URI returns error envelope', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'cloudcdn://nope' } },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
  assert.ok(r.error);
  assert.match(r.error.message, /unknown resource/);
});

test('mcp: prompts/list returns 4 prompt templates', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'prompts/list' },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
  assert.equal(r.result.prompts.length, 4);
  const names = r.result.prompts.map((p) => p.name);
  assert.ok(names.includes('cache_bust_after_deploy'));
  assert.ok(names.includes('triage_error_spike'));
  assert.ok(names.includes('alt_text_batch'));
  assert.ok(names.includes('audit_recent_tokens'));
});

test('mcp: prompts/get renders argument substitution', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'prompts/get',
      params: { name: 'cache_bust_after_deploy', arguments: { sha: 'abc1234', project: 'akande' } } },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
  assert.equal(r.result.messages[0].role, 'user');
  assert.match(r.result.messages[0].content.text, /abc1234/);
  assert.match(r.result.messages[0].content.text, /akande/);
});

test('mcp: prompts/get without required argument returns error', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'prompts/get',
      params: { name: 'cache_bust_after_deploy', arguments: {} } },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
  assert.ok(r.error);
  assert.match(r.error.message, /requires argument "sha"/);
});

test('mcp: prompts/get optional arguments take their defaults', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'prompts/get',
      params: { name: 'triage_error_spike', arguments: {} } },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
  assert.ok(r.result.messages);
  assert.match(r.result.messages[0].content.text, /last 1 day/);
});

test('mcp: prompts/get alt_text_batch renders project + format substitution', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'prompts/get',
      params: { name: 'alt_text_batch', arguments: { project: 'akande', format: 'png' } } },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
  assert.match(r.result.messages[0].content.text, /akande/);
  assert.match(r.result.messages[0].content.text, /png/);
});

test('mcp: prompts/get audit_recent_tokens with custom days', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'prompts/get',
      params: { name: 'audit_recent_tokens', arguments: { days: '3' } } },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
  assert.match(r.result.messages[0].content.text, /last 3 day/);
});

test('mcp: prompts/get unknown prompt returns error', async () => {
  const { stdout } = await driveMcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'nope' } },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').find((l) => l.includes('"id":2')));
  assert.ok(r.error);
  assert.match(r.error.message, /unknown prompt/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fuzzy suggest picks up the new commands.
// ─────────────────────────────────────────────────────────────────────────────

test('suggest: "explan" → explain', async () => {
  const r = await runClean(['explan']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Did you mean "explain"\?/);
});

test('suggest: "inti" → init', async () => {
  const r = await runClean(['inti']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Did you mean "init"\?/);
});
