#!/usr/bin/env bash
set -euo pipefail

# Contract test for the consumer-facing release ref. This deliberately uses a
# fake gh API so the test proves the caller parser without requiring network
# access or a real PR. In particular, a caller that reintroduces central-sha
# must fail even when its @v1 line is otherwise correct.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

mkdir -p "$tmp_dir/bin"
cat >"$tmp_dir/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

case "${2:-}" in
  repos/exampleorg/example)
    printf '{"default_branch":"main"}\n'
    ;;
  repos/exampleorg/example/contents/*)
    encoded="$(printf '%s' "${FAKE_WORKFLOW_CONTENT}" | base64 | tr -d '\n')"
    printf '{"content":"%s"}\n' "$encoded"
    ;;
  *)
    echo "unexpected fake gh call: $*" >&2
    exit 1
    ;;
esac
FAKE_GH
chmod +x "$tmp_dir/bin/gh"

valid_workflow=$'jobs:\n  review:\n    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@v1\n    secrets: inherit\n'
invalid_workflow="${valid_workflow}"$'    with:\n      central-sha: 0123456789012345678901234567890123456789\n'

PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 \
  FAKE_WORKFLOW_CONTENT="$valid_workflow" \
  "$repo_root/scripts/validate-caller-workflow.sh"

if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example CENTRAL_REF=v1 \
    FAKE_WORKFLOW_CONTENT="$invalid_workflow" \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo "expected central-sha duplication to fail" >&2
  exit 1
fi
grep -Fq "must not duplicate the central release ref as central-sha" <<<"$output"

echo "validate-caller-workflow contract passed"
