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
//   node scripts/make-scoop.mjs <version>    # writes dist/stratos.scoop.json

import { writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const version = process.argv[2];
if (!version) {
  process.stderr.write('usage: make-scoop.mjs <version>\n');
  process.exit(1);
}

const baseUrl = `https://github.com/sebastienrousseau/stratos/releases/download/v${version}`;

/** Compute SHA-256 of a local file (or return a placeholder if not yet built). */
async function fileSha(localPath) {
  try {
    await access(localPath);
    const buf = await readFile(localPath);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return 'REPLACE_WITH_SHA256';
  }
}

const winx64Sha   = await fileSha(join(ROOT, 'stratos-win-x64.exe'));

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

const outDir = join(ROOT, 'dist');
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'stratos.scoop.json'),
  JSON.stringify(manifest, null, 2) + '\n');

process.stdout.write(`wrote ${outDir}/stratos.scoop.json\n`);
