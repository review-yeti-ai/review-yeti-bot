#!/usr/bin/env bash
# Fail closed when the review transport configuration is internally inconsistent.
#
# Extracted from review-bot.yaml so it is testable. Branching and exit paths buried in workflow
# YAML cannot be exercised by the suite, and these two invariants are exactly the kind that fail
# silently and expensively.
#
# 1. One provider's credential must never reach another provider's endpoint. The workflow's
#    key-selection expression cannot enforce this alone: GitHub Actions `&&`/`||` return operands
#    rather than booleans, and an unset secret is an empty string, which is falsy -- so a missing
#    opencode key falls through to the OpenRouter credential while the destination still points at
#    opencode.
#
# 2. The action's outer per-lane deadline must not be tighter than the provider's own budget, or
#    it cuts off a lane the inner budget still considers live. This does NOT hold by default:
#    the outer default is 90s and the opencode budget is 300s, so the opencode destination
#    REQUIRES REVIEW_LANE_TIMEOUT_MS to be set. A requirement that lives only in a repository
#    variable is invisible until reviews start failing; assert it instead.
set -euo pipefail

BASE_URL="${REVIEW_BASE_URL:-}"
OPENCODE_KEY_PRESENT="${OPENCODE_KEY_PRESENT:-false}"
OPENROUTER_KEY_PRESENT="${OPENROUTER_KEY_PRESENT:-false}"
LANE_TIMEOUT_MS="${REVIEW_LANE_TIMEOUT_MS:-}"
OPENCODE_MIN_LANE_TIMEOUT_MS="${OPENCODE_MIN_LANE_TIMEOUT_MS:-300000}"

fail() { echo "::error::$1" >&2; exit 1; }

case "$BASE_URL" in
  *opencode.ai*)
    [ "$OPENCODE_KEY_PRESENT" = "true" ] || fail \
      "Review destination is opencode but CT_REVIEW_OPENCODE_API_KEY is unset. Refusing to run rather than falling back to the OpenRouter credential, which would transmit it to opencode.ai."
    case "$LANE_TIMEOUT_MS" in
      ''|*[!0-9]*) fail \
        "Review destination is opencode but REVIEW_LANE_TIMEOUT_MS is unset or non-numeric ('${LANE_TIMEOUT_MS}'). The default outer deadline is tighter than the opencode provider budget, so every lane would time out mid-stream." ;;
    esac
    [ "$LANE_TIMEOUT_MS" -ge "$OPENCODE_MIN_LANE_TIMEOUT_MS" ] || fail \
      "REVIEW_LANE_TIMEOUT_MS=${LANE_TIMEOUT_MS} is tighter than the opencode provider budget of ${OPENCODE_MIN_LANE_TIMEOUT_MS}ms; the outer deadline would cut off a lane the inner budget still considers live."
    ;;
  *openrouter.ai*)
    [ "$OPENROUTER_KEY_PRESENT" = "true" ] || fail \
      "Review destination is OpenRouter but CT_REVIEW_OPENROUTER_API_KEY is unset."
    ;;
  *)
    fail "Review destination '${BASE_URL}' has no matching role-scoped credential rule."
    ;;
esac

echo "Review transport configuration is consistent: ${BASE_URL}"
