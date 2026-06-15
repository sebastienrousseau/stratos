// SPDX-License-Identifier: MIT
//
// v0.0.20 — cost + carbon + rules validate tests.
//
// `stratos cost`   queries /api/billing/usage and falls back to
//                  projecting from /api/core/statistics × rate card.
// `stratos carbon` queries the same usage endpoint and layers on top
//                  energy coefficients × grid intensity (live via
//                  Electricity Maps when reachable, static defaults
//                  otherwise).
// `stratos rules validate` is offline; parses _headers / _redirects
//                  locally and emits an issue list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
      env: { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1', ...env },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
  });
}

const json = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'function' ? body(req) : JSON.stringify(body));
};

const AUTH = { CLOUDCDN_ACCOUNT_KEY: 'k', CLOUDCDN_ACCESS_KEY: 'k' };

// ─── stratos cost
// ────────────────────────────────────────────────────────────────────

test('cost: real billing endpoint → returns per-region cost rollup', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer((req, res) => {
      if (req.url.startsWith('/api/billing/usage')) {
        json({
          mode: 'actual',
          days: 7,
          regions: [
            { name: 'us-east',  requests: 5_000_000, bytes: 100 * 1024 ** 3 },
            { name: 'eu-west',  requests: 2_000_000, bytes:  40 * 1024 ** 3 },
          ],
        })(req, res);
        return;
      }
      res.writeHead(404).end();
    }));
    const r = await run(['cost', '--days', '7', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.mode, 'actual');
    assert.equal(body.regions.length, 2);
    // us-east: 5M req × $0.20/M + 100 GB × $0.05 = 1 + 5 = $6.00
    assert.equal(body.regions[0].cost_usd, 6);
    // eu-west: 2M × $0.20 + 40 × $0.05 = 0.4 + 2 = $2.40
    assert.equal(body.regions[1].cost_usd, 2.4);
    assert.equal(body.total_usd, 8.4);
  } finally { if (srv) srv.close(); }
});

test('cost --projected: forces statistics-based projection', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer((req, res) => {
      if (req.url.startsWith('/api/core/statistics')) {
        json({
          regions: [{ name: 'global', requests: 10_000_000, bytes: 500 * 1024 ** 3 }],
        })(req, res);
        return;
      }
      res.writeHead(404).end();
    }));
    const r = await run(['cost', '--projected', '--days', '30', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.mode, 'projected');
    // 10M × $0.20 + 500 × $0.05 = 2 + 25 = $27
    assert.equal(body.total_usd, 27);
  } finally { if (srv) srv.close(); }
});

test('cost: 401 from billing → propagates auth_invalid', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'no key' }));
    }));
    const r = await run(['cost', '--days', '7', '--json'],
      { ...AUTH, CLOUDCDN_URL: base, CLOUDCDN_RETRIES: '0' });
    assert.equal(r.status, 77);  // EX.NOPERM
    const env = JSON.parse(r.stderr.trim().split('\n').pop());
    assert.equal(env.error.type, 'auth_invalid');
  } finally { if (srv) srv.close(); }
});

// ─── stratos carbon
// ────────────────────────────────────────────────────────────────────

test('carbon: usage × energy × static intensity → gCO2e rollup', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer((req, res) => {
      if (req.url.startsWith('/api/billing/usage')) {
        json({
          regions: [
            { name: 'us-east', requests: 10_000_000, bytes: 1000 * 1024 ** 3 },   // 1 TB
            { name: 'eu-west', requests:  5_000_000, bytes:  500 * 1024 ** 3 },   // 500 GB
          ],
        })(req, res);
        return;
      }
      res.writeHead(404).end();
    }));
    const r = await run(['carbon', '--days', '30', '--no-live-intensity', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.regions.length, 2);
    // us-east: 10M × 1e-7 kWh + 1000 GB × 2e-4 kWh = 1 + 0.2 = 1.2 kWh × 380 = 456 g
    assert.equal(body.regions[0].region, 'us-east');
    assert.equal(body.regions[0].intensity_g_per_kwh, 380);
    assert.equal(body.regions[0].intensity_source, 'static');
    assert.equal(body.regions[0].total_kwh, 1.2);
    assert.equal(body.regions[0].co2e_g, 456);
    // eu-west: 5M × 1e-7 + 500 × 2e-4 = 0.5 + 0.1 = 0.6 kWh × 220 = 132 g
    assert.equal(body.regions[1].co2e_g, 132);
    assert.equal(body.totals.total_co2e_g, 456 + 132);
  } finally { if (srv) srv.close(); }
});

test('carbon --intensity-below: gate passes when cleanest region is below threshold', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({
      regions: [
        { name: 'us-east',  requests: 1000, bytes: 1024 ** 3 },  // 380 gCO2e/kWh
        { name: 'eu-north', requests: 1000, bytes: 1024 ** 3 },  //  30 gCO2e/kWh
      ],
    })));
    const r = await run(
      ['carbon', '--intensity-below', '100', '--no-live-intensity', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);  // eu-north's 30 < 100
    const body = JSON.parse(r.stdout);
    assert.equal(body.cleanest, 30);
  } finally { if (srv) srv.close(); }
});

test('carbon --intensity-below: gate fails (exit 69) when no region is below threshold', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({
      regions: [
        { name: 'ap-south', requests: 1000, bytes: 1024 ** 3 },  // 680
        { name: 'us-east',  requests: 1000, bytes: 1024 ** 3 },  // 380
      ],
    })));
    const r = await run(
      ['carbon', '--intensity-below', '100', '--no-live-intensity', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 69);  // EX.UNAVAILABLE — gate refused
  } finally { if (srv) srv.close(); }
});

test('carbon: unknown region falls back to default intensity', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({
      regions: [{ name: 'mars-1', requests: 1_000_000, bytes: 100 * 1024 ** 3 }],
    })));
    const r = await run(['carbon', '--no-live-intensity', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.regions[0].intensity_g_per_kwh, 400);   // CARBON_DEFAULTS.intensity_g_per_kwh.default
  } finally { if (srv) srv.close(); }
});

// ─── stratos rules validate (offline; no server)
// ────────────────────────────────────────────────────────────────────

test('rules validate _headers: clean file exits 0', async () => {
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-rules-validate-'));
    const f = join(tmp, '_headers');
    await writeFile(f, '/api/*\n  Cache-Control: no-store\n  X-Frame-Options: DENY\n\n# comment\n/static/*\n  Cache-Control: public, max-age=31536000\n');
    const r = await run(['rules', 'validate', '_headers', '-f', f]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /no issues/);
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('rules validate _headers: bad URL pattern → EX_DATAERR + issue list', async () => {
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-rules-validate-'));
    const f = join(tmp, '_headers');
    await writeFile(f, 'no-slash-prefix\n  Cache-Control: no-store\n');
    const r = await run(['rules', 'validate', '_headers', '-f', f, '--output', 'json']);
    assert.equal(r.status, 65);  // EX.DATAERR
    assert.match(r.stderr, /URL pattern must start with '\/' or '\*'/);
    const body = JSON.parse(r.stdout);
    assert.equal(body.issues[0].line, 1);
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('rules validate _headers: missing colon in header → flagged', async () => {
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-rules-validate-'));
    const f = join(tmp, '_headers');
    await writeFile(f, '/api/*\n  Cache-Control no-store\n');
    const r = await run(['rules', 'validate', '_headers', '-f', f, '--output', 'json']);
    assert.equal(r.status, 65);
    assert.match(r.stderr, /header must be 'Name: value'/);
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('rules validate _redirects: clean file exits 0', async () => {
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-rules-validate-'));
    const f = join(tmp, '_redirects');
    await writeFile(f, '# This is a comment\n/old /new\n/blog/* /posts/:splat 301\n/legacy /modern 302\n');
    const r = await run(['rules', 'validate', '_redirects', '-f', f]);
    assert.equal(r.status, 0);
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('rules validate _redirects: bad from prefix → flagged', async () => {
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-rules-validate-'));
    const f = join(tmp, '_redirects');
    await writeFile(f, 'no-slash /target 301\n');
    const r = await run(['rules', 'validate', '_redirects', '-f', f, '--output', 'json']);
    assert.equal(r.status, 65);
    assert.match(r.stderr, /'from' must start with '\/' or '\*'/);
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('rules validate _redirects: bad status code → flagged', async () => {
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-rules-validate-'));
    const f = join(tmp, '_redirects');
    await writeFile(f, '/foo /bar 200\n');
    const r = await run(['rules', 'validate', '_redirects', '-f', f, '--output', 'json']);
    assert.equal(r.status, 65);
    assert.match(r.stderr, /status must be a redirect code/);
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('rules validate _redirects: wrong token count → flagged', async () => {
  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), 'stratos-rules-validate-'));
    const f = join(tmp, '_redirects');
    await writeFile(f, '/foo\n');
    const r = await run(['rules', 'validate', '_redirects', '-f', f, '--output', 'json']);
    assert.equal(r.status, 65);
    assert.match(r.stderr, /expected 'from to \[status\]'/);
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
});

test('rules validate: missing -f flag → EX_USAGE', async () => {
  const r = await run(['rules', 'validate', '_headers']);
  assert.equal(r.status, 64);
});

test('rules validate: unknown file type → EX_USAGE', async () => {
  const r = await run(['rules', 'validate', '_bogus', '-f', '/tmp/x']);
  assert.equal(r.status, 64);
});

// ─── Branch coverage: zone/region flags + projection-fallback shape +
//     reduce-false arm.
// ────────────────────────────────────────────────────────────────────

test('cost --zone --projected: zone is forwarded; stats without .regions falls back to global synthesised entry', async () => {
  let srv, base;
  try {
    let lastQuery = '';
    ({ srv, base } = await startServer((req, res) => {
      if (req.url.startsWith('/api/core/statistics')) {
        lastQuery = req.url;
        // Body without a `regions` array → exercises the
        // Array.isArray(stats?.regions) false arm. Also: requests=0 and
        // bytes=0 trigger the `r.requests || 0` / `r.bytes || 0` falsy
        // arms in the .map.
        json({ requests: 0, bytes: 0 })(req, res);
        return;
      }
      res.writeHead(404).end();
    }));
    const r = await run(['cost', '--zone', 'us-east-1', '--projected', '--days', '7', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(lastQuery, /zone=us-east-1/);
    const body = JSON.parse(r.stdout);
    assert.equal(body.regions[0].region, 'global');
    assert.equal(body.regions[0].cost_usd, 0);
    assert.equal(body.total_usd, 0);
  } finally { if (srv) srv.close(); }
});

test('carbon --region: region is forwarded; reduce false-arm exercised', async () => {
  let srv, base;
  try {
    let lastQuery = '';
    ({ srv, base } = await startServer((req, res) => {
      lastQuery = req.url;
      // Order is intentional: eu-north (30) first, then us-east (380).
      // The reduce starts at Infinity; eu-north < Infinity → true (sets
      // min=30); us-east < 30 → FALSE (returns existing min). Exercises
      // the `<` false arm at L2703.
      json({
        regions: [
          { name: 'eu-north', requests: 1_000_000, bytes: 10 * 1024 ** 3 },
          { name: 'us-east',  requests: 1_000_000, bytes: 10 * 1024 ** 3 },
        ],
      })(req, res);
    }));
    const r = await run(
      ['carbon', '--region', 'us-east-1', '--no-live-intensity', '--output', 'json'],
      { ...AUTH, CLOUDCDN_URL: base });
    assert.equal(r.status, 0);
    assert.match(lastQuery, /region=us-east-1/);
    const body = JSON.parse(r.stdout);
    assert.equal(body.regions.length, 2);
  } finally { if (srv) srv.close(); }
});

// ─── MCP tool dispatch for cost + carbon (in-process)
// ────────────────────────────────────────────────────────────────────

test('mcp: cloudcdn_cost tool dispatches cmdCost', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({
      regions: [{ name: 'us-east', requests: 1_000_000, bytes: 10 * 1024 ** 3 }],
    })));
    process.env.CLOUDCDN_URL = base;
    process.env.CLOUDCDN_ACCOUNT_KEY = 'k';
    process.env.CLOUDCDN_ACCESS_KEY = 'k';
    const { mcpCall } = await import('../stratos.mjs');
    const result = await mcpCall('cloudcdn_cost', { days: 7 });
    assert.ok(result.stdout.length > 0, 'cmdCost should have produced output');
    assert.match(result.stdout, /us-east/);
  } finally {
    if (srv) srv.close();
    delete process.env.CLOUDCDN_URL;
    delete process.env.CLOUDCDN_ACCOUNT_KEY;
    delete process.env.CLOUDCDN_ACCESS_KEY;
  }
});

test('mcp: cloudcdn_carbon tool dispatches cmdCarbon', async () => {
  let srv, base;
  try {
    ({ srv, base } = await startServer(json({
      regions: [{ name: 'eu-north', requests: 1_000_000, bytes: 10 * 1024 ** 3 }],
    })));
    process.env.CLOUDCDN_URL = base;
    process.env.CLOUDCDN_ACCOUNT_KEY = 'k';
    process.env.CLOUDCDN_ACCESS_KEY = 'k';
    const { mcpCall } = await import('../stratos.mjs');
    const result = await mcpCall('cloudcdn_carbon', { days: 7, 'no-live-intensity': true });
    assert.ok(result.stdout.length > 0, 'cmdCarbon should have produced output');
    assert.match(result.stdout, /eu-north/);
  } finally {
    if (srv) srv.close();
    delete process.env.CLOUDCDN_URL;
    delete process.env.CLOUDCDN_ACCOUNT_KEY;
    delete process.env.CLOUDCDN_ACCESS_KEY;
  }
});

// ─── schema includes the three new commands
// ────────────────────────────────────────────────────────────────────

test('schema: includes cost, carbon, and reflects rules validate', async () => {
  const r = await run(['schema']);
  assert.equal(r.status, 0);
  const s = JSON.parse(r.stdout);
  const byName = Object.fromEntries(s.commands.map((c) => [c.name, c]));
  assert.ok(byName.cost,   'schema missing cost');
  assert.ok(byName.carbon, 'schema missing carbon');
  assert.equal(byName.cost.mcp_tool,   'cloudcdn_cost');
  assert.equal(byName.carbon.mcp_tool, 'cloudcdn_carbon');
  assert.ok(byName.rules.exits.includes(65), 'rules should now declare EX_DATAERR (added by validate)');
});
