#!/usr/bin/env bash
set -euo pipefail

# Contract test for the caller workflow. The fake GitHub API serves content only for the supplied
# EXPECTED_BASE_SHA, proving the validator cannot silently consult the repository default branch.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

mkdir -p "$tmp_dir/bin"
cat >"$tmp_dir/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

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
  repos/exampleorg/example/contents/*|repos/exampleorg/example-review-actions/contents/*)
    ref="${endpoint##*ref=}"
    if [[ "$ref" != "$EXPECTED_BASE_SHA" ]]; then
      echo "unexpected ref requested: $ref" >&2
      exit 1
    fi
    encoded="$(printf '%s' "$FAKE_WORKFLOW_CONTENT" | base64 | tr -d '\n')"
    body="$(printf '{"content":"%s"}' "$encoded")"
    ;;
  repos/exampleorg/example-review-actions/compare/*)
    if [[ "$GH_TOKEN" != "${FAKE_COMPARE_TOKEN:-test}" ]]; then
      echo 'private central comparison requires the App identity' >&2
      exit 1
    fi
    body="$(printf '{"status":"%s"}' "${FAKE_COMPARE_STATUS:-ahead}")"
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
immutable_workflow=$'jobs:\n  review:\n    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@89269f7918bee2ec4fcc48d61bde64346e6e865b\n    secrets: inherit\n'
invalid_workflow="${valid_workflow}"$'    with:\n      central-sha: 0123456789012345678901234567890123456789\n'

# Exercise the workflow binding as well as the script. A script-only test would
# miss github.token being passed to this one step while checkout uses the App.
pin_step="$(sed -n '/      - name: Validate immutable caller pin/,/      - name: Validate central dispatch boundary/p' "$repo_root/.github/workflows/review-yeti.yml")"
# shellcheck disable=SC2016 # Match the literal GitHub expression, not shell expansion.
grep -Fxq '          GH_TOKEN: ${{ steps.ry_token.outputs.token }}' <<<"$pin_step" || {
  echo 'immutable caller validation must bind only the already-minted App token' >&2
  exit 1
}

# The ambient consumer token can read its own base caller but cannot compare
# private central history. Only the App token works; lack of it is fail-closed.
PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=fixture-app FAKE_COMPARE_TOKEN=fixture-app \
  REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
  FAKE_WORKFLOW_CONTENT="$immutable_workflow" \
  "$repo_root/scripts/validate-caller-workflow.sh"

if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=fixture-ambient FAKE_COMPARE_TOKEN=fixture-app \
    REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$immutable_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected the ambient consumer token to fail private central comparison' >&2
  exit 1
fi
grep -Fq 'Could not verify immutable Review Yeti pin' <<<"$output"

if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN='' \
    REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$immutable_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected an absent App token to fail before any API access' >&2
  exit 1
fi
grep -Fq 'GH_TOKEN is required' <<<"$output"

PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
  FAKE_WORKFLOW_CONTENT="$valid_workflow" \
  "$repo_root/scripts/validate-caller-workflow.sh"

PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
  FAKE_WORKFLOW_CONTENT="$immutable_workflow" \
  "$repo_root/scripts/validate-caller-workflow.sh"

if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$invalid_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo "expected central-sha duplication to fail" >&2
  exit 1
fi
grep -Fq "must not duplicate the central release ref as central-sha" <<<"$output"

if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_COMPARE_STATUS=behind FAKE_WORKFLOW_CONTENT="$immutable_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo "expected an immutable pin outside the central release history to fail" >&2
  exit 1
fi
grep -Fq "is not reachable from central v1" <<<"$output"

# A different default branch is deliberately unavailable in the fake API. This pass proves the
# validator uses the base commit supplied by pull_request_target rather than a default-branch ref.
grep -Fq "$base_sha" <(PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" FAKE_WORKFLOW_CONTENT="$valid_workflow" "$repo_root/scripts/validate-caller-workflow.sh")

if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA=not-a-sha \
    FAKE_WORKFLOW_CONTENT="$valid_workflow" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo "expected malformed EXPECTED_BASE_SHA to fail" >&2
  exit 1
fi
grep -Fq "base-sha is invalid" <<<"$output"

# The central repository now uses the same promoted-v1 caller contract and path
# as every consumer; accepting @main here would recreate the self-review bypass.
central_workflow=$'jobs:\n  review:\n    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@v1\n    secrets: inherit\n'
PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example-review-actions CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
  FAKE_WORKFLOW_CONTENT="$central_workflow" \
  "$repo_root/scripts/validate-caller-workflow.sh"

if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example-review-actions CENTRAL_REF=main EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="${central_workflow/@v1/@main}" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo "expected central self-review on main to fail" >&2
  exit 1
fi
grep -Fq "central-ref must be a platform-owned major release ref such as v1" <<<"$output"

echo "validate-caller-workflow contract passed"
