#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Pattern: mint a 10-minute signed URL for a private asset and copy it to
# the clipboard for sharing with a client.

set -euo pipefail

: "${SIGNED_URL_SECRET:?SIGNED_URL_SECRET is required (in your shell or .env)}"

path="${1:-}"
if [ -z "${path}" ]; then
  echo "usage: $0 /clients/<client>/<file>" >&2
  exit 64
fi

expires=$(($(date +%s) + 600))   # 10 minutes
url=$(stratos signed "${path}" --expires "${expires}")

case "$(uname -s)" in
  Darwin) printf '%s' "${url}" | pbcopy && echo "✓ copied (10-min expiry)" ;;
  Linux)  if command -v xclip >/dev/null; then
            printf '%s' "${url}" | xclip -selection clipboard && echo "✓ copied (10-min expiry)"
          else
            echo "${url}"
          fi ;;
  *) echo "${url}" ;;
esac
