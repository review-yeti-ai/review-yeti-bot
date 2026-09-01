#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${WORKFLOW_REF:-}" || -z "${WORKFLOW_SHA:-}" ]]; then
  echo "::error::GitHub did not expose the reusable workflow identity" >&2
  exit 1
fi

if [[ -z "${GITHUB_OUTPUT:-}" ]]; then
  echo "::error::GITHUB_OUTPUT is unavailable" >&2
  exit 1
fi

printf 'workflow_ref=%s\n' "$WORKFLOW_REF" >> "$GITHUB_OUTPUT"
printf 'workflow_sha=%s\n' "$WORKFLOW_SHA" >> "$GITHUB_OUTPUT"
