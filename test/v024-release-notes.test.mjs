// SPDX-License-Identifier: MIT
//
// v0.0.24 regression tests for code-scanning alerts #1 and #2: the
// extract-release-notes version argument was built into a regular
// expression with only `.` escaped, so a version such as `0.0.2[0-9]`
// matched a different section and `(` crashed the script.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const extract = (version) => spawnSync(process.execPath,
  [join(REPO, 'scripts', 'extract-release-notes.mjs'), version], { cwd: REPO, encoding: 'utf8' });

for (const version of ['0.0.2[0-9]', '0.0.2.', '0.0.*', '(', '0\\.0\\.23']) {
  test(`v0.0.24: extract-release-notes reads "${version}" literally`, () => {
    const r = extract(version);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /could not find a "## \[.*\]" section/);
  });
}

test('v0.0.24: extract-release-notes still finds an exact version, with or without v', () => {
  for (const version of ['0.0.23', 'v0.0.23']) {
    const r = extract(version);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^- \*\*Package licences\.\*\*/m);
    assert.doesNotMatch(r.stdout, /^## \[/m);
  }
});
