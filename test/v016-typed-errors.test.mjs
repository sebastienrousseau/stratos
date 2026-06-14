// SPDX-License-Identifier: MIT
//
// v0.0.16 — Stable typed errors (Phase 1.3 of the implementation plan).
// Agents drive retry / surface logic from `error.type` and `error.retryable`.
// The strings here are a public contract: never rename, never re-classify
// retryable. Adding a new type is fine.
//
// Invariants:
//   - text mode: stderr stays human-readable; the type appears in brackets
//   - structured mode (`--json` / `--output json|ndjson|yaml`): stderr is a
//     valid `{ error: { type, message, retryable, exit_code, ...} }` envelope
//   - HTTP 401/403/404/429/5xx surface the right type
//   - the typed-error table is included in `stratos schema`
//   - exit codes match the registry

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
  env: { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1', ...env },
  encoding: 'utf8',
});

function runAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1', ...env },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

const failStatus = (status, body = { message: 'denied' }) => (req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// ─── Text mode — bracketed type, human-readable
// ────────────────────────────────────────────────────────────────────

test('fatal text mode: usage_error appears in brackets on stderr', () => {
  const r = run(['signed']);  // missing path → usage_error
  assert.equal(r.status, 64);
  assert.match(r.stderr, /\[usage_error\]/);
  assert.match(r.stderr, /signed needs a path argument/);
});

test('fatal text mode: auth_missing_key appears in brackets', () => {
  const r = run(['signed', '/x', '--expires', '1700000000'], {
    SIGNED_URL_SECRET: '', STRATOS_NO_KEYCHAIN: '1',
  });
  assert.equal(r.status, 78);
  assert.match(r.stderr, /\[auth_missing_key\]/);
});

// ─── Structured mode — JSON envelope on stderr
// ────────────────────────────────────────────────────────────────────

test('fatal --json: emits structured error envelope to stderr', () => {
  const r = run(['signed', '--json']);
  assert.equal(r.status, 64);
  const env = JSON.parse(r.stderr);
  assert.equal(env.error.type, 'usage_error');
  assert.equal(env.error.retryable, false);
  assert.equal(env.error.exit_code, 64);
  assert.match(env.error.message, /signed needs a path/);
});

test('fatal --output ndjson: same envelope shape', () => {
  const r = run(['signed', '--output', 'ndjson']);
  assert.equal(r.status, 64);
  const env = JSON.parse(r.stderr);
  assert.equal(env.error.type, 'usage_error');
  assert.equal(env.error.exit_code, 64);
});

test('fatal --output yaml: structured mode still uses JSON envelope', () => {
  // The yaml output is for SUCCESS bodies; errors keep the same machine
  // envelope shape so agents have one parser regardless of output flag.
  const r = run(['signed', '--output', 'yaml']);
  assert.equal(r.status, 64);
  const env = JSON.parse(r.stderr);
  assert.equal(env.error.type, 'usage_error');
});

// ─── HTTP-status → type inference via emitFailure
// ────────────────────────────────────────────────────────────────────

test('emitFailure 401: auth_invalid envelope', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(failStatus(401, { message: 'no key' })));
    const r = await runAsync(['health', '--json'], {
      CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k',
    });
    assert.equal(r.status, 77);  // EX.NOPERM
    const env = JSON.parse(r.stderr.trim().split('\n').pop());
    assert.equal(env.error.type, 'auth_invalid');
    assert.equal(env.error.retryable, false);
    assert.equal(env.error.http_status, 401);
  } finally {
    if (srv) srv.close();
  }
});

test('emitFailure 404: target_not_found envelope', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(failStatus(404, { message: 'gone' })));
    const r = await runAsync(['health', '--json'], {
      CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k',
    });
    assert.equal(r.status, 69);  // EX.UNAVAILABLE
    const env = JSON.parse(r.stderr.trim().split('\n').pop());
    assert.equal(env.error.type, 'target_not_found');
    assert.equal(env.error.retryable, false);
    assert.equal(env.error.http_status, 404);
  } finally {
    if (srv) srv.close();
  }
});

test('emitFailure 429: rate_limited envelope is RETRYABLE', async () => {
  // The retryable bit is the contract that drives agent backoff loops.
  // 429 must be retryable: true; 4xx must be retryable: false. Lock it.
  let srv, base;
  try {
    ({ srv, base } = await startServer(failStatus(429, { message: 'slow down' })));
    const r = await runAsync(['health', '--json', '--retries', '0'], {
      CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k',
    });
    assert.equal(r.status, 75);  // EX.TEMPFAIL
    const env = JSON.parse(r.stderr.trim().split('\n').pop());
    assert.equal(env.error.type, 'rate_limited');
    assert.equal(env.error.retryable, true);
    assert.equal(env.error.http_status, 429);
  } finally {
    if (srv) srv.close();
  }
});

test('emitFailure 500: server_error envelope is RETRYABLE', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(failStatus(503, { message: 'maintenance' })));
    const r = await runAsync(['health', '--json', '--retries', '0'], {
      CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k',
    });
    assert.equal(r.status, 75);
    const env = JSON.parse(r.stderr.trim().split('\n').pop());
    assert.equal(env.error.type, 'server_error');
    assert.equal(env.error.retryable, true);
    assert.equal(env.error.http_status, 503);
  } finally {
    if (srv) srv.close();
  }
});

// ─── Schema integration — error_types is in the catalogue
// ────────────────────────────────────────────────────────────────────

test('schema: includes error_types registry', () => {
  const r = run(['schema']);
  assert.equal(r.status, 0);
  const s = JSON.parse(r.stdout);
  assert.equal(typeof s.error_types, 'object');
  for (const t of ['usage_error','auth_missing_key','auth_invalid','target_not_found','rate_limited','server_error','request_failed']) {
    assert.ok(s.error_types[t], `missing type ${t}`);
    assert.equal(typeof s.error_types[t].exit, 'number', `${t}.exit missing`);
    assert.equal(typeof s.error_types[t].retryable, 'boolean', `${t}.retryable missing`);
  }
  // Retryable contract: the two transient classes are retryable.
  assert.equal(s.error_types.rate_limited.retryable, true);
  assert.equal(s.error_types.server_error.retryable, true);
  assert.equal(s.error_types.request_failed.retryable, true);
  // And the permanent classes are not.
  assert.equal(s.error_types.usage_error.retryable, false);
  assert.equal(s.error_types.auth_invalid.retryable, false);
  assert.equal(s.error_types.target_not_found.retryable, false);
});

// ─── String-body 5xx exercises the `typeof body === 'string'` arm
// ────────────────────────────────────────────────────────────────────

test('emitFailure with plain-text error body: still produces envelope', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer((req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('upstream timeout');
    }));
    const r = await runAsync(['health', '--json', '--retries', '0'], {
      CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k',
    });
    assert.equal(r.status, 75);
    const env = JSON.parse(r.stderr.trim().split('\n').pop());
    assert.equal(env.error.type, 'server_error');
    assert.equal(env.error.http_status, 503);
    assert.match(env.error.message, /upstream timeout/);
  } finally {
    if (srv) srv.close();
  }
});

test('emitFailure with empty-object body: falls back to "HTTP <status>"', async () => {
  // Hits the falsy arm of `body.message || body.error || body.Message`.
  let srv, base;
  try {
    ({ srv, base } = await startServer((req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{}');  // no message / error / Message keys
    }));
    const r = await runAsync(['health', '--json', '--retries', '0'], {
      CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k',
    });
    // status 400 falls through typeForStatus's `data_error` arm (ignored
    // for coverage, defensive); EX.UNAVAILABLE = 69.
    assert.equal(r.status, 69);
    const env = JSON.parse(r.stderr.trim().split('\n').pop());
    assert.equal(env.error.http_status, 400);
    assert.match(env.error.message, /HTTP 400/);
  } finally {
    if (srv) srv.close();
  }
});

// ─── Backward compat — fatal() with no type still works
// ────────────────────────────────────────────────────────────────────

test('fatal without type: plain stderr (no brackets), no JSON envelope', () => {
  // `explain` with no arg goes through a plain `fatal()` call — no type.
  const r = run(['explain']);
  assert.equal(r.status, 64);
  // Plain `error:` prefix without `[type]` brackets.
  assert.match(r.stderr, /error:\s+explain needs/);
  assert.doesNotMatch(r.stderr, /\[\w+_\w+\]/);
});
