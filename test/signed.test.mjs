// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, STRATOS_CI: '0', ...env, NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' },
    encoding: 'utf8',
  });
}

test('signed: emits canonical URL deterministically', () => {
  const r = run(['signed', '/clients/akande/private.pdf', '--expires', '1700000000'],
    { SIGNED_URL_SECRET: 'topsecret' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^https:\/\/cloudcdn\.pro\/api\/signed\?path=/);
  assert.match(r.stdout, /&expires=1700000000&sig=[0-9a-f]{64}$/m);
});

test('signed: same inputs produce same signature (stable HMAC)', () => {
  const a = run(['signed', '/a', '--expires', '42'], { SIGNED_URL_SECRET: 'k' }).stdout;
  const b = run(['signed', '/a', '--expires', '42'], { SIGNED_URL_SECRET: 'k' }).stdout;
  assert.equal(a, b);
});

test('signed: paths with | do not collide (canonicalisation fix)', () => {
  const a = run(['signed', '/a|extra', '--expires', '42'], { SIGNED_URL_SECRET: 'k' }).stdout;
  const b = run(['signed', '/a', '--expires', '|extra|42'], { SIGNED_URL_SECRET: 'k' }).stdout;
  // Pull the &sig= component out of each.
  const sigA = (a.match(/&sig=([0-9a-f]+)/) || [])[1];
  const sigB = (b.match(/&sig=([0-9a-f]+)/) || [])[1];
  assert.ok(sigA && sigB);
  assert.notEqual(sigA, sigB);
});

test('signed: missing --expires fails with EX_USAGE (64)', () => {
  const r = run(['signed', '/x'], { SIGNED_URL_SECRET: 'k' });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--expires/);
});

test('signed: missing secret fails with EX_CONFIG (78)', () => {
  const r = run(['signed', '/x', '--expires', '1'], { SIGNED_URL_SECRET: '' });
  assert.equal(r.status, 78);
});
