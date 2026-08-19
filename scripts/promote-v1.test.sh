#!/usr/bin/env bash
set -euo pipefail

# Behavioral contract test for promotion. The fake APIs deliberately put `validate` only on
# the merged source commit and `review / Review Yeti` only on the PR head. This catches regressions
# that accidentally validate all required checks against the wrong GitHub coordinate.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT
mkdir -p "$tmp_dir/bin"

cat >"$tmp_dir/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

request="$*"
case "$request" in
  *"repos/exampleorg/example-review-actions --jq"*)
    printf 'main\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/main --jq"*)
    printf '%s\n' "${FAKE_MAIN_SHA:-source123}"
    ;;
  *"repos/exampleorg/example-review-actions/commits/source123 --jq .sha"*)
    printf 'source123\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/source123 --jq .commit.tree.sha"*)
    printf 'tree123\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/head123 --jq .commit.tree.sha"*)
    printf 'tree123\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/source123/pulls?per_page=100"*)
    printf '[[{"number":42,"base":{"ref":"main"},"head":{"sha":"head123"},"merged_at":"2026-08-19T15:00:00Z"}]]\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/source123/check-runs?per_page=100"*)
    printf '{"check_runs":[{"name":"validate","status":"completed","conclusion":"success","completed_at":"2026-08-19T15:01:00Z"}]}\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/head123/check-runs?per_page=100"*)
    printf '{"check_runs":[{"name":"review / Review Yeti","status":"completed","conclusion":"success","completed_at":"2026-08-19T15:02:00Z"}]}\n'
    ;;
  *)
    echo "unexpected fake gh call: $request" >&2
    exit 1
    ;;
esac
FAKE_GH
chmod +x "$tmp_dir/bin/gh"

cat >"$tmp_dir/bin/git" <<'FAKE_GIT'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${FAKE_LOG:-/dev/null}"
case " $* " in
  *" fetch "*) exit 0 ;;
  *" push "*) printf 'pushed\n' ;;
  *"refs/heads/v1 "*)
    if [[ "${FAKE_TAG_ONLY:-}" == true ]]; then exit 2; fi
    printf 'old123\trefs/heads/v1\n'
    ;;
  *"refs/tags/v1 "*)
    if [[ "${FAKE_TAG_ONLY:-}" == true ]]; then printf 'old123\trefs/tags/v1\n'; else exit 2; fi
    ;;
  *" rev-parse refs/remotes/origin/main "*) printf '%s\n' "${FAKE_MAIN_SHA:-source123}" ;;
  *" rev-parse refs/remotes/origin/v1 "*) printf 'old123\n' ;;
  *" rev-parse refs/tags/v1-legacy^{} "*) printf 'old123\n' ;;
  *" merge-base "*) exit 0 ;;
  *) echo "unexpected fake git call: $*" >&2; exit 1 ;;
esac
FAKE_GIT
chmod +x "$tmp_dir/bin/git"

PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
  GITHUB_STEP_SUMMARY="$tmp_dir/summary" \
  "$repo_root/scripts/promote-v1.sh"

grep -Fq 'Originating PR: #42' "$tmp_dir/summary"

if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_MAIN_SHA=other123 \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected stale main promotion to fail" >&2
  exit 1
fi
grep -Fq 'current main tip' <<<"$output"

set +e
tag_only_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_TAG_ONLY=true FAKE_LOG="$tmp_dir/git.log" "$repo_root/scripts/promote-v1.sh"
} 2>&1)"
tag_only_rc=$?
set -e
if [[ "$tag_only_rc" -ne 0 ]]; then
  echo "$tag_only_output" >&2
  exit 1
fi
printf '%s\n' "$tag_only_output"
grep -Fq 'Promoted Review Yeti v1' <<<"$tag_only_output"
grep -Fq 'Removed legacy Review Yeti v1 tag' <<<"$tag_only_output"

echo "promote-v1 behavioral contract passed"
