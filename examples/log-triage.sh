#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Pattern: tail edge logs for errors, route the first matching pattern to
# Slack via webhook, exit clean on Ctrl-C.

set -euo pipefail

: "${CLOUDCDN_ACCOUNT_KEY:?CLOUDCDN_ACCOUNT_KEY is required}"
: "${SLACK_WEBHOOK_URL:?SLACK_WEBHOOK_URL is required}"

pattern="${1:-5[0-9][0-9]}"

stratos logs tail --level error \
  | while IFS= read -r line; do
      if echo "${line}" | grep -qE "${pattern}"; then
        curl -fsSL -X POST -H 'Content-Type: application/json' \
          -d "{\"text\":\"CloudCDN: ${line//\"/\\\"}\"}" \
          "${SLACK_WEBHOOK_URL}" >/dev/null || true
      fi
      printf '%s\n' "${line}"
    done
