// SPDX-License-Identifier: MIT
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlags } from '../stratos.mjs';

test('parseFlags: bare positional', () => {
  const { positional, flags } = parseFlags(['a', 'b', 'c']);
  assert.deepEqual(positional, ['a', 'b', 'c']);
  assert.deepEqual(flags, {});
});

test('parseFlags: --flag=value', () => {
  const { flags } = parseFlags(['--project=akande', '--format=svg']);
  assert.equal(flags.project, 'akande');
  assert.equal(flags.format, 'svg');
});

test('parseFlags: --flag value', () => {
  const { flags } = parseFlags(['--expires', '1700000000']);
  assert.equal(flags.expires, '1700000000');
});

test('parseFlags: --flag with no value becomes true', () => {
  const { flags } = parseFlags(['--deep']);
  assert.equal(flags.deep, true);
});

test('parseFlags: multiple --tag repeats become array (the v0.0.1 bug fix)', () => {
  const { flags } = parseFlags(['--tag', 'a', '--tag', 'b', '--tag', 'c']);
  assert.deepEqual(flags.tag, ['a', 'b', 'c']);
});

test('parseFlags: -- ends flag parsing', () => {
  const { positional, flags } = parseFlags(['--deep', '--', '--literal']);
  assert.deepEqual(positional, ['--literal']);
  assert.equal(flags.deep, true);
});

test('parseFlags: -h / -v shortcuts', () => {
  assert.equal(parseFlags(['-h']).flags.help, true);
  assert.equal(parseFlags(['-v']).flags.version, true);
  assert.equal(parseFlags(['-q']).flags.quiet, true);
});

test('parseFlags: boolean followed by another flag', () => {
  const { flags } = parseFlags(['--dry-run', '--everything']);
  assert.equal(flags['dry-run'], true);
  assert.equal(flags.everything, true);
});
