#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Build a single, self-contained executable from `stratos.mjs`.
//
// Background. Node's Single Executable Application (SEA) feature
// fundamentally requires a CommonJS entry point — embedding an ESM module
// is not supported as of Node 25.5. Rather than maintain a CJS bundling
// step, this script uses Bun's `bun build --compile`, which:
//
//   * Natively supports ESM, top-level await, and the full `node:*`
//     compatibility surface Stratos already targets (fs/promises, os,
//     path, url, readline, child_process, timers/promises, plus globals
//     fetch / crypto / AbortSignal).
//   * Cross-compiles from any host to every supported target via
//     `--target=bun-<os>-<arch>` — no matrix runner required for a
//     proof-of-concept, though the release workflow still uses a matrix
//     for parallelism and per-OS smoke-testing.
//   * Produces a ~50 MB statically-linked binary with no runtime
//     dependency on Node, Bun, or libc beyond the host's.
//
// This script is *not* a Bun runtime dependency for users — Bun is
// invoked here only at build time. The resulting binary embeds the
// Bun runtime alongside the script.
//
// Usage:
//   node scripts/build-binary.mjs                       # host target
//   node scripts/build-binary.mjs --target linux-x64    # named target
//   node scripts/build-binary.mjs --all                 # every published target
//
// Requires: Bun >= 1.2 on PATH. Install: https://bun.sh

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { platform, arch } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const TARGETS = {
  'linux-x64':    { bunTarget: 'bun-linux-x64',       outfile: 'stratos-linux-x64' },
  'linux-arm64':  { bunTarget: 'bun-linux-arm64',     outfile: 'stratos-linux-arm64' },
  'darwin-x64':   { bunTarget: 'bun-darwin-x64',      outfile: 'stratos-darwin-x64' },
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64',    outfile: 'stratos-darwin-arm64' },
  'win-x64':      { bunTarget: 'bun-windows-x64',     outfile: 'stratos-win-x64.exe' },
};

const args = process.argv.slice(2);
const buildAll = args.includes('--all');
const namedTarget = (() => {
  const i = args.indexOf('--target');
  return i >= 0 ? args[i + 1] : null;
})();

function hostTargetName() {
  const os = platform() === 'win32' ? 'win' : platform();
  return `${os}-${arch()}`;
}

function step(label) {
  process.stderr.write(`\x1b[34m> ${label}\x1b[0m\n`);
}

function buildOne(name) {
  const spec = TARGETS[name];
  if (!spec) {
    process.stderr.write(`\x1b[31munknown target: ${name}. Known: ${Object.keys(TARGETS).join(', ')}\x1b[0m\n`);
    process.exit(1);
  }
  step(`Building ${spec.outfile} (${spec.bunTarget})`);
  const r = spawnSync('bun', [
    'build', '--compile',
    `--target=${spec.bunTarget}`,
    `--outfile=${spec.outfile}`,
    'stratos.mjs',
  ], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) {
    process.stderr.write(`\x1b[31mx bun build -> exit ${r.status}\x1b[0m\n`);
    process.exit(r.status ?? 1);
  }
  const out = resolve(ROOT, spec.outfile);
  if (!existsSync(out)) {
    process.stderr.write(`\x1b[31mx bun build claimed success but ${spec.outfile} is missing\x1b[0m\n`);
    process.exit(1);
  }
  const sizeMB = (statSync(out).size / 1024 / 1024).toFixed(1);
  process.stderr.write(`\x1b[32m+ wrote ${spec.outfile} (${sizeMB} MB)\x1b[0m\n`);

  // Smoke the host build only — cross-compiled binaries can't run here.
  if (name === hostTargetName()) {
    step(`Smoke: ${spec.outfile} version`);
    const s = spawnSync(out, ['version'], { stdio: 'inherit', cwd: ROOT });
    if (s.status !== 0) {
      process.stderr.write(`\x1b[31mx binary smoke failed (exit ${s.status})\x1b[0m\n`);
      process.exit(s.status ?? 1);
    }
  }
}

const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (which.status !== 0) {
  process.stderr.write('\x1b[31mbun is required on PATH. Install: https://bun.sh\x1b[0m\n');
  process.exit(1);
}
process.stderr.write(`\x1b[2mbun ${which.stdout.trim()}\x1b[0m\n`);

if (buildAll) {
  for (const name of Object.keys(TARGETS)) buildOne(name);
} else {
  buildOne(namedTarget || hostTargetName());
}
