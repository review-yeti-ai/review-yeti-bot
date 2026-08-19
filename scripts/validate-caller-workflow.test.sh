#!/usr/bin/env bash
set -euo pipefail

# Contract test for the consumer-facing release ref. This deliberately uses a
# fake gh API so the test proves the caller parser without requiring network
# access or a real PR. In particular:
#   - a caller that reintroduces central-sha must fail even when its @v1 line
#     is otherwise correct.
#   - the script must validate the copy of the caller workflow that lives at
#     EXPECTED_BASE_SHA (the commit pull_request_target actually executes),
#     not the repository's default branch. REL-287: example-api PRs target
#     0.8.7-stable, not master, so validating the default branch produced
#     false failures on every in-flight stable PR whenever the two branches'
#     pins diverged (observed 2026-08-18, 04:25-06:13 and 12:53-13:53).
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

mkdir -p "$tmp_dir/bin"
cat >"$tmp_dir/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

# Minimal stand-in for `gh api [--jq EXPR] ENDPOINT`. Real gh applies --jq
# server-side; this fake must apply it too, otherwise callers that depend on
# --jq filtering (e.g. an unfiltered default-branch lookup) would pass the
# test for the wrong reason instead of failing loudly.
shift # drop "api"
endpoint=""
jqexpr=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --jq) jqexpr="$2"; shift 2 ;;
    *) endpoint="$1"; shift ;;
  esac
done

case "$endpoint" in
  repos/exampleorg/example/contents/*)
    ref="${endpoint##*ref=}"
    if [[ "$ref" == "$EXPECTED_BASE_SHA" ]]; then
      content="$FAKE_WORKFLOW_CONTENT"
    else
      echo "unexpected ref requested: $ref" >&2
      exit 1
    fi
    encoded="$(printf '%s' "$content" | base64 | tr -d '\n')"
    body="$(printf '{"content":"%s"}' "$encoded")"
    ;;
  *)
    echo "unexpected fake gh call: $endpoint" >&2
    exit 1
    ;;
esac

if [[ -n "$jqexpr" ]]; then
  printf '%s' "$body" | jq -r "$jqexpr"
else
  printf '%s\n' "$body"
fi
FAKE_GH
chmod +x "$tmp_dir/bin/gh"

base_sha="deadbeefcafef00ddeadbeefcafef00ddeadbeef"
valid_workflow=$'jobs:\n  review:\n    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@v1\n    secrets: inherit\n'
invalid_workflow="${valid_workflow}"$'    with:\n      central-sha: 0123456789012345678901234567890123456789\n'

PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 \
  EXPECTED_BASE_SHA="$base_sha" \
  FAKE_WORKFLOW_CONTENT="$valid_workflow" \
  "$repo_root/scripts/validate-caller-workflow.sh"

if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 \
    EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$invalid_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo "expected central-sha duplication to fail" >&2
  exit 1
fi
grep -Fq "must not duplicate the central release ref as central-sha" <<<"$output"

echo "validate-caller-workflow contract passed"

# REL-287 regression: the base-branch copy (what pull_request_target actually runs) is valid, and
# is the ONLY copy this script is given access to (the fake gh 404s any other ref, standing in for
# a default branch that has already moved to a different pin). The script must not need — and must
# not fall back to — a default-branch lookup to reach a pass.
if ! output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 \
    EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$valid_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo "expected a valid base-branch copy to pass even though no default-branch lookup is offered" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "Validated" <<<"$output"

echo "validate-caller-workflow base-branch-anchor regression passed"

# The fail-closed EXPECTED_BASE_SHA format guard must reject a malformed value before any gh call
# is made (the fake gh 404s everything, so a pass here would mean the regex check was skipped).
if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 \
    EXPECTED_BASE_SHA="not-a-sha" \
    FAKE_WORKFLOW_CONTENT="$valid_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo "expected a malformed EXPECTED_BASE_SHA to fail" >&2
  exit 1
fi
grep -Fq "base-sha is invalid" <<<"$output"

echo "validate-caller-workflow base-sha format guard passed"
