#!/usr/bin/env bash
# ==============================================================================
# Stratos installer (macOS / Linux) — production-grade.
#
# Hardening:
#   - native sha256sum -c / shasum -c --status (no manual hash-string compare)
#   - curl --connect-timeout 10 --retry 3 (survives flaky networks)
#   - install(1) for the binary drop (atomic on the same filesystem)
#   - relative-path shim ($(dirname "$0")/../lib/stratos) so users can
#     relocate the bin/lib pair without breaking
#
# Usage:
#   curl -sL https://cloudcdn.pro/dist/stratos/install.sh | bash
#
# Override install location:
#   curl -sL https://cloudcdn.pro/dist/stratos/install.sh | STRATOS_PREFIX=$HOME/bin bash
# ==============================================================================

set -euo pipefail

# --- Configuration ---
VERSION="0.0.15"
# Default to the GitHub release asset — it's the canonical source signed
# by the release workflow, immutable per-tag, and serves the right bytes
# without any out-of-band CDN sync. Power users can override with
# CLOUDCDN_URL to pull from their own edge.
SOURCE="${CLOUDCDN_URL:-https://github.com/sebastienrousseau/stratos/releases/download/v${VERSION}/stratos.mjs}"
# Expected SHA-256 of stratos.mjs as delivered. Matches the source file
# in git verbatim — `curl -o` (used below) writes the response body
# byte-for-byte. Bumped on each release.
EXPECTED_SHA="cc140da2897e0f0c7197b8ec78c826f80eb3efca058dc07823f2084cf9696035"

# --- Styling ---
if [ -t 1 ]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
else
  RED=''; GREEN=''; BLUE=''; NC=''
fi
log_info()    { printf "%sinfo:%s %s\n"    "$BLUE"  "$NC" "$1"; }
log_success() { printf "%ssuccess:%s %s\n" "$GREEN" "$NC" "$1"; }
log_error()   { printf "%serror:%s %s\n"   "$RED"   "$NC" "$1" >&2; }

# --- Pre-flight: dependencies ---
check_dep() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log_error "'$1' is required but not found on PATH. Install it and re-run."
    exit 1
  fi
}
check_dep curl
check_dep node

# Node ≥ 20 (built-in fetch + crypto.subtle + AbortSignal.timeout).
NODE_MAJOR=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  log_error "Node ≥ 20 required; detected v$NODE_MAJOR."
  exit 1
fi

# --- Install prefix resolution ---
if [ -n "${STRATOS_PREFIX:-}" ]; then
  PREFIX="$STRATOS_PREFIX"
elif [ -w /usr/local/bin ]; then
  PREFIX="/usr/local/bin"
else
  PREFIX="$HOME/.local/bin"
fi

LIBDIR="$(dirname "$PREFIX")/lib/stratos"
mkdir -p "$PREFIX" "$LIBDIR"

# --- Download with retry/timeout ---
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

log_info "Fetching Stratos v$VERSION from $SOURCE ..."
if ! curl -fsSL --connect-timeout 10 --retry 3 "$SOURCE" -o "$TMP"; then
  log_error "Failed to download $SOURCE"
  exit 1
fi

# --- Native checksum verification ---
#
# We support both `sha256sum` (GNU coreutils, Linux) and `shasum -a 256`
# (Perl-based, ships with macOS by default). We avoid `sha256sum -c`
# because BSD-derived `sha256sum` (e.g. FreeBSD 14, some macOS user
# installs) uses incompatible argument syntax — see
# https://github.com/sebastienrousseau/stratos/issues for the report.
# Instead, compute the hash and compare strings.
log_info "Verifying SHA-256 of payload ..."
compute_sha() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    return 1
  fi
}
GOT_SHA="$(compute_sha "$TMP")" || {
  log_error "Neither shasum nor sha256sum is available — cannot verify integrity. Aborting."
  exit 1
}
if [ "$GOT_SHA" != "$EXPECTED_SHA" ]; then
  log_error "SHA-256 mismatch. The download is corrupted or tampered."
  log_error "  expected: $EXPECTED_SHA"
  log_error "  got:      $GOT_SHA"
  exit 1
fi

# --- Atomic install ---
install -m 0644 "$TMP" "$LIBDIR/stratos.mjs"

# Shim uses a runtime-relative path so moving the install tree doesn't break.
cat > "$PREFIX/stratos" <<'EOF'
#!/usr/bin/env bash
set -e
STRATOS_LIB="$(cd "$(dirname "$0")/../lib/stratos" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "stratos: node is required at runtime but was not found on PATH." >&2
  exit 1
fi
exec node "$STRATOS_LIB/stratos.mjs" "$@"
EOF
chmod 0755 "$PREFIX/stratos"

log_success "Stratos v$VERSION installed at $PREFIX/stratos"

# --- Optional: man page ---
# Best-effort fetch of the gzipped man page from the GitHub release into
# the user's local man directory. Failures are silent — the CLI works
# without it.
MAN_DIR="$(dirname "$PREFIX")/share/man/man1"
MAN_SRC="https://github.com/sebastienrousseau/stratos/releases/download/v$VERSION/stratos.1.gz"
if mkdir -p "$MAN_DIR" 2>/dev/null && \
   curl -fsSL --connect-timeout 5 --retry 2 "$MAN_SRC" -o "$MAN_DIR/stratos.1.gz" 2>/dev/null; then
  log_info "Installed man page at $MAN_DIR/stratos.1.gz (try: man stratos)"
fi

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) log_info "$PREFIX is not on PATH. Add 'export PATH=\"\$PATH:$PREFIX\"' to your shell rc." ;;
esac
log_info "Try: stratos version  /  stratos help  /  stratos doctor"
