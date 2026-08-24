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
  *"repos/exampleorg/example-review-actions/commits/source123/pulls?per_page=100"*)
    printf '[[{"number":42,"base":{"ref":"main"},"head":{"sha":"head123"},"merge_commit_sha":"source123","merged_at":"2026-08-19T15:00:00Z"}]]\n'
    ;;
  *"repos/exampleorg/example-review-actions/commits/source123/check-runs?per_page=100"*)
    printf '{"check_runs":[{"name":"validate","status":"completed","conclusion":"success","completed_at":"2026-08-19T15:01:00Z"}]}\n'
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
      printf '{"check_runs":[{"id":1,"name":"review / Review Yeti","status":"completed","conclusion":"success","completed_at":"2026-08-19T15:02:00Z"}]}\n'
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
    if [[ "${FAKE_TAG_ONLY:-}" == true ]]; then exit 2; fi
    printf '%s\trefs/heads/v1\n' "${FAKE_V1_SHA:-old123}"
    ;;
  *"refs/tags/v1 "*)
    if [[ "${FAKE_TAG_ONLY:-}" == true ]]; then printf 'old123\trefs/tags/v1\n'; else exit 2; fi
    ;;
  *" rev-parse refs/remotes/origin/main "*) printf '%s\n' "${FAKE_MAIN_SHA:-source123}" ;;
  *" rev-parse refs/remotes/origin/v1 "*) printf '%s\n' "${FAKE_V1_SHA:-old123}" ;;
  *" rev-parse refs/tags/v1-legacy^{} "*) printf 'old123\n' ;;
  *" merge-base "*)
    if [[ "${FAKE_DIVERGED:-}" == true ]]; then exit 1; fi
    exit 0
    ;;
  *) echo "unexpected fake git call: $*" >&2; exit 1 ;;
esac
FAKE_GIT
chmod +x "$tmp_dir/bin/git"

fast_forward_log="$tmp_dir/fast-forward.log"
PATH="$tmp_dir/bin:$PATH" \
  GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
  FAKE_LOG="$fast_forward_log" \
  GITHUB_STEP_SUMMARY="$tmp_dir/summary" \
  "$repo_root/scripts/promote-v1.sh"

grep -Fq 'Originating PR: #42' "$tmp_dir/summary"
grep -Fxq 'merge-base --is-ancestor old123 source123' "$fast_forward_log"
grep -Fxq 'push origin source123:refs/heads/v1' "$fast_forward_log"
if grep -Eq 'push .*HEAD|push .*codex/' "$fast_forward_log"; then
  echo "promotion must use the exact candidate SHA, not the ambient checkout" >&2
  exit 1
fi

# A divergent active channel must fail before any ref update.
divergence_log="$tmp_dir/divergence.log"
if divergence_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_DIVERGED=true FAKE_LOG="$divergence_log" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected divergent v1 promotion to fail" >&2
  exit 1
fi
grep -Fq 'Refusing non-fast-forward v1 promotion from old123 to source123' <<<"$divergence_output"
if grep -Fq 'push ' "$divergence_log"; then
  echo "divergent promotion attempted a ref update" >&2
  exit 1
fi

# An already-promoted candidate is an idempotent success and performs no write.
idempotent_log="$tmp_dir/idempotent.log"
idempotent_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_V1_SHA=source123 FAKE_LOG="$idempotent_log" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"
grep -Fq 'Review Yeti v1 already points to source123' <<<"$idempotent_output"
if grep -Fq 'push ' "$idempotent_log"; then
  echo "idempotent promotion attempted a ref update" >&2
  exit 1
fi

# A rejected branch update must not print a success receipt or attempt another
# ref update. This is the non-partial branch-only failure case.
failed_branch_log="$tmp_dir/failed-branch.log"
if failed_branch_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
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

# Characterize the incomplete legacy migration that Rank 1B must repair. The
# current implementation updates the branch and then deletes the tag in a
# second push. If that deletion fails, the script exits non-zero but has already
# emitted a success line and may have partially changed the active channel.
partial_update_log="$tmp_dir/partial-update.log"
if partial_update_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
    FAKE_TAG_ONLY=true FAKE_TAG_DELETE_FAIL=true FAKE_LOG="$partial_update_log" \
    "$repo_root/scripts/promote-v1.sh"
} 2>&1)"; then
  echo "expected failed legacy tag deletion to fail the promotion" >&2
  exit 1
fi
grep -Fq 'Promoted Review Yeti v1' <<<"$partial_update_output"
grep -Fq 'simulated legacy tag deletion failure' <<<"$partial_update_output"
grep -Fxq 'push origin source123:refs/heads/v1' "$partial_update_log"
grep -Fxq 'push origin :refs/tags/v1' "$partial_update_log"

pending_marker="$tmp_dir/pending-marker"
pending_output="$({
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
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
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
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
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
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
    GH_TOKEN=test SOURCE_SHA=source123 GITHUB_REPOSITORY=exampleorg/example-review-actions \
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

echo "promote-v1 behavioral contract passed"
