#!/usr/bin/env bash
set -euo pipefail

workflow=.github/workflows/doks-action-qualification.yml
test -s "$workflow"
grep -Fq 'workflow_call:' "$workflow"
grep -Fq 'id-token: write' "$workflow"
grep -Fq 'timeout-minutes: 15' "$workflow"
grep -Fq 'execution-backend: doks' "$workflow"
grep -Fq 'doks-publish-mode: disabled' "$workflow"
grep -Fq 'id: first_dispatch' "$workflow"
grep -Fq 'id: duplicate_dispatch' "$workflow"
grep -Fq 'review-status' "$workflow"
grep -Fq 'gate-decision' "$workflow"
grep -Fq 'merge-eligible' "$workflow"

if grep -Eq 'schedule:|cron:|OPENROUTER|OLLAMA|FIREWORKS|SYNTHETIC|GEMINI_API_KEY|issues: write|pull-requests: write' "$workflow"; then
  echo 'DOKS qualification must remain manual, nonpublishing, and provider-free' >&2
  exit 1
fi
