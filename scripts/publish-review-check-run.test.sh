#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/publish-review-check-run.sh"
export TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ORIG_PATH="$PATH"

# Mock curl that records calls and method
cat >"$TMP/curl" <<INNER_EOF
#!/usr/bin/env bash
set -euo pipefail

log_file="$TMP/curl_calls.log"
method=""
url=""
data=""

while [[ \$# -gt 0 ]]; do
  case "\$1" in
    -X)
      method="\$2"
      shift 2
      ;;
    -d)
      data="\$2"
      shift 2
      ;;
    http*)
      url="\$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

echo "\${method}|\${url}|\${data}" >> "\$log_file"
cat <<'JSON'
{"id": 999999, "status": "completed"}
JSON
INNER_EOF
chmod +x "$TMP/curl"

# Test 1: Missing TARGET_REPO or HEAD_SHA exits 0
set +e
env -i PATH="$TMP:$ORIG_PATH" GH_TOKEN="test-token" "$SCRIPT" >/dev/null 2>&1
status1=$?
set -e
[[ "$status1" -eq 0 ]]

# DOKS never writes a target check-run, regardless of whether the worker handoff
# returned DISPATCHED, failed before a verdict, produced a verdict, or ran in
# passthrough mode. A bogus CHECK_ID must be ignored rather than PATCHed.
run_doks_case() {
  local label="$1"
  local status="$2"
  local passthrough="$3"
  local check_id="$4"
  local summary="$TMP/${label}.summary"

  rm -f "$TMP/curl_calls.log" "$summary"
  env -i PATH="$TMP:$ORIG_PATH" \
    GH_TOKEN="test-token" \
    TARGET_REPO="exampleorg/ct-test" \
    HEAD_SHA="abc1234" \
    REVIEW_YETI_EXECUTION_BACKEND="doks" \
    REVIEW_STATUS="$status" \
    REVIEW_YETI_PASSTHROUGH="$passthrough" \
    CHECK_ID="$check_id" \
    CENTRAL_RUN_URL="https://example.com/run/1" \
    GITHUB_STEP_SUMMARY="$summary" \
    "$SCRIPT" >/dev/null

  [[ ! -f "$TMP/curl_calls.log" ]]
  grep -qF "DOKS backend returned" "$summary"
  grep -qF "Central Checks API writes: 0" "$summary"
  if grep -Eq '(^|[^A-Za-z])(PATCH|POST)([^A-Za-z]|$)' "$summary"; then
    echo "$label receipt must not describe a check API write" >&2
    exit 1
  fi
}

run_doks_case dispatched DISPATCHED "" 45678
run_doks_case error ERROR "" ""
run_doks_case missing-verdict "" "" ""
run_doks_case success SHIP "" ""

# Passthrough on DOKS must still POST required App checks (worker is not dispatched).
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_YETI_EXECUTION_BACKEND="doks" \
  REVIEW_STATUS="SKIPPED" \
  REVIEW_YETI_PASSTHROUGH="true" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -cF "POST|https://api.github.com/repos/exampleorg/ct-test/check-runs|" "$TMP/curl_calls.log" | grep -qx 2
grep -qF '"name":"Review Yeti"' "$TMP/curl_calls.log"
grep -qF '"name":"Review Yeti Gate"' "$TMP/curl_calls.log"
grep -qF '"conclusion":"skipped"' "$TMP/curl_calls.log"
grep -qF 'SKIPPED' "$TMP/curl_calls.log"

# Local passthrough also POSTs skipped (not SHIP/success) for both required names.
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_YETI_EXECUTION_BACKEND="local" \
  REVIEW_YETI_PASSTHROUGH="true" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -qF '"conclusion":"skipped"' "$TMP/curl_calls.log"
grep -qF '"name":"Review Yeti Gate"' "$TMP/curl_calls.log"

# Hosted/local SHIP without CHECK_ID POSTs both the raw verdict and required gate.
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_YETI_EXECUTION_BACKEND="local" \
  REVIEW_STATUS="SHIP" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -cF "POST|https://api.github.com/repos/exampleorg/ct-test/check-runs|" "$TMP/curl_calls.log" | grep -qx 2
grep -qF '"name":"Review Yeti"' "$TMP/curl_calls.log"
grep -qF '"name":"Review Yeti Gate"' "$TMP/curl_calls.log"
grep -qF '"conclusion":"success"' "$TMP/curl_calls.log"

# Hosted/local SHIP with CHECK_ID PATCHes the raw verdict and POSTs the gate.
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_YETI_EXECUTION_BACKEND="local" \
  REVIEW_STATUS="SHIP" \
  CHECK_ID="78901" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -qF "PATCH|https://api.github.com/repos/exampleorg/ct-test/check-runs/78901|" "$TMP/curl_calls.log"
grep -qF "POST|https://api.github.com/repos/exampleorg/ct-test/check-runs|" "$TMP/curl_calls.log"
grep -qF '"name":"Review Yeti Gate"' "$TMP/curl_calls.log"
grep -qF '"conclusion":"success"' "$TMP/curl_calls.log"

# Hosted/local FIX_FIRST with CHECK_ID fails both the raw verdict and gate.
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_YETI_EXECUTION_BACKEND="local" \
  REVIEW_STATUS="FIX_FIRST" \
  CHECK_ID="78901" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -qF "PATCH|https://api.github.com/repos/exampleorg/ct-test/check-runs/78901|" "$TMP/curl_calls.log"
grep -qF "POST|https://api.github.com/repos/exampleorg/ct-test/check-runs|" "$TMP/curl_calls.log"
grep -qF '"name":"Review Yeti Gate"' "$TMP/curl_calls.log"
grep -qF '"conclusion":"failure"' "$TMP/curl_calls.log"

# Hosted/local unknown verdicts remain fail-closed and are still published as failures.
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_YETI_EXECUTION_BACKEND="local" \
  REVIEW_STATUS="UNKNOWN_VERDICT" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -cF "POST|https://api.github.com/repos/exampleorg/ct-test/check-runs|" "$TMP/curl_calls.log" | grep -qx 2
grep -qF '"name":"Review Yeti Gate"' "$TMP/curl_calls.log"
grep -qF '"conclusion":"failure"' "$TMP/curl_calls.log"

echo "publish-review-check-run.test.sh: DOKS no-write and hosted publication contract passed"
