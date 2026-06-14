// SPDX-License-Identifier: MIT
//
// Tests for v0.0.5: --output yaml/csv, --filter, --rate, --otlp-endpoint,
// extract-release-notes, make-vex, make-homebrew, Dockerfile presence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, 'stratos.mjs');

function runClean(args, env = {}, opts = {}) {
  const baseEnv = { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1' };
  for (const k of [
    'CLOUDCDN_URL','CLOUDCDN_ACCOUNT_KEY','CLOUDCDN_ACCESS_KEY','SIGNED_URL_SECRET',
    'CLOUDCDN_TIMEOUT','CLOUDCDN_RETRIES','STRATOS_PROFILE',
    'GITHUB_ACTIONS','GITLAB_CI','CIRCLECI','JENKINS_URL','TF_BUILD','CI',
    'OTEL_EXPORTER_OTLP_ENDPOINT','OTEL_EXPORTER_OTLP_TRACES_ENDPOINT','OTEL_EXPORTER_OTLP_HEADERS',
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

const jsonServer = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

// ─────────────────────────────────────────────────────────────────────────────
// --output yaml | csv | table
// ─────────────────────────────────────────────────────────────────────────────

test('--output yaml: emits valid-shape YAML for object body (health)', async () => {
  await withServer(jsonServer({ status: 'ok', bindings: { ai: true, kv: false } }),
    async (base) => {
      const r = await runClean(['health', '--output', 'yaml'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /^status: ok/m);
      assert.match(r.stdout, /^bindings:/m);
      assert.match(r.stdout, /^ {2}ai: true/m);
      assert.match(r.stdout, /^ {2}kv: false/m);
    });
});

test('--output yaml: arrays render as block sequences', async () => {
  await withServer(jsonServer({ Page: 1, TotalPages: 1, Data: [
    { Path: '/a.svg', Size: 100, Format: 'svg' },
    { Path: '/b.png', Size: 200, Format: 'png' },
  ] }), async (base) => {
    const r = await runClean(['assets', '--output', 'yaml'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^-/m);
    assert.match(r.stdout, /Path: \/a\.svg/);
    assert.match(r.stdout, /Path: \/b\.png/);
  });
});

test('--output yaml: special characters get double-quoted', async () => {
  await withServer(jsonServer({ raw: 'a: b', empty: '', boolish: 'yes' }),
    async (base) => {
      const r = await runClean(['health', '--output', 'yaml'], { CLOUDCDN_URL: base });
      assert.match(r.stdout, /raw: "a: b"/);
      assert.match(r.stdout, /empty: ""/);
      assert.match(r.stdout, /boolish: "yes"/);
    });
});

test('--output csv: emits header row + escaped values', async () => {
  await withServer(jsonServer({ Page: 1, TotalPages: 1, Data: [
    { Path: '/a.svg', Size: 100, ContentType: 'image/svg+xml' },
    { Path: '/b,c.png', Size: 200, ContentType: 'image/png' },  // comma in value
    { Path: '/d"e.gif', Size: 300, ContentType: 'image/gif' },   // quote in value
  ] }), async (base) => {
    const r = await runClean(['assets', '--output', 'csv'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^Path,Size,ContentType/);
    assert.match(r.stdout, /"\/b,c\.png"/);          // comma triggers quoting
    assert.match(r.stdout, /"\/d""e\.gif"/);          // quote becomes ""
  });
});

test('--output table: forces table even on a pipe', async () => {
  await withServer(jsonServer({ Page: 1, TotalPages: 1, Data: [
    { Path: '/a.svg', Format: 'svg', Size: 1, ContentType: 'image/svg+xml' },
  ] }), async (base) => {
    const r = await runClean(['assets', '--output', 'table'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PATH\s+FORMAT/);
    assert.match(r.stdout, /\/a\.svg/);
  });
});

test('--output: invalid value fails EX_USAGE with the allowed list', async () => {
  const r = await runClean(['health', '--output', 'xml']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /json\|yaml\|csv\|table/);
});

test('--json remains a shortcut for --output json', async () => {
  await withServer(jsonServer({ status: 'ok' }), async (base) => {
    const r = await runClean(['health', '--json'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^\{"status":"ok"/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --filter (jq)
// ─────────────────────────────────────────────────────────────────────────────

test('--filter: pipes body through jq for object', async () => {
  await withServer(jsonServer({ bindings: { ai: true, kv: false, d1: true } }),
    async (base) => {
      const r = await runClean(['health', '--filter', '.bindings.ai'],
        { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      assert.match(r.stdout, /true/);
    });
});

test('--filter: multi-line jq output collapses to an array', async () => {
  await withServer(jsonServer({ bindings: { ai: true, kv: true, d1: false } }),
    async (base) => {
      const r = await runClean(['health',
        '--filter', '.bindings | to_entries[] | select(.value == true) | .key',
        '--output', 'json'], { CLOUDCDN_URL: base });
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.ok(Array.isArray(out));
      assert.deepEqual(out.sort(), ['ai', 'kv']);
    });
});

test('--filter: malformed jq exits EX_DATAERR (65)', async () => {
  await withServer(jsonServer({ x: 1 }), async (base) => {
    const r = await runClean(['health', '--filter', '.x | this_is_not_a_function'],
      { CLOUDCDN_URL: base });
    assert.equal(r.status, 65);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --rate parsing
// ─────────────────────────────────────────────────────────────────────────────

test('--rate: bad value fails EX_USAGE', async () => {
  const r = await runClean(['health', '--rate', 'fast']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--rate/);
});

test('--rate: accepts "10/s" and bare "10"', async () => {
  await withServer(jsonServer({ status: 'ok' }), async (base) => {
    const r1 = await runClean(['health', '--rate', '10/s'], { CLOUDCDN_URL: base });
    const r2 = await runClean(['health', '--rate', '10'],   { CLOUDCDN_URL: base });
    assert.equal(r1.status, 0);
    assert.equal(r2.status, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// --otlp-endpoint
// ─────────────────────────────────────────────────────────────────────────────

test('--otlp-endpoint: POSTs one span per command to /v1/traces', async () => {
  let received;
  await withServer((req, res) => {
    if (req.url === '/v1/traces') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', () => {
        received = JSON.parse(body);
        res.writeHead(200); res.end('{}');
      });
    } else {
      // The "API" endpoint stratos calls for `health`.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    }
  }, async (base) => {
    const r = await runClean(['health', '--otlp-endpoint', base],
      { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.ok(received, 'no OTLP span received');
    const span = received.resourceSpans[0].scopeSpans[0].spans[0];
    assert.equal(span.name, 'stratos health');
    assert.match(span.traceId, /^[0-9a-f]{32}$/);
    assert.match(span.spanId, /^[0-9a-f]{16}$/);
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
    // Service.name attribute round-trips.
    const resourceAttrs = received.resourceSpans[0].resource.attributes;
    const svc = resourceAttrs.find((a) => a.key === 'service.name');
    assert.equal(svc.value.stringValue, 'stratos');
  });
});

test('--otlp-endpoint: env var OTEL_EXPORTER_OTLP_ENDPOINT also works', async () => {
  let received = false;
  await withServer((req, res) => {
    if (req.url === '/v1/traces') {
      received = true;
      let body = ''; req.on('data', (c) => body += c);
      req.on('end', () => { res.writeHead(200); res.end('{}'); });
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    }
  }, async (base) => {
    await runClean(['health'],
      { CLOUDCDN_URL: base, OTEL_EXPORTER_OTLP_ENDPOINT: base });
    assert.ok(received, 'OTLP span not sent via env');
  });
});

test('--otlp-endpoint + --verbose: logs exporter non-2xx', async () => {
  await withServer((req, res) => {
    if (req.url === '/v1/traces') { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
  }, async (base) => {
    const r = await runClean(['health', '--otlp-endpoint', base, '--verbose'],
      { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /otlp: exporter HTTP 500/);
  });
});

test('--rate: limiter spaces out multi-batch storage sync', async () => {
  // 60 files at 50/batch → 2 batches. With --rate 2/s the second batch
  // waits ~500 ms before its acquire() returns. Total elapsed should be
  // ≥ 450 ms but well under 2 s.
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-rate-'));
    for (let i = 0; i < 60; i++) await writeFile(join(tmp, `f${i}.txt`), 'x');
    await withServer(jsonServer({ ok: true }), async (base) => {
      const start = Date.now();
      const r = await runClean(['storage', 'sync', tmp, '/x', '--rate', '2'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      const elapsed = Date.now() - start;
      assert.equal(r.status, 0);
      assert.ok(elapsed >= 400, `expected ≥ 400 ms with --rate 2, got ${elapsed} ms`);
      assert.ok(elapsed < 5000, `did not expect ≥ 5 s, got ${elapsed} ms`);
    });
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('--rate: fractional rate (0.5/s) is honoured by the limiter', async () => {
  // With --rate 0.5/s, the first batch is immediate; a hypothetical
  // second batch would wait 2000 ms. Storage sync of < 50 files is a
  // single batch, so this tests the parser + no-spurious-block path.
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-rate-frac-'));
    await writeFile(join(tmp, 'one.txt'), 'x');
    await withServer(jsonServer({ ok: true }), async (base) => {
      const start = Date.now();
      const r = await runClean(['storage', 'sync', tmp, '/x', '--rate', '0.5'],
        { CLOUDCDN_URL: base, CLOUDCDN_ACCOUNT_KEY: 'k' });
      const elapsed = Date.now() - start;
      assert.equal(r.status, 0);
      assert.ok(elapsed < 2000, `single-batch sync should not wait; got ${elapsed} ms`);
    });
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('--output csv on non-list body wraps the body in a single-row CSV', async () => {
  await withServer(jsonServer({ status: 'ok', version: '0.0.5' }), async (base) => {
    const r = await runClean(['health', '--output', 'csv'], { CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^status,version/);
    assert.match(r.stdout, /^ok,0\.0\.5/m);
  });
});

test('toYaml: emits "null" for null', async () => {
  await withServer(jsonServer({ a: null }), async (base) => {
    const r = await runClean(['health', '--output', 'yaml'], { CLOUDCDN_URL: base });
    assert.match(r.stdout, /^a: null/m);
  });
});

test('--otlp-endpoint: exporter failure does NOT fail the command (best-effort)', async () => {
  await withServer(jsonServer({ status: 'ok' }), async (base) => {
    // Point OTLP at an unreachable port so the exporter fails.
    const r = await runClean(['health', '--otlp-endpoint', 'http://127.0.0.1:1'],
      { CLOUDCDN_URL: base, CLOUDCDN_TIMEOUT: '5000' });
    assert.equal(r.status, 0);  // command still succeeded
  });
});

test('--otlp-headers: parses k=v,k=v', async () => {
  let received;
  await withServer((req, res) => {
    if (req.url === '/v1/traces') {
      received = req.headers;
      let body = ''; req.on('data', (c) => body += c);
      req.on('end', () => { res.writeHead(200); res.end('{}'); });
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
    }
  }, async (base) => {
    await runClean(['health', '--otlp-endpoint', base,
      '--otlp-headers', 'authorization=Bearer abc123,x-tenant=acme'],
      { CLOUDCDN_URL: base });
    assert.equal(received.authorization, 'Bearer abc123');
    assert.equal(received['x-tenant'], 'acme');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// scripts/ helpers
// ─────────────────────────────────────────────────────────────────────────────

test('extract-release-notes: pulls the section for the given version', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath,
      [join(REPO, 'scripts', 'extract-release-notes.mjs'), '0.0.4'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /stratos explain/);
  assert.doesNotMatch(r.stdout, /^## \[0\.0\.3\]/m); // stops before next section
});

test('extract-release-notes: unknown version exits non-zero', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath,
      [join(REPO, 'scripts', 'extract-release-notes.mjs'), '99.99.99'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ code, stderr }));
  });
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /could not find/);
});

test('make-vex: produces valid CycloneDX 1.6 VEX doc', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath,
      [join(REPO, 'scripts', 'make-vex.mjs'), '0.0.5'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => stdout += d);
    child.on('close', (code) => resolve({ stdout, code }));
  });
  assert.equal(r.code, 0);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.bomFormat, 'CycloneDX');
  assert.equal(doc.specVersion, '1.6');
  assert.match(doc.serialNumber, /^urn:uuid:/);
  assert.equal(doc.metadata.component.purl, 'pkg:npm/@cloudcdn/stratos@0.0.5');
  assert.ok(Array.isArray(doc.vulnerabilities));
});

test('make-homebrew: produces a valid-looking Formula', async () => {
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath,
      [join(REPO, 'scripts', 'make-homebrew.mjs'), '0.0.5'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => stdout += d);
    child.on('close', (code) => resolve({ stdout, code }));
  });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /class Stratos < Formula/);
  assert.match(r.stdout, /version "0\.0\.5"/);
  assert.match(r.stdout, /stratos-darwin-arm64/);
  assert.match(r.stdout, /stratos-linux-x64/);
  assert.match(r.stdout, /REPLACE_WITH_DARWIN_ARM64_SHA/);  // template placeholder
});

test('Dockerfile exists at repo root', async () => {
  await access(join(REPO, 'Dockerfile'));
  const dockerfile = await readFile(join(REPO, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /^FROM node:/m);
  assert.match(dockerfile, /COPY stratos\.mjs/);
  assert.match(dockerfile, /ENTRYPOINT \["stratos"\]/);
});
