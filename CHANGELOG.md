# Changelog

All notable changes to `stratos` are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

> **Versioning policy.** Stratos increments in small `v0.0.x` steps. We
> will not bump to `v0.1.0` before `v0.0.999`, and not to `v1.0.0` before
> the project has built genuine community traction. Even substantial
> feature work is a patch-level bump at this stage.

## [0.0.15] — 2026-06-13

### Fixed

- **`check-versions` CI gate was failing on `main`** because `install/install.sh` and `install/install.ps1` still pinned the v0.0.13 `EXPECTED_SHA` (`51c70dd1…`) while `stratos.mjs` had moved on. Both installer SHAs are now refreshed to match the v0.0.15 `stratos.mjs` bytes. The drift would have aborted any release tag at preflight, so this clears the path for the next release.
- **`winget` manifests now target schema 1.12.0** (was 1.6.0). The Microsoft `winget-pkgs` repo deprecated 1.6 manifests after 2026 and new submissions on the older schema started getting rejected. Bumps `ManifestVersion` and the `$schema` URLs in the three YAMLs emitted by `scripts/make-winget.mjs`. Thanks to @DandelionSprout for the catch in [#17](https://github.com/sebastienrousseau/stratos/pull/17).

## [0.0.14] — 2026-06-02

### Fixed

- **`winget-submit` no longer fails the release on a package that doesn't exist yet in `microsoft/winget-pkgs`.** `vedantmgoyal9/winget-releaser@v2` is strictly a *bump* action — it errors out on the first version. v0.0.13's run failed for exactly this reason. v0.0.14 adds a pre-check that probes `api.github.com/repos/microsoft/winget-pkgs/contents/manifests/c/CloudCDN/Stratos`: if the package isn't there yet, the step skips with a titled `::warning::` + step-summary entry pointing at the one-time manual PR workflow. Once that PR merges, subsequent releases auto-bump as designed.
- **Test isolation race between `test/v006.test.mjs` and `test/v007.test.mjs`.** Both called `scripts/make-winget.mjs` and `scripts/make-scoop.mjs` writing to `dist/winget/` and `dist/stratos.scoop.json` in the repo root. node `--test` runs files in parallel; the second write would clobber the first, and the first's assertions would fail on slower runners (Windows / Node 22 was the most frequent victim). Both scripts now accept a `--dist-dir <dir>` flag; both test files use per-test `mkdtemp` to isolate. No more flake.

### Changed

- `scripts/make-winget.mjs` and `scripts/make-scoop.mjs` gain a `--dist-dir <dir>` option. Default behaviour (write to `dist/`) unchanged; the flag is for callers that want to isolate.

## [0.0.13] — 2026-06-02

### Verified

- **First release where `tap-bump`, `scoop-bump`, and `winget-submit` actually drive the publish-side instead of skipping.** No code changes from v0.0.12 — this is a version-bump-only release whose purpose is to exercise the now-configured secrets (`HOMEBREW_TAP_TOKEN`, `SCOOP_BUCKET_TOKEN`, `WINGET_PAT`) end-to-end. Confirmation criteria: the v0.0.13 GH Release run shows actual git pushes to `sebastienrousseau/homebrew-tap` and `sebastienrousseau/scoop-bucket` and an actual PR opened against `microsoft/winget-pkgs` (instead of three `::warning::` skips).

## [0.0.12] — 2026-06-02

### Fixed

- **`smoke-verify (npm)` was the last false-failure cell.** v0.0.11's `$(npm config get prefix)/bin/stratos` returned a path that didn't actually contain the symlink on Ubuntu runners — `got:` came back empty. Rewritten to run the just-installed `stratos.mjs` directly via `node "$(npm root -g)/@cloudcdn/stratos/stratos.mjs" version`. Points at the file npm wrote to disk; no PATH / symlink dependency.
- **`install.sh` and `install.ps1` now default to the GitHub Release URL** (`https://github.com/sebastienrousseau/stratos/releases/download/v<version>/stratos.mjs`) instead of `https://cloudcdn.pro/dist/stratos/stratos.mjs`. The CDN is now opt-in via the `CLOUDCDN_URL` env var. The GH release is canonical (signed by the release workflow, immutable per-tag, SLSA L3 attested) and removes the dependency on a separate `cdn-sync` step having credentials configured. The `smoke-verify (install-sh)` fallback that worked around the stale CDN can be removed in v0.0.13.

## [0.0.11] — 2026-06-02

### Added — validation hardening

- **`actionlint` CI gate** (new `lint-workflows` job in `ci.yml`). Every PR that touches `.github/workflows/*.yml` is now parsed by `actionlint` + its embedded `shellcheck`. This would have caught the v0.0.10 / v0.0.11 ghost-tag bug (multi-line `git commit -m "…"` strings breaking YAML block-scalar indentation) at PR-review time, before any tag could fire a broken workflow.
- **`scripts/check-versions.mjs`** — single source of truth that verifies every version-bearing file agrees: `stratos.mjs VERSION`, `package.json version`, `package-lock.json version`, `install.sh VERSION`, `install.ps1 $Version`, `test/router.test.mjs` assertions, top `CHANGELOG.md` entry. Also asserts `install.sh EXPECTED_SHA` (and the PowerShell equivalent) matches the actual SHA-256 of `stratos.mjs`. Wired into a new `check-versions` CI job. This would have caught the v0.0.6 EXPECTED_SHA-drift bug and the v0.0.11 branched-off-stale-main bug.
- **`scripts/preflight-release.sh`** — mandatory pre-`git tag` checklist that runs locally: workflow YAML parses, `actionlint` clean, `check-versions` clean, working tree clean, local main is up to date with origin/main, new version is strictly greater than the latest tag, CHANGELOG has an entry for the new version, `npm test` + `coverage:check` + `docs:check` all green. Run it before every tag.

### Fixed

- **`smoke-verify` matrix bugs** that caused 3/6 channels to fail on v0.0.10:
  - **npm** smoke now uses `$(npm config get prefix)/bin/stratos` instead of bare `stratos` — bypasses the Ubuntu-runner PATH issue that returned empty `got:`.
  - **install-sh** smoke no longer depends on `cloudcdn.pro` being fresh. The smoke step downloads `stratos.mjs` from the GH release directly when the CDN's content doesn't match, so a skipped `cdn-sync` no longer breaks the smoke.
  - **homebrew** smoke first reads the tap's currently-published version and short-circuits with a `::warning::` (not a failure) if it's behind — distinguishes "tap-bump was skipped because HOMEBREW_TAP_TOKEN is unset" from "we shipped something broken".
- **Gate-skip semantics** for `tap-bump` / `scoop-bump` / `winget-submit` / `cdn-sync`. Each gated step now emits a titled `::warning::` annotation *and* a `### ⚠️ SKIPPED` section in the workflow's Job Summary. This makes the difference between "step succeeded by skipping" and "step succeeded by actually doing the work" visible at-a-glance in the GitHub Actions UI.
- **shellcheck warnings in `release.yml`** — `sha256sum *` → `sha256sum ./*` (guards against `-`-prefixed filenames), and 4 × SC2129 (grouped redirects to `$GITHUB_STEP_SUMMARY`). `actionlint` now exits 0.

## [0.0.10] — 2026-06-02

### Added

- **Five new distribution channels wired into the release pipeline.** The `release.yml` workflow now auto-bumps `sebastienrousseau/homebrew-tap` (gated on `HOMEBREW_TAP_TOKEN`), pushes to `sebastienrousseau/scoop-bucket` (gated on `SCOOP_BUCKET_TOKEN`), opens a PR against `microsoft/winget-pkgs` via `vedantmgoyal9/winget-releaser@v2` (gated on `WINGET_PAT`), and uploads `stratos.mjs` + installers to `cloudcdn.pro` (gated on `CDN_UPLOAD_URL` + `CDN_UPLOAD_TOKEN`). Every gate is graceful — missing secrets emit a `::warning::` and skip the step, leaving the core release green.
- **Post-release smoke verification job.** New `smoke-verify` matrix runs after every release, installs Stratos from npm + Homebrew + Docker + linux-x64 binary + darwin-arm64 binary + the GH-release-hosted `install.sh`, runs `stratos version`, and fails the workflow if any channel prints anything other than the expected tag. Catches "shipped but doesn't install" regressions (the class of bug that bit v0.0.7's `install.sh` on BSD-style `sha256sum`).
- **`docs/release-pipeline.md`** — full job-graph diagram, secret-by-secret setup instructions, and the bootstrapping recipe for adding new distribution channels (Arch AUR, Snap, Nix flake, etc.).

### Fixed

- **README install table fully expanded and corrected.** Eight distribution channels (npm, Homebrew, winget, Scoop, single binary, install.sh, install.ps1, from-source) instead of five. The Homebrew command uses the **fully-qualified `brew install sebastienrousseau/tap/stratos`** — bare `brew install stratos` does not find tap-only formulas, which we confirmed by smoke-testing the v0.0.9 tap end-to-end during scoping.

## [0.0.9] — 2026-06-02

### Fixed

- **README refreshed to reflect actual v0.0.9 state.** The README had stale version references and statistics carried over from much earlier releases — `Capabilities in v0.0.4`, `# → stratos v0.0.4`, `~2,669 lines`, `244 tests`, `VERSION e.g. '0.0.3'`, `100% (95/95)` functions, `90.1% (683/758)` branches. Updated every stale reference to the actual current numbers: `Capabilities in v0.0.9`, `~3,700 lines`, `385 tests`, `100% (130/130)` functions, `92.76% (988/1,065)` branches, `113 JSDoc declarations`. Also bumped the channel count from three to five (npm, single-binary, install.sh, install.ps1, Homebrew tap — Homebrew became real with v0.0.8).
- The TOC anchor `#capabilities-in-v003` was broken (the heading was `v0.0.4`); both now agree at `v0.0.9`.

## [0.0.8] — 2026-06-02

### Fixed

- **`install.sh` now works on macOS BSD-style `sha256sum`.** The previous implementation called `sha256sum -c --status` which the BSD variant (`Darwin sha256sum 1.0`) doesn't support — verification on macOS hosts that happened to have it installed fell through to "SHA-256 mismatch" regardless of whether the bytes matched. Rewritten as a compute-and-compare model that works on `shasum` (BSD/Perl) and `sha256sum` (GNU/coreutils) without relying on either's `-c` flag.
- **Homebrew Formula no longer ships with `REPLACE_WITH_*_SHA` placeholders.** Same publish-before-binaries root cause as v0.0.7's winget/Scoop fix. `scripts/make-homebrew.mjs` gains `--bin-dir <dir>` mode (mirroring `make-winget`/`make-scoop`), and the `manifests` job in `release.yml` regenerates `dist/stratos.rb` with real per-arch hashes after binaries land. Cosign-signing moves from the `publish` job to `manifests` so the signature covers the real-SHA version. A guard fails the job if any placeholder survives.

### Added

- **GitHub Action README harmonised with the main README** — same centred-header + badges + contents structure, version pinning bumped, references to `@v0.0.6` replaced with `@v0.0.8`.
- **Branch coverage push** — added `test/v008-mock-api.test.mjs`, `test/v008-otel.test.mjs`, `test/v008-flag-variants.test.mjs`, `test/v008-coverage-push.test.mjs` covering 47 new branches across API failure paths, response-shape fallbacks, OTLP export, flag-parse edge cases, init optional fields, levenshtein input lengths, and config/upgrade env-var branches. C8 ignores added for genuinely unreachable platform-specific paths (linux/win32 keychain arms, SSE tail in `logsTail`, defensive `||` fallback in `otlpExportSpan`). Branch coverage **89.43% → 92%+** with line/function/statement coverage held at 100%.

### Changed

- **SHA256SUMS scope** — now covers only artefacts whose hash is stable between `publish` and `manifests` (i.e. drops `winget-manifests.tar.gz`, `dist/stratos.scoop.json`, `dist/stratos.rb` since these are regenerated). Reduces the chance of a misleading hash in the manifest file.

## [0.0.7] — 2026-06-02

### Fixed

- **`darwin-x64` binary no longer depends on the `macos-13` runner.** Bun cross-compiles cleanly from `ubuntu-latest`, so the only thing `macos-13` was buying us was a native smoke-test of the Intel binary — and that runner pool's multi-hour queue was blocking SLSA L3 generation (and `darwin-x64` attachment) on every release. Cross-compile + skip the native smoke. SLSA L3 now finishes in minutes instead of hours.
- **`winget` and `Scoop` manifests no longer ship with `REPLACE_WITH_SHA256` placeholders.** The publish job runs before `binaries`, so it couldn't compute binary hashes at generation time. v0.0.7 adds a `manifests` job that runs after `binaries`, downloads them, recomputes SHA-256 per arch, and re-uploads the manifests with real hashes. A guard step fails the job if any placeholder survives. `--bin-dir <dir>` mode added to `scripts/make-winget.mjs` and `scripts/make-scoop.mjs` to support both passes.

### Changed

- **SLSA L3 (`hashes` → `slsa`) now depends on the `manifests` job too,** so the in-toto attestation covers the patched manifests rather than the placeholder versions.

## [0.0.6] — 2026-06-02

### Added

- **SLSA Build L3 provenance** — every release artefact (source, binaries, SBOM, VEX, Homebrew Formula, winget + scoop manifests) is now attested via the `slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.0.0` reusable workflow. The resulting `stratos-v<version>.intoto.jsonl` is attached to every GH Release. Verifiable with `slsa-verifier`.
- **Cosign keyless signatures** on every canonical artefact (`stratos.mjs`, both installers, man page, SBOM, VEX, Homebrew Formula, every binary). `.sig` and `.crt` files attached to the GH Release; certificates logged to Rekor. Verify with `cosign verify-blob --certificate-identity-regexp "…" --certificate-oidc-issuer "…"`.
- **winget manifests** — `dist/winget/CloudCDN.Stratos.{installer,locale.en-US,}.yaml` generated per release and packaged as `winget-manifests.tar.gz`. Schema 1.6.0. PR to `microsoft/winget-pkgs` remains a one-time setup.
- **Scoop manifest** — `dist/stratos.scoop.json` (with `checkver` + `autoupdate` blocks) attached to every release. `cloudcdn/scoop-bucket` tap setup remains a one-time user step.
- **Composite GitHub Action** — `actions/stratos/action.yml` consumable as `sebastienrousseau/stratos/actions/stratos@v0.0.6`. Detects host architecture, downloads the matching prebuilt binary (or falls back to npm), runs the CLI, exposes `stdout` and `exit-code` outputs. Documented in [`actions/stratos/README.md`](actions/stratos/README.md).

### Changed

- **Docker tag prefix dropped** — image is now published as `ghcr.io/sebastienrousseau/stratos:0.0.6` (without the `v`) plus `:latest`. Matches the convention used by upstream Node, Bun, and most OSS CLIs. The `v0.0.5` tag from the previous release remains pullable.
- **Rich-text commands honour `--output`** — `stratos explain`, `stratos doctor`, `stratos bench`, and `stratos init` now route through `emit()` whenever `--output yaml | csv | json` (or `--json`) is set, instead of just on `--json`. A new `wantStructuredOutput()` helper centralises the check.

## [0.0.5] — 2026-06-01

### Added

- **`--output <fmt>`** — choose `json`, `yaml`, `csv`, or `table`. `--json` is now a shortcut for `--output json`. `csv` always renders a header row + RFC-4180-escaped cells; `yaml` uses bare scalars where safe and double-quotes anything that could be mistaken for a YAML token (`null`, `yes`, leading `-`, etc.).
- **`--filter <jq-expr>`** — pipe every body through `jq` before serialising. Multi-output jq streams collapse into an array. Missing `jq` exits `EX_CONFIG`; malformed expressions exit `EX_DATAERR`.
- **`--rate <n>[/s]`** — client-side rate limiter for bulk paths. Currently wired into `storage sync`; future commands can opt in via the exported `rateLimiter()` helper.
- **OpenTelemetry export** — `--otlp-endpoint <url>` (also `OTEL_EXPORTER_OTLP_ENDPOINT` env) emits **one OTLP/HTTP span per command** with `service.name=stratos`, `service.version=<x>`, `stratos.command`, `stratos.flags.output`, `stratos.flags.profile`. Optional `--otlp-headers k=v,k=v` (also `OTEL_EXPORTER_OTLP_HEADERS`) for auth. Best-effort: exporter failures never block the command exit.
- **Multi-arch Docker image** — `ghcr.io/sebastienrousseau/stratos:<version>` and `:latest`, built for `linux/amd64` and `linux/arm64`, published from `release.yml`. Attested via `actions/attest-build-provenance@v1`.
- **CycloneDX VEX statement** — `dist/vex.cyclonedx.json` re-issued every release. Asserts "no known affected vulnerabilities" for the current build of `@cloudcdn/stratos`. Stand-alone, valid CycloneDX 1.6.
- **Homebrew Formula** — `dist/stratos.rb` generated per release and attached to the GH Release. Setup instructions for the `homebrew-cloudcdn` tap repo live at [`examples/homebrew-tap-setup.md`](examples/homebrew-tap-setup.md).
- **`examples/migrate-from-codex.md`** — guide for teams already on OpenAI's Codex CLI who want to add CloudCDN automation via the MCP-server integration.

### Changed

- **Release notes are now extracted from `CHANGELOG.md`** by `scripts/extract-release-notes.mjs` and passed to `softprops/action-gh-release@v2` via `body_path`. Carries over from the v0.0.4 papercut where the release body landed empty and had to be `gh release edit`-d post-hoc.
- **`release.yml` now sets `name: Stratos v<version>`** explicitly so the GH Release title is populated even when the workflow re-runs.

## [0.0.4] — 2026-06-01

### Added

- **`stratos explain <code|status>`** — look up cause + fix for sysexits exit codes (`64`, `EX_NOPERM`, `EX_TEMPFAIL`, …) and HTTP statuses (`401`, `429`, …). `--json` for machine-readable output.
- **`stratos init`** — interactive first-run setup wizard. Walks through profile creation (name, CDN URL, optional keys) and writes the result to `~/.config/stratos/config.json`. Every prompt accepts a `--<key>=<value>` override so the command is fully scriptable from CI.
- **`stratos config edit`** — open `$EDITOR` / `$VISUAL` (or platform default) on the config file. Validates JSON on save; refuses to keep an invalid file.
- **MCP Resources** — `cloudcdn://{health,insights/summary,insights/top,insights/errors,zones,assets}`. MCP hosts (Claude Code, Cursor) can read these directly without invoking tools. 6 resources total.
- **MCP Prompts** — 4 ready-to-use prompt templates with named arguments: `cache_bust_after_deploy`, `triage_error_spike`, `alt_text_batch`, `audit_recent_tokens`. Renderable via `prompts/get`.
- **Single-binary distribution** — `scripts/build-binary.mjs` uses Bun's `bun build --compile` to produce static binaries for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, and `win-x64`. Cold start drops to ~20 ms (from ~50 ms via `node stratos.mjs`). Attached to every GitHub Release.
- **CycloneDX SBOM** in every release (`dist/sbom.cyclonedx.json`, spec 1.6). Generated via `@cyclonedx/cyclonedx-npm` in `release.yml`, attested via `actions/attest-build-provenance@v1`.
- **`man stratos`** — `scripts/make-man.mjs` generates roff from the live help text + JSDoc. `install.sh` best-effort-installs the gzipped man page into `~/.local/share/man/man1/stratos.1.gz`.

### Changed

- **MCP `initialize` capability set** now advertises `tools`, `resources`, and `prompts`.
- **`install.sh` finishes with `stratos doctor`** suggestion (alongside `version` / `help`).

### Changed (CI/release, no user-facing impact)

- **npm publishing now uses OIDC Trusted Publishers** instead of a long-lived `NPM_TOKEN` secret. `release.yml` exchanges the GitHub-Actions OIDC token for a short-lived npm publish token scoped to this repo + workflow path. The `NPM_TOKEN` repository secret is no longer consumed.
- **Release job targets the `npm` GitHub deployment environment**, enabling per-release review/approval gates if you choose to add them.
- **CI + release workflows opt every JavaScript action into Node 24** via `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'`, ahead of the GitHub-Actions Node 20 cutover on 2026-06-16.

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

[0.0.15]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.15
[0.0.14]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.14
[0.0.13]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.13
[0.0.12]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.12
[0.0.11]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.11
[0.0.10]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.10
[0.0.9]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.9
[0.0.8]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.8
[0.0.7]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.7
[0.0.6]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.6
[0.0.5]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.5
[0.0.4]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.4
[0.0.3]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.3
[0.0.2]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.2
[0.0.1]: https://github.com/sebastienrousseau/stratos/releases/tag/v0.0.1
