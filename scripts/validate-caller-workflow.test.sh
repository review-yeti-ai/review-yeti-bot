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
  repos/exampleorg/example/contents/*|repos/exampleorg/example-review-actions/contents/*|repos/review-yeti-ai/review-yeti-bot/contents/*)
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
grep -Fxq '          GH_TOKEN: ${{ steps.target_token_exampleorg.outputs.token || steps.target_token_public.outputs.token }}' <<<"$pin_step" || {
  echo 'immutable caller validation must bind only the already-minted App token' >&2
  exit 1
}
# shellcheck disable=SC2016 # Match the literal GitHub expression, not shell expansion.
grep -Fxq '          GH_CENTRAL_TOKEN: ${{ steps.central_token.outputs.token }}' <<<"$pin_step" || {
  echo 'immutable caller validation must bind the dedicated central App token' >&2
  exit 1
}

# The called workflow is its own immutable trust root. Consumer calls must
# capture job.workflow_sha before any repository checkout and use that exact
# value. The only PR-head exception is the already-governed same-repository
# example-review-actions path; fork and external consumers remain on workflow_sha.
source_step="$(sed -n '/      - name: Resolve immutable central tooling source/,/      - name: Checkout central workflow tooling/p' "$repo_root/.github/workflows/review-yeti.yml")"
source_script="$(
  sed -n '/        run: |/,$p' <<<"$source_step" |
    sed '1d;$d;s/^          //'
)"
[[ -n "$source_script" ]] || {
  echo 'missing trusted pre-checkout central tooling source resolver' >&2
  exit 1
}
# shellcheck disable=SC2016 # Match the literal GitHub expression.
grep -Fxq '          WORKFLOW_SHA: ${{ job.workflow_sha }}' <<<"$source_step" || {
  echo 'central tooling source resolver must bind job.workflow_sha directly' >&2
  exit 1
}
checkout_step="$(sed -n '/      - name: Checkout central workflow tooling/,/      - name: Set up Node 24/p' "$repo_root/.github/workflows/review-yeti.yml")"
# shellcheck disable=SC2016 # Match the literal GitHub expression.
grep -Fxq '          ref: ${{ steps.central_source.outputs.sha }}' <<<"$checkout_step" || {
  echo 'central tooling checkout must use the trusted resolver output' >&2
  exit 1
}
if grep -Eq 'ref:.*(v1|main)' <<<"$checkout_step"; then
  echo 'central tooling checkout must not use a mutable ref' >&2
  exit 1
fi

workflow_sha='54a9ec171b5a8cbc90515ad3998b7c0a9ffb65ff'
same_repo_head='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
run_source_resolver() {
  local repository="$1"
  local head_repository="$2"
  local head_sha="$3"
  local central_execution="${4:-false}"
  local output_file="$tmp_dir/source-output"
  : >"$output_file"
  GITHUB_OUTPUT="$output_file" \
    WORKFLOW_SHA="$workflow_sha" \
    CENTRAL_EXECUTION="$central_execution" \
    CALLER_REPOSITORY="$repository" \
    PR_HEAD_REPOSITORY="$head_repository" \
    PR_HEAD_SHA="$head_sha" \
    bash -c "$source_script"
  sed -n 's/^sha=//p' "$output_file"
}

[[ "$(run_source_resolver review-yeti-ai/review-yeti-bot review-yeti-ai/review-yeti-bot "$same_repo_head")" == "$workflow_sha" ]] || {
  echo 'external self-review must execute central tooling at job.workflow_sha' >&2
  exit 1
}
[[ "$(run_source_resolver exampleorg/example-review-actions exampleorg/example-review-actions "$same_repo_head")" == "$same_repo_head" ]] || {
  echo 'governed same-repository central PRs must retain PR-head policy execution' >&2
  exit 1
}
[[ "$(run_source_resolver exampleorg/example-review-actions untrusted/fork "$same_repo_head")" == "$workflow_sha" ]] || {
  echo 'forked central PRs must execute central tooling at job.workflow_sha' >&2
  exit 1
}
[[ "$(run_source_resolver exampleorg/example-review-actions exampleorg/example-review-actions "$same_repo_head" true)" == "$workflow_sha" ]] || {
  echo 'central dispatch must retain precedence over same-repository PR-head execution' >&2
  exit 1
}

# Every secret reference must be declared by workflow_call. App identity is
# mandatory; providers and optional enrichments remain optional so callers can
# expose only the transports they operate.
secret_interface="$(sed -n '/^  workflow_call:/,/^permissions:/p' "$repo_root/.github/workflows/review-yeti.yml")"
referenced_secrets="$(grep -Eo 'secrets\.[A-Z0-9_]+' "$repo_root/.github/workflows/review-yeti.yml" | sed 's/^secrets\.//' | sort -u)"
while IFS= read -r secret_name; do
  grep -Eq "^      ${secret_name}:$" <<<"$secret_interface" || {
    echo "workflow_call secret interface is missing ${secret_name}" >&2
    exit 1
  }
done <<<"$referenced_secrets"
for required_secret in CT_REVIEW_BOT_APP_ID CT_REVIEW_BOT_APP_PRIVATE_KEY; do
  declaration="$(sed -n "/^      ${required_secret}:$/,/^      [A-Z0-9_]*:$/p" <<<"$secret_interface")"
  grep -Fxq '        required: true' <<<"$declaration" || {
    echo "${required_secret} must be a required workflow_call secret" >&2
    exit 1
  }
done
for optional_secret in CONTEXT7_API_KEY GEMINI_API_KEY HONCHO_API_KEY HONCHO_BASE_URL OLLAMA_PR_REVIEW_API_KEY REVIEW_YETI_BIFROST_API_KEY; do
  declaration="$(sed -n "/^      ${optional_secret}:$/,/^      [A-Z0-9_]*:$/p" <<<"$secret_interface")"
  grep -Fxq '        required: false' <<<"$declaration" || {
    echo "${optional_secret} must remain an optional workflow_call secret" >&2
    exit 1
  }
done
if grep -Fq 'OPENROUTER_REVIEW_FLEET_KEY' <<<"$secret_interface"; then
  echo 'retired OpenRouter credential must not be declared by workflow_call' >&2
  exit 1
fi

# The target App reads consumer contents while the dedicated central App reads
# private central history. The two identities must remain distinct and the
# central token is mandatory for immutable comparison.
PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=fixture-target GH_CENTRAL_TOKEN=fixture-central FAKE_COMPARE_TOKEN=fixture-central \
  REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
  FAKE_WORKFLOW_CONTENT="$immutable_workflow" \
  "$repo_root/scripts/validate-caller-workflow.sh"

if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=fixture-target GH_CENTRAL_TOKEN=fixture-wrong-central FAKE_COMPARE_TOKEN=fixture-central \
    REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$immutable_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected the wrong central App token to fail private central comparison' >&2
  exit 1
fi
grep -Fq 'Could not verify immutable Review Yeti pin' <<<"$output"

if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=fixture-target GH_CENTRAL_TOKEN='' \
    REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$immutable_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected an absent central App token to fail before any API access' >&2
  exit 1
fi
grep -Fq 'GH_CENTRAL_TOKEN is required' <<<"$output"

PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
  FAKE_WORKFLOW_CONTENT="$valid_workflow" \
  "$repo_root/scripts/validate-caller-workflow.sh"

PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=test GH_CENTRAL_TOKEN=central-test FAKE_COMPARE_TOKEN=central-test \
  REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
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
    GH_TOKEN=test GH_CENTRAL_TOKEN=central-test FAKE_COMPARE_TOKEN=central-test \
    REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
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

# The public external self-review repository cannot resolve this private
# reusable workflow. Every direct shape fails with one explicit route: use the
# base-owned central dispatch workflow instead.
external_workflow=$'name: Review Yeti\non:\n  pull_request_target:\njobs:\n  review:\n    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@54a9ec171b5a8cbc90515ad3998b7c0a9ffb65ff\n    secrets:\n      CT_REVIEW_BOT_APP_ID: ${{ secrets.CT_REVIEW_BOT_APP_ID }}\n      CT_REVIEW_BOT_APP_PRIVATE_KEY: ${{ secrets.CT_REVIEW_BOT_APP_PRIVATE_KEY }}\n      REVIEW_YETI_BIFROST_API_KEY: ${{ secrets.REVIEW_YETI_BIFROST_API_KEY }}\n'
if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    REVIEW_REPOSITORY=review-yeti-ai/review-yeti-bot CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$external_workflow" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected the external reusable-workflow caller to fail' >&2
  exit 1
fi
grep -Fq 'external self-review must use the central dispatch workflow' <<<"$output"
external_floating="${external_workflow/@54a9ec171b5a8cbc90515ad3998b7c0a9ffb65ff/@v1}"
if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    REVIEW_REPOSITORY=review-yeti-ai/review-yeti-bot CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$external_floating" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected the external self-review caller floating v1 ref to fail' >&2
  exit 1
fi
grep -Fq 'external self-review must use the central dispatch workflow' <<<"$output"

external_inherit=$'jobs:\n  review:\n    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@54a9ec171b5a8cbc90515ad3998b7c0a9ffb65ff\n    secrets: inherit\n'
if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    REVIEW_REPOSITORY=review-yeti-ai/review-yeti-bot CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$external_inherit" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected external secrets inheritance to fail' >&2
  exit 1
fi
grep -Fq 'external self-review must use the central dispatch workflow' <<<"$output"

external_extra_secret="${external_workflow}"$'      UNRELATED_SECRET: ${{ secrets.UNRELATED_SECRET }}\n'
if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    REVIEW_REPOSITORY=review-yeti-ai/review-yeti-bot CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$external_extra_secret" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected an unallowlisted external secret mapping to fail' >&2
  exit 1
fi
grep -Fq 'external self-review must use the central dispatch workflow' <<<"$output"

external_missing_identity="$(grep -v 'CT_REVIEW_BOT_APP_PRIVATE_KEY:' <<<"$external_workflow")"
if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    REVIEW_REPOSITORY=review-yeti-ai/review-yeti-bot CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$external_missing_identity" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected a missing mandatory App identity mapping to fail' >&2
  exit 1
fi
grep -Fq 'external self-review must use the central dispatch workflow' <<<"$output"

external_pr_head_job="${external_workflow}"$'  unsafe:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n'
if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    REVIEW_REPOSITORY=review-yeti-ai/review-yeti-bot CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$external_pr_head_job" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected external PR-head execution to fail' >&2
  exit 1
fi
grep -Fq 'external self-review must use the central dispatch workflow' <<<"$output"

external_duplicate_uses="${external_workflow/    secrets:/    uses: attacker\/untrusted\/.github\/workflows\/review.yml@main$'\n'    secrets:}"
if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    REVIEW_REPOSITORY=review-yeti-ai/review-yeti-bot CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$external_duplicate_uses" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected a duplicate reusable-workflow target to fail' >&2
  exit 1
fi
grep -Fq 'external self-review must use the central dispatch workflow' <<<"$output"

external_with_override="${external_workflow/    secrets:/$'    with:\n      central_execution: true\n    secrets:'}"
if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    REVIEW_REPOSITORY=review-yeti-ai/review-yeti-bot CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$external_with_override" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected external reusable-workflow input overrides to fail' >&2
  exit 1
fi
grep -Fq 'external self-review must use the central dispatch workflow' <<<"$output"

external_duplicate_secrets="${external_workflow}"$'    secrets:\n      CT_REVIEW_BOT_APP_ID: ${{ secrets.CT_REVIEW_BOT_APP_ID }}\n      CT_REVIEW_BOT_APP_PRIVATE_KEY: ${{ secrets.CT_REVIEW_BOT_APP_PRIVATE_KEY }}\n'
if output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    REVIEW_REPOSITORY=review-yeti-ai/review-yeti-bot CENTRAL_REF=v1 EXPECTED_BASE_SHA="$base_sha" \
    FAKE_WORKFLOW_CONTENT="$external_duplicate_secrets" "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo 'expected duplicate YAML secret mappings to fail' >&2
  exit 1
fi
grep -Fq 'external self-review must use the central dispatch workflow' <<<"$output"

echo "validate-caller-workflow contract passed"
