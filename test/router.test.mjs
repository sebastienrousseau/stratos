// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');
const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args],
  { env: { ...process.env, STRATOS_CI: '0', ...env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' },
    encoding: 'utf8' });

test('router: version prints v0.0.10', () => {
  const r = run(['version']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^stratos v0\.0\.10/);
});

test('router: -v and --version both work', () => {
  assert.match(run(['-v']).stdout, /v0\.0\.10/);
  assert.match(run(['--version']).stdout, /v0\.0\.10/);
});

test('router: bare invocation prints help, exits 0', () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stratos v0\.0\.10/);
});

test('router: unknown command exits EX_USAGE (64)', () => {
  const r = run(['nope']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /unknown command/);
});

test('router: per-command --help works', () => {
  const r = run(['purge', '--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stratos purge/);
});

test('router: help <topic> works', () => {
  const r = run(['help', 'signed']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /stratos signed/);
});

test('purge: dry-run with no auth still works', () => {
  const r = run(['purge', '--tag', 'a', '--tag', 'b', '--dry-run']);
  assert.equal(r.status, 0);
  const body = JSON.parse(r.stdout);
  assert.equal(body.dry_run, true);
  assert.deepEqual(body.would_send.tags, ['a', 'b']);
});

test('purge: dry-run with --everything', () => {
  const r = run(['purge', '--everything', '--dry-run']);
  const body = JSON.parse(r.stdout);
  assert.equal(body.would_send.purge_everything, true);
});

test('purge: dry-run with stdin URLs', () => {
  const r = spawnSync(process.execPath, [CLI, 'purge', '-', '--dry-run'],
    { env: { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' },
      encoding: 'utf8',
      input: 'https://cloudcdn.pro/a\nhttps://cloudcdn.pro/b\n' });
  const body = JSON.parse(r.stdout);
  assert.deepEqual(body.would_send.urls, ['https://cloudcdn.pro/a', 'https://cloudcdn.pro/b']);
});

test('purge: missing args fails EX_USAGE', () => {
  const r = run(['purge', '--dry-run']);
  assert.equal(r.status, 64);
});

test('completion: bash emits a completion function', () => {
  const r = run(['completion', 'bash']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /_stratos_complete/);
});

test('completion: zsh emits compdef', () => {
  const r = run(['completion', 'zsh']);
  assert.match(r.stdout, /compdef _stratos stratos/);
});

test('completion: unknown shell fails EX_USAGE', () => {
  const r = run(['completion', 'tcsh']);
  assert.equal(r.status, 64);
});
