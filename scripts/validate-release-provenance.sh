#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RESOLVED_SHA:?RESOLVED_SHA is required}"

# Break-glass is deliberate but never silent, and never unbounded: an
# override run is announced as a workflow warning AND must still point at a
# commit reachable from the bot's main branch — an emergency freeze targets a
# known-merged commit, never an arbitrary or off-history one. Only the
# release-tag requirement is waived under override.
OVERRIDE_MODE=false
if [[ "${ACTION_REF_IS_OVERRIDE:-false}" == "true" ]]; then
  OVERRIDE_MODE=true
  echo "::warning::Release provenance in BREAK-GLASS mode: action_sha_override=${RESOLVED_SHA}. Release-tag binding is waived; main-reachability is still enforced."
fi

bot_repo='review-yeti-ai/review-yeti-bot'
sha_re='^[0-9a-f]{40}$'

[[ "$RESOLVED_SHA" =~ $sha_re ]] || { echo "::error::RESOLVED_SHA is invalid"; exit 1; }

# Reachability: the resolved commit must be main or an ancestor of main. A commit ahead of
# (or diverged from) main could not have gone through the bot repository's own review gate.
compare_status="$(gh api "repos/${bot_repo}/compare/main...${RESOLVED_SHA}" --jq '.status' 2>&1)" || {
  echo "::error::Could not compare ${bot_repo}@main with resolved commit ${RESOLVED_SHA}."
  echo "$compare_status"
  exit 1
}

if [[ "$compare_status" != "identical" && "$compare_status" != "behind" ]]; then
  echo "::error::Resolved commit ${RESOLVED_SHA} is not reachable from ${bot_repo}@main (compare status: ${compare_status})."
  exit 1
fi

if [[ "$OVERRIDE_MODE" == "true" ]]; then
  echo "Provenance (break-glass): ${RESOLVED_SHA} reachable from main; release-tag binding waived by explicit override."
  exit 0
fi

# Released: the resolved commit must carry an IMMUTABLE semver release tag (vX.Y.Z) —
# channel tags like v1/v1-rc are floating pointers, not release evidence.
# The /tags endpoint returns commit.sha ALREADY dereferenced for annotated tags, so this is a
# single paginated call — never one API call per tag.
released=false
if gh api "repos/${bot_repo}/tags?per_page=100" --paginate 2>/dev/null \
  | jq -e --arg sha "$RESOLVED_SHA" 'first(.[] | select((.name|test("^v[0-9]+\\.[0-9]+\\.[0-9]+$")) and .commit.sha == $sha)) != null' >/dev/null; then
  released=true
fi

if [[ "$released" != "true" ]]; then
  echo "::error::Resolved commit ${RESOLVED_SHA} is not the target of any v* release tag on ${bot_repo}."
  exit 1
fi

echo "Provenance OK: ${RESOLVED_SHA} released and reachable from main."
