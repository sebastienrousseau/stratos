#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Lint test/*.test.mjs for the resource-leak pattern that caused the
// v0.0.14 → v0.0.15 Windows CI hang.
//
// The bug:
//
//   test('something', async () => {
//     const { srv, base } = await startServer(handler);    // opens listener
//     const tmp = await mkdtemp(join('/tmp', 'x-'));       // ← THROWS on Windows
//     try { ... } finally { srv.close(); }                  // ← never reached
//   });
//
// `mkdtemp` threw ENOENT before the try block, so srv.close() never
// ran. The open server kept the Node test process alive forever and
// `node --test` hung until the workflow timeout (default 6h × 9
// matrix cells = 54 wasted compute-hours per run).
//
// The rule:
//
//   Within a test(...) callback, every resource-opener is "safe" iff
//   one of the following holds:
//
//     (1) The opener sits inside an active `try { ... }` block — any
//         subsequent throw lands in finally where cleanup runs.
//
//     (2) Between the opener and the next `try { ... }` on the same
//         level, no other `await` appears. (Opener throwing itself is
//         fine because there's nothing to clean up yet.)
//
//   Anything else is a leak risk.
//
// Why "next await" matters in case (2): the v0.0.14 bug had two
// openers in series — `await startServer` then `await mkdtemp`. The
// second opener threw on Windows and the first leaked. Equivalently,
// any `await writeFile` / `await import` between two would also let
// the first opener leak.
//
// Fix shape (passes lint):
//
//   test('something', async () => {
//     let srv, tmp;
//     try {
//       ({ srv } = await startServer(handler));   // inside try — case (1)
//       tmp = await mkdtemp(join(tmpdir(), 'x-'));
//       ...
//     } finally {
//       if (srv) srv.close();
//       if (tmp) await rm(tmp, { recursive: true, force: true });
//     }
//   });
//
// Or this lighter shape (also passes):
//
//   test('simple', async () => {
//     const { srv, base } = await startServer(handler);   // case (2)
//     try {                                                // next stmt is try
//       ...
//     } finally { srv.close(); }
//   });
//
// Usage:
//   node scripts/lint-tests.mjs            # human output
//   node scripts/lint-tests.mjs --json     # machine output
//
// Exits 0 if clean, 1 on any violation.

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TEST_DIR = join(ROOT, 'test');

/** @type {RegExp[]} */
const OPENERS = [
  /\bawait\s+startServer\s*\(/,
  /\bawait\s+mkdtemp\s*\(/,
];

/** @type {RegExp} */
const TEST_START = /^\s*test\s*\(\s*['"`]/;
/** @type {RegExp} */
const TRY_START = /\btry\s*\{/;
/** @type {RegExp} */
const ALLOW_NEXT = /\blint-tests-allow-next\b/;
/** @type {RegExp} */
const AWAIT_KW = /\bawait\b/;

/**
 * Replace string literals with empty sentinels and strip line + block
 * comments. Order matters: strings first, so `//` inside `'https://x'`
 * isn't treated as a comment opener. Heuristic — doesn't track
 * multi-line template strings — good enough for these test files.
 *
 * @param {string} line
 * @returns {string}
 */
function preprocess(line) {
  let s = line;
  s = s.replace(/'(?:\\.|[^'\\])*'/g, "''");
  s = s.replace(/"(?:\\.|[^"\\])*"/g, '""');
  s = s.replace(/`(?:\\.|[^`\\])*`/g, '``');
  s = s.replace(/\/\*.*?\*\//g, '');
  s = s.replace(/\/\/.*$/, '');
  return s;
}

/**
 * Brace delta on a pre-processed line (no strings, no comments).
 *
 * @param {string} s
 * @returns {number}
 */
function braceDelta(s) {
  const opens = (s.match(/\{/g) || []).length;
  const closes = (s.match(/\}/g) || []).length;
  return opens - closes;
}

/**
 * Whether the line is an opener of a resource needing cleanup.
 *
 * @param {string} code - Stripped line (no comments).
 * @returns {boolean}
 */
function isOpener(code) {
  return OPENERS.some((re) => re.test(code));
}

/**
 * Lint one file.
 *
 * Algorithm:
 *   - Track brace depth and a stack of `try {` opening depths.
 *   - Inside any `test(...)` callback, on each line:
 *     * If we're "watching" an outside-try opener (state.watch.from) and
 *       the line contains `await` that isn't itself an opener, flag.
 *     * If the line contains an opener:
 *         - inside try (case 1): safe, ignore
 *         - outside try (case 2): start watching forward
 *     * If the line opens a `try {`, clear the watch (we reached safety).
 *
 * @param {string} file
 * @returns {Promise<Array<{file:string,line:number,test_line:number,
 *                          opener_line:number,source:string}>>}
 */
async function lintFile(file) {
  const src = await readFile(file, 'utf8');
  const lines = src.split('\n');
  const issues = [];

  // File-level escape hatch: a `// lint-tests-skip-file: <reason>`
  // comment in the first ~10 lines bails out entirely. Use only for
  // meta-tests that legitimately need to embed examples of the leak
  // pattern (e.g. test/v016-lint-tests.test.mjs).
  if (lines.slice(0, 10).some((l) => /\blint-tests-skip-file\b/.test(l))) {
    return issues;
  }

  let inTest = false;
  let testStartLine = 0;
  let depthAtTestStart = 0;
  let depth = 0;
  /** @type {number[]} */
  let tryStack = [];
  /** @type {{ openerLine: number, openerSource: string } | null} */
  let watch = null;
  let allowOne = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = preprocess(raw);

    const delta = braceDelta(code);
    const depthBefore = depth;
    const depthAfter = depth + delta;

    // Enter test callback.
    if (!inTest && TEST_START.test(raw)) {
      inTest = true;
      testStartLine = i + 1;
      depthAtTestStart = depthAfter;
      tryStack = [];
      watch = null;
      allowOne = false;
      depth = depthAfter;
      continue;
    }

    if (inTest) {
      // Pop try frames that are now closed.
      while (tryStack.length > 0 && depthAfter <= tryStack[tryStack.length - 1]) {
        tryStack.pop();
        // Exiting a try block clears any pending watch — we're past the
        // safe harbour anyway.
        watch = null;
      }

      // Detect `try {` on this line — pushes a frame at depth-before.
      if (TRY_START.test(code)) {
        tryStack.push(depthBefore);
        // Reaching `try {` makes any outside-try opener safe.
        watch = null;
      }

      const opener = isOpener(code);
      const insideTry = tryStack.length > 0;

      // Rule check: if we're watching and this line has `await` that
      // is not itself an opener, flag.
      if (watch && AWAIT_KW.test(code) && !opener) {
        if (allowOne) {
          allowOne = false;
        } else {
          issues.push({
            file: relative(ROOT, file),
            line: i + 1,
            test_line: testStartLine,
            opener_line: watch.openerLine,
            source: raw.trim(),
            opener_source: watch.openerSource,
          });
          // One report per opener.
          watch = null;
        }
      }

      // Note an opener.
      if (opener) {
        if (insideTry) {
          // Case (1) — safe.
        } else if (watch) {
          // Two openers in series outside try. The first is at risk
          // because if THIS opener throws, the first leaks. Flag the
          // first, then re-watch from this one in case more await
          // follows.
          if (allowOne) {
            allowOne = false;
          } else {
            issues.push({
              file: relative(ROOT, file),
              line: i + 1,
              test_line: testStartLine,
              opener_line: watch.openerLine,
              source: raw.trim(),
              opener_source: watch.openerSource,
            });
          }
          watch = { openerLine: i + 1, openerSource: raw.trim() };
        } else {
          // Case (2) — start watching.
          watch = { openerLine: i + 1, openerSource: raw.trim() };
        }
      }

      if (ALLOW_NEXT.test(raw)) allowOne = true;

      depth = depthAfter;

      // Exit the test callback?
      if (depth < depthAtTestStart) {
        inTest = false;
        tryStack = [];
        watch = null;
        allowOne = false;
      }
    } else {
      depth = depthAfter;
    }
  }

  return issues;
}

const args = process.argv.slice(2);
const flags = { json: args.includes('--json') };

const entries = await readdir(TEST_DIR);
const files = entries
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join(TEST_DIR, f));

const allIssues = [];
for (const f of files) {
  const issues = await lintFile(f);
  allIssues.push(...issues);
}

if (flags.json) {
  process.stdout.write(JSON.stringify({
    total: allIssues.length,
    issues: allIssues,
  }, null, 2) + '\n');
  process.exit(allIssues.length === 0 ? 0 : 1);
}

if (allIssues.length === 0) {
  console.log(`✓ lint-tests: every resource-opener in ${files.length} test files is safe`);
  process.exit(0);
}

console.error(`✗ lint-tests: ${allIssues.length} resource-leak risk(s) detected\n`);
for (const it of allIssues) {
  console.error(`  ${it.file}:${it.line}  (opener at L${it.opener_line}, in test starting L${it.test_line})`);
  console.error(`    opener: ${it.opener_source}`);
  console.error(`    risk:   ${it.source}`);
}
console.error('');
console.error('Rule: opener-must-reach-try-without-await');
console.error('  Within a test() callback, every resource-opener must be');
console.error('  EITHER inside a try { ... } block, OR followed by a try { ... }');
console.error('  block with no intervening `await`. Any await between an');
console.error('  outside-try opener and the next try is a chance for the');
console.error('  opener to leak (the v0.0.14 → v0.0.15 Windows hang).');
console.error('');
console.error('Fix shape — wrap everything in try:');
console.error('  let srv, tmp;');
console.error('  try {');
console.error('    ({ srv } = await startServer(...));');
console.error('    tmp = await mkdtemp(join(tmpdir(), \'x-\'));');
console.error('    ...');
console.error('  } finally {');
console.error('    if (srv) srv.close();');
console.error('    if (tmp) await rm(tmp, { recursive: true, force: true });');
console.error('  }');
console.error('');
console.error('Escape hatch: `// lint-tests-allow-next: <reason>` above');
console.error('a single line silences the check once.');
process.exit(1);
