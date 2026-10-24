// SPDX-License-Identifier: MIT
//
// v0.0.23 regression tests for the 0.0.22 release findings:
//   (1) the Homebrew formula, Scoop manifest and winget manifest declared
//       `MIT` while package.json declares `Apache-2.0 OR MIT`
//   (2) the formula's install block failed `brew style`
//       (Style/HashLikeCase, Layout/EndAlignment), and its `version` line
//       failed `brew audit --strict` (redundant with the URL)
//   (3) tap-bump and scoop-bump pushed to protected main branches, which
//       now take changes only through pull requests
//   (4) v0.0.23: a run whose PR step failed left its branch behind, so a
//       rerun could not push the rebuilt commit (non-fast-forward)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = (name, args) => spawnSync(process.execPath, [join(REPO, 'scripts', name), ...args],
  { cwd: REPO, encoding: 'utf8' });
const pkgLicense = async () => JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')).license;

test('v0.0.23 fix #1: formula licence matches package.json', async () => {
  const ids = (await pkgLicense()).split(' OR ');
  const r = script('make-homebrew.mjs', ['0.0.23']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, new RegExp(`^  license any_of: \\[${ids.map((id) => `"${id}"`).join(', ')}\\]$`, 'm'));
});

test('v0.0.23 fix #1: Scoop manifest licence matches package.json', async () => {
  const tmpDist = await mkdtemp(join(tmpdir(), 'stratos-v023-scoop-'));
  try {
    assert.equal(script('make-scoop.mjs', ['0.0.23', '--dist-dir', tmpDist]).status, 0);
    const manifest = JSON.parse(await readFile(join(tmpDist, 'stratos.scoop.json'), 'utf8'));
    // Scoop writes a licence offered as a choice with `|`.
    assert.equal(manifest.license, (await pkgLicense()).split(' OR ').join('|'));
  } finally { await rm(tmpDist, { recursive: true, force: true }); }
});

test('v0.0.23 fix #1: winget manifest licence matches package.json', async () => {
  const tmpDist = await mkdtemp(join(tmpdir(), 'stratos-v023-winget-'));
  try {
    assert.equal(script('make-winget.mjs', ['0.0.23', '--dist-dir', tmpDist]).status, 0);
    const locale = await readFile(join(tmpDist, 'winget', 'CloudCDN.Stratos.locale.en-US.yaml'), 'utf8');
    assert.match(locale, new RegExp(`^License: ${await pkgLicense()}$`, 'm'));
  } finally { await rm(tmpDist, { recursive: true, force: true }); }
});

test('v0.0.23 fix #2: formula installs the downloaded binary without a case', () => {
  const r = script('make-homebrew.mjs', ['0.0.23']);
  assert.equal(r.status, 0);
  const install = r.stdout.match(/^  def install\n([\s\S]*?)^  end$/m);
  assert.ok(install, 'formula has an install block');
  assert.doesNotMatch(install[1], /\bcase\b/);
  // Every binary the install line can name is one the formula downloads.
  for (const os of ['darwin', 'linux']) {
    for (const arch of ['arm64', 'x64']) {
      assert.match(r.stdout, new RegExp(`url ".*/stratos-${os}-${arch}"`));
    }
  }
  assert.match(install[1], /bin\.install "stratos-#\{os\}-#\{arch\}" => "stratos"/);
});

test('v0.0.23 fix #2: formula takes its version from the release URL', () => {
  const r = script('make-homebrew.mjs', ['0.0.23']);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /^\s*version "/m);
  assert.match(r.stdout, /url "https:\/\/github\.com\/sebastienrousseau\/stratos\/releases\/download\/v0\.0\.23\/stratos-darwin-arm64"/);
});

test('v0.0.23 fix #3: tap-bump and scoop-bump open pull requests instead of pushing to main', async () => {
  // Windows checkouts may use CRLF; the job regex anchors on `\n`.
  const yaml = (await readFile(join(REPO, '.github', 'workflows', 'release.yml'), 'utf8')).replace(/\r\n/g, '\n');
  for (const job of ['tap-bump', 'scoop-bump']) {
    const body = yaml.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [a-z-]+:$)`, 'm'));
    assert.ok(body, `${job} job exists`);
    assert.match(body[1], /git switch -c "\$branch"/);
    assert.match(body[1], /git push --force --set-upstream origin "\$branch"/);
    assert.match(body[1], /gh pr create/);
    assert.doesNotMatch(body[1], /^\s+git push\s*$/m);
  }
});
