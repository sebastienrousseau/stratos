#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Generate a roff-formatted man page for `stratos(1)` directly from the
// CLI's own help text. Emits to stdout so the release workflow can pipe
// it to `dist/stratos.1` and gzip it.
//
// Why not pandoc / marked-man? Both work but each adds a dependency
// outside the Node standard library. This script is ~150 lines of
// straight-line code with no runtime dependencies — the same ethos as
// `scripts/check-docs.mjs`.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI  = resolve(HERE, '..', 'stratos.mjs');

/** Run `stratos help` and capture its stdout. */
function gatherHelp() {
  const r = spawnSync(process.execPath, [CLI, 'help'],
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', STRATOS_CI: '0' } });
  if (r.status !== 0) {
    process.stderr.write(`stratos help exited ${r.status}\n${r.stderr}\n`);
    process.exit(1);
  }
  return r.stdout;
}

function getVersion() {
  const r = spawnSync(process.execPath, [CLI, 'version'],
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', STRATOS_CI: '0' } });
  return r.stdout.trim().replace(/^stratos v/, '');
}

/**
 * Escape a line for roff: hyphens, backslashes, dots at column 0.
 */
function rEscape(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/-/g, '\\-')
    .replace(/^\./gm, '\\&.');
}

const today = new Date().toISOString().slice(0, 10);
const version = getVersion();
const help = gatherHelp();

// Strip ANSI just in case NO_COLOR didn't suppress everything.
const plain = help.replace(/\x1b\[[0-9;]*m/g, '');

const lines = plain.split('\n');
const out = [];

out.push(`.TH STRATOS 1 "${today}" "stratos ${version}" "Stratos User Manual"`);
out.push('.SH NAME');
out.push('stratos \\- official command\\-line client for CloudCDN');
out.push('.SH SYNOPSIS');
out.push('.B stratos');
out.push('.RI [ command ]');
out.push('.RI [ subcommand ]');
out.push('.RI [ options ]');
out.push('.SH DESCRIPTION');
out.push('Stratos is a single\\-file, zero\\-dependency Node \\(>= 20 ES module that drives');
out.push('the full CloudCDN control plane: cache purge, signed URLs, asset catalogue,');
out.push('insights, zones, tokens, webhooks, rules, storage, SSE\\-streamed logs, AI vision,');
out.push('image transforms, pipeline, search, and an MCP stdio server.');
out.push('');

// Walk the help text, treating bold-looking section headers
// ("Core", "Edge ops", "Catalog & insights" ...) as section breaks.
let currentSection = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();

  if (!trimmed) {
    // Blank line: emit a paragraph break unless we're already at one.
    if (out[out.length - 1] !== '.PP') out.push('.PP');
    continue;
  }

  // Heading detection: short lines at column 0 ("Core", "Edge ops", "Global options").
  const isHeading = line === trimmed
    && trimmed.length > 0 && trimmed.length < 40
    && !trimmed.includes(':')
    && /^[A-Z]/.test(trimmed)
    && trimmed !== 'Usage'
    && i > 0;

  if (isHeading) {
    currentSection = trimmed.toUpperCase();
    out.push(`.SH ${currentSection}`);
    continue;
  }

  if (trimmed.startsWith('Usage:')) {
    out.push('.SH USAGE');
    out.push(rEscape(trimmed.replace(/^Usage:\s*/, '')));
    continue;
  }

  // Indented "command   description" lines become tagged paragraphs.
  if (line.startsWith('  ') && /^\s\s\s*\S/.test(line)) {
    const m = line.match(/^\s+(\S[^\s]*(?:\s+\S+)*?)\s{2,}(.+)$/);
    if (m) {
      const [, name, desc] = m;
      out.push('.TP');
      out.push(`.B ${rEscape(name)}`);
      out.push(rEscape(desc));
      continue;
    }
    // Sub-indented line (e.g. flag explanations under a command).
    out.push(rEscape(line.replace(/^\s+/, '')));
    continue;
  }

  out.push(rEscape(line));
}

out.push('.SH ENVIRONMENT');
out.push('.TP');
out.push('.B CLOUDCDN_URL');
out.push('API base URL. Default: https://cloudcdn.pro.');
out.push('.TP');
out.push('.B CLOUDCDN_ACCOUNT_KEY');
out.push('Control\\-plane authentication. Required for purge, zones, tokens, webhooks.');
out.push('.TP');
out.push('.B CLOUDCDN_ACCESS_KEY');
out.push('Read\\-only authentication. Used for assets, insights, search.');
out.push('.TP');
out.push('.B SIGNED_URL_SECRET');
out.push('HMAC secret for the offline \\fBsigned\\fR command.');
out.push('.TP');
out.push('.B STRATOS_PROFILE');
out.push('Default profile name (overridden by \\fB\\-\\-profile\\fR).');
out.push('.TP');
out.push('.B STRATOS_CI');
out.push('Set to \\fB0\\fR to opt out of CI auto\\-mode; \\fB1\\fR to force generic CI mode.');
out.push('.TP');
out.push('.B STRATOS_NO_KEYCHAIN');
out.push('Set to \\fB1\\fR to skip OS\\-keychain lookups during configuration resolution.');
out.push('.TP');
out.push('.B NO_COLOR');
out.push('Set to disable ANSI styling.');

out.push('.SH EXIT STATUS');
out.push('Stratos follows the sysexits(3) convention.');
out.push('.TP');
out.push('.B 0');
out.push('Success.');
out.push('.TP');
out.push('.B 64');
out.push('Usage error (bad CLI arguments).');
out.push('.TP');
out.push('.B 69');
out.push('Service unavailable (4xx other than auth).');
out.push('.TP');
out.push('.B 75');
out.push('Tempfail (5xx, 429, or network error after retries exhausted).');
out.push('.TP');
out.push('.B 77');
out.push('Permission denied (401 or 403).');
out.push('.TP');
out.push('.B 78');
out.push('Configuration error (missing key, unreadable config file).');
out.push('.TP');
out.push('.B 130');
out.push('Interrupted (SIGINT).');
out.push('.PP');
out.push('Use \\fBstratos explain <code>\\fR for cause + remediation.');

out.push('.SH FILES');
out.push('.TP');
out.push('.I ~/.config/stratos/config.json');
out.push('Per\\-user profile store (mode 0600). Honours \\fBXDG_CONFIG_HOME\\fR.');

out.push('.SH SEE ALSO');
out.push('CloudCDN documentation: https://cloudcdn.pro');
out.push('.br');
out.push('Source: https://github.com/sebastienrousseau/stratos');
out.push('.br');
out.push('Issues: https://github.com/sebastienrousseau/stratos/issues');

out.push('.SH AUTHOR');
out.push('Sebastien Rousseau <sebastian.rousseau@gmail.com>');

out.push('.SH LICENSE');
out.push('MIT');

process.stdout.write(out.join('\n') + '\n');
