#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Generate winget manifests for Stratos. The 1.12 schema requires three
// YAML files in a versioned subdirectory:
//
//   manifests/c/CloudCDN/Stratos/<version>/CloudCDN.Stratos.installer.yaml
//   manifests/c/CloudCDN/Stratos/<version>/CloudCDN.Stratos.locale.en-US.yaml
//   manifests/c/CloudCDN/Stratos/<version>/CloudCDN.Stratos.yaml
//
// Users land the manifests via a PR to microsoft/winget-pkgs. We emit
// the three files into `dist/winget/` so the release workflow can
// tarball them and attach to the GitHub release; the actual PR is a
// one-time setup similar to the Homebrew tap.
//
// Usage:
//   node scripts/make-winget.mjs <version>                     # writes to dist/winget/
//   node scripts/make-winget.mjs <version> --bin-dir <dir>     # use binaries in <dir>
//                                                              # to compute the real SHA
//   node scripts/make-winget.mjs <version> --dist-dir <dir>    # write to <dir>/winget/
//                                                              # instead of dist/winget/
//                                                              # (used by tests to isolate)

import { writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const version = process.argv[2];
if (!version) {
  process.stderr.write('usage: make-winget.mjs <version> [--bin-dir <dir>]\n');
  process.exit(1);
}

const binDirIdx = process.argv.indexOf('--bin-dir');
const binDir = binDirIdx >= 0 ? resolve(process.argv[binDirIdx + 1]) : null;

const distDirIdx = process.argv.indexOf('--dist-dir');
const distRoot = distDirIdx >= 0 ? resolve(process.argv[distDirIdx + 1]) : join(ROOT, 'dist');

const baseUrl = `https://github.com/sebastienrousseau/stratos/releases/download/v${version}`;

/**
 * Compute SHA-256 of a local file. Tries `--bin-dir` first (used by the
 * release workflow's `manifests` job, which runs after the binaries are
 * built and downloads them into a known dir), then the repo root.
 * Returns the upper-case hex or a placeholder if the file isn't there.
 */
async function fileSha(filename) {
  const candidates = binDir ? [join(binDir, filename), join(ROOT, filename)] : [join(ROOT, filename)];
  for (const p of candidates) {
    try {
      await access(p);
      const buf = await readFile(p);
      return createHash('sha256').update(buf).digest('hex').toUpperCase();
    } catch { /* try next */ }
  }
  return 'REPLACE_WITH_SHA256';
}

const installerSha = await fileSha('stratos-win-x64.exe');

const installer = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.12.0.schema.json
# SPDX-License-Identifier: MIT

PackageIdentifier: CloudCDN.Stratos
PackageVersion: ${version}
InstallerType: portable
Commands:
  - stratos
ReleaseDate: ${new Date().toISOString().slice(0, 10)}
Installers:
  - Architecture: x64
    InstallerUrl: ${baseUrl}/stratos-win-x64.exe
    InstallerSha256: ${installerSha}
    NestedInstallerType: portable
    NestedInstallerFiles:
      - RelativeFilePath: stratos-win-x64.exe
        PortableCommandAlias: stratos
ManifestType: installer
ManifestVersion: 1.12.0
`;

const locale = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.12.0.schema.json
# SPDX-License-Identifier: MIT

PackageIdentifier: CloudCDN.Stratos
PackageVersion: ${version}
PackageLocale: en-US
Publisher: CloudCDN
PublisherUrl: https://cloudcdn.pro
PublisherSupportUrl: https://github.com/sebastienrousseau/stratos/issues
Author: Sebastien Rousseau
PackageName: Stratos
PackageUrl: https://github.com/sebastienrousseau/stratos
License: MIT
LicenseUrl: https://github.com/sebastienrousseau/stratos/blob/main/LICENSE
ShortDescription: Official command-line client for CloudCDN.
Description: |-
  Stratos is the official command-line client and Node ESM library for CloudCDN.
  ~30 commands across the full control plane (purge, signed URLs, assets, insights,
  zones, tokens, webhooks, rules, storage, logs, AI, image transforms), an MCP
  stdio server, OpenTelemetry export, OS-keychain auth, shell completions, and a
  100%-tested zero-dependency single-file Node ≥ 20 implementation.
Tags:
  - cdn
  - cli
  - cloudcdn
  - mcp
  - opentelemetry
ManifestType: defaultLocale
ManifestVersion: 1.12.0
`;

const root = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.12.0.schema.json
# SPDX-License-Identifier: MIT

PackageIdentifier: CloudCDN.Stratos
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.12.0
`;

const outDir = join(distRoot, 'winget');
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'CloudCDN.Stratos.installer.yaml'), installer);
await writeFile(join(outDir, 'CloudCDN.Stratos.locale.en-US.yaml'), locale);
await writeFile(join(outDir, 'CloudCDN.Stratos.yaml'), root);

process.stdout.write(`wrote ${outDir}/CloudCDN.Stratos.{installer,locale.en-US,}.yaml\n`);
