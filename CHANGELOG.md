# Changelog

All notable changes to `stratos` are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-05-14

First public release. Extracted from the
[`cloudcdn.pro`](https://github.com/sebastienrousseau/cloudcdn.pro)
repository, where the CLI has been developed and tested since
2026-05.

### Added

- **`stratos.mjs`** — single-file Node ≥ 18 CLI (no dependencies).
  Commands: `version`, `help`, `health [--deep]`, `purge <url> |
  --tag <tag> | --everything`, `signed <path> --expires
  <unix-seconds> [--secret <key>]`, `assets [--project=<name>]
  [--format=<ext>] [--page=<n>]`.
- **`install/install.sh`** — POSIX installer (macOS + Linux). Pinned
  SHA-256 verified via `sha256sum -c --status` / `shasum -a 256 -c
  --status`. Network resilient (`curl --connect-timeout 10 --retry
  3`). Atomic install via `install(1)`. Runtime-relative shim so the
  bin/lib pair is relocatable.
- **`install/install.ps1`** — Windows / PowerShell installer. SHA-256
  via `Get-FileHash`. Resilient (`Invoke-WebRequest -MaximumRetryCount
  3 -RetryIntervalSec 2 -TimeoutSec 30`). `try/finally` cleanup on
  partial-install failure.
- **Authentication** via environment variables: `CLOUDCDN_ACCOUNT_KEY`
  (control-plane), `CLOUDCDN_ACCESS_KEY` (read-only),
  `SIGNED_URL_SECRET` (offline HMAC for `signed`).
- **Endpoint override** via `CLOUDCDN_URL` (defaults to
  `https://cloudcdn.pro`). Lets you point Stratos at staging or
  self-hosted edges without recompiling.
- 43 unit tests in the parent `cloudcdn.pro` repository hitting
  100% line / branch / function / statement coverage on
  `stratos.mjs`.

[0.1.0]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.1.0
