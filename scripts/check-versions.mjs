#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Verify that every version-bearing file in the repo agrees on the
// same version string, and that the EXPECTED_SHA pinned in both
// installers matches the actual SHA-256 of stratos.mjs.
//
// This is the single source of truth used by `npm test` and by the
// pre-tag preflight script (`scripts/preflight-release.sh`). Run it
// before you commit a version bump and again before you tag a
// release.
//
// Exits 0 if everything agrees, 1 otherwise (printing every mismatch).

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Read a file and pull out the first capture group of `regex`. Throws
 * with a useful message if the pattern doesn't match.
 *
 * @param {string} relPath - Path relative to the repo root.
 * @param {RegExp} regex - Must contain exactly one capture group.
 * @returns {Promise<string>} The captured substring.
 */
async function extract(relPath, regex) {
  const text = await readFile(join(ROOT, relPath), 'utf8');
  const m = text.match(regex);
  if (!m) throw new Error(`${relPath}: pattern ${regex} did not match`);
  return m[1];
}

/**
 * Compute the SHA-256 of `relPath`'s bytes as lowercase hex.
 *
 * @param {string} relPath
 * @returns {Promise<string>}
 */
async function sha256(relPath) {
  const buf = await readFile(join(ROOT, relPath));
  return createHash('sha256').update(buf).digest('hex');
}

const errors = [];
const checks = [];

// ─── Version-string sources ───────────────────────────────────────────────
const stratosVersion       = await extract('stratos.mjs',        /const VERSION = '([^']+)'/);
const packageVersion       = await extract('package.json',       /"version":\s*"([^"]+)"/);
const lockVersion          = await extract('package-lock.json',  /"name":\s*"@cloudcdn\/stratos"[\s\S]*?"version":\s*"([^"]+)"/);
const installShVersion     = await extract('install/install.sh', /VERSION="([^"]+)"/);
const installPsVersion     = await extract('install/install.ps1', /\$Version\s*=\s*'([^']+)'/);
const routerTestRegex      = await extract('test/router.test.mjs', /v0\\?\.0\\?\.(\d+)/);
const changelogTopVersion  = await extract('CHANGELOG.md',       /^## \[([\d.]+)\]/m);

checks.push(['stratos.mjs VERSION',       stratosVersion]);
checks.push(['package.json version',      packageVersion]);
checks.push(['package-lock.json version', lockVersion]);
checks.push(['install.sh VERSION',        installShVersion]);
checks.push(['install.ps1 $Version',      installPsVersion]);
checks.push(['router.test.mjs version',   `0.0.${routerTestRegex}`]);
checks.push(['CHANGELOG.md top entry',    changelogTopVersion]);

const canonical = stratosVersion;
for (const [name, value] of checks) {
  if (value !== canonical) {
    errors.push(`  ${name}: expected ${canonical}, got ${value}`);
  }
}

// ─── EXPECTED_SHA agreement ───────────────────────────────────────────────
const actualSha = await sha256('stratos.mjs');
const installShSha  = await extract('install/install.sh',  /EXPECTED_SHA="([0-9a-f]+)"/);
const installPsSha  = await extract('install/install.ps1', /\$ExpectedSha\s*=\s*'([0-9a-f]+)'/);

if (installShSha !== actualSha) {
  errors.push(`  install.sh EXPECTED_SHA: expected ${actualSha}, got ${installShSha}`);
}
if (installPsSha !== actualSha) {
  errors.push(`  install.ps1 $ExpectedSha: expected ${actualSha}, got ${installPsSha}`);
}

// ─── Report ───────────────────────────────────────────────────────────────
if (errors.length === 0) {
  console.log(`✓ all version-bearing files agree on v${canonical}`);
  console.log(`✓ EXPECTED_SHA matches stratos.mjs (${actualSha.slice(0, 12)}…)`);
  process.exit(0);
}

console.error(`✗ version inconsistencies detected (${errors.length}):`);
for (const e of errors) console.error(e);
console.error('');
console.error('Fix:');
console.error(`  - pick the intended version`);
console.error(`  - run \`scripts/preflight-release.sh\` for the full pre-tag checklist`);
process.exit(1);
