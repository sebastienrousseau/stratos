# Security-audit notes

This document captures the threat model the Stratos project operates
against, the controls already in place, the known limitations, and the
areas under active hardening. It complements
[`SECURITY.md`](./SECURITY.md) (which covers _how to report_ a
vulnerability) and is intended for security reviewers, downstream
distributors, and anyone evaluating Stratos for production use.

Last updated for v0.0.16.

## Trust model

Stratos is a **client-side tool**. It runs on the user's machine or in
the user's CI runner, with credentials the user has chosen to surface to
it. There is no Stratos-controlled server. There is no Stratos data
plane.

The trust boundaries are:

| Boundary | What's trusted | What's not |
|---|---|---|
| The Node runtime | Honest execution of `stratos.mjs` against the supplied env vars / flags / profile | Network responses (treated as untrusted) |
| The OS keychain | Read access to entries Stratos wrote | The keychain backend itself (we don't manage it) |
| `https://cloudcdn.pro` (or `CLOUDCDN_URL`) | The CloudCDN API as a service | The HTTP response body (treated as untrusted) |
| The published artefacts | npm `@cloudcdn/stratos`, GH-release binaries, the published installer scripts | Anything downloaded outside the verified channels |

## Adversaries we defend against

### 1. Supply-chain compromise of the published artefacts

**Concern:** an attacker pushes a tampered `stratos.mjs` or a tampered
binary to one of the eight distribution channels and a user installs it.

**Controls:**

- **npm provenance** (Trusted Publishers via GitHub Actions OIDC, no
  long-lived `NPM_TOKEN`). Verifiable with `npm audit signatures`.
- **SLSA L3 build provenance** for every release artefact via
  `slsa-framework/slsa-github-generator`. The `stratos-v<x>.intoto.jsonl`
  bundle is attached to the GitHub release and verifiable with
  `slsa-verifier`.
- **Cosign keyless signatures** (Sigstore Fulcio + Rekor transparency
  log) for `stratos.mjs`, the 5-architecture binaries, the installer
  scripts, the SBOM, and the VEX statement. The `.sig` and `.crt` files
  are alongside each artefact in the release.
- **Pinned `EXPECTED_SHA`** in both `install/install.sh` and
  `install/install.ps1`. The installers refuse to write a file whose
  SHA-256 doesn't match the pin; `scripts/check-versions.mjs` enforces
  the pin matches the actual `stratos.mjs` bytes pre-tag.
- **CycloneDX SBOM and VEX** attached to every release. Both are signed
  with Cosign keyless.
- **GitHub branch protection** on `main` requires PR review, CI green,
  and disallows force-push.

**Residual risks:** an attacker who compromises the maintainer's GitHub
account *and* their signing identity could push a tampered release.
Detection relies on the Rekor log and on downstream verification of
provenance. There is no second human in the release loop today —
addressing this is on the roadmap (see `GOVERNANCE.md` — adding
deputies).

### 2. Compromised dependencies

**Concern:** a runtime dependency is compromised and ships malicious code
to every user.

**Controls:**

- **Zero runtime dependencies.** This is the brand. Every line of
  `stratos.mjs` is the work of Stratos contributors and visible in the
  one file. `devDependencies` are `c8` for coverage only — they don't
  ship to users.
- **`dependencies` in `package.json` is asserted empty** at every
  release (the `npm publish --provenance` step would refuse to publish
  with vulnerable deps, and the SBOM would surface them — neither
  scenario applies since the dep tree is empty).

**Residual risks:** a future PR could introduce a runtime dep without
the reviewer catching it. The
[`CONTRIBUTING.md`](./CONTRIBUTING.md) ground rule and the PR-review
checklist exist to enforce this, but it's a process control, not a
technical one.

### 3. Credential theft from the user's machine

**Concern:** Stratos reads `CLOUDCDN_ACCOUNT_KEY`, `CLOUDCDN_ACCESS_KEY`,
`SIGNED_URL_SECRET`. An attacker with local access to the user's machine
recovers them.

**Controls:**

- **OS keychain preferred.** `stratos login --account-key=…` stores the
  key in the platform's native secret store (`security` on macOS,
  `secret-tool` on Linux, `cmdkey` on Windows). The keychain is
  per-user, encrypted-at-rest, and gated by the OS login session.
- **`STRATOS_NO_KEYCHAIN=1`** opt-out for environments where the
  keychain is undesirable (CI without a tty, hermetic test runs).
- **Env vars never echoed to stderr.** Diagnostics that print
  configuration mask the credential values (`stratos login status`,
  `stratos doctor`).
- **No credentials written to disk** outside the keychain (the config
  file at `~/.config/stratos/config.json` does not contain secret values
  unless the user explicitly opted to store them there — and the file
  is written with mode `0600`).

**Residual risks:** environment variables are visible to any process in
the same process group (`ps e`, `/proc/<pid>/environ`). This is a Unix
fact, not a Stratos bug, but agents-as-credential-passers need to be
aware. Documented in `SECURITY.md`.

### 4. Server-spoofing of `CLOUDCDN_URL`

**Concern:** a user is tricked into setting `CLOUDCDN_URL` to an
attacker-controlled host that masquerades as CloudCDN.

**Controls:**

- **HTTPS is required** for the default endpoint; non-HTTPS is accepted
  for the `CLOUDCDN_URL` override to support local dev, but the
  responsibility lies with the user.
- **Auth headers are always sent.** The `AccountKey` / `AccessKey`
  headers would land at the attacker's server in a spoof scenario.
- **`stratos schema` is the recommended way for agents to discover the
  surface,** not by mining the CloudCDN API — so a spoofed server
  cannot trick an agent into invoking non-Stratos behaviour.

**Residual risks:** a user pointing Stratos at a hostile `CLOUDCDN_URL`
with a valid `CLOUDCDN_ACCOUNT_KEY` set will leak the key to that host
on the first command. This is the standard credential-handling tradeoff;
there's no way to fix it without a discovery / pin-the-cert mechanism
that the current design doesn't have.

### 5. Output-injection from a hostile API response

**Concern:** an API response contains characters that, when emitted on
the terminal, do something unwanted (ANSI escape sequences, terminal
control codes).

**Controls:**

- **`emit()` never escapes ANSI characters from server bodies.** It
  passes the body through `JSON.stringify` (for JSON / NDJSON mode) or
  uses a pre-built YAML / CSV serialiser, both of which already encode
  arbitrary characters safely. Table rendering on TTY uses field-width
  padding only — no terminal-interpretive sequences.
- **CI auto-defaults to `--json --quiet`** (see `detectCI`), which
  removes the table-rendering path entirely in CI contexts.

**Residual risks:** a user pointing `--output table` at a hostile server
and reading the output on a vt100-emulating terminal could in principle
see control-sequence injection. The defence-in-depth fix would be to
strip control bytes before emission; this is on the hardening roadmap.

### 6. Test-process leak that hangs CI

**Concern:** a malicious or accidentally-broken test leaves an HTTP
listener open and blocks the test runner from exiting, causing CI to
burn its full job timeout.

**Controls:**

- **`scripts/lint-tests.mjs`** flags any test that opens a resource
  (`await startServer`, `await mkdtemp`) outside a `try { ... } finally`
  block, or with intervening throwable code. CI gate on every PR.
- **Job-level `timeout-minutes:`** caps on every CI and release-pipeline
  job. The default 6h is now never inherited.
- **Regression test** (`test/v016-lint-tests.test.mjs`) asserts the
  linter both passes on the real repo and catches the leak shape.

This control exists because v0.0.14 → v0.0.15 had exactly this bug class
and burned ~54 compute-hours per run before being caught. See the v0.0.15
CHANGELOG.

## Hardening roadmap

The following items are under active consideration. Each is tracked
either as a roadmap item in `~/Drop/stratos-ip.md` or as an issue.

| Item | Status | Notes |
|---|---|---|
| Add second human in the release loop | Roadmap (Phase 4.5) | Recruit deputies, require co-approval for tagged releases |
| OpenSSF Best Practices badge | Roadmap (Phase 4) | Apply once Phase 1 + governance docs land |
| Reproducible builds | Goal | npm + binary builds; some inputs (timestamps) need pinning |
| Control-byte stripping for table mode | Open | Belt-and-braces for the residual risk in §5 |
| Public PGP key for security-disclosure mail | Open | `SECURITY.md` currently routes to plain email |
| Short-lived federated tokens (OIDC device flow) | Roadmap (Phase 2.4) | Removes long-lived `CLOUDCDN_ACCOUNT_KEY` for many use cases |

## Verifying a release

```bash
# Get the release.
gh release download v0.0.16 --repo sebastienrousseau/stratos

# Verify npm provenance.
npm audit signatures @cloudcdn/stratos@0.0.16

# Verify the SLSA bundle.
slsa-verifier verify-artifact stratos.mjs \
  --provenance-path stratos-v0.0.16.intoto.jsonl \
  --source-uri github.com/sebastienrousseau/stratos \
  --source-tag v0.0.16

# Verify the Cosign signature.
cosign verify-blob \
  --certificate stratos.mjs.crt \
  --signature  stratos.mjs.sig \
  --certificate-identity-regexp 'https://github.com/sebastienrousseau/stratos/' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  stratos.mjs

# Verify the install.sh pinned SHA.
shasum -a 256 stratos.mjs  # compare to install/install.sh's EXPECTED_SHA
```

If any of these fail, **do not install**. Open a security issue per
[`SECURITY.md`](./SECURITY.md).

## Contact

Security-sensitive reports: **sebastian.rousseau@gmail.com**. See
[`SECURITY.md`](./SECURITY.md) for the disclosure policy and SLAs.
