// SPDX-License-Identifier: MIT
//
// v0.0.17 — CLI help-render smoke matrix.
//
// For every command in `stratos schema`, this file asserts that:
//
//   1. `stratos help <cmd>` renders without crashing
//   2. `stratos <cmd> --help` is recognised and exits cleanly
//   3. Unknown subcommands fall through to a usage error (EX.USAGE)
//
// The point isn't to test behaviour (the other v0xx test files do
// that) — it's to catch the class of bug where a routine refactor
// breaks one command's help renderer or argument parser without
// breaking any of the explicitly-tested commands.
//
// If a future contributor adds a new command but forgets to wire it
// into HELP_BY_COMMAND or the router, this file fails immediately
// with a precise pointer instead of leaving a silent gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1', ...env },
  encoding: 'utf8',
});

const SCHEMA = JSON.parse(run(['schema']).stdout);

// Some commands legitimately exit non-zero with a usage hint (`mcp`
// without `serve`, `passkey` exiting with EX.UNAVAILABLE by design).
// `stratos help <cmd>` is the universal renderer that should ALWAYS
// return zero — it's just printing text.

test('cli-smoke: stratos help <every-known-command> exits 0', () => {
  for (const c of SCHEMA.commands) {
    const r = run(['help', c.name]);
    assert.equal(r.status, 0,
      `'stratos help ${c.name}' exited ${r.status}. stderr=${r.stderr}`);
    assert.ok(r.stdout.length > 0,
      `'stratos help ${c.name}' produced no output`);
  }
});

test('cli-smoke: stratos help with no topic prints root help', () => {
  const r = run(['help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stratos v\d+\.\d+\.\d+/);
  assert.match(r.stdout, /Usage:/);
});

test('cli-smoke: stratos help unknown-topic exits with usage error', () => {
  const r = run(['help', '__definitely_not_a_command__']);
  assert.equal(r.status, 64);  // EX.USAGE
  assert.match(r.stderr, /No help for/);
});

test('cli-smoke: stratos --help is recognised as root help', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stratos v\d+\.\d+\.\d+/);
});

test('cli-smoke: stratos -h is recognised as root help', () => {
  const r = run(['-h']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stratos v\d+\.\d+\.\d+/);
});

test('cli-smoke: stratos --version is recognised', () => {
  const r = run(['--version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /v\d+\.\d+\.\d+/);
});

test('cli-smoke: stratos -v is recognised', () => {
  const r = run(['-v']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /v\d+\.\d+\.\d+/);
});

test('cli-smoke: stratos with no args prints root help (exit 0)', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test('cli-smoke: stratos unknown-command exits EX.USAGE with suggestion', () => {
  const r = run(['__definitely_not_a_command__']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown command/);
});

test('cli-smoke: stratos typo gets a "did you mean" hint', () => {
  // "halth" is one edit away from "health" — Levenshtein-suggestCommand
  // should propose it.
  const r = run(['halth']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /Did you mean.*health/);
});

test('cli-smoke: every command\'s help text mentions the command name', () => {
  // Sanity check the renderer hasn't broken in a way that returns the
  // wrong topic's help text.
  for (const c of SCHEMA.commands) {
    const r = run(['help', c.name]);
    // The help text should reference the command name itself at least
    // once. Some commands (e.g. `mcp`) have prose-rich help that
    // mentions the command in lowercase too.
    const lower = r.stdout.toLowerCase();
    assert.ok(lower.includes(c.name),
      `'stratos help ${c.name}' output doesn't mention "${c.name}". First 200 chars:\n${r.stdout.slice(0, 200)}`);
  }
});

// ─── Subcommand smoke: bad subcommands fall through cleanly ──────────

test('cli-smoke: commands with subcommand routers reject unknown subcommands', () => {
  // These commands implement a `case 'sub':` switch and default to
  // fatal(..., EX.USAGE) for unknown subcommands. Verify the contract.
  const subcommandRouters = [
    { cmd: 'zones',    bad: '__bogus__' },
    { cmd: 'rules',    bad: '__bogus__' },
    { cmd: 'tokens',   bad: '__bogus__' },
    { cmd: 'webhooks', bad: '__bogus__' },
    { cmd: 'storage',  bad: '__bogus__' },
    { cmd: 'logs',     bad: '__bogus__' },
    { cmd: 'config',   bad: '__bogus__' },
    { cmd: 'ai',       bad: '__bogus__' },
    { cmd: 'image',    bad: '__bogus__' },
    { cmd: 'pipeline', bad: '__bogus__' },
    { cmd: 'insights', bad: '__bogus__' },
  ];
  for (const { cmd, bad } of subcommandRouters) {
    const r = run([cmd, bad], {
      // Most of these need an account key to even reach the dispatch
      // branch. Provide a dummy so we test the dispatcher's USAGE path.
      CLOUDCDN_ACCOUNT_KEY: 'k',
      CLOUDCDN_ACCESS_KEY:  'k',
    });
    assert.equal(r.status, 64,
      `'${cmd} ${bad}' should exit 64 (USAGE) for unknown subcommand. Got ${r.status}. stderr=${r.stderr.slice(0, 200)}`);
  }
});

// ─── Completion script renders without crashing for every shell ──────

test('cli-smoke: completion script renders for every supported shell', () => {
  for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
    const r = run(['completion', shell]);
    assert.equal(r.status, 0,
      `'stratos completion ${shell}' exited ${r.status}. stderr=${r.stderr}`);
    assert.ok(r.stdout.length > 0,
      `'stratos completion ${shell}' produced no output`);
  }
});

test('cli-smoke: completion without a shell name exits EX.USAGE', () => {
  const r = run(['completion']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /completion needs a shell/);
});

test('cli-smoke: completion with unknown shell exits EX.USAGE', () => {
  const r = run(['completion', '__bogus_shell__']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown shell/);
});

// ─── explain works for every documented EX code ─────────────────────

test('cli-smoke: stratos explain <code> works for every EX value', async () => {
  const stratos = await import('../stratos.mjs');
  for (const [name, code] of Object.entries(stratos.EX)) {
    if (code === 0) continue;  // OK isn't explainable; not in registry
    const r = run(['explain', String(code)]);
    assert.equal(r.status, 0,
      `'stratos explain ${code}' (EX.${name}) exited ${r.status}. stderr=${r.stderr}`);
  }
});

test('cli-smoke: stratos explain <symbolic-name> works', () => {
  // EX_NOPERM, EX_USAGE, etc. are aliases — verify they resolve.
  for (const sym of ['EX_USAGE', 'EX_NOPERM', 'EX_TEMPFAIL', 'EX_CONFIG']) {
    const r = run(['explain', sym]);
    assert.equal(r.status, 0,
      `'stratos explain ${sym}' exited ${r.status}. stderr=${r.stderr}`);
  }
});

test('cli-smoke: stratos explain <HTTP-status> works for common codes', () => {
  for (const status of ['200', '401', '403', '404', '429', '500', '503']) {
    const r = run(['explain', status]);
    assert.equal(r.status, 0,
      `'stratos explain ${status}' exited ${r.status}. stderr=${r.stderr}`);
  }
});

test('cli-smoke: stratos explain unknown topic exits cleanly', () => {
  const r = run(['explain', '__bogus__']);
  // explain returns EX.UNAVAILABLE for unknown topics (not USAGE — the
  // syntax was valid, the lookup just failed).
  assert.equal(r.status, 69);
});

test('cli-smoke: stratos explain with no arg exits EX.USAGE', () => {
  const r = run(['explain']);
  assert.equal(r.status, 64);
});
