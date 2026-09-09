#!/usr/bin/env bash
# hold-for-review.sh
# Centralized gate script for holding CI execution until ct-review-bot's Review Yeti completes.
#
# Exit codes:
#   0 - Review Yeti completed with conclusion 'success' (SHIP) or accepted 'neutral' (PASSTHROUGH).
#   1 - Review Yeti completed with a failing conclusion (FIX_FIRST / BLOCK / transport error),
#       or timed out, or Review Yeti dispatch aborted. Testing is bypassed to save runner compute.
#
# Arguments / Environment:
#   $1 or $HEAD_SHA          - PR head commit SHA (required)
#   $2 or $REPO              - Repository in owner/repo format (required)
#   $3 or $TIMEOUT_SECONDS   - Maximum wait duration in seconds (default: 600)
#   $4 or $POLL_INTERVAL     - Polling interval in seconds (default: 10)

set -euo pipefail

HEAD_SHA="${1:-${HEAD_SHA:-${GITHUB_SHA:-}}}"
REPO="${2:-${REPO:-${GITHUB_REPOSITORY:-}}}"
TIMEOUT_SECONDS="${3:-${TIMEOUT_SECONDS:-600}}"
POLL_INTERVAL="${4:-${POLL_INTERVAL:-10}}"

# Support either GH_TOKEN or GITHUB_TOKEN for gh CLI
export GH_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"

if [ -z "$HEAD_SHA" ] || [ -z "$REPO" ]; then
  echo "Usage: $0 <head_sha> <repo> [timeout_seconds] [poll_interval]" >&2
  exit 1
fi

echo "==> Holding test execution until Review Yeti completes on ${REPO}@${HEAD_SHA} (timeout: ${TIMEOUT_SECONDS}s)"

start_time=$(date +%s)

while true; do
  current_time=$(date +%s)
  elapsed=$((current_time - start_time))
  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    echo "::error::Timed out after ${TIMEOUT_SECONDS}s waiting for Review Yeti verdict at ${HEAD_SHA}."
    exit 1
  fi

  # Query GitHub check-runs API for the head commit (paginated, all check runs)
  set +e
  api_output="$(gh api --paginate "repos/${REPO}/commits/${HEAD_SHA}/check-runs?filter=all" 2>&1)"
  api_status=$?
  set -e
  if [ "$api_status" -ne 0 ] || [ -z "$api_output" ]; then
    echo "[${elapsed}s] Unable to query GitHub check-runs API (exit ${api_status}): ${api_output}. Retrying in ${POLL_INTERVAL}s..."
    sleep "$POLL_INTERVAL"
    continue
  fi
  checks_json="$api_output"

  # Locate the Review Yeti verdict check run from ct-review-bot.
  # Explicitly filter out the queue handoff placeholder: "Review Yeti: DISPATCHED (no verdict for this head)"
  yeti_check="$(echo "$checks_json" | jq -c '
    first(
      .check_runs[]?
      | select(.name == "Review Yeti" and (.app.slug // "") == "ct-review-bot")
      | select((.output.title // "") | test("DISPATCHED \\(no verdict") | not)
    ) // empty
  ' 2>/dev/null || true)"

  if [ -n "$yeti_check" ]; then
    status="$(echo "$yeti_check" | jq -r '.status // "unknown"')"
    conclusion="$(echo "$yeti_check" | jq -r '.conclusion // "pending"')"
    title="$(echo "$yeti_check" | jq -r '.output.title // "No title"')"

    if [ "$status" = "completed" ]; then
      if [ "$conclusion" = "success" ]; then
        echo "==> Review Yeti PASSED with conclusion '${conclusion}' (${title}) after ${elapsed}s."
        echo "==> Proceeding to test execution."
        exit 0
      elif [ "$conclusion" = "neutral" ] && [[ "$title" =~ PASSTHROUGH ]]; then
        echo "==> Review Yeti PASSTHROUGH accepted with conclusion '${conclusion}' (${title}) after ${elapsed}s."
        echo "==> Proceeding to test execution."
        exit 0
      else
        echo "::error::Review Yeti concluded with '${conclusion}' (${title})."
        echo "::error::Holding test execution to prevent burning runner compute on a non-shipping PR."
        exit 1
      fi
    else
      echo "[${elapsed}s] Review Yeti status is '${status}' (${title}). Waiting..."
    fi
  else
    # Check if the dispatching workflow job itself aborted or failed
    dispatch_failure="$(echo "$checks_json" | jq -c '
      first(
        .check_runs[]?
        | select(.name == "Review Yeti / Review Yeti" and .status == "completed" and (.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "cancelled"))
      ) // empty
    ' 2>/dev/null || true)"

    if [ -n "$dispatch_failure" ]; then
      dispatch_conclusion="$(echo "$dispatch_failure" | jq -r '.conclusion // "failure"')"
      echo "::error::Review Yeti dispatch workflow ended with '${dispatch_conclusion}' without publishing a verdict."
      echo "::error::Holding test execution to prevent burning runner compute."
      exit 1
    fi

    echo "[${elapsed}s] Review Yeti check run not yet registered or in dispatch handoff. Waiting..."
  fi

  sleep "$POLL_INTERVAL"
done
