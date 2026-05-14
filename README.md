<!-- SPDX-License-Identifier: MIT -->

<p align="center">
  <img src="https://cloudcdn.pro/shared/logos/stratos.svg" alt="Stratos logo" width="128" />
</p>

<h1 align="center">stratos</h1>

<p align="center">
  Official command-line client for <a href="https://cloudcdn.pro">CloudCDN</a> — health, cache purge, signed URLs, and asset catalog from a single Node ≥ 18 script.
</p>

<p align="center">
  <a href="https://github.com/sebastienrousseau/stratos/actions"><img src="https://img.shields.io/github/actions/workflow/status/sebastienrousseau/stratos/ci.yml?style=for-the-badge&logo=github" alt="Build" /></a>
  <a href="https://github.com/sebastienrousseau/stratos/releases"><img src="https://img.shields.io/github/v/release/sebastienrousseau/stratos?style=for-the-badge&color=fc8d62" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/@cloudcdn/stratos"><img src="https://img.shields.io/npm/v/@cloudcdn/stratos.svg?style=for-the-badge&color=cb3837&logo=npm" alt="npm" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge" alt="MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A518-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 18+" /></a>
</p>

---

## Contents

**Getting started**

- [Install](#install) — one-liner, manual, from source
- [Quick Start](#quick-start) — health check in three lines
- [Authentication](#authentication) — account key vs. access key

**Reference**

- [Commands](#commands) — `version`, `health`, `purge`, `signed`, `assets`
- [Environment variables](#environment-variables) — `CLOUDCDN_URL`, keys, secrets
- [Exit codes](#exit-codes) — what each non-zero exit means

**Operational**

- [Examples](#examples) — copy-paste recipes
- [Integrity verification](#integrity-verification) — checking the installer
- [Development](#development) — running tests, layout
- [Security](#security) — supply chain, signing
- [License](#license)

---

## Install

The `stratos` CLI is a single-file Node ≥ 18 script (uses built-in
`fetch` and `crypto.subtle`). One-line installers fetch the script
from the CloudCDN edge, verify a pinned SHA-256, and drop a `stratos`
shim on `PATH`.

| Channel | Install |
|---|---|
| macOS / Linux (one-liner) | `curl -sL https://cloudcdn.pro/dist/stratos/install.sh \| bash` |
| Windows (PowerShell) | `irm https://cloudcdn.pro/dist/stratos/install.ps1 \| iex` |
| npm | `npm install -g @cloudcdn/stratos` *(planned)* |
| Manual | Download [`stratos.mjs`](https://cloudcdn.pro/dist/stratos/stratos.mjs), `chmod +x`, run `node stratos.mjs …` |
| From source | `git clone https://github.com/sebastienrousseau/stratos && cd stratos && node stratos.mjs …` |

The Unix installer drops the script under `$HOME/.local/lib/stratos/`
by default with a shim at `$HOME/.local/bin/stratos`. Override with
`STRATOS_PREFIX`:

```bash
curl -sL https://cloudcdn.pro/dist/stratos/install.sh | STRATOS_PREFIX=$HOME/bin bash
```

The Windows installer drops to
`%LocalAppData%\Programs\stratos\` with a `stratos.cmd` shim. Override
with `$env:STRATOS_PREFIX`.

Both installers verify a pinned SHA-256 of the script before atomic
install. The Unix path uses `sha256sum -c --status` (or `shasum -a
256 -c --status` on macOS); the Windows path uses `Get-FileHash`.

---

## Quick Start

```bash
$ stratos version
stratos v0.1.0

$ stratos health
{
  "status": "ok",
  "bindings": { "ai": true, "kv": true, "d1": true, "r2": true }
}

$ stratos help
stratos v0.1.0 — CloudCDN CLI
…
```

Set an account key once for control-plane operations:

```bash
export CLOUDCDN_ACCOUNT_KEY="…"
stratos purge https://cloudcdn.pro/akande/v1/logos/logo.svg
```

---

## Authentication

Stratos reads credentials from environment variables. Two keys cover
two privilege levels:

| Variable | Used for | Header sent |
|---|---|---|
| `CLOUDCDN_ACCOUNT_KEY` | Control plane: purge, configuration writes | `AccountKey` + `x-api-key` (on `/api/purge`) |
| `CLOUDCDN_ACCESS_KEY` | Read-only: assets listing, health, insights | `AccessKey` |
| `SIGNED_URL_SECRET` | HMAC for `signed` command (offline; no network) | n/a |

Per-command override:

```bash
stratos signed /clients/akande/private.pdf --expires 1700000000 --secret "$LOCAL_SECRET"
```

Issue and rotate keys from the [CloudCDN
dashboard](https://cloudcdn.pro/dashboard/).

---

## Commands

### `stratos version`

Print the CLI version and exit `0`.

### `stratos health [--deep]`

`GET /api/health`. `--deep` adds `?deep=1`, which exercises every
binding (KV, D1, R2, AI) instead of returning a flat liveness check.

```bash
stratos health
stratos health --deep
```

Exit codes: `0` on `200`, `1` on `4xx`, `2` on `5xx`.

### `stratos purge`

`POST /api/purge`. Requires `CLOUDCDN_ACCOUNT_KEY`. Three modes:

```bash
# By URL (1+ positional args, must start with the CDN origin)
stratos purge https://cloudcdn.pro/akande/v1/logos/logo.svg \
              https://cloudcdn.pro/akande/v1/logos/wordmark.svg

# By Cache-Tag (--tag may repeat or be a single value)
stratos purge --tag project-akande
stratos purge --tag project-akande --tag type-banner

# Everything (hard rate-limited at the server)
stratos purge --everything
```

### `stratos signed <path>`

Mint an HMAC-SHA256-signed URL for a private asset. Runs **offline** —
no network call. Use `--expires <unix-seconds>` for the validity
window and `--secret <key>` to override `SIGNED_URL_SECRET`.

```bash
stratos signed /clients/akande/private.pdf --expires $(($(date +%s) + 3600))
# https://cloudcdn.pro/api/signed?path=%2Fclients%2Fakande%2Fprivate.pdf&expires=…&sig=…
```

### `stratos assets`

`GET /api/assets`. Paginated catalog of CDN-served assets. Filters:

| Flag | Maps to |
|---|---|
| `--project=<name>` | `?project=<name>` (filter by project/zone) |
| `--format=<ext>` | `?format=<ext>` (filter by file extension) |
| `--page=<n>` | `?page=<n>` (1-based) |

```bash
stratos assets --project=akande --format=svg
stratos assets --page=2
```

### `stratos help` / `-h` / `--help`

Print the inline help text and exit `0`.

---

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `CLOUDCDN_URL` | API base URL | `https://cloudcdn.pro` |
| `CLOUDCDN_ACCOUNT_KEY` | Control-plane auth | unset |
| `CLOUDCDN_ACCESS_KEY` | Read-only auth | unset |
| `SIGNED_URL_SECRET` | HMAC secret for `signed` | unset |
| `STRATOS_PREFIX` | Install-location override (installer only) | platform default |

For staging or self-hosted CloudCDN edges:

```bash
export CLOUDCDN_URL="https://staging.cloudcdn.example"
export CLOUDCDN_ACCESS_KEY="…"
stratos health --deep
```

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Bad input (missing flag, no positional, unknown command), or `4xx` from API |
| `2` | Server error (`5xx` from API) or uncaught exception |

The body of any failing API call is printed to `stdout` (JSON-pretty)
before exit, so non-zero exits never swallow detail.

---

## Examples

Daily smoke test against production:

```bash
stratos health --deep | jq '.bindings | to_entries[] | select(.value != true)'
# (no output = all bindings healthy)
```

CI cache invalidation after a deploy:

```bash
export CLOUDCDN_ACCOUNT_KEY="$CLOUDCDN_PROD_KEY"
stratos purge --tag "build-${GITHUB_SHA}"
```

Short-lived signed URL for a client preview:

```bash
EXPIRES=$(($(date +%s) + 600))   # 10 minutes
stratos signed "/clients/$CLIENT/preview.pdf" --expires "$EXPIRES"
```

List all SVG assets in a project:

```bash
stratos assets --project=akande --format=svg | jq '.Data[].Path'
```

---

## Integrity verification

The published `stratos.mjs` is delivered with a pinned SHA-256 in
both installers. To verify a manual download against the live edge:

```bash
curl -fsSL https://cloudcdn.pro/dist/stratos/stratos.mjs -o stratos.mjs
shasum -a 256 stratos.mjs
# Expected (v0.1.0):
# 98306c394345fc18b8610c0113e6ef94f071ceba47de0f07eb45a9204effaf27
```

Source of truth: the `EXPECTED_SHA` constants in
[`install/install.sh`](install/install.sh) and
[`install/install.ps1`](install/install.ps1).

> **Note** Hashing via stdin (`curl … | shasum`) yields a different
> value because `curl` appends a trailing newline to stdout/pipes;
> the installers use `-o file` / `-OutFile` which writes the bytes
> verbatim. Verify against a file, not a pipe.

---

## Development

Stratos is a single ES module — no build step, no transpiler. The
canonical layout:

```
.
├── stratos.mjs         # the CLI (≤ 250 LOC, no dependencies)
├── install/
│   ├── install.sh      # POSIX installer (curl + sha256sum)
│   └── install.ps1     # Windows installer (Invoke-WebRequest + Get-FileHash)
├── README.md
├── CHANGELOG.md
├── LICENSE             # MIT
└── package.json
```

Run locally without installing:

```bash
node stratos.mjs version
node stratos.mjs health
```

Tests live in the parent [`cloudcdn.pro`](https://github.com/sebastienrousseau/cloudcdn.pro)
repo at `scripts/tests/stratos-cli.test.js` (43 tests, 100% line /
branch / function / statement coverage on `stratos.mjs`). A stand-
alone test harness is on the roadmap; for now any change to
`stratos.mjs` should be PR'd back to `cloudcdn.pro` first, where CI
gates the coverage.

---

## Security

- **No runtime dependencies.** Pure Node ≥ 18 standard library
  (`fetch`, `crypto.subtle`, `URLSearchParams`). Zero `node_modules`
  in the install footprint.
- **Pinned SHA-256.** Both installers verify the downloaded
  `stratos.mjs` against a SHA-256 constant baked into the installer
  itself; a tampered CDN response fails the check before the script
  reaches disk.
- **No telemetry.** Every network call is initiated by an explicit
  command. The CLI does not phone home, not even on errors.
- **Offline `signed` command.** The HMAC mint runs in-process
  against `SIGNED_URL_SECRET`; the secret never leaves the host.
- **Signed commits.** Every commit on `main` is SSH ED25519 signed.

Report security issues to
[`sebastian.rousseau@gmail.com`](mailto:sebastian.rousseau@gmail.com).
Please do not open public issues for vulnerabilities.

---

## License

Licensed under the [MIT License](LICENSE).

See [CHANGELOG.md](CHANGELOG.md) for release history.

<p align="right"><a href="#contents">Back to Top</a></p>
