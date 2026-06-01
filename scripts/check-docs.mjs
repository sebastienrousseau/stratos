#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Zero-dependency JSDoc coverage checker for stratos.mjs.
//
// Walks the source file line-by-line. For every top-level declaration
// (function, async function, const NAME =, class NAME, export of any of the
// above) it checks whether the immediately preceding non-blank, non-ignore
// line ends a JSDoc block (`*/`) whose opening token is `/**`.
//
// Output: a per-declaration verdict and a final coverage summary. Exits 0
// when 100% of declarations are documented, 1 otherwise.
//
// Usage:
//   node scripts/check-docs.mjs                 # check stratos.mjs
//   node scripts/check-docs.mjs --quiet         # only print summary
//   node scripts/check-docs.mjs --json          # machine-readable
//   node scripts/check-docs.mjs path/to/file    # check a different file
//
// JSDoc must use `/** … */`. Single-line `// …` comments don't count — the
// goal of this gate is structured documentation that downstream tools
// (TypeDoc, IDE hover hints, documentation.js) can consume.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const DECLARATION_RE = new RegExp(
  '^(' +
    'export\\s+(?:default\\s+)?(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)' +
    '|export\\s+(?:default\\s+)?class\\s+([A-Za-z_$][\\w$]*)' +
    '|export\\s+const\\s+([A-Za-z_$][\\w$]*)\\s*=' +
    '|(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)' +
    '|class\\s+([A-Za-z_$][\\w$]*)' +
    '|const\\s+([A-Z][A-Z0-9_]*)\\s*=' +     // SCREAMING_SNAKE constants
    '|const\\s+([a-z$_][\\w$]*)\\s*=\\s*(?:\\(|async|function)' +  // arrow/function const
  ')',
);

/**
 * Check whether `lines` between `start` (exclusive) and 0 contain a JSDoc
 * block closing immediately before `start`.
 *
 * Skips blank lines and existing c8/eslint ignore comments.
 *
 * @param {string[]} lines - File contents split on newlines.
 * @param {number}   start - Line index of the declaration (0-based).
 * @returns {boolean} True iff a JSDoc block ends just above.
 */
function hasJsdocAbove(lines, start) {
  let i = start - 1;
  while (i >= 0) {
    const ln = lines[i].trim();
    if (ln === '') { i--; continue; }
    if (ln.startsWith('/* c8 ignore') || ln.startsWith('/* eslint')) { i--; continue; }
    if (ln === '*/' || ln.endsWith('*/')) {
      // Walk back to the opener.
      let j = i;
      while (j >= 0 && !lines[j].includes('/**')) j--;
      return j >= 0 && lines[j].includes('/**');
    }
    return false;
  }
  return false;
}

/**
 * Collect every top-level declaration in `source`.
 *
 * @param {string} source - Full file contents.
 * @returns {Array<{line:number,name:string,kind:string,documented:boolean}>}
 */
function collectDeclarations(source) {
  const lines = source.split('\n');
  const decls = [];
  // Track block nesting so we only inspect *top-level* declarations.
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip lines inside braces — only consider declarations at column 0.
    if (depth === 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      const m = line.match(DECLARATION_RE);
      if (m) {
        const name = m[2] || m[3] || m[4] || m[5] || m[6] || m[7] || m[8];
        const kind = m[0].includes('function') ? 'function'
                   : m[0].includes('class') ? 'class'
                   : /^[A-Z]/.test(name || '') ? 'constant'
                   : 'binding';
        if (name && !['_kcCache','HERE'].includes(name)) {
          decls.push({
            line: i + 1, name, kind,
            documented: hasJsdocAbove(lines, i),
          });
        }
      }
    }
    // Update depth.
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
  }
  return decls;
}

const args = process.argv.slice(2);
const flags = { quiet: false, json: false };
const positional = [];
for (const a of args) {
  if (a === '--quiet' || a === '-q') flags.quiet = true;
  else if (a === '--json') flags.json = true;
  else positional.push(a);
}

const file = positional[0] || resolve(HERE, '..', 'stratos.mjs');
const source = await readFile(file, 'utf8');
const decls = collectDeclarations(source);

const documented = decls.filter((d) => d.documented);
const missing = decls.filter((d) => !d.documented);
const pct = decls.length === 0 ? 100 : Math.round((documented.length / decls.length) * 10000) / 100;

if (flags.json) {
  process.stdout.write(JSON.stringify({
    file, total: decls.length, documented: documented.length, missing: missing.length,
    coverage_pct: pct, missing_decls: missing,
  }, null, 2) + '\n');
} else {
  if (!flags.quiet) {
    for (const d of decls) {
      const tag = d.documented ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      process.stdout.write(`  ${tag}  L${String(d.line).padStart(4)}  ${d.kind.padEnd(8)}  ${d.name}\n`);
    }
    process.stdout.write('\n');
  }
  const bar = pct === 100 ? '\x1b[32m' : '\x1b[33m';
  process.stdout.write(
    `${bar}Documentation: ${pct}% (${documented.length}/${decls.length} declarations)\x1b[0m\n`
  );
  if (missing.length > 0) {
    process.stdout.write(`\nMissing JSDoc on:\n`);
    for (const d of missing) {
      process.stdout.write(`  L${String(d.line).padStart(4)}  ${d.kind}  ${d.name}\n`);
    }
  }
}

process.exit(missing.length === 0 ? 0 : 1);
