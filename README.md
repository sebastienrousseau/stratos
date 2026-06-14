<!-- SPDX-License-Identifier: MIT -->

<p align="center">
  <img src="https://cloudcdn.pro/stratos/v1/logos/stratos.svg" alt="Stratos logo" width="128" />
</p>

<h1 align="center">stratos</h1>

<p align="center">
  Official command-line client and Node ESM library for
  <a href="https://cloudcdn.pro">CloudCDN</a> — the full control plane in
  a single ~4,000-line, zero-dependency Node&nbsp;≥&nbsp;20 script.
</p>

<p align="center">
  <a href="https://github.com/sebastienrousseau/stratos/actions"><img src="https://img.shields.io/github/actions/workflow/status/sebastienrousseau/stratos/ci.yml?style=for-the-badge&logo=github" alt="Build" /></a>
  <a href="https://github.com/sebastienrousseau/stratos/releases"><img src="https://img.shields.io/github/v/release/sebastienrousseau/stratos?style=for-the-badge&color=fc8d62" alt="Release" /></a>
  <a href="https://www.npmjs.com/package/@cloudcdn/stratos"><img src="https://img.shields.io/npm/v/@cloudcdn/stratos.svg?style=for-the-badge&color=cb3837&logo=npm" alt="npm" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge" alt="MIT" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node 20+" /></a>
  <a href="#tests--coverage"><img src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=for-the-badge" alt="Coverage 100%" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/sebastienrousseau/stratos"><img src="https://img.shields.io/ossf-scorecard/github.com/sebastienrousseau/stratos?style=for-the-badge&label=OpenSSF%20Scorecard&logo=openssf" alt="OpenSSF Scorecard" /></a>
</p>

---

## Contents

**Getting started**

- [Install](#install) — eight channels, SHA-pinned installer
- [Quick Start](#quick-start) — verify, authenticate, purge in five lines
- [Why a single-file CLI?](#why-a-single-file-cli) — design rationale

**Companion artefacts**

- [Companion artefacts](#companion-artefacts) — composite GitHub Action, MCP server, Docker image
- [Migrating from another CDN CLI](#migrating-from-another-cdn-cli) — Wrangler, Fastly CLI, Codex CLI

**CLI reference**

- [Capabilities](#capabilities) — release inventory
- [Authentication & profiles](#authentication--profiles) — env, profile, keychain
- [Commands](#commands) — full command table
- [Programmatic API](#programmatic-api) — drive Stratos in-process
- [MCP server](#mcp-server) — agent integration
- [Machine-readable schema](#machine-readable-schema) — `stratos schema`
- [Output, exit codes, typed errors](#output-exit-codes-typed-errors) — pipeline contract

**Operational**

- [Examples](#examples)
- [When not to use Stratos](#when-not-to-use-stratos)
- [Integrity & supply chain](#integrity--supply-chain)
- [Development](#development)
- [Tests & coverage](#tests--coverage)
- [Release pipeline](docs/release-pipeline.md)
- [Security](#security)
- [Governance](#governance)
- [Documentation](#documentation)
- [License](#license)

---

## Install

Stratos ships as one ES module (`stratos.mjs`, ~4,000 lines, **zero runtime dependencies**). Eight distribution channels:

| Channel | Command |
|---|---|
| **npm** *(recommended)* | `npm install -g @cloudcdn/stratos` |
| **Homebrew** *(macOS / Linux, no Node required)* | `brew tap sebastienrousseau/tap && brew install sebastienrousseau/tap/stratos` |
| **winget** *(Windows)* | `winget install CloudCDN.Stratos` |
| **Scoop** *(Windows)* | `scoop bucket add sebastienrousseau https://github.com/sebastienrousseau/scoop-bucket && scoop install stratos` |
| **Single binary** *(no Node required)* | Download from [the latest release](https://github.com/sebastienrousseau/stratos/releases/latest) — `stratos-{linux-x64,linux-arm64,darwin-x64,darwin-arm64,win-x64.exe}`. Compiled with Bun; ~58 MB, ~20 ms cold start. |
| **macOS / Linux installer** | `curl -sL https://cloudcdn.pro/dist/stratos/install.sh \| bash` |
| **Windows (PowerShell)** | `irm https://cloudcdn.pro/dist/stratos/install.ps1 \| iex` |
| **From source** | `git clone https://github.com/sebastienrousseau/stratos && cd stratos && node stratos.mjs help` |

Override the installer prefix:

```bash
curl -sL https://cloudcdn.pro/dist/stratos/install.sh | STRATOS_PREFIX=$HOME/bin bash
```

Both shell installers verify a pinned SHA-256 of the script *before* writing it to disk. npm releases are published with **Sigstore-backed provenance** — verify with `npm audit signatures`. Every release also ships a SLSA L3 build provenance attestation (`stratos-v<version>.intoto.jsonl`) and a Cosign keyless signature for each canonical artefact — see [Integrity & supply chain](#integrity--supply-chain).

> **Module format:** `@cloudcdn/stratos` is **ESM only** (`"type": "module"`). Modern Node ≥ 20 consumes it directly with `import`. CommonJS callers use dynamic import: `const stratos = await import('@cloudcdn/stratos')`.

---

## Quick Start

<p align="center">
  <img src="docs/casts/health.gif" alt="stratos health" width="640" />
</p>

```bash
# Verify the install
stratos version
# → stratos v0.0.17

# Hit the public health endpoint
stratos health
# → { "status": "ok", "bindings": { "ai": true, "kv": true, "d1": true, "r2": true } }

# Set up tab completion (zsh shown; bash/fish/powershell also supported)
eval "$(stratos completion zsh)"

# Authenticate once, then drive the control plane
export CLOUDCDN_ACCOUNT_KEY="cdnsk_…"
stratos purge https://cloudcdn.pro/akande/v1/logos/logo.svg
stratos purge --tag "build-${GITHUB_SHA}" --tag project-akande
cat urls.txt | stratos purge -      # batch invalidate from stdin

# Stream NDJSON into jq for downstream pipelines
stratos assets --all --output ndjson | jq -r '.Path'

# Introspect the surface (agent caller's gateway)
stratos schema --output ndjson | jq -r 'select(.mcp_tool) | "\(.name) → \(.mcp_tool)"'
```

### In-terminal demos

| Command | Cast |
|---|---|
| **`stratos purge --tag … --dry-run`** | <img src="docs/casts/purge.gif" alt="stratos purge dry-run" width="520" /> |
| **`stratos signed …`** (offline HMAC mint) | <img src="docs/casts/signed.gif" alt="stratos signed" width="520" /> |
| **`stratos doctor`** | <img src="docs/casts/doctor.gif" alt="stratos doctor" width="520" /> |

> Re-record any cast with `node scripts/make-casts.mjs --render` — needs [`agg`](https://github.com/asciinema/agg) (`brew install agg`).

---

## Why a single-file CLI?

Most edge-platform CLIs ship as 30–80 MB Node bundles with hundreds of transitive dependencies. Stratos takes a deliberately different bet:

- **One file** — `stratos.mjs` is the entire CLI. No build step. No transpiler. The thing that runs is the thing you read.
- **Zero runtime dependencies** — only Node ≥ 20 standard library. No transitive supply-chain exposure. Zero `node_modules` in the install footprint.
- **One SHA-pin** — installers verify a single SHA-256 of the script before touching disk. Tampered CDN responses fail the check before anything is executed.
- **Cold-start under 70 ms on M-series** — measured by `stratos bench`. Suitable for CI hot loops and shell pipelines.
- **Errors to stderr, machine output to stdout** — pipelines like `stratos assets --output ndjson | jq …` stay clean.
- **Sysexits-style exit codes** *and* **stable typed errors** — `make` and shell `||` chains can branch on cause (`64 USAGE`, `77 NOPERM`, `75 TEMPFAIL`, …); agents drive backoff loops from `error.type` and `error.retryable`.
- **CLI is also a library** — every command is an exported ESM function; the test suite drives it in-process and you can too.

If those trade-offs match what you need, read on. If you'd prefer a richer SDK with a build pipeline, see [When not to use Stratos](#when-not-to-use-stratos).

---

## Companion artefacts

Three artefacts ship from this repo. The CLI is the core; the others wrap it for specific delivery surfaces.

| Artefact | What it is | Use case |
|---|---|---|
| **`@cloudcdn/stratos`** | The CLI and library (this README) | Local terminal, CI, scripts, in-process integration |
| **`sebastienrousseau/stratos/actions/stratos@v<x>`** | Composite GitHub Action | Drop-in CI step; auto-detects `GITHUB_ACTIONS`, emits `::error::` workflow commands on non-zero exit. See [`actions/stratos/README.md`](actions/stratos/README.md). |
| **`stratos mcp serve`** | Model Context Protocol stdio server (bundled) | Claude Code, Cursor, Continue.dev, Zed assistant, any MCP host — see [MCP server](#mcp-server) |
| **`ghcr.io/sebastienrousseau/stratos`** | Multi-arch Docker image (`linux/amd64`, `linux/arm64`) | Containerised CI runners; `docker run --rm ghcr.io/sebastienrousseau/stratos:latest version` |

---

## Migrating from another CDN CLI

Three step-by-step guides covering the equivalent commands, authentication mapping, and behavioural differences:

| Coming from… | Guide |
|---|---|
| **Cloudflare Wrangler** | [`examples/migrate-from-wrangler.md`](examples/migrate-from-wrangler.md) |
| **Fastly CLI** | [`examples/migrate-from-fastly.md`](examples/migrate-from-fastly.md) |
| **OpenAI Codex CLI** *(agentic-CLI patterns)* | [`examples/migrate-from-codex.md`](examples/migrate-from-codex.md) |

> Agent harnesses can introspect Stratos's full verb + error surface in one call via `stratos schema --output ndjson` — no `--help` parsing required. See [Machine-readable schema](#machine-readable-schema).

---

## Capabilities

Stratos covers ~35 commands across the full CloudCDN platform, grouped by concern.

| Theme | Capabilities |
|---|---|
| **Edge cache** | URL / Cache-Tag / wildcard purge, dry-run preview, stdin batching, offline length-prefixed HMAC-SHA256 signed URLs |
| **Catalog & analytics** | Paginated asset catalogue with `--all` auto-walk, per-asset metadata, insights (summary, top, asset, errors, geo), audit logs, raw analytics filter |
| **Multi-tenancy** | Zone create / list / show / delete, custom-domain attachment |
| **Config-as-code** | `_headers` / `_redirects` get / set / **LCS-based diff** (exits non-zero on drift, git-style) |
| **Auth & secrets** | Scoped API tokens, webhook subscriptions, `stratos login` → **OS keychain** (macOS `security`, libsecret, Windows `cmdkey`) |
| **Storage** | Single-file CRUD plus recursive `sync` over the batch endpoint, 50 files / request |
| **Observability** | SSE-streamed live `logs tail`, historical `logs query`, `doctor` env diagnostic, `bench` cold-start + latency sampler, **OTLP/HTTP tracing** via `--otlp-endpoint` (one span per command) |
| **AI & media** | Alt-text, moderation, smart-crop, background-remove; on-the-fly image `transform`, BlurHash, LQIP, format negotiation, HLS playlist builder |
| **Pipeline & discovery** | SVG-driven asset scaffolding, hybrid vector + fuzzy `search`, AI concierge (`ask`) |
| **Agent integration** | `stratos mcp serve` (10 tools / 6 resources / 4 prompts), **`stratos schema`** machine-readable command catalogue, **`--output ndjson`** streaming, **stable typed errors** (`error.type` + `retryable`) |
| **Operator UX** | Shell completions (bash/zsh/fish/PowerShell), XDG-compliant profiles, `--json`, `--output ndjson\|yaml\|csv\|table`, `--filter <jq>`, `-q`, `--verbose`, `--rate <n>/s` client-side throttle, configurable `--timeout` / `--retries` with full-jitter backoff |

---

## Authentication & profiles

Configuration is resolved from four sources, highest precedence first:

1. **Per-command flags** — `--account-key`, `--access-key`, `--cdn-url`, `--secret`, `--timeout`, `--retries`, `--profile`.
2. **Environment variables** — see table below.
3. **Profile file** — `~/.config/stratos/config.json` (XDG-compliant), selected with `--profile <name>` or `$STRATOS_PROFILE`.
4. **OS keychain** — populated via `stratos login`; suppressed by `STRATOS_NO_KEYCHAIN=1`.

| Env var | Purpose | Default |
|---|---|---|
| `CLOUDCDN_URL` | API base URL | `https://cloudcdn.pro` |
| `CLOUDCDN_ACCOUNT_KEY` | Control plane: purge, zones, rules, tokens, webhooks | unset |
| `CLOUDCDN_ACCESS_KEY` | Read-only: assets, insights, search | unset |
| `SIGNED_URL_SECRET` | HMAC secret for `signed` (offline) | unset |
| `STRATOS_PROFILE` | Default profile name | `default` |
| `CLOUDCDN_TIMEOUT` | Per-request timeout, ms | `15000` |
| `CLOUDCDN_RETRIES` | Max retries on 429 / 5xx / network | `3` |
| `STRATOS_NO_KEYCHAIN` | Set to `1` to skip OS-keychain lookups | unset |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP traces endpoint (alt to `--otlp-endpoint`) | unset |
| `OTEL_EXPORTER_OTLP_HEADERS` | OTLP exporter headers (`k=v,k=v`) | unset |
| `NO_COLOR` | Set to disable ANSI output | unset |

Profile setup is round-trippable via `stratos config`:

```bash
stratos config set prod.url        https://cloudcdn.pro
stratos config set prod.account_key cdnsk_xxx…
stratos config set staging.url     https://staging.cloudcdn.example
stratos config list

# Then everywhere:
stratos --profile prod purge --tag build-123
STRATOS_PROFILE=staging stratos health --deep
```

The config file is written with permission mode `0600`.

For the most secure setup, store keys in the OS keychain instead:

```bash
stratos login              # interactive prompt; writes to macOS Keychain / libsecret / cmdkey
stratos login status       # show resolved config with secrets masked
stratos logout             # clear all stratos secrets from the keychain
```

---

## Commands

### Edge ops

| Command | What it does |
|---|---|
| `version`, `-v`, `--version` | Print version |
| `help [<topic>]`, `-h`, `--help` | Print help; per-command `--help` too |
| `health [--deep]` | `GET /api/health` (add `?deep=1` with `--deep`) |
| `purge <url>...` | Invalidate by URL |
| `purge --tag <t>...` | Invalidate by Cache-Tag (repeats accumulate) |
| `purge --everything` | Wipe edge cache (hard-rate-limited) |
| `purge --dry-run` | Preview the payload without sending |
| `purge -` | Read URLs from stdin (one per line) |
| `signed <path> --expires <ts> [--secret <key>]` | Offline length-prefixed HMAC-SHA256 URL |

### Catalog & insights

| Command | What it does |
|---|---|
| `assets [--project] [--format] [--page] [--all]` | Paginated catalogue; `--all` walks every page (cap: 1,000) |
| `assets show <path>` | Single-asset metadata |
| `insights summary [--days N] [--zone Z]` | Requests, bandwidth, cache ratio |
| `insights top [--limit N] [--days N]` | Top requested assets |
| `insights asset <path> [--days N]` | Per-asset traffic |
| `insights errors [--days N]` | 4xx / 5xx breakdown |
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
| `rules diff <_headers\|_redirects> -f <file>` | LCS line diff; exits 0 if identical, 69 on drift |
| `tokens list \| create --name N --scopes S,S \| rm <id>` | Scoped API tokens |
| `webhooks list \| add --url U --events E,E \| rm <id>` | Event subscriptions |

### Storage

| Command | What it does |
|---|---|
| `storage put <local> <remote>` | Single-file upload |
| `storage get <remote> [<local>]` | Download (stdout if no `<local>`) |
| `storage rm <remote>` | Delete |
| `storage ls <prefix>` | List under a prefix |
| `storage sync <dir> <prefix>` | Recursive upload via `/api/storage/batch` (50 / req) |

### AI, image, media

| Command | What it does |
|---|---|
| `ai alt \| moderate \| crop \| bg-remove <url>` | AI vision endpoints |
| `image transform <url> [--w --h --fit --format --q --blur --sharpen]` | Resize / convert |
| `image blurhash <url> [--size N]` | BlurHash placeholder |
| `image lqip <url> [--size N] [--blur N]` | Tiny blurred placeholder |
| `image auto <path>` | Format negotiation |
| `stream <video> [--quality Q] [--segment N]` | HLS playlist or segment URL |

### Pipeline & discovery

| Command | What it does |
|---|---|
| `pipeline submit --svg <file> --name N` | Asset scaffold from an SVG |
| `search <query> [--limit N]` | Hybrid asset search |
| `ask <message>` | CloudCDN AI concierge |
| `logs tail [--level L]` | SSE-stream live logs |
| `logs query [--days N] [--level L] [--limit N]` | Historical logs |

### Meta

| Command | What it does |
|---|---|
| `init` | Interactive first-run setup; scriptable via flags |
| `schema [--output json\|ndjson\|yaml]` | **Machine-readable command catalogue** (drives MCP tool registration, completion, doc generation) |
| `completion <bash\|zsh\|fish\|powershell>` | Emit completion script |
| `upgrade` | Re-run the latest pinned installer |
| `config get \| set \| list \| edit` | Profile management; `edit` opens `$EDITOR` |
| `login` / `login status` / `logout` | Store keys in the OS keychain |
| `passkey` | WebAuthn ceremony bootstrapper (browser) |
| `doctor` | Diagnose env, credentials, network |
| `bench [-n N]` | Cold-start + N latency samples |
| `explain <code\|status>` | Cause + fix for an exit code or HTTP status |
| `mcp serve` | Run as an MCP server over stdio (10 tools, 6 resources, 4 prompts) |

### Global options

`--json` (force JSON), `--no-json` (opt out of CI auto-JSON), `--output <fmt>` (`json` / `ndjson` / `yaml` / `csv` / `table`; `jsonl` is an alias for `ndjson`), `--filter <jq-expr>` (pipe output through `jq`), `-q` / `--quiet` (suppress info), `--no-quiet` (opt out of CI auto-quiet), `--verbose` (trace requests), `--profile <name>`, `--cdn-url <url>`, `--account-key <key>`, `--access-key <key>`, `--timeout <ms>`, `--retries <n>`, `--rate <n>[/s]` (client-side rate limit for bulk ops), `--otlp-endpoint <url>`, `--otlp-headers k=v,k=v`.

When CI is detected (`GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD`, or `CI=true`), Stratos auto-enables `--json --quiet` and, on GitHub Actions, emits `::error::` workflow commands on non-zero exit so failures surface inline on PR/run pages. Override with `STRATOS_CI=0`.

Run `stratos <command> --help` for per-command detail.

---

## Programmatic API

Stratos is *also* a Node ESM library. Every command is an exported function you can drive in-process from your own application or test suite.

> **ESM only.** Use `import` from any Node ≥ 20 ES module. CommonJS callers use `await import('@cloudcdn/stratos')`.

#### Minting a signed URL from your application

```javascript
// signed-url-server.mjs — mint short-lived signed URLs from an Express handler.
import { cmdSigned } from '@cloudcdn/stratos';
import express from 'express';

const app = express();

app.get('/preview/:client/:file', async (req, res) => {
  // cmdSigned writes the URL to process.stdout, so capture stdout briefly.
  const captured = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { captured.push(chunk); return true; };

  try {
    const expires = Math.floor(Date.now() / 1000) + 600; // 10 minutes
    await cmdSigned(
      [`/clients/${req.params.client}/${req.params.file}`],
      { expires, secret: process.env.SIGNED_URL_SECRET },
    );
  } finally {
    process.stdout.write = originalWrite;
  }

  res.redirect(302, captured.join('').trim());
});

app.listen(3000);
```

#### Parsing CLI-style flags in your own tool

```javascript
// custom-tool.mjs — reuse Stratos's flag parser for consistency with the CLI.
import { parseFlags } from '@cloudcdn/stratos';

const { positional, flags } = parseFlags(process.argv.slice(2));
// e.g. node custom-tool.mjs deploy --env=prod --tag a --tag b
// → positional = ['deploy']
// → flags      = { env: 'prod', tag: ['a', 'b'] }
console.log({ positional, flags });
```

#### Driving the full router (for test harnesses)

```javascript
// integration-test.mjs — invoke any command in-process.
import { main, VERSION, EX } from '@cloudcdn/stratos';

console.log(`Driving stratos v${VERSION}`);          // → Driving stratos v0.0.17
console.log(`Exit codes: ${JSON.stringify(EX)}`);    // → { OK: 0, USAGE: 64, ... }

// Same argv shape as the CLI; same exits, same stdout/stderr discipline.
await main(['health', '--cdn-url', 'http://localhost:8788', '--json']);
```

#### Public exports

| Symbol | Kind | Purpose |
|---|---|---|
| `main(argv?)` | `async function` | The full CLI router (drives every subcommand) |
| `parseFlags(args)` | `function` | `argv → { positional, flags }` parser |
| `jsonReq(path, init?, opts?)` | `async function` | Retrying, auth-aware `fetch` wrapper |
| `envConfig(flags?)` | `async function` | Resolve `{ BASE, ACCOUNT_KEY, ACCESS_KEY, … }` from flags / env / profile / keychain |
| `cmdHealth`, `cmdPurge`, `cmdSigned`, `cmdAssets`, `cmdInsights`, `cmdZones`, `cmdTokens`, `cmdWebhooks`, `cmdStorage`, `cmdLogs`, `cmdAI`, `cmdImage`, `cmdSearch`, `cmdAsk` | `async function` | The in-process-driveable subset of CLI subcommands |
| `MCP_TOOLS` | `Array<{name, desc, schema}>` | The 10 tools exposed over MCP |
| `mcpCall(name, args)` | `async function` | Invoke an MCP tool in-process |
| `VERSION` | `string` | e.g. `'0.0.16'` |
| `EX` | `Readonly<Object>` | Sysexits-style exit-code constants |

Every export carries full JSDoc (parameters, returns, throws). IDE hover and TypeDoc-generated docs work out of the box.

---

## MCP server

Stratos speaks [Model Context Protocol](https://modelcontextprotocol.io) over stdio, exposing 10 CloudCDN tools (purge, assets, insights, AI vision, signed URLs, search, log query, …) to any MCP host.

**Claude Code** — add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "cloudcdn": {
      "command": "stratos",
      "args": ["mcp", "serve"],
      "env": {
        "CLOUDCDN_ACCOUNT_KEY": "cdnsk_…",
        "CLOUDCDN_ACCESS_KEY":  "cdnsk_…"
      }
    }
  }
}
```

**Cursor / Continue / any MCP host** — same shape; point at `stratos mcp serve`.

The server inherits env vars from the host process, so a `CLOUDCDN_ACCOUNT_KEY` already exported in your shell is what the agent calls with. See [`examples/mcp-claude-code.md`](examples/mcp-claude-code.md) for prompts that work well and a debugging walkthrough.

---

## Machine-readable schema

`stratos schema` emits the full command surface as a structured catalogue. Drives MCP tool registration, shell completion, doc generation, and external agent introspection from a single source of truth.

```bash
# Per-command shape
stratos schema --output ndjson | jq -c 'select(.name == "purge")'
# → {"name":"purge","summary":"Invalidate cache by URL, tag, or wholesale.",
#    "usage":"stratos purge <url>... [--dry-run]",
#    "exits":[0,64,69,75,77,78],"since":"0.0.1","mcp_tool":"cloudcdn_purge"}

# Top-level wrapper
stratos schema | jq 'keys'
# → ["$schema","commands","error_types","homepage","tool","version"]

# Discover only MCP-exposed commands
stratos schema --output ndjson | jq -r 'select(.mcp_tool) | .name'
# → health, purge, signed, assets, insights, ai, search, logs (10 total)
```

The output is **deterministic** — byte-identical across runs given the same source, so it's safe to cache, hash, or attest. The `error_types` field includes the stable typed-error registry so an agent gets both the verb surface and the error contract in one document.

---

## Output, exit codes, typed errors

**Output.** Default is pretty JSON on TTY, compact JSON on pipe. List-shaped commands (`assets`, `zones`, `tokens`, …) render an aligned table on TTY and JSON when piped or with `--json`. Use `--output ndjson` to stream one record per line (alias `jsonl`); pipes cleanly into `jq -c`, DuckDB `read_ndjson`, or an LLM context window without buffering an array. Diagnostics (`info:`, `warning:`, `error:`) go to **stderr**, never stdout.

**Exit codes** (sysexits-style):

| Code | Meaning |
|---|---|
| `0` | Success |
| `64` | Usage / bad CLI args |
| `65` | Data error — malformed input or response |
| `69` | Service unavailable (4xx other than auth) |
| `70` | Software error (uncaught exception) |
| `74` | Local I/O failure |
| `75` | Tempfail — 5xx, 429, or network after retries exhausted |
| `77` | Permission denied (401 / 403) |
| `78` | Config error (missing key, unreadable config file) |
| `130` | Interrupted (SIGINT) |

Programmatic consumers can import `EX` for these constants.

**Stable typed errors.** When `--json` or any structured `--output` is set, failures emit a typed envelope on stderr that agents can parse without regex-matching on human strings:

```bash
stratos signed --json
# stderr: {"error":{"type":"usage_error","message":"signed needs a path argument.",
#                   "retryable":false,"exit_code":64}}
```

```bash
# HTTP-status → type inference via emitFailure()
stratos health --json --retries 0 --cdn-url http://127.0.0.1:1
# stderr: {"error":{"type":"request_failed","message":"...","retryable":true,
#                   "exit_code":75}}
```

| `error.type` | When | `retryable` | Exit |
|---|---|---|---|
| `usage_error` | Invalid CLI invocation | `false` | `64` |
| `auth_missing_key` | Required credential not configured | `false` | `78` |
| `auth_invalid` | 401 / 403 from the API | `false` | `77` |
| `target_not_found` | 404 from the API | `false` | `69` |
| `rate_limited` | 429 from the API | **`true`** | `75` |
| `server_error` | 5xx from the API | **`true`** | `75` |
| `request_failed` | Network / transport failure | **`true`** | `75` |
| `data_error` | Malformed input or response (400 / 422) | `false` | `65` |
| `io_error` | Local filesystem failure | `false` | `74` |
| `unavailable` | Other non-2xx | `false` | `69` |
| `software_error` | Unexpected internal error | `false` | `70` |

The full table is also embedded in `stratos schema`'s `error_types` field, so an agent can pull both the verb surface and the error contract in one introspection roundtrip.

---

## Examples

Bash idioms below assume GNU / BSD `xargs`. Full source for each lives in [`examples/`](examples/).

Daily smoke test against production:

```bash
stratos health --deep | jq '.bindings | to_entries[] | select(.value != true)'
# (no output = all bindings healthy)
```

CI cache invalidation after a deploy:

```bash
export CLOUDCDN_ACCOUNT_KEY="$CLOUDCDN_PROD_KEY"
stratos purge --tag "build-${GITHUB_SHA::7}" --tag "project-akande"
```

Short-lived signed URL for a client preview:

```bash
EXPIRES=$(($(date +%s) + 600))   # 10 minutes
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

Batch AI alt-text generation (one curl per asset, 4 in parallel, NDJSON-streamed):

```bash
stratos assets --format=jpg --output ndjson | jq -r '.Path' \
  | xargs -I{} -P4 stratos ai alt "https://cloudcdn.pro{}"
```

Detect edge-config drift in CI (exits non-zero on diff):

```bash
stratos rules diff _headers -f ./public/_headers
```

Agent-friendly retry from a typed error:

```bash
# An agent caller wraps each call with this pattern.
if ! out=$(stratos purge --tag "$TAG" --json 2>err.json); then
  retryable=$(jq -r '.error.retryable' err.json)
  [[ "$retryable" == "true" ]] && sleep 1 && retry
fi
```

| Recipe | File |
|---|---|
| CI cache bust + warm-up | [`examples/ci-cache-bust.sh`](examples/ci-cache-bust.sh) |
| Client preview signed URL | [`examples/client-preview-url.sh`](examples/client-preview-url.sh) |
| Batch AI alt-text → CSV | [`examples/ai-alt-text-batch.sh`](examples/ai-alt-text-batch.sh) |
| Log triage → Slack webhook | [`examples/log-triage.sh`](examples/log-triage.sh) |
| MCP with Claude Code | [`examples/mcp-claude-code.md`](examples/mcp-claude-code.md) |
| Migrating from Wrangler | [`examples/migrate-from-wrangler.md`](examples/migrate-from-wrangler.md) |
| Migrating from Fastly CLI | [`examples/migrate-from-fastly.md`](examples/migrate-from-fastly.md) |
| Migrating from Codex CLI | [`examples/migrate-from-codex.md`](examples/migrate-from-codex.md) |
| Setting up the Homebrew tap | [`examples/homebrew-tap-setup.md`](examples/homebrew-tap-setup.md) |

---

## When not to use Stratos

Stratos is shaped for a specific bet. It's the wrong tool when:

- **You need local emulation.** `wrangler dev` and `fastly dev` ship dev servers; Stratos is API-only today (Phase 2 of the implementation plan adds `stratos dev`). For local CloudCDN now, run the upstream stack and point `CLOUDCDN_URL` at it.
- **You need a richer SDK** with auto-pagination iterators, typed response models, or built-in observability hooks. Use the upstream HTTP API directly with your preferred client.
- **You're on Node < 20.** Stratos uses `AbortSignal.timeout`, the stable global `fetch`, and `crypto.subtle`. We won't backport.
- **You need browser support.** Stratos is Node-only — it shells out (`security`, `secret-tool`), reads `process.env`, calls `process.exit`. None of that runs in a browser.
- **You need Wrangler/Fastly-specific primitives** (D1, KV, Compute@Edge, VCL). Different platforms. See [`NON-GOALS.md`](NON-GOALS.md) for the full list of deliberate scope exclusions.
- **You can't tolerate breaking changes during 0.0.x.** Per [versioning policy](#versioning-policy), all `0.0.x` releases may include breaking changes. We will not bump to `0.1.0` until `0.0.999`.

---

## Integrity & supply chain

- **Pinned SHA-256.** Both shell installers verify the downloaded `stratos.mjs` against a SHA-256 constant baked into the installer itself.
- **npm provenance.** Releases publish with `npm publish --provenance` — Sigstore-backed attestation. Verify with:

  ```bash
  npm audit signatures
  ```

- **SLSA L3 build provenance.** Each tagged release attaches an in-toto attestation (`stratos-v<version>.intoto.jsonl`) via `slsa-framework/slsa-github-generator`. Verify with `slsa-verifier`. Standard GitHub Actions attestations also exist:

  ```bash
  gh attestation verify stratos.mjs --owner sebastienrousseau
  ```

- **Cosign keyless signatures.** `.sig` and `.crt` files alongside every canonical artefact (script, binaries, installers, SBOM, VEX). Sigstore Fulcio CA + Rekor transparency log. See [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md) for the verification recipe.
- **CycloneDX SBOM + VEX.** Attached to every release; both signed with Cosign keyless.
- **Signed commits.** Every commit on `main` is SSH ED25519 signed.
- **No telemetry.** Every network call is initiated by an explicit command. No phone-home, no auto-update polling.
- **Offline `signed`.** The HMAC mint runs in-process; the secret never leaves the host.

Manual verification:

```bash
curl -fsSL https://cloudcdn.pro/dist/stratos/stratos.mjs -o stratos.mjs
shasum -a 256 stratos.mjs
# Compare against EXPECTED_SHA in install/install.sh
```

---

## Development

Stratos is a single ES module with no runtime dependencies. The only dev-only dependency is `c8` (coverage aggregation).

```
.
├── stratos.mjs              # the CLI (~4,000 lines, zero runtime deps)
├── install/
│   ├── install.sh           # POSIX installer
│   └── install.ps1          # Windows installer
├── scripts/
│   ├── check-docs.mjs       # zero-dep JSDoc coverage gate
│   ├── check-versions.mjs   # version-string + EXPECTED_SHA agreement check
│   └── lint-tests.mjs       # resource-leak rule for test/*.test.mjs
├── test/                    # 532 tests across 29 files, node --test
│   ├── parse.test.mjs · router.test.mjs · signed.test.mjs · http.test.mjs
│   ├── mcp.test.mjs         # JSON-RPC stdio
│   ├── commands.test.mjs · coverage-edge.test.mjs · branches.test.mjs · more-branches.test.mjs
│   ├── doctor-bench.test.mjs · diff-pagination.test.mjs
│   ├── v003.test.mjs … v013-branch-push.test.mjs   # per-release regression sets
│   └── v016-{lint-tests,schema,ndjson,typed-errors}.test.mjs
├── examples/                # cookbook + migration guides
├── actions/stratos/         # composite GitHub Action
├── .github/workflows/
│   ├── ci.yml               # Node 20/22/24 × { ubuntu, macos, windows }
│   └── release.yml          # npm publish --provenance on tag
├── .github/dependabot.yml   # weekly actions/npm/docker updates
├── .c8rc.json               # coverage config (enforcement in coverage:check)
├── README.md · CHANGELOG.md · CONTRIBUTING.md · CODE_OF_CONDUCT.md
├── GOVERNANCE.md · MAINTAINERS.md · NON-GOALS.md
├── SECURITY.md · SECURITY-AUDIT.md · LICENSE
└── package.json · package-lock.json
```

Run the suite:

```bash
npm test                     # all 532 tests, ~8 s
npm run coverage             # text + HTML + LCOV reports
npm run coverage:check       # enforce 100 / 100 / 100 / 100 thresholds
npm run docs:check           # enforce 100% JSDoc coverage
npm run tests:lint           # resource-leak rule (CI gate)
```

Run locally without installing:

```bash
node stratos.mjs version
node stratos.mjs health --cdn-url https://staging.cloudcdn.example
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR checklist (zero-dep ethos, JSDoc-on-every-declaration rule, test-required-for-every-command policy, resource-lifecycle rule for tests).

### Versioning policy

Stratos uses small `v0.0.x` increments. We will not bump to `v0.1.0` before `v0.0.999`, and not to `v1.0.0` before the project has built genuine community traction. Even substantial feature work is a patch-level bump at this stage.

---

## Tests & coverage

| Metric | Result |
|---|---|
| Tests | **532 / 532 green** (`node --test`, zero runtime deps, ~8 s) |
| Code: Statements | **100%** |
| Code: Lines | **100%** |
| Code: Functions | **100%** |
| Code: Branches | **100%** |
| Docs: JSDoc declarations | **100%** (118 / 118) |

The CI gate (Node 22 / Ubuntu) runs `npm test → coverage:check → docs:check → tests:lint` in sequence. The build fails below any threshold. Cross-platform CI runs all 532 tests on Node 20/22/24 × { Ubuntu, macOS, Windows }.

---

## Security

See [SECURITY.md](SECURITY.md) for the disclosure policy, supported versions, and supply-chain notes. The deeper threat model + control catalogue lives in [SECURITY-AUDIT.md](SECURITY-AUDIT.md). Report vulnerabilities privately to [`sebastian.rousseau@gmail.com`](mailto:sebastian.rousseau@gmail.com) — please do *not* open public GitHub issues for security matters.

---

## Governance

How decisions are made, who has commit rights, how to become a deputy, how releases are cut: [`GOVERNANCE.md`](GOVERNANCE.md). The current maintainer list is in [`MAINTAINERS.md`](MAINTAINERS.md). The flip side of the capabilities table — things Stratos deliberately doesn't do — is in [`NON-GOALS.md`](NON-GOALS.md).

All participation is subject to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

---

## Documentation

| Resource | Where |
|---|---|
| CLI reference | [`stratos help`](#commands) and per-command `stratos <cmd> --help` |
| Machine-readable schema | `stratos schema` (JSON / NDJSON / YAML; drives agent introspection + MCP) |
| Programmatic API | [Programmatic API](#programmatic-api) section above; full JSDoc on every export |
| Cookbook | [`examples/`](examples/) |
| Migration guides | [`examples/migrate-from-wrangler.md`](examples/migrate-from-wrangler.md), [`examples/migrate-from-fastly.md`](examples/migrate-from-fastly.md), [`examples/migrate-from-codex.md`](examples/migrate-from-codex.md) |
| MCP integration | [`examples/mcp-claude-code.md`](examples/mcp-claude-code.md) |
| Release notes | [`CHANGELOG.md`](CHANGELOG.md) |
| Security disclosure | [`SECURITY.md`](SECURITY.md) |
| Security audit / threat model | [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md) |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) |
| Code of Conduct | [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) |
| Governance | [`GOVERNANCE.md`](GOVERNANCE.md) |
| Maintainers | [`MAINTAINERS.md`](MAINTAINERS.md) |
| Non-goals | [`NON-GOALS.md`](NON-GOALS.md) |

Contributions welcome.

---

## License

Licensed under the [MIT License](LICENSE).

See [CHANGELOG.md](CHANGELOG.md) for release history.

<p align="right"><a href="#contents">Back to Top</a></p>
