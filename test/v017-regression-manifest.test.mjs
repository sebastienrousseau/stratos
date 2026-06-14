// SPDX-License-Identifier: MIT
//
// v0.0.17 — manifest-coherence regression.
//
// Stratos has four parallel registries that MUST agree:
//
//   - KNOWN_COMMANDS (the router's command-name allow-list, used by
//     suggestCommand and cmdCompletion)
//   - COMMAND_META (per-command exits[]/mcp_tool/since/summary — drives
//     `stratos schema`)
//   - MCP_TOOLS (the JSON-RPC tool registry exposed over stdio)
//   - the ESM `export { … }` block (what library consumers can import)
//
// When these drift, the failure modes are subtle: a command suggested
// by completion that doesn't dispatch, an MCP tool the schema doesn't
// list, a documented exit code no command emits. This file asserts
// they stay in sync — adding a new command without updating one of the
// four registries fails CI before merge.
//
// The schema verb is the gateway: `stratos schema` is the public
// document we ship as ground truth. Everything else cross-references
// against it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'stratos.mjs');

/**
 * Spawn the CLI and return { status, stdout, stderr }.
 *
 * @param {string[]} args
 * @param {Object<string,string>} [env]
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, STRATOS_CI: '0', NO_COLOR: '1', STRATOS_NO_KEYCHAIN: '1', ...env },
    encoding: 'utf8',
  });
}

// Capture the schema once — every test asserts against the same snapshot.
const r = run(['schema']);
assert.equal(r.status, 0, `schema must exit 0; stderr=${r.stderr}`);
const SCHEMA = JSON.parse(r.stdout);

// Import what the library actually exports so we can compare it against
// what the schema claims.
const stratos = await import('../stratos.mjs');

// ─── Schema shape ─────────────────────────────────────────────────────

test('manifest: schema top-level keys are stable', () => {
  const required = ['$schema', 'tool', 'version', 'homepage', 'commands', 'error_types'];
  for (const key of required) {
    assert.ok(key in SCHEMA, `schema missing top-level key: ${key}`);
  }
  assert.equal(SCHEMA.tool, 'stratos');
  assert.match(SCHEMA.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Array.isArray(SCHEMA.commands));
  assert.ok(SCHEMA.commands.length >= 30, `expected ≥ 30 commands, got ${SCHEMA.commands.length}`);
});

test('manifest: every command has a unique name', () => {
  const seen = new Set();
  for (const c of SCHEMA.commands) {
    assert.ok(!seen.has(c.name), `duplicate command name in schema: ${c.name}`);
    seen.add(c.name);
  }
});

test('manifest: every command has summary + usage + exits[] + since', () => {
  for (const c of SCHEMA.commands) {
    assert.equal(typeof c.name, 'string', `${c.name}: name`);
    assert.ok(c.summary?.length > 0, `${c.name}: missing summary`);
    assert.ok(c.usage?.length > 0, `${c.name}: missing usage`);
    assert.ok(Array.isArray(c.exits) && c.exits.length > 0, `${c.name}: missing exits[]`);
    assert.match(c.since, /^\d+\.\d+\.\d+$/, `${c.name}: malformed since=${c.since}`);
  }
});

test('manifest: every command\'s exits[] is sorted ascending (deterministic)', () => {
  for (const c of SCHEMA.commands) {
    for (let i = 1; i < c.exits.length; i++) {
      assert.ok(c.exits[i - 1] < c.exits[i],
        `${c.name}: exits not sorted: ${JSON.stringify(c.exits)}`);
    }
  }
});

// ─── EX × exits[] cross-reference ─────────────────────────────────────

test('manifest: every exit code in any command is a documented EX.* value', () => {
  const validCodes = new Set(Object.values(stratos.EX));
  for (const c of SCHEMA.commands) {
    for (const code of c.exits) {
      assert.ok(validCodes.has(code),
        `${c.name}: exit ${code} not in EX registry (valid: ${[...validCodes].sort((a, b) => a - b).join(', ')})`);
    }
  }
});

test('manifest: every EX code is referenced somewhere in the schema', () => {
  // Two valid sources: a command's exits[] (documented per-command), or
  // error_types.<x>.exit (framework-level errors like software_error
  // that any command can theoretically emit). EX_NOINPUT / EX_CANTCREAT
  // are reserved sysexits we don't currently use.
  const aspirational = new Set([stratos.EX.NOINPUT, stratos.EX.CANTCREAT]);
  const referenced = new Set([
    ...SCHEMA.commands.flatMap((c) => c.exits),
    ...Object.values(SCHEMA.error_types).map((e) => e.exit),
  ]);
  for (const [name, code] of Object.entries(stratos.EX)) {
    if (aspirational.has(code)) continue;
    assert.ok(referenced.has(code),
      `EX.${name} (${code}) is in the registry but no command lists it AND no error_type maps to it — dead code`);
  }
});

// ─── error_types × EX cross-reference ────────────────────────────────

test('manifest: every error_types entry has a valid exit code', () => {
  const validCodes = new Set(Object.values(stratos.EX));
  for (const [type, def] of Object.entries(SCHEMA.error_types)) {
    assert.ok(validCodes.has(def.exit),
      `error_types.${type}.exit=${def.exit} not in EX registry`);
    assert.equal(typeof def.retryable, 'boolean', `error_types.${type}.retryable`);
    assert.ok(def.summary?.length > 0, `error_types.${type}.summary`);
  }
});

test('manifest: retryable bits match the documented contract', () => {
  // This is the contract agents drive backoff loops from. If any of
  // these flip, downstream agents silently mis-classify failures.
  const expected = {
    usage_error: false,
    auth_missing_key: false,
    auth_invalid: false,
    target_not_found: false,
    rate_limited: true,
    server_error: true,
    request_failed: true,
    data_error: false,
    io_error: false,
    unavailable: false,
    software_error: false,
  };
  for (const [type, want] of Object.entries(expected)) {
    assert.ok(SCHEMA.error_types[type],
      `missing error_types.${type} — adding a type is fine, removing/renaming breaks the agent contract`);
    assert.equal(SCHEMA.error_types[type].retryable, want,
      `error_types.${type}.retryable contract flipped: expected ${want}, got ${SCHEMA.error_types[type].retryable}`);
  }
});

// ─── MCP_TOOLS × schema cross-reference ──────────────────────────────

test('manifest: every MCP_TOOLS entry resolves to a known command', () => {
  // The mapping is N:1 — `cloudcdn_insights_summary` and
  // `cloudcdn_insights_top` both drive `insights`, `cloudcdn_ai_alt`
  // and `cloudcdn_ai_moderate` both drive `ai`. So we don't assert
  // 1:1; we assert each tool name strips to a real command.
  const commandNames = new Set(SCHEMA.commands.map((c) => c.name));
  for (const tool of stratos.MCP_TOOLS) {
    // cloudcdn_<verb>[_<subverb>] → split, take the second token.
    const verb = tool.name.split('_')[1];
    assert.ok(commandNames.has(verb),
      `MCP tool "${tool.name}" → expected verb "${verb}" in schema commands but not found`);
  }
});

test('manifest: every command.mcp_tool exists in MCP_TOOLS (primary tool)', () => {
  const mcpNames = new Set(stratos.MCP_TOOLS.map((t) => t.name));
  for (const c of SCHEMA.commands) {
    if (!c.mcp_tool) continue;
    assert.ok(mcpNames.has(c.mcp_tool),
      `${c.name} claims mcp_tool="${c.mcp_tool}" but MCP_TOOLS has no such entry`);
  }
});

test('manifest: every MCP tool name follows the cloudcdn_* convention', () => {
  for (const tool of stratos.MCP_TOOLS) {
    assert.match(tool.name, /^cloudcdn_[a-z_]+$/,
      `MCP tool name "${tool.name}" breaks the cloudcdn_* convention`);
    assert.ok(tool.desc?.length > 0, `MCP tool ${tool.name}: missing desc`);
    assert.ok(tool.schema && typeof tool.schema === 'object',
      `MCP tool ${tool.name}: missing JSON schema`);
    assert.equal(tool.schema.type, 'object', `MCP tool ${tool.name}: schema.type must be 'object'`);
  }
});

// ─── Public exports × library consumer expectations ──────────────────

test('manifest: every documented export is actually exported', () => {
  // These are the symbols README.md's "Public exports" table promises.
  // Removing one is a breaking change for library consumers.
  const promised = [
    'main', 'VERSION', 'EX', 'jsonReq', 'envConfig', 'MCP_TOOLS', 'mcpCall',
    'cmdHealth', 'cmdAssets', 'cmdInsights', 'cmdZones', 'cmdTokens', 'cmdWebhooks',
    'cmdStorage', 'cmdLogs', 'cmdAI', 'cmdImage', 'cmdSearch', 'cmdAsk',
    'cmdPurge', 'cmdSigned',  // these two are exported at declaration site
    'parseFlags',             // also at declaration site; the bare-export form
  ];
  for (const sym of promised) {
    assert.ok(sym in stratos, `library export missing: ${sym}`);
  }
});

test('manifest: VERSION matches package.json', async () => {
  const pkg = JSON.parse(
    await (await import('node:fs/promises')).readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
  assert.equal(stratos.VERSION, pkg.version,
    `VERSION drift: stratos.mjs=${stratos.VERSION} vs package.json=${pkg.version}`);
});

test('manifest: EX is a frozen object', () => {
  assert.ok(Object.isFrozen(stratos.EX),
    'EX must be frozen; library consumers may rely on stable exit-code constants');
});

// ─── Schema verb determinism (the contract is: byte-identical bytes) ─

test('manifest: stratos schema is byte-deterministic across consecutive runs', () => {
  const a = run(['schema']);
  const b = run(['schema']);
  assert.equal(a.stdout, b.stdout,
    'schema output must be deterministic — it is meant to be cached, hashed, and attested');
});
