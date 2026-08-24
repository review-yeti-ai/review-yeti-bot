#!/usr/bin/env bash
set -euo pipefail

# Read-only preflight for the v1 promotion contract. This command intentionally
# uses only already-fetched refs: it does not need GitHub credentials, contact a
# remote, or infer a candidate from the ambient checkout.
: "${SOURCE_SHA:?SOURCE_SHA is required}"
: "${EXPECTED_OLD_V1_SHA:?EXPECTED_OLD_V1_SHA is required}"

main_ref="refs/remotes/origin/main"
observed_v1_ref="refs/remotes/origin/v1"
target_ref="refs/heads/v1"

require_exact_sha() {
  local name="$1"
  local value="$2"

  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || {
    echo "::error::${name} must be an exact lowercase 40-character commit SHA." >&2
    exit 1
  }
}

resolve_commit() {
  local ref="$1"
  git rev-parse --verify "${ref}^{commit}" 2>/dev/null || {
    echo "::error::Cannot resolve ${ref} to a commit from the local ref snapshot." >&2
    exit 1
  }
}

require_exact_sha SOURCE_SHA "$SOURCE_SHA"
require_exact_sha EXPECTED_OLD_V1_SHA "$EXPECTED_OLD_V1_SHA"

main_sha="$(resolve_commit "$main_ref")"
observed_old_sha="$(resolve_commit "$observed_v1_ref")"
candidate_sha="$(resolve_commit "$SOURCE_SHA")"
expected_old_sha="$(resolve_commit "$EXPECTED_OLD_V1_SHA")"

# A full SHA must resolve to itself. This rejects a caller whose local object
# database maps an alleged commit input to some other object or peeled commit.
[[ "$candidate_sha" == "$SOURCE_SHA" ]] || {
  echo "::error::SOURCE_SHA resolved to ${candidate_sha}, not exact candidate ${SOURCE_SHA}." >&2
  exit 1
}
[[ "$expected_old_sha" == "$EXPECTED_OLD_V1_SHA" ]] || {
  echo "::error::EXPECTED_OLD_V1_SHA resolved to ${expected_old_sha}, not exact old ref ${EXPECTED_OLD_V1_SHA}." >&2
  exit 1
}

eligible=true
relation=fast-forward
reason=ready

if [[ "$observed_old_sha" != "$EXPECTED_OLD_V1_SHA" ]]; then
  eligible=false
  relation=stale-old-ref
  reason=observed-v1-does-not-match-expected-old
elif [[ "$candidate_sha" != "$main_sha" ]]; then
  eligible=false
  relation=stale-candidate
  reason=candidate-is-not-current-main
elif [[ "$observed_old_sha" == "$candidate_sha" ]]; then
  relation=idempotent
  reason=already-promoted
elif ! git merge-base --is-ancestor "$observed_old_sha" "$candidate_sha"; then
  eligible=false
  relation=diverged
  reason=non-fast-forward
fi

printf '%s\n' \
  'schema=exampleorg.review-yeti-v1-promotion-audit.v1' \
  'ref_snapshot=local-only' \
  'remote_access=false' \
  "main_ref=${main_ref}" \
  "main_sha=${main_sha}" \
  "observed_v1_ref=${observed_v1_ref}" \
  "observed_old_sha=${observed_old_sha}" \
  "expected_old_ref=${target_ref}" \
  "expected_old_sha=${EXPECTED_OLD_V1_SHA}" \
  "candidate_sha=${candidate_sha}" \
  "expected_new_ref=${target_ref}" \
  "expected_new_sha=${candidate_sha}" \
  "relation=${relation}" \
  "eligible=${eligible}" \
  "reason=${reason}" \
  'rollback_strategy=create-reviewed-revert-on-main-then-promote' \
  "rollback_from_sha=${candidate_sha}" \
  "rollback_baseline_sha=${EXPECTED_OLD_V1_SHA}" \
  'direct_ref_rewind_allowed=false' \
  'write_performed=false'

if [[ "$eligible" != true ]]; then
  echo "::error::v1 promotion audit refused: ${reason}." >&2
  exit 1
fi
