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
grep -Fq "accepted" <<<"$output" || { echo "[zero-lane-ship] expected the acceptance message" >&2; echo "$output" >&2; exit 1; }
echo "[zero-lane-ship] passed (published SHIP honored, no crash)"

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

# 5. A syntactically valid SHIP/PASS report with an unresolved P2 advisory must block.
run_script "$(pr_json "$base_sha" "$head_sha")" '' "$nonzero_p2_report"
if [[ "$rc" -eq 0 ]]; then
  echo "[p2-advisory] expected unresolved P2 advisory to block" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "unresolved P2 advisory finding(s)" <<<"$output" || {
  echo "[p2-advisory] expected the required-advisory failure message" >&2
  echo "$output" >&2
  exit 1
}
echo "[p2-advisory] passed (unresolved advisory blocks)"

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

echo "check-review-verdict self-cancel contract passed"
