#!/usr/bin/env bash
set -euo pipefail

# Contract test proving the exact-head race behavior of check-review-verdict.sh:
#   - a head-changed PR must self-cancel this run rather than paint a plain failure on an
#     already-superseded SHA (example-api #4396: failures at 16:04/16:06, SHIP at 16:08 on the
#     newer head).
#   - every OTHER failure path (base SHA, verdict fields) is untouched and still a plain exit 1
#     -- only the head-changed branch may cancel.
#   - no path ever exits 0 for a stale SHA, and a SHIP/PASS verdict is never accepted for a head
#     that no longer matches the PR.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'find "$tmp_dir" -type f -delete; find "$tmp_dir" -depth -type d -empty -delete' EXIT

mkdir -p "$tmp_dir/bin"
cat >"$tmp_dir/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$1" == "run" ]]; then
  sub="$2"
  case "$sub" in
    cancel)
      run_id="$3"
      echo "cancel $run_id" >>"$CALL_LOG"
      exit 0
      ;;
    view)
      run_id="$3"
      echo "view $run_id" >>"$CALL_LOG"
      printf '%s' "$RUN_VIEW_JSON"
      exit 0
      ;;
    *)
      echo "unexpected fake gh run call: $*" >&2
      exit 1
      ;;
  esac
fi

shift # drop "api"
endpoint="$1"
case "$endpoint" in
  repos/exampleorg/example/pulls/7)
    printf '%s\n' "$PR_METADATA_JSON"
    ;;
  *)
    echo "unexpected fake gh api call: $endpoint" >&2
    exit 1
    ;;
esac
FAKE_GH
chmod +x "$tmp_dir/bin/gh"

base_sha="deadbeefcafef00ddeadbeefcafef00ddeadbeef"
head_sha="0123456789012345678901234567890123456789"
newer_head_sha="abcdefabcdefabcdefabcdefabcdefabcdefabcd"
digest="$(printf '0123456789abcdef%.0s' {1..4})"

zero_p2_report="$tmp_dir/zero-p2.json"
nonzero_p2_report="$tmp_dir/nonzero-p2.json"
string_pr_report="$tmp_dir/string-pr.json"
base_mismatch_report="$tmp_dir/base-mismatch.json"
verdict_mismatch_report="$tmp_dir/verdict-mismatch.json"
inconsistent_p2_report="$tmp_dir/inconsistent-p2.json"

cat >"$zero_p2_report" <<EOF
{
  "schemaVersion": "review-run-report-v1",
  "repository": "exampleorg/example",
  "prNumber": 7,
  "baseSha": "$base_sha",
  "headSha": "$head_sha",
  "verdict": "SHIP",
  "lanes": [{
    "decision": "APPROVE",
    "severity": {"P0": 0, "P1": 0, "P2": 0},
    "findings": []
  }]
}
EOF

jq '.prNumber = "7"' "$zero_p2_report" >"$string_pr_report"
jq '.baseSha = "ffffffffffffffffffffffffffffffffffffffff"' "$zero_p2_report" >"$base_mismatch_report"
jq '.verdict = "FIX_FIRST"' "$zero_p2_report" >"$verdict_mismatch_report"

cat >"$nonzero_p2_report" <<EOF
{
  "schemaVersion": "review-run-report-v1",
  "repository": "exampleorg/example",
  "prNumber": 7,
  "baseSha": "$base_sha",
  "headSha": "$head_sha",
  "verdict": "SHIP",
  "lanes": [{
    "decision": "FINDINGS",
    "severity": {"P0": 0, "P1": 0, "P2": 1},
    "findings": [{"severity": "P2", "file": "lib/example.ex", "title": "Advisory"}]
  }]
}
EOF

jq '.lanes[0].severity.P2 = 0' "$nonzero_p2_report" >"$inconsistent_p2_report"

# REL-550: a lane whose evidence was reused from a prior run (incremental "trusted repair
# delta" mode, evidenceSource == "parent") must never carry unresolved P0/P1 findings forward
# under a SHIP verdict -- SHIP means this exact head is clear, and a reused lane cannot attest
# to a diff it never examined.
reused_p1_ship_report="$tmp_dir/reused-p1-ship.json"
cat >"$reused_p1_ship_report" <<EOF
{
  "schemaVersion": "review-run-report-v1",
  "repository": "exampleorg/example",
  "prNumber": 7,
  "baseSha": "$base_sha",
  "headSha": "$head_sha",
  "verdict": "SHIP",
  "lanes": [{
    "decision": "FINDINGS",
    "severity": {"P0": 0, "P1": 1, "P2": 0},
    "findings": [{"severity": "P1", "file": "lib/example.ex", "title": "Reused blocking"}],
    "evidenceSource": "parent"
  }]
}
EOF

# The same reused-lane shape, but P2-only: still advisory, must not block a SHIP verdict.
reused_p2_only_ship_report="$tmp_dir/reused-p2-only-ship.json"
cat >"$reused_p2_only_ship_report" <<EOF
{
  "schemaVersion": "review-run-report-v1",
  "repository": "exampleorg/example",
  "prNumber": 7,
  "baseSha": "$base_sha",
  "headSha": "$head_sha",
  "verdict": "SHIP",
  "lanes": [{
    "decision": "FINDINGS",
    "severity": {"P0": 0, "P1": 0, "P2": 1},
    "findings": [{"severity": "P2", "file": "lib/example.ex", "title": "Reused advisory"}],
    "evidenceSource": "parent"
  }]
}
EOF

# A live (non-reused) lane with a P1 finding under a FIX_FIRST verdict: unaffected by the new
# reused-lane rule, which only ever fires under a SHIP verdict.
live_p1_fix_first_report="$tmp_dir/live-p1-fix-first.json"
cat >"$live_p1_fix_first_report" <<EOF
{
  "schemaVersion": "review-run-report-v1",
  "repository": "exampleorg/example",
  "prNumber": 7,
  "baseSha": "$base_sha",
  "headSha": "$head_sha",
  "verdict": "FIX_FIRST",
  "lanes": [{
    "decision": "FINDINGS",
    "severity": {"P0": 0, "P1": 1, "P2": 0},
    "findings": [{"severity": "P1", "file": "lib/example.ex", "title": "Live blocking"}]
  }]
}
EOF

# scope.chainDepth is an optional nonnegative-integer field surfaced by the incremental
# "trusted repair delta" mode; a valid depth must never fail a report that is otherwise clean.
chain_depth_valid_report="$tmp_dir/chain-depth-valid.json"
jq '.scope.chainDepth = 2' "$zero_p2_report" >"$chain_depth_valid_report"

# A malformed (non-numeric) chainDepth must fail closed rather than being silently ignored.
chain_depth_invalid_report="$tmp_dir/chain-depth-invalid.json"
jq '.scope.chainDepth = "x"' "$zero_p2_report" >"$chain_depth_invalid_report"

# example-api #4386 shape: "no reviewable files remained after 1 expected policy
# exclusion(s)" -- SHIP verdict, zero lanes, no digest, no reflection status.
zero_lane_report="$tmp_dir/zero-lane.json"
cat >"$zero_lane_report" <<EOF
{
  "schemaVersion": "review-run-report-v1",
  "repository": "exampleorg/example",
  "prNumber": 7,
  "baseSha": "$base_sha",
  "headSha": "$head_sha",
  "verdict": "SHIP",
  "lanes": []
}
EOF

pr_json() {
  printf '{"base":{"sha":"%s"},"head":{"sha":"%s"}}' "$1" "$2"
}

run_script() {
  local pr_json="$1" run_view_json="${2-}" report_path="${3:-$zero_p2_report}"
  if [[ -z "$run_view_json" ]]; then
    run_view_json='{"status":"in_progress","conclusion":null}'
  fi
  local -A extra=(
    [REVIEW_STATUS]="${REVIEW_STATUS:-SHIP}"
    [GATE_DECISION]="${GATE_DECISION:-PASS}"
    [MERGE_ELIGIBLE]="${MERGE_ELIGIBLE:-true}"
    [FILES_OMITTED]="${FILES_OMITTED:-0}"
    [DISPATCH_REFLECTION_STATUS]="${DISPATCH_REFLECTION_STATUS-complete}"
    [PROVIDER_RECEIPT_DIGEST]="${PROVIDER_RECEIPT_DIGEST-$digest}"
  )
  local call_log
  call_log="$(mktemp)"
  set +e
  output="$(
    PATH="$tmp_dir/bin:$PATH" \
      GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example REVIEW_PR_NUMBER=7 \
      EXPECTED_BASE_SHA="$base_sha" EXPECTED_HEAD_SHA="$head_sha" \
      GITHUB_RUN_ID=999 \
      SELF_CANCEL_WAIT_ATTEMPTS=1 SELF_CANCEL_WAIT_INTERVAL=0 \
      REVIEW_STATUS="${extra[REVIEW_STATUS]}" GATE_DECISION="${extra[GATE_DECISION]}" \
      MERGE_ELIGIBLE="${extra[MERGE_ELIGIBLE]}" FILES_OMITTED="${extra[FILES_OMITTED]}" \
      DISPATCH_REFLECTION_STATUS="${extra[DISPATCH_REFLECTION_STATUS]}" \
      PROVIDER_RECEIPT_DIGEST="${extra[PROVIDER_RECEIPT_DIGEST]}" \
      RUN_REPORT_PATH="$report_path" \
      PR_METADATA_JSON="$pr_json" RUN_VIEW_JSON="$run_view_json" CALL_LOG="$call_log" \
      "$repo_root/scripts/check-review-verdict.sh" 2>&1
  )"
  rc=$?
  set -e
  cancel_called=0
  [[ -f "$call_log" ]] && grep -q '^cancel 999$' "$call_log" && cancel_called=1
  rm -f "$call_log"
}

unset REVIEW_STATUS GATE_DECISION MERGE_ELIGIBLE FILES_OMITTED DISPATCH_REFLECTION_STATUS PROVIDER_RECEIPT_DIGEST

# 0. A failure before the review action runs leaves every action output empty. The final
#    always() gate must explain that upstream failure cleanly instead of crashing on bash's
#    parameter-expansion guard and obscuring the actual failed setup step.
set +e
output="$(
  PATH="$tmp_dir/bin:$PATH" \
    GH_TOKEN=test REVIEW_REPOSITORY=exampleorg/example REVIEW_PR_NUMBER=7 \
    EXPECTED_BASE_SHA="$base_sha" EXPECTED_HEAD_SHA="$head_sha" \
    REVIEW_STATUS='' GATE_DECISION='' MERGE_ELIGIBLE='' FILES_OMITTED='' \
    DISPATCH_REFLECTION_STATUS='' PROVIDER_RECEIPT_DIGEST='' RUN_REPORT_PATH='' \
    PR_METADATA_JSON="$(pr_json "$base_sha" "$head_sha")" RUN_VIEW_JSON='' CALL_LOG=/dev/null \
    "$repo_root/scripts/check-review-verdict.sh" 2>&1
)"
rc=$?
set -e
if [[ "$rc" -eq 0 ]]; then
  echo "[missing-review-outputs] expected fail-closed non-zero exit" >&2
  exit 1
fi
if grep -Fq "REVIEW_STATUS is required" <<<"$output"; then
  echo "[missing-review-outputs] raw parameter-expansion error obscured the upstream failure" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "::error::Review Yeti did not produce a verdict; an earlier workflow step failed" <<<"$output" || {
  echo "[missing-review-outputs] expected the clean missing-verdict error" >&2
  echo "$output" >&2
  exit 1
}
echo "[missing-review-outputs] passed (clean upstream-failure message)"

# 0b. DOKS asynchronous dispatch: review action enqueues the job and exits with DISPATCHED/PENDING.
#     Verdict enforcement is reported asynchronously by the GitHub App gate.
REVIEW_STATUS=DISPATCHED GATE_DECISION=PENDING run_script "$(pr_json "$base_sha" "$head_sha")"
if [[ "$rc" -ne 0 ]]; then
  echo "[doks-dispatched] expected zero exit on successful asynchronous DOKS dispatch, got $rc" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "dispatched asynchronously to DOKS queue" <<<"$output" || {
  echo "[doks-dispatched] expected DOKS dispatch notice" >&2
  echo "$output" >&2
  exit 1
}
echo "[doks-dispatched] passed (asynchronous dispatch accepted cleanly)"

# 1. Head changed while the run was in flight, verdict otherwise a clean SHIP/PASS: must
#    self-cancel rather than mint (or fail-loudly-paint) a verdict for a SHA that no longer
#    matches the PR, and must never exit 0.
run_script "$(pr_json "$base_sha" "$newer_head_sha")" '{"status":"completed","conclusion":"cancelled"}'
if [[ "$rc" -eq 0 ]]; then
  echo "[head-changed] expected non-zero exit, got 0 -- a SHIP verdict must never be accepted for a stale head" >&2
  echo "$output" >&2
  exit 1
fi
if [[ "$cancel_called" -ne 1 ]]; then
  echo "[head-changed] expected gh run cancel 999 to be invoked" >&2
  echo "$output" >&2
  exit 1
fi
if grep -Fq "::error::Review became stale because the PR head changed" <<<"$output"; then
  echo "[head-changed] expected the self-cancel path, not the old plain failure message" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "Self-cancelling" <<<"$output" || { echo "[head-changed] expected a self-cancel notice" >&2; echo "$output" >&2; exit 1; }
echo "[head-changed] passed (cancelled, exit $rc, no plain-failure wording)"

# 1b. Cancellation never confirmed: still exit non-zero (fail-closed backstop).
run_script "$(pr_json "$base_sha" "$newer_head_sha")" in_progress
if [[ "$rc" -eq 0 ]]; then
  echo "[head-changed-unconfirmed] expected non-zero exit, got 0" >&2
  echo "$output" >&2
  exit 1
fi
echo "[head-changed-unconfirmed] passed (unconfirmed cancel, exit $rc)"

# 2. Base changed (head untouched): plain exit-1 failure path, no cancellation.
run_script "$(pr_json "ffffffffffffffffffffffffffffffffffffff" "$head_sha")"
if [[ "$rc" -eq 0 || "$cancel_called" -eq 1 ]]; then
  echo "[base-changed] expected plain exit 1 without cancellation" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "Review became stale because the PR base changed" <<<"$output" || { echo "[base-changed] expected the plain base-SHA failure message" >&2; exit 1; }
echo "[base-changed] passed (plain exit 1, no cancel)"

# 3. Verdict not SHIP (head/base match): plain exit-1 failure path, no cancellation. This is the
#    "single worst outcome available" guard: a bad verdict on the CORRECT head must never be
#    reinterpreted as cancel-worthy.
REVIEW_STATUS=FIX_FIRST run_script "$(pr_json "$base_sha" "$head_sha")"
if [[ "$rc" -eq 0 || "$cancel_called" -eq 1 ]]; then
  echo "[not-ship] expected plain exit 1 without cancellation" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "Review Yeti verdict is FIX_FIRST, not SHIP" <<<"$output" || { echo "[not-ship] expected the plain verdict failure message" >&2; exit 1; }
echo "[not-ship] passed (plain exit 1, no cancel)"

# 3b. An empty PROVIDER_RECEIPT_DIGEST (the real shape a self-review of a repo with all
#     transports down produces, once the earlier SHIP/PASS/eligible/omitted/reflection gates are
#     satisfied) must fail closed with a clean ::error:: BLOCK message, not crash on an unset
#     `:?`-guarded variable with a raw bash parameter-expansion error that hides the verdict.
PROVIDER_RECEIPT_DIGEST="" \
  run_script "$(pr_json "$base_sha" "$head_sha")"
if [[ "$rc" -eq 0 || "$cancel_called" -eq 1 ]]; then
  echo "[empty-digest] expected plain exit 1 without cancellation" >&2
  echo "$output" >&2
  exit 1
fi
if grep -Fq "PROVIDER_RECEIPT_DIGEST is required" <<<"$output"; then
  echo "[empty-digest] expected the clean ::error:: digest message, not a raw :?-crash" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "::error::Review Yeti provider receipt digest is missing or invalid" <<<"$output" || {
  echo "[empty-digest] expected the clean digest-missing error message" >&2
  echo "$output" >&2
  exit 1
}
echo "[empty-digest] passed (clean BLOCK, no crash)"

# 3c. example-api #4386 reproduction: a legitimate zero-lane SHIP verdict ("no
#     reviewable files remained after policy exclusion(s)") where upstream
#     never emitted DISPATCH_REFLECTION_STATUS or PROVIDER_RECEIPT_DIGEST.
#     Before the fix this crashed on the `:?`-guarded DISPATCH_REFLECTION_STATUS
#     with a raw bash parameter-expansion error, AFTER the verdict was already
#     published -- turning a passing SHIP into a red required check. The fix
#     must honor the published SHIP, not crash and not fail closed.
DISPATCH_REFLECTION_STATUS="" PROVIDER_RECEIPT_DIGEST="" \
  run_script "$(pr_json "$base_sha" "$head_sha")" '' "$zero_lane_report"
if [[ "$rc" -ne 0 ]]; then
  echo "[zero-lane-ship] expected the published SHIP to be honored with exit 0, got $rc" >&2
  echo "$output" >&2
  exit 1
fi
if grep -Fq "DISPATCH_REFLECTION_STATUS is required" <<<"$output"; then
  echo "[zero-lane-ship] expected no raw :?-crash on DISPATCH_REFLECTION_STATUS" >&2
  echo "$output" >&2
  exit 1
fi
# The gate must not fail-closed on a legitimate zero-lane SHIP (that would wedge every
# generated-file-only PR toward --admin), but it must ALSO not report this the same way as a
# real review: "accepted" wording is reserved for lane_count > 0. A zero-lane SHIP must be
# labeled NO_REVIEWABLE_CONTENT so a human reading the log can tell "nothing was reviewed" from
# "N personas approved".
if grep -Fq "accepted" <<<"$output"; then
  echo "[zero-lane-ship] expected the honest NO_REVIEWABLE_CONTENT message, not the real-review acceptance wording" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "NO_REVIEWABLE_CONTENT" <<<"$output" || {
  echo "[zero-lane-ship] expected the NO_REVIEWABLE_CONTENT message" >&2
  echo "$output" >&2
  exit 1
}
echo "[zero-lane-ship] passed (published SHIP honored as NO_REVIEWABLE_CONTENT, not fake review evidence, no crash)"

# 3c-2. Passthrough mode: a zero-lane SHIP must be REJECTED.
#       deliver-passthrough.sh emits NO_REVIEW, so a SHIP arriving here under
#       passthrough is a synthetic verdict from some other path. This test used
#       to assert exit 0 and a "Review Yeti: SHIP (Passthrough Mode)" heading --
#       a heading that asserted an approval its own body denied.
REVIEW_YETI_PASSTHROUGH="true" DISPATCH_REFLECTION_STATUS="" PROVIDER_RECEIPT_DIGEST="" \
  run_script "$(pr_json "$base_sha" "$head_sha")" '' "$zero_lane_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[passthrough-mode] a zero-lane SHIP under passthrough must not pass" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "NO_REVIEW" <<<"$output" || {
  echo "[passthrough-mode] expected the NO_REVIEW message in output" >&2
  echo "$output" >&2
  exit 1
}
if grep -Eq "Review Yeti: SHIP" <<<"$output"; then
  echo "[passthrough-mode] output must never announce SHIP for an unreviewed head" >&2
  echo "$output" >&2
  exit 1
fi
echo "[passthrough-mode] passed (zero-lane SHIP under passthrough is rejected, never announced as SHIP)"

# 3c-2b. Honest passthrough: SKIPPED is merge-eligible without claiming SHIP.
REVIEW_YETI_EXECUTION_BACKEND="local" REVIEW_YETI_PASSTHROUGH="true" REVIEW_STATUS="SKIPPED" GATE_DECISION="SKIPPED" MERGE_ELIGIBLE="true" \
  DISPATCH_REFLECTION_STATUS="" PROVIDER_RECEIPT_DIGEST="" \
  run_script "$(pr_json "$base_sha" "$head_sha")" '' "$zero_lane_report"
if [[ "$rc" -ne 0 ]]; then
  echo "[passthrough-skipped] expected exit 0 for SKIPPED passthrough" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "PASSTHROUGH accepted" <<<"$output" || {
  echo "[passthrough-skipped] expected PASSTHROUGH accepted" >&2
  echo "$output" >&2
  exit 1
}
grep -Fq "SKIPPED" <<<"$output" || {
  echo "[passthrough-skipped] expected SKIPPED wording" >&2
  echo "$output" >&2
  exit 1
}
if grep -Eq "Review Yeti: SHIP" <<<"$output"; then
  echo "[passthrough-skipped] must not announce SHIP" >&2
  echo "$output" >&2
  exit 1
fi
echo "[passthrough-skipped] passed (SKIPPED passthrough is merge-eligible, not SHIP)"

# 3c-2c. DOKS passthrough suppresses worker dispatch and publishes no check. The
# enforcement step itself completes cleanly, but must say that protected merge
# remains blocked rather than borrowing the legacy local skipped-check wording.
REVIEW_YETI_EXECUTION_BACKEND="doks" REVIEW_YETI_PASSTHROUGH="true" REVIEW_STATUS="SKIPPED" GATE_DECISION="SKIPPED" MERGE_ELIGIBLE="false" \
  DISPATCH_REFLECTION_STATUS="" PROVIDER_RECEIPT_DIGEST="" \
  run_script "$(pr_json "$base_sha" "$head_sha")" '' "$zero_lane_report"
if [[ "$rc" -ne 0 ]]; then
  echo "[doks-passthrough-skipped] expected the DOKS passthrough handler to complete cleanly, got $rc" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "No Review Yeti check is published" <<<"$output" || {
  echo "[doks-passthrough-skipped] expected explicit no-check wording" >&2
  echo "$output" >&2
  exit 1
}
grep -Fq "protected raw App check remains unsatisfied" <<<"$output" || {
  echo "[doks-passthrough-skipped] expected unsatisfied-protection wording" >&2
  echo "$output" >&2
  exit 1
}
grep -Fq "merge remains blocked" <<<"$output" || {
  echo "[doks-passthrough-skipped] expected blocked-merge wording" >&2
  echo "$output" >&2
  exit 1
}
if grep -Eq "Gate check is skipped|merge queue can continue|PASSTHROUGH accepted" <<<"$output"; then
  echo "[doks-passthrough-skipped] DOKS must not claim a skipped Gate or accepted merge" >&2
  echo "$output" >&2
  exit 1
fi
echo "[doks-passthrough-skipped] passed (no check published, protected merge remains blocked)"
unset REVIEW_YETI_EXECUTION_BACKEND REVIEW_YETI_PASSTHROUGH REVIEW_STATUS GATE_DECISION MERGE_ELIGIBLE

# 3c-3. Direct execution of deliver-passthrough.sh:
#       Ensures required coordinate enforcement, zero-lane SHIP report generation,
#       and correct GITHUB_OUTPUT entries.
passthrough_test_dir="$(mktemp -d)"
# Fails closed on missing coordinates:
if (
  TARGET_REPO="" PR_NUMBER="" HEAD_SHA="" BASE_SHA="" \
  bash "$repo_root/scripts/deliver-passthrough.sh"
) >/dev/null 2>&1; then
  echo "[deliver-passthrough-script] expected script to fail closed on missing coordinates" >&2
  exit 1
fi

(
  export TARGET_REPO="exampleorg/example-api"
  export PR_NUMBER=4854
  export HEAD_SHA="$head_sha"
  export BASE_SHA="$base_sha"
  export RUNNER_TEMP="$passthrough_test_dir"
  export GITHUB_OUTPUT="$passthrough_test_dir/gh_output"
  export GITHUB_STEP_SUMMARY="$passthrough_test_dir/summary"
  bash "$repo_root/scripts/deliver-passthrough.sh"
)
# Plan item 0.1: passthrough reviewed nothing, so it must not report an approval.
# These assertions previously required review-status=SHIP / gate-decision=PASS /
# merge-eligible=true -- the exact combination a pull request once merged on.
grep -Fxq "review-status=SKIPPED" "$passthrough_test_dir/gh_output" || { echo "[deliver-passthrough-script] missing review-status output" >&2; exit 1; }
grep -Fxq "gate-decision=SKIPPED" "$passthrough_test_dir/gh_output" || { echo "[deliver-passthrough-script] missing gate-decision output" >&2; exit 1; }
grep -Fxq "merge-eligible=true" "$passthrough_test_dir/gh_output" || { echo "[deliver-passthrough-script] missing merge-eligible output" >&2; exit 1; }
grep -Fq "review-status=SHIP" "$passthrough_test_dir/gh_output" && { echo "[deliver-passthrough-script] passthrough must never emit SHIP" >&2; exit 1; }
grep -Fxq "files-omitted=0" "$passthrough_test_dir/gh_output" || { echo "[deliver-passthrough-script] missing files-omitted output" >&2; exit 1; }
generated_report="$(grep '^run-report-path=' "$passthrough_test_dir/gh_output" | cut -d= -f2-)"
[[ -f "$generated_report" ]] || { echo "[deliver-passthrough-script] report file was not created" >&2; exit 1; }
jq -e '
  .schemaVersion == "review-run-report-v1" and
  .repository == "exampleorg/example-api" and
  .prNumber == 4854 and
  .baseSha == "'"$base_sha"'" and
  .headSha == "'"$head_sha"'" and
  .verdict == "SKIPPED" and
  .lanes == [] and
  .scope.mode == "passthrough"
' "$generated_report" >/dev/null || { echo "[deliver-passthrough-script] generated report failed schema validation" >&2; exit 1; }
rm -rf "$passthrough_test_dir"
echo "[deliver-passthrough-script] passed (direct execution, coordinate enforcement, and report schema validated)"

# 3d. A zero-lane run is not a blanket amnesty: if DISPATCH_REFLECTION_STATUS
#     is present but contradicts the zero-lane shape (anything other than
#     empty or "complete"), that is an inconsistent report and must still
#     block -- a missing verdict, or a self-contradictory one, is never
#     silently accepted as SHIP.
DISPATCH_REFLECTION_STATUS="pending" PROVIDER_RECEIPT_DIGEST="" \
  run_script "$(pr_json "$base_sha" "$head_sha")" '' "$zero_lane_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[zero-lane-inconsistent] expected a contradictory zero-lane reflection status to block" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "inconsistent" <<<"$output" || {
  echo "[zero-lane-inconsistent] expected the inconsistency failure message" >&2
  echo "$output" >&2
  exit 1
}
echo "[zero-lane-inconsistent] passed (contradictory zero-lane state blocked)"

# 3e. A genuinely missing/unparseable verdict (malformed run report) must
#     still fail closed as BLOCKED -- the fix must not turn a crash into a
#     fail-open for reports the checker cannot actually understand.
malformed_report="$tmp_dir/malformed.json"
printf 'not json' >"$malformed_report"
DISPATCH_REFLECTION_STATUS="" PROVIDER_RECEIPT_DIGEST="" \
  run_script "$(pr_json "$base_sha" "$head_sha")" '' "$malformed_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[malformed-report] expected an unparseable run report to fail closed" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "::error::Review Yeti run report failed closed" <<<"$output" || {
  echo "[malformed-report] expected the fail-closed run-report error message" >&2
  echo "$output" >&2
  exit 1
}
echo "[malformed-report] passed (unparseable report blocked, not fail-open)"

# 4. Everything matches and verdict is a clean SHIP/PASS: unaffected, exits 0.
run_script "$(pr_json "$base_sha" "$head_sha")"
if [[ "$rc" -ne 0 ]]; then
  echo "[exact-match] expected exit 0, got $rc" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "accepted" <<<"$output" || { echo "[exact-match] expected the acceptance message" >&2; exit 1; }
echo "[exact-match] passed"

# 5. A SHIP/PASS report with unresolved P2 advisories must PASS, warning rather than failing.
#    Inverted from "must block" -- an advisory that blocks is not an advisory, and the verdict
#    engine already escalates P2 volume via fixP2 on deduped clusters. Option A of the three in
#    example-meta docs/plans/2026-08-20-review-yeti-known-gaps.md. Observed contradiction this
#    replaces: example-api run 32369789786 reached `Verdict: SHIP` and still got a red check.
run_script "$(pr_json "$base_sha" "$head_sha")" '' "$nonzero_p2_report"
if [[ "$rc" -ne 0 ]]; then
  echo "[p2-advisory] expected P2 advisories to be non-blocking on a SHIP verdict" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "advisory only, not blocking" <<<"$output" || {
  echo "[p2-advisory] expected the advisory warning to be emitted" >&2
  echo "$output" >&2
  exit 1
}
echo "[p2-advisory] passed (advisory warns, does not block)"

# 6. Report identity fields must retain their schema types; a string PR number is invalid.
run_script "$(pr_json "$base_sha" "$head_sha")" '' "$string_pr_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[report-schema] expected string PR number to fail closed" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "run-report PR number does not match" <<<"$output" || {
  echo "[report-schema] expected the PR-number schema failure message" >&2
  echo "$output" >&2
  exit 1
}
echo "[report-schema] passed (string PR number rejected)"

# 7. The report's exact identity and summary counts are independently validated, even when
# the action-level environment says SHIP/PASS.
run_script "$(pr_json "$base_sha" "$head_sha")" '' "$base_mismatch_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[report-base] expected report base mismatch to fail closed" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "run-report base/head does not match" <<<"$output" || {
  echo "[report-base] expected exact identity failure message" >&2
  exit 1
}
echo "[report-base] passed (base mismatch rejected)"

run_script "$(pr_json "$base_sha" "$head_sha")" '' "$verdict_mismatch_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[report-verdict] expected report verdict mismatch to fail closed" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "run-report verdict does not match" <<<"$output" || {
  echo "[report-verdict] expected verdict identity failure message" >&2
  exit 1
}
echo "[report-verdict] passed (verdict mismatch rejected)"

run_script "$(pr_json "$base_sha" "$head_sha")" '' "$inconsistent_p2_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[report-p2-count] expected inconsistent P2 count to fail closed" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "run-report P2 count is inconsistent" <<<"$output" || {
  echo "[report-p2-count] expected P2 consistency failure message" >&2
  exit 1
}
echo "[report-p2-count] passed (summary mismatch rejected)"

# 8. REL-550: a reused lane (evidenceSource == "parent") carrying an unresolved P1 finding must
#    fail closed under a SHIP verdict -- a SHIP verdict must never be attested to by a lane that
#    was never actually re-reviewed on this exact head.
run_script "$(pr_json "$base_sha" "$head_sha")" '' "$reused_p1_ship_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[reused-lane-p1-ship] expected a reused blocking lane to fail closed under SHIP" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "run-report carries a reused lane with blocking findings under a SHIP verdict" <<<"$output" || {
  echo "[reused-lane-p1-ship] expected the reused-lane blocking-findings error message" >&2
  echo "$output" >&2
  exit 1
}
echo "[reused-lane-p1-ship] passed (reused blocking lane rejected under SHIP)"

# 9. The same reused-lane shape, but P2-only, remains advisory and must not block SHIP.
run_script "$(pr_json "$base_sha" "$head_sha")" '' "$reused_p2_only_ship_report"
if [[ "$rc" -ne 0 ]]; then
  echo "[reused-lane-p2-only-ship] expected a reused P2-only lane to pass under SHIP" >&2
  echo "$output" >&2
  exit 1
fi
echo "[reused-lane-p2-only-ship] passed (reused P2-only lane accepted under SHIP)"

# 10. A live (non-reused) lane with a P1 finding under FIX_FIRST behaves exactly as it did
#     before this change: the plain not-SHIP failure path, never the new reused-lane message.
REVIEW_STATUS=FIX_FIRST run_script "$(pr_json "$base_sha" "$head_sha")" '' "$live_p1_fix_first_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[live-lane-p1-fix-first] expected FIX_FIRST to still fail closed" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "Review Yeti verdict is FIX_FIRST, not SHIP" <<<"$output" || {
  echo "[live-lane-p1-fix-first] expected the unchanged plain verdict failure message" >&2
  echo "$output" >&2
  exit 1
}
if grep -Fq "reused lane" <<<"$output"; then
  echo "[live-lane-p1-fix-first] the reused-lane rule must never fire on a non-SHIP verdict" >&2
  echo "$output" >&2
  exit 1
fi
echo "[live-lane-p1-fix-first] passed (unchanged FIX_FIRST behavior, reused-lane rule did not fire)"

# 11. scope.chainDepth is optional; a valid nonnegative integer must not fail an otherwise
#     clean report.
run_script "$(pr_json "$base_sha" "$head_sha")" '' "$chain_depth_valid_report"
if [[ "$rc" -ne 0 ]]; then
  echo "[chain-depth-valid] expected a numeric scope.chainDepth to pass" >&2
  echo "$output" >&2
  exit 1
fi
echo "[chain-depth-valid] passed (numeric scope.chainDepth accepted)"

# 12. A malformed (non-numeric) scope.chainDepth must fail closed.
run_script "$(pr_json "$base_sha" "$head_sha")" '' "$chain_depth_invalid_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[chain-depth-invalid] expected a non-numeric scope.chainDepth to fail closed" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "run-report scope.chainDepth must be a nonnegative integer" <<<"$output" || {
  echo "[chain-depth-invalid] expected the scope.chainDepth failure message" >&2
  echo "$output" >&2
  exit 1
}
echo "[chain-depth-invalid] passed (non-numeric scope.chainDepth rejected)"

echo "check-review-verdict self-cancel contract passed"
