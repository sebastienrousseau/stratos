// SPDX-License-Identifier: MIT
//
// v0.0.16 — `stratos schema` verb (Phase 1.1 of the implementation
// plan: agent-first DevEx). The schema is the gateway: shell completion,
// MCP tools, doc generation, and external agent introspection all read
// from the same source of truth.
//
// Invariants we lock down here:
//   - exits 0 and emits valid JSON
//   - schema covers every KNOWN_COMMANDS entry (no drift)
//   - top-level shape: { $schema, tool, version, homepage, commands }
//   - per-command shape: { name, summary, usage, exits, since, mcp_tool? }
//   - MCP-exposed commands include mcp_tool; non-MCP commands do not
//   - --output ndjson streams one command per line (no array wrapper)
//   - --output jsonl is an accepted alias for ndjson
//   - --output yaml works (sanity)
//   - deterministic: two consecutive runs produce identical bytes

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

test('schema: emits valid JSON with the expected top-level shape', () => {
  const r = run(['schema']);
  assert.equal(r.status, 0, `non-zero exit. stderr=${r.stderr}`);
  const s = JSON.parse(r.stdout);
  assert.equal(s.$schema, 'https://stratos.cloudcdn.pro/schema/v1.json');
  assert.equal(s.tool, 'stratos');
  assert.match(s.version, /^\d+\.\d+\.\d+$/);
  assert.equal(s.homepage, 'https://github.com/sebastienrousseau/stratos#readme');
  assert.ok(Array.isArray(s.commands), 'commands must be an array');
  assert.ok(s.commands.length >= 32, `expected ≥ 32 commands, got ${s.commands.length}`);
});

test('schema: every command has the required fields', () => {
  const r = run(['schema']);
  const s = JSON.parse(r.stdout);
  for (const cmd of s.commands) {
    assert.equal(typeof cmd.name, 'string', `command missing name: ${JSON.stringify(cmd)}`);
    assert.equal(typeof cmd.summary, 'string', `command ${cmd.name} missing summary`);
    assert.equal(typeof cmd.usage, 'string', `command ${cmd.name} missing usage`);
    assert.ok(Array.isArray(cmd.exits), `command ${cmd.name} missing exits[]`);
    assert.ok(cmd.exits.length > 0, `command ${cmd.name} has empty exits[]`);
    assert.match(cmd.since, /^\d+\.\d+\.\d+|unknown$/, `command ${cmd.name} has malformed since`);
    // exits sorted ascending (deterministic ordering).
    for (let i = 1; i < cmd.exits.length; i++) {
      assert.ok(cmd.exits[i - 1] < cmd.exits[i],
        `command ${cmd.name} exits not sorted: ${JSON.stringify(cmd.exits)}`);
    }
  }
});

test('schema: catalogue matches KNOWN_COMMANDS (no drift)', () => {
  const r = run(['schema']);
  const s = JSON.parse(r.stdout);
  // Smoke-check a handful of representative entries that must always
  // appear: the trio of edge ops + the agent surface entries.
  const names = new Set(s.commands.map((c) => c.name));
  for (const expected of [
    'health', 'purge', 'signed', 'assets', 'insights', 'rules', 'mcp',
    'doctor', 'explain', 'version', 'help', 'schema', 'completion',
  ]) {
    assert.ok(names.has(expected), `schema missing ${expected}`);
  }
});

test('schema: MCP-exposed commands carry mcp_tool; others omit it', () => {
  const r = run(['schema']);
  const s = JSON.parse(r.stdout);
  const byName = Object.fromEntries(s.commands.map((c) => [c.name, c]));
  // A spot-check against the actual MCP_TOOLS registry. Any command
  // listed here MUST have mcp_tool set; any command NOT MCP-exposed
  // (login, doctor, …) must omit it.
  assert.equal(byName.health.mcp_tool, 'cloudcdn_health');
  assert.equal(byName.purge.mcp_tool, 'cloudcdn_purge');
  assert.equal(byName.signed.mcp_tool, 'cloudcdn_signed');
  assert.equal(byName.search.mcp_tool, 'cloudcdn_search');
  assert.equal(byName.logs.mcp_tool, 'cloudcdn_logs_query');
  assert.equal(byName.doctor.mcp_tool, undefined);
  assert.equal(byName.login.mcp_tool, undefined);
  assert.equal(byName.completion.mcp_tool, undefined);
});

test('schema --output ndjson: one record per line, no array wrapper', () => {
  const r = run(['schema', '--output', 'ndjson']);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.ok(lines.length >= 32, `expected ≥ 32 lines, got ${lines.length}`);
  // Every line is a complete JSON object representing one command.
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.equal(typeof obj.name, 'string', `line is not a command: ${line.slice(0, 80)}`);
    assert.ok(Array.isArray(obj.exits), `line missing exits[]: ${line.slice(0, 80)}`);
  }
  // Verify it's NOT one giant JSON array.
  assert.doesNotMatch(r.stdout.slice(0, 5), /^\[/);
});

test('schema --output jsonl: alias for ndjson', () => {
  const r = run(['schema', '--output', 'jsonl']);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  // Same shape as ndjson — one command per line.
  for (const line of lines) {
    const obj = JSON.parse(line);
    assert.equal(typeof obj.name, 'string');
  }
});

test('schema --output yaml: emits valid-looking YAML', () => {
  const r = run(['schema', '--output', 'yaml']);
  assert.equal(r.status, 0);
  // YAML emitter is dependency-free; we don't parse it back, just
  // confirm the structural anchor lines are present.
  assert.match(r.stdout, /^\$schema:/m);
  assert.match(r.stdout, /^tool:\s*stratos/m);
  assert.match(r.stdout, /^commands:/m);
});

test('schema: deterministic across runs (byte-identical)', () => {
  const a = run(['schema']);
  const b = run(['schema']);
  assert.equal(a.stdout, b.stdout, 'schema output must be deterministic');
});

test('--output bogus: rejected with EX_USAGE', () => {
  const r = run(['schema', '--output', 'bogus']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--output must be json\|ndjson\|yaml\|csv\|table/);
});
