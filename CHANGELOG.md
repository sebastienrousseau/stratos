# Changelog

All notable changes to `stratos` are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

> **Versioning policy.** Stratos increments in small `v0.0.x` steps. We
> will not bump to `v0.1.0` before `v0.0.999`, and not to `v1.0.0` before
> the project has built genuine community traction. Even substantial
> feature work is a patch-level bump at this stage.

## [0.0.3] — 2026-06-01

### Added

- **Fuzzy "did you mean?"** — unknown commands now suggest the closest match by Levenshtein distance (`stratos prge` → "Did you mean 'purge'?").
- **CI-mode auto-detect** — when `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`, `TF_BUILD`, or `CI=true` is present, Stratos auto-enables `--json --quiet`. Override with `STRATOS_CI=0` or `--no-json` / `--no-quiet`.
- **GitHub Actions workflow-command framing** — fatal errors under `GITHUB_ACTIONS=true` are *also* emitted as `::error title=stratos (exit N)::…` so they surface inline on PR/run pages.
- **`--dry-run` symmetry on every destructive op** — `zones rm`, `tokens rm`, `webhooks rm`, `storage rm` now all accept `--dry-run` (matching the existing `purge` and `storage sync` behaviour).
- **Asciinema casts** — `docs/casts/{version,health,purge,signed,doctor}.{cast,gif}` rendered with [agg](https://github.com/asciinema/agg). Embedded in the README under Quick Start. Regenerate with `node scripts/make-casts.mjs --render`.

### Changed

- **MCP protocol bumped** from `2024-11-05` to the stable `2025-11-25` spec. The `2026-07-28` release candidate (Resources, Prompts, Tasks, Elicitation) is queued for v0.0.5 once it leaves RC.

## [0.0.2] — 2026-05-31

A major DX and API-coverage upgrade. Stratos now covers ~30 commands across the
full CloudCDN control plane, ships an MCP server, shell completions, profile
support, and a 56-test in-repo suite.

### Added

- **`stratos doctor`** — environment + reachability check (Node version,
  config file, OS keychain availability, credentials presence with masked
  display, live `/api/health` probe). Non-zero exit on any failure.
- **`stratos login`** — interactive prompt that stores `account_key`,
  `access_key`, and `signed_url_secret` in the OS keychain (macOS
  `security`, Linux `secret-tool` / libsecret, Windows `cmdkey`).
  Non-interactive via `--account-key=…`.  `stratos login status` shows
  the resolved config with masked values; `stratos logout` clears.
  Opt out with `STRATOS_NO_KEYCHAIN=1`.
- **`stratos bench`** — cold-start measurement + N `/api/health` latency
  samples with min/p50/p95/max summary. `--json` for ingestion.
- **`stratos rules diff <_headers|_redirects> -f <local>`** — LCS-based
  diff between the live edge file and your local copy. Exits 0 if
  identical, 69 on drift (git-style).
- **`assets --all`** — auto-paginate the asset catalog until `TotalPages`
  is reached or a page is empty. Safety cap: 1000 pages.
- **Value-taking short flags** — `-n 5` for `bench`, `-f path` for `rules`.
- **API coverage expanded from 4 → ~30 endpoints**: `insights {summary,top,asset,errors,geo}`,
  `stats`, `analytics query`, `audit`, `zones {list,create,show,rm,domains}`,
  `rules {get,set,diff}`, `tokens {list,create,rm}`, `webhooks {list,add,rm}`,
  `storage {put,get,rm,ls,sync}`, `logs {tail,query}` (SSE-streamed),
  `ai {alt,moderate,crop,bg-remove}`, `image {transform,blurhash,lqip,auto}`,
  `stream`, `pipeline submit`, `search`, `ask`, `passkey`, plus
  `assets show <path>` for single-asset metadata.
- **`stratos mcp serve`** — Model Context Protocol stdio server. Exposes 10 tools
  (`cloudcdn_health`, `cloudcdn_purge`, `cloudcdn_assets`, `cloudcdn_insights_*`,
  `cloudcdn_ai_*`, `cloudcdn_search`, `cloudcdn_signed`, `cloudcdn_logs_query`)
  so Claude Code, Cursor, and any MCP host can drive CloudCDN over JSON-RPC.
- **Shell completion** — `stratos completion <bash|zsh|fish|powershell>`.
- **Config & profiles** — `~/.config/stratos/config.json` with named profiles;
  select via `--profile <name>` or `STRATOS_PROFILE`. New `config get|set|list`
  subcommand. XDG-compliant.
- **Global flags** — `--json` (force JSON), `--quiet`/`-q`, `--verbose` (request
  tracing to stderr), `--profile`, `--url`, `--account-key`, `--access-key`,
  `--timeout <ms>` (default 15 s), `--retries <n>` (default 3, full-jitter
  backoff on 429/5xx and network errors).
- **`stratos purge --dry-run`** — preview the request body without sending.
- **`stratos purge -`** — read URLs from stdin, one per line.
- **Per-command `--help`** — `stratos purge --help`, `stratos signed --help`, etc.
- **Sysexits-style exit codes** — `0` ok, `64` usage, `69` unavailable, `75`
  tempfail (5xx/network), `77` noperm (401/403), `78` config error.
- **In-repo test suite** — 218 tests under `test/*.test.mjs` using `node --test`
  (zero runtime deps). Covers parsing, routing, HMAC, HTTP (in-process mock
  server), MCP protocol, doctor/bench/login-status, rules diff, auto-pagination,
  every command's happy + error paths, and the major fallback-chain arms in
  config resolution.
- **Coverage** — c8 dev dependency. **100% statements / lines / functions** on
  `stratos.mjs`, branch coverage 90.1%. CI gate enforces 100/100/100/85 on the
  Node 22 / Ubuntu job; full HTML report via `npm run coverage`.
- **Documentation** — **100% JSDoc coverage** on every top-level declaration
  (86/86) in `stratos.mjs`. Zero-dep `scripts/check-docs.mjs` enforces the
  gate; `npm run docs:check` runs it locally and CI gates on Node 22 / Ubuntu.
- **`--cdn-url <url>` global flag** (renamed from the original `--url`, which
  collided with `stratos webhooks add --url`).
- **CI matrix** — Node 20/22/24 × Ubuntu/macOS/Windows in `.github/workflows/ci.yml`.
- **Release workflow** — `npm publish --provenance` via Sigstore attestation
  + build-provenance attestation on tag.
- **`SECURITY.md`, `CONTRIBUTING.md`, `examples/`** — top-level docs and a
  cookbook of working recipes, including Wrangler/Fastly migration guides.

### Changed

- **Errors now go to stderr, not stdout.** A 4xx/5xx response body no longer
  pollutes `stratos … | jq …` pipelines. *Breaking for v0.0.1 scripts that
  parsed error JSON from stdout.*
- **Exit codes follow sysexits.h** instead of `0/1/2`. *Breaking for v0.0.1
  scripts that branched on exact codes 1 and 2.*
- **HMAC canonicalisation** — `signed` now signs a length-prefixed
  `<len>:<path>|<len>:<expires>` instead of `<path>|<expires>`, eliminating
  signature collisions for paths containing `|`. *Breaking: signatures
  produced by v0.0.2 differ from v0.0.1.*
- **Auth-header policy** — read-only routes now send `AccessKey` only when
  available; control-plane routes send `AccountKey + x-api-key`. Reduces
  accidental credential leakage when both env vars are set.
- **Node ≥ 20** is now required (was ≥ 18). Node 18 reaches EOL April 2026;
  Stratos uses `AbortSignal.timeout` and other Node 20+ APIs.
- **Global `--url` flag renamed to `--cdn-url`** to avoid collision with
  `stratos webhooks add --url <hook>`. Env var `CLOUDCDN_URL` is unchanged.
- **`User-Agent: stratos/<version>`** is now sent on every request.

### Fixed

- **Multi-tag purge** — `stratos purge --tag a --tag b` now sends both tags.
  v0.0.1 silently dropped all but the last because `parseFlags` overwrote
  repeated keys. (Critical bug.)
- **No fetch timeout** — added `AbortController` with `--timeout` (default 15 s);
  CI no longer hangs forever on a stalled edge.
- **No retries** — added exponential backoff with full jitter (3 attempts by
  default) on 429, 5xx, and network errors.
- **Cold start** — moved the dynamic `fileURLToPath` import inside the script-
  entrypoint guard; saves ~5 ms on every invocation.

## [0.0.1] — 2026-05-14

First public release. Extracted from the
[`cloudcdn.pro`](https://github.com/sebastienrousseau/cloudcdn.pro)
repository, where the CLI has been developed and tested since 2026-05.

> Originally tagged in-repo as `v0.1.0`; renumbered to `v0.0.1` on
> 2026-05-31 to align with the small-increment policy. No prior
> `v0.1.0` release was ever published to npm or attached to a GitHub
> release, so this renumbering has no consumer impact.

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

[0.0.3]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.3
[0.0.2]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.2
[0.0.1]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.1
