#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Generate a Scoop manifest for Stratos. The single JSON file lands in
// the `cloudcdn/scoop-bucket` repo (one-time setup analogous to the
// Homebrew tap); users then install with:
//
//     scoop bucket add cloudcdn https://github.com/sebastienrousseau/scoop-bucket
//     scoop install stratos
//
// Schema reference: https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests
//
// Usage:
//   node scripts/make-scoop.mjs <version>                      # writes dist/stratos.scoop.json
//   node scripts/make-scoop.mjs <version> --bin-dir <dir>      # use binaries in <dir>
//                                                              # to compute the real SHA
//   node scripts/make-scoop.mjs <version> --dist-dir <dir>     # write to <dir>/stratos.scoop.json
//                                                              # instead of dist/ (used by tests)

import { writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const version = process.argv[2];
if (!version) {
  process.stderr.write('usage: make-scoop.mjs <version> [--bin-dir <dir>]\n');
  process.exit(1);
}

const binDirIdx = process.argv.indexOf('--bin-dir');
const binDir = binDirIdx >= 0 ? resolve(process.argv[binDirIdx + 1]) : null;

const distDirIdx = process.argv.indexOf('--dist-dir');
const distRoot = distDirIdx >= 0 ? resolve(process.argv[distDirIdx + 1]) : join(ROOT, 'dist');

const baseUrl = `https://github.com/sebastienrousseau/stratos/releases/download/v${version}`;

/**
 * Compute SHA-256 of a local file. Tries `--bin-dir` first, falls back
 * to the repo root, finally yields a placeholder for the pre-binaries
 * pass.
 */
async function fileSha(filename) {
  const candidates = binDir ? [join(binDir, filename), join(ROOT, filename)] : [join(ROOT, filename)];
  for (const p of candidates) {
    try {
      await access(p);
      const buf = await readFile(p);
      return createHash('sha256').update(buf).digest('hex');
    } catch { /* try next */ }
  }
  return 'REPLACE_WITH_SHA256';
}

const winx64Sha = await fileSha('stratos-win-x64.exe');

const manifest = {
  $schema: 'https://raw.githubusercontent.com/ScoopInstaller/Scoop/master/schema.json',
  version,
  description: 'Official command-line client for CloudCDN — full control plane in a single zero-dep Node ≥ 20 ES module.',
  homepage: 'https://github.com/sebastienrousseau/stratos',
  license: 'MIT',
  notes: [
    'Single-binary install — no Node required.',
    'Run `stratos doctor` to validate your environment + credentials.',
    'See https://github.com/sebastienrousseau/stratos for command reference.',
  ],
  architecture: {
    '64bit': {
      url: `${baseUrl}/stratos-win-x64.exe#/stratos.exe`,
      hash: winx64Sha,
      bin: 'stratos.exe',
    },
  },
  checkver: {
    github: 'https://github.com/sebastienrousseau/stratos',
  },
  autoupdate: {
    architecture: {
      '64bit': {
        url: 'https://github.com/sebastienrousseau/stratos/releases/download/v$version/stratos-win-x64.exe#/stratos.exe',
      },
    },
  },
};

await mkdir(distRoot, { recursive: true });
await writeFile(join(distRoot, 'stratos.scoop.json'),
  JSON.stringify(manifest, null, 2) + '\n');

process.stdout.write(`wrote ${distRoot}/stratos.scoop.json\n`);
