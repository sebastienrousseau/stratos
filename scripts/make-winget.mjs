#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Generate winget manifests for Stratos. The 1.6 schema requires three
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
//   node scripts/make-winget.mjs <version>    # writes to dist/winget/

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const version = process.argv[2];
if (!version) {
  process.stderr.write('usage: make-winget.mjs <version>\n');
  process.exit(1);
}

const baseUrl = `https://github.com/sebastienrousseau/stratos/releases/download/v${version}`;

/** Compute SHA-256 of a local file (or return a placeholder if not yet built). */
async function fileSha(localPath) {
  try {
    await access(localPath);
    const buf = await readFile(localPath);
    return createHash('sha256').update(buf).digest('hex').toUpperCase();
  } catch {
    return 'REPLACE_WITH_SHA256';
  }
}

const installerSha = await fileSha(join(ROOT, 'stratos-win-x64.exe'));

const installer = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json
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
ManifestVersion: 1.6.0
`;

const locale = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json
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
ManifestVersion: 1.6.0
`;

const root = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json
# SPDX-License-Identifier: MIT

PackageIdentifier: CloudCDN.Stratos
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`;

const outDir = join(ROOT, 'dist', 'winget');
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'CloudCDN.Stratos.installer.yaml'), installer);
await writeFile(join(outDir, 'CloudCDN.Stratos.locale.en-US.yaml'), locale);
await writeFile(join(outDir, 'CloudCDN.Stratos.yaml'), root);

process.stdout.write(`wrote ${outDir}/CloudCDN.Stratos.{installer,locale.en-US,}.yaml\n`);
