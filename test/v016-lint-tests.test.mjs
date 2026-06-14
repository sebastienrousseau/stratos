// SPDX-License-Identifier: MIT
// lint-tests-skip-file: this file contains template-literal fixtures
// that intentionally embed the leak pattern to exercise lint-tests.mjs;
// the lint script itself would flag them as real violations.
//
// Phase 0 hardening: the lint-tests.mjs script must stay green AND it
// must actually catch the v0.0.14 → v0.0.15 Windows-hang shape (an HTTP
// listener opened outside a try/finally, then a setup throw between the
// opener and try). Both invariants are tested here against synthetic
// fixtures written to a tmpdir so we don't pollute test/.
//
// If a future contributor breaks the rule, this test fails locally and
// in CI before the hang ever reaches the Windows matrix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LINT = join(ROOT, 'scripts', 'lint-tests.mjs');

/**
 * Run lint-tests.mjs against a synthetic test/ directory and return
 * exit code + stdout/stderr.
 *
 * @param {string} testDir - Path containing one or more *.test.mjs files.
 * @returns {{status: number, stdout: string, stderr: string}}
 */
function runLint(testDir) {
  // The lint script reads `test/` relative to its own location, so we
  // run it from a fake repo root that has the script and a test dir.
  return spawnSync(process.execPath, [LINT, '--json'], {
    encoding: 'utf8',
    cwd: testDir,
    env: { ...process.env },
  });
}

/**
 * Build a fake repo with `scripts/lint-tests.mjs` (copied from the real
 * one) and `test/<file>.test.mjs` (with the given content), so we can
 * exercise the linter against arbitrary code without polluting the real
 * test directory.
 *
 * Returns the fake-repo's root.
 *
 * @param {string} testContent - JS that goes into test/synth.test.mjs.
 * @returns {Promise<{ root: string, run: () => ReturnType<typeof spawnSync> }>}
 */
async function fakeRepo(testContent) {
  const root = await mkdtemp(join(tmpdir(), 'stratos-lint-fixture-'));
  try {
    const { mkdir, copyFile } = await import('node:fs/promises');
    await mkdir(join(root, 'scripts'), { recursive: true });
    await mkdir(join(root, 'test'), { recursive: true });
    await copyFile(LINT, join(root, 'scripts', 'lint-tests.mjs'));
    await writeFile(join(root, 'test', 'synth.test.mjs'), testContent);
    return {
      root,
      run: () => spawnSync(process.execPath,
        [join(root, 'scripts', 'lint-tests.mjs'), '--json'],
        { encoding: 'utf8', cwd: root }),
    };
  } catch (e) {
    await rm(root, { recursive: true, force: true });
    throw e;
  }
}

test('lint-tests: real repo passes', () => {
  const r = runLint(ROOT);
  assert.equal(r.status, 0,
    `lint-tests should pass on the real repo. stdout=${r.stdout} stderr=${r.stderr}`);
});

test('lint-tests: catches startServer+mkdtemp leak (the v0.0.14 bug shape)', async () => {
  // The exact regression shape — opener outside try, await between
  // opener and try. This is what hung Windows CI for 6 hours.
  const { root, run } = await fakeRepo(`
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function startServer() { return { srv: { close() {} } }; }

test('leak shape', async () => {
  const { srv } = await startServer();
  const tmp = await mkdtemp(join(tmpdir(), 'x-'));
  try {
  } finally {
    srv.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
`);
  try {
    const r = run();
    assert.equal(r.status, 1, `expected lint to flag the leak. stdout=${r.stdout}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.total >= 1, `expected ≥1 issue, got ${out.total}`);
    assert.match(JSON.stringify(out.issues), /await startServer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lint-tests: safe pattern (all inside try) passes', async () => {
  const { root, run } = await fakeRepo(`
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function startServer() { return { srv: { close() {} } }; }

test('safe shape', async () => {
  let srv, tmp;
  try {
    ({ srv } = await startServer());
    tmp = await mkdtemp(join(tmpdir(), 'x-'));
  } finally {
    if (srv) srv.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
});
`);
  try {
    const r = run();
    assert.equal(r.status, 0,
      `expected lint to pass for everything-inside-try. stdout=${r.stdout}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lint-tests: safe pattern (opener then immediate try) passes', async () => {
  // The lighter shape — opener outside try is fine as long as the very
  // next statement is try, with no intervening awaits.
  const { root, run } = await fakeRepo(`
import { test } from 'node:test';

async function startServer() { return { srv: { close() {} } }; }

test('safe lite shape', async () => {
  const { srv } = await startServer();
  try {
  } finally { srv.close(); }
});
`);
  try {
    const r = run();
    assert.equal(r.status, 0,
      `expected lint to pass for opener-then-try. stdout=${r.stdout}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('lint-tests: escape-hatch comment silences one violation', async () => {
  const { root, run } = await fakeRepo(`
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function startServer() { return { srv: { close() {} } }; }

test('with escape hatch', async () => {
  const { srv } = await startServer();
  // lint-tests-allow-next: synthetic await guaranteed not to throw
  const tmp = await mkdtemp(join(tmpdir(), 'x-'));
  try {
  } finally {
    srv.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
`);
  try {
    const r = run();
    assert.equal(r.status, 0,
      `escape hatch should suppress the violation. stdout=${r.stdout}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
