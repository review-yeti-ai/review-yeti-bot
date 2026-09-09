#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/hold-for-review.sh"
export TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ORIG_PATH="$PATH"

cat >"$TMP/gh" <<'INNER_EOF'
#!/usr/bin/env bash
set -euo pipefail

case "${FAKE_GH_RESULT:-ship}" in
  ship)
    cat <<'JSON'
{
  "check_runs": [
    {
      "name": "Review Yeti",
      "app": {"slug": "ct-review-bot"},
      "status": "completed",
      "conclusion": "success",
      "output": {"title": "Review Yeti: SHIP (0 findings)"}
    }
  ]
}
JSON
    ;;
  passthrough)
    cat <<'JSON'
{
  "check_runs": [
    {
      "name": "Review Yeti",
      "app": {"slug": "ct-review-bot"},
      "status": "completed",
      "conclusion": "neutral",
      "output": {"title": "Review Yeti: PASSTHROUGH (no review performed)"}
    }
  ]
}
JSON
    ;;
  dispatched_then_ship)
    count_file="$TMP/yeti_test_poll_count"
    count=0
    if [[ -f "$count_file" ]]; then
      count=$(cat "$count_file")
    fi
    count=$((count + 1))
    echo "$count" > "$count_file"
    if [[ "$count" -eq 1 ]]; then
      cat <<'JSON'
{
  "check_runs": [
    {
      "name": "Review Yeti",
      "app": {"slug": "ct-review-bot"},
      "status": "completed",
      "conclusion": "failure",
      "output": {"title": "Review Yeti: DISPATCHED (no verdict for this head)"}
    }
  ]
}
JSON
    else
      cat <<'JSON'
{
  "check_runs": [
    {
      "name": "Review Yeti",
      "app": {"slug": "ct-review-bot"},
      "status": "completed",
      "conclusion": "success",
      "output": {"title": "Review Yeti: SHIP (all checks passed)"}
    }
  ]
}
JSON
    fi
    ;;
  fix_first)
    cat <<'JSON'
{
  "check_runs": [
    {
      "name": "Review Yeti",
      "app": {"slug": "ct-review-bot"},
      "status": "completed",
      "conclusion": "failure",
      "output": {"title": "Review Yeti: FIX_FIRST (1 blocking finding)"}
    }
  ]
}
JSON
    ;;
  dispatch_failure)
    cat <<'JSON'
{
  "check_runs": [
    {
      "name": "Review Yeti / Review Yeti",
      "status": "completed",
      "conclusion": "failure"
    }
  ]
}
JSON
    ;;
  pending)
    cat <<'JSON'
{
  "check_runs": [
    {
      "name": "Review Yeti",
      "app": {"slug": "ct-review-bot"},
      "status": "in_progress",
      "conclusion": null,
      "output": {"title": "Review Yeti: in progress"}
    }
  ]
}
JSON
    ;;
  untrusted_app)
    cat <<'JSON'
{
  "check_runs": [
    {
      "name": "Review Yeti",
      "app": {"slug": "some-other-app"},
      "status": "completed",
      "conclusion": "success",
      "output": {"title": "Review Yeti: SHIP (spoofed)"}
    }
  ]
}
JSON
    ;;
  dispatched_and_ship_coexisting)
    cat <<'JSON'
{
  "check_runs": [
    {
      "name": "Review Yeti",
      "app": {"slug": "ct-review-bot"},
      "status": "completed",
      "conclusion": "failure",
      "output": {"title": "Review Yeti: DISPATCHED (no verdict for this head)"}
    },
    {
      "name": "Review Yeti",
      "app": {"slug": "ct-review-bot"},
      "status": "completed",
      "conclusion": "success",
      "output": {"title": "Review Yeti: SHIP (0 findings)"}
    }
  ]
}
JSON
    ;;
esac
INNER_EOF
chmod +x "$TMP/gh"

# Test 1: Missing args (strictly isolated from runner environment)
set +e
env -i PATH="$TMP:$ORIG_PATH" "$SCRIPT" 2>/dev/null
missing_status=$?
set -e
[[ "$missing_status" -eq 1 ]]

# Test 2: Ship verdict
ship_output="$(env -i PATH="$TMP:$ORIG_PATH" FAKE_GH_RESULT=ship "$SCRIPT" abc1234 exampleorg/example-release 10 1)"
grep -qF "Review Yeti PASSED with conclusion 'success'" <<<"$ship_output"

# Test 3: Passthrough verdict
passthrough_output="$(env -i PATH="$TMP:$ORIG_PATH" FAKE_GH_RESULT=passthrough "$SCRIPT" abc1234 exampleorg/example-release 10 1)"
grep -qF "Review Yeti PASSTHROUGH accepted" <<<"$passthrough_output"

# Test 4: Dispatched placeholder ignored then Ship verdict
rm -f "$TMP/yeti_test_poll_count"
dispatched_output="$(env -i PATH="$TMP:$ORIG_PATH" TMP="$TMP" FAKE_GH_RESULT=dispatched_then_ship "$SCRIPT" abc1234 exampleorg/example-release 10 1)"
grep -qF "Review Yeti check run not yet registered or in dispatch handoff" <<<"$dispatched_output"
grep -qF "Review Yeti PASSED with conclusion 'success'" <<<"$dispatched_output"
rm -f "$TMP/yeti_test_poll_count"

# Test 5: FIX_FIRST failure
set +e
fix_output="$(env -i PATH="$TMP:$ORIG_PATH" FAKE_GH_RESULT=fix_first "$SCRIPT" abc1234 exampleorg/example-release 10 1 2>&1)"
fix_status=$?
set -e
[[ "$fix_status" -eq 1 ]]
grep -qF "Review Yeti concluded with 'failure'" <<<"$fix_output"

# Test 6: Dispatch failure
set +e
dispatch_fail_output="$(env -i PATH="$TMP:$ORIG_PATH" FAKE_GH_RESULT=dispatch_failure "$SCRIPT" abc1234 exampleorg/example-release 10 1 2>&1)"
dispatch_fail_status=$?
set -e
[[ "$dispatch_fail_status" -eq 1 ]]
grep -qF "Review Yeti dispatch workflow ended with 'failure'" <<<"$dispatch_fail_output"

# Test 7: Timeout
set +e
timeout_output="$(env -i PATH="$TMP:$ORIG_PATH" FAKE_GH_RESULT=pending "$SCRIPT" abc1234 exampleorg/example-release 1 1 2>&1)"
timeout_status=$?
set -e
[[ "$timeout_status" -eq 1 ]]
grep -qF "Timed out after 1s waiting for Review Yeti verdict" <<<"$timeout_output"

# Test 8: Untrusted app check run is ignored
set +e
untrusted_output="$(env -i PATH="$TMP:$ORIG_PATH" FAKE_GH_RESULT=untrusted_app "$SCRIPT" abc1234 exampleorg/example-release 1 1 2>&1)"
untrusted_status=$?
set -e
[[ "$untrusted_status" -eq 1 ]]
grep -qF "Timed out after 1s waiting for Review Yeti verdict" <<<"$untrusted_output"

# Test 9: Dispatched and Ship coexisting in same check runs list (filter=all)
coexist_output="$(env -i PATH="$TMP:$ORIG_PATH" FAKE_GH_RESULT=dispatched_and_ship_coexisting "$SCRIPT" abc1234 exampleorg/example-release 10 1)"
grep -qF "Review Yeti PASSED with conclusion 'success'" <<<"$coexist_output"

echo "hold-for-review.test.sh: all 9 test cases passed successfully"
