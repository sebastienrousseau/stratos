# Security Policy

## Supported versions

Stratos uses a small-increment policy: every release at this stage is a
`v0.0.x` bump. The most recent `v0.0.x` is supported; earlier `v0.0.x`
releases are not. There is no `v0.1.x` yet and won't be until the project
has accumulated genuine community traction.

| Version | Supported |
|---------|-----------|
| 0.0.4   | ✅        |
| 0.0.3   | ⚠️ (superseded; missing `explain` / `init` / MCP Resources & Prompts / single-binary builds) |
| 0.0.2   | ❌ (please upgrade) |
| 0.0.1   | ❌ (please upgrade — multi-tag purge bug, no fetch timeout) |

## Reporting a vulnerability

**Do not open a public GitHub issue.** Email
[`sebastian.rousseau@gmail.com`](mailto:sebastian.rousseau@gmail.com) with:

- a description of the issue and its impact,
- exact reproduction steps (a minimal repo or commands is ideal),
- the affected version of Stratos and Node.js,
- your preferred channel for follow-up.

If you need encrypted contact, request a public key in the first message
and you will receive one before any sensitive detail is exchanged.

### Response SLA

- **Triage:** within 3 business days.
- **Mitigation plan:** within 10 business days for high/critical severity.
- **Coordinated disclosure window:** 90 days by default; we can extend or
  shorten by mutual agreement.

We credit reporters in the release notes unless you ask not to be named.

## Supply chain & build provenance

Each tagged release attaches:

- **npm provenance** (`npm publish --provenance`) — Sigstore-backed
  attestation of the build. Verify with:

  ```bash
  npm audit signatures
  ```

- **npm Trusted Publishers (OIDC).** From v0.0.4 onward, the release
  workflow does not consume an `NPM_TOKEN` secret. Instead, npm 11.5+
  exchanges the GitHub-Actions OIDC token for a short-lived publish
  token scoped to:
  - owner: `sebastienrousseau`
  - repo: `stratos`
  - workflow: `.github/workflows/release.yml`
  - environment: `npm` (GitHub deployment environment for additional
    review/approval gates)

  This means there is no long-lived publish token sitting in repo
  secrets — a leak vector that npm's own threat model has flagged as
  the highest-risk pattern.

- **GitHub build provenance** (`actions/attest-build-provenance`) — an
  attestation for `stratos.mjs` linked to the workflow run that produced it.
  Verify with:

  ```bash
  gh attestation verify stratos.mjs --owner sebastienrousseau
  ```

- **Pinned SHA-256** baked into `install/install.sh` and `install/install.ps1`.

Both installers verify the downloaded `stratos.mjs` against the pinned hash
before atomic install. Tampered CDN responses are rejected on disk write.

## Defensive design choices

- **No runtime dependencies** — zero `node_modules` in the install footprint
  means no transitive supply-chain exposure.
- **No telemetry, no auto-update polling** — every network call originates
  from an explicit command.
- **Offline `signed`** — the HMAC mint runs in-process. `SIGNED_URL_SECRET`
  never leaves the host.
- **Length-prefixed HMAC canonicalisation** — `<len>:<path>|<len>:<expires>`
  prevents signature collisions for paths containing the `|` delimiter.
- **Least-privilege auth headers** — read-only routes prefer `AccessKey`;
  `AccountKey + x-api-key` only on control-plane routes.
- **AbortController timeouts + bounded retries** — 15 s default per request,
  3 attempts max with full-jitter exponential backoff. CI never hangs forever.
- **Signed commits** — every commit on `main` is SSH ED25519 signed.

## Known limitations (treat as out-of-scope)

- Credentials in environment variables are visible to other processes
  running as the same user via `/proc/$PID/environ` (Linux) or `ps -E`
  (BSD). OS-keychain integration is on the roadmap for v0.3.
- The `signed` command's HMAC secret strength is the responsibility of the
  operator — Stratos does not enforce minimum length or entropy.
- `stratos upgrade` re-runs the installer but cannot roll back atomically;
  pin a version with `STRATOS_VERSION=…` for reproducible installs.
