#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Generate asciicast v2 (.cast) files for the README demos, then render
// each to a GIF via `agg` (https://github.com/asciinema/agg).
//
// The casts are hand-scripted (not recorded) so they're deterministic,
// version-controllable, and don't depend on a live CloudCDN endpoint to
// regenerate.
//
// Usage:
//   node scripts/make-casts.mjs            # writes .cast files only
//   node scripts/make-casts.mjs --render   # also runs `agg` to produce .gif

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'docs', 'casts');
await mkdir(OUT, { recursive: true });

const ANSI = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  cyan:   '\x1b[36m',
};

/**
 * Build a v2 asciicast given a sequence of `[delaySeconds, output]` pairs.
 * The header includes a small green prompt and `stratos`-themed env.
 */
function makeCast({ width = 92, height = 18, title, events }) {
  const header = { version: 2, width, height,
    timestamp: 1717228800, // 2026-06-01T00:00:00Z
    env: { SHELL: '/bin/zsh', TERM: 'xterm-256color' },
    title,
  };
  let t = 0;
  const lines = [JSON.stringify(header)];
  for (const [dt, out] of events) {
    t += dt;
    lines.push(JSON.stringify([Number(t.toFixed(3)), 'o', out]));
  }
  return lines.join('\n') + '\n';
}

const prompt = `${ANSI.green}❯${ANSI.reset} `;

const CASTS = {
  'version': {
    title: 'stratos version',
    events: [
      [0.4, prompt],
      [0.6, 'stratos version\r\n'],
      [0.3, `stratos v0.0.2\r\n`],
      [0.4, prompt],
      [1.0, ''],
    ],
  },

  'health': {
    title: 'stratos health',
    events: [
      [0.4, prompt],
      [0.7, 'stratos health\r\n'],
      [0.4,
        '{\r\n' +
        '  "status": "ok",\r\n' +
        '  "bindings": {\r\n' +
        '    "ai": true,\r\n' +
        '    "kv": true,\r\n' +
        '    "d1": true,\r\n' +
        '    "r2": true\r\n' +
        '  }\r\n' +
        '}\r\n'
      ],
      [0.4, prompt],
      [1.0, ''],
    ],
  },

  'purge': {
    title: 'stratos purge --tag … --dry-run',
    events: [
      [0.4, prompt],
      [1.0, 'stratos purge --tag build-abc1234 --tag project-akande --dry-run\r\n'],
      [0.4, '{\r\n  "dry_run": true,\r\n  "would_send": {\r\n    "tags": [\r\n      "build-abc1234",\r\n      "project-akande"\r\n    ]\r\n  }\r\n}\r\n'],
      [0.4, prompt],
      [1.0, ''],
    ],
  },

  'signed': {
    title: 'stratos signed (offline HMAC)',
    events: [
      [0.4, prompt],
      [0.8, 'export SIGNED_URL_SECRET=cdnsk_xxxxxxxxxxxxxxx\r\n'],
      [0.4, prompt],
      [1.0, 'stratos signed /clients/akande/preview.pdf --expires 1717232400\r\n'],
      [0.4, 'https://cloudcdn.pro/api/signed?path=%2Fclients%2Fakande%2Fpreview.pdf&'],
      [0.0, 'expires=1717232400&sig=4d3b1f8a9c7e2d6b5a4f3e2d1c8b9a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b\r\n'],
      [0.4, prompt],
      [1.0, ''],
    ],
  },

  'doctor': {
    title: 'stratos doctor',
    events: [
      [0.4, prompt],
      [0.7, 'stratos doctor\r\n'],
      [0.3, `${ANSI.bold}CHECK                         STATUS  DETAIL${ANSI.reset}\r\n`],
      [0.0, `${ANSI.dim}────────────────────────────────────────────────────────────────────────────────${ANSI.reset}\r\n`],
      [0.05, `Node ≥ 20                       ${ANSI.green}  ok  ${ANSI.reset}  ${ANSI.dim}detected 24.14.0${ANSI.reset}\r\n`],
      [0.05, `Config file readable            ${ANSI.green}  ok  ${ANSI.reset}  ${ANSI.dim}~/.config/stratos/config.json · 2 profile(s)${ANSI.reset}\r\n`],
      [0.05, `Keychain (security)             ${ANSI.green}  ok  ${ANSI.reset}  ${ANSI.dim}macOS Keychain${ANSI.reset}\r\n`],
      [0.05, `account_key                     ${ANSI.green}  ok  ${ANSI.reset}  ${ANSI.dim}cdnsk_…23${ANSI.reset}\r\n`],
      [0.05, `access_key                      ${ANSI.green}  ok  ${ANSI.reset}  ${ANSI.dim}cdnsk_…42${ANSI.reset}\r\n`],
      [0.05, `signed_url_secret               ${ANSI.green}  ok  ${ANSI.reset}  ${ANSI.dim}cdnsk_…1f${ANSI.reset}\r\n`],
      [0.4, `Reach https://cloudcdn.pro      ${ANSI.green}  ok  ${ANSI.reset}  ${ANSI.dim}HTTP 200 in 87ms${ANSI.reset}\r\n`],
      [0.4, prompt],
      [1.5, ''],
    ],
  },
};

for (const [name, spec] of Object.entries(CASTS)) {
  const cast = makeCast(spec);
  const path = join(OUT, `${name}.cast`);
  await writeFile(path, cast);
  console.log(`wrote ${path}`);
}

if (process.argv.includes('--render')) {
  for (const name of Object.keys(CASTS)) {
    const cast = join(OUT, `${name}.cast`);
    const gif  = join(OUT, `${name}.gif`);
    console.log(`rendering ${cast} → ${gif}`);
    const r = spawnSync('agg', [
      '--theme', 'monokai',
      '--font-size', '14',
      '--line-height', '1.3',
      cast, gif,
    ], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`agg failed for ${name} (exit ${r.status})`);
      process.exit(1);
    }
  }
  console.log(`✓ ${Object.keys(CASTS).length} GIF(s) rendered into ${OUT}`);
}
