#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Pattern: after a deploy, purge by build tag (cheap) and warm a few
# critical URLs (free of stale 404s for the first user).
#
# Required env:
#   CLOUDCDN_ACCOUNT_KEY  control-plane API key
#   GITHUB_SHA            the deploy's commit SHA (or substitute your own)
#   CDN_BASE              the asset prefix, e.g. https://cloudcdn.pro/akande/v1

set -euo pipefail

: "${CLOUDCDN_ACCOUNT_KEY:?CLOUDCDN_ACCOUNT_KEY is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"
: "${CDN_BASE:?CDN_BASE is required}"

echo "→ purging by tag build-${GITHUB_SHA:0:7}"
stratos purge --tag "build-${GITHUB_SHA:0:7}"

echo "→ warming critical paths"
for path in /index.html /robots.txt /sitemap.xml; do
  url="${CDN_BASE}${path}"
  if curl -fsSL -o /dev/null -w "  %{http_code} %{time_total}s  ${url}\n" "${url}"; then
    :
  else
    echo "  WARN: could not warm ${url}" >&2
  fi
done

echo "✓ done"
