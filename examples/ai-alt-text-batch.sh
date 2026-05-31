#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Pattern: generate AI alt-text for every JPG asset in a project, four at
# a time, and emit a CSV. Re-run safe — appends per asset.

set -euo pipefail

: "${CLOUDCDN_ACCESS_KEY:?CLOUDCDN_ACCESS_KEY is required}"

project="${1:-}"
out="${2:-alt-text.csv}"
if [ -z "${project}" ]; then
  echo "usage: $0 <project> [<out.csv>]" >&2
  exit 64
fi

echo "path,alt_text" > "${out}"

stratos assets --project="${project}" --format=jpg --json \
  | jq -r '.[].Path' \
  | xargs -I{} -P4 bash -c '
      url="https://cloudcdn.pro{}"
      alt=$(stratos ai alt "$url" --json | jq -r ".alt // empty")
      printf "%s,\"%s\"\n" "{}" "$alt"
    ' >> "${out}"

echo "✓ wrote ${out} ($(wc -l < "${out}") rows)"
