#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

fake_bin="$tmp_dir/bin"
mkdir -p "$fake_bin"
printf '%s\n' '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'case "$*" in' \
  '  *"git/ref/tags/v1"*) if [[ "${FAKE_LIGHTWEIGHT:-}" == true ]]; then printf "%s\n" '\''{"object":{"type":"commit","sha":"0123456789abcdef0123456789abcdef01234567"}}'\''; elif [[ "${FAKE_MOVED_TAG:-}" == true ]]; then printf "%s\n" '\''{"object":{"type":"tag","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}'\''; else printf "%s\n" '\''{"object":{"type":"tag","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'\''; fi;;' \
  '  *"git/tags/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"*) if [[ "${FAKE_BAD_TAG:-}" == true ]]; then printf "%s\n" '\''{"object":{"type":"commit","sha":"fedcba9876543210fedcba9876543210fedcba98"}}'\''; elif [[ "${FAKE_NON_COMMIT_TAG:-}" == true ]]; then printf "%s\n" '\''{"object":{"type":"tree","sha":"tree-object"}}'\''; else printf "%s\n" '\''{"object":{"type":"commit","sha":"0123456789abcdef0123456789abcdef01234567"}}'\''; fi;;' \
  '  *"git/tags/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"*) printf "%s\n" '\''{"object":{"type":"commit","sha":"0123456789abcdef0123456789abcdef01234567"}}'\'';;' \
  '  *"compare/main...0123456789abcdef0123456789abcdef01234567"*) if [[ "${FAKE_BAD_COMPARE:-}" == true ]]; then printf "%s\n" diverged; elif [[ "${FAKE_IDENTICAL:-}" == true ]]; then printf "%s\n" identical; else printf "%s\n" behind; fi;;' \
  '  *) echo "unexpected gh call: $*" >&2; exit 1;;' \
  'esac' > "$fake_bin/gh"
chmod +x "$fake_bin/gh"

output_file="$tmp_dir/output"
PATH="$fake_bin:$PATH" GH_TOKEN=test-token GITHUB_OUTPUT="$output_file" \
  REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=v1 \
  "$repo_root/scripts/resolve-release-channel.sh"
grep -q '^sha<<' "$output_file"
grep -qx '0123456789abcdef0123456789abcdef01234567' "$output_file"
grep -q '^ref_sha<<' "$output_file"
grep -qx aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$output_file"
grep -q '^channel<<' "$output_file"
grep -qx v1 "$output_file"

PATH="$fake_bin:$PATH" GH_TOKEN=test-token \
  REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=v1 \
  RESOLVED_SHA=0123456789abcdef0123456789abcdef01234567 \
  RESOLVED_REF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$repo_root/scripts/validate-release-provenance.sh"

PATH="$fake_bin:$PATH" GH_TOKEN=test-token FAKE_IDENTICAL=true \
  REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=v1 \
  RESOLVED_SHA=0123456789abcdef0123456789abcdef01234567 \
  RESOLVED_REF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$repo_root/scripts/validate-release-provenance.sh"

PATH="$fake_bin:$PATH" GH_TOKEN=test-token FAKE_MOVED_TAG=true \
  REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=v1 \
  RESOLVED_SHA=0123456789abcdef0123456789abcdef01234567 \
  RESOLVED_REF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$repo_root/scripts/validate-release-provenance.sh" > "$tmp_dir/moved-tag.log"
grep -q 'advanced during this run' "$tmp_dir/moved-tag.log"

lightweight_output="$tmp_dir/lightweight-output"
PATH="$fake_bin:$PATH" GH_TOKEN=test-token GITHUB_OUTPUT="$lightweight_output" FAKE_LIGHTWEIGHT=true \
  REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=v1 \
  "$repo_root/scripts/resolve-release-channel.sh"
grep -qx '0123456789abcdef0123456789abcdef01234567' "$lightweight_output"

expect_failure() {
  local name="$1"
  shift
  set +e
  "$@" > "$tmp_dir/${name}.log" 2>&1
  local rc=$?
  set -e
  [[ "$rc" -eq 1 ]]
}

expect_failure invalid-sha env \
  PATH="$fake_bin:$PATH" GH_TOKEN=test-token REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=v1 RESOLVED_SHA=not-a-sha RESOLVED_REF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$repo_root/scripts/validate-release-provenance.sh"
grep -q 'RESOLVED_SHA is invalid' "$tmp_dir/invalid-sha.log"

expect_failure bad-compare env \
  PATH="$fake_bin:$PATH" GH_TOKEN=test-token FAKE_BAD_COMPARE=true REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=v1 RESOLVED_SHA=0123456789abcdef0123456789abcdef01234567 RESOLVED_REF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$repo_root/scripts/validate-release-provenance.sh"
grep -q 'not reachable' "$tmp_dir/bad-compare.log"

expect_failure bad-tag env \
  PATH="$fake_bin:$PATH" GH_TOKEN=test-token FAKE_BAD_TAG=true REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=v1 RESOLVED_SHA=0123456789abcdef0123456789abcdef01234567 RESOLVED_REF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$repo_root/scripts/validate-release-provenance.sh"
grep -q 'does not match release tag' "$tmp_dir/bad-tag.log"

expect_failure non-commit-tag env \
  PATH="$fake_bin:$PATH" GH_TOKEN=test-token FAKE_NON_COMMIT_TAG=true REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=v1 RESOLVED_SHA=0123456789abcdef0123456789abcdef01234567 RESOLVED_REF_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  "$repo_root/scripts/validate-release-provenance.sh"
grep -q 'non-commit object' "$tmp_dir/non-commit-tag.log"

set +e
PATH="$fake_bin:$PATH" GH_TOKEN=test-token GITHUB_OUTPUT="$tmp_dir/invalid-output" \
  REVIEW_YETI_REPOSITORY='review-yeti-ai/review-yeti-bot' \
  REVIEW_YETI_ACTION_CHANNEL=main \
  "$repo_root/scripts/resolve-release-channel.sh" > "$tmp_dir/invalid.log" 2>&1
rc=$?
set -e
[[ "$rc" -eq 1 ]]
grep -q 'not a release channel' "$tmp_dir/invalid.log"

echo "release channel resolution and provenance contract passed"
