<!-- SPDX-License-Identifier: MIT -->

<p align="center">
  <img src="https://cloudcdn.pro/stratos/v1/logos/stratos.svg" alt="Stratos logo" width="128" />
</p>

<h1 align="center">stratos</h1>

<p align="center">
  Official command-line client for <a href="https://cloudcdn.pro">CloudCDN</a> —
  full control plane in a single zero-dependency Node ≥ 20 script.
</p>

<p align="center">
  <a href="https://github.com/sebastienrousseau/stratos/actions"><img src="https://img.shields.io/github/actions/workflow/status/sebastienrousseau/stratos/ci.yml?style=for-the-badge&logo=github" alt="Build" /></a>
  <a href="https://github.com/sebastienrousseau/stratos/releases"><img src="https://img.shields.io/github/v/release/sebastienrousseau/stratos?style=for-the-badge&color=fc8d62" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/@cloudcdn/stratos"><img src="https://img.shields.io/npm/v/@cloudcdn/stratos.svg?style=for-the-badge&color=cb3837&logo=npm" alt="npm" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge" alt="MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 20+" /></a>
</p>

---

## What's new in v0.0.2

- ~30 commands covering insights, zones, tokens, webhooks, storage, logs,
  AI, image ops, pipeline, search, and the full control plane.
- `stratos mcp serve` — Model Context Protocol stdio server so Claude Code,
  Cursor, and any MCP host can drive CloudCDN.
- Shell completions, config profiles, `--json`/`--quiet`/`--verbose`,
  `--timeout`/`--retries` with full-jitter backoff, sysexits-style exit codes.
- Errors now go to **stderr** so pipelines stay clean.
- 43-test in-repo suite (`node --test`, zero deps). Multi-tag purge bug fixed.

See [CHANGELOG.md](CHANGELOG.md) for the full list (and the breaking changes).

---

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Authentication & profiles](#authentication--profiles)
- [Commands](#commands)
- [Output, exit codes, environment](#output-exit-codes-environment)
- [MCP server](#mcp-server)
- [Examples](#examples)
- [Integrity & supply chain](#integrity--supply-chain)
- [Development](#development)
- [Security](#security)
- [License](#license)

---

## Install

Stratos is a single-file Node ≥ 20 script. Three supported channels:

| Channel | Install |
|---|---|
| **npm** | `npm install -g @cloudcdn/stratos` |
| **macOS / Linux** | `curl -sL https://cloudcdn.pro/dist/stratos/install.sh \| bash` |
| **Windows (PowerShell)** | `irm https://cloudcdn.pro/dist/stratos/install.ps1 \| iex` |
| **From source** | `git clone … && node stratos.mjs …` |

Both installers verify a pinned SHA-256 of the script before atomic install.
Override the install prefix with `STRATOS_PREFIX`:

```bash
curl -sL https://cloudcdn.pro/dist/stratos/install.sh | STRATOS_PREFIX=$HOME/bin bash
```

`npm install -g @cloudcdn/stratos` publishes with **Sigstore-backed npm
provenance** — verify with `npm audit signatures`.

---

## Quick Start

```bash
$ stratos version
stratos v0.0.2

$ stratos health
{ "status": "ok", "bindings": { "ai": true, "kv": true, "d1": true, "r2": true } }

$ stratos completion zsh >> ~/.zshrc   # tab-complete subcommands

$ export CLOUDCDN_ACCOUNT_KEY="…"
$ stratos purge https://cloudcdn.pro/akande/v1/logos/logo.svg
$ stratos purge --tag build-${GITHUB_SHA} --tag project-akande
$ cat urls.txt | stratos purge -
```

---

## Authentication & profiles

Three sources, highest precedence first:

1. **Per-command flags** — `--account-key`, `--access-key`, `--url`, `--secret`.
2. **Environment variables** — see table below.
3. **Profile file** — `~/.config/stratos/config.json`, selected by
   `--profile <name>` or `STRATOS_PROFILE`.

| Env var | Purpose |
|---|---|
| `CLOUDCDN_URL` | API base URL (default `https://cloudcdn.pro`) |
| `CLOUDCDN_ACCOUNT_KEY` | Control plane: purge, zones, rules, tokens, webhooks |
| `CLOUDCDN_ACCESS_KEY` | Read-only: assets, insights, search |
| `SIGNED_URL_SECRET` | HMAC secret for `signed` (offline) |
| `STRATOS_PROFILE` | Default profile name |
| `CLOUDCDN_TIMEOUT` | Per-request timeout in ms (default 15000) |
| `CLOUDCDN_RETRIES` | Max retries on 429/5xx/network (default 3) |
| `NO_COLOR` | Disable ANSI output |

Profile setup:

```bash
stratos config set prod.url        https://cloudcdn.pro
stratos config set prod.account_key cdnsk_xxx…
stratos config set staging.url     https://staging.cloudcdn.example
stratos config list

# Then everywhere:
stratos --profile prod purge --tag build-123
STRATOS_PROFILE=staging stratos health --deep
```

The config file is written with mode `0600`.

---

## Commands

### Edge ops

| Command | What it does |
|---|---|
| `version`, `-v`, `--version` | Print version |
| `help [<topic>]`, `-h`, `--help` | Print help; per-command `--help` too |
| `health [--deep]` | `GET /api/health` |
| `purge <url>...` | Invalidate by URL |
| `purge --tag <t>...` | Invalidate by Cache-Tag (repeats allowed) |
| `purge --everything` | Wipe edge cache (hard-rate-limited) |
| `purge --dry-run` | Preview the payload, no network call |
| `purge -` | Read URLs from stdin (one per line) |
| `signed <path> --expires <ts> [--secret <key>]` | Offline HMAC-SHA256 URL |

### Catalog & insights

| Command | What it does |
|---|---|
| `assets [--project] [--format] [--page] [--all]` | Paginated catalog; `--all` walks every page |
| `assets show <path>` | Single-asset metadata |
| `insights summary [--days N] [--zone Z]` | Requests, bandwidth, cache ratio |
| `insights top [--limit N] [--days N]` | Top requested assets |
| `insights asset <path> [--days N]` | Per-asset traffic |
| `insights errors [--days N]` | 4xx/5xx breakdown |
| `insights geo [--days N]` | Country distribution |
| `stats [--days N] [--zone Z]` | `/api/core/statistics` |
| `analytics query [...]` | `/api/analytics` filter |
| `audit [--action A] [--days N]` | Immutable audit trail |

### Zones, rules, tokens, webhooks

| Command | What it does |
|---|---|
| `zones list \| create <name> \| show <id> \| rm <id> --force` | Tenant zones |
| `zones domains add <id> <hostname>` | Add a custom domain |
| `rules get <_headers\|_redirects>` | Read the edge config file |
| `rules set <_headers\|_redirects> -f <file>` | Write it back via Git |
| `rules diff <_headers\|_redirects> -f <file>` | Diff local vs. edge (exit 0 / 69) |
| `tokens list \| create --name N --scopes S,S \| rm <id>` | Scoped API tokens |
| `webhooks list \| add --url U --events E,E \| rm <id>` | Event subscriptions |

### Storage

| Command | What it does |
|---|---|
| `storage put <local> <remote>` | Single-file upload |
| `storage get <remote> [<local>]` | Download (stdout if no `<local>`) |
| `storage rm <remote>` | Delete |
| `storage ls <prefix>` | List under a prefix |
| `storage sync <dir> <prefix>` | Recursive upload via `/api/storage/batch` (50/req) |

### AI, image, media

| Command | What it does |
|---|---|
| `ai alt \| moderate \| crop \| bg-remove <url>` | AI vision endpoints |
| `image transform <url> [--w --h --fit --format --q --blur --sharpen]` | Resize/convert |
| `image blurhash <url> [--size N]` | BlurHash placeholder |
| `image lqip <url> [--size N] [--blur N]` | Tiny blurred placeholder |
| `image auto <path>` | Format negotiation |
| `stream <video> [--quality Q] [--segment N]` | HLS playlist or segment URL |

### Pipeline & discovery

| Command | What it does |
|---|---|
| `pipeline submit --svg <file> --name N` | Asset-scaffold from an SVG |
| `search <query> [--limit N]` | Hybrid asset search |
| `ask <message>` | CloudCDN AI concierge |
| `logs tail [--level L]` | SSE-stream live logs |
| `logs query [--days N] [--level L] [--limit N]` | Historical logs |

### Meta

| Command | What it does |
|---|---|
| `completion <bash\|zsh\|fish\|powershell>` | Emit completion script |
| `upgrade` | Re-run the latest pinned installer |
| `config get \| set \| list` | Profile management |
| `login` \| `login status` \| `logout` | Store keys in the OS keychain |
| `doctor` | Diagnose env, credentials, network |
| `bench [-n N]` | Cold-start + N latency samples |
| `mcp serve` | Run as an MCP server over stdio |

### Global options

`--json` (force JSON), `-q`/`--quiet` (suppress info), `--verbose` (trace
requests), `--profile <name>`, `--url <url>`, `--account-key <key>`,
`--access-key <key>`, `--timeout <ms>`, `--retries <n>`.

Run `stratos <command> --help` for per-command detail.

---

## Output, exit codes, environment

**Output.** Default is pretty JSON on TTY, compact JSON on pipe.
List-shaped commands (assets, zones, tokens, …) render a table on TTY and
JSON when piped or with `--json`. Diagnostics (`info:`, `warning:`, `error:`)
go to **stderr**, never stdout.

**Exit codes** (sysexits-style):

| Code | Meaning |
|---|---|
| `0` | Success |
| `64` | Usage / bad CLI args |
| `69` | Service unavailable (4xx other than auth) |
| `75` | Tempfail — 5xx, 429, or network after retries exhausted |
| `77` | Permission denied (401 / 403) |
| `78` | Config error (missing key, unreadable config file) |
| `70` | Software error (uncaught exception) |
| `130` | Interrupted (SIGINT) |

---

## MCP server

Stratos can speak [Model Context Protocol](https://modelcontextprotocol.io)
over stdio, exposing 10 CloudCDN tools (purge, assets, insights, AI, signed
URLs, search, log query, …) to any MCP host.

**Claude Code** — add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "cloudcdn": { "command": "stratos", "args": ["mcp", "serve"] }
  }
}
```

**Cursor / Continue / any MCP host** — same shape; point at `stratos mcp serve`.

The server inherits env vars from the host, so `CLOUDCDN_ACCOUNT_KEY` in your
shell is what the agent calls with.

---

## Examples

Daily smoke test against production:

```bash
stratos health --deep | jq '.bindings | to_entries[] | select(.value != true)'
```

CI cache invalidation after a deploy:

```bash
export CLOUDCDN_ACCOUNT_KEY="$CLOUDCDN_PROD_KEY"
stratos purge --tag "build-${GITHUB_SHA}" --tag "project-akande"
```

Short-lived signed URL for a client preview:

```bash
EXPIRES=$(($(date +%s) + 600))
stratos signed "/clients/$CLIENT/preview.pdf" --expires "$EXPIRES"
```

Tail live edge logs (Ctrl-C clean):

```bash
stratos logs tail --level error
```

Recursive site upload with concurrency:

```bash
stratos storage sync ./dist /sites/acme --concurrency 16
```

Batch AI alt-text generation:

```bash
stratos assets --format=jpg --json | jq -r '.[].Path' \
  | xargs -I{} -P4 stratos ai alt "https://cloudcdn.pro{}"
```

More recipes: see [`examples/`](examples/).

---

## Integrity & supply chain

- **Pinned SHA-256.** Both installers verify the downloaded `stratos.mjs`
  against a SHA-256 constant baked into the installer itself.
- **npm provenance.** Releases publish with
  `npm publish --provenance` — Sigstore-backed attestation. Verify with:

  ```bash
  npm audit signatures
  ```

- **Build provenance.** Each tagged release attaches a GitHub
  `actions/attest-build-provenance` attestation for `stratos.mjs`.
- **Signed commits.** Every commit on `main` is SSH ED25519 signed.
- **No telemetry.** Every network call is initiated by an explicit command.
- **Offline `signed`.** The HMAC mint runs in-process; the secret never
  leaves the host.

Manual verification:

```bash
curl -fsSL https://cloudcdn.pro/dist/stratos/stratos.mjs -o stratos.mjs
shasum -a 256 stratos.mjs
# Compare against EXPECTED_SHA in install/install.sh
```

---

## Development

Stratos is a single ES module with no runtime dependencies.

```
.
├── stratos.mjs              # the CLI (~1500 LoC, no deps)
├── install/
│   ├── install.sh           # POSIX installer
│   └── install.ps1          # Windows installer
├── test/                    # 43 tests, node --test
│   ├── parse.test.mjs
│   ├── router.test.mjs
│   ├── signed.test.mjs
│   ├── http.test.mjs        # uses in-process mock HTTP server
│   └── mcp.test.mjs
├── examples/                # cookbook recipes
├── .github/workflows/
│   ├── ci.yml               # Node 20/22/24 × {ubuntu, macos, windows}
│   └── release.yml          # npm publish --provenance on tag
├── README.md · CHANGELOG.md · SECURITY.md · CONTRIBUTING.md · LICENSE
└── package.json
```

Run the suite:

```bash
npm test
# or:
node --test test/parse.test.mjs test/router.test.mjs test/signed.test.mjs \
            test/http.test.mjs test/mcp.test.mjs
```

Run locally without installing:

```bash
node stratos.mjs version
node stratos.mjs health
```

---

## Security

See [SECURITY.md](SECURITY.md) for the disclosure policy and supported
versions. Report vulnerabilities privately to
[`sebastian.rousseau@gmail.com`](mailto:sebastian.rousseau@gmail.com).

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

Licensed under the [MIT License](LICENSE).

See [CHANGELOG.md](CHANGELOG.md) for release history.

<p align="right"><a href="#contents">Back to Top</a></p>
