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
    printf '%s\n' "${FAKE_MAIN_SHA:-2222222222222222222222222222222222222222}"
    ;;
  *"repos/exampleorg/example-review-actions/commits/2222222222222222222222222222222222222222 --jq .sha"*)
    printf '2222222222222222222222222222222222222222\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/2222222222222222222222222222222222222222/pulls?per_page=100"*)
    printf '[[{"number":42,"base":{"ref":"main"},"head":{"sha":"head123"},"merge_commit_sha":"2222222222222222222222222222222222222222","merged_at":"2026-08-19T15:00:00Z"}]]\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/2222222222222222222222222222222222222222/check-runs?per_page=100"*)
    printf '{"check_runs":[{"id":11,"name":"validate","status":"completed","conclusion":"success","completed_at":"2026-08-19T15:01:00Z"}]}\n'
    ;;
  *"repos/exampleorg/example-review-actions/pulls/42/commits?per_page=100"*)
    printf '[[{"sha":"oldhead1"},{"sha":"head123"}]]\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/oldhead1/check-runs?per_page=100"*)
    if [[ "${FAKE_EARLIER_GREEN:-}" == true ]]; then
      printf '{"check_runs":[{"id":1,"name":"review / Review Yeti","status":"completed","conclusion":"success","completed_at":"2026-08-19T14:58:00Z"}]}\n'
    else
      printf '{"check_runs":[{"id":1,"name":"review / Review Yeti","status":"completed","conclusion":"failure","completed_at":"2026-08-19T14:58:00Z"}]}\n'
    fi
    ;;
  *"repos/exampleorg/example-review-actions/commits/head123/check-runs?per_page=100"*)
    if [[ "${FAKE_HEAD_RED:-}" == true ]]; then
      printf '{"check_runs":[{"id":3,"name":"review / Review Yeti","status":"completed","conclusion":"failure","completed_at":"2026-08-19T15:04:00Z"}]}\n'
    elif [[ "${FAKE_STALE_THEN_FRESH:-}" == true ]]; then
      # A prior attempt on this exact head SHA (e.g. a transient failure that was rerun)
      # completed and left a check-run behind; a fresh rerun (higher id, no completed_at yet)
      # is the one that actually reflects reality. `last` must key off recency of the attempt
      # (id), not completion time, or a stale failed attempt permanently shadows the live one --
      # this is the shape of the deadlock: a red check "at merge time" that a rerun already
      # superseded, but the picker never looks past it.
      if [[ ! -e "${FAKE_STALE_MARKER:?}" ]]; then
        touch "$FAKE_STALE_MARKER"
        printf '{"check_runs":[{"id":1,"name":"review / Review Yeti","status":"completed","conclusion":"failure","completed_at":"2026-08-19T15:00:00Z"},{"id":2,"name":"review / Review Yeti","status":"in_progress","conclusion":null,"completed_at":null}]}\n'
      else
        printf '{"check_runs":[{"id":1,"name":"review / Review Yeti","status":"completed","conclusion":"failure","completed_at":"2026-08-19T15:00:00Z"},{"id":2,"name":"review / Review Yeti","status":"completed","conclusion":"success","completed_at":"2026-08-19T15:03:00Z"}]}\n'
      fi
    elif [[ "${FAKE_PENDING_ONCE:-}" == true && ! -e "${FAKE_PENDING_MARKER:?}" ]]; then
      touch "$FAKE_PENDING_MARKER"
      printf '{"check_runs":[{"id":1,"name":"review / Review Yeti","status":"in_progress","conclusion":null,"completed_at":null}]}\n'
    else
      printf '{"check_runs":[{"id":21,"name":"review / Review Yeti","status":"completed","conclusion":"success","completed_at":"2026-08-19T15:02:00Z"}]}\n'
    fi
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
  *" push "*)
    if [[ "${FAKE_MAIN_LEASE_FAIL:-}" == true ]]; then
      echo "simulated main lease rejection" >&2
      exit 1
    fi
    if [[ "$*" == *":refs/tags/v1"* && "${FAKE_TAG_DELETE_FAIL:-}" == true ]]; then
      echo "simulated legacy tag deletion failure" >&2
      exit 1
    fi
    if [[ "$*" == *":refs/heads/v1"* && "${FAKE_BRANCH_PUSH_FAIL:-}" == true ]]; then
      echo "simulated v1 branch update failure" >&2
      exit 1
    fi
    printf 'pushed\n'
    ;;
  *"refs/heads/v1 "*)
    if [[ "${FAKE_TAG_ONLY:-}" == true || "${FAKE_NO_V1:-}" == true ]]; then exit 2; fi
    printf '%s\trefs/heads/v1\n' "${FAKE_V1_SHA:-1111111111111111111111111111111111111111}"
    ;;
  *"refs/tags/v1 "*)
    if [[ "${FAKE_TAG_ONLY:-}" == true ]]; then printf '1111111111111111111111111111111111111111\trefs/tags/v1\n'; else exit 2; fi
    ;;
  *" rev-parse refs/remotes/origin/main "*) printf '%s\n' "${FAKE_MAIN_SHA:-2222222222222222222222222222222222222222}" ;;
  *" rev-parse refs/remotes/origin/v1 "*) printf '%s\n' "${FAKE_V1_SHA:-1111111111111111111111111111111111111111}" ;;
  *" rev-parse refs/tags/v1-legacy^{} "*) printf '1111111111111111111111111111111111111111\n' ;;
  *" merge-base "*)
    if [[ "${FAKE_DIVERGED:-}" == true ]]; then exit 1; fi
    exit 0
    ;;
  *) echo "unexpected fake git call: $*" >&2; exit 1 ;;
esac
FAKE_GIT
chmod +x "$tmp_dir/bin/git"

export EXPECTED_OLD_V1_SHA=1111111111111111111111111111111111111111
export GITHUB_ACTOR=test-operator
export PROMOTION_RECEIPT_PATH="$tmp_dir/promotion-receipt.json"

if malformed_source_output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test SOURCE_SHA=short \
    GITHUB_REPOSITORY=exampleorg/example-review-actions \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected malformed source SHA to fail" >&2
  exit 1
fi
grep -Fq 'SOURCE_SHA must be an exact lowercase 40-character commit SHA' <<<"$malformed_source_output"

if malformed_old_output="$({
  PATH="$tmp_dir/bin:$PATH" GH_TOKEN=test \
    SOURCE_SHA=2222222222222222222222222222222222222222 \
    EXPECTED_OLD_V1_SHA=short GITHUB_REPOSITORY=exampleorg/example-review-actions \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected malformed old v1 SHA to fail" >&2
  exit 1
fi
grep -Fq "EXPECTED_OLD_V1_SHA must be an exact lowercase 40-character commit SHA or 'absent'" <<<"$malformed_old_output"

fast_forward_log="$tmp_dir/fast-forward.log"
PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=credential-sentinel-must-not-appear SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
  FAKE_LOG="$fast_forward_log" \
  GITHUB_STEP_SUMMARY="$tmp_dir/summary" \
  "$repo_root/scripts/promote-v1.sh"

grep -Fq 'Originating PR: #42' "$tmp_dir/summary"
grep -Fxq 'merge-base --is-ancestor 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222' "$fast_forward_log"
grep -Fxq 'push --atomic --force-with-lease=refs/heads/main:2222222222222222222222222222222222222222 --force-with-lease=refs/heads/v1:1111111111111111111111111111111111111111 origin 2222222222222222222222222222222222222222:refs/heads/main 2222222222222222222222222222222222222222:refs/heads/v1' "$fast_forward_log"
if grep -Eq 'push .*HEAD|push .*codex/' "$fast_forward_log"; then
  echo "promotion must use the exact candidate SHA, not the ambient checkout" >&2
  exit 1
fi
jq -e '
  .schema == "exampleorg.review-yeti-v1-promotion-receipt.v1" and
  .actor == "test-operator" and
  .release.source_sha == "2222222222222222222222222222222222222222" and
  .release.pr_number == 42 and
  .validation.validate_check_run_id == 11 and
  .validation.review_check_run_id == 21 and
  (.validation.digest | test("^[0-9a-f]{64}$")) and
  .refs.expected_old_v1_sha == "1111111111111111111111111111111111111111" and
  .refs.new_v1_sha == "2222222222222222222222222222222222222222" and
  .rollback.direct_ref_rewind_allowed == false and
  .result == "promoted" and
  .write_performed == true
' "$PROMOTION_RECEIPT_PATH" >/dev/null
if grep -Fq 'credential-sentinel-must-not-appear' "$PROMOTION_RECEIPT_PATH"; then
  echo "promotion receipt exposed credential content" >&2
  exit 1
fi

# A divergent active channel must fail before any ref update.
divergence_log="$tmp_dir/divergence.log"
if divergence_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_DIVERGED=true FAKE_LOG="$divergence_log" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected divergent v1 promotion to fail" >&2
  exit 1
fi
grep -Fq 'Refusing non-fast-forward v1 promotion from 1111111111111111111111111111111111111111 to 2222222222222222222222222222222222222222' <<<"$divergence_output"
if grep -Fq 'push ' "$divergence_log"; then
  echo "divergent promotion attempted a ref update" >&2
  exit 1
fi

# An already-promoted candidate is an idempotent success and performs no write.
idempotent_log="$tmp_dir/idempotent.log"
idempotent_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    EXPECTED_OLD_V1_SHA=2222222222222222222222222222222222222222 FAKE_V1_SHA=2222222222222222222222222222222222222222 FAKE_LOG="$idempotent_log" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"
grep -Fq 'Review Yeti v1 already points to 2222222222222222222222222222222222222222' <<<"$idempotent_output"
if grep -Fq 'push ' "$idempotent_log"; then
  echo "idempotent promotion attempted a ref update" >&2
  exit 1
fi
jq -e '.result == "already-promoted" and .write_performed == false' "$PROMOTION_RECEIPT_PATH" >/dev/null

# A rejected branch update must not print a success receipt or attempt another
# ref update. This is the non-partial branch-only failure case.
failed_branch_log="$tmp_dir/failed-branch.log"
if failed_branch_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_BRANCH_PUSH_FAIL=true FAKE_LOG="$failed_branch_log" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected rejected v1 branch update to fail" >&2
  exit 1
fi
grep -Fq 'simulated v1 branch update failure' <<<"$failed_branch_output"
if grep -Fq 'Promoted Review Yeti v1' <<<"$failed_branch_output"; then
  echo "failed v1 branch update reported promotion success" >&2
  exit 1
fi
[[ "$(grep -c '^push ' "$failed_branch_log")" -eq 1 ]]

# A stale caller-supplied old ref fails before any remote write.
stale_expected_log="$tmp_dir/stale-expected.log"
if stale_expected_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 \
    EXPECTED_OLD_V1_SHA=3333333333333333333333333333333333333333 \
    GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_LOG="$stale_expected_log" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected stale old v1 input to fail" >&2
  exit 1
fi
grep -Fq 'Expected v1 at 3333333333333333333333333333333333333333, but observed 1111111111111111111111111111111111111111' <<<"$stale_expected_output"
if grep -Fq 'push ' "$stale_expected_log"; then
  echo "stale expected old ref attempted a push" >&2
  exit 1
fi

# The no-op main refspec shares the atomic transaction. A main lease rejection
# therefore fails without a success receipt or a partially updated v1.
main_lease_log="$tmp_dir/main-lease.log"
main_lease_receipt="$tmp_dir/main-lease-receipt.json"
if main_lease_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 \
    GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_MAIN_LEASE_FAIL=true FAKE_LOG="$main_lease_log" \
    PROMOTION_RECEIPT_PATH="$main_lease_receipt" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected moved main lease to reject the atomic promotion" >&2
  exit 1
fi
grep -Fq 'simulated main lease rejection' <<<"$main_lease_output"
if grep -Fq 'Promoted Review Yeti v1' <<<"$main_lease_output"; then
  echo "main lease rejection reported promotion success" >&2
  exit 1
fi
[[ "$(grep -c '^push ' "$main_lease_log")" -eq 1 ]]
grep -Fq -- '--force-with-lease=refs/heads/main:2222222222222222222222222222222222222222' "$main_lease_log"
[[ ! -e "$main_lease_receipt" ]]

if output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
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
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
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
grep -Fq 'Removed legacy Review Yeti v1 tag in the same atomic promotion' <<<"$tag_only_output"
grep -Fxq 'push --atomic --force-with-lease=refs/heads/main:2222222222222222222222222222222222222222 --force-with-lease=refs/heads/v1: --force-with-lease=refs/tags/v1:1111111111111111111111111111111111111111 origin 2222222222222222222222222222222222222222:refs/heads/main 2222222222222222222222222222222222222222:refs/heads/v1 :refs/tags/v1' "$tmp_dir/git.log"

# First initialization requires an explicit absent expectation and a lease that
# rejects creation if another actor creates v1 before the atomic push.
initialize_log="$tmp_dir/initialize.log"
initialize_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 \
    EXPECTED_OLD_V1_SHA=absent GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_NO_V1=true FAKE_LOG="$initialize_log" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"
grep -Fq 'Promoted Review Yeti v1 from <uninitialized>' <<<"$initialize_output"
grep -Fxq 'push --atomic --force-with-lease=refs/heads/main:2222222222222222222222222222222222222222 --force-with-lease=refs/heads/v1: origin 2222222222222222222222222222222222222222:refs/heads/main 2222222222222222222222222222222222222222:refs/heads/v1' "$initialize_log"

# A legacy migration is one atomic push. If the remote rejects the tag deletion,
# the script reports no success and cannot have moved only the branch.
partial_update_log="$tmp_dir/partial-update.log"
partial_receipt="$tmp_dir/partial-receipt.json"
if partial_update_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_TAG_ONLY=true FAKE_TAG_DELETE_FAIL=true FAKE_LOG="$partial_update_log" \
    PROMOTION_RECEIPT_PATH="$partial_receipt" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected failed legacy tag deletion to fail the promotion" >&2
  exit 1
fi
grep -Fq 'simulated legacy tag deletion failure' <<<"$partial_update_output"
if grep -Fq 'Promoted Review Yeti v1' <<<"$partial_update_output"; then
  echo "failed atomic migration reported promotion success" >&2
  exit 1
fi
[[ "$(grep -c '^push ' "$partial_update_log")" -eq 1 ]]
grep -Fq -- '--atomic' "$partial_update_log"
grep -Fq '2222222222222222222222222222222222222222:refs/heads/v1' "$partial_update_log"
grep -Fq ':refs/tags/v1' "$partial_update_log"
[[ ! -e "$partial_receipt" ]]

pending_marker="$tmp_dir/pending-marker"
pending_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    PROMOTION_WAIT_SECONDS=2 PROMOTION_POLL_SECONDS=0 \
    FAKE_PENDING_ONCE=true FAKE_PENDING_MARKER="$pending_marker" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"
grep -Fq 'Waiting for PR #42 head head123: review / Review Yeti' <<<"$pending_output"

# A stale, already-completed FAILURE check-run must never permanently shadow a fresher rerun
# (higher id) on the same head SHA that is still in flight (or has since succeeded). Deadlock
# regression: this is the "check was red once, so it can never promote" trap -- the picker must
# key off attempt recency (id), not completion time.
stale_marker="$tmp_dir/stale-marker"
set +e
stale_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    PROMOTION_WAIT_SECONDS=2 PROMOTION_POLL_SECONDS=0 \
    FAKE_STALE_THEN_FRESH=true FAKE_STALE_MARKER="$stale_marker" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"
stale_rc=$?
set -e
if [[ "$stale_rc" -ne 0 ]]; then
  echo "expected promotion to recover past the stale failed attempt and succeed:" >&2
  echo "$stale_output" >&2
  exit 1
fi
grep -Fq 'Promoted Review Yeti v1' <<<"$stale_output"

# Stranded-head rescue: the merged head has NO green review (an update-branch or
# in-flight-merge push left it red), but an earlier commit of the SAME pull
# request was reviewed green. The fallback walk must accept that earlier green
# review with a loud warning instead of stranding the promotion.
stranded_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_HEAD_RED=true FAKE_EARLIER_GREEN=true \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"
grep -Fq 'accepting the green review on earlier PR commit oldhead1' <<<"$stranded_output"
grep -Fq 'Promoted Review Yeti v1' <<<"$stranded_output"

# No green review anywhere on the pull request: the fallback walk finds nothing
# and the promotion must still refuse — a deliberately unreviewed merge stays
# stranded rather than being rescued.
set +e
unreviewed_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=2222222222222222222222222222222222222222 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    PROMOTION_WAIT_SECONDS=2 PROMOTION_POLL_SECONDS=0 \
    FAKE_HEAD_RED=true \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"
unreviewed_rc=$?
set -e
if [[ "$unreviewed_rc" -eq 0 ]]; then
  echo "expected promotion with no green review on any PR commit to refuse:" >&2
  echo "$unreviewed_output" >&2
  exit 1
fi
grep -Fq 'Required central check did not pass' <<<"$unreviewed_output"

# The dry-run audit uses exact, caller-supplied old/new SHAs and local refs only.
# It must model fast-forward, idempotent rerun, divergence, stale expected-old,
# and rollback inputs without fetching, pushing, or requiring credentials.
audit_bin="$tmp_dir/audit-bin"
mkdir -p "$audit_bin"
cat >"$audit_bin/git" <<'FAKE_AUDIT_GIT'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "${FAKE_LOG:?}"
case " $* " in
  *" rev-parse --verify refs/remotes/origin/main^{commit} "*)
    if [[ "${AUDIT_MAIN_MISSING:-}" == true ]]; then exit 1; fi
    printf '%s\n' "$AUDIT_MAIN_SHA"
    ;;
  *" rev-parse --verify refs/remotes/origin/v1^{commit} "*) printf '%s\n' "$AUDIT_V1_SHA" ;;
  *" rev-parse --verify ${AUDIT_SOURCE_SHA}^{commit} "*) printf '%s\n' "$AUDIT_SOURCE_SHA" ;;
  *" rev-parse --verify ${AUDIT_EXPECTED_OLD_SHA}^{commit} "*) printf '%s\n' "$AUDIT_EXPECTED_OLD_SHA" ;;
  *" merge-base --is-ancestor "*)
    if [[ "${AUDIT_DIVERGED:-}" == true ]]; then exit 1; fi
    exit 0
    ;;
  *) echo "unexpected fake audit git call: $*" >&2; exit 1 ;;
esac
FAKE_AUDIT_GIT
chmod +x "$audit_bin/git"

audit_old_sha=1111111111111111111111111111111111111111
audit_new_sha=2222222222222222222222222222222222222222
audit_log="$tmp_dir/audit-fast-forward.log"
audit_output="$({
  PATH="$audit_bin:$PATH" \
    GH_TOKEN=credential-sentinel-must-not-appear \
    SOURCE_SHA="$audit_new_sha" EXPECTED_OLD_V1_SHA="$audit_old_sha" \
    AUDIT_MAIN_SHA="$audit_new_sha" AUDIT_V1_SHA="$audit_old_sha" \
    AUDIT_SOURCE_SHA="$audit_new_sha" AUDIT_EXPECTED_OLD_SHA="$audit_old_sha" \
    FAKE_LOG="$audit_log" \
    "$repo_root/scripts/audit-v1-promotion.sh"
} 2>&1)"
grep -Fxq "expected_old_ref=refs/heads/v1" <<<"$audit_output"
grep -Fxq 'ref_snapshot=local-only' <<<"$audit_output"
grep -Fxq 'remote_access=false' <<<"$audit_output"
grep -Fxq "expected_old_sha=$audit_old_sha" <<<"$audit_output"
grep -Fxq "expected_new_ref=refs/heads/v1" <<<"$audit_output"
grep -Fxq "expected_new_sha=$audit_new_sha" <<<"$audit_output"
grep -Fxq 'relation=fast-forward' <<<"$audit_output"
grep -Fxq 'eligible=true' <<<"$audit_output"
grep -Fxq 'rollback_strategy=create-reviewed-revert-on-main-then-promote' <<<"$audit_output"
grep -Fxq "rollback_from_sha=$audit_new_sha" <<<"$audit_output"
grep -Fxq "rollback_baseline_sha=$audit_old_sha" <<<"$audit_output"
grep -Fxq 'direct_ref_rewind_allowed=false' <<<"$audit_output"
grep -Fxq 'write_performed=false' <<<"$audit_output"
if grep -Fq 'credential-sentinel-must-not-appear' <<<"$audit_output"; then
  echo "read-only audit exposed credential content" >&2
  exit 1
fi
if grep -Eq 'fetch|ls-remote|push|token|credential' "$audit_log"; then
  echo "read-only audit attempted remote access or exposed a credential field" >&2
  exit 1
fi

audit_idempotent_log="$tmp_dir/audit-idempotent.log"
audit_idempotent_output="$({
  PATH="$audit_bin:$PATH" \
    SOURCE_SHA="$audit_new_sha" EXPECTED_OLD_V1_SHA="$audit_new_sha" \
    AUDIT_MAIN_SHA="$audit_new_sha" AUDIT_V1_SHA="$audit_new_sha" \
    AUDIT_SOURCE_SHA="$audit_new_sha" AUDIT_EXPECTED_OLD_SHA="$audit_new_sha" \
    FAKE_LOG="$audit_idempotent_log" \
    "$repo_root/scripts/audit-v1-promotion.sh"
} 2>&1)"
grep -Fxq 'relation=idempotent' <<<"$audit_idempotent_output"
grep -Fxq 'write_performed=false' <<<"$audit_idempotent_output"

audit_stale_candidate_main_sha=3333333333333333333333333333333333333333
audit_stale_candidate_log="$tmp_dir/audit-stale-candidate.log"
if audit_stale_candidate_output="$({
  PATH="$audit_bin:$PATH" \
    SOURCE_SHA="$audit_new_sha" EXPECTED_OLD_V1_SHA="$audit_old_sha" \
    AUDIT_MAIN_SHA="$audit_stale_candidate_main_sha" AUDIT_V1_SHA="$audit_old_sha" \
    AUDIT_SOURCE_SHA="$audit_new_sha" AUDIT_EXPECTED_OLD_SHA="$audit_old_sha" \
    FAKE_LOG="$audit_stale_candidate_log" \
    "$repo_root/scripts/audit-v1-promotion.sh"
} 2>&1)"; then
  echo "expected stale candidate audit to refuse promotion" >&2
  exit 1
fi
grep -Fxq "main_sha=$audit_stale_candidate_main_sha" <<<"$audit_stale_candidate_output"
grep -Fxq "candidate_sha=$audit_new_sha" <<<"$audit_stale_candidate_output"
grep -Fxq 'relation=stale-candidate' <<<"$audit_stale_candidate_output"
grep -Fxq 'eligible=false' <<<"$audit_stale_candidate_output"
grep -Fxq 'write_performed=false' <<<"$audit_stale_candidate_output"

audit_diverged_log="$tmp_dir/audit-diverged.log"
if audit_diverged_output="$({
  PATH="$audit_bin:$PATH" \
    SOURCE_SHA="$audit_new_sha" EXPECTED_OLD_V1_SHA="$audit_old_sha" \
    AUDIT_MAIN_SHA="$audit_new_sha" AUDIT_V1_SHA="$audit_old_sha" \
    AUDIT_SOURCE_SHA="$audit_new_sha" AUDIT_EXPECTED_OLD_SHA="$audit_old_sha" \
    AUDIT_DIVERGED=true FAKE_LOG="$audit_diverged_log" \
    "$repo_root/scripts/audit-v1-promotion.sh"
} 2>&1)"; then
  echo "expected divergent audit to refuse promotion" >&2
  exit 1
fi
grep -Fxq 'relation=diverged' <<<"$audit_diverged_output"
grep -Fxq 'eligible=false' <<<"$audit_diverged_output"
grep -Fxq 'write_performed=false' <<<"$audit_diverged_output"

audit_observed_sha=3333333333333333333333333333333333333333
audit_stale_log="$tmp_dir/audit-stale.log"
if audit_stale_output="$({
  PATH="$audit_bin:$PATH" \
    SOURCE_SHA="$audit_new_sha" EXPECTED_OLD_V1_SHA="$audit_old_sha" \
    AUDIT_MAIN_SHA="$audit_new_sha" AUDIT_V1_SHA="$audit_observed_sha" \
    AUDIT_SOURCE_SHA="$audit_new_sha" AUDIT_EXPECTED_OLD_SHA="$audit_old_sha" \
    FAKE_LOG="$audit_stale_log" \
    "$repo_root/scripts/audit-v1-promotion.sh"
} 2>&1)"; then
  echo "expected stale old-ref audit to refuse promotion" >&2
  exit 1
fi
grep -Fxq "observed_old_sha=$audit_observed_sha" <<<"$audit_stale_output"
grep -Fxq "expected_old_sha=$audit_old_sha" <<<"$audit_stale_output"
grep -Fxq 'relation=stale-old-ref' <<<"$audit_stale_output"
grep -Fxq 'write_performed=false' <<<"$audit_stale_output"

# Malformed exact-SHA inputs and missing local refs fail before eligibility is
# evaluated. These guards keep the audit from accepting ambiguous coordinates.
invalid_sha_log="$tmp_dir/audit-invalid-sha.log"
if invalid_sha_output="$({
  PATH="$audit_bin:$PATH" \
    SOURCE_SHA=not-an-exact-sha EXPECTED_OLD_V1_SHA="$audit_old_sha" \
    FAKE_LOG="$invalid_sha_log" \
    "$repo_root/scripts/audit-v1-promotion.sh"
} 2>&1)"; then
  echo "expected malformed candidate SHA to fail the audit" >&2
  exit 1
fi
grep -Fq 'SOURCE_SHA must be an exact lowercase 40-character commit SHA' <<<"$invalid_sha_output"
[[ ! -s "$invalid_sha_log" ]]

missing_ref_log="$tmp_dir/audit-missing-ref.log"
if missing_ref_output="$({
  PATH="$audit_bin:$PATH" \
    SOURCE_SHA="$audit_new_sha" EXPECTED_OLD_V1_SHA="$audit_old_sha" \
    AUDIT_MAIN_SHA="$audit_new_sha" AUDIT_V1_SHA="$audit_old_sha" \
    AUDIT_SOURCE_SHA="$audit_new_sha" AUDIT_EXPECTED_OLD_SHA="$audit_old_sha" \
    AUDIT_MAIN_MISSING=true FAKE_LOG="$missing_ref_log" \
    "$repo_root/scripts/audit-v1-promotion.sh"
} 2>&1)"; then
  echo "expected missing local main ref to fail the audit" >&2
  exit 1
fi
grep -Fq 'Cannot resolve refs/remotes/origin/main to a commit from the local ref snapshot' <<<"$missing_ref_output"

# The hosted entry point must pass the audited old ref and retain the immutable
# receipt. The promoter independently rejects a wrong resolver result.
# shellcheck disable=SC2016
grep -Fq 'EXPECTED_OLD_V1_SHA: ${{ steps.expected-v1.outputs.sha }}' "$repo_root/.github/workflows/promote-v1.yml"
# shellcheck disable=SC2016
grep -Fq 'PROMOTION_RECEIPT_PATH: ${{ runner.temp }}/review-yeti-v1-promotion-receipt.json' "$repo_root/.github/workflows/promote-v1.yml"
grep -Fq 'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6.0.0' "$repo_root/.github/workflows/promote-v1.yml"
grep -Fq 'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6.0.0' "$repo_root/.github/workflows/review-yeti.yml"
grep -Fq 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0' "$repo_root/.github/workflows/review-yeti.yml"
grep -Fq 'node-version: 24' "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq "if: always() && steps.review.outputs.provider-telemetry-path != ''" "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq 'name: review-yeti-provider-telemetry-${{ github.run_id }}-${{ github.run_attempt }}' "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq 'path: ${{ steps.review.outputs.provider-telemetry-path }}' "$repo_root/.github/workflows/review-yeti.yml"
grep -Fq 'actions: read' "$repo_root/.github/workflows/self-review.yml"
grep -Fq 'actions: read' "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq 'incremental-review: ${{ steps.policy.outputs.incremental_enabled }}' "$repo_root/.github/workflows/review-yeti.yml"
if [[ -e "$repo_root/.github/workflows/self-review-recovery.yml" ]]; then
  echo "temporary self-review recovery workflow must be removed before activation" >&2
  exit 1
fi
workflow_identity_step="$({
  sed -n \
    '/^      - name: Resolve immutable reusable workflow identity$/,/^      - name: Run Review Yeti review panel$/p' \
    "$repo_root/.github/workflows/review-yeti.yml"
} | sed '$d')"
grep -Fq 'id: workflow_identity' <<<"$workflow_identity_step"
grep -Fq 'WORKFLOW_REF: ${{ job.workflow_ref }}' <<<"$workflow_identity_step"
grep -Fq 'WORKFLOW_SHA: ${{ job.workflow_sha }}' <<<"$workflow_identity_step"
grep -Fq 'run: .exampleorg-review-actions/scripts/emit-workflow-identity.sh' <<<"$workflow_identity_step"
grep -Fq 'incremental-trusted-workflow: ${{ steps.workflow_identity.outputs.workflow_ref }}' "$repo_root/.github/workflows/review-yeti.yml"
grep -Fq 'incremental-trusted-workflow-sha: ${{ steps.workflow_identity.outputs.workflow_sha }}' "$repo_root/.github/workflows/review-yeti.yml"
# REL-554: central-execution runs (repository_dispatch inside this repository) must bind
# incremental reuse to this repository's own artifacts and trust the repository_dispatch
# parent event in addition to the consumer's original pull_request(_target) event.
grep -Fq 'incremental-artifact-repo: ${{ github.repository }}' "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq "incremental-trusted-events: \${{ inputs.central_execution && 'pull_request,pull_request_target,repository_dispatch' || 'pull_request,pull_request_target' }}" "$repo_root/.github/workflows/review-yeti.yml"
grep -Fq 'max-incremental-diff-chars: ${{ steps.policy.outputs.max_incremental_diff_chars }}' "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq 'max-incremental-chain: ${{ steps.policy.outputs.max_incremental_chain }}' "$repo_root/.github/workflows/review-yeti.yml"
grep -Fq 'max-review-assignments: ${{ steps.policy.outputs.max_review_assignments }}' "$repo_root/.github/workflows/review-yeti.yml"
grep -Fq 'if-no-files-found: error' "$repo_root/.github/workflows/promote-v1.yml"

# The check-run publication logic is an extracted, independently invocable script (not an
# inline YAML `run:` block) precisely so it can be behaviorally proven here instead of only
# grepped. review-yeti.yml must delegate to it, forward the platform-owned backend, and keep
# the asynchronous DOKS worker as the sole raw target-check publisher.
grep -Fq 'run: .exampleorg-review-actions/scripts/publish-review-check-run.sh' "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq 'REVIEW_YETI_PASSTHROUGH: ${{ steps.policy.outputs.passthrough }}' "$repo_root/.github/workflows/review-yeti.yml"
grep -Fq "TRUSTED_EXECUTION_BACKEND: \${{ inputs.execution_backend || vars.REVIEW_YETI_EXECUTION_BACKEND || 'local' }}" "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq 'REVIEW_YETI_RESOLVED_BACKEND: ${{ env.TRUSTED_EXECUTION_BACKEND }}' "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq "if: inputs.central_execution && steps.ry_token.outputs.token != '' && env.TRUSTED_EXECUTION_BACKEND != 'doks'" "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq "check-id: \${{ env.TRUSTED_EXECUTION_BACKEND != 'doks' && steps.init_check.outputs.check_id || '' }}" "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq 'execution-backend: ${{ env.TRUSTED_EXECUTION_BACKEND }}' "$repo_root/.github/workflows/review-yeti.yml"
# shellcheck disable=SC2016
grep -Fq 'REVIEW_YETI_EXECUTION_BACKEND: ${{ env.TRUSTED_EXECUTION_BACKEND }}' "$repo_root/.github/workflows/review-yeti.yml"
if [[ "$(grep -Fc 'inputs.execution_backend ||' "$repo_root/.github/workflows/review-yeti.yml")" != 1 ]]; then
  echo "backend selection must be resolved once while preserving existing qualified central inputs" >&2
  exit 1
fi
if grep -Fq 'Publishing Check Run' "$repo_root/.github/workflows/review-yeti.yml"; then
  echo "check-run publication logic must live in publish-review-check-run.sh, not inline in review-yeti.yml" >&2
  exit 1
fi

# Passthrough publishes required App checks even on DOKS (the worker is not
# dispatched). Non-passthrough DOKS still records a receipt and does not write.
python3 - "$repo_root/scripts/publish-review-check-run.sh" <<'PY_PUBLISH_CONTRACT_EOF'
import sys
script = open(sys.argv[1]).read()
passthrough_start = script.index('if [[ "${REVIEW_YETI_PASSTHROUGH:-}" == "true" ]]')
doks_start = script.index('if [[ "${REVIEW_YETI_EXECUTION_BACKEND}" == "doks" ]]')
assert passthrough_start < doks_start, 'passthrough must publish before the DOKS skip'
doks_block = script[doks_start:script.index('conclusion="success"')]
assert 'Central Checks API writes: 0' in doks_block, 'DOKS receipt must state zero central check writes'
assert 'worker is the only raw' in doks_block, 'DOKS receipt must name the worker as sole publisher'
assert 'PATCH' not in doks_block, 'DOKS path must not claim PATCH reuse'
assert 'exit 0' in doks_block, 'DOKS path must not fall through to hosted publication'
assert 'Worker will complete check-run via PATCH' not in script, 'publisher must not claim PATCH reuse for DOKS'
hosted_block = script[script.index('conclusion="success"'):]
assert 'if [[ -n "${CHECK_ID:-}" ]]' in hosted_block, 'hosted CHECK_ID PATCH path must remain'
assert 'conclusion="failure"' in hosted_block, 'hosted non-SHIP publication must remain fail-closed'
print('  passthrough-before-doks and hosted publication contract ok')
PY_PUBLISH_CONTRACT_EOF

# Behavioral proof: invoke the real script (not a grep of its text) with a fake curl that
# captures the actual JSON payload, for both a passthrough verdict and a normal SHIP verdict.
publish_test_dir="$tmp_dir/publish-check-run"
mkdir -p "$publish_test_dir/bin"
cat >"$publish_test_dir/bin/curl" <<'FAKE_PUBLISH_CURL'
#!/usr/bin/env bash
for ((i=1; i<=$#; i++)); do
  if [[ "${!i}" == "-d" ]]; then
    j=$((i+1))
    echo "${!j}" > "${FAKE_CURL_PAYLOAD:?}"
  fi
done
FAKE_PUBLISH_CURL
chmod +x "$publish_test_dir/bin/curl"

passthrough_payload="$publish_test_dir/passthrough.json"
PATH="$publish_test_dir/bin:$PATH" FAKE_CURL_PAYLOAD="$passthrough_payload" \
  GH_TOKEN=test TARGET_REPO=exampleorg/example HEAD_SHA=deadbeef \
  REVIEW_STATUS=SHIP REVIEW_YETI_PASSTHROUGH=true CENTRAL_RUN_URL=https://example/run/1 \
  "$repo_root/scripts/publish-review-check-run.sh" >/dev/null
jq -e '.conclusion == "success" and (.output.title | test("PASSTHROUGH"))' "$passthrough_payload" >/dev/null

normal_ship_payload="$publish_test_dir/normal-ship.json"
PATH="$publish_test_dir/bin:$PATH" FAKE_CURL_PAYLOAD="$normal_ship_payload" \
  GH_TOKEN=test TARGET_REPO=exampleorg/example HEAD_SHA=deadbeef \
  REVIEW_STATUS=SHIP CENTRAL_RUN_URL=https://example/run/1 \
  "$repo_root/scripts/publish-review-check-run.sh" >/dev/null
jq -e '.conclusion == "success"' "$normal_ship_payload" >/dev/null

# An absent verdict must never render as SHIP. The publisher used to interpolate
# ${REVIEW_STATUS:-SHIP}, so a run whose panel never produced a verdict published
# a check titled "Review Yeti: SHIP" whose summary claimed the evaluation had
# "finished with verdict: SHIP" (observed on example-workspace#2554, moments after
# check-review-verdict.sh errored with "did not produce a verdict"). The
# conclusion was correctly `failure`, so this asserts BOTH: still failing, and no
# longer claiming an approval that no persona gave.
no_verdict_payload="$publish_test_dir/no-verdict.json"
PATH="$publish_test_dir/bin:$PATH" FAKE_CURL_PAYLOAD="$no_verdict_payload" \
  GH_TOKEN=test TARGET_REPO=exampleorg/example HEAD_SHA=deadbeef \
  REVIEW_STATUS= CENTRAL_RUN_URL=https://example/run/1 \
  "$repo_root/scripts/publish-review-check-run.sh" >/dev/null
jq -e '.conclusion == "failure"' "$no_verdict_payload" >/dev/null
jq -e '(.output.title | test("SHIP") | not)' "$no_verdict_payload" >/dev/null
jq -e '(.output.summary | test("verdict: SHIP") | not)' "$no_verdict_payload" >/dev/null
jq -e '(.output.title | test("NO VERDICT"))' "$no_verdict_payload" >/dev/null

# A real non-SHIP verdict still fails and is still named accurately.
block_payload="$publish_test_dir/block.json"
PATH="$publish_test_dir/bin:$PATH" FAKE_CURL_PAYLOAD="$block_payload" \
  GH_TOKEN=test TARGET_REPO=exampleorg/example HEAD_SHA=deadbeef \
  REVIEW_STATUS=BLOCK CENTRAL_RUN_URL=https://example/run/1 \
  "$repo_root/scripts/publish-review-check-run.sh" >/dev/null
jq -e '.conclusion == "failure" and (.output.title | test("BLOCK"))' "$block_payload" >/dev/null

# The literal default that caused it must not come back.
if grep -Fq 'REVIEW_STATUS:-SHIP' "$repo_root/scripts/publish-review-check-run.sh"; then
  echo "publish-review-check-run.sh must not default an absent verdict to SHIP" >&2
  exit 1
fi

# Consumer callers must not be able to self-serve a passthrough approval or reroute execution.
# Only the platform-owned REVIEW_YETI_PASSTHROUGH repository variable may enable passthrough.
grep -Fq "'^[[:space:]]+passthrough:'" "$repo_root/scripts/validate-caller-workflow.sh"
grep -Fq "'^[[:space:]]+execution_backend:'" "$repo_root/scripts/validate-caller-workflow.sh"
grep -Fq 'must not set passthrough; only the platform-owned repository variable may enable it.' "$repo_root/scripts/validate-caller-workflow.sh"
grep -Fq 'must not override execution_backend; the central policy is the only authority for backend selection.' "$repo_root/scripts/validate-caller-workflow.sh"

# Behavioral proof: run the real validator against a crafted caller that smuggles
# `with: passthrough: true`, and against the real compliant central self-review caller.
caller_test_dir="$tmp_dir/validate-caller"
mkdir -p "$caller_test_dir/bin"
malicious_caller_b64="$(base64 <<'MALICIOUS_CALLER_FIXTURE' | tr -d '\n'
name: Review Yeti
on:
  pull_request_target:
    branches: [main]
jobs:
  review:
    uses: exampleorg/example-review-actions/.github/workflows/review-yeti.yml@v1
    with:
      passthrough: true
    secrets: inherit
MALICIOUS_CALLER_FIXTURE
)"
compliant_caller_b64="$(base64 <"$repo_root/.github/workflows/self-review.yml" | tr -d '\n')"

cat >"$caller_test_dir/bin/gh" <<FAKE_CALLER_GH
#!/usr/bin/env bash
set -euo pipefail
request="\$*"
case "\$request" in
  *"repos/exampleorg/example/contents/.github/workflows/ct-review-bot.yml"*)
    printf '{"content":"%s"}\\n' "$malicious_caller_b64"
    ;;
  *"repos/exampleorg/example-review-actions/contents/.github/workflows/self-review.yml"*)
    printf '{"content":"%s"}\\n' "$compliant_caller_b64"
    ;;
  *)
    echo "unexpected fake gh call: \$request" >&2
    exit 1
    ;;
esac
FAKE_CALLER_GH
chmod +x "$caller_test_dir/bin/gh"

if malicious_caller_output="$({
  PATH="$caller_test_dir/bin:$PATH" GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example \
    EXPECTED_BASE_SHA=1111111111111111111111111111111111111111 \
    "$repo_root/scripts/validate-caller-workflow.sh"
} 2>&1)"; then
  echo "expected a caller smuggling passthrough: true to be rejected" >&2
  exit 1
fi
grep -Fq 'must not set passthrough' <<<"$malicious_caller_output"

PATH="$caller_test_dir/bin:$PATH" GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example-review-actions \
  EXPECTED_BASE_SHA=1111111111111111111111111111111111111111 CENTRAL_REF=main \
  "$repo_root/scripts/validate-caller-workflow.sh" >/dev/null

echo "promote-v1 behavioral contract passed"
