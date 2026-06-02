<!-- SPDX-License-Identifier: MIT -->

# Release pipeline

This document describes how a Stratos release happens, what the
`release.yml` workflow does, and the GitHub secrets needed to enable
each downstream channel.

## Trigger

A signed annotated tag matching `v*` (e.g. `v0.0.10`) pushed to
`origin/main` fires `.github/workflows/release.yml`.

## Job graph

```
publish ─┬─ binaries (linux-x64/arm64, darwin-x64/arm64, win-x64)
         ├─ docker (ghcr.io/sebastienrousseau/stratos)
         └─ cdn-sync (cloudcdn.pro)            [optional, see secrets]

binaries ─┐
publish ──┼─ manifests (patches winget + scoop + Homebrew with real
docker ───┘             per-arch SHAs, re-uploads + re-signs)

manifests ─┬─ tap-bump      (sebastienrousseau/homebrew-tap)  [optional]
           ├─ scoop-bump    (sebastienrousseau/scoop-bucket)  [optional]
           └─ winget-submit (microsoft/winget-pkgs PR)        [optional]

manifests ─┐
publish ───┼─ hashes ─ slsa (in-toto attestation)
docker ────┘

tap-bump ─┐
slsa ─────┴─ smoke-verify (install from every public channel, run
                           `stratos version`, assert match)
```

## Required and optional secrets

The workflow uses `${{ secrets.GITHUB_TOKEN }}` (automatic) and OIDC for
the load-bearing parts (npm Trusted Publisher, Sigstore, SLSA L3, build
provenance). Everything below is **optional**: missing secrets degrade
gracefully — the step prints a `::warning::` and skips, leaving the
core release green.

| Secret | Used by | Effect when unset |
|---|---|---|
| `HOMEBREW_TAP_TOKEN` | `tap-bump` | Skips the Homebrew tap push. Users can still `brew install` from the previously-bumped tag. |
| `SCOOP_BUCKET_TOKEN` | `scoop-bump` | Skips the Scoop bucket push. Users can still `scoop install` against the previously-bumped version. |
| `WINGET_PAT` | `winget-submit` | Skips the winget-pkgs PR. Users can still `winget install` against the previously-merged version. |
| `CDN_UPLOAD_URL` + `CDN_UPLOAD_TOKEN` | `cdn-sync` | Skips the CDN sync. The README's `curl install.sh \| bash` one-liner serves whatever the CDN was last seeded with — see [CDN sync](#cdn-sync). |

### How to set them

**`HOMEBREW_TAP_TOKEN`** — a GitHub fine-grained PAT scoped to
`sebastienrousseau/homebrew-tap`:

1. Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token
2. Resource owner: `sebastienrousseau`
3. Repository access: Only select repositories → `homebrew-tap`
4. Repository permissions: Contents → Read and write
5. Copy the token, add as `HOMEBREW_TAP_TOKEN` repo secret on `stratos`

**`SCOOP_BUCKET_TOKEN`** — identical procedure, scoped to
`sebastienrousseau/scoop-bucket` instead.

**`WINGET_PAT`** — a classic PAT with `public_repo` scope. The action
`vedantmgoyal9/winget-releaser@v2` uses this to fork
`microsoft/winget-pkgs` and open a PR. See the action's README for the
fine-grained alternative.

**`CDN_UPLOAD_URL` + `CDN_UPLOAD_TOKEN`** — depends on what's behind
`cloudcdn.pro`. The default `cdn-sync` step issues:

```
PUT $CDN_UPLOAD_URL/dist/stratos/<filename>
Authorization: Bearer $CDN_UPLOAD_TOKEN
Content-Type: application/octet-stream
<file bytes>
```

Swap the curl invocation in `release.yml` for whatever your CDN
expects (AWS S3 PUT, Cloudflare R2 via wrangler, Backblaze B2, etc.).

## Smoke verification

The final `smoke-verify` job is the regression net. It runs after
every release and installs Stratos from every public channel:

- npm: `npm install -g @cloudcdn/stratos@<version>`
- Homebrew: `brew tap sebastienrousseau/tap && brew install sebastienrousseau/tap/stratos`
- Docker: `docker pull ghcr.io/sebastienrousseau/stratos:<version>`
- Linux x64 binary: download + chmod + run
- Darwin arm64 binary: download + chmod + run
- install.sh: download from the GH release, run with `STRATOS_PREFIX=$tmp/bin`

For each channel it runs `stratos version` and asserts the output is
exactly `stratos v<expected>`. Any mismatch fails the job.

This is a **release-day-only** safety net — it doesn't replace the
unit/integration tests in `test/`. The `publish` job already ran those
on the source tree before any artefact left the workflow. `smoke-
verify` catches a different class of bug: the artefact shipped, but
*how* users will actually install it is broken (the BSD-`sha256sum`
incompatibility we found post-v0.0.7 was exactly this).

## Why all the optional gating?

Forks of this repo (or fresh clones for someone reading the code)
shouldn't need 6 secrets configured before the release workflow goes
green. The required ones — OIDC for npm publish, Sigstore for signing,
SLSA L3 — are automatic via GitHub's own token and the npm-side
Trusted Publisher mapping. Everything else is value-add, and the
workflow gates each on its respective secret with an explicit
`::warning::` so the absence is logged rather than silent.

## Pre-tag validation

Before you `git tag`, run the preflight:

```bash
scripts/preflight-release.sh
```

It runs every validation we have, all in one place:

| Check | What it catches |
|---|---|
| `python3 -c 'yaml.safe_load(...)'` on every workflow | YAML parse errors (the v0.0.10/v0.0.11 ghost-tag bug) |
| `actionlint` | `shellcheck` issues + GitHub Actions semantic checks |
| `scripts/check-versions.mjs` | drift between `stratos.mjs` / `package.json` / installers / CHANGELOG / router tests + EXPECTED_SHA disagreement |
| `git diff --quiet` | uncommitted changes that wouldn't make it into the tag |
| `local main == origin/main` | branched-off-stale-main bug (v0.0.11) |
| `new version > latest tag` | accidental backward bumps |
| `## [<new>]` in CHANGELOG | forgotten changelog entry |
| `npm test` + `coverage:check` + `docs:check` | the existing gates |

The same checks run on every PR via `ci.yml`'s `lint-workflows` and `check-versions` jobs, so most issues are caught at PR-review time. The preflight is the last line of defence right before you tag.

## Bootstrapping a new channel

To add (say) a Linux distro packaging channel — start an Arch Linux
AUR push, a Snap, a Nix flake — the pattern is:

1. Add a new top-level job in `release.yml` with `needs: manifests`
   (so it sees the patched stratos.* files).
2. Gate the actual upload on a `*_TOKEN` secret using the same
   `id: gate` / `if: steps.gate.outputs.skip != 'true'` pattern.
3. Add a `smoke-verify` matrix entry for the new channel.
4. Add a row to the README's install table.
5. Add a row to the secrets table above.

That's the whole contract.
