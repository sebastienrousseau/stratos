#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Pre-tag preflight for Stratos releases. Run this BEFORE `git tag` to
# catch the classes of bugs that have bitten previous releases:
#
#   - YAML syntax errors in .github/workflows/release.yml (v0.0.10, v0.0.11)
#   - VERSION-string drift between stratos.mjs / package.json / installers /
#     CHANGELOG / router tests (latent footgun until check-versions.mjs)
#   - install.sh EXPECTED_SHA pointing at a stale stratos.mjs (same as v0.0.6)
#   - branching feature work off a stale `main` (v0.0.11 was branched while
#     PR #10's YAML fix was still pending)
#
# Usage:
#   scripts/preflight-release.sh         # check intended version (from stratos.mjs)
#   scripts/preflight-release.sh 0.0.11  # check + assert intended version is 0.0.11
#
# Exits 0 if everything passes; 1 on first failure.

set -euo pipefail

cd "$(dirname "$0")/.."

ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m⚠\033[0m %s\n' "$1"; }
fail()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
header(){ printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

EXPECTED_VERSION="${1:-}"

# ─── 1. Workflow YAML is parseable ────────────────────────────────────────
header "1. .github/workflows/*.yml parses as YAML"
for f in .github/workflows/*.yml; do
  if ! python3 -c "import yaml,sys; yaml.safe_load(open('$f'))" 2>/dev/null; then
    python3 -c "import yaml,sys; yaml.safe_load(open('$f'))" 2>&1 | tail -3 >&2
    fail "$f does not parse — release tag would fire a broken workflow"
  fi
  ok "$f parses"
done

# ─── 2. actionlint clean (workflow semantic check) ────────────────────────
header "2. actionlint clean"
if command -v actionlint >/dev/null 2>&1; then
  if actionlint .github/workflows/*.yml; then
    ok "actionlint reports no issues"
  else
    fail "actionlint found issues — fix above before tagging"
  fi
else
  warn "actionlint not installed; skipping. Install with \`brew install actionlint\`."
fi

# ─── 3. Version-string + EXPECTED_SHA agreement ───────────────────────────
header "3. Version-string + EXPECTED_SHA agreement"
if ! node scripts/check-versions.mjs; then
  fail "version-bearing files disagree"
fi

# ─── 4. Intended version matches if caller passed one ─────────────────────
if [ -n "$EXPECTED_VERSION" ]; then
  header "4. Intended version match"
  actual="$(grep -oE "const VERSION = '[^']+'" stratos.mjs | head -1 | grep -oE "'[^']+'" | tr -d "'")"
  if [ "$actual" = "$EXPECTED_VERSION" ]; then
    ok "intended v${EXPECTED_VERSION} matches stratos.mjs"
  else
    fail "intended v${EXPECTED_VERSION}, but stratos.mjs has v${actual}"
  fi
fi

# ─── 5. Working tree clean ────────────────────────────────────────────────
header "5. Working tree clean"
if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short
  fail "uncommitted changes — commit or stash before tagging"
fi
ok "no uncommitted changes"

# ─── 6. Branch is up to date with origin/main ─────────────────────────────
header "6. Branch up to date with origin/main"
git fetch --quiet origin main
local_main="$(git rev-parse main 2>/dev/null || true)"
remote_main="$(git rev-parse origin/main)"
if [ "$local_main" != "$remote_main" ]; then
  fail "local main ($local_main) != origin/main ($remote_main). Pull first."
fi
ok "local main == origin/main"

# Are we ON main? Otherwise warn (you can still tag a branch, but this is
# how the v0.0.11 ghost was created — branched off main before the YAML
# fix landed).
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "main" ]; then
  warn "HEAD is on '$current_branch', not 'main'. If this is intentional, OK."
fi

# ─── 7. New version > latest tag ──────────────────────────────────────────
header "7. New version is strictly greater than latest tag"
latest_tag="$(git tag --list 'v*' --sort=-v:refname | head -1 || true)"
new_v="$(grep -oE "const VERSION = '[^']+'" stratos.mjs | head -1 | grep -oE "'[^']+'" | tr -d "'")"
if [ -n "$latest_tag" ]; then
  # Strip the v.
  prev="${latest_tag#v}"
  # Cheap sort: rely on `sort -V`.
  if [ "$(printf '%s\n%s\n' "$prev" "$new_v" | sort -V | tail -1)" != "$new_v" ] || [ "$prev" = "$new_v" ]; then
    fail "stratos.mjs VERSION '$new_v' is not greater than latest tag '$latest_tag'"
  fi
  ok "v$new_v > $latest_tag"
else
  ok "no previous tag; v$new_v is the first"
fi

# ─── 8. CHANGELOG has an entry for the new version ────────────────────────
header "8. CHANGELOG entry for v$new_v"
if grep -qE "^## \[$new_v\]" CHANGELOG.md; then
  ok "CHANGELOG.md has a '## [$new_v]' entry"
else
  fail "no '## [$new_v]' entry in CHANGELOG.md"
fi

# ─── 9. Tests + coverage + docs gates ─────────────────────────────────────
header "9. npm test + coverage:check + docs:check"
if npm test --silent >/dev/null 2>&1; then
  ok "npm test green"
else
  fail "npm test failed — run \`npm test\` to see details"
fi
if npm run coverage:check --silent >/dev/null 2>&1; then
  ok "npm run coverage:check green"
else
  fail "coverage gate failed — run \`npm run coverage:check\` to see details"
fi
if npm run docs:check --silent >/dev/null 2>&1; then
  ok "npm run docs:check green"
else
  fail "JSDoc gate failed — run \`npm run docs:check\` to see details"
fi

# ─── Done ─────────────────────────────────────────────────────────────────
printf '\n\033[1;32m✓ Preflight passed for v%s. Safe to tag:\033[0m\n' "$new_v"
printf '\n    git tag -s v%s -m "..."\n    git push origin v%s\n\n' "$new_v" "$new_v"
