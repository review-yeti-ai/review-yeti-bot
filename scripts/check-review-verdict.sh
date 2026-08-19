#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${REVIEW_REPOSITORY:?REVIEW_REPOSITORY is required}"
: "${REVIEW_PR_NUMBER:?REVIEW_PR_NUMBER is required}"
: "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"
: "${REVIEW_STATUS:?REVIEW_STATUS is required}"
: "${GATE_DECISION:?GATE_DECISION is required}"
: "${MERGE_ELIGIBLE:?MERGE_ELIGIBLE is required}"
: "${FILES_OMITTED:?FILES_OMITTED is required}"
: "${DISPATCH_REFLECTION_STATUS:?DISPATCH_REFLECTION_STATUS is required}"
: "${PROVIDER_RECEIPT_DIGEST:?PROVIDER_RECEIPT_DIGEST is required}"

metadata="$(gh api "repos/${REVIEW_REPOSITORY}/pulls/${REVIEW_PR_NUMBER}")"
actual_base="$(jq -r '.base.sha // empty' <<<"$metadata")"
actual_head="$(jq -r '.head.sha // empty' <<<"$metadata")"

[[ "$actual_base" == "$EXPECTED_BASE_SHA" ]] || { echo "::error::Review became stale because the PR base changed"; exit 1; }
[[ "$actual_head" == "$EXPECTED_HEAD_SHA" ]] || { echo "::error::Review became stale because the PR head changed"; exit 1; }
[[ "$REVIEW_STATUS" == SHIP ]] || { echo "::error::Review Yeti verdict is ${REVIEW_STATUS}, not SHIP"; exit 1; }
[[ "$GATE_DECISION" == PASS ]] || { echo "::error::Review Yeti gate decision is ${GATE_DECISION}, not PASS"; exit 1; }
[[ "$MERGE_ELIGIBLE" == true ]] || { echo "::error::Review Yeti did not declare this exact-head review merge eligible"; exit 1; }
[[ "$FILES_OMITTED" == 0 ]] || { echo "::error::Review Yeti omitted ${FILES_OMITTED} changed files"; exit 1; }
[[ "$DISPATCH_REFLECTION_STATUS" == complete ]] || { echo "::error::Review Yeti dispatch reflection is ${DISPATCH_REFLECTION_STATUS}, not complete"; exit 1; }
[[ "$PROVIDER_RECEIPT_DIGEST" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "::error::Review Yeti provider receipt digest is missing or invalid"; exit 1; }

echo "Review Yeti SHIP/PASS accepted for ${REVIEW_REPOSITORY}#${REVIEW_PR_NUMBER} at exact head ${EXPECTED_HEAD_SHA}."
