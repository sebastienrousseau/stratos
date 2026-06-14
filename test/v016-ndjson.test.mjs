// SPDX-License-Identifier: MIT
//
// v0.0.16 — --output ndjson / --output jsonl (Phase 1.2 of the
// implementation plan). NDJSON is the lingua franca for streaming list
// records into LLM contexts and into jq / DuckDB pipelines. This file
// pins the contract:
//
//   - list commands emit one record per line (no surrounding array)
//   - single-object commands emit a single line
//   - `jsonl` is accepted as an alias for `ndjson`
//   - --output validation rejects unknown formats with EX_USAGE
//   - wantStructuredOutput() returns true for ndjson (so commands with
//     rich text rendering switch to machine output)

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

const COMMON_AUTH = {
  CLOUDCDN_ACCOUNT_KEY: 'k',
  CLOUDCDN_ACCESS_KEY: 'k',
};

test('--output ndjson on list endpoint: one row per line', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({
      tokens: [
        { id: 'tk1', name: 'one', scopes: ['read'] },
        { id: 'tk2', name: 'two', scopes: ['read', 'write'] },
        { id: 'tk3', name: 'three', scopes: ['read'] },
      ],
    })));
    const r = await run(['tokens', 'list', '--output', 'ndjson'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0, `non-zero exit. stderr=${r.stderr}`);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 3, `expected 3 lines, got ${lines.length}: ${r.stdout}`);
    for (const line of lines) {
      const row = JSON.parse(line);
      assert.match(row.id, /^tk[123]$/);
    }
    // Critically: NOT an array wrapper.
    assert.doesNotMatch(r.stdout.slice(0, 5), /^\[/);
  } finally {
    if (srv) srv.close();
  }
});

test('--output ndjson on single-object endpoint: single line', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ status: 'ok', edge: 'lhr-1' })));
    const r = await run(['health', '--output', 'ndjson'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `expected 1 line, got ${lines.length}: ${r.stdout}`);
    const obj = JSON.parse(lines[0]);
    assert.equal(obj.status, 'ok');
    assert.equal(obj.edge, 'lhr-1');
  } finally {
    if (srv) srv.close();
  }
});

test('--output jsonl: accepted as alias for ndjson', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ tokens: [{ id: 'tk1', name: 'one' }] })));
    const r = await run(['tokens', 'list', '--output', 'jsonl'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    JSON.parse(lines[0]); // parses cleanly
  } finally {
    if (srv) srv.close();
  }
});

test('--output bogus: rejected with EX_USAGE + helpful message', async () => {
  const r = await run(['health', '--output', 'bogus'], { ...COMMON_AUTH });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--output must be json\|ndjson\|yaml\|csv\|table/);
});

test('--output ndjson on empty list: emits nothing (zero lines)', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({ tokens: [] })));
    const r = await run(['tokens', 'list', '--output', 'ndjson'],
      { ...COMMON_AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    // Empty list → zero lines. An agent treating each line as a record
    // sees zero records, which is the correct empty-list signal.
    assert.equal(r.stdout.trim(), '');
  } finally {
    if (srv) srv.close();
  }
});
