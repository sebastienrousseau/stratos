#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Stratos — official CloudCDN CLI.
//
// Zero runtime dependencies. Single-file. Node ≥ 20 (uses fetch, crypto.subtle,
// AbortSignal.timeout, fs/promises, readline, util.styleText fallbacks).
//
// Source:  https://github.com/sebastienrousseau/stratos
// License: MIT

import { readFile, writeFile, mkdir, stat, readdir, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { homedir, platform } from 'node:os';
import { resolve as resolvePath, join, dirname, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const VERSION = '0.0.2';

// ─────────────────────────────────────────────────────────────────────────────
// Sysexits — sysexits.h conventions, so CI / make / sh can branch on cause.
// ─────────────────────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Styling — ANSI only when stdout is a TTY and NO_COLOR is unset.
// ─────────────────────────────────────────────────────────────────────────────
// STRATOS_FORCE_TTY=1 forces TTY-mode output (table renderer, colours).
// Used by the test suite to exercise output paths inside subprocesses.
const isTTY = () => process.env.STRATOS_FORCE_TTY === '1' || (process.stdout.isTTY && !process.env.NO_COLOR);
function paint(s, code) { return isTTY() ? `\x1b[${code}m${s}\x1b[0m` : s; }
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
function out(s)    { process.stdout.write(s.endsWith('\n') ? s : s + '\n'); }
function diag(s)   { process.stderr.write(s.endsWith('\n') ? s : s + '\n'); }
function info(m)   { if (!FLAGS_GLOBAL.quiet) diag(`${c.blue('info:')}    ${m}`); }
function warn(m)   { diag(`${c.yellow('warning:')} ${m}`); }
function fatal(m, code = EX.SOFTWARE) {
  diag(`${c.red('error:')}   ${m}`);
  process.exit(code);
}

// Globally observed flags so info()/warn() can honour --quiet without
// threading the flag through every function. Mutated once in main().
const FLAGS_GLOBAL = { quiet: false, verbose: 0, json: false };

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
// Short flags. Boolean ones map char → full name; value-taking ones use an
// object { name, value: true } so the parser knows to consume the next arg.
const SHORTCUTS = {
  h: 'help',
  v: 'version',
  q: 'quiet',
  n: { name: 'n', value: true },        // count, e.g. `bench -n 5`
  f: { name: 'f', value: true },        // file path, e.g. `rules set -f ./_headers`
};

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

function flagList(v) { return v === undefined ? [] : Array.isArray(v) ? v : [v]; }

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
const XDG_CONFIG_HOME =
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const CONFIG_DIR = join(XDG_CONFIG_HOME, 'stratos');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

async function loadFileConfig() {
  try {
    const raw = await readFile(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return { profiles: {} };
    throw new Error(`config: ${CONFIG_FILE} unreadable: ${e.message}`);
  }
}

async function saveFileConfig(cfg) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

// Resolved-keychain cache: keychain lookups shell out, so cache per-process.
const _kcCache = new Map();

async function envConfig(flags = {}) {
  const profileName =
    flags.profile || process.env.STRATOS_PROFILE || 'default';
  const fileCfg = await loadFileConfig();
  const profile = (fileCfg.profiles && fileCfg.profiles[profileName]) || {};

  // Resolve each key from flag → env → profile → keychain.
  // Keychain is checked last because it costs a child process; skip if
  // STRATOS_NO_KEYCHAIN=1 (handy for CI smoke tests).
  const useKc = process.env.STRATOS_NO_KEYCHAIN !== '1';
  const fromKc = async (account) => useKc ? await keychainGet(account) : '';

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
const KC_SERVICE = 'stratos';

/* c8 ignore start -- shells out to OS-specific binaries; not deterministically
   reachable from a portable test suite. Behaviour is exercised manually
   on each platform. */
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
async function jsonReq(path, init = {}, opts = {}) {
  const cfg = await envConfig(init.flags || {});
  const base = cfg.BASE.replace(/\/$/, '');
  const url = base + path;
  const headers = { Accept: 'application/json', 'User-Agent': `stratos/${VERSION}`, ...(init.headers || {}) };

  // Auth-header policy: control-plane = AccountKey + x-api-key;
  // read-only = AccessKey if present, otherwise AccountKey.
  const role = opts.role || 'read';
  if (role === 'control') {
    if (!cfg.ACCOUNT_KEY) throw httpErr('CLOUDCDN_ACCOUNT_KEY is required for this command.', EX.CONFIG);
    headers.AccountKey = cfg.ACCOUNT_KEY;
    headers['x-api-key'] = cfg.ACCOUNT_KEY;
  } else {
    if (cfg.ACCESS_KEY) headers.AccessKey = cfg.ACCESS_KEY;
    else if (cfg.ACCOUNT_KEY) headers.AccountKey = cfg.ACCOUNT_KEY;
  }

  const maxAttempts = (opts.noRetry ? 1 : cfg.MAX_RETRIES) + 1;
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
  throw httpErr(`request failed after ${maxAttempts} attempts: ${lastErr ? lastErr.message : 'unknown'}`, EX.TEMPFAIL);
}

function httpErr(msg, code) { const e = new Error(msg); e.exitCode = code; return e; }

function emit(body, status = 200) {
  if (FLAGS_GLOBAL.json || !isTTY()) {
    out(JSON.stringify(body, null, isTTY() ? 2 : 0));
  } else {
    out(JSON.stringify(body, null, 2));
  }
}

function emitFailure(body, status) {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  diag(text);
}

function exitForStatus(status) {
  if (status === 401 || status === 403) return EX.NOPERM;
  if (status === 429) return EX.TEMPFAIL;
  if (status >= 500) return EX.TEMPFAIL;
  return EX.UNAVAILABLE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Table renderer — minimal, dependency-free.
// ─────────────────────────────────────────────────────────────────────────────
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

function emitList(rows, columns) {
  if (FLAGS_GLOBAL.json || !isTTY()) {
    out(JSON.stringify(rows, null, isTTY() ? 2 : 0));
  } else {
    renderTable(rows, columns);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stdin helpers.
// ─────────────────────────────────────────────────────────────────────────────
async function readStdinLines() {
  if (process.stdin.isTTY) return [];
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands — version, help, completion, upgrade, config.
// ─────────────────────────────────────────────────────────────────────────────
function cmdVersion() {
  out(`stratos v${VERSION}`);
}

const HELP_ROOT = `${c.bold('stratos')} v${VERSION} — CloudCDN CLI

${c.bold('Usage:')} stratos <command> [<subcommand>] [options]

${c.bold('Core')}
  version                     Print version and exit.
  help [<command>]            Print help for a command.
  completion <shell>          Emit completion script (bash|zsh|fish|powershell).
  upgrade                     Re-install the latest pinned release.
  config get|set|list         Manage ~/.config/stratos/config.json profiles.
  login                       Store keys in the OS keychain.
  login status                Show resolved config (keys masked).
  logout                      Remove keys from the OS keychain.
  doctor                      Diagnose environment, credentials, reachability.
  bench [-n N]                Measure cold-start + N request latencies.
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
  --json                      Force JSON output.
  --quiet | -q                Suppress info logs.
  --verbose                   Trace HTTP requests.
  --profile <name>            Select config profile.
  --cdn-url <url>             Override CLOUDCDN_URL (the API base).
  --account-key <key>         Override CLOUDCDN_ACCOUNT_KEY.
  --access-key <key>          Override CLOUDCDN_ACCESS_KEY.
  --timeout <ms>              Per-request timeout (default 15000).
  --retries <n>               Max retries (default 3).

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
    'stratos rules get  <_headers|_redirects>\n' +
    'stratos rules set  <_headers|_redirects> -f <file>   (or via stdin)\n' +
    'stratos rules diff <_headers|_redirects> -f <file>\n\n' +
    'diff exits 0 if remote and local match, 69 on drift (git-style).\n',
  mcp: 'stratos mcp serve\n  Speak Model Context Protocol over stdio.\n',
  completion: 'stratos completion <bash|zsh|fish|powershell>\n',
  config:
    'stratos config list\n' +
    'stratos config get <profile>.<key>\n' +
    'stratos config set <profile>.<key> <value>\n',
};

function cmdHelp(rest) {
  const topic = rest[0];
  if (!topic) { out(HELP_ROOT); return; }
  const h = HELP_BY_COMMAND[topic];
  if (h) { out(h); return; }
  diag(`No help for '${topic}'.`);
  process.exit(EX.USAGE);
}

function cmdCompletion(rest) {
  const shell = rest[0];
  if (!shell) fatal('completion needs a shell name (bash|zsh|fish|powershell).', EX.USAGE);
  const COMMANDS = [
    'version','help','health','purge','signed','assets','insights','stats','analytics',
    'audit','zones','rules','tokens','webhooks','storage','logs','ai','image','stream',
    'pipeline','search','ask','passkey','config','mcp','completion','upgrade',
    'login','logout','doctor','bench',
  ];
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
    default:
      fatal('config <list|get|set>', EX.USAGE);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Login — prompt for keys, store in OS keychain.
// ─────────────────────────────────────────────────────────────────────────────
/* c8 ignore start -- interactive TTY-only readline; covered by manual QA */
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

function platformKeychainName() {
  switch (platform()) {
    case 'darwin': return 'macOS Keychain';
    case 'linux':  return 'libsecret (GNOME Keyring / KWallet)';
    /* c8 ignore next 2 -- platform-specific switch arms */
    case 'win32':  return 'Windows Credential Manager';
    default:       return 'OS keychain';
  }
}

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

function maskKey(k) {
  if (!k) return c.dim('(unset)');
  if (k.length <= 8) return c.dim('***');
  return c.dim(k.slice(0, 6) + '…' + k.slice(-2));
}

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
  const kcCmd = platform() === 'darwin' ? 'security'
            : platform() === 'linux'  ? 'secret-tool'
            : platform() === 'win32'  ? 'cmdkey' : null;
  if (kcCmd) {
    const r = await execCapture(kcCmd, ['--version'].slice(0, kcCmd === 'cmdkey' ? 0 : 1));
    check(`Keychain (${kcCmd})`, r.code === 0 || r.stdout.length > 0 || r.stderr.length > 0,
      platformKeychainName());
  } else {
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
  if (FLAGS_GLOBAL.json) { emit(checks); return; }
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
  if (FLAGS_GLOBAL.json) { emit(stats); return; }
  out(c.bold(`cold start (spawn → exit):  ${stats.summary.cold_start_ms} ms`));
  out(c.bold(`requests (${oks.length}/${samples.length} ok):  `) +
      `min ${stats.summary.min_ms}  p50 ${stats.summary.p50_ms}  p95 ${stats.summary.p95_ms}  max ${stats.summary.max_ms}  (ms)`);
  for (const s of samples) {
    const status = s.status === 0 ? c.red('ERR') : s.status < 400 ? c.green(String(s.status)) : c.yellow(String(s.status));
    out(`  #${s.i + 1}  ${status}  ${String(s.ms).padStart(7)} ms  ${s.error || ''}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Health, purge, signed, assets — existing commands, hardened.
// ─────────────────────────────────────────────────────────────────────────────
async function cmdHealth(flags) {
  const deep = flags.deep ? '?deep=1' : '';
  const { ok, status, body } = await jsonReq('/api/health' + deep, { flags });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  emit(body, status);
}

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
    if (urls.length === 0) fatal('purge needs at least one URL, --tag, or --everything.', EX.USAGE);
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

export async function cmdSigned(positional, flags) {
  const cfg = await envConfig(flags);
  if (positional.length === 0) fatal('signed needs a path argument.', EX.USAGE);
  const path = positional[0];
  const expires = flags.expires;
  if (!expires) fatal('signed needs --expires <unix-seconds>.', EX.USAGE);
  const secret = flags.secret || cfg.SIGNED_URL_SECRET;
  if (!secret) fatal('SIGNED_URL_SECRET (or --secret) is required.', EX.CONFIG);

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
      if (page > 1000) { warn('safety cap at 1000 pages'); break; }
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
async function getJson(path, flags, role = 'read') {
  const { ok, status, body } = await jsonReq(path, { flags }, { role });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  return body;
}

function daysParam(flags, max = 90) {
  const d = Number(flags.days || 7);
  if (!Number.isFinite(d) || d < 1 || d > max) fatal(`--days must be 1..${max}`, EX.USAGE);
  return d;
}

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

async function cmdStats(flags) {
  const params = new URLSearchParams({ days: String(daysParam(flags)) });
  if (flags.zone) params.set('zone', flags.zone);
  emit(await getJson('/api/core/statistics?' + params, flags, 'control'));
}

async function cmdAnalytics(positional, flags) {
  const sub = positional[0] || 'query';
  if (sub !== 'query') fatal('analytics query [options]', EX.USAGE);
  const params = new URLSearchParams({ days: String(daysParam(flags, 30)) });
  for (const k of ['path', 'bytes', 'country', 'cache']) {
    if (flags[k] !== undefined) params.set(k, String(flags[k]));
  }
  emit(await getJson('/api/analytics?' + params, flags));
}

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
// Zones.
// ─────────────────────────────────────────────────────────────────────────────
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
async function cmdRules(positional, flags) {
  const sub = positional[0];
  if (sub !== 'get' && sub !== 'set' && sub !== 'diff') {
    fatal('rules <get|set|diff> <_headers|_redirects>', EX.USAGE);
  }
  const file = positional[1];
  if (file !== '_headers' && file !== '_redirects') fatal('file must be _headers or _redirects', EX.USAGE);

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
  while (i < m) { lines.push({ kind: '-', text: A[i++] }); removed++; }
  while (j < n) { lines.push({ kind: '+', text: B[j++] }); added++; }
  return { lines, added, removed, context, changes: added + removed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens.
// ─────────────────────────────────────────────────────────────────────────────
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

async function storageRm(remote, flags) {
  if (!remote) fatal('storage rm <remote>', EX.USAGE);
  const { ok, status, body } = await jsonReq('/api/storage/' + encodeRemotePath(remote), {
    method: 'DELETE', flags,
  }, { role: 'control' });
  if (!ok) { emitFailure(body, status); process.exit(exitForStatus(status)); }
  info(`removed ${remote}`);
}

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
  let done = 0;
  for (const batch of batches) {
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

function encodeRemotePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

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

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Logs — historical query + SSE tail.
// ─────────────────────────────────────────────────────────────────────────────
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

async function logsTail(flags) {
  const cfg = await envConfig(flags);
  const params = new URLSearchParams({ tail: 'true' });
  if (flags.level) params.set('level', flags.level);
  const url = cfg.BASE.replace(/\/$/, '') + '/api/logs?' + params;
  const headers = { Accept: 'text/event-stream' };
  if (cfg.ACCOUNT_KEY) { headers.AccountKey = cfg.ACCOUNT_KEY; headers['x-api-key'] = cfg.ACCOUNT_KEY; }

  const controller = new AbortController();
  process.on('SIGINT', () => { controller.abort(); process.exit(130); });

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
}

function printLogLine(rec) {
  const lvl = (rec.level || 'info').toLowerCase();
  const colour = lvl === 'error' ? c.red : lvl === 'warn' ? c.yellow : lvl === 'debug' ? c.dim : c.cyan;
  const ts = rec.timestamp || new Date().toISOString();
  out(`${c.dim(ts)}  ${colour(lvl.toUpperCase().padEnd(5))}  ${rec.message || JSON.stringify(rec)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// AI, image, stream, pipeline, search, ask, passkey.
// ─────────────────────────────────────────────────────────────────────────────
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

async function cmdStream(positional, flags) {
  const video = positional[0];
  if (!video) fatal('stream <video> [--quality Q] [--segment N]', EX.USAGE);
  const params = new URLSearchParams({ video });
  if (flags.quality) params.set('quality', String(flags.quality));
  if (flags.segment !== undefined) params.set('segment', String(flags.segment));
  const cfg = await envConfig(flags);
  out(`${cfg.BASE.replace(/\/$/, '')}/api/stream?${params}`);
}

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
];

async function mcpCall(name, args) {
  const flags = args || {};
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
        else await cmdPurge(flags.urls || [], {});
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
      default: throw new Error(`unknown tool: ${name}`);
    }
  } finally {
    process.stdout.write = orig.write;
    process.stderr.write = orig.errWrite;
  }
  return { stdout: sink.out.join(''), stderr: sink.err.join('') };
}

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
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'stratos', version: VERSION },
          capabilities: { tools: {} },
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
function applyGlobalFlags(flags) {
  if (flags.quiet) FLAGS_GLOBAL.quiet = true;
  if (flags.verbose) FLAGS_GLOBAL.verbose = Number(flags.verbose) || 1;
  if (flags.json) FLAGS_GLOBAL.json = true;
}

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

  switch (cmd) {
    case 'completion':  cmdCompletion(positional); return;
    case 'upgrade':     return cmdUpgrade();
    case 'config':      return cmdConfig(positional, flags);
    case 'login':       return cmdLogin(positional, flags);
    case 'logout':      return loginLogout(flags);
    case 'doctor':      return cmdDoctor(flags);
    case 'bench':       return cmdBench(flags);
    case 'mcp':         if (positional[0] !== 'serve') fatal('mcp serve', EX.USAGE); return cmdMcpServe();
    case 'health':      return cmdHealth(flags);
    case 'purge':       return cmdPurge(positional, flags);
    case 'signed':      return cmdSigned(positional, flags);
    case 'assets':      return cmdAssets(positional, flags);
    case 'insights':    return cmdInsights(positional, flags);
    case 'stats':       return cmdStats(flags);
    case 'analytics':   return cmdAnalytics(positional, flags);
    case 'audit':       return cmdAudit(flags);
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
    default:
      fatal(`unknown command: ${cmd}. Run "stratos help" for usage.`, EX.USAGE);
  }
}

// Exports for testing.
export {
  VERSION, EX, parseFlags as _parseFlags, jsonReq, envConfig, cmdHealth, cmdAssets,
  cmdInsights, cmdZones, cmdTokens, cmdWebhooks, cmdStorage, cmdLogs, cmdAI, cmdImage,
  cmdSearch, cmdAsk, MCP_TOOLS, mcpCall,
};

// Script entrypoint guard.
/* v8 ignore start */
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    const code = (e && e.exitCode) ? e.exitCode : EX.SOFTWARE;
    fatal(e && e.message ? e.message : String(e), code);
  });
}
/* v8 ignore stop */
