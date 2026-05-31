// SPDX-License-Identifier: MIT
//
// MCP protocol smoke test — spawn `stratos mcp serve`, drive it with a couple
// of JSON-RPC messages on stdin, parse the JSON-RPC responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

function drive(messages, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'mcp', 'serve'],
      { env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timeout; stderr=${stderr}`)); }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve({ stdout, stderr }); });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    // Give the server a tick to respond before closing stdin.
    setTimeout(() => child.stdin.end(), 200);
  });
}

test('mcp: initialize returns protocolVersion + serverInfo', async () => {
  const { stdout } = await drive([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  ]);
  const responses = stdout.trim().split('\n').map((l) => JSON.parse(l));
  const r = responses.find((x) => x.id === 1);
  assert.ok(r);
  assert.equal(r.result.serverInfo.name, 'stratos');
  assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
});

test('mcp: tools/list returns expected tools', async () => {
  const { stdout } = await drive([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);
  const responses = stdout.trim().split('\n').map((l) => JSON.parse(l));
  const r = responses.find((x) => x.id === 2);
  const names = r.result.tools.map((t) => t.name);
  assert.ok(names.includes('cloudcdn_health'));
  assert.ok(names.includes('cloudcdn_purge'));
  assert.ok(names.includes('cloudcdn_signed'));
});

test('mcp: unknown method returns -32601', async () => {
  const { stdout } = await drive([
    { jsonrpc: '2.0', id: 9, method: 'nope', params: {} },
  ]);
  const r = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(r.error.code, -32601);
});
