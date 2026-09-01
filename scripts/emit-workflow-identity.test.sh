#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/emit-workflow-identity.sh"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

output="$tmp_dir/github-output"
workflow_ref='exampleorg/example-review-actions/.github/workflows/review-yeti.yml@refs/heads/v1'
workflow_sha='0123456789abcdef0123456789abcdef01234567'

WORKFLOW_REF="$workflow_ref" \
WORKFLOW_SHA="$workflow_sha" \
GITHUB_OUTPUT="$output" \
  "$script"

grep -Fxq "workflow_ref=$workflow_ref" "$output"
grep -Fxq "workflow_sha=$workflow_sha" "$output"

if WORKFLOW_REF='' WORKFLOW_SHA="$workflow_sha" GITHUB_OUTPUT="$output" "$script"; then
  echo "expected an empty workflow ref to fail" >&2
  exit 1
fi

if WORKFLOW_REF="$workflow_ref" WORKFLOW_SHA='' GITHUB_OUTPUT="$output" "$script"; then
  echo "expected an empty workflow SHA to fail" >&2
  exit 1
fi

if WORKFLOW_REF="$workflow_ref" WORKFLOW_SHA="$workflow_sha" GITHUB_OUTPUT='' "$script"; then
  echo "expected a missing GitHub output file to fail" >&2
  exit 1
fi

echo "workflow identity output contract passed"
