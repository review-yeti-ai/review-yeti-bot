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

pr_json() {
  printf '{"base":{"sha":"%s"},"head":{"sha":"%s"}}' "$1" "$2"
}

run_script() {
  local pr_json="$1" run_view_json="${2-}"
  if [[ -z "$run_view_json" ]]; then
    run_view_json='{"status":"in_progress","conclusion":null}'
  fi
  local -A extra=(
    [REVIEW_STATUS]="${REVIEW_STATUS:-SHIP}"
    [GATE_DECISION]="${GATE_DECISION:-PASS}"
    [MERGE_ELIGIBLE]="${MERGE_ELIGIBLE:-true}"
    [FILES_OMITTED]="${FILES_OMITTED:-0}"
    [DISPATCH_REFLECTION_STATUS]="${DISPATCH_REFLECTION_STATUS:-complete}"
    [PROVIDER_RECEIPT_DIGEST]="${PROVIDER_RECEIPT_DIGEST:-$digest}"
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

# 4. Everything matches and verdict is a clean SHIP/PASS: unaffected, exits 0.
run_script "$(pr_json "$base_sha" "$head_sha")"
if [[ "$rc" -ne 0 ]]; then
  echo "[exact-match] expected exit 0, got $rc" >&2
  echo "$output" >&2
  exit 1
fi
grep -Fq "accepted" <<<"$output" || { echo "[exact-match] expected the acceptance message" >&2; exit 1; }
echo "[exact-match] passed"

echo "check-review-verdict self-cancel contract passed"
