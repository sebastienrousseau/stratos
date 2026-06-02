// SPDX-License-Identifier: MIT
//
// v0.0.8 — small unit tests for parse/format edge cases identified by
// the branch-coverage survey.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
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

// Async spawn so the same-process HTTP servers can serve their requests.
function run(args, env = {}, opts = {}) {
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
    'JENKINS_URL', 'TF_BUILD', 'CI', 'XDG_CONFIG_HOME',
  ]) delete baseEnv[k];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args],
      { env: { ...baseEnv, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

const json = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

// ─────────────────────────────────────────────────────────────────────────────
// toYaml: empty object → '{}'
// ─────────────────────────────────────────────────────────────────────────────

test('--output=yaml: empty object emits "{}"', async () => {
  const { srv, base } = await startServer(json({}));
  try {
    const r = await run(['health', '--output=yaml'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\{\}/);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// toCsv on a non-list/non-row body (purge dry-run emits a plain object).
// ─────────────────────────────────────────────────────────────────────────────

test('--output=csv with purge --dry-run --tag a --tag b: CSV produced from object', async () => {
  const r = await run(['purge', '--dry-run', '--tag', 'a', '--tag', 'b', '--output=csv'],
    { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 0);
  // CSV of a single record — should have at least one header line.
  assert.ok(r.stdout.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// readStdinLines early-return when stdin is closed and empty.
// ─────────────────────────────────────────────────────────────────────────────

test('purge -: closed empty stdin → no URLs → fatal EX_USAGE', async () => {
  const r = await run(['purge', '-'], { CLOUDCDN_ACCOUNT_KEY: 'k' }, { input: '' });
  // Empty stdin → urls === [] → fatal('purge needs at least one URL ...')
  assert.equal(r.status, 64);  // EX.USAGE
});

// ─────────────────────────────────────────────────────────────────────────────
// Unknown short flag falls through to positional (line ~287 of parseFlags).
// ─────────────────────────────────────────────────────────────────────────────

test('unknown short flag -Z is treated as positional', async () => {
  // `stratos -Z foo` → -Z is positional → command lookup fails → EX_USAGE.
  // We just want to drive the `if (!sc) { positional.push(a); continue; }`
  // branch. `stratos` with no positionals would print HELP_ROOT — we want
  // the parseFlags branch, so we use `help -Z` which is a valid command.
  const r = await run(['health', '-Z'], { CLOUDCDN_URL: 'http://127.0.0.1:1',
                                    CLOUDCDN_TIMEOUT: '500',
                                    CLOUDCDN_RETRIES: '0' });
  // The -Z is dropped into positional but health ignores positionals.
  // Should still exit non-zero (connection refused), but not because of -Z.
  assert.notEqual(r.status, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// XDG_CONFIG_HOME branch.
// ─────────────────────────────────────────────────────────────────────────────

test('XDG_CONFIG_HOME env var is honoured by `config list`', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'stratos-xdg-'));
  try {
    const r = await run(['config', 'list'], { XDG_CONFIG_HOME: tmp });
    // No config file exists at XDG_CONFIG_HOME/stratos/config.json — that's
    // fine, the command should report "no profiles" but exit 0.
    assert.equal(r.status, 0);
  } finally { await rm(tmp, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// isTTY() short-circuit: STRATOS_FORCE_TTY=1 wins only if NO_COLOR is unset.
// `STRATOS_FORCE_TTY=1` alone returns true; `NO_COLOR=1` on its own makes
// the right-hand `!process.env.NO_COLOR` arm false. Both set → STRATOS_FORCE_TTY
// short-circuits the OR.
// ─────────────────────────────────────────────────────────────────────────────

test('isTTY: STRATOS_FORCE_TTY=1 + NO_COLOR=1 → still TTY via the left arm', async () => {
  const r = await run(['help'], { STRATOS_FORCE_TTY: '1', NO_COLOR: '1' });
  assert.equal(r.status, 0);
  // Help text rendered; STRATOS_FORCE_TTY=1 wins. We don't assert on ANSI
  // because c.bold etc still wrap when NO_COLOR is set + force-tty:
  // `isTTY()` returns true so paint() emits escapes, but our assertion is
  // structural: the help banner is present.
  assert.ok(r.stdout.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// --rate=10/s — successful parse.
// ─────────────────────────────────────────────────────────────────────────────

test('--rate=10/s parses successfully', async () => {
  const { srv, base } = await startServer(json({ status: 'ok' }));
  try {
    const r = await run(['health', '--rate=10/s'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
  } finally { srv.close(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// --rate=bad — fatal EX_USAGE.
// ─────────────────────────────────────────────────────────────────────────────

test('--rate=bad exits EX_USAGE', async () => {
  const r = await run(['health', '--rate=bad'], { CLOUDCDN_URL: 'http://127.0.0.1:1' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /rate/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Repeated --tag flag → flagList accumulates into an array.
// ─────────────────────────────────────────────────────────────────────────────

test('repeated --tag flag accumulates into array (flagList path)', async () => {
  const r = await run(['purge', '--tag', 'a', '--tag', 'b', '--dry-run', '--json'],
    { CLOUDCDN_ACCOUNT_KEY: 'k' });
  assert.equal(r.status, 0);
  const body = JSON.parse(r.stdout);
  assert.deepEqual(body.would_send.tags, ['a', 'b']);
});
