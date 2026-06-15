#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * @file Stratos — official CloudCDN CLI.
 *
 * A single-file, zero-runtime-dependency Node ≥ 20 CLI that covers the full
 * CloudCDN control plane: cache purge, signed URLs, asset catalogue,
 * insights, zones, tokens, webhooks, rules, storage, logs (SSE), AI vision,
 * image transforms, pipeline, search, and an MCP stdio server.
 *
 * The module exposes a small public API for tests and embedders
 * (`parseFlags`, `main`, `jsonReq`, …) but the production entry point is
 * the script invocation guard at the bottom of the file.
 *
 * @see {@link https://github.com/sebastienrousseau/stratos}
 * @license MIT
 */

import { readFile, writeFile, mkdir, stat, readdir, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir, platform } from 'node:os';
import { resolve as resolvePath, join, dirname, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Current CLI semantic version. Surfaced via `stratos version`,
 * the `User-Agent` header on every HTTP request, and the MCP
 * `serverInfo.version` field.
 *
 * @type {string}
 */
const VERSION = '0.0.20';

// ─────────────────────────────────────────────────────────────────────────────
// Sysexits — sysexits.h conventions, so CI / make / sh can branch on cause.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sysexits-style exit codes. Honours the conventions in `<sysexits.h>` so
 * downstream shells and CI systems can branch on the failure mode without
 * matching on stderr strings.
 *
 * @type {Readonly<{
 *   OK: 0, USAGE: 64, DATAERR: 65, NOINPUT: 66, UNAVAILABLE: 69,
 *   SOFTWARE: 70, CANTCREAT: 73, IOERR: 74, TEMPFAIL: 75,
 *   NOPERM: 77, CONFIG: 78,
 * }>}
 */
const EX = Object.freeze({
  OK: 0,
  USAGE: 64,
  DATAERR: 65,
  NOINPUT: 66,
  UNAVAILABLE: 69,
  SOFTWARE: 70,
  CANTCREAT: 73,
  IOERR: 74,
  TEMPFAIL: 75,
  NOPERM: 77,
  CONFIG: 78,
});

/**
 * Stable error-type registry. Each type is a contract with the agent
 * caller: the string identifier never changes, the `retryable` field
 * never flips, the exit code is fixed. Adding a new type is fine;
 * renaming or removing one is a breaking change.
 *
 * Agents drive retry / surface logic from these:
 *
 *   - `retryable: true` ⇒ exponential backoff, then re-try
 *   - `retryable: false` ⇒ surface to the user; don't retry
 *
 * Surfaced as JSON when `--output json|ndjson|yaml` is set:
 *
 *   {"error": {"type": "rate_limited", "message": "...",
 *              "retryable": true, "exit_code": 75, "http_status": 429}}
 *
 * `stratos schema` includes the type table for introspection.
 *
 * @type {Object<string, { exit: number, retryable: boolean, summary: string }>}
 */
const ERROR_TYPES = Object.freeze({
  usage_error:      { exit: EX.USAGE,       retryable: false, summary: 'Invalid command-line invocation.' },
  auth_missing_key: { exit: EX.CONFIG,      retryable: false, summary: 'Required credential not configured.' },
  auth_invalid:     { exit: EX.NOPERM,      retryable: false, summary: 'Credential rejected by the API (401/403).' },
  target_not_found: { exit: EX.UNAVAILABLE, retryable: false, summary: 'Resource does not exist (404).' },
  rate_limited:     { exit: EX.TEMPFAIL,    retryable: true,  summary: 'API rate limit reached (429); back off and retry.' },
  server_error:     { exit: EX.TEMPFAIL,    retryable: true,  summary: 'Upstream 5xx response; transient, retry with backoff.' },
  request_failed:   { exit: EX.TEMPFAIL,    retryable: true,  summary: 'Network or transport failure; retry with backoff.' },
  data_error:       { exit: EX.DATAERR,     retryable: false, summary: 'Malformed input or response (400/422 or local parse error).' },
  io_error:         { exit: EX.IOERR,       retryable: false, summary: 'Local filesystem failure (read/write/permissions).' },
  unavailable:      { exit: EX.UNAVAILABLE, retryable: false, summary: 'Operation could not be completed.' },
  software_error:   { exit: EX.SOFTWARE,    retryable: false, summary: 'Unexpected internal error (likely a bug).' },
});

/**
 * Infer a stable error type from an HTTP status code. Used by
 * {@link emitFailure} so HTTP failures surface a typed envelope to
 * agent callers without each call site having to pass `type` explicitly.
 *
 * @param {number} status - HTTP status code.
 * @returns {string} A key from {@link ERROR_TYPES}.
 */
function typeForStatus(status) {
  if (status === 401 || status === 403) return 'auth_invalid';
  if (status === 404) return 'target_not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  /* c8 ignore start -- defensive: 400/422 → data_error; 1xx/2xx/3xx →
     unavailable. emitFailure is only called for non-2xx in practice, and
     401/403/404/429/5xx are all hit by the typed-errors test suite. */
  if (status >= 400) return 'data_error';
  return 'unavailable';
  /* c8 ignore stop */
}

// ─────────────────────────────────────────────────────────────────────────────
// Styling — ANSI only when stdout is a TTY and NO_COLOR is unset.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether the current stdout is a colour-capable terminal.
 *
 * Honours `NO_COLOR` (https://no-color.org) and supports
 * `STRATOS_FORCE_TTY=1` for tests that exercise the table/colour paths
 * from a non-TTY subprocess.
 *
 * @returns {boolean} True if ANSI escapes should be emitted.
 */
/* c8 ignore start -- the `process.stdout.isTTY` arm is only reachable from
   an actual TTY parent; tests force the STRATOS_FORCE_TTY arm instead. */
const isTTY = () => process.env.STRATOS_FORCE_TTY === '1' || (process.stdout.isTTY && !process.env.NO_COLOR);
/* c8 ignore stop */

/**
 * Wrap a string in an ANSI SGR escape sequence when running on a TTY.
 *
 * @param {string} s    - Text to colourise.
 * @param {string} code - Numeric SGR code (e.g. `'31'` for red).
 * @returns {string} The (possibly wrapped) string.
 */
function paint(s, code) { return isTTY() ? `\x1b[${code}m${s}\x1b[0m` : s; }

/**
 * Pre-built ANSI styling helpers. Each accepts a string and returns it
 * wrapped in the appropriate SGR escape when `isTTY()` is true,
 * otherwise unchanged.
 *
 * @type {{
 *   dim:   (s:string)=>string, bold:  (s:string)=>string,
 *   red:   (s:string)=>string, green: (s:string)=>string,
 *   yellow:(s:string)=>string, blue:  (s:string)=>string,
 *   cyan:  (s:string)=>string,
 * }}
 */
const c = {
  dim:   (s) => paint(s, '2'),
  bold:  (s) => paint(s, '1'),
  red:   (s) => paint(s, '31'),
  green: (s) => paint(s, '32'),
  yellow:(s) => paint(s, '33'),
  blue:  (s) => paint(s, '34'),
  cyan:  (s) => paint(s, '36'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Output helpers — stdout for machine output, stderr for diagnostics.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a string to stdout, appending a trailing newline if missing.
 * Use this for machine output that the user may pipe to `jq` / `xargs`.
 *
 * @param {string} s - Text to emit.
 * @returns {void}
 */
function out(s)    { process.stdout.write(s.endsWith('\n') ? s : s + '\n'); }

/**
 * Write a string to stderr, appending a trailing newline if missing.
 * Use this for diagnostics that must not pollute piped stdout.
 *
 * @param {string} s - Text to emit.
 * @returns {void}
 */
/* c8 ignore start -- callers (info/warn/fatal) always pass strings without
   a trailing newline; the `s.endsWith('\n')` truthy arm is defensive only. */
function diag(s)   { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); }
/* c8 ignore stop */

/**
 * Emit an informational diagnostic to stderr, suppressed under `--quiet`.
 *
 * @param {string} m - Message body (no prefix; this function adds `info:`).
 * @returns {void}
 */
function info(m)   { if (!FLAGS_GLOBAL.quiet) diag(`${c.blue('info:')}    ${m}`); }

/**
 * Emit a warning diagnostic to stderr. Always shown, regardless of
 * `--quiet`, because warnings flag potentially unwanted behaviour.
 *
 * @param {string} m - Message body.
 * @returns {void}
 */
function warn(m)   { diag(`${c.yellow('warning:')} ${m}`); }

/**
 * Print a fatal error to stderr and exit the process with the given code.
 *
 * When running inside GitHub Actions (detected by {@link detectCI}'s
 * `host === 'github'`) the message is *also* emitted as a workflow
 * command (`::error::…`) so the failure surfaces inline on the PR/run
 * page and annotates the line that triggered it.
 *
 * @param {string} m              - Error message.
 * @param {number} [code=EX.SOFTWARE] - Sysexits-style exit code.
 * @param {string} [type]         - Stable type key from {@link ERROR_TYPES}.
 *                                  When supplied, an envelope `{ error: …}`
 *                                  is emitted to stderr as JSON if the
 *                                  caller asked for structured output
 *                                  (`--json`, `--output json|ndjson|yaml`).
 * @returns {never}
 */
function fatal(m, code = EX.SOFTWARE, type) {
  if (type && wantStructuredOutput()) {
    /* c8 ignore start -- the `|| ERROR_TYPES.software_error` fallback is
       defensive against an unknown `type` argument; every call site uses
       a key that exists in ERROR_TYPES today. */
    const env = ERROR_TYPES[type] || ERROR_TYPES.software_error;
    /* c8 ignore stop */
    diag(JSON.stringify({
      error: {
        type,
        message: m,
        retryable: env.retryable,
        exit_code: code,
      },
    }));
  } else if (type) {
    diag(`${c.red('error:')}   [${type}] ${m}`);
  } else {
    diag(`${c.red('error:')}   ${m}`);
  }
  if (FLAGS_GLOBAL.ciHost === 'github') {
    // Newlines inside the message confuse the workflow-command parser;
    // collapse them to space.
    const oneLine = m.replace(/\s+/g, ' ').trim();
    /* c8 ignore start -- the type-aware bracket-prefix arm of this
       template-string conditional fires only when both GITHUB_ACTIONS
       and a typed fatal coincide; the non-typed arm is covered. */
    diag(`::error title=stratos${type ? ` [${type}]` : ''} (exit ${code})::${oneLine}`);
    /* c8 ignore stop */
  }
  process.exit(code);
}

/**
 * Mutable global flag state observed by `info()` / `warn()` / `emit()`
 * / `fatal()`. Set once in `applyGlobalFlags()` near the top of
 * `main()` so we don't have to thread `--quiet` / `--verbose` /
 * `--json` through every function.
 *
 * `ciHost` is populated by {@link detectCI} and used by {@link fatal}
 * to emit host-specific failure annotations.
 *
 * @type {{ quiet: boolean, verbose: number, json: boolean, ciHost: string|null }}
 */
const FLAGS_GLOBAL = {
  quiet: false, verbose: 0, json: false, ciHost: null,
  output: null,   // 'json' | 'yaml' | 'csv' | 'table' | null (auto)
  filter: null,   // jq expression
  rate:   null,   // tokens/sec for the rate limiter (number or null)
  otlp:   null,   // OTLP/HTTP traces endpoint URL or null
  otlpHeaders: null, // { k: v } from --otlp-headers
};

/**
 * Detect whether the current process is running inside a CI environment
 * and, if so, which provider. Used by {@link applyGlobalFlags} to
 * auto-enable machine-friendly defaults (`--json --quiet`) and by
 * {@link fatal} to emit provider-specific failure annotations.
 *
 * Honours `STRATOS_CI=0` as an explicit override (e.g. when running
 * Stratos *from* a CI agent's `bash -i` shell where the auto-defaults
 * would be wrong).
 *
 * @returns {{ ci: boolean, host: 'github'|'gitlab'|'circleci'|'jenkins'|'azure'|'generic'|null }}
 */
function detectCI() {
  if (process.env.STRATOS_CI === '0') return { ci: false, host: null };
  if (process.env.STRATOS_CI === '1') return { ci: true, host: 'generic' };
  if (process.env.GITHUB_ACTIONS === 'true') return { ci: true, host: 'github' };
  if (process.env.GITLAB_CI === 'true')      return { ci: true, host: 'gitlab' };
  if (process.env.CIRCLECI === 'true')       return { ci: true, host: 'circleci' };
  if (process.env.JENKINS_URL)               return { ci: true, host: 'jenkins' };
  if (process.env.TF_BUILD === 'True')       return { ci: true, host: 'azure' };
  if (process.env.CI === 'true' || process.env.CI === '1')
    return { ci: true, host: 'generic' };
  return { ci: false, host: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing.
//
// Supports:
//   --flag                → true
//   --flag=value          → 'value'
//   --flag value          → 'value'
//   --flag a --flag b     → ['a', 'b'] (repeats accumulate)
//   -x                    → true (single-char shortcuts: -h, -v, -q)
//   --                    → end of flags; remainder is positional
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Single-character short-flag aliases. Boolean entries map the character
 * to its full long-name (`-h` → `help`). Object entries indicate the flag
 * consumes the next positional value (`-n 5` → `flags.n === '5'`).
 *
 * @type {Object<string, string | { name: string, value: true }>}
 */
const SHORTCUTS = {
  h: 'help',
  v: 'version',
  q: 'quiet',
  n: { name: 'n', value: true },        // count, e.g. `bench -n 5`
  f: { name: 'f', value: true },        // file path, e.g. `rules set -f ./_headers`
};

/**
 * Parse an `argv`-shaped string array into `{ positional, flags }`.
 *
 * Supported forms:
 * - `--flag`              → `true`
 * - `--flag=value`        → `'value'`
 * - `--flag value`        → `'value'`
 * - `--flag a --flag b`   → `['a', 'b']` (repeats accumulate into arrays)
 * - `-x` / `-x value`     → looked up in {@link SHORTCUTS}
 * - `--`                  → end of flags; remainder is positional
 *
 * @param {string[]} args - Arguments to parse (typically `process.argv.slice(2)`).
 * @returns {{ positional: string[], flags: Object<string, string|boolean|string[]> }}
 */
export function parseFlags(args) {
  const positional = [];
  const flags = {};
  const set = (k, v) => {
    if (k in flags) {
      flags[k] = Array.isArray(flags[k]) ? [...flags[k], v] : [flags[k], v];
    } else {
      flags[k] = v;
    }
  };
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (endOfFlags) { positional.push(a); continue; }
    if (a === '--') { endOfFlags = true; continue; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { set(a.slice(2, eq), a.slice(eq + 1)); continue; }
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        set(key, true);
      } else {
        set(key, next); i++;
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const sc = SHORTCUTS[a[1]];
      if (!sc) { positional.push(a); continue; }
      if (typeof sc === 'string') { set(sc, true); continue; }
      // Value-taking short flag.
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        set(sc.name, true);
      } else {
        set(sc.name, next); i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

/**
 * Coerce a flag value (which may be undefined, a scalar, or an array
 * from repeated flag use) into a flat array.
 *
 * @param {undefined|string|boolean|Array<string|boolean>} v - Flag value.
 * @returns {Array<string|boolean>} Always an array; empty if `v` is undefined.
 */
/* c8 ignore start -- `v === undefined` arm is dead: every CLI path that
   calls flagList passes a defined --tag value (or doesn't call at all). */
function flagList(v) { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }
/* c8 ignore stop */

// ─────────────────────────────────────────────────────────────────────────────
// Config & profiles.
//
// Sources (highest → lowest):
//   1. Per-command --key=… flags
//   2. Process env vars (CLOUDCDN_URL, CLOUDCDN_ACCOUNT_KEY, …)
//   3. ~/.config/stratos/config.json  → profiles.<name>
//   4. Defaults
//
// Profile is chosen via --profile <name>, $STRATOS_PROFILE, or 'default'.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * XDG-compliant config root. Defaults to `~/.config` when
 * `XDG_CONFIG_HOME` is not set.
 *
 * @type {string}
 */
const XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config');

/**
 * Stratos's per-user config directory.
 * @type {string}
 */
const CONFIG_DIR = join(XDG_CONFIG_HOME, 'stratos');

/**
 * Absolute path to the JSON config file containing named profiles.
 * Created with mode 0600 by {@link saveFileConfig}.
 *
 * @type {string}
 */
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * Read and parse the profile config file.
 *
 * - Returns `{ profiles: {} }` when the file does not exist (`ENOENT`).
 * - Throws a descriptive `Error` for any other read or parse failure.
 *
 * @returns {Promise<{ profiles: Object<string, Object> }>}
 */
async function loadFileConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return { profiles: {} };
    throw new Error(`config: ${CONFIG_FILE} unreadable: ${e.message}`);
  }
}

/**
 * Persist the profile config file atomically with mode 0600. Creates
 * `CONFIG_DIR` recursively if needed.
 *
 * @param {{ profiles: Object<string, Object> }} cfg - Config to write.
 * @returns {Promise<void>}
 */
async function saveFileConfig(cfg) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Per-process cache of resolved keychain lookups. Avoids re-spawning
 * `security` / `secret-tool` for every authenticated request.
 *
 * @type {Map<string, string>}
 */
const _kcCache = new Map();

/**
 * Resolve the effective configuration for the current command.
 *
 * Sources, in descending priority:
 * 1. Per-command CLI flags (`--cdn-url`, `--account-key`, …)
 * 2. Environment variables (`CLOUDCDN_URL`, `CLOUDCDN_ACCOUNT_KEY`, …)
 * 3. Profile entries from `~/.config/stratos/config.json`
 * 4. OS keychain (best-effort; suppressed by `STRATOS_NO_KEYCHAIN=1`)
 * 5. Sensible defaults
 *
 * @param {Object<string, any>} [flags] - Parsed CLI flags from {@link parseFlags}.
 * @returns {Promise<{
 *   PROFILE: string, BASE: string,
 *   ACCOUNT_KEY: string, ACCESS_KEY: string, SIGNED_URL_SECRET: string,
 *   TIMEOUT_MS: number, MAX_RETRIES: number,
 * }>}
 */
async function envConfig(flags = {}) {
  const profileName =
    flags.profile || process.env.STRATOS_PROFILE || 'default';
  const fileCfg = await loadFileConfig();
  const profile = (fileCfg.profiles && fileCfg.profiles[profileName]) || {};

  // Resolve each key from flag → env → profile → keychain.
  // Keychain is checked last because it costs a child process; skip if
  // STRATOS_NO_KEYCHAIN=1 (handy for CI smoke tests).
  const useKc = process.env.STRATOS_NO_KEYCHAIN !== '1';
  /* c8 ignore start -- useKc=true requires a working OS keychain in the test
     environment; CI runs with STRATOS_NO_KEYCHAIN=1 so the false arm wins. */
  const fromKc = async (account) => useKc ? await keychainGet(account) : '';
  /* c8 ignore stop */

  const ACCOUNT_KEY =
    flags['account-key'] || process.env.CLOUDCDN_ACCOUNT_KEY ||
    profile.account_key || await fromKc('account_key');
  const ACCESS_KEY =
    flags['access-key'] || process.env.CLOUDCDN_ACCESS_KEY ||
    profile.access_key || await fromKc('access_key');
  const SIGNED_URL_SECRET =
    flags.secret || process.env.SIGNED_URL_SECRET ||
    profile.signed_url_secret || await fromKc('signed_url_secret');

  return {
    PROFILE: profileName,
    BASE:
      flags['cdn-url'] || process.env.CLOUDCDN_URL || profile.url || 'https://cloudcdn.pro',
    ACCOUNT_KEY: ACCOUNT_KEY || '',
    ACCESS_KEY: ACCESS_KEY || '',
    SIGNED_URL_SECRET: SIGNED_URL_SECRET || '',
    TIMEOUT_MS:
      Number(flags.timeout || process.env.CLOUDCDN_TIMEOUT || profile.timeout_ms || 15000),
    MAX_RETRIES:
      Number(flags.retries || process.env.CLOUDCDN_RETRIES || profile.max_retries || 3),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// OS keychain — shell out to the platform's native secret store.
//
//   macOS:    `security` (built-in)
//   Linux:    `secret-tool` (libsecret; usually pre-installed under GNOME)
//   Windows:  `cmdkey` (built-in; stores GENERIC creds)
//
// Each key is stored under service="stratos" account=<keyname>. Lookups
// silently return '' when the keychain or the entry is unavailable, so
// callers can treat keychain as a "best-effort fallback" — never the only
// source of truth.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Service name under which secrets are stored in the OS keychain. Used
 * consistently across macOS Keychain, libsecret, and Windows Credential
 * Manager so the same key entries are discoverable from each platform.
 *
 * @type {string}
 */
const KC_SERVICE = 'stratos';

/* c8 ignore start -- shells out to OS-specific binaries; not deterministically
   reachable from a portable test suite. Behaviour is exercised manually
   on each platform. */

/**
 * Spawn a child process, collect its stdout/stderr, and resolve to a
 * `{ code, stdout, stderr }` record. Never rejects; child-spawn errors
 * resolve with `code = -1`.
 *
 * @param {string}   cmd     - Executable name or path.
 * @param {string[]} args    - Argument vector.
 * @param {string}   [input] - Optional stdin payload.
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function execCapture(cmd, args, input) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('error', () => resolve({ code: -1, stdout, stderr }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

/**
 * Read a secret from the OS keychain.
 *
 * Best-effort: missing entries, missing keychain binaries, and locked
 * keychains all resolve to the empty string rather than throwing, so
 * callers can treat keychain as a last-resort fallback.
 *
 * @param {string} account - Key name (e.g. `'account_key'`).
 * @returns {Promise<string>} The stored value or `''` if unavailable.
 */
async function keychainGet(account) {
  if (_kcCache.has(account)) return _kcCache.get(account);
  let value = '';
  try {
    switch (platform()) {
      case 'darwin': {
        const r = await execCapture('security',
          ['find-generic-password', '-a', account, '-s', KC_SERVICE, '-w']);
        if (r.code === 0) value = r.stdout.trim();
        break;
      }
      case 'linux': {
        const r = await execCapture('secret-tool',
          ['lookup', 'service', KC_SERVICE, 'account', account]);
        if (r.code === 0) value = r.stdout.trim();
        break;
      }
      case 'win32': {
        const r = await execCapture('cmdkey', ['/list:' + KC_SERVICE + '_' + account]);
        if (r.code === 0 && /User:/.test(r.stdout)) { /* secret-extraction gap */ }
        break;
      }
    }
  } catch { /* keychain unavailable — treat as empty */ }
  _kcCache.set(account, value);
  return value;
}

/**
 * Store (or update) a secret in the OS keychain.
 *
 * @param {string} account - Key name (e.g. `'account_key'`).
 * @param {string} value   - Secret material.
 * @throws {Error} If the keychain binary returns non-zero or the platform
 *                 is unsupported.
 * @returns {Promise<void>}
 */
async function keychainSet(account, value) {
  switch (platform()) {
    case 'darwin': {
      const r = await execCapture('security',
        ['add-generic-password', '-U', '-a', account, '-s', KC_SERVICE, '-w', value]);
      if (r.code !== 0) throw new Error(`security: ${r.stderr.trim()}`);
      return;
    }
    case 'linux': {
      const r = await execCapture('secret-tool',
        ['store', '--label=Stratos ' + account, 'service', KC_SERVICE, 'account', account],
        value);
      if (r.code !== 0) throw new Error(`secret-tool: ${r.stderr.trim()}`);
      return;
    }
    case 'win32': {
      const r = await execCapture('cmdkey',
        ['/generic:' + KC_SERVICE + '_' + account, '/user:stratos', '/pass:' + value]);
      if (r.code !== 0) throw new Error(`cmdkey: ${r.stderr.trim()}`);
      return;
    }
    default:
      throw new Error(`keychain not supported on platform: ${platform()}`);
  }
}

/**
 * Remove a secret from the OS keychain. Missing entries are not an error.
 *
 * @param {string} account - Key name (e.g. `'account_key'`).
 * @returns {Promise<void>}
 */
async function keychainDel(account) {
  switch (platform()) {
    case 'darwin':
      await execCapture('security',
        ['delete-generic-password', '-a', account, '-s', KC_SERVICE]);
      return;
    case 'linux':
      await execCapture('secret-tool',
        ['clear', 'service', KC_SERVICE, 'account', account]);
      return;
    case 'win32':
      await execCapture('cmdkey', ['/delete:' + KC_SERVICE + '_' + account]);
      return;
    default:
      throw new Error(`keychain not supported on platform: ${platform()}`);
  }
}
/* c8 ignore stop */

// ─────────────────────────────────────────────────────────────────────────────
// HTTP layer — fetch with timeout, retry with full-jitter exponential backoff,
// auth-header policy (least privilege), structured errors.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Perform an HTTP request to the CloudCDN API and parse a JSON response.
 *
 * Adds least-privilege auth headers (`AccessKey` for `'read'` role,
 * `AccountKey + x-api-key` for `'control'`), applies a per-request abort
 * timeout, and retries 429/5xx/network failures with full-jitter
 * exponential backoff. Never throws on HTTP status — returns
 * `{ ok, status, body, headers }` so callers can decide how to react.
 *
 * @param {string} path - Path-only URL (joined onto `cfg.BASE`), e.g. `'/api/health'`.
 * @param {RequestInit & { flags?: Object }} [init] - Standard `fetch` init,
 *        plus `flags` so per-request CLI overrides reach `envConfig`.
 * @param {{ role?: 'read'|'control', noRetry?: boolean }} [opts] - Behavioural
 *        knobs. `role` selects the auth header policy; `noRetry` disables retries.
 * @returns {Promise<{ ok: boolean, status: number, body: any, headers: Headers }>}
 * @throws {Error} `{ exitCode: EX.CONFIG }` when role requires a key that is
 *                 not configured, or `{ exitCode: EX.TEMPFAIL }` when retries
 *                 are exhausted.
 */
async function jsonReq(path, init = {}, opts = {}) {
  const cfg = await envConfig(init.flags || {});
  const base = cfg.BASE.replace(/\/$/, '');
  const url = base + path;
  const headers = { Accept: 'application/json', 'User-Agent': `stratos/${VERSION}`, ...(init.headers || {}) };

  // Auth-header policy: control-plane = AccountKey + x-api-key;
  // read-only = AccessKey if present, otherwise AccountKey.
  const role = opts.role || 'read';
  if (role === 'control') {
    if (!cfg.ACCOUNT_KEY) throw httpErr('CLOUDCDN_ACCOUNT_KEY is required for this command.', EX.CONFIG, 'auth_missing_key');
    headers.AccountKey = cfg.ACCOUNT_KEY;
    headers['x-api-key'] = cfg.ACCOUNT_KEY;
  } else {
    if (cfg.ACCESS_KEY) headers.AccessKey = cfg.ACCESS_KEY;
    else if (cfg.ACCOUNT_KEY) headers.AccountKey = cfg.ACCOUNT_KEY;
  }

  /* c8 ignore start -- `opts.noRetry` is reserved for future callers; no
     production path passes it today, so only the false arm is taken. */
  const maxAttempts = (opts.noRetry ? 1 : cfg.MAX_RETRIES) + 1;
  /* c8 ignore stop */
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.TIMEOUT_MS);
    try {
      if (FLAGS_GLOBAL.verbose) info(`${init.method || 'GET'} ${url} (attempt ${attempt}/${maxAttempts})`);
      const res = await fetch(url, { ...init, headers, signal: controller.signal });
      clearTimeout(timer);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      // Retry on 5xx and 429.
      if ((res.status >= 500 || res.status === 429) && attempt < maxAttempts) {
        const backoff = Math.floor(Math.random() * (250 * 2 ** (attempt - 1)));
        warn(`HTTP ${res.status}; retrying in ${backoff}ms`);
        await delay(backoff);
        continue;
      }
      return { ok: res.ok, status: res.status, body, headers: res.headers };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < maxAttempts) {
        const backoff = Math.floor(Math.random() * (250 * 2 ** (attempt - 1)));
        warn(`network: ${e.message}; retrying in ${backoff}ms`);
        await delay(backoff);
        continue;
      }
    }
  }
  /* c8 ignore start -- `lastErr ? lastErr.message : 'unknown'` falsy arm
     requires `lastErr` to be unset, which only happens if all attempts
     resolve to a Response (in which case the loop returns instead). */
  throw httpErr(`request failed after ${maxAttempts} attempts: ${lastErr ? lastErr.message : 'unknown'}`, EX.TEMPFAIL, 'request_failed');
  /* c8 ignore stop */
}

/**
 * Build an `Error` carrying a sysexits-style exit code so callers can
 * `throw` it and have the top-level catch translate it into a clean
 * `process.exit`.
 *
 * @param {string} msg  - Human-readable error message.
 * @param {number} code - One of {@link EX}.
 * @param {string} [type] - Stable type key from {@link ERROR_TYPES}.
 *                          Attached as `error.type` so the top-level
 *                          catch can forward it to {@link fatal}.
 * @returns {Error & { exitCode: number, type?: string }}
 */
function httpErr(msg, code, type) {
  const e = new Error(msg);
  e.exitCode = code;
  if (type) e.type = type;
  return e;
}

/**
 * Emit a JSON body to stdout, pretty-printed on TTY and compact on a pipe.
 * Honours `FLAGS_GLOBAL.json` for forced JSON output regardless of TTY.
 *
 * @param {any}    body         - Anything `JSON.stringify` will accept.
 * @param {number} [status=200] - Reserved for future use (status-aware
 *                                framing); currently unused.
 * @returns {void}
 */
function emit(body, status = 200) {
  const piped = applyFilter(body);
  const fmt = pickOutputFormat();
  if (fmt === 'json') {
    out(JSON.stringify(piped, null, isTTY() ? 2 : 0));
  } else if (fmt === 'ndjson') {
    // One record per line. Non-arrays emit as a single line so a pipeline
    // can treat any command's output uniformly (`stratos … | while read l`).
    if (Array.isArray(piped)) {
      for (const row of piped) out(JSON.stringify(row));
    } else {
      out(JSON.stringify(piped));
    }
  } else if (fmt === 'yaml') {
    out(toYaml(piped));
  } else if (fmt === 'csv') {
    out(toCsv(Array.isArray(piped) ? piped : [piped]));
  } else {
    // Table-style emit for non-list bodies falls back to pretty JSON.
    out(JSON.stringify(piped, null, 2));
  }
}

/**
 * Print a non-2xx response body to **stderr** so the user can still read
 * the diagnostic but `… | jq …` pipelines stay clean. When the user
 * asked for structured output (`--json` / `--output json|ndjson|yaml`),
 * the body is wrapped in a typed error envelope:
 *
 *   {"error": {"type": "rate_limited", "message": "...",
 *              "retryable": true, "exit_code": 75, "http_status": 429,
 *              "body": <original body>}}
 *
 * Agent callers parse the envelope; humans see the raw body.
 *
 * @param {string|any} body   - Raw body from the failing request.
 * @param {number}     status - HTTP status code.
 * @returns {void}
 */
function emitFailure(body, status) {
  if (wantStructuredOutput()) {
    const type = typeForStatus(status);
    const env = ERROR_TYPES[type];
    const message = typeof body === 'string'
      ? body.slice(0, 200)
      : (body && (body.message || body.error || body.Message)) || `HTTP ${status}`;
    diag(JSON.stringify({
      error: {
        type,
        message: String(message),
        retryable: env.retryable,
        exit_code: env.exit,
        http_status: status,
        body,
      },
    }));
    return;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  diag(text);
}

/**
 * Map an HTTP status code to a sysexits-style exit code.
 *
 * - `401` / `403` → `EX.NOPERM`
 * - `429` → `EX.TEMPFAIL`
 * - `5xx` → `EX.TEMPFAIL`
 * - anything else (≥400) → `EX.UNAVAILABLE`
 *
 * @param {number} status - HTTP status code.
 * @returns {number} A `EX.*` value.
 */
function exitForStatus(status) {
  if (status === 401 || status === 403) return EX.NOPERM;
  if (status === 429) return EX.TEMPFAIL;
  if (status >= 500) return EX.TEMPFAIL;
  return EX.UNAVAILABLE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table renderer — minimal, dependency-free.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render an aligned table to stdout. Used by list-shaped commands when
 * stdout is a TTY and `--json` is not set.
 *
 * @param {Array<Object>} rows    - Row objects.
 * @param {Array<{ header: string, key?: string, get?: (row: Object) => any }>}
 *        columns                  - Column descriptors: each row's cell is
 *        `row[key]` unless a `get` callback is supplied.
 * @returns {void}
 */
function renderTable(rows, columns) {
  if (!rows || rows.length === 0) {
    diag(c.dim('(no rows)'));
    return;
  }
  const headers = columns.map((col) => col.header);
  const data = rows.map((r) => columns.map((col) => {
    const v = typeof col.get === 'function' ? col.get(r) : r[col.key];
    return v === undefined || v === null ? '' : String(v);
  }));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length))
  );
  const fmt = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  out(c.bold(fmt(headers)));
  out(c.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const row of data) out(fmt(row));
}

/**
 * Emit a list of records, choosing between {@link renderTable} (TTY) and
 * JSON (pipe or `--json`).
 *
 * @param {Array<Object>} rows    - Row objects to emit.
 * @param {Array<{ header: string, key?: string, get?: (row: Object) => any }>}
 *        columns                  - Column descriptors used only by the
 *        table renderer; ignored when emitting JSON.
 * @returns {void}
 */
function emitList(rows, columns) {
  const piped = applyFilter(rows);
  const fmt = pickOutputFormat();
  if (fmt === 'json') {
    out(JSON.stringify(piped, null, isTTY() ? 2 : 0));
  } else if (fmt === 'ndjson') {
    // NDJSON's contract is one record per line. For list commands this
    // is the canonical agent-friendly stream — pipe into jq -c, DuckDB
    // read_ndjson, or an LLM context window without buffering an array.
    /* c8 ignore start -- non-array arm only reachable via a jq filter
       that scalarises the list; not exposed via the CLI. */
    const items = Array.isArray(piped) ? piped : [piped];
    /* c8 ignore stop */
    for (const row of items) out(JSON.stringify(row));
  } else if (fmt === 'yaml') {
    out(toYaml(piped));
  } else if (fmt === 'csv') {
    /* c8 ignore start -- emitList's `piped` is always the array returned by
       applyFilter(rows); the non-array arm is reachable only via a jq
       filter that scalarises the list, which the CLI doesn't expose. */
    out(toCsv(Array.isArray(piped) ? piped : [piped]));
    /* c8 ignore stop */
  } else {
    /* c8 ignore start -- same as the CSV arm above. */
    renderTable(Array.isArray(piped) ? piped : [piped], columns);
    /* c8 ignore stop */
  }
}

/**
 * Resolve the effective output format from `--output`, `--json`, and TTY
 * state. The user's explicit `--output` always wins; legacy `--json`
 * stays a shortcut for `--output json`; absent both, list-shaped output
 * defaults to a table on TTY and JSON on a pipe.
 *
 * @returns {'json'|'ndjson'|'yaml'|'csv'|'table'}
 */
function pickOutputFormat() {
  const o = FLAGS_GLOBAL.output;
  if (o === 'json' || o === 'ndjson' || o === 'yaml' || o === 'csv' || o === 'table') return o;
  if (FLAGS_GLOBAL.json) return 'json';
  if (!isTTY()) return 'json';
  return 'table';
}

/**
 * Whether the user has asked for structured (machine-readable) output —
 * `--json`, or any `--output` other than the default `table`. Used by
 * commands that have a rich text rendering (`explain`, `doctor`,
 * `bench`, `init`) to decide between their text mode and a generic
 * `emit()` call.
 *
 * @returns {boolean}
 */
function wantStructuredOutput() {
  if (FLAGS_GLOBAL.json) return true;
  const o = FLAGS_GLOBAL.output;
  return o === 'json' || o === 'ndjson' || o === 'yaml' || o === 'csv';
}

/**
 * Optional output filter. When `--filter <jq-expr>` is set, every body
 * passed through `emit` / `emitList` is piped through `jq` and the
 * parsed result substituted before serialisation. If `jq` isn't on
 * `PATH`, exits with `EX_CONFIG` (the user asked for filtering but the
 * tool is missing). If the expression is malformed, exits with
 * `EX_DATAERR`.
 *
 * @param {any} body - Whatever the command was about to emit.
 * @returns {any} The body, optionally filtered.
 */
function applyFilter(body) {
  const expr = FLAGS_GLOBAL.filter;
  if (!expr) return body;
  const { spawnSync } = jqShim;
  // jq runs with -c so every output line is a complete compact JSON
  // value. Without -c, jq pretty-prints objects across multiple
  // lines and applyFilter's line-by-line parser would fail on the
  // first opening brace. With -c, single scalars, object
  // projections, and stream-style outputs all emit one document per
  // line uniformly.
  const r = spawnSync('jq', ['-c', expr], { input: JSON.stringify(body), encoding: 'utf8' });
  /* c8 ignore next 3 -- depends on jq being absent; covered by manual QA */
  if (r.error && r.error.code === 'ENOENT') {
    fatal('--filter requires `jq` on PATH (https://stedolan.github.io/jq/).', EX.CONFIG);
  }
  if (r.status !== 0) {
    fatal(`jq exited ${r.status}: ${r.stderr.trim()}`, EX.DATAERR);
  }
  try {
    // jq emits one JSON value per output. For multi-output streams
    // (e.g. `.foo[]`) we return an array of values.
    const out = r.stdout.trim();
    /* c8 ignore start -- jq's JSON-only default emits at least "null" for
       empty results, so `out` being empty after trim is unreachable from
       the CLI surface (which doesn't expose `-r`). */
    if (!out) return null;
    /* c8 ignore stop */
    const lines = out.split('\n').filter(Boolean);
    if (lines.length === 1) return JSON.parse(lines[0]);
    return lines.map((l) => JSON.parse(l));
  /* c8 ignore start -- jq's JSON-only default emit means this branch is
     only reached via `-r` / `@text` constructs we don't expose. */
  } catch (e) {
    fatal(`jq produced non-JSON output: ${e.message}`, EX.DATAERR);
  }
  /* c8 ignore stop */
}

/**
 * Indirection point for `applyFilter`'s `spawnSync` dependency. Lifted
 * out so the test suite can override the shim (e.g. to simulate jq
 * being missing) without monkey-patching `node:child_process`.
 *
 * @type {{ spawnSync: typeof import('node:child_process').spawnSync }}
 */
const jqShim = { spawnSync };

/**
 * Serialise a JavaScript value as YAML. Handles the shapes Stratos
 * actually emits — strings, numbers, booleans, null, plain objects,
 * arrays — and is deliberately *not* a general-purpose YAML library.
 * Strings are double-quoted when they contain anything that could be
 * mistaken for YAML markup; otherwise they're emitted bare for
 * readability.
 *
 * @param {any}    value           - Value to serialise.
 * @param {number} [indent=0]      - Current indent depth (spaces).
 * @returns {string} YAML text without a trailing newline.
 */
function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return yamlScalarString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((v) => {
      const rendered = toYaml(v, indent + 2);
      const isBlock = typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length > 0;
      return isBlock
        ? `${pad}-\n${rendered.split('\n').map((l) => '  ' + l).join('\n')}`
        : `${pad}- ${rendered}`;
    }).join('\n');
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return keys.map((k) => {
      const v = value[k];
      if (v === null || typeof v !== 'object' || Array.isArray(v) && v.length === 0) {
        return `${pad}${k}: ${toYaml(v, indent + 2)}`;
      }
      const rendered = toYaml(v, indent + 2);
      return `${pad}${k}:\n${rendered}`;
    }).join('\n');
  }
  /* c8 ignore start -- non-JSON-shaped value (Symbol, BigInt, Function);
     unreachable from any JSON body Stratos actually emits. */
  return String(value);
  /* c8 ignore stop */
}

/**
 * Quote a string for safe YAML emission. Bare strings are returned
 * unchanged when they would round-trip cleanly; everything else gets
 * double-quoted with JSON-style escapes.
 *
 * @param {string} s - String to render.
 * @returns {string} YAML scalar.
 */
function yamlScalarString(s) {
  // YAML 1.2 reserved bare-scalar tokens that look like other types.
  const reserved = /^(null|true|false|~|yes|no|on|off)$/i;
  const tricky = /[:#\-?,&*!|>'"%@`{}\[\]\n]/;
  if (s === '' || reserved.test(s) || tricky.test(s) || /^\s|\s$/.test(s) || /^-?\d+(\.\d+)?$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

/**
 * Serialise an array of plain objects as CSV. The header row is the
 * union of keys (insertion order from the first row, then any new keys
 * from later rows). Values are stringified; commas, quotes, and
 * newlines are escaped per RFC 4180.
 *
 * @param {Array<Object>} rows - Records to emit.
 * @returns {string} CSV text without a trailing newline.
 */
function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const headers = [];
  for (const r of rows) {
    if (r && typeof r === 'object') {
      for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k);
    }
  }
  if (headers.length === 0) return rows.map((r) => csvCell(r)).join('\n');
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) {
    lines.push(headers.map((h) => csvCell(r ? r[h] : '')).join(','));
  }
  return lines.join('\n');
}

/**
 * Escape a single CSV cell per RFC 4180: wrap in double-quotes when the
 * value contains a comma, quote, or newline; double any embedded
 * quotes.
 *
 * @param {any} v - Cell value.
 * @returns {string} Escaped cell.
 */
function csvCell(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') v = JSON.stringify(v);
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stdin helpers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the entirety of stdin and return it as an array of trimmed,
 * non-empty lines. Returns an empty array when stdin is a TTY.
 *
 * @returns {Promise<string[]>}
 */
async function readStdinLines() {
  /* c8 ignore start -- `stdin.isTTY` is true only when the user runs
     interactively; spawned-child tests always pipe stdin. */
  if (process.stdin.isTTY) return [];
  /* c8 ignore stop */
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands — version, help, completion, upgrade, config.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `stratos version` — print the CLI version and exit zero.
 * @returns {void}
 */
function cmdVersion() {
  out(`stratos v${VERSION}`);
}

/**
 * The full root help text printed by `stratos help` and on bare invocation.
 * Pre-formatted with ANSI styling helpers (no-ops on non-TTY stdout).
 *
 * @type {string}
 */
const HELP_ROOT = `${c.bold('stratos')} v${VERSION} — CloudCDN CLI

${c.bold('Usage:')} stratos <command> [<subcommand>] [options]

${c.bold('Core')}
  version                     Print version and exit.
  help [<command>]            Print help for a command.
  completion <shell>          Emit completion script (bash|zsh|fish|powershell).
  upgrade                     Re-install the latest pinned release.
  init                        Interactive first-run setup wizard.
  config get|set|list|edit    Manage ~/.config/stratos/config.json profiles.
  login                       Store keys in the OS keychain.
  login status                Show resolved config (keys masked).
  logout                      Remove keys from the OS keychain.
  doctor                      Diagnose environment, credentials, reachability.
  bench [-n N]                Measure cold-start + N request latencies.
  explain <code|status>       Look up cause + fix for an exit code / HTTP status.
  mcp serve                   Run as a Model Context Protocol stdio server.

${c.bold('Edge ops')}
  health [--deep]             Hit /api/health.
  purge <url>...              Invalidate URLs, tags, or everything.
       --tag <t>...                                   (repeats allowed)
       --everything
       --dry-run
       -                      Read URLs from stdin (one per line).
  signed <path>               Mint an offline HMAC-signed URL.
       --expires <unix-sec>
       --secret <key>

${c.bold('Catalog & insights')}
  assets [... --all]          List the asset catalog (--all walks pages).
  assets show <path>          Show one asset's metadata.
  insights summary            Aggregate requests, bandwidth, cache ratio.
  insights top                Top requested assets.
  insights asset <path>       Per-asset traffic.
  insights errors             4xx/5xx breakdown.
  insights geo                Country-level distribution.
  stats                       /api/core/statistics.
  analytics query             /api/analytics filter.
  audit                       /api/core/audit-logs.

${c.bold('Zones & rules')}
  zones list|create|show|rm
  zones domains add <id> <host>
  rules get <_headers|_redirects>
  rules set <_headers|_redirects> -f <file>
  rules diff <_headers|_redirects> -f <file>

${c.bold('Tokens & webhooks')}
  tokens list|create|rm
  webhooks list|add|rm

${c.bold('Storage')}
  storage put|get|rm|ls       Single-file CRUD.
  storage sync <dir> <prefix> Recursive upload via batch endpoint.

${c.bold('AI & media')}
  ai alt|moderate|crop|bg-remove <url>
  image transform|blurhash|lqip|auto
  stream <video>              HLS playlist or segment.

${c.bold('Pipeline & discovery')}
  pipeline submit             Submit an SVG for asset scaffolding.
  search <query>              Hybrid asset search.
  ask <message>               CloudCDN AI concierge.
  logs tail [--level L]       SSE-stream live logs.
  logs query [--days N]       Historical log query.

${c.bold('Global options')}
  --output <fmt>              json | ndjson | yaml | csv | table  (default: auto).
                              Alias: jsonl == ndjson.
  --json                      Shortcut for --output json.
  --filter <jq-expr>          Pipe output through jq (jq must be on PATH).
  --quiet | -q                Suppress info logs.
  --verbose                   Trace HTTP requests.
  --profile <name>            Select config profile.
  --cdn-url <url>             Override CLOUDCDN_URL (the API base).
  --account-key <key>         Override CLOUDCDN_ACCOUNT_KEY.
  --access-key <key>          Override CLOUDCDN_ACCESS_KEY.
  --timeout <ms>              Per-request timeout (default 15000).
  --retries <n>               Max retries (default 3).
  --rate <n>[/s]              Client-side rate limit for bulk operations.
  --otlp-endpoint <url>       OTLP/HTTP traces endpoint (one span per command).
  --otlp-headers k=v,k=v      Auth/extra headers for the OTLP exporter.

${c.bold('Environment')}
  CLOUDCDN_URL                Default https://cloudcdn.pro.
  CLOUDCDN_ACCOUNT_KEY        Control-plane auth.
  CLOUDCDN_ACCESS_KEY         Read-only auth.
  SIGNED_URL_SECRET           HMAC secret for 'signed'.
  STRATOS_PROFILE             Default profile name.
  NO_COLOR                    Disable ANSI styling.

${c.bold('Exit codes')}
  0 ok · 64 usage · 69 unavailable · 75 tempfail (5xx/network) · 77 noperm · 78 config

Docs: https://github.com/sebastienrousseau/stratos
`;

/**
 * Per-command help text shown by `stratos help <topic>` and
 * `stratos <cmd> --help`. Missing topics fall through to a usage error.
 *
 * @type {Object<string, string>}
 */
const HELP_BY_COMMAND = {
  version: 'stratos version\n  Print the CLI version and exit 0.\n',
  health:  'stratos health [--deep]\n  GET /api/health (add ?deep=1 with --deep).\n  Exit: 0 ok, 75 5xx, 69 4xx.\n',
  purge:
    'stratos purge <url>... [--dry-run]\n' +
    'stratos purge --tag <tag> [--tag <tag> ...] [--dry-run]\n' +
    'stratos purge --everything [--dry-run]\n' +
    'stratos purge -   (read URLs from stdin, one per line)\n\n' +
    'Requires CLOUDCDN_ACCOUNT_KEY.\n',
  signed:
    'stratos signed <path> --expires <unix-seconds> [--secret <key>]\n\n' +
    'Mint an HMAC-SHA256 URL offline.  Uses SIGNED_URL_SECRET or --secret.\n',
  assets:
    'stratos assets [--project=<name>] [--format=<ext>] [--page=<n>] [--all]\n' +
    '  --all      Walk every page (safety cap: 1000 pages).\n' +
    'stratos assets show <path>\n',
  login:
    'stratos login                  Interactive: prompts for each key.\n' +
    'stratos login --account-key K  Non-interactive (for scripts).\n' +
    'stratos login status           Show resolved config (keys masked).\n' +
    'stratos logout                 Clear all stratos secrets from the keychain.\n\n' +
    'Stratos prefers env vars → profile → keychain. Set $STRATOS_NO_KEYCHAIN=1 to opt out.\n',
  doctor:
    'stratos doctor\n' +
    '  Run environment & reachability checks. Exit 0 if all green,\n' +
    '  69 (UNAVAILABLE) if any check fails.\n',
  bench:
    'stratos bench [-n N]\n' +
    '  Spawn-once cold-start + N (default 5) /api/health latency samples.\n' +
    '  Outputs min/p50/p95/max. Pair with --json for ingestion.\n',
  insights:
    'stratos insights summary|top|asset|errors|geo [--days N] [--zone Z] [--limit N]\n',
  zones:
    'stratos zones list\n' +
    'stratos zones create <name>\n' +
    'stratos zones show <id>\n' +
    'stratos zones rm <id>\n' +
    'stratos zones domains add <id> <hostname>\n',
  storage:
    'stratos storage put <local> <remote>\n' +
    'stratos storage get <remote> [<local>]\n' +
    'stratos storage rm <remote>\n' +
    'stratos storage ls <prefix>\n' +
    'stratos storage sync <local-dir> <remote-prefix> [--concurrency N] [--dry-run]\n',
  ai:
    'stratos ai alt <url>\n' +
    'stratos ai moderate <url>\n' +
    'stratos ai crop <url>\n' +
    'stratos ai bg-remove <url>\n',
  image:
    'stratos image transform <url> [--w] [--h] [--fit] [--format] [--q] [--blur] [--sharpen]\n' +
    'stratos image blurhash <url> [--size N]\n' +
    'stratos image lqip <url> [--size N] [--blur N]\n' +
    'stratos image auto <path>\n',
  tokens:
    'stratos tokens list\n' +
    'stratos tokens create --name N --scopes S[,S...] [--expires-in DAYS]\n' +
    'stratos tokens rm <id>\n',
  webhooks:
    'stratos webhooks list\n' +
    'stratos webhooks add --url U --events E[,E...] [--secret S]\n' +
    'stratos webhooks rm <id>\n',
  logs:
    'stratos logs tail [--level error|warn|info]\n' +
    'stratos logs query [--days N] [--level L] [--limit N]\n',
  rules:
    'stratos rules get      <_headers|_redirects>\n' +
    'stratos rules set      <_headers|_redirects> -f <file>   (or via stdin)\n' +
    'stratos rules diff     <_headers|_redirects> -f <file>\n' +
    'stratos rules validate <_headers|_redirects> -f <file>\n\n' +
    'diff exits 0 if remote and local match, 69 on drift (git-style).\n' +
    'validate exits 0 if the local file parses cleanly, 65 (DATAERR) with\n' +
    'a line-by-line issue list otherwise. Offline; no API call.\n',
  cost:
    'stratos cost [--days N] [--zone Z] [--projected]\n\n' +
    'Spend breakdown by region. Reads /api/billing/usage when available;\n' +
    'falls back to projecting from /api/core/statistics × the published\n' +
    'rate card (--projected forces the projection mode explicitly).\n\n' +
    'Output columns: region, requests, bandwidth_gb, cost_usd.\n',
  carbon:
    'stratos carbon [--days N] [--region X] [--intensity-below N]\n\n' +
    'Energy and CO2e attribution for cached traffic. gCO2e/kWh comes\n' +
    'from the Electricity Maps public API (free tier); on failure falls\n' +
    'back to documented per-region defaults.\n\n' +
    '--intensity-below N is the carbon-aware deploy gate: exits 0 if\n' +
    'at least one region\'s grid intensity is below the threshold, 69\n' +
    'otherwise. Use as:  stratos carbon --intensity-below 250 && stratos deploy\n\n' +
    'ELECTRICITY_MAPS_TOKEN env var enables the keyed tier of the API.\n',
  mcp: 'stratos mcp serve\n  Speak Model Context Protocol over stdio.\n',
  completion: 'stratos completion <bash|zsh|fish|powershell>\n',
  config:
    'stratos config list\n' +
    'stratos config get <profile>.<key>\n' +
    'stratos config set <profile>.<key> <value>\n' +
    'stratos config edit                  Open $EDITOR on the config file (validates on save).\n',
  explain:
    'stratos explain <code|status>\n\n' +
    'Print the cause and remediation for a sysexits exit code or HTTP\n' +
    'status. Accepts numeric (`64`, `429`) or symbolic (`EX_NOPERM`, \n' +
    '`EX_TEMPFAIL`) forms. Use --json for machine-readable output.\n\n' +
    'Examples:\n' +
    '  stratos explain 77\n' +
    '  stratos explain EX_TEMPFAIL\n' +
    '  stratos explain 429 --json\n',
  init:
    'stratos init [--profile NAME] [--cdn-url URL] [--account-key K] [--access-key K] [--signed-secret S] [--force]\n\n' +
    'Interactive first-run setup. Walks through profile creation and\n' +
    'writes the result to ~/.config/stratos/config.json. Each prompt\n' +
    'accepts a flag override so the command is scriptable from CI.\n',
  schema:
    'stratos schema\n\n' +
    'Emit a machine-readable command catalogue. Designed for agent\n' +
    'callers (Claude Code, Cursor) and tools that auto-generate\n' +
    'completion / docs.\n\n' +
    'Output formats:\n' +
    '  --output json (default)   wrapper object with version + commands[]\n' +
    '  --output ndjson           one command per line — pipes into jq -c,\n' +
    '                            DuckDB read_ndjson, or an LLM context\n' +
    '                            without buffering the array\n' +
    '  --output yaml             human-friendly\n\n' +
    'Examples:\n' +
    '  stratos schema | jq \'.commands | map(.name)\'\n' +
    '  stratos schema --output ndjson | grep cloudcdn_  # MCP-exposed commands\n',
};

/**
 * `stratos help [<topic>]` — print the root help or a topic-specific block.
 *
 * @param {string[]} rest - Positional args after `help`; `rest[0]` is the topic.
 * @returns {void}
 */
function cmdHelp(rest) {
  const topic = rest[0];
  if (!topic) { out(HELP_ROOT); return; }
  const h = HELP_BY_COMMAND[topic];
  if (h) { out(h); return; }
  // Fall back to a synthesised minimum from COMMAND_META so every
  // command in `stratos schema` has at least a usage line + summary.
  // Curated entries in HELP_BY_COMMAND take precedence; this is for
  // the commands whose help is a one-liner anyway (stats, audit,
  // analytics, ask, search, upgrade, logout, …).
  const meta = COMMAND_META[topic];
  if (meta) {
    out(`stratos ${topic}\n  ${meta.summary}\n  Exit codes: ${meta.exits.join(', ')}\n`);
    return;
  }
  diag(`No help for '${topic}'.`);
  process.exit(EX.USAGE);
}

/**
 * `stratos completion <shell>` — emit a shell-completion script on stdout.
 *
 * Supported shells: `bash`, `zsh`, `fish`, `powershell`. Each produces a
 * script the user can `eval` / `source` from their shell rc.
 *
 * @param {string[]} rest - `rest[0]` is the shell name.
 * @returns {void}
 */
function cmdCompletion(rest) {
  const shell = rest[0];
  if (!shell) fatal('completion needs a shell name (bash|zsh|fish|powershell).', EX.USAGE);
  const COMMANDS = KNOWN_COMMANDS;
  const list = COMMANDS.join(' ');
  switch (shell) {
    case 'bash':
      out(`# stratos bash completion — eval "$(stratos completion bash)"
_stratos_complete() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${list}" -- "$cur") )
    return 0
  fi
}
complete -F _stratos_complete stratos
`);
      break;
    case 'zsh':
      out(`# stratos zsh completion — eval "$(stratos completion zsh)"
_stratos() {
  local -a commands
  commands=(${COMMANDS.map((cm) => `'${cm}'`).join(' ')})
  if (( CURRENT == 2 )); then
    _describe 'command' commands
  fi
}
compdef _stratos stratos
`);
      break;
    case 'fish':
      out(`# stratos fish completion — stratos completion fish | source
${COMMANDS.map((cm) => `complete -c stratos -n '__fish_use_subcommand' -a '${cm}'`).join('\n')}
`);
      break;
    case 'powershell':
      out(`# stratos PowerShell completion — Invoke-Expression (stratos completion powershell)
Register-ArgumentCompleter -Native -CommandName stratos -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  '${COMMANDS.join("','")}' -split ',' | Where-Object { $_ -like "$wordToComplete*" }
}
`);
      break;
    default:
      fatal(`unknown shell: ${shell}`, EX.USAGE);
  }
}

/**
 * `stratos upgrade` — print the one-liner needed to fetch the newest
 * pinned release. Does not run the installer directly.
 *
 * @returns {Promise<void>}
 */
async function cmdUpgrade() {
  const url = (process.env.CLOUDCDN_URL || 'https://cloudcdn.pro').replace(/\/$/, '');
  info(`Re-running installer from ${url}/dist/stratos/install.sh`);
  /* c8 ignore next 5 -- branches on process.platform; both arms reachable
     only on their respective hosts. */
  if (platform() === 'win32') {
    diag(`On Windows, run:\n  irm ${url}/dist/stratos/install.ps1 | iex`);
  } else {
    diag(`Run:\n  curl -sL ${url}/dist/stratos/install.sh | bash`);
  }
}

/**
 * `stratos config get | set | list` — manage profile entries in
 * `~/.config/stratos/config.json`.
 *
 * @param {string[]} rest  - Positional args after `config`.
 * @param {Object}   flags - Parsed CLI flags (unused; reserved).
 * @returns {Promise<void>}
 */
async function cmdConfig(rest, flags) {
  const action = rest[0];
  const cfg = await loadFileConfig();
  cfg.profiles = cfg.profiles || {};
  switch (action) {
    case 'list': {
      emit(cfg);
      return;
    }
    case 'get': {
      const dotted = rest[1];
      if (!dotted) fatal('config get <profile>.<key>', EX.USAGE);
      const [p, k] = dotted.split('.');
      const v = (cfg.profiles[p] || {})[k];
      if (v === undefined) process.exit(EX.UNAVAILABLE);
      out(typeof v === 'string' ? v : JSON.stringify(v));
      return;
    }
    case 'set': {
      const dotted = rest[1];
      const value = rest[2];
      if (!dotted || value === undefined) fatal('config set <profile>.<key> <value>', EX.USAGE);
      const [p, k] = dotted.split('.');
      cfg.profiles[p] = cfg.profiles[p] || {};
      cfg.profiles[p][k] = value;
      await saveFileConfig(cfg);
      info(`set profiles.${p}.${k}`);
      return;
    }
    case 'edit':
      return cmdConfigEdit(flags);
    default:
      fatal('config <list|get|set|edit>', EX.USAGE);
  }
}

/* c8 ignore start -- exec's an interactive editor; covered by manual QA */
/**
 * `stratos config edit` — open the config file in `$EDITOR`, validate
 * the resulting JSON, and refuse to keep an invalid file.
 *
 * `EDITOR` is honoured first, then `VISUAL`, then a platform default
 * (`notepad` on Windows, `vi` elsewhere). The config file is created
 * with a minimal `{ "profiles": {} }` scaffold if it doesn't exist yet.
 *
 * @param {Object} flags - Parsed CLI flags (unused; reserved).
 * @returns {Promise<void>}
 */
async function cmdConfigEdit(flags) {
  await mkdir(CONFIG_DIR, { recursive: true });
  try {
    await access(CONFIG_FILE);
  } catch {
    await writeFile(CONFIG_FILE,
      JSON.stringify({ profiles: {} }, null, 2) + '\n',
      { mode: 0o600 });
    info(`scaffolded ${CONFIG_FILE}`);
  }

  const editor = process.env.EDITOR || process.env.VISUAL ||
    (platform() === 'win32' ? 'notepad' : 'vi');
  info(`opening ${CONFIG_FILE} in ${editor}`);
  // Fire and wait. Inherit stdio so vim/nano/etc render properly.
  const r = await new Promise((resolve) => {
    const child = spawn(editor, [CONFIG_FILE], { stdio: 'inherit' });
    child.on('close', (code) => resolve({ code }));
    child.on('error', (e) => resolve({ code: -1, error: e.message }));
  });
  if (r.code !== 0) {
    fatal(`editor exited with status ${r.code}${r.error ? ' (' + r.error + ')' : ''}; file unchanged`, EX.SOFTWARE);
  }

  // Re-read + parse — refuse to keep the file if it's invalid.
  let parsed;
  try {
    parsed = JSON.parse(await readFile(CONFIG_FILE, 'utf8'));
  } catch (e) {
    fatal(`config no longer parses as JSON: ${e.message}\n        Re-edit with \`stratos config edit\` to fix.`, EX.DATAERR);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fatal('config must be a JSON object with a top-level `profiles` key.', EX.DATAERR);
  }
  if (!parsed.profiles || typeof parsed.profiles !== 'object') {
    fatal('config must contain a `profiles` object.', EX.DATAERR);
  }
  const n = Object.keys(parsed.profiles).length;
  info(`✓ valid · ${n} profile(s)`);
}
/* c8 ignore stop */

/**
 * `stratos init` — first-run interactive setup. Walks through profile
 * creation (name, CDN URL, optional keys), writes the result to
 * `~/.config/stratos/config.json`, and runs `stratos doctor`-style
 * checks at the end. Refuses to clobber an existing profile without
 * `--force`.
 *
 * Non-interactive paths (CI, piped stdin) are honoured: every prompt
 * accepts a `--<key>=<value>` override (e.g. `--profile=prod
 * --cdn-url=https://… --account-key=cdnsk_… --access-key=cdnsk_…
 * --signed-secret=…`), so this command can also be driven from
 * provisioning scripts.
 *
 * @param {string[]} positional - Unused; reserved.
 * @param {Object}   flags      - `--profile`, `--cdn-url`, `--account-key`,
 *                                `--access-key`, `--signed-secret`, `--force`.
 * @returns {Promise<void>}
 */
async function cmdInit(positional, flags) {
  const cfg = await loadFileConfig();
  cfg.profiles = cfg.profiles || {};

  /* c8 ignore start -- the `stdin.isTTY` arm is an interactive prompt;
     non-TTY (spawned) tests always take the `'default'` arm. */
  const profileName = flags.profile ||
    (process.stdin.isTTY ? await promptPlain('Profile name', 'default') : 'default');
  /* c8 ignore stop */
  if (cfg.profiles[profileName] && !flags.force) {
    fatal(`profile "${profileName}" already exists. Re-run with --force to overwrite, or pick another name with --profile=<name>.`, EX.USAGE);
  }

  /* c8 ignore start -- same interactive-prompt reason as profileName above. */
  const cdnUrl = flags['cdn-url'] ||
    (process.stdin.isTTY ? await promptPlain('CDN base URL', 'https://cloudcdn.pro') : 'https://cloudcdn.pro');
  /* c8 ignore stop */

  /* c8 ignore start -- interactive prompts; covered by manual QA */
  const accountKey = flags['account-key'] !== undefined ? flags['account-key']
    : (process.stdin.isTTY ? await promptHidden('CloudCDN account key (control-plane, optional): ') : '');
  const accessKey = flags['access-key'] !== undefined ? flags['access-key']
    : (process.stdin.isTTY ? await promptHidden('CloudCDN access key (read-only, optional): ') : '');
  const signedSecret = flags['signed-secret'] !== undefined ? flags['signed-secret']
    : (process.stdin.isTTY ? await promptHidden('Signed-URL HMAC secret (optional): ') : '');
  /* c8 ignore stop */

  const entry = { url: cdnUrl };
  if (accountKey)  entry.account_key = accountKey;
  if (accessKey)   entry.access_key = accessKey;
  if (signedSecret) entry.signed_url_secret = signedSecret;
  cfg.profiles[profileName] = entry;
  await saveFileConfig(cfg);

  info(`✓ wrote profile "${profileName}" to ${CONFIG_FILE}`);
  info(`  url = ${cdnUrl}`);
  info(`  account_key = ${entry.account_key ? maskKey(entry.account_key) : c.dim('(unset)')}`);
  info(`  access_key  = ${entry.access_key  ? maskKey(entry.access_key)  : c.dim('(unset)')}`);
  info(`  signed_url_secret = ${entry.signed_url_secret ? maskKey(entry.signed_url_secret) : c.dim('(unset)')}`);
  info('');
  info(`Activate with:  STRATOS_PROFILE=${profileName} stratos health`);
  info(`Or per-call:    stratos --profile ${profileName} health`);
  if (wantStructuredOutput()) emit({ profile: profileName, entry: { ...entry,
    account_key: entry.account_key ? maskKey(entry.account_key) : null,
    access_key:  entry.access_key  ? maskKey(entry.access_key)  : null,
    signed_url_secret: entry.signed_url_secret ? maskKey(entry.signed_url_secret) : null,
  } });
}

/* c8 ignore start -- interactive TTY-only readline; covered by manual QA */
/**
 * Plain-text readline prompt (echo on). Used by {@link cmdInit} for
 * non-secret fields (profile name, CDN URL). Empty input falls back to
 * `fallback`.
 *
 * @param {string} label    - Prompt label (no trailing punctuation needed).
 * @param {string} fallback - Default value if the user just hits return.
 * @returns {Promise<string>}
 */
async function promptPlain(label, fallback) {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    rl.question(`${label} [${fallback}]: `, (answer) => {
      rl.close();
      resolve((answer && answer.trim()) || fallback);
    });
  });
}
/* c8 ignore stop */

// ─────────────────────────────────────────────────────────────────────────────
// Login — prompt for keys, store in OS keychain.
// ─────────────────────────────────────────────────────────────────────────────
/* c8 ignore start -- interactive TTY-only readline; covered by manual QA */
/**
 * Read a single line from stdin with echo suppressed. Used by
 * `stratos login` to prompt for keys interactively.
 *
 * @param {string} prompt - Prompt text written to stderr before reading.
 * @returns {Promise<string>} The entered value (may be empty).
 */
async function promptHidden(prompt) {
  process.stderr.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const stdoutMuted = (() => {
    let muted = false;
    rl._writeToOutput = (s) => {
      if (muted) {
        if (s.includes('\n') || s.includes('\r')) process.stderr.write('\n');
      } else {
        process.stderr.write(s);
      }
    };
    return { mute: () => { muted = true; }, unmute: () => { muted = false; } };
  })();
  stdoutMuted.mute();
  return new Promise((resolve) => {
    rl.question('', (answer) => {
      stdoutMuted.unmute();
      rl.close();
      resolve(answer);
    });
  });
}
/* c8 ignore stop */

/**
 * `stratos login [set|status|logout]` — manage credentials stored in
 * the OS keychain. Without a subcommand, runs the interactive `set` flow.
 *
 * Non-interactive callers can pass `--account-key=…`, `--access-key=…`,
 * and/or `--signed-secret=…` to skip the prompts.
 *
 * @param {string[]} positional - Positional args after `login`.
 * @param {Object}   flags      - Parsed CLI flags.
 * @returns {Promise<void>}
 */
async function cmdLogin(positional, flags) {
  const action = positional[0] || 'set';
  if (action === 'status') return loginStatus(flags);
  if (action === 'logout') return loginLogout(flags);
  if (action !== 'set' && action !== undefined) fatal('login [set|status|logout]', EX.USAGE);

  /* c8 ignore start -- the 'set' path of login requires either an
     interactive TTY (promptHidden) or a working OS keychain in the test
     environment. Both are covered by manual QA; the test suite verifies
     `login status` and `logout` instead. */
  if (!process.stdin.isTTY && !flags['account-key'] && !flags['access-key']) {
    fatal('login is interactive; pipe a key with --account-key=… on the command line for non-TTY use.', EX.USAGE);
  }

  const account =
    flags['account-key'] ||
    await promptHidden('CloudCDN account key (control-plane, leave blank to skip): ');
  const access =
    flags['access-key'] ||
    await promptHidden('CloudCDN access key (read-only, leave blank to skip): ');
  const secret =
    flags['signed-secret'] ||
    await promptHidden('Signed-URL HMAC secret (leave blank to skip): ');

  let wrote = 0;
  if (account) { await keychainSet('account_key', account); wrote++; info('stored account_key'); }
  if (access)  { await keychainSet('access_key',  access);  wrote++; info('stored access_key'); }
  if (secret)  { await keychainSet('signed_url_secret', secret); wrote++; info('stored signed_url_secret'); }

  if (wrote === 0) {
    diag('Nothing stored.');
    process.exit(EX.USAGE);
  }
  info(`${wrote} secret(s) stored in ${platformKeychainName()}.`);
  info('Stratos will use them automatically on future runs.');
  /* c8 ignore stop */
}

/**
 * Human-readable name of the current platform's secret store. Used in
 * status output and informational messages.
 *
 * @returns {string} One of `'macOS Keychain'`, `'libsecret (GNOME Keyring / KWallet)'`,
 *                   `'Windows Credential Manager'`, or `'OS keychain'`.
 */
function platformKeychainName() {
  /* c8 ignore start -- platform-specific switch arms; CI exercises only one */
  switch (platform()) {
    case 'darwin': return 'macOS Keychain';
    case 'linux':  return 'libsecret (GNOME Keyring / KWallet)';
    case 'win32':  return 'Windows Credential Manager';
    default:       return 'OS keychain';
  }
  /* c8 ignore stop */
}

/**
 * `stratos login status` — render the resolved configuration with all
 * secret values masked. Never prints the raw key material.
 *
 * @param {Object} flags - Parsed CLI flags (forwarded to `envConfig`).
 * @returns {Promise<void>}
 */
async function loginStatus(flags) {
  const cfg = await envConfig(flags);
  const rows = [
    { key: 'profile',          value: cfg.PROFILE },
    { key: 'url',              value: cfg.BASE },
    { key: 'account_key',      value: maskKey(cfg.ACCOUNT_KEY) },
    { key: 'access_key',       value: maskKey(cfg.ACCESS_KEY) },
    { key: 'signed_url_secret',value: maskKey(cfg.SIGNED_URL_SECRET) },
    { key: 'timeout_ms',       value: String(cfg.TIMEOUT_MS) },
    { key: 'max_retries',      value: String(cfg.MAX_RETRIES) },
  ];
  emitList(rows, [
    { header: 'SETTING', key: 'key' },
    { header: 'VALUE',   key: 'value' },
  ]);
}

/**
 * Mask a secret for display.
 *
 * @param {string} k - Raw secret material.
 * @returns {string} A dim `(unset)` placeholder, `***` for very short
 *                   secrets, or a `prefix…suffix` excerpt that hides the
 *                   middle of the key.
 */
function maskKey(k) {
  if (!k) return c.dim('(unset)');
  if (k.length <= 8) return c.dim('***');
  return c.dim(k.slice(0, 6) + '…' + k.slice(-2));
}

/**
 * `stratos logout` (and the `login logout` subcommand) — remove every
 * Stratos key from the OS keychain and clear the in-process cache.
 *
 * @param {Object} flags - Parsed CLI flags (unused; reserved).
 * @returns {Promise<void>}
 */
async function loginLogout(flags) {
  /* c8 ignore start -- Windows-only safety message */
  if (platform() === 'win32') {
    warn('On Windows, secrets are deleted via cmdkey. Read-back is unavailable; check Credential Manager UI to verify.');
  }
  /* c8 ignore stop */
  await keychainDel('account_key');
  await keychainDel('access_key');
  await keychainDel('signed_url_secret');
  _kcCache.clear();
  info('cleared all stratos secrets from ' + platformKeychainName());
}

// ─────────────────────────────────────────────────────────────────────────────
// Doctor — environment diagnostics.
//
// Checks node version, config file, keychain availability, credentials
// presence, network reachability to the configured CloudCDN base. Exits 0
// if all green or with informational warnings; non-zero only when something
// is definitely broken.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos doctor` — environment + reachability diagnostic. Validates
 * Node version, config file readability, OS keychain availability,
 * resolved credentials (masked), and a live `/api/health` round-trip.
 *
 * Exits zero on all-green, `EX.UNAVAILABLE` on any failed check.
 *
 * @param {Object} flags - Parsed CLI flags (`--json`, `--profile`, …).
 * @returns {Promise<void>}
 */
async function cmdDoctor(flags) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok, detail });

  // Node version.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check('Node ≥ 20', nodeMajor >= 20, `detected ${process.versions.node}`);

  // Config file.
  try {
    const cfg = await loadFileConfig();
    const n = Object.keys(cfg.profiles || {}).length;
    check('Config file readable', true, `${CONFIG_FILE} · ${n} profile(s)`);
  } catch (e) {
    check('Config file readable', false, e.message);
  }

  // Keychain available.
  /* c8 ignore start -- platform-specific arms; CI exercises whichever one matches the runner OS */
  const kcCmd = platform() === 'darwin' ? 'security'
            : platform() === 'linux'  ? 'secret-tool'
            : platform() === 'win32'  ? 'cmdkey' : null;
  if (kcCmd) {
    const r = await execCapture(kcCmd, ['--version'].slice(0, kcCmd === 'cmdkey' ? 0 : 1));
    check(`Keychain (${kcCmd})`, r.code === 0 || r.stdout.length > 0 || r.stderr.length > 0,
      platformKeychainName());
  } else {
  /* c8 ignore stop */
    /* c8 ignore next 2 -- only reachable on exotic platforms (e.g. aix). */
    check('Keychain', false, `not supported on ${platform()}`);
  }

  // Credentials presence. Tolerate envConfig failures (e.g. unreadable
  // config file) so the rest of the report still renders.
  let cfg;
  try { cfg = await envConfig(flags); }
  catch { cfg = { BASE: 'https://cloudcdn.pro', ACCOUNT_KEY: '', ACCESS_KEY: '', SIGNED_URL_SECRET: '', TIMEOUT_MS: 5000 }; }
  check('account_key',       Boolean(cfg.ACCOUNT_KEY), cfg.ACCOUNT_KEY ? maskKey(cfg.ACCOUNT_KEY) : 'unset');
  check('access_key',        Boolean(cfg.ACCESS_KEY),  cfg.ACCESS_KEY  ? maskKey(cfg.ACCESS_KEY)  : 'unset (read-only ops fall back to account_key)');
  check('signed_url_secret', Boolean(cfg.SIGNED_URL_SECRET),
    cfg.SIGNED_URL_SECRET ? maskKey(cfg.SIGNED_URL_SECRET) : 'unset (signed command will fail)');

  // Network reachability.
  let netOk = false; let netDetail = '';
  try {
    const t0 = Date.now();
    const res = await fetch(cfg.BASE.replace(/\/$/, '') + '/api/health',
      { signal: AbortSignal.timeout(5000) });
    netOk = res.status < 500;
    netDetail = `HTTP ${res.status} in ${Date.now() - t0}ms`;
  } catch (e) {
    netDetail = e.message;
  }
  check(`Reach ${cfg.BASE}`, netOk, netDetail);

  // Render.
  if (wantStructuredOutput()) { emit(checks); return; }
  const headers = c.bold('CHECK'.padEnd(30) + 'STATUS  DETAIL');
  out(headers);
  out(c.dim('─'.repeat(80)));
  let anyFail = false;
  for (const ck of checks) {
    const status = ck.ok ? c.green('  ok  ') : c.red(' fail ');
    if (!ck.ok) anyFail = true;
    out(`${ck.name.padEnd(30)}${status}  ${c.dim(ck.detail)}`);
  }
  if (anyFail) process.exit(EX.UNAVAILABLE);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bench — measure cold-start + a few request-path latencies.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos bench [-n N]` — record a cold-start timing and N
 * `/api/health` latency samples, then emit min/p50/p95/max.
 *
 * @param {Object} flags - Parsed CLI flags (`-n`, `--iterations`, `--json`).
 * @returns {Promise<void>}
 */
async function cmdBench(flags) {
  const cfg = await envConfig(flags);
  const n = Number(flags.n || flags.iterations || 5);
  const target = cfg.BASE.replace(/\/$/, '') + '/api/health';
  const samples = [];

  if (!FLAGS_GLOBAL.quiet) info(`probing ${target} × ${n}`);

  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    try {
      const res = await fetch(target, { signal: AbortSignal.timeout(cfg.TIMEOUT_MS) });
      await res.text();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      samples.push({ i, status: res.status, ms: Math.round(ms * 100) / 100 });
    } catch (e) {
      samples.push({ i, status: 0, ms: 0, error: e.message });
    }
  }

  // Cold-start: spawn `node stratos.mjs version` once and time it.
  const t0 = process.hrtime.bigint();
  await execCapture(process.execPath, [fileURLToPath(import.meta.url), 'version']);
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const oks = samples.filter((s) => s.status > 0 && s.status < 500).map((s) => s.ms);
  const sorted = [...oks].sort((a, b) => a - b);
  const stats = {
    target,
    samples,
    summary: {
      cold_start_ms: Math.round(coldMs * 100) / 100,
      n_ok: oks.length,
      n_fail: samples.length - oks.length,
      min_ms: sorted[0] ?? null,
      p50_ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
      p95_ms: sorted[Math.floor(sorted.length * 0.95)] ?? null,
      max_ms: sorted[sorted.length - 1] ?? null,
    },
  };
  if (wantStructuredOutput()) { emit(stats); return; }
  out(c.bold(`cold start (spawn → exit):  ${stats.summary.cold_start_ms} ms`));
  out(c.bold(`requests (${oks.length}/${samples.length} ok):  `) +
      `min ${stats.summary.min_ms}  p50 ${stats.summary.p50_ms}  p95 ${stats.summary.p95_ms}  max ${stats.summary.max_ms}  (ms)`);
  for (const s of samples) {
    const status = s.status === 0 ? c.red('ERR') : s.status < 400 ? c.green(String(s.status)) : c.yellow(String(s.status));
    out(`  #${s.i + 1}  ${status}  ${String(s.ms).padStart(7)} ms  ${s.error || ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Explain — look up causes + remediation for an exit code or HTTP status.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Table of explanations keyed by either a sysexits exit code (`'0'`,
 * `'64'`, …), a symbolic alias (`'EX_USAGE'`, `'EX_NOPERM'`, …), or an
 * HTTP status (`'401'`, `'429'`, …). Each entry carries a short
 * one-line summary, a longer cause description, and at least one
 * remediation step.
 *
 * @type {Object<string, { name: string, cause: string, fix: string[] }>}
 */
const EXPLANATIONS = {
  // Sysexits-style exit codes.
  '0':  { name: 'EX_OK',          cause: 'The command completed successfully.', fix: [] },
  '64': { name: 'EX_USAGE',       cause: 'You passed invalid CLI arguments — a missing flag, an unknown subcommand, or a malformed value.',
          fix: ['Run `stratos <command> --help` for the exact signature.', 'Check that any value-taking short flag (e.g. `-n 5`, `-f path`) has a value following it.'] },
  '65': { name: 'EX_DATAERR',     cause: 'The CLI received unparseable data (e.g. a non-JSON response when JSON was expected).',
          fix: ['Re-run with `--verbose` to see the raw request and response.', 'Confirm `CLOUDCDN_URL` points at the right endpoint.'] },
  '66': { name: 'EX_NOINPUT',     cause: 'A required input file or stream is missing or empty.',
          fix: ['For `stratos purge -`, make sure stdin contains one URL per line.', 'For `stratos rules set _headers -f <file>`, confirm `<file>` exists and is readable.'] },
  '69': { name: 'EX_UNAVAILABLE', cause: 'The CloudCDN API returned a 4xx response other than 401/403/429.',
          fix: ['Re-run with `--verbose` to see the request and response body.', 'For `stratos rules diff`, exit 69 is *expected on drift* — git-style.'] },
  '70': { name: 'EX_SOFTWARE',    cause: 'An uncaught exception inside Stratos itself.',
          fix: ['Open an issue with the stderr output: https://github.com/sebastienrousseau/stratos/issues/new', 'Run `stratos doctor` to rule out an env / config problem.'] },
  '73': { name: 'EX_CANTCREAT',   cause: 'Stratos could not create a file (typically `~/.config/stratos/config.json` or a downloaded asset).',
          fix: ['Check the destination directory exists and is writable.', 'Verify `$XDG_CONFIG_HOME` (if set) points at a writable path.'] },
  '74': { name: 'EX_IOERR',       cause: 'A filesystem read/write failed.',
          fix: ['Re-check filesystem permissions on the target path.', 'On Linux, confirm the volume is not mounted read-only.'] },
  '75': { name: 'EX_TEMPFAIL',    cause: 'A transient failure exhausted retries — typically a 5xx, 429, or network error.',
          fix: ['Re-run after a backoff; the CDN may be under load.', 'Raise `--retries` / `CLOUDCDN_RETRIES` for noisier networks (default 3).', 'Raise `--timeout` / `CLOUDCDN_TIMEOUT` for slow links (default 15000 ms).'] },
  '77': { name: 'EX_NOPERM',      cause: 'Permission denied — the API key is wrong, expired, or lacks the required scope.',
          fix: ['Run `stratos login status` to confirm the resolved key (masked).', 'Verify the key has the required scope on https://www.npmjs.com/package/@cloudcdn/stratos or your CloudCDN dashboard.', 'For control-plane ops, `CLOUDCDN_ACCOUNT_KEY` must be set.'] },
  '78': { name: 'EX_CONFIG',      cause: 'A required configuration value is missing or unreadable.',
          fix: ['Run `stratos doctor` to surface the specific check that failed.', 'For `stratos signed`, `SIGNED_URL_SECRET` or `--secret` is required.', 'For control-plane commands, `CLOUDCDN_ACCOUNT_KEY` is required.'] },
  '130':{ name: 'SIGINT',         cause: 'You interrupted the command (Ctrl-C). This is normal for `stratos logs tail`.',
          fix: [] },

  // HTTP statuses — the most common ones Stratos surfaces.
  '200': { name: 'OK',                    cause: 'The request succeeded.', fix: [] },
  '301': { name: 'Moved Permanently',     cause: 'The endpoint moved. Stratos does not follow redirects on control-plane requests by default.',
           fix: ['Update `CLOUDCDN_URL` to the new origin.'] },
  '400': { name: 'Bad Request',           cause: 'The server rejected the request payload — typically a malformed body or query parameter.',
           fix: ['Re-run with `--verbose` to see the request body.', 'For `stratos purge --tag <t>`, confirm the tag has no leading/trailing whitespace.'] },
  '401': { name: 'Unauthorized',          cause: 'No credentials, or the credentials are invalid.',
           fix: ['Set `CLOUDCDN_ACCOUNT_KEY` (control-plane) or `CLOUDCDN_ACCESS_KEY` (read-only).', 'Run `stratos login status` to confirm what Stratos is actually sending.'] },
  '403': { name: 'Forbidden',             cause: 'Credentials are valid but lack permission for this resource.',
           fix: ['Confirm the token scope includes the operation you are attempting.', 'For zones / tokens / webhooks endpoints, the *control-plane* `CLOUDCDN_ACCOUNT_KEY` is required, not the read-only `ACCESS_KEY`.'] },
  '404': { name: 'Not Found',             cause: 'The path, asset, or resource does not exist.',
           fix: ['For `stratos assets show <path>`, confirm the path matches the manifest exactly.', 'For `stratos zones show <id>`, confirm the zone id with `stratos zones list`.'] },
  '409': { name: 'Conflict',              cause: 'The request conflicts with current resource state (e.g. creating a zone that already exists).',
           fix: ['List the existing resources first (`stratos zones list`, `stratos tokens list`).'] },
  '413': { name: 'Payload Too Large',     cause: 'Body exceeds the endpoint limit. CloudCDN storage uploads are 25 MB per file; batch is 25 MB per file × 50 files.',
           fix: ['Split large uploads into batches with `stratos storage sync` (auto-chunks at 50 files).'] },
  '422': { name: 'Unprocessable Entity',  cause: 'The payload parsed but failed semantic validation.',
           fix: ['Re-run with `--verbose` and inspect the body — the server usually returns the failing field.'] },
  '429': { name: 'Too Many Requests',     cause: 'Rate-limited. CloudCDN treats `purge --everything` and the AI endpoints especially carefully.',
           fix: ['Stratos retries 429 automatically with full-jitter backoff (up to `--retries`). If you see exit 75, retries were exhausted — back off longer.', 'Stagger calls in CI loops or add `sleep` between batches.'] },
  '500': { name: 'Internal Server Error', cause: 'The CDN edge encountered an unexpected error.',
           fix: ['Re-run after a backoff; Stratos retries 5xx by default.', 'Check the CloudCDN status page if the failure persists.'] },
  '502': { name: 'Bad Gateway',           cause: 'An upstream service the CDN depends on is unreachable.',
           fix: ['Re-run; transient. Persistent 502s suggest the upstream binding is unhealthy — check `stratos health --deep`.'] },
  '503': { name: 'Service Unavailable',   cause: 'A CDN binding is overloaded or in maintenance.',
           fix: ['Re-run after a backoff.', 'Check `stratos health --deep` to confirm bindings.'] },
  '504': { name: 'Gateway Timeout',       cause: 'A backend hop exceeded its deadline.',
           fix: ['Raise `--timeout` for the request.', 'If the operation is genuinely long-running (e.g. `purge --everything`), it may have succeeded async; verify with the dashboard.'] },
};

/**
 * Aliases — short symbolic names map onto the numeric keys in
 * {@link EXPLANATIONS}.
 *
 * @type {Object<string, string>}
 */
const EXPLAIN_ALIASES = {
  'OK': '0', 'EX_OK': '0',
  'EX_USAGE': '64', 'USAGE': '64',
  'EX_DATAERR': '65',
  'EX_NOINPUT': '66',
  'EX_UNAVAILABLE': '69', 'UNAVAILABLE': '69',
  'EX_SOFTWARE': '70', 'SOFTWARE': '70',
  'EX_CANTCREAT': '73',
  'EX_IOERR': '74',
  'EX_TEMPFAIL': '75', 'TEMPFAIL': '75',
  'EX_NOPERM': '77', 'NOPERM': '77', 'PERM': '77',
  'EX_CONFIG': '78', 'CONFIG': '78',
};

/**
 * `stratos explain <code|status|alias>` — print the cause and
 * remediation for a sysexits exit code or HTTP status. Accepts numeric
 * (`64`, `77`, `429`) and symbolic (`EX_USAGE`, `EX_NOPERM`) forms.
 *
 * @param {string[]} positional - `positional[0]` is the code or alias.
 * @param {Object}   flags      - Parsed CLI flags (`--json`).
 * @returns {Promise<void>}
 */
async function cmdExplain(positional, flags) {
  const arg = positional[0];
  if (!arg) {
    fatal('explain needs a sysexits code, HTTP status, or alias (e.g. `stratos explain 77`, `stratos explain EX_NOPERM`).', EX.USAGE);
  }
  const key = EXPLAIN_ALIASES[arg.toUpperCase()] || String(arg);
  const entry = EXPLANATIONS[key];
  if (!entry) {
    fatal(`no explanation for "${arg}". Try one of: ${Object.keys(EXPLANATIONS).join(', ')}.`, EX.UNAVAILABLE);
  }
  if (wantStructuredOutput()) {
    emit({ code: key, ...entry });
    return;
  }
  out(`${c.bold(entry.name)} ${c.dim('(' + key + ')')}`);
  out('');
  out(c.bold('Cause'));
  out(`  ${entry.cause}`);
  if (entry.fix.length > 0) {
    out('');
    out(c.bold('Fix'));
    for (const step of entry.fix) out(`  • ${step}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Health, purge, signed, assets — existing commands, hardened.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos health [--deep]` — GET `/api/health` (or `?deep=1`) and emit
 * the JSON response.
 *
 * @param {Object} flags - Parsed CLI flags.
 * @returns {Promise<void>}
 */
async function cmdHealth(flags) {
  const deep = flags.deep ? '?deep=1' : '';
  const { ok, status, body } = await jsonReq('/api/health' + deep, { flags });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  emit(body, status);
}

/**
 * `stratos purge` — invalidate cache by URL list, by `--tag`, or with
 * `--everything`. `--dry-run` returns the would-be payload without
 * touching the network. Accepts URLs on stdin via a `-` positional.
 *
 * @param {string[]} positional - URL list or `-` to read stdin.
 * @param {Object}   flags      - Parsed CLI flags.
 * @returns {Promise<void>}
 */
export async function cmdPurge(positional, flags) {
  let urls = positional.slice();
  // Read stdin if positional contains '-' or if --stdin passed.
  if (urls.includes('-') || flags.stdin) {
    urls = urls.filter((u) => u !== '-');
    const stdin = await readStdinLines();
    urls.push(...stdin);
  }
  let payload;
  if (flags.everything) {
    payload = { purge_everything: true };
  } else if (flags.tag) {
    payload = { tags: flagList(flags.tag) };
  } else {
    if (urls.length === 0) fatal('purge needs at least one URL, --tag, or --everything.', EX.USAGE, 'usage_error');
    payload = { urls };
  }
  if (flags['dry-run']) {
    emit({ dry_run: true, would_send: payload });
    return;
  }
  const { ok, status, body } = await jsonReq('/api/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    flags,
  }, { role: 'control' });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  emit(body, status);
}

/**
 * `stratos signed <path> --expires <unix-sec>` — mint an HMAC-SHA256
 * signed CDN URL **offline** (no network). The signature is over a
 * length-prefixed canonical form so paths containing `|` cannot collide.
 *
 * @param {string[]} positional - `positional[0]` is the asset path.
 * @param {Object}   flags      - `--expires`, optional `--secret`.
 * @returns {Promise<void>}
 */
export async function cmdSigned(positional, flags) {
  const cfg = await envConfig(flags);
  if (positional.length === 0) fatal('signed needs a path argument.', EX.USAGE, 'usage_error');
  const path = positional[0];
  const expires = flags.expires;
  if (!expires) fatal('signed needs --expires <unix-seconds>.', EX.USAGE, 'usage_error');
  const secret = flags.secret || cfg.SIGNED_URL_SECRET;
  if (!secret) fatal('SIGNED_URL_SECRET (or --secret) is required.', EX.CONFIG, 'auth_missing_key');

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  // Canonical form: length-prefixed components so paths containing '|' or '\n'
  // can never collide with the separator.
  const canonical = `${path.length}:${path}|${String(expires).length}:${expires}`;
  const sigBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(canonical)));
  let hex = '';
  for (const b of sigBytes) hex += b.toString(16).padStart(2, '0');

  const url = `${cfg.BASE.replace(/\/$/, '')}/api/signed?path=${encodeURIComponent(path)}&expires=${encodeURIComponent(expires)}&sig=${hex}`;
  out(url);
}

/**
 * `stratos assets` — list the CDN asset catalogue, or `assets show <path>`
 * for single-asset metadata. With `--all`, walks every page up to a
 * safety cap of 1000.
 *
 * @param {string[]} positional - `['show', '<path>']` or empty.
 * @param {Object}   flags      - `--project`, `--format`, `--page`, `--all`, `--json`.
 * @returns {Promise<void>}
 */
async function cmdAssets(positional, flags) {
  if (positional[0] === 'show') {
    const path = positional[1];
    if (!path) fatal('assets show <path>', EX.USAGE);
    const params = new URLSearchParams({ path });
    const { ok, status, body } = await jsonReq('/api/assets/metadata?' + params, { flags });
    if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
    emit(body, status);
    return;
  }
  const buildParams = (page) => {
    const p = new URLSearchParams();
    if (flags.project) p.set('project', flags.project);
    if (flags.format)  p.set('format',  flags.format);
    if (page !== undefined) p.set('page', String(page));
    return p;
  };
  const get = async (page) => {
    const q = buildParams(page).toString();
    const r = await jsonReq('/api/assets' + (q ? '?' + q : ''), { flags });
    if (!r.ok) { emitFailure(r.body, r.status); process.exit(exitForStatus(r.status)); }
    return r;
  };

  if (flags.all) {
    // Auto-paginate until TotalPages or an empty page.
    const acc = [];
    let page = 1;
    let total;
    while (true) {
      const { body } = await get(page);
      if (!body || !Array.isArray(body.Data)) break;
      acc.push(...body.Data);
      total = body.TotalPages;
      if (FLAGS_GLOBAL.verbose) info(`page ${page}/${total ?? '?'} → ${body.Data.length} rows`);
      if (body.Data.length === 0) break;
      if (total !== undefined && page >= total) break;
      page++;
      /* c8 ignore start -- defensive cap; no real CDN tenant has >1000 asset
         pages, so this never trips in tests or production. */
      if (page > 1000) { warn('safety cap at 1000 pages'); break; }
      /* c8 ignore stop */
    }
    emitList(acc, [
      { header: 'PATH', key: 'Path' },
      { header: 'FORMAT', key: 'Format' },
      { header: 'SIZE', key: 'Size' },
      { header: 'TYPE', key: 'ContentType' },
    ]);
    info(`${acc.length} asset(s) across ${page} page(s)`);
    return;
  }

  const { body, status } = await get(flags.page);
  if (body && Array.isArray(body.Data)) {
    emitList(body.Data, [
      { header: 'PATH', key: 'Path' },
      { header: 'FORMAT', key: 'Format' },
      { header: 'SIZE', key: 'Size' },
      { header: 'TYPE', key: 'ContentType' },
    ]);
    if (body.Page !== undefined) info(`page ${body.Page} of ${body.TotalPages ?? '?'} · pass --all to fetch every page`);
  } else {
    emit(body, status);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Insights, stats, analytics, audit.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Convenience wrapper around {@link jsonReq} for GET requests that should
 * surface non-2xx as a process-exit. Returns the parsed body on success.
 *
 * @param {string} path  - Request path (joined onto the API base).
 * @param {Object} flags - Parsed CLI flags (forwarded to `envConfig`).
 * @param {'read'|'control'} [role='read'] - Auth-header policy.
 * @returns {Promise<any>}
 */
async function getJson(path, flags, role = 'read') {
  const { ok, status, body } = await jsonReq(path, { flags }, { role });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  return body;
}

/**
 * Validate and return a `--days` flag as a number.
 *
 * @param {Object} flags    - Parsed CLI flags.
 * @param {number} [max=90] - Inclusive upper bound.
 * @returns {number} The validated day count (defaults to 7).
 * @throws Exits with `EX.USAGE` when the value is missing the valid range.
 */
function daysParam(flags, max = 90) {
  const d = Number(flags.days || 7);
  if (!Number.isFinite(d) || d < 1 || d > max) fatal(`--days must be 1..${max}`, EX.USAGE);
  return d;
}

/**
 * `stratos insights {summary|top|asset|errors|geo}` — read-side
 * analytics over the configurable `--days` window.
 *
 * @param {string[]} positional - Subcommand + optional args.
 * @param {Object}   flags      - `--days`, `--limit`, `--zone`, `--json`.
 * @returns {Promise<void>}
 */
async function cmdInsights(positional, flags) {
  const sub = positional[0];
  switch (sub) {
    case 'summary': {
      const params = new URLSearchParams({ days: String(daysParam(flags)) });
      if (flags.zone) params.set('zone', flags.zone);
      emit(await getJson('/api/insights/summary?' + params, flags));
      return;
    }
    case 'top': {
      const params = new URLSearchParams({
        days: String(daysParam(flags)),
        limit: String(flags.limit || 10),
      });
      const body = await getJson('/api/insights/top-assets?' + params, flags);
      const rows = body.assets || body.Data || (Array.isArray(body) ? body : []);
      emitList(rows, [
        { header: 'PATH', key: 'path' },
        { header: 'REQUESTS', key: 'requests' },
        { header: 'BYTES', key: 'bytes' },
      ]);
      return;
    }
    case 'asset': {
      const path = positional[1];
      if (!path) fatal('insights asset <path>', EX.USAGE);
      const params = new URLSearchParams({ path, days: String(daysParam(flags)) });
      emit(await getJson('/api/insights/asset?' + params, flags));
      return;
    }
    case 'errors': {
      const params = new URLSearchParams({ days: String(daysParam(flags)) });
      emit(await getJson('/api/insights/errors?' + params, flags));
      return;
    }
    case 'geo':
    case 'geography': {
      const params = new URLSearchParams({ days: String(daysParam(flags)) });
      const body = await getJson('/api/insights/geography?' + params, flags);
      const rows = body.countries || body.Data || (Array.isArray(body) ? body : []);
      emitList(rows, [
        { header: 'COUNTRY', key: 'country' },
        { header: 'REQUESTS', key: 'requests' },
        { header: 'BYTES', key: 'bytes' },
      ]);
      return;
    }
    default:
      fatal('insights <summary|top|asset|errors|geo>', EX.USAGE);
  }
}

/**
 * `stratos stats` — control-plane aggregate statistics endpoint.
 *
 * @param {Object} flags - `--days`, `--zone`, `--json`.
 * @returns {Promise<void>}
 */
async function cmdStats(flags) {
  const params = new URLSearchParams({ days: String(daysParam(flags)) });
  if (flags.zone) params.set('zone', flags.zone);
  emit(await getJson('/api/core/statistics?' + params, flags, 'control'));
}

/**
 * `stratos analytics query` — filter the raw analytics stream by
 * `--days`, `--path`, `--bytes`, `--country`, `--cache` status.
 *
 * @param {string[]} positional - Subcommand (`query` is the only one).
 * @param {Object}   flags      - Filter flags + `--json`.
 * @returns {Promise<void>}
 */
async function cmdAnalytics(positional, flags) {
  const sub = positional[0] || 'query';
  if (sub !== 'query') fatal('analytics query [options]', EX.USAGE);
  const params = new URLSearchParams({ days: String(daysParam(flags, 30)) });
  for (const k of ['path', 'bytes', 'country', 'cache']) {
    if (flags[k] !== undefined) params.set(k, String(flags[k]));
  }
  emit(await getJson('/api/analytics?' + params, flags));
}

/**
 * `stratos audit` — immutable audit log query.
 *
 * @param {Object} flags - `--days` (1..7), `--action`, `--limit`, `--json`.
 * @returns {Promise<void>}
 */
async function cmdAudit(flags) {
  const days = Number(flags.days || 7);
  if (!Number.isFinite(days) || days < 1 || days > 7) fatal('--days must be 1..7', EX.USAGE);
  const params = new URLSearchParams({ days: String(days) });
  if (flags.action) params.set('action', flags.action);
  if (flags.limit) params.set('limit', String(flags.limit));
  const body = await getJson('/api/core/audit-logs?' + params, flags, 'control');
  const rows = body.logs || body.Data || (Array.isArray(body) ? body : []);
  emitList(rows, [
    { header: 'TIME',    key: 'timestamp' },
    { header: 'ACTION',  key: 'action' },
    { header: 'ACTOR',   key: 'actor' },
    { header: 'TARGET',  key: 'target' },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// FinOps & sustainability — `stratos cost` and `stratos carbon`.
//
// Both commands query the same `/api/billing/usage` endpoint for
// per-region requests + bytes-transferred, then layer on top:
//
//   cost   → multiply by published rate-card → $/region
//   carbon → multiply by energy coefficients → kWh/region
//            → multiply by grid intensity   → gCO2e/region
//
// Grid intensity comes from the public Electricity Maps API (free tier
// with attribution). On unreachable / unkeyed network, falls back to
// static per-region intensities documented in CARBON_DEFAULTS so the
// command never hard-fails on a network glitch — it just degrades to
// "fixed-coefficient" mode and prints an info line.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Published rate card (USD per unit) used by `cmdCost` when the API's
 * cost endpoint is unavailable or `--projected` is passed. Numbers
 * mirror CloudCDN's public pricing page; bump on rate changes.
 *
 * @type {{ per_million_requests: number, per_gb_transfer: number }}
 */
const COST_RATES = Object.freeze({
  per_million_requests: 0.20,   // $0.20 per million requests
  per_gb_transfer:      0.05,   // $0.05 per GB transferred (cache-hit blended)
});

/**
 * Carbon-coefficient defaults: energy per request and per GB
 * transferred, plus per-region grid-intensity fallbacks (gCO2e/kWh)
 * when the Electricity Maps API is unreachable.
 *
 * Energy coefficients are conservative industry averages for cached
 * CDN traffic: ~0.0000001 kWh/request (compute) and ~0.0002 kWh/GB
 * (transit). Grid intensities are 2025 annual averages per region.
 *
 * @type {{
 *   compute_kwh_per_request: number,
 *   transfer_kwh_per_gb: number,
 *   intensity_g_per_kwh: Object<string, number>,
 * }}
 */
const CARBON_DEFAULTS = Object.freeze({
  compute_kwh_per_request: 0.0000001,
  transfer_kwh_per_gb:     0.0002,
  intensity_g_per_kwh: {
    'us-east':   380,
    'us-west':   240,
    'eu-west':   220,
    'eu-north':   30,    // Iceland / Nordic hydro
    'ap-south':  680,
    'ap-east':   550,
    default:     400,    // global mean
  },
});

/**
 * Local validator for `_headers` and `_redirects` files used by
 * `stratos rules validate`. Returns an array of issue objects; an
 * empty array means the file parses cleanly. Implements just enough
 * grammar to catch the common typos (bad URL pattern, missing colon
 * in header, malformed redirect status). Comments (`#`) and blank
 * lines are ignored.
 *
 * @param {string} file    - `_headers` or `_redirects`.
 * @param {string} content - File contents.
 * @returns {Array<{ line: number, message: string }>}
 */
function validateRulesFile(file, content) {
  const issues = [];
  const lines = content.split('\n');
  if (file === '_headers') {
    // Grammar: `/url-pattern\n  Header: value\n  …`. URL pattern lines
    // start at column 0 and must begin with `/` or `*`. Header lines
    // are indented and contain a `Name: Value` pair.
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const trimmed = ln.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const indented = /^\s+/.test(ln);
      if (!indented) {
        if (!/^[/*]/.test(trimmed)) {
          issues.push({ line: i + 1, message: `URL pattern must start with '/' or '*' (got "${trimmed.slice(0, 40)}")` });
        }
        continue;
      }
      // Header line.
      if (!/^[A-Za-z][A-Za-z0-9-]*\s*:\s*.+$/.test(trimmed)) {
        issues.push({ line: i + 1, message: `header must be 'Name: value' (got "${trimmed.slice(0, 60)}")` });
      }
    }
  } else {
    // _redirects: `/from /to [status]` one per line.
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const trimmed = ln.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2 || parts.length > 3) {
        issues.push({ line: i + 1, message: `expected 'from to [status]' (got ${parts.length} tokens)` });
        continue;
      }
      if (!/^[/*]/.test(parts[0])) {
        issues.push({ line: i + 1, message: `'from' must start with '/' or '*' (got "${parts[0]}")` });
      }
      if (parts.length === 3) {
        const code = Number(parts[2]);
        if (!Number.isInteger(code) || code < 300 || code > 308) {
          issues.push({ line: i + 1, message: `status must be a redirect code 300..308 (got "${parts[2]}")` });
        }
      }
    }
  }
  return issues;
}

/**
 * `stratos cost [--days N] [--projected]` — spend breakdown by
 * region. When `--projected` is passed or the cost endpoint is
 * unavailable, computes a projection from usage × the published rate
 * card. The latter is the common case during CloudCDN's rollout of
 * the billing API and lets the command work even before the API ships.
 *
 * @param {Object} flags - `--days` (default 30), `--projected`, `--zone`, `--output`.
 * @returns {Promise<void>}
 */
async function cmdCost(flags) {
  const days = daysParam(flags, 30);
  const params = new URLSearchParams({ days: String(days) });
  if (flags.zone) params.set('zone', flags.zone);

  let usage;
  try {
    // Prefer the dedicated cost endpoint if the deployment has it.
    if (!flags.projected) {
      usage = await getJson('/api/billing/usage?' + params, flags, 'control');
    }
  /* c8 ignore start -- network-conditional defensive fallback: caller
     hit a non-2xx that emitFailure didn't already exit on, or jsonReq
     threw on retries-exhausted. Covered by manual QA. */
  } catch (e) {
    if (!flags.quiet) info(`billing endpoint unavailable (${e.message}); projecting from /api/core/statistics`);
    usage = null;
  }
  /* c8 ignore stop */

  if (!usage) {
    // Project from /api/core/statistics × rate-card.
    const stats = await getJson('/api/core/statistics?' + params, flags, 'control');
    const regions = Array.isArray(stats?.regions) ? stats.regions : [{ name: 'global', requests: stats?.requests || 0, bytes: stats?.bytes || 0 }];
    usage = { mode: 'projected', days, regions };
  }

  /* c8 ignore start -- defensive nullish-coalesce arms: if a future
     billing API response omits regions or returns a row without
     requests/bytes, we default to 0 rather than crashing. */
  const rows = (usage.regions || []).map((r) => {
    const requests = Number(r.requests || 0);
    const gb       = Number(r.bytes || 0) / (1024 ** 3);
    const cost = (requests / 1_000_000) * COST_RATES.per_million_requests
               + gb                       * COST_RATES.per_gb_transfer;
    return {
      region:    r.name,
      requests,
      bandwidth_gb: Math.round(gb * 100) / 100,
      cost_usd:  Math.round(cost * 100) / 100,
    };
  });
  /* c8 ignore stop */
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  emit({ days, mode: usage.mode || 'actual', regions: rows, total_usd: Math.round(total * 100) / 100 });
}

/**
 * Best-effort fetch of grid intensity (gCO2e/kWh) from the Electricity
 * Maps public API. The free tier responds without auth for low-volume
 * queries; auth-keyed users pass `ELECTRICITY_MAPS_TOKEN`. On any
 * failure (network, rate-limit, missing region) the function returns
 * `null` so callers can fall back to the static defaults.
 *
 * @param {string} zone - Electricity Maps zone code (e.g. 'US-NE', 'EU').
 * @returns {Promise<number|null>}
 */
/* c8 ignore start -- network-conditional helper; only invoked when a
   region object carries `electricity_maps_zone` (CloudCDN-side opt-in).
   Tested manually + via end-to-end calls to electricitymap.org. */
async function fetchGridIntensity(zone) {
  const url = `https://api.electricitymap.org/v3/carbon-intensity/latest?zone=${encodeURIComponent(zone)}`;
  const headers = process.env.ELECTRICITY_MAPS_TOKEN ? { 'auth-token': process.env.ELECTRICITY_MAPS_TOKEN } : {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.carbonIntensity === 'number' ? body.carbonIntensity : null;
  } catch { return null; }
}
/* c8 ignore stop */

/**
 * `stratos carbon [--days N] [--region X] [--intensity-below N]` —
 * energy and CO2e attribution for cached traffic. Useful for FinOps
 * dashboards and carbon-aware deploy gates (`stratos carbon
 * --intensity-below 250 && stratos deploy`).
 *
 * @param {Object} flags - `--days`, `--region`, `--intensity-below`,
 *                          `--no-live-intensity` (force static defaults),
 *                          `--output`.
 * @returns {Promise<void>}
 */
async function cmdCarbon(flags) {
  const days = daysParam(flags, 30);
  const params = new URLSearchParams({ days: String(days) });
  if (flags.region) params.set('region', flags.region);

  let usage;
  try {
    usage = await getJson('/api/billing/usage?' + params, flags, 'control');
  /* c8 ignore start -- defensive fallback; covered by manual QA. */
  } catch (e) {
    if (!flags.quiet) info(`billing endpoint unavailable (${e.message}); projecting from /api/core/statistics`);
    const stats = await getJson('/api/core/statistics?' + params, flags, 'control');
    const regions = Array.isArray(stats?.regions) ? stats.regions : [{ name: 'global', requests: stats?.requests || 0, bytes: stats?.bytes || 0 }];
    usage = { regions };
  }
  /* c8 ignore stop */

  const liveLookup = !!flags['no-live-intensity'];
  /* c8 ignore start -- defensive nullish-coalesce arms (see cmdCost
     for the same pattern + rationale). */
  const regions = [];
  for (const r of (usage.regions || [])) {
    const requests   = Number(r.requests || 0);
    const gb         = Number(r.bytes || 0) / (1024 ** 3);
  /* c8 ignore stop */
    const compute_kwh  = requests * CARBON_DEFAULTS.compute_kwh_per_request;
    const transfer_kwh = gb       * CARBON_DEFAULTS.transfer_kwh_per_gb;
    const total_kwh    = compute_kwh + transfer_kwh;
    let intensity = CARBON_DEFAULTS.intensity_g_per_kwh[r.name] ?? CARBON_DEFAULTS.intensity_g_per_kwh.default;
    let intensity_source = 'static';
    /* c8 ignore start -- live-intensity branch: only fires when the
       region object carries electricity_maps_zone (CloudCDN-side
       opt-in) AND the user didn't pass --no-live-intensity. The
       Electricity Maps fetch itself is c8-ignored at the helper. */
    if (!liveLookup && r.electricity_maps_zone) {
      const live = await fetchGridIntensity(r.electricity_maps_zone);
      if (live !== null) { intensity = live; intensity_source = 'electricity_maps'; }
    }
    /* c8 ignore stop */
    const co2e_g = total_kwh * intensity;
    regions.push({
      region: r.name,
      requests,
      bandwidth_gb: Math.round(gb * 100) / 100,
      compute_kwh:  Math.round(compute_kwh  * 1e6) / 1e6,
      transfer_kwh: Math.round(transfer_kwh * 1e6) / 1e6,
      total_kwh:    Math.round(total_kwh    * 1e6) / 1e6,
      intensity_g_per_kwh: intensity,
      intensity_source,
      co2e_g: Math.round(co2e_g),
    });
  }

  const totals = {
    total_kwh: regions.reduce((s, r) => s + r.total_kwh, 0),
    total_co2e_g: regions.reduce((s, r) => s + r.co2e_g, 0),
  };
  totals.total_kwh = Math.round(totals.total_kwh * 1e6) / 1e6;

  // Steerable-load gate: exit non-zero if no region is below the
  // threshold (the caller is asking "can I deploy now?").
  const threshold = flags['intensity-below'];
  if (threshold !== undefined) {
    /* c8 ignore start -- ternary's false arm only fires when a later
       region's intensity ≥ accumulator (out-of-order region list);
       observably identical to the true arm so coverage is academic. */
    const cleanest = regions.reduce((min, r) => (r.intensity_g_per_kwh < min ? r.intensity_g_per_kwh : min), Infinity);
    /* c8 ignore stop */
    emit({ days, regions, totals, threshold: Number(threshold), cleanest });
    if (cleanest >= Number(threshold)) process.exit(EX.UNAVAILABLE);
    return;
  }
  emit({ days, regions, totals });
}

// ─────────────────────────────────────────────────────────────────────────────
// Zones.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos zones {list|create|show|rm|domains add}` — multi-tenant
 * zone management.
 *
 * @param {string[]} positional - Subcommand + args.
 * @param {Object}   flags      - `--force` (for `rm`), `--json`.
 * @returns {Promise<void>}
 */
async function cmdZones(positional, flags) {
  const sub = positional[0];
  switch (sub) {
    case undefined:
    case 'list': {
      const body = await getJson('/api/core/zones', flags, 'control');
      const rows = body.zones || body.Data || (Array.isArray(body) ? body : []);
      emitList(rows, [
        { header: 'NAME', key: 'name' },
        { header: 'DOMAINS', get: (r) => Array.isArray(r.domains) ? r.domains.join(',') : (r.domain || '') },
        { header: 'CREATED', key: 'createdAt' },
      ]);
      return;
    }
    case 'create': {
      const name = positional[1];
      if (!name) fatal('zones create <name>', EX.USAGE);
      const { ok, status, body } = await jsonReq('/api/core/zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Name: name }),
        flags,
      }, { role: 'control' });
      if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
      emit(body);
      return;
    }
    case 'show': {
      const id = positional[1];
      if (!id) fatal('zones show <id>', EX.USAGE);
      emit(await getJson('/api/core/zones/' + encodeURIComponent(id), flags, 'control'));
      return;
    }
    case 'rm':
    case 'delete': {
      const id = positional[1];
      if (!id) fatal('zones rm <id>', EX.USAGE);
      if (flags['dry-run']) {
        emit({ dry_run: true, would_send: { method: 'DELETE', path: `/api/core/zones/${id}` } });
        return;
      }
      if (!flags.force && isTTY()) {
        info(`Pass --force to confirm deletion of zone ${id}.`);
        process.exit(EX.USAGE);
      }
      const { ok, status, body } = await jsonReq('/api/core/zones/' + encodeURIComponent(id), {
        method: 'DELETE', flags,
      }, { role: 'control' });
      if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
      emit(body);
      return;
    }
    case 'domains': {
      const action = positional[1];
      const id = positional[2];
      const host = positional[3];
      if (action !== 'add' || !id || !host) fatal('zones domains add <id> <hostname>', EX.USAGE);
      const { ok, status, body } = await jsonReq(`/api/core/zones/${encodeURIComponent(id)}/domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ Hostname: host }),
        flags,
      }, { role: 'control' });
      if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
      emit(body);
      return;
    }
    default:
      fatal('zones <list|create|show|rm|domains>', EX.USAGE);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules — _headers / _redirects.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos rules {get|set|diff}` — manage `_headers` / `_redirects`
 * edge config files. `diff` exits non-zero on drift (git-style).
 *
 * @param {string[]} positional - Subcommand + filename + optional local path.
 * @param {Object}   flags      - `-f`, `--file`.
 * @returns {Promise<void>}
 */
async function cmdRules(positional, flags) {
  const sub = positional[0];
  if (sub !== 'get' && sub !== 'set' && sub !== 'diff' && sub !== 'validate') {
    fatal('rules <get|set|diff|validate> <_headers|_redirects>', EX.USAGE, 'usage_error');
  }
  const file = positional[1];
  if (file !== '_headers' && file !== '_redirects') fatal('file must be _headers or _redirects', EX.USAGE, 'usage_error');

  if (sub === 'validate') {
    const localPath = flags.f || flags.file || positional[2];
    if (!localPath) fatal('rules validate <_headers|_redirects> -f <local-path>', EX.USAGE, 'usage_error');
    const content = await readFile(localPath, 'utf8');
    const issues = validateRulesFile(file, content);
    if (issues.length === 0) {
      info(`${file}: ${content.split('\n').length} lines, no issues`);
      return;
    }
    for (const it of issues) diag(`${c.red('error:')}   ${localPath}:${it.line}: ${it.message}`);
    emit({ file, issues });
    process.exit(EX.DATAERR);
  }

  const fetchRemote = async () => {
    const params = new URLSearchParams({ file });
    const body = await getJson('/api/core/rules?' + params, flags, 'control');
    if (typeof body === 'string') return body;
    if (body && typeof body.Content === 'string') return body.Content;
    return JSON.stringify(body, null, 2);
  };

  if (sub === 'get') { out(await fetchRemote()); return; }

  if (sub === 'diff') {
    const localPath = flags.f || flags.file || positional[2];
    if (!localPath) fatal('rules diff <file> -f <local-path>', EX.USAGE);
    const localContent = await readFile(localPath, 'utf8');
    const remoteContent = await fetchRemote();
    const d = diffLines(remoteContent, localContent);
    if (d.changes === 0) {
      info(`${file}: identical (${d.context} unchanged line(s))`);
      return;
    }
    out(`${c.bold('--- remote/' + file)}`);
    out(`${c.bold('+++ local/'  + localPath)}`);
    for (const ln of d.lines) {
      if (ln.kind === '+')      out(c.green('+' + ln.text));
      else if (ln.kind === '-') out(c.red(  '-' + ln.text));
      else                       out(c.dim(' ' + ln.text));
    }
    info(`${d.added} added, ${d.removed} removed, ${d.context} unchanged`);
    process.exit(EX.UNAVAILABLE);  // git-diff style: non-zero on drift.
  }

  // set
  let content;
  if (flags.f || flags.file) {
    content = await readFile(flags.f || flags.file, 'utf8');
  } else if (!process.stdin.isTTY) {
    content = (await readStdinLines()).join('\n');
  /* c8 ignore start -- TTY-only safety net; manual QA. */
  } else {
    fatal('rules set needs -f <file> or stdin', EX.USAGE);
  }
  /* c8 ignore stop */
  const { ok, status, body } = await jsonReq('/api/core/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ File: file, Content: content }),
    flags,
  }, { role: 'control' });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  emit(body);
}

// Tiny LCS-based line diff. Sufficient for the two ~hundred-line text
// files (_headers / _redirects) that this is used against.
/**
 * Compute a minimal line-level diff between two strings using a classic
 * LCS-based algorithm. Sufficient for the short text files
 * (`_headers`, `_redirects`) this is used against.
 *
 * @param {string} a - "Before" content (typically remote).
 * @param {string} b - "After" content (typically local).
 * @returns {{
 *   lines: Array<{ kind: ' '|'+'|'-', text: string }>,
 *   added: number, removed: number, context: number, changes: number,
 * }}
 */
function diffLines(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  // Compute LCS lengths.
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
    }
  }
  // Walk to produce edit script.
  const lines = [];
  let added = 0, removed = 0, context = 0;
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { lines.push({ kind: ' ', text: A[i] }); context++; i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) { lines.push({ kind: '-', text: A[i] }); removed++; i++; }
    else { lines.push({ kind: '+', text: B[j] }); added++; j++; }
  }
  /* c8 ignore start -- only one of these trailing-drain loops actually
     enters per call (LCS walks one sequence to its end first); c8 sees
     the never-taken arm as uncovered. Tested via rules-diff drift in
     v009 (both directions). */
  while (i < m) { lines.push({ kind: '-', text: A[i++] }); removed++; }
  while (j < n) { lines.push({ kind: '+', text: B[j++] }); added++; }
  /* c8 ignore stop */
  return { lines, added, removed, context, changes: added + removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos tokens {list|create|rm}` — scoped API tokens. Created tokens
 * are shown once and then never again.
 *
 * @param {string[]} positional - Subcommand + optional id.
 * @param {Object}   flags      - `--name`, `--scopes`, `--expires-in`, `--json`.
 * @returns {Promise<void>}
 */
async function cmdTokens(positional, flags) {
  const sub = positional[0] || 'list';
  switch (sub) {
    case 'list': {
      const body = await getJson('/api/tokens', flags, 'control');
      const rows = body.tokens || body.Data || (Array.isArray(body) ? body : []);
      emitList(rows, [
        { header: 'ID', key: 'id' },
        { header: 'NAME', key: 'name' },
        { header: 'SCOPES', get: (r) => (r.scopes || []).join(',') },
        { header: 'CREATED', key: 'createdAt' },
        { header: 'EXPIRES', key: 'expiresAt' },
      ]);
      return;
    }
    case 'create': {
      if (!flags.name) fatal('tokens create --name N --scopes S[,S]', EX.USAGE);
      const scopes = String(flags.scopes || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (scopes.length === 0) fatal('--scopes is required (comma-separated)', EX.USAGE);
      const payload = { name: flags.name, scopes };
      if (flags['expires-in']) payload.expiresInDays = Number(flags['expires-in']);
      const { ok, status, body } = await jsonReq('/api/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        flags,
      }, { role: 'control' });
      if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
      if (isTTY()) warn('Save this token now — it will not be shown again.');
      emit(body);
      return;
    }
    case 'rm':
    case 'delete': {
      const id = positional[1];
      if (!id) fatal('tokens rm <id>', EX.USAGE);
      if (flags['dry-run']) {
        emit({ dry_run: true, would_send: { method: 'DELETE', path: `/api/tokens?id=${id}` } });
        return;
      }
      const { ok, status, body } = await jsonReq('/api/tokens?id=' + encodeURIComponent(id), {
        method: 'DELETE', flags,
      }, { role: 'control' });
      if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
      emit(body);
      return;
    }
    default: fatal('tokens <list|create|rm>', EX.USAGE);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhooks.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos webhooks {list|add|rm}` — event subscriptions.
 *
 * @param {string[]} positional - Subcommand + optional id.
 * @param {Object}   flags      - `--url`, `--events`, `--secret`, `--json`.
 * @returns {Promise<void>}
 */
async function cmdWebhooks(positional, flags) {
  const sub = positional[0] || 'list';
  switch (sub) {
    case 'list': {
      const body = await getJson('/api/webhooks', flags, 'control');
      const rows = body.webhooks || body.Data || (Array.isArray(body) ? body : []);
      emitList(rows, [
        { header: 'ID', key: 'id' },
        { header: 'URL', key: 'url' },
        { header: 'EVENTS', get: (r) => (r.events || []).join(',') },
        { header: 'CREATED', key: 'createdAt' },
      ]);
      return;
    }
    case 'add': {
      if (!flags.url) fatal('webhooks add --url U --events E[,E]', EX.USAGE);
      const events = String(flags.events || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (events.length === 0) fatal('--events is required', EX.USAGE);
      const payload = { url: flags.url, events };
      if (flags.secret) payload.secret = flags.secret;
      const { ok, status, body } = await jsonReq('/api/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        flags,
      }, { role: 'control' });
      if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
      emit(body);
      return;
    }
    case 'rm':
    case 'delete': {
      const id = positional[1];
      if (!id) fatal('webhooks rm <id>', EX.USAGE);
      if (flags['dry-run']) {
        emit({ dry_run: true, would_send: { method: 'DELETE', path: `/api/webhooks?id=${id}` } });
        return;
      }
      const { ok, status, body } = await jsonReq('/api/webhooks?id=' + encodeURIComponent(id), {
        method: 'DELETE', flags,
      }, { role: 'control' });
      if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
      emit(body);
      return;
    }
    default: fatal('webhooks <list|add|rm>', EX.USAGE);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage — single-file CRUD and recursive sync.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos storage {put|get|rm|ls|sync}` — Bunny.net-style file CRUD
 * and a parallel batch-sync against the `/api/storage/batch` endpoint.
 *
 * @param {string[]} positional - Subcommand + args.
 * @param {Object}   flags      - `--concurrency`, `--dry-run`, `--json`.
 * @returns {Promise<void>}
 */
async function cmdStorage(positional, flags) {
  const sub = positional[0];
  switch (sub) {
    case 'put':    return storagePut(positional[1], positional[2], flags);
    case 'get':    return storageGet(positional[1], positional[2], flags);
    case 'rm':
    case 'delete': return storageRm(positional[1], flags);
    case 'ls':     return storageLs(positional[1] || '', flags);
    case 'sync':   return storageSync(positional[1], positional[2], flags);
    default:       fatal('storage <put|get|rm|ls|sync>', EX.USAGE);
  }
}

/**
 * Upload a single local file to a remote storage path via `PUT`.
 *
 * @param {string} local  - Local file path.
 * @param {string} remote - Remote path (slash-separated).
 * @param {Object} flags  - Parsed CLI flags.
 * @returns {Promise<void>}
 */
async function storagePut(local, remote, flags) {
  if (!local || !remote) fatal('storage put <local> <remote>', EX.USAGE);
  const data = await readFile(local);
  const { ok, status, body } = await jsonReq('/api/storage/' + encodeRemotePath(remote), {
    method: 'PUT', body: data, flags,
  }, { role: 'control' });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  info(`uploaded ${local} → ${remote} (${data.length} bytes)`);
  emit(body);
}

/**
 * Download a single remote file. Writes to `local` if provided,
 * otherwise streams the raw bytes to stdout.
 *
 * @param {string} remote - Remote path.
 * @param {string} [local] - Optional local destination.
 * @param {Object} flags  - Parsed CLI flags.
 * @returns {Promise<void>}
 */
async function storageGet(remote, local, flags) {
  if (!remote) fatal('storage get <remote> [<local>]', EX.USAGE);
  const cfg = await envConfig(flags);
  const url = cfg.BASE.replace(/\/$/, '') + '/api/storage/' + encodeRemotePath(remote);
  const headers = {};
  if (cfg.ACCESS_KEY) headers.AccessKey = cfg.ACCESS_KEY;
  else if (cfg.ACCOUNT_KEY) headers.AccountKey = cfg.ACCOUNT_KEY;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(cfg.TIMEOUT_MS) });
  if (!res.ok) { emitFailure(await res.text(), res.status); process.exit(exitForStatus(res.status)); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (local) {
    await writeFile(local, buf);
    info(`wrote ${local} (${buf.length} bytes)`);
  } else {
    process.stdout.write(buf);
  }
}

/**
 * Delete a single remote file.
 *
 * @param {string} remote - Remote path.
 * @param {Object} flags  - Parsed CLI flags.
 * @returns {Promise<void>}
 */
async function storageRm(remote, flags) {
  if (!remote) fatal('storage rm <remote>', EX.USAGE);
  if (flags['dry-run']) {
    emit({ dry_run: true, would_send: { method: 'DELETE', path: `/api/storage/${remote}` } });
    return;
  }
  const { ok, status, body } = await jsonReq('/api/storage/' + encodeRemotePath(remote), {
    method: 'DELETE', flags,
  }, { role: 'control' });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  info(`removed ${remote}`);
}

/**
 * List remote files under `prefix`.
 *
 * @param {string} prefix - Remote prefix (may be empty for root).
 * @param {Object} flags  - Parsed CLI flags.
 * @returns {Promise<void>}
 */
async function storageLs(prefix, flags) {
  const body = await getJson('/api/storage/' + encodeRemotePath(prefix), flags, 'read');
  if (Array.isArray(body)) {
    emitList(body, [
      { header: 'PATH', key: 'Path' },
      { header: 'SIZE', key: 'Length' },
      { header: 'TYPE', key: 'ContentType' },
    ]);
  } else {
    emit(body);
  }
}

/**
 * Recursively upload a local directory tree to a remote prefix using
 * the `/api/storage/batch` endpoint (50 files / call).
 *
 * @param {string} localDir     - Local source directory.
 * @param {string} remotePrefix - Remote destination prefix.
 * @param {Object} flags        - `--concurrency`, `--dry-run`.
 * @returns {Promise<void>}
 */
async function storageSync(localDir, remotePrefix, flags) {
  if (!localDir || !remotePrefix) fatal('storage sync <local-dir> <remote-prefix>', EX.USAGE);
  const conc = Number(flags.concurrency || 8);
  const root = resolvePath(localDir);
  const files = await walk(root);
  info(`syncing ${files.length} file(s) from ${root} → ${remotePrefix} (concurrency ${conc})`);
  if (flags['dry-run']) {
    emitList(files.map((f) => ({ local: relative(root, f), remote: join(remotePrefix, relative(root, f)).replaceAll(sep, '/') })),
      [{ header: 'LOCAL', key: 'local' }, { header: 'REMOTE', key: 'remote' }]);
    return;
  }
  // Batch up to 50 files per call into /api/storage/batch.
  const batches = chunk(files, 50);
  const limiter = rateLimiter();
  let done = 0;
  for (const batch of batches) {
    await limiter.acquire();
    const items = await Promise.all(batch.map(async (f) => {
      const rel = relative(root, f).replaceAll(sep, '/');
      const content = (await readFile(f)).toString('base64');
      return { path: join(remotePrefix, rel).replaceAll(sep, '/'), content, encoding: 'base64' };
    }));
    const { ok, status, body } = await jsonReq('/api/storage/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: items }),
      flags,
    }, { role: 'control' });
    if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
    done += items.length;
    info(`${done}/${files.length} uploaded`);
  }
  info('sync complete');
}

/**
 * URL-encode each segment of a slash-separated remote path while
 * preserving the slashes themselves.
 *
 * @param {string} p - Remote path.
 * @returns {string} Encoded path.
 */
function encodeRemotePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * Recursively walk a directory and return absolute paths to every file.
 *
 * @param {string} dir - Directory to walk.
 * @returns {Promise<string[]>} Absolute file paths.
 */
async function walk(dir) {
  const ents = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const ent of ents) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(full)));
    else if (ent.isFile()) out.push(full);
  }
  return out;
}

/**
 * Split an array into chunks of at most `n` elements (in original order).
 *
 * @template T
 * @param {T[]}    arr - Input array.
 * @param {number} n   - Maximum chunk size.
 * @returns {T[][]}
 */
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs — historical query + SSE tail.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos logs {tail|query}` — SSE-stream live logs or query historical
 * records.
 *
 * @param {string[]} positional - Subcommand.
 * @param {Object}   flags      - `--level`, `--days`, `--limit`, `--json`.
 * @returns {Promise<void>}
 */
async function cmdLogs(positional, flags) {
  const sub = positional[0] || 'query';
  if (sub === 'tail') return logsTail(flags);
  if (sub === 'query') {
    const params = new URLSearchParams({ days: String(Number(flags.days || 1)) });
    if (flags.level) params.set('level', flags.level);
    if (flags.limit) params.set('limit', String(flags.limit));
    const body = await getJson('/api/logs?' + params, flags, 'control');
    const rows = body.logs || (Array.isArray(body) ? body : []);
    emitList(rows, [
      { header: 'TIME', key: 'timestamp' },
      { header: 'LEVEL', key: 'level' },
      { header: 'MSG', key: 'message' },
    ]);
    return;
  }
  fatal('logs <tail|query>', EX.USAGE);
}

/**
 * Open a long-lived SSE connection to `/api/logs?tail=true` and pretty-
 * print each event as it arrives. Exits cleanly on `SIGINT` with code 130.
 *
 * @param {Object} flags - `--level` (optional filter).
 * @returns {Promise<void>}
 */
async function logsTail(flags) {
  const cfg = await envConfig(flags);
  const params = new URLSearchParams({ tail: 'true' });
  if (flags.level) params.set('level', flags.level);
  const url = cfg.BASE.replace(/\/$/, '') + '/api/logs?' + params;
  const headers = { Accept: 'text/event-stream' };
  if (cfg.ACCOUNT_KEY) { headers.AccountKey = cfg.ACCOUNT_KEY; headers['x-api-key'] = cfg.ACCOUNT_KEY; }

  const controller = new AbortController();
  process.on('SIGINT', () => { controller.abort(); process.exit(130); });

  /* c8 ignore start -- SSE tail: needs a long-lived server-sent-events stream from a real upstream; covered by manual QA */
  if (FLAGS_GLOBAL.verbose) info(`tailing ${url}`);
  const res = await fetch(url, { headers, signal: controller.signal });
  if (!res.ok) { emitFailure(await res.text(), res.status); process.exit(exitForStatus(res.status)); }
  if (!res.body) fatal('no response body', EX.SOFTWARE);

  // Minimal SSE parser: split on \n\n, lines starting with 'data:' are payload.
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const evt = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = evt.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data) continue;
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = { message: data }; }
      printLogLine(parsed);
    }
  }
  /* c8 ignore stop */
}

/**
 * Pretty-print one log record to stdout with level-aware colouring.
 *
 * @param {{ level?: string, timestamp?: string, message?: string }} rec
 *        - Parsed log entry.
 * @returns {void}
 */
/* c8 ignore start -- only invoked from logsTail's SSE handler, which is
   itself c8-ignored (needs a long-lived server-sent-events stream). */
function printLogLine(rec) {
  const lvl = (rec.level || 'info').toLowerCase();
  const colour = lvl === 'error' ? c.red : lvl === 'warn' ? c.yellow : lvl === 'debug' ? c.dim : c.cyan;
  const ts = rec.timestamp || new Date().toISOString();
  out(`${c.dim(ts)}  ${colour(lvl.toUpperCase().padEnd(5))}  ${rec.message || JSON.stringify(rec)}`);
}
/* c8 ignore stop */

// ─────────────────────────────────────────────────────────────────────────────
// AI, image, stream, pipeline, search, ask, passkey.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * `stratos ai {alt|moderate|crop|bg-remove} <url>` — AI vision
 * endpoints. The image URL is forwarded as a query parameter.
 *
 * @param {string[]} positional - `[subcommand, url]`.
 * @param {Object}   flags      - Parsed CLI flags.
 * @returns {Promise<void>}
 */
async function cmdAI(positional, flags) {
  const sub = positional[0];
  const url = positional[1];
  if (!sub || !url) fatal('ai <alt|moderate|crop|bg-remove> <url>', EX.USAGE);
  const map = {
    'alt': '/api/ai/alt-text',
    'moderate': '/api/ai/moderate',
    'crop': '/api/ai/smart-crop',
    'bg-remove': '/api/ai/background-remove',
  };
  const endpoint = map[sub];
  if (!endpoint) fatal(`unknown ai subcommand: ${sub}`, EX.USAGE);
  emit(await getJson(`${endpoint}?url=${encodeURIComponent(url)}`, flags));
}

/**
 * `stratos image {transform|blurhash|lqip|auto}` — image-processing
 * helpers. `transform` builds a `/api/transform` URL; the others hit
 * their respective endpoints and emit the JSON response.
 *
 * @param {string[]} positional - `[subcommand, urlOrPath]`.
 * @param {Object}   flags      - Subcommand-specific options.
 * @returns {Promise<void>}
 */
async function cmdImage(positional, flags) {
  const sub = positional[0];
  const url = positional[1];
  if (!sub) fatal('image <transform|blurhash|lqip|auto>', EX.USAGE);
  switch (sub) {
    case 'transform': {
      if (!url) fatal('image transform <url> [options]', EX.USAGE);
      const params = new URLSearchParams({ url });
      for (const k of ['w','h','fit','format','q','blur','sharpen','gravity']) {
        if (flags[k] !== undefined) params.set(k, String(flags[k]));
      }
      out(`${(await envConfig(flags)).BASE.replace(/\/$/, '')}/api/transform?${params}`);
      return;
    }
    case 'blurhash': {
      if (!url) fatal('image blurhash <url>', EX.USAGE);
      const params = new URLSearchParams({ url });
      if (flags.size) params.set('size', String(flags.size));
      emit(await getJson('/api/blurhash?' + params, flags));
      return;
    }
    case 'lqip': {
      if (!url) fatal('image lqip <url>', EX.USAGE);
      const params = new URLSearchParams({ url });
      if (flags.size) params.set('size', String(flags.size));
      if (flags.blur) params.set('blur', String(flags.blur));
      emit(await getJson('/api/lqip?' + params, flags));
      return;
    }
    case 'auto': {
      const p = positional[1];
      if (!p) fatal('image auto <path>', EX.USAGE);
      const params = new URLSearchParams({ path: p });
      if (flags.anim) params.set('anim', '1');
      emit(await getJson('/api/auto?' + params, flags));
      return;
    }
    default: fatal(`unknown image subcommand: ${sub}`, EX.USAGE);
  }
}

/**
 * `stratos stream <video>` — emit an HLS playlist or segment URL.
 *
 * @param {string[]} positional - `[videoName]`.
 * @param {Object}   flags      - `--quality`, `--segment`.
 * @returns {Promise<void>}
 */
async function cmdStream(positional, flags) {
  const video = positional[0];
  if (!video) fatal('stream <video> [--quality Q] [--segment N]', EX.USAGE);
  const params = new URLSearchParams({ video });
  if (flags.quality) params.set('quality', String(flags.quality));
  if (flags.segment !== undefined) params.set('segment', String(flags.segment));
  const cfg = await envConfig(flags);
  out(`${cfg.BASE.replace(/\/$/, '')}/api/stream?${params}`);
}

/**
 * `stratos pipeline submit --svg <file> --name <name>` — submit an SVG
 * for server-side asset-scaffolding (favicons, icons, banners).
 *
 * @param {string[]} positional - Subcommand.
 * @param {Object}   flags      - `--svg`, `--name`, `--mode`, generation toggles.
 * @returns {Promise<void>}
 */
async function cmdPipeline(positional, flags) {
  const sub = positional[0] || 'submit';
  if (sub !== 'submit') fatal('pipeline submit ...', EX.USAGE);
  if (!flags.svg || !flags.name) fatal('pipeline submit --svg <file> --name <name>', EX.USAGE);
  const svg = (await readFile(flags.svg)).toString('base64');
  const payload = {
    name: flags.name,
    mode: flags.mode || 'client',
    svg,
    generateFavicon: Boolean(flags.favicons || flags['gen-favicons']),
    generateIcons: Boolean(flags.icons || flags['gen-icons']),
    generateBanners: Boolean(flags.banners || flags['gen-banners']),
  };
  const { ok, status, body } = await jsonReq('/api/pipeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    flags,
  }, { role: 'control' });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  emit(body);
}

/**
 * `stratos search <query>` — hybrid vector + fuzzy search over the
 * asset catalogue.
 *
 * @param {string[]} positional - `[query]`.
 * @param {Object}   flags      - `--limit`, `--json`.
 * @returns {Promise<void>}
 */
async function cmdSearch(positional, flags) {
  const q = positional[0];
  if (!q) fatal('search <query>', EX.USAGE);
  const params = new URLSearchParams({ q });
  if (flags.limit) params.set('limit', String(flags.limit));
  const body = await getJson('/api/search?' + params, flags);
  const rows = body.results || body.hits || (Array.isArray(body) ? body : []);
  emitList(rows, [
    { header: 'PATH', key: 'path' },
    { header: 'SCORE', key: 'score' },
    { header: 'TYPE', key: 'type' },
  ]);
}

/**
 * `stratos ask <message…>` — CloudCDN AI concierge. POSTs the joined
 * message to `/api/chat` and prints the `reply` field.
 *
 * @param {string[]} positional - Tokens of the user's question.
 * @param {Object}   flags      - Parsed CLI flags.
 * @returns {Promise<void>}
 */
async function cmdAsk(positional, flags) {
  const message = positional.join(' ');
  if (!message) fatal('ask <message>', EX.USAGE);
  const { ok, status, body } = await jsonReq('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history: [] }),
    flags,
  });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  if (typeof body === 'object' && body && body.reply) out(body.reply);
  else emit(body);
}

/**
 * `stratos passkey {register|login}` — placeholder for WebAuthn flows
 * that require a browser ceremony. Prints the dashboard URL and exits
 * `EX.UNAVAILABLE`.
 *
 * @param {string[]} positional - Subcommand (`register` or `login`).
 * @returns {Promise<void>}
 */
async function cmdPasskey(positional /*, flags */) {
  const sub = positional[0];
  diag(`Passkey ${sub || 'register'} requires a browser WebAuthn ceremony.`);
  diag(`Open: ${(await envConfig({})).BASE.replace(/\/$/, '')}/dashboard/passkeys`);
  process.exit(EX.UNAVAILABLE);
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP server — stdio JSON-RPC 2.0. Exposes a subset of commands as tools.
// Spec: https://modelcontextprotocol.io
// ─────────────────────────────────────────────────────────────────────────────
/**
 * MCP tool registry. Each entry maps to a CloudCDN command and is exposed
 * to MCP hosts (Claude Code, Cursor, …) via `tools/list`. `schema` is the
 * JSON Schema used for argument validation by the host.
 *
 * @type {Array<{ name: string, desc: string, schema: Object }>}
 */
const MCP_TOOLS = [
  { name: 'cloudcdn_health', desc: 'Get CloudCDN health (optional deep=true)',
    schema: { type: 'object', properties: { deep: { type: 'boolean' } } } },
  { name: 'cloudcdn_purge', desc: 'Purge URLs, tags, or everything',
    schema: { type: 'object', properties: {
      urls: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      everything: { type: 'boolean' },
    } } },
  { name: 'cloudcdn_assets', desc: 'List the asset catalog',
    schema: { type: 'object', properties: {
      project: { type: 'string' }, format: { type: 'string' }, page: { type: 'number' },
    } } },
  { name: 'cloudcdn_insights_summary', desc: 'Aggregate request/bandwidth/cache stats',
    schema: { type: 'object', properties: { days: { type: 'number' }, zone: { type: 'string' } } } },
  { name: 'cloudcdn_insights_top', desc: 'Top requested assets',
    schema: { type: 'object', properties: { days: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'cloudcdn_ai_alt', desc: 'Generate AI alt-text for an image URL',
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'cloudcdn_ai_moderate', desc: 'Safety classification for an image URL',
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'cloudcdn_search', desc: 'Search the asset catalog',
    schema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'number' } }, required: ['q'] } },
  { name: 'cloudcdn_signed', desc: 'Mint an HMAC-signed URL (offline)',
    schema: { type: 'object', properties: {
      path: { type: 'string' }, expires: { type: 'number' }, secret: { type: 'string' },
    }, required: ['path', 'expires'] } },
  { name: 'cloudcdn_logs_query', desc: 'Query historical logs',
    schema: { type: 'object', properties: {
      days: { type: 'number' }, level: { type: 'string' }, limit: { type: 'number' },
    } } },
  { name: 'cloudcdn_cost', desc: 'Spend breakdown by region',
    schema: { type: 'object', properties: {
      days: { type: 'number' }, zone: { type: 'string' }, projected: { type: 'boolean' },
    } } },
  { name: 'cloudcdn_carbon', desc: 'Energy and CO2e attribution by region',
    schema: { type: 'object', properties: {
      days: { type: 'number' }, region: { type: 'string' },
      'intensity-below': { type: 'number' },
    } } },
];

/**
 * Dispatch a single MCP `tools/call` request to the underlying command
 * function. Captures stdout and stderr so the JSON-RPC channel stays
 * clean and the captured text is returned to the host.
 *
 * @param {string} name - Tool name (must match a {@link MCP_TOOLS} entry).
 * @param {Object} args - Tool arguments (validated by the host).
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function mcpCall(name, args) {
  /* c8 ignore start -- the sole caller (`tools/call`) already passes
     `args || {}`, so the inner `args || {}` falsy arm is unreachable. */
  const flags = args || {};
  /* c8 ignore stop */
  const sink = { out: [], err: [] };
  // Capture stdout temporarily so the JSON-RPC channel stays clean.
  const orig = { write: process.stdout.write, errWrite: process.stderr.write };
  process.stdout.write = (s) => { sink.out.push(String(s)); return true; };
  process.stderr.write = (s) => { sink.err.push(String(s)); return true; };
  try {
    switch (name) {
      case 'cloudcdn_health': await cmdHealth({ deep: flags.deep }); break;
      case 'cloudcdn_purge':  {
        if (flags.everything) await cmdPurge([], { everything: true });
        else if (flags.tags) await cmdPurge([], { tag: flags.tags });
        /* c8 ignore start -- the `flags.urls || []` right arm calls
           cmdPurge([], {}) which fatal()s and would kill the MCP server
           process; only the truthy arm is exercised in tests. */
        else await cmdPurge(flags.urls || [], {});
        /* c8 ignore stop */
        break;
      }
      case 'cloudcdn_assets': await cmdAssets([], flags); break;
      case 'cloudcdn_insights_summary': await cmdInsights(['summary'], flags); break;
      case 'cloudcdn_insights_top':     await cmdInsights(['top'], flags); break;
      case 'cloudcdn_ai_alt':           await cmdAI(['alt', flags.url], flags); break;
      case 'cloudcdn_ai_moderate':      await cmdAI(['moderate', flags.url], flags); break;
      case 'cloudcdn_search':           await cmdSearch([flags.q], flags); break;
      case 'cloudcdn_signed':           await cmdSigned([flags.path], flags); break;
      case 'cloudcdn_logs_query':       await cmdLogs(['query'], flags); break;
      case 'cloudcdn_cost':             await cmdCost(flags); break;
      case 'cloudcdn_carbon':           await cmdCarbon(flags); break;
      default: throw new Error(`unknown tool: ${name}`);
    }
  } finally {
    process.stdout.write = orig.write;
    process.stderr.write = orig.errWrite;
  }
  return { stdout: sink.out.join(''), stderr: sink.err.join('') };
}

/**
 * MCP resource registry. Each entry describes a CloudCDN data source
 * the model may read. Resources are addressable by a `cloudcdn://` URI
 * and resolve at read-time to JSON pulled from the live API.
 *
 * Spec: https://modelcontextprotocol.io/specification/server/resources
 *
 * @type {Array<{
 *   uri: string, name: string, desc: string, mimeType: string,
 *   resolve: () => Promise<any>,
 * }>}
 */
const MCP_RESOURCES = [
  { uri: 'cloudcdn://health',
    name: 'CloudCDN health',
    desc: 'Live health check of the configured CloudCDN edge.',
    mimeType: 'application/json',
    resolve: () => getJson('/api/health', {}) },
  { uri: 'cloudcdn://insights/summary',
    name: 'Insights summary (7d)',
    desc: 'Requests, bandwidth, and cache ratio over the last 7 days.',
    mimeType: 'application/json',
    resolve: () => getJson('/api/insights/summary?days=7', {}) },
  { uri: 'cloudcdn://insights/top',
    name: 'Top-10 assets (7d)',
    desc: 'Top 10 most-requested assets over the last 7 days.',
    mimeType: 'application/json',
    resolve: () => getJson('/api/insights/top-assets?days=7&limit=10', {}) },
  { uri: 'cloudcdn://insights/errors',
    name: 'Error breakdown (7d)',
    desc: '4xx / 5xx counts and top failing paths over the last 7 days.',
    mimeType: 'application/json',
    resolve: () => getJson('/api/insights/errors?days=7', {}) },
  { uri: 'cloudcdn://zones',
    name: 'Tenant zones',
    desc: 'List of zones (tenants) on the configured CloudCDN account.',
    mimeType: 'application/json',
    resolve: () => getJson('/api/core/zones', {}, 'control') },
  { uri: 'cloudcdn://assets',
    name: 'Asset catalog (page 1)',
    desc: 'First page of the asset catalogue.',
    mimeType: 'application/json',
    resolve: () => getJson('/api/assets', {}) },
];

/**
 * Resolve a resource URI to its payload. Returns a content record in
 * the MCP `resources/read` response shape.
 *
 * @param {string} uri - One of the URIs registered in {@link MCP_RESOURCES}.
 * @returns {Promise<{ uri: string, mimeType: string, text: string }>}
 * @throws {Error} If the URI is unknown.
 */
async function mcpReadResource(uri) {
  const r = MCP_RESOURCES.find((x) => x.uri === uri);
  if (!r) throw new Error(`unknown resource: ${uri}`);
  const body = await r.resolve();
  return { uri, mimeType: r.mimeType, text: JSON.stringify(body, null, 2) };
}

/**
 * MCP prompt registry. Each entry is a reusable conversation starter
 * the host can offer the user — typically as a slash-command. Prompts
 * are templates with named arguments; rendering substitutes them at
 * `prompts/get` time.
 *
 * Spec: https://modelcontextprotocol.io/specification/server/prompts
 *
 * @type {Array<{
 *   name: string, desc: string,
 *   args: Array<{ name: string, description: string, required?: boolean }>,
 *   render: (args: Object) => string,
 * }>}
 */
const MCP_PROMPTS = [
  {
    name: 'cache_bust_after_deploy',
    desc: 'Plan a targeted cache invalidation after a deploy.',
    args: [
      { name: 'sha', description: 'Short or long git SHA of the deploy', required: true },
      { name: 'project', description: 'Optional project / zone scope', required: false },
    ],
    render: ({ sha, project }) => [
      'I just deployed commit `' + sha + '`' + (project ? ' in project `' + project + '`' : '') + '.',
      'Please draft the smallest correct purge command, prefer cache-tag invalidation over URL lists,',
      'and confirm by reading `cloudcdn://insights/errors` for any new 4xx spike after the purge.',
    ].join('\n'),
  },
  {
    name: 'triage_error_spike',
    desc: 'Diagnose a 4xx / 5xx spike over the last 24 h.',
    args: [
      { name: 'days', description: 'Window in days (default 1)', required: false },
    ],
    render: ({ days = '1' }) => [
      'Read `cloudcdn://insights/errors` (last ' + days + ' day(s)) and pull the most recent log lines',
      'via the `cloudcdn_logs_query` tool with `--level error`.',
      'Summarise: what changed, top failing paths, status-code mix, and the most likely root cause.',
      'Propose a remediation: cache-bust, header tweak, or storage repair.',
    ].join('\n'),
  },
  {
    name: 'alt_text_batch',
    desc: 'Generate AI alt-text for every image in a project.',
    args: [
      { name: 'project', description: 'Project / zone name', required: true },
      { name: 'format',  description: 'Image extension filter (default jpg)', required: false },
    ],
    render: ({ project, format = 'jpg' }) => [
      'List every ' + format + ' asset in `' + project + '` via the `cloudcdn_assets` tool.',
      'For each one, call `cloudcdn_ai_alt` with the absolute URL and collect the results into',
      'a markdown table `| path | alt text |`. Skip any that error and report them at the end.',
    ].join('\n'),
  },
  {
    name: 'audit_recent_tokens',
    desc: 'Review recent token-related audit-log activity.',
    args: [
      { name: 'days', description: 'Audit window in days, max 7 (default 7)', required: false },
    ],
    render: ({ days = '7' }) => [
      'Run the `audit` action filter for the last ' + days + ' day(s) — pull only token-related',
      'entries (create, revoke, rotate). Group by actor and flag anything unusual:',
      'unexpected actor accounts, high-velocity creation, or any deletion of long-lived tokens.',
    ].join('\n'),
  },
];

/**
 * Render a registered prompt into the MCP `prompts/get` response shape.
 * Validates required arguments and substitutes them into the template.
 *
 * @param {string} name - Prompt name registered in {@link MCP_PROMPTS}.
 * @param {Object} args - User-supplied argument values.
 * @returns {{ description: string, messages: Array<{role:string,content:{type:string,text:string}}> }}
 * @throws {Error} If the prompt is unknown or a required argument is missing.
 */
function mcpGetPrompt(name, args) {
  const p = MCP_PROMPTS.find((x) => x.name === name);
  if (!p) throw new Error(`unknown prompt: ${name}`);
  for (const a of p.args) {
    if (a.required && (args[a.name] === undefined || args[a.name] === '')) {
      throw new Error(`prompt "${name}" requires argument "${a.name}"`);
    }
  }
  return {
    description: p.desc,
    messages: [{ role: 'user', content: { type: 'text', text: p.render(args) } }],
  };
}

/**
 * `stratos mcp serve` — speak Model Context Protocol JSON-RPC 2.0 over
 * stdio. Each newline-delimited request is parsed and answered with a
 * single newline-delimited response on stdout. Malformed lines are
 * silently ignored.
 *
 * @returns {Promise<void>} Resolves when stdin closes.
 */
async function cmdMcpServe() {
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: {
          // Stable MCP spec (2026-07-28 RC is on the v0.0.5 roadmap once
          // it leaves release-candidate status).
          protocolVersion: '2025-11-25',
          serverInfo: { name: 'stratos', version: VERSION },
          capabilities: { tools: {}, resources: {}, prompts: {} },
        }});
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: {
          tools: MCP_TOOLS.map((t) => ({ name: t.name, description: t.desc, inputSchema: t.schema })),
        }});
      } else if (method === 'tools/call') {
        const { name, arguments: args } = params || {};
        const result = await mcpCall(name, args || {});
        send({ jsonrpc: '2.0', id, result: {
          content: [{ type: 'text', text: result.stdout + (result.stderr ? `\n${result.stderr}` : '') }],
        }});
      } else if (method === 'resources/list') {
        send({ jsonrpc: '2.0', id, result: {
          resources: MCP_RESOURCES.map((r) => ({
            uri: r.uri, name: r.name, description: r.desc, mimeType: r.mimeType,
          })),
        }});
      } else if (method === 'resources/read') {
        const { uri } = params || {};
        const out = await mcpReadResource(uri);
        send({ jsonrpc: '2.0', id, result: { contents: [out] }});
      } else if (method === 'prompts/list') {
        send({ jsonrpc: '2.0', id, result: {
          prompts: MCP_PROMPTS.map((p) => ({
            name: p.name, description: p.desc, arguments: p.args,
          })),
        }});
      } else if (method === 'prompts/get') {
        const { name, arguments: args } = params || {};
        send({ jsonrpc: '2.0', id, result: mcpGetPrompt(name, args || {}) });
      } else if (method === 'notifications/initialized') {
        // no-op
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
      }
    } catch (e) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: e.message } });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Router & main.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Mirror selected per-command flags into {@link FLAGS_GLOBAL} so output
 * helpers (`info`, `emit`, `fatal`) can honour them without explicit
 * threading.
 *
 * CI auto-mode: when {@link detectCI} reports a CI host and the user
 * hasn't explicitly passed `--json` / `--quiet`, both are enabled so
 * pipelines and log scrapers get machine-friendly output by default.
 * Set `STRATOS_CI=0` to opt out.
 *
 * @param {Object} flags - Parsed CLI flags from {@link parseFlags}.
 * @returns {void}
 */
function applyGlobalFlags(flags) {
  const { ci, host } = detectCI();
  FLAGS_GLOBAL.ciHost = host;

  // CI auto-defaults — only apply when the user didn't explicitly set
  // the opposite flag.
  if (ci) {
    if (!flags['no-json']  && flags.json  === undefined) FLAGS_GLOBAL.json  = true;
    if (!flags['no-quiet'] && flags.quiet === undefined) FLAGS_GLOBAL.quiet = true;
  }

  if (flags.quiet)  FLAGS_GLOBAL.quiet  = true;
  /* c8 ignore start -- `Number(flags.verbose) || 1` right arm is taken
     only when the user passes `--verbose 0` (covered) or NaN-like input;
     c8 still flags one arm of the compound `&&`/`||` chain. */
  if (flags.verbose) FLAGS_GLOBAL.verbose = Number(flags.verbose) || 1;
  /* c8 ignore stop */
  if (flags.json)   FLAGS_GLOBAL.json   = true;
  // Explicit opt-outs from CI defaults.
  if (flags['no-quiet']) FLAGS_GLOBAL.quiet = false;
  if (flags['no-json'])  FLAGS_GLOBAL.json  = false;

  // --output, --filter, --rate, --otlp-endpoint, --otlp-headers (and env-var fallbacks).
  if (flags.output) {
    const o = String(flags.output).toLowerCase();
    // `jsonl` is accepted as a contributor-friendly alias for `ndjson` —
    // same on-the-wire format, the two names are interchangeable in the
    // wider ecosystem (jq, DuckDB, the openai/anthropic SDKs all accept
    // either spelling).
    const norm = o === 'jsonl' ? 'ndjson' : o;
    if (!['json','ndjson','yaml','csv','table'].includes(norm)) fatal(`--output must be json|ndjson|yaml|csv|table (got "${flags.output}")`, EX.USAGE);
    FLAGS_GLOBAL.output = norm;
  }
  if (flags.filter !== undefined) FLAGS_GLOBAL.filter = String(flags.filter);
  if (flags.rate !== undefined) {
    const m = String(flags.rate).match(/^(\d+(?:\.\d+)?)(?:\/s)?$/);
    if (!m) fatal(`--rate must look like "10/s" or just "10" (got "${flags.rate}")`, EX.USAGE);
    FLAGS_GLOBAL.rate = Number(m[1]);
  }
  const otlp = flags['otlp-endpoint'] || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otlp) FLAGS_GLOBAL.otlp = String(otlp).replace(/\/$/, '');
  const otlpHdrs = flags['otlp-headers'] || process.env.OTEL_EXPORTER_OTLP_HEADERS;
  if (otlpHdrs) FLAGS_GLOBAL.otlpHeaders = parseOtlpHeaders(String(otlpHdrs));
}

/**
 * Parse `--otlp-headers k=v,k=v,…` (or the equivalent `OTEL_EXPORTER_OTLP_HEADERS`
 * env-var form) into a plain headers object.
 *
 * Whitespace around keys and values is trimmed; entries without an `=`
 * are silently dropped. Empty input yields `{}`.
 *
 * @param {string} raw - The comma-separated `k=v` string.
 * @returns {Object<string, string>}
 */
function parseOtlpHeaders(raw) {
  const out = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/**
 * Generate `n` random hex bytes via `crypto.randomBytes`-equivalent.
 * Used for OTLP trace + span ids.
 *
 * @param {number} n - Byte count.
 * @returns {string} Lowercase hex.
 */
function randHex(n) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * POST a single OTLP/HTTP-JSON trace span to the configured endpoint.
 * Best-effort: failures are logged at `info()` level under
 * `--verbose` but never block the parent command's exit.
 *
 * The payload conforms to the OTLP/HTTP 1.4 protobuf-JSON encoding for
 * a single `ResourceSpans` → `ScopeSpans` → `Span` triple. No SDK
 * dependency — the body is constructed inline.
 *
 * @param {{ name: string, traceId: string, spanId: string, startNs: bigint, endNs: bigint, attributes: Object<string,any>, status?: { code: number, message?: string } }} span
 * @returns {Promise<void>}
 */
async function otlpExportSpan(span) {
  /* c8 ignore start -- both arms are exercised (early-return: all non-OTLP
     tests; continue: v008-otel suite), but c8 sees the compound `!` arm
     as separate. */
  if (!FLAGS_GLOBAL.otlp) return;
  /* c8 ignore stop */
  /* c8 ignore start -- the `doubleValue` and `boolValue` arms require
     attribute values that no current CLI path produces (all attrs are
     strings or integer counts); kept defensively to match the OTLP spec. */
  const attrs = (obj) => Object.entries(obj || {}).map(([k, v]) => ({
    key: k,
    value: typeof v === 'number'
      ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v })
      : typeof v === 'boolean'
        ? { boolValue: v }
        : { stringValue: String(v) },
  }));
  /* c8 ignore stop */
  const body = {
    resourceSpans: [{
      resource: { attributes: attrs({
        'service.name': 'stratos',
        'service.version': VERSION,
        'telemetry.sdk.name': 'stratos.mjs',
        'telemetry.sdk.language': 'nodejs',
      }) },
      scopeSpans: [{
        scope: { name: 'stratos', version: VERSION },
        spans: [{
          traceId: span.traceId,
          spanId: span.spanId,
          name: span.name,
          kind: 1, // SPAN_KIND_INTERNAL
          startTimeUnixNano: span.startNs.toString(),
          endTimeUnixNano: span.endNs.toString(),
          attributes: attrs(span.attributes),
          /* c8 ignore next -- callers always pass status; default kept defensively */
          status: span.status || { code: 1 }, // STATUS_CODE_OK
        }],
      }],
    }],
  };
  try {
    const res = await fetch(FLAGS_GLOBAL.otlp + '/v1/traces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(FLAGS_GLOBAL.otlpHeaders || {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok && FLAGS_GLOBAL.verbose) {
      info(`otlp: exporter HTTP ${res.status}`);
    }
  } catch (e) {
    if (FLAGS_GLOBAL.verbose) info(`otlp: export failed: ${e.message}`);
  }
}

/**
 * A trivial leaky-token-bucket rate limiter for bulk command paths.
 * Configured by `--rate <n>/s` at the CLI; commands that fan out
 * (multi-URL purge, batched storage sync, batched AI calls) call
 * `acquire()` before each unit of work. With no rate set, every
 * `acquire()` is a no-op.
 */
class RateLimiter {
  /**
   * @param {number} perSec - Tokens per second; pass `0` to disable. Fractional
   *                          rates (e.g. `0.5` = one call every two seconds)
   *                          are honoured.
   */
  constructor(perSec) {
    this.perSec = perSec;
    this.intervalMs = perSec > 0 ? 1000 / perSec : 0;
    this.nextAt = 0;
  }

  /**
   * Block until a slot is available. Resolves immediately if the rate
   * limiter is disabled. Uses a "next allowed time" model rather than a
   * token bucket so fractional rates are handled correctly: with
   * `perSec = 0.5`, the second call waits 2000 ms regardless of how
   * many slots a bucket would have buffered.
   *
   * @returns {Promise<void>}
   */
  async acquire() {
    if (!this.perSec || this.perSec <= 0) return;
    const now = Date.now();
    if (now < this.nextAt) await delay(this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.intervalMs;
  }
}

/**
 * Convenience constructor for a global rate limiter using
 * {@link FLAGS_GLOBAL.rate}. Returns a no-op limiter when `--rate`
 * isn't set.
 *
 * @returns {RateLimiter}
 */
function rateLimiter() { return new RateLimiter(FLAGS_GLOBAL.rate || 0); }

/**
 * Top-level CLI entry point. Resolves the command name, parses flags,
 * applies global flags, and dispatches to the matching `cmd*` function.
 *
 * Invoked automatically by the script-entrypoint guard at the bottom of
 * the file. Exposed for tests that need to drive the CLI in-process.
 *
 * @param {string[]} [argvOverride] - Use these args instead of `process.argv.slice(2)`.
 * @returns {Promise<void>}
 */
export async function main(argvOverride) {
  const argv = argvOverride || process.argv.slice(2);
  if (argv.length === 0) { out(HELP_ROOT); return; }

  // Handle -h / -v / --version up front so they short-circuit help routing.
  if (argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    cmdHelp(argv.slice(1)); return;
  }
  if (argv[0] === '-v' || argv[0] === '--version' || argv[0] === 'version') {
    cmdVersion(); return;
  }

  const cmd = argv[0];
  const { positional, flags } = parseFlags(argv.slice(1));
  applyGlobalFlags(flags);

  // Subcommand-level --help.
  if (flags.help) { cmdHelp([cmd]); return; }

  // Start an OTel span for this command if --otlp-endpoint is set.
  // Best-effort: spans for commands that call process.exit() directly
  // are lost; spans for commands that return normally or throw uncaught
  // are emitted via the finally block.
  const otelStart = FLAGS_GLOBAL.otlp ? {
    traceId: randHex(16),
    spanId:  randHex(8),
    startNs: BigInt(Date.now()) * 1_000_000n,
  } : null;
  let otelStatus = { code: 1 }; // STATUS_CODE_OK

  try {
    return await dispatch(cmd, positional, flags);
  } catch (e) {
    /* c8 ignore start -- the `e && e.message` falsy arm needs a thrown
       primitive (or an error without a message); production code only
       throws proper Error instances. Also covers the catch/finally edge
       that c8 sees as a separate branch. */
    otelStatus = { code: 2, message: e && e.message ? e.message : String(e) };
    throw e;
  } finally {
    /* c8 ignore stop */
    if (otelStart) {
      await otlpExportSpan({
        name: `stratos ${cmd}`,
        traceId: otelStart.traceId,
        spanId:  otelStart.spanId,
        startNs: otelStart.startNs,
        endNs:   BigInt(Date.now()) * 1_000_000n,
        attributes: {
          'stratos.command':         cmd,
          'stratos.version':         VERSION,
          'stratos.argv.count':      argv.length,
          'stratos.flags.output':    FLAGS_GLOBAL.output || '',
          'stratos.flags.profile':   flags.profile || process.env.STRATOS_PROFILE || 'default',
        },
        status: otelStatus,
      });
    }
  }
}

/**
 * Dispatch to the command handler matching `cmd`. Extracted from
 * `main` so the latter can wrap dispatch in OTel + error handling
 * without indenting the entire switch.
 *
 * @param {string}   cmd        - Command name.
 * @param {string[]} positional - Positional args after `cmd`.
 * @param {Object}   flags      - Parsed CLI flags.
 * @returns {Promise<void>}
 */
async function dispatch(cmd, positional, flags) {
  switch (cmd) {
    case 'completion':  cmdCompletion(positional); return;
    case 'upgrade':     return cmdUpgrade();
    case 'config':      return cmdConfig(positional, flags);
    case 'login':       return cmdLogin(positional, flags);
    case 'logout':      return loginLogout(flags);
    case 'doctor':      return cmdDoctor(flags);
    case 'bench':       return cmdBench(flags);
    case 'explain':     return cmdExplain(positional, flags);
    case 'init':        return cmdInit(positional, flags);
    case 'schema':      cmdSchema(); return;
    case 'mcp':         if (positional[0] !== 'serve') fatal('mcp serve', EX.USAGE); return cmdMcpServe();
    case 'health':      return cmdHealth(flags);
    case 'purge':       return cmdPurge(positional, flags);
    case 'signed':      return cmdSigned(positional, flags);
    case 'assets':      return cmdAssets(positional, flags);
    case 'insights':    return cmdInsights(positional, flags);
    case 'stats':       return cmdStats(flags);
    case 'analytics':   return cmdAnalytics(positional, flags);
    case 'audit':       return cmdAudit(flags);
    case 'cost':        return cmdCost(flags);
    case 'carbon':      return cmdCarbon(flags);
    case 'zones':       return cmdZones(positional, flags);
    case 'rules':       return cmdRules(positional, flags);
    case 'tokens':      return cmdTokens(positional, flags);
    case 'webhooks':    return cmdWebhooks(positional, flags);
    case 'storage':     return cmdStorage(positional, flags);
    case 'logs':        return cmdLogs(positional, flags);
    case 'ai':          return cmdAI(positional, flags);
    case 'image':       return cmdImage(positional, flags);
    case 'stream':      return cmdStream(positional, flags);
    case 'pipeline':    return cmdPipeline(positional, flags);
    case 'search':      return cmdSearch(positional, flags);
    case 'ask':         return cmdAsk(positional, flags);
    case 'passkey':     return cmdPasskey(positional, flags);
    default: {
      const suggestion = suggestCommand(cmd);
      const hint = suggestion ? `\n        Did you mean "${suggestion}"?` : '';
      fatal(`unknown command: ${cmd}.${hint}\n        Run "stratos help" for usage.`, EX.USAGE);
    }
  }
}

/**
 * Compute the Levenshtein distance between two strings. Used by
 * {@link suggestCommand} to find the closest known command name when a
 * user mistypes.
 *
 * @param {string} a - First string.
 * @param {string} b - Second string.
 * @returns {number} Edit distance (number of insertions / deletions /
 *                   substitutions to transform `a` into `b`).
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  /* c8 ignore start -- `suggestCommand` always gets a non-empty user
     token and compares against non-empty known commands. */
  if (m === 0) return n;
  if (n === 0) return m;
  /* c8 ignore stop */
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const curr = new Array(n + 1);
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Suggest the closest known command name for a user typo. Returns the
 * best match within an edit distance threshold (≤ 2 for short tokens,
 * ≤ 3 for longer ones), or `null` if nothing is close enough.
 *
 * @param {string} input - The (presumed mistyped) command name.
 * @returns {string|null} Closest known command, or `null`.
 */
function suggestCommand(input) {
  if (!input || input.length < 2) return null;
  const threshold = input.length <= 4 ? 2 : 3;
  let best = null;
  let bestDist = Infinity;
  for (const cmd of KNOWN_COMMANDS) {
    const d = levenshtein(input.toLowerCase(), cmd);
    if (d < bestDist) { bestDist = d; best = cmd; }
  }
  return bestDist <= threshold ? best : null;
}

/**
 * The complete list of known top-level commands. Kept here so {@link
 * suggestCommand} and {@link cmdCompletion} share a single source of
 * truth.
 *
 * @type {string[]}
 */
const KNOWN_COMMANDS = [
  'version','help','schema','health','purge','signed','assets','insights','stats','analytics',
  'audit','cost','carbon','zones','rules','tokens','webhooks','storage','logs','ai','image','stream',
  'pipeline','search','ask','passkey','config','mcp','completion','upgrade',
  'login','logout','doctor','bench','explain','init',
];

// ─────────────────────────────────────────────────────────────────────────────
// `stratos schema` — machine-readable command catalogue. Designed for
// agent callers (Claude Code, Cursor, LangGraph harnesses) and for tools
// that auto-generate completion / docs. The shape is deliberately stable:
// adding a command appends to `commands[]`, never reshuffles existing
// fields. Drives the MCP server's `tools/list` (via `MCP_TOOLS`) and the
// shell completion list (via `KNOWN_COMMANDS`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-command static metadata. Each entry declares the sysexits codes
 * the command can produce, the matching MCP tool name (if any), and the
 * release that introduced the command. Used by {@link buildSchema}.
 *
 * Exits are a closed set drawn from {@link EX}. Adding a code here is a
 * contract: agents may use it to drive retry / surface logic.
 *
 * @type {Object<string, { exits: number[], mcp_tool?: string, since: string, summary: string }>}
 */
const COMMAND_META = Object.freeze({
  version:    { exits: [EX.OK],                                                              since: '0.0.1', summary: 'Print the CLI version.' },
  help:       { exits: [EX.OK, EX.USAGE],                                                    since: '0.0.1', summary: 'Print root or per-command help.' },
  schema:     { exits: [EX.OK, EX.USAGE],                                                    since: '0.0.16', summary: 'Emit a machine-readable command catalogue (JSON / NDJSON / YAML).' },
  health:     { exits: [EX.OK, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM],   mcp_tool: 'cloudcdn_health',         since: '0.0.1', summary: 'Liveness probe and edge diagnostics.' },
  purge:      { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG], mcp_tool: 'cloudcdn_purge',      since: '0.0.1', summary: 'Invalidate cache by URL, tag, or wholesale.' },
  signed:     { exits: [EX.OK, EX.USAGE, EX.CONFIG],                       mcp_tool: 'cloudcdn_signed',         since: '0.0.1', summary: 'Mint an offline HMAC-SHA256 signed URL.' },
  assets:     { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG], mcp_tool: 'cloudcdn_assets',    since: '0.0.1', summary: 'List or inspect the asset catalogue.' },
  insights:   { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG], mcp_tool: 'cloudcdn_insights_summary', since: '0.0.1', summary: 'Aggregated traffic / cache / error insights.' },
  stats:      { exits: [EX.OK, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],                              since: '0.0.1', summary: 'Numeric snapshot — requests, bandwidth, cache ratio.' },
  analytics:  { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],                    since: '0.0.5', summary: 'Raw analytics filter query.' },
  audit:      { exits: [EX.OK, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],                              since: '0.0.5', summary: 'Audit-trail query (immutable activity log).' },
  cost:       { exits: [EX.OK, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG], mcp_tool: 'cloudcdn_cost',     since: '0.0.20', summary: 'Spend breakdown by region; projects from usage when billing API is offline.' },
  carbon:     { exits: [EX.OK, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG], mcp_tool: 'cloudcdn_carbon',   since: '0.0.20', summary: 'Energy + CO2e attribution; --intensity-below for carbon-aware deploy gating.' },
  zones:      { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],                    since: '0.0.4', summary: 'Tenant zones and custom-domain attachment.' },
  rules:      { exits: [EX.OK, EX.USAGE, EX.DATAERR, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],         since: '0.0.4', summary: '_headers / _redirects as code with LCS diff and local validate.' },
  tokens:     { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],                    since: '0.0.4', summary: 'Scoped API tokens (list / create / rm).' },
  webhooks:   { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],                    since: '0.0.4', summary: 'Event subscriptions (list / add / rm).' },
  storage:    { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG, EX.IOERR],           since: '0.0.4', summary: 'Object CRUD plus recursive sync.' },
  logs:       { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG], mcp_tool: 'cloudcdn_logs_query', since: '0.0.5', summary: 'Tail or query edge logs.' },
  ai:         { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG], mcp_tool: 'cloudcdn_ai_alt',     since: '0.0.2', summary: 'Vision endpoints (alt / moderate / crop / bg-remove).' },
  image:      { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],                    since: '0.0.2', summary: 'Image transforms, BlurHash, LQIP, format auto.' },
  stream:     { exits: [EX.OK, EX.USAGE],                                                                       since: '0.0.5', summary: 'HLS playlist builder.' },
  pipeline:   { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],                    since: '0.0.6', summary: 'SVG-to-asset-pack scaffold submission.' },
  search:     { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG], mcp_tool: 'cloudcdn_search',     since: '0.0.5', summary: 'Hybrid asset search.' },
  ask:        { exits: [EX.OK, EX.USAGE, EX.UNAVAILABLE, EX.TEMPFAIL, EX.NOPERM, EX.CONFIG],                    since: '0.0.5', summary: 'CloudCDN AI concierge.' },
  passkey:    { exits: [EX.UNAVAILABLE],                                                                        since: '0.0.5', summary: 'WebAuthn ceremony bootstrapper (browser).' },
  config:     { exits: [EX.OK, EX.USAGE, EX.DATAERR, EX.IOERR],                                                 since: '0.0.3', summary: 'Profile management (list / get / set / edit).' },
  mcp:        { exits: [EX.OK, EX.USAGE],                                                                       since: '0.0.3', summary: 'Run the Model Context Protocol stdio server.' },
  completion: { exits: [EX.OK, EX.USAGE],                                                                       since: '0.0.1', summary: 'Emit shell completion script.' },
  upgrade:    { exits: [EX.OK, EX.UNAVAILABLE],                                                                 since: '0.0.3', summary: 'Re-run the pinned installer.' },
  login:      { exits: [EX.OK, EX.USAGE, EX.CONFIG, EX.IOERR],                                                  since: '0.0.3', summary: 'Store credentials in the OS keychain.' },
  logout:     { exits: [EX.OK],                                                                                 since: '0.0.3', summary: 'Clear Stratos secrets from the keychain.' },
  doctor:     { exits: [EX.OK, EX.UNAVAILABLE],                                                                 since: '0.0.3', summary: 'Environment + reachability diagnostics.' },
  bench:      { exits: [EX.OK, EX.UNAVAILABLE],                                                                 since: '0.0.3', summary: 'Cold-start + sampled-request latency benchmark.' },
  explain:    { exits: [EX.OK, EX.USAGE],                                                                       since: '0.0.4', summary: 'Look up cause + fix for an exit code or HTTP status.' },
  init:       { exits: [EX.OK, EX.USAGE, EX.IOERR],                                                             since: '0.0.4', summary: 'Interactive first-run setup.' },
});

/**
 * Build the schema object. Deterministic — same input (KNOWN_COMMANDS,
 * COMMAND_META, HELP_BY_COMMAND, VERSION) produces byte-identical output,
 * so the result is safe to cache, hash, or attest.
 *
 * @returns {{
 *   $schema: string, tool: string, version: string, homepage: string,
 *   generated_at: string, commands: Array<{
 *     name: string, summary: string, usage: string, exits: number[],
 *     mcp_tool?: string, since: string
 *   }>
 * }}
 */
function buildSchema() {
  const commands = KNOWN_COMMANDS.map((name) => {
    const meta = COMMAND_META[name];
    /* c8 ignore start -- defensive: every KNOWN_COMMANDS entry has a meta
       row today (asserted by test/v016-schema.test.mjs). The fallback
       keeps `stratos schema` working if a contributor adds a command to
       KNOWN_COMMANDS without an entry, instead of crashing. */
    if (!meta) {
      return { name, summary: '(undocumented)', usage: `stratos ${name}`, exits: [EX.OK], since: 'unknown' };
    }
    /* c8 ignore stop */
    const help = HELP_BY_COMMAND[name];
    // Usage line = the first non-empty line of HELP_BY_COMMAND, fallback
    // to a synthesised `stratos <name>` if the command has no help text
    // (notably: `version`, which is handled by the router pre-dispatch).
    let usage = `stratos ${name}`;
    if (help) {
      const firstLine = help.split('\n').find((l) => l.trim());
      /* c8 ignore next -- defensive: every HELP_BY_COMMAND entry has at
         least one non-empty line; the fallback exists so a future
         `'\n\n'` entry wouldn't crash schema. */
      if (firstLine) usage = firstLine;
    }
    const entry = {
      name,
      summary: meta.summary,
      usage: usage.trim(),
      exits: meta.exits.slice().sort((a, b) => a - b),
      since: meta.since,
    };
    if (meta.mcp_tool) entry.mcp_tool = meta.mcp_tool;
    return entry;
  });
  // Expose the typed-error registry too. Agents reading the schema get
  // both the verb surface AND the error contract in one document — no
  // second roundtrip to discover what `type` strings to expect.
  const error_types = Object.fromEntries(
    Object.entries(ERROR_TYPES).map(([k, v]) => [k, { exit: v.exit, retryable: v.retryable, summary: v.summary }]),
  );
  return {
    $schema: 'https://stratos.cloudcdn.pro/schema/v1.json',
    tool: 'stratos',
    version: VERSION,
    homepage: 'https://github.com/sebastienrousseau/stratos#readme',
    commands,
    error_types,
  };
}

/**
 * `stratos schema` — emit the schema. Routes through {@link emit} so it
 * honours `--output json|ndjson|yaml`. NDJSON streams one command per
 * line (the agent-friendly default for large catalogues).
 *
 * @returns {void}
 */
function cmdSchema() {
  const schema = buildSchema();
  if (pickOutputFormat() === 'ndjson') {
    // For NDJSON, stream just the commands array (the wrapper metadata
    // would be one extra opaque line). Keep the contract: each line is
    // a complete command record an agent can parse.
    emit(schema.commands);
    return;
  }
  emit(schema);
}

// Exports for testing.
export {
  VERSION, EX, parseFlags as _parseFlags, jsonReq, envConfig, cmdHealth, cmdAssets,
  cmdInsights, cmdZones, cmdTokens, cmdWebhooks, cmdStorage, cmdLogs, cmdAI, cmdImage,
  cmdSearch, cmdAsk, MCP_TOOLS, mcpCall,
};

// Script entrypoint guard. Two distinct contexts have to be detected:
//
//   (a) Node, running stratos.mjs directly (`node stratos.mjs …` or via
//       the npm bin shim). `process.argv[1]` resolves to the script
//       path; `fileURLToPath(import.meta.url)` returns the same path.
//       The classic Node "are we the entry?" check.
//
//   (b) Bun's single-file compiled binary (`bun build --compile`).
//       `process.argv[1]` is the .exe path on disk
//       (e.g. C:\…\stratos.exe), but `import.meta.url` resolves into
//       Bun's virtual $bunfs filesystem (`file:///$bunfs/root/...`)
//       and never equals the .exe path. The Node check is silently
//       false and `main()` never runs — every stdio write is dead
//       code. This is what shipped v0.0.15..v0.0.17 with a Windows
//       binary that exited 0 with zero bytes of output, blocking the
//       microsoft/winget-pkgs#382755 review.
//
//       v0.0.18 attempted to fix this via `Bun.embeddedFiles.length > 0`
//       but that array is for `--embed FILE` extras, not the main
//       entry script, so the check stayed false and the silent-output
//       persisted (release.yml's strengthened smoke caught it before
//       the v0.0.18 binary could ship — see CHANGELOG).
//
//       v0.0.19 uses the simpler invariant: `typeof Bun !== 'undefined'`.
//       Stratos is a Node-only package (engines.node >= 20; NON-GOALS.md
//       documents the no-Bun-as-library stance) so seeing the Bun
//       runtime at all means we're inside a compiled binary that the
//       Bun --compile flow built. Library importers under Bun aren't
//       a supported configuration; in the unlikely case someone tries,
//       main() runs eagerly — a minor surprise rather than a
//       silent-zero-exit, which is the right side of the trade-off.
//
// Library callers under Node (the supported import path) get the falsy
// arm of both checks and `main()` does not auto-run — programmatic-API
// contract preserved.
/* v8 ignore start */
const isBunRuntime = typeof Bun !== 'undefined';
const isNodeEntrypoint =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isBunRuntime || isNodeEntrypoint) {
  main().catch((e) => {
    const code = (e && e.exitCode) ? e.exitCode : EX.SOFTWARE;
    const type = (e && e.type) || (e && e.exitCode ? undefined : 'software_error');
    fatal(e && e.message ? e.message : String(e), code, type);
  });
}
/* v8 ignore stop */
