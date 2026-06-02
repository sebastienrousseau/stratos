#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Generate a standalone CycloneDX 1.6 VEX (Vulnerability Exploitability
// eXchange) document for the current release. Re-issued every release.
//
// Stratos has zero runtime dependencies, so the active assertion is
// "no known affected vulnerabilities in this version of
// @cloudcdn/stratos". When a CVE is filed against us (or against a
// dev-only dep that's somehow surfaced), this script will be the place
// to add per-CVE entries.
//
// Output spec: https://cyclonedx.org/docs/1.6/json/#vulnerabilities
//
// Usage:
//   node scripts/make-vex.mjs <version>    # emits to stdout

import { randomUUID } from 'node:crypto';

const version = process.argv[2];
if (!version) {
  process.stderr.write('usage: make-vex.mjs <version>\n');
  process.exit(1);
}

const now = new Date().toISOString();

const doc = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: now,
    tools: [{
      vendor: 'cloudcdn',
      name: 'stratos-make-vex',
      version,
    }],
    component: {
      'bom-ref': `pkg:npm/@cloudcdn/stratos@${version}`,
      type: 'application',
      name: '@cloudcdn/stratos',
      version,
      purl: `pkg:npm/@cloudcdn/stratos@${version}`,
      description: 'Official command-line client for CloudCDN.',
      licenses: [{ license: { id: 'MIT' } }],
    },
  },
  // Stratos has zero runtime dependencies and no known affected
  // vulnerabilities at this version. We still publish an empty
  // `vulnerabilities` array so consumers can verify the document
  // exists rather than infer absence from missing data.
  vulnerabilities: [],
};

process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
