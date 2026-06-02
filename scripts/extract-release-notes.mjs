#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Extract the CHANGELOG.md section for `process.argv[2]` (a version
// like `0.0.5` — leading `v` stripped if present) and print it on
// stdout. Used by release.yml as the body source for the GitHub
// release.
//
// The CHANGELOG uses the Keep-a-Changelog format:
//
//   ## [0.0.5] — 2026-06-15
//
//   ### Added
//   - …
//
//   ## [0.0.4] — 2026-06-01
//
// We grab everything between the requested header and the next `## `
// header at column 0, trimming the blank lines at the edges.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHANGELOG = resolve(HERE, '..', 'CHANGELOG.md');

const raw = process.argv[2];
if (!raw) {
  process.stderr.write('usage: extract-release-notes.mjs <version>\n');
  process.exit(1);
}
const v = raw.replace(/^v/, '');

const text = await readFile(CHANGELOG, 'utf8');
const lines = text.split('\n');

const start = lines.findIndex((l) => l.match(new RegExp(`^##\\s+\\[${v.replace(/\./g, '\\.')}\\]`)));
if (start < 0) {
  process.stderr.write(`could not find a "## [${v}]" section in ${CHANGELOG}\n`);
  process.exit(1);
}

let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) { end = i; break; }
}

const body = lines.slice(start + 1, end).join('\n').replace(/^\n+|\n+$/g, '');
process.stdout.write(body + '\n');
