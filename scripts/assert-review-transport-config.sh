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
#
# A third destination is recognised by the SHA-256 of its base URL rather than by hostname, because
# this repository is public and the operator's hygiene rule bars first-party hostnames from it. The
# digest here must stay identical to ALLOWED_REVIEW_BASE_URL_DIGESTS in
# .github/workflows/pipelines/openrouter-policy.js; a drift test asserts that.
set -euo pipefail

BASE_URL="${REVIEW_BASE_URL:-}"
OPENCODE_KEY_PRESENT="${OPENCODE_KEY_PRESENT:-false}"
OPENROUTER_KEY_PRESENT="${OPENROUTER_KEY_PRESENT:-false}"
GATEWAY_KEY_PRESENT="${GATEWAY_KEY_PRESENT:-false}"
FIREWORKS_KEY_PRESENT="${FIREWORKS_KEY_PRESENT:-false}"
LANE_TIMEOUT_MS="${REVIEW_LANE_TIMEOUT_MS:-}"
OPENCODE_MIN_LANE_TIMEOUT_MS="${OPENCODE_MIN_LANE_TIMEOUT_MS:-300000}"
# Not a vendor-published budget: derived from measured per-turn latency on this destination
# (~12s for a prefix-sized turn) against the 15-turn investigation ceiling, plus headroom. The
# point is that the 90s DEFAULT would truncate a multi-turn lane, so the variable must be set.
GATEWAY_MIN_LANE_TIMEOUT_MS="${GATEWAY_MIN_LANE_TIMEOUT_MS:-300000}"
# Same floor as the gateway: Fireworks is a direct reasoning transport, and the 90s default
# cuts a multi-turn lane off before it emits findings.
FIREWORKS_MIN_LANE_TIMEOUT_MS="${FIREWORKS_MIN_LANE_TIMEOUT_MS:-300000}"
# Digest of the normalized base URL. Keep in lockstep with openrouter-policy.js.
GATEWAY_BASE_URL_SHA256="${GATEWAY_BASE_URL_SHA256:-ca8309dbe7eb85c5c7da280d48572eb44d159c1244ebea3548b82784cbc27c53}"

fail() { echo "::error::$1" >&2; exit 1; }

# Emit the destination CLASS the guard actually matched, so the workflow's credential selection
# binds to this resolution instead of re-deriving it. Without this the selector identified the
# gateway by elimination ("not opencode, not openrouter, not empty"), which silently mis-routes the
# gateway credential to any FOURTH destination a later change admits here.
emit_destination() {
  [ -n "${GITHUB_OUTPUT:-}" ] && printf 'destination=%s\n' "$1" >> "$GITHUB_OUTPUT"
  return 0
}

# sha256sum on GitHub's Linux runners, shasum on developer macOS. Absent both, fail closed rather
# than skipping the destination check.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then printf '%s' "$1" | sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  else fail "Neither sha256sum nor shasum is available; cannot verify the review destination."
  fi
}

require_lane_timeout() {
  local floor="$1" destination_label="$2"
  case "$LANE_TIMEOUT_MS" in
    ''|*[!0-9]*) fail \
      "Review destination is ${destination_label} but REVIEW_LANE_TIMEOUT_MS is unset or non-numeric ('${LANE_TIMEOUT_MS}'). The default outer deadline is tighter than the provider budget, so every lane would time out mid-stream." ;;
  esac
  [ "$LANE_TIMEOUT_MS" -ge "$floor" ] || fail \
    "REVIEW_LANE_TIMEOUT_MS=${LANE_TIMEOUT_MS} is tighter than the ${destination_label} provider budget of ${floor}ms; the outer deadline would cut off a lane the inner budget still considers live."
}

# Checked BEFORE the hostname cases: this destination is identified by digest, and an exact match
# must win before any substring rule gets a chance to look at it.
NORMALIZED_BASE_URL="${BASE_URL%"${BASE_URL##*[!/]}"}"
if [ -n "$BASE_URL" ] && [ "$(sha256_of "$NORMALIZED_BASE_URL")" = "$GATEWAY_BASE_URL_SHA256" ]; then
  [ "$GATEWAY_KEY_PRESENT" = "true" ] || fail \
    "Review destination is the digest-pinned gateway but CT_REVIEW_GATEWAY_API_KEY is unset. Refusing to run rather than falling back to another provider's credential, which the workflow's key-selection expression would otherwise transmit to it."
  require_lane_timeout "$GATEWAY_MIN_LANE_TIMEOUT_MS" "digest-pinned gateway"
  emit_destination gateway
  # Deliberately does not echo the URL: this repository is public and so are its workflow logs.
  echo "Review transport configuration is consistent: digest-pinned gateway destination"
  exit 0
fi

case "$BASE_URL" in
  *opencode.ai*)
    [ "$OPENCODE_KEY_PRESENT" = "true" ] || fail \
      "Review destination is opencode but CT_REVIEW_OPENCODE_API_KEY is unset. Refusing to run rather than falling back to the OpenRouter credential, which would transmit it to opencode.ai."
    require_lane_timeout "$OPENCODE_MIN_LANE_TIMEOUT_MS" "opencode"
    emit_destination opencode
    ;;
  *openrouter.ai*)
    [ "$OPENROUTER_KEY_PRESENT" = "true" ] || fail \
      "Review destination is OpenRouter but CT_REVIEW_OPENROUTER_API_KEY is unset."
    emit_destination openrouter
    ;;
  *api.fireworks.ai*)
    [ "$FIREWORKS_KEY_PRESENT" = "true" ] || fail \
      "Review destination is Fireworks but CT_REVIEW_FIREWORKS_API_KEY is unset. Refusing to run rather than falling back to another provider's credential."
    require_lane_timeout "$FIREWORKS_MIN_LANE_TIMEOUT_MS" "fireworks"
    emit_destination fireworks
    ;;
  *)
    fail "Review destination has no matching role-scoped credential rule (sha256 $(sha256_of "$NORMALIZED_BASE_URL")). The URL is withheld because this repository's workflow logs are public."
    ;;
esac

echo "Review transport configuration is consistent: ${BASE_URL}"
