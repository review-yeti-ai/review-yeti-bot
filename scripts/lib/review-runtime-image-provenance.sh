#!/usr/bin/env bash
# Source this library, then call:
#   verify_review_runtime_image_provenance IMAGE_REPO@sha256:DIGEST REVIEWED_SHA
# Returns 0 for an exact registry source-tag/digest match, 2 for invalid input,
# and 1 for an unavailable crane/registry or a mismatched registry response.
# Success is silent; failures emit only fixed diagnostics.
#
# This proves registry source-tag matching at lookup time, not independent
# source review or cryptographic attestation. The caller must supply the exact
# reviewed source SHA. No fallback tags, platform selection, credentials,
# registry login, retry loop, or mutable override of the allowlist is used.

verify_review_runtime_image_provenance() (
  # Keep caller shell options unchanged and raw registry responses out of
  # inherited xtrace. Case-insensitive caller matching must not weaken policy.
  set +x
  shopt -u nocasematch
  export LC_ALL=C

  if [[ "$#" != 2 ]]; then
    printf '%s\n' 'review-runtime-image-provenance: expected image and reviewed source SHA' >&2
    return 2
  fi

  local image="$1" source_sha="$2" repository expected_digest resolved_digest crane_path
  if [[ ! "$source_sha" =~ ^[0-9a-f]{40}$ ]]; then
    printf '%s\n' 'review-runtime-image-provenance: source SHA must be exactly 40 lowercase hex characters' >&2
    return 2
  fi

  if [[ ! "$image" =~ ^(ghcr\.io/review-yeti-ai/(review-yeti-bot|review-yeti-operator|review-yeti-worker)|registry\.digitalocean\.com/calltelemetry/(ct-review-bot|review-yeti-operator|review-yeti-worker))@sha256:[0-9a-f]{64}$ ]]; then
    printf '%s\n' 'review-runtime-image-provenance: expected a trusted repository with an exact lowercase sha256 digest' >&2
    return 2
  fi

  if ! crane_path="$(type -P crane)" || [[ -z "$crane_path" ]]; then
    printf '%s\n' 'review-runtime-image-provenance: installed crane is unavailable' >&2
    return 1
  fi

  repository="${image%@*}"
  expected_digest="${image##*@}"
  # A single lookup of the full source-SHA tag. Do not pass --platform: a
  # platform manifest digest is not interchangeable with its parent index.
  if ! resolved_digest="$("$crane_path" digest "$repository:$source_sha" 2>/dev/null)"; then
    printf '%s\n' 'review-runtime-image-provenance: registry source-tag lookup failed' >&2
    return 1
  fi
  if [[ ! "$resolved_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '%s\n' 'review-runtime-image-provenance: registry returned an invalid digest' >&2
    return 1
  fi
  if [[ "$resolved_digest" != "$expected_digest" ]]; then
    printf '%s\n' 'review-runtime-image-provenance: source-tag digest does not match the requested image' >&2
    return 1
  fi
  return 0
)

export -f verify_review_runtime_image_provenance
