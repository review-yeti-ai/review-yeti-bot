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

# Test 2: DISPATCHED without CHECK_ID POSTs failure check-run
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_STATUS="DISPATCHED" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -qF "POST|https://api.github.com/repos/exampleorg/ct-test/check-runs|" "$TMP/curl_calls.log"
grep -qF '"conclusion":"failure"' "$TMP/curl_calls.log"

# Test 3: DISPATCHED with CHECK_ID exits 0 without curl call
rm -f "$TMP/curl_calls.log"
output3=$(env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_STATUS="DISPATCHED" \
  CHECK_ID="45678" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT")

[[ ! -f "$TMP/curl_calls.log" ]]
grep -qF "Skipping placeholder publication" <<<"$output3"

# Test 4: PASSTHROUGH without CHECK_ID POSTs neutral
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_YETI_PASSTHROUGH="true" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -qF "POST|https://api.github.com/repos/exampleorg/ct-test/check-runs|" "$TMP/curl_calls.log"
grep -qF '"conclusion":"neutral"' "$TMP/curl_calls.log"

# Test 5: PASSTHROUGH with CHECK_ID PATCHes check-run
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_YETI_PASSTHROUGH="true" \
  CHECK_ID="45678" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -qF "PATCH|https://api.github.com/repos/exampleorg/ct-test/check-runs/45678|" "$TMP/curl_calls.log"
grep -qF '"conclusion":"neutral"' "$TMP/curl_calls.log"

# Test 6: SHIP verdict without CHECK_ID POSTs success
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_STATUS="SHIP" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -qF "POST|https://api.github.com/repos/exampleorg/ct-test/check-runs|" "$TMP/curl_calls.log"
grep -qF '"conclusion":"success"' "$TMP/curl_calls.log"

# Test 7: SHIP verdict with CHECK_ID PATCHes success
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_STATUS="SHIP" \
  CHECK_ID="78901" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -qF "PATCH|https://api.github.com/repos/exampleorg/ct-test/check-runs/78901|" "$TMP/curl_calls.log"
grep -qF '"conclusion":"success"' "$TMP/curl_calls.log"

# Test 8: FIX_FIRST verdict with CHECK_ID PATCHes failure
rm -f "$TMP/curl_calls.log"
env -i PATH="$TMP:$ORIG_PATH" \
  GH_TOKEN="test-token" \
  TARGET_REPO="exampleorg/ct-test" \
  HEAD_SHA="abc1234" \
  REVIEW_STATUS="FIX_FIRST" \
  CHECK_ID="78901" \
  CENTRAL_RUN_URL="https://example.com/run/1" \
  "$SCRIPT" >/dev/null 2>&1

grep -qF "PATCH|https://api.github.com/repos/exampleorg/ct-test/check-runs/78901|" "$TMP/curl_calls.log"
grep -qF '"conclusion":"failure"' "$TMP/curl_calls.log"

echo "publish-review-check-run.test.sh: all 8 test cases passed successfully"
