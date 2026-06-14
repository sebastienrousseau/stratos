// SPDX-License-Identifier: MIT
//
// v0.0.17 — output-format regression matrix.
//
// `--output <fmt>` accepts five named formats (json, ndjson, yaml,
// csv, table) plus the `jsonl` alias for ndjson. Each is supposed to
// work on:
//
//   - a single-object body (e.g. `stratos health` returns one record)
//   - a list body          (e.g. `stratos tokens list` returns N rows)
//
// 5 formats × 2 body shapes × at least one assertion each → 10 cells.
// Plus auto-format selection (TTY vs pipe), `--json` shortcut, and
// `--filter` jq pipeline assertions.
//
// This file catches the class of bug where editing `emit()` /
// `emitList()` / `pickOutputFormat()` breaks one format silently
// because no individual command's test exercises that format.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1',
        ...env,
      },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

const json = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const AUTH = { CLOUDCDN_ACCOUNT_KEY: 'k', CLOUDCDN_ACCESS_KEY: 'k' };

// ─── Single-object body: stratos health
// ────────────────────────────────────────────────────────────────────

test('output-matrix: health --output json (single-object body)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ status: 'ok', edge: 'lhr-1' })));
    const r = await run(['health', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.status, 'ok');
    assert.equal(parsed.edge, 'lhr-1');
  } finally { if (srv) srv.close(); }
});

test('output-matrix: health --output ndjson (single-object → one line)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ status: 'ok', edge: 'lhr-1' })));
    const r = await run(['health', '--output', 'ndjson'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `expected 1 line, got ${lines.length}`);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.status, 'ok');
  } finally { if (srv) srv.close(); }
});

test('output-matrix: health --output jsonl (alias for ndjson)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ status: 'ok' })));
    const r = await run(['health', '--output', 'jsonl'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    JSON.parse(lines[0]);  // parses cleanly
  } finally { if (srv) srv.close(); }
});

test('output-matrix: health --output yaml (single-object body)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ status: 'ok', edge: 'lhr-1' })));
    const r = await run(['health', '--output', 'yaml'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    // Don't depend on a YAML parser; just check the structural signature.
    // The YAML emitter quotes strings that contain `-` (e.g. "lhr-1").
    assert.match(r.stdout, /^status:\s*ok$/m);
    assert.match(r.stdout, /^edge:\s*"?lhr-1"?$/m);
  } finally { if (srv) srv.close(); }
});

test('output-matrix: health --output csv (single-object body → header row + value row)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ status: 'ok', edge: 'lhr-1' })));
    const r = await run(['health', '--output', 'csv'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 2, `expected header + 1 row, got ${lines.length}`);
    assert.match(lines[0], /status,edge/);
    assert.match(lines[1], /ok,lhr-1/);
  } finally { if (srv) srv.close(); }
});

// ─── List body: stratos tokens list
// ────────────────────────────────────────────────────────────────────

const tokenList = {
  tokens: [
    { id: 'tk1', name: 'one',   scopes: ['read'] },
    { id: 'tk2', name: 'two',   scopes: ['read', 'write'] },
    { id: 'tk3', name: 'three', scopes: ['read'] },
  ],
};

test('output-matrix: tokens list --output json (list body)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json(tokenList)));
    const r = await run(['tokens', 'list', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const arr = JSON.parse(r.stdout);
    assert.ok(Array.isArray(arr), 'json output of a list should be a JSON array');
    assert.equal(arr.length, 3);
    assert.equal(arr[0].id, 'tk1');
  } finally { if (srv) srv.close(); }
});

test('output-matrix: tokens list --output ndjson (list body → N lines)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json(tokenList)));
    const r = await run(['tokens', 'list', '--output', 'ndjson'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 3, `expected 3 lines, got ${lines.length}`);
    for (const line of lines) {
      const row = JSON.parse(line);
      assert.match(row.id, /^tk[123]$/);
    }
    // Critical: no array wrapper.
    assert.doesNotMatch(r.stdout.slice(0, 5), /^\[/);
  } finally { if (srv) srv.close(); }
});

test('output-matrix: tokens list --output yaml (list body)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json(tokenList)));
    const r = await run(['tokens', 'list', '--output', 'yaml'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^-$/m);          // yaml list marker (dash on its own line)
    assert.match(r.stdout, /id:\s*tk1/);
    assert.match(r.stdout, /id:\s*tk2/);
    assert.match(r.stdout, /id:\s*tk3/);
  } finally { if (srv) srv.close(); }
});

test('output-matrix: tokens list --output csv (list body)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json(tokenList)));
    const r = await run(['tokens', 'list', '--output', 'csv'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 4, `expected 1 header + 3 rows, got ${lines.length}`);
    assert.match(lines[0], /id/);  // header includes id column
  } finally { if (srv) srv.close(); }
});

test('output-matrix: tokens list --output table (forced TTY mode)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json(tokenList)));
    const r = await run(['tokens', 'list', '--output', 'table'],
      { ...AUTH, CLOUDCDN_URL: base, STRATOS_FORCE_TTY: '1' });
    assert.equal(r.status, 0);
    // Table mode renders headers + values; the ID column shows tkN.
    assert.match(r.stdout, /ID/);
    assert.match(r.stdout, /tk1/);
    assert.match(r.stdout, /tk3/);
  } finally { if (srv) srv.close(); }
});

// ─── Format selection edge cases
// ────────────────────────────────────────────────────────────────────

test('output-matrix: --json is shorthand for --output json', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json(tokenList)));
    const a = await run(['tokens', 'list', '--json'],
      { ...AUTH, CLOUDCDN_URL: base });
    const b = await run(['tokens', 'list', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
    // Whitespace might differ (pretty vs compact on TTY arm), but the
    // parsed shape must match.
    assert.deepEqual(JSON.parse(a.stdout), JSON.parse(b.stdout));
  } finally { if (srv) srv.close(); }
});

test('output-matrix: piped (no TTY) defaults to compact JSON', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ status: 'ok' })));
    const r = await run(['health'], { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    // Non-TTY → compact (no newlines inside the object).
    assert.equal(r.stdout.trim(), '{"status":"ok"}');
  } finally { if (srv) srv.close(); }
});

test('output-matrix: invalid --output rejected with EX.USAGE', async () => {
  const r = await run(['health', '--output', 'xml'], { ...AUTH });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--output must be json\|ndjson\|yaml\|csv\|table/);
});

// ─── --filter (jq pipeline) sanity
// ────────────────────────────────────────────────────────────────────

test('output-matrix: --filter (single-line value)', async () => {
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('jq', ['--version']).status !== 0) return;  // skip if jq missing
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ status: 'ok', edge: 'lhr-1' })));
    const r = await run(
      ['health', '--filter', '.status', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    assert.equal(JSON.parse(r.stdout), 'ok');
  } finally { if (srv) srv.close(); }
});

test('output-matrix: --filter (object-projection — the v0.0.17 jq -c fix)', async () => {
  // Pre-v0.0.17, `{status, edge}` failed because jq pretty-prints
  // multi-line objects by default and applyFilter() parses one JSON
  // value per stdout line. The `-c` flag (added in v0.0.17) makes
  // every line a complete document. This test pins the fix.
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('jq', ['--version']).status !== 0) return;
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ status: 'ok', edge: 'lhr-1', region: 'eu' })));
    const r = await run(
      ['health', '--filter', '{status, edge}', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), { status: 'ok', edge: 'lhr-1' });
  } finally { if (srv) srv.close(); }
});

test('output-matrix: --filter (stream-style — array-yielding expressions)', async () => {
  // `.[].name` against a list yields N values, one per jq output
  // line. applyFilter() collects them into a JS array.
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('jq', ['--version']).status !== 0) return;
  let srv, base;
  try {
    ({ srv, base } = await startServer(json(tokenList)));
    const r = await run(
      ['tokens', 'list', '--filter', '.[].name', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0, `exit=${r.status} stderr=${r.stderr}`);
    assert.deepEqual(JSON.parse(r.stdout), ['one', 'two', 'three']);
  } finally { if (srv) srv.close(); }
});

// ─── Schema output formats (regression-pinned)
// ────────────────────────────────────────────────────────────────────

test('output-matrix: stratos schema renders in json/ndjson/yaml', async () => {
  // Schema is offline — no mock server needed.
  for (const fmt of ['json', 'ndjson', 'yaml']) {
    const r = await run(['schema', '--output', fmt]);
    assert.equal(r.status, 0, `'stratos schema --output ${fmt}' exited ${r.status}`);
    assert.ok(r.stdout.length > 0, `'stratos schema --output ${fmt}' produced no output`);
  }
});
