#!/usr/bin/env bash
set -euo pipefail

: "${RECEIPT_PATH:?RECEIPT_PATH is required}"
: "${WORKER_IMAGE:?WORKER_IMAGE is required}"
: "${EXPECTED_REPO:?EXPECTED_REPO is required}"
: "${EXPECTED_REPOSITORY_ID:?EXPECTED_REPOSITORY_ID is required}"
: "${EXPECTED_BASE_SHA:?EXPECTED_BASE_SHA is required}"
: "${EXPECTED_HEAD_SHA:?EXPECTED_HEAD_SHA is required}"

engine_revision="${WORKER_IMAGE##*@sha256:}"
[[ "$engine_revision" =~ ^[0-9a-f]{64}$ ]] || { echo 'worker image digest is invalid' >&2; exit 1; }
jq -e --arg engine "$engine_revision" --arg repo "$EXPECTED_REPO" \
  --arg repository_id "$EXPECTED_REPOSITORY_ID" --arg base "$EXPECTED_BASE_SHA" --arg head "$EXPECTED_HEAD_SHA" '
  .version == "ReviewYetiPanelQualification.v1" and
  .profile == "same-head" and
  .status == "succeeded" and
  .source == "github-pull-request" and
  .publicationMode == "disabled" and
  .engineRevision == $engine and
  .repo == $repo and (.repositoryId | tostring) == $repository_id and
  .baseSha == $base and .headSha == $head and
  .providerId == "openrouter" and
  .requestedModel == "deepseek/deepseek-v4-flash-0731" and
  .githubReads == 3 and .githubWrites == 0 and
  .personaCount == 6 and .expectedPersonaCount == 6 and
  .optionalFailureCount == 0 and .quorumSatisfied == true and
  .findingFingerprintVersion == "ReviewYetiFindingFingerprint.v1" and
  (.findingFingerprints | length) == .findingsCount and
  (.laneAttribution | length) == 8
' "$RECEIPT_PATH" >/dev/null
