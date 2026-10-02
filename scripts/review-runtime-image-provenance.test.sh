#!/usr/bin/env bash
# Child Bash code deliberately receives literal positional parameters.
# shellcheck disable=SC2016
set -euo pipefail

# The verifier's PATH contains only Bash and this file symlinked as crane.
# Its fake-crane branch uses only Bash builtins; no registry/client is invoked.
if [[ "${0##*/}" == crane ]]; then
  printf '%s\n' call >>"$PROVENANCE_TEST_CALLS"
  [[ "$#" == 2 && "$1" == digest && "$2" == "$PROVENANCE_TEST_SOURCE_TAG" ]] || exit 90
  case "$PROVENANCE_TEST_MODE" in
    match) printf '%s\n' "$PROVENANCE_TEST_DIGEST" ;;
    mismatch) printf 'sha256:%064d\n' 0 ;;
    failure)
      printf '%s\n' 'RAW_REGISTRY_BODY CREDENTIAL_SENTINEL'
      printf '%s\n' 'Authorization: Bearer CREDENTIAL_SENTINEL' >&2
      exit 1
      ;;
    unavailable) exit 127 ;;
    empty) : ;;
    raw-success) printf '%s\n' 'RAW_REGISTRY_BODY CREDENTIAL_SENTINEL' ;;
    extra-line) printf '%s\n%s\n' "$PROVENANCE_TEST_DIGEST" 'RAW_REGISTRY_BODY CREDENTIAL_SENTINEL' ;;
    noisy-match)
      printf '%s\n' 'Authorization: Bearer CREDENTIAL_SENTINEL' >&2
      printf '%s\n' "$PROVENANCE_TEST_DIGEST"
      ;;
    *) exit 91 ;;
  esac
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
library="$script_dir/lib/review-runtime-image-provenance.sh"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/review-runtime-provenance.XXXXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT
mkdir "$test_root/bin" "$test_root/empty"
ln -s "$BASH" "$test_root/bin/bash"
ln -s "$script_dir/review-runtime-image-provenance.test.sh" "$test_root/bin/crane"
export PROVENANCE_TEST_CALLS="$test_root/calls"
export PROVENANCE_TEST_DIGEST="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
sha="0123456789abcdef0123456789abcdef01234567"
repo="ghcr.io/review-yeti-ai/review-yeti-bot"
image="$repo@$PROVENANCE_TEST_DIGEST"
passed=0

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

check() {
  local name="$1" expected_status="$2" expected_calls="$3" mode="$4"
  local target="$5" source="$6" case_path="${7:-$test_root/bin}"
  local output status calls=0 line
  : >"$PROVENANCE_TEST_CALLS"
  export PROVENANCE_TEST_SOURCE_TAG="${target%@*}:$source"
  export PROVENANCE_TEST_MODE="$mode"
  # Exercise callers with errexit, nounset, nocasematch and xtrace enabled.
  # The inputs are positional parameters; never evaluate them as shell code.
  if output="$(PATH="$case_path" "$BASH" -c '
      set -euo pipefail
      source "$1"
      shopt -s nocasematch
      set -x
      verify_review_runtime_image_provenance "$2" "$3"
    ' bash "$library" "$target" "$source" 2>&1)"; then
    status=0
  else
    status=$?
  fi
  [[ "$status" == "$expected_status" ]] || fail "$name: unexpected exit status $status"
  while IFS= read -r line; do
    [[ "$line" == call ]] || fail "$name: malformed fake-crane invocation record"
    calls=$((calls + 1))
  done <"$PROVENANCE_TEST_CALLS"
  [[ "$calls" == "$expected_calls" ]] || fail "$name: unexpected lookup count $calls"
  [[ "$output" != *CREDENTIAL_SENTINEL* && "$output" != *RAW_REGISTRY_BODY* ]] || fail "$name: raw registry output escaped"
  if [[ "$expected_status" != 0 ]]; then
    [[ "$output" == *review-runtime-image-provenance:* ]] || fail "$name: missing fixed failure diagnostic"
  fi
  passed=$((passed + 1))
  printf 'ok - %s\n' "$name"
}

for trusted_repo in \
  ghcr.io/review-yeti-ai/review-yeti-bot \
  ghcr.io/review-yeti-ai/review-yeti-operator \
  ghcr.io/review-yeti-ai/review-yeti-worker \
  registry.digitalocean.com/calltelemetry/ct-review-bot \
  registry.digitalocean.com/calltelemetry/review-yeti-operator \
  registry.digitalocean.com/calltelemetry/review-yeti-worker; do
  check "matching $trusted_repo" 0 1 match "$trusted_repo@$PROVENANCE_TEST_DIGEST" "$sha"
done

check 'manifest/index digest mismatch' 1 1 mismatch "$image" "$sha"
check 'registry failure with sensitive output' 1 1 failure "$image" "$sha"
check 'registry unavailable' 1 1 unavailable "$image" "$sha"
check 'empty registry response' 1 1 empty "$image" "$sha"
check 'raw response with successful exit' 1 1 raw-success "$image" "$sha"
check 'digest with extra response lines' 1 1 extra-line "$image" "$sha"
check 'matching digest with sensitive stderr' 0 1 noisy-match "$image" "$sha"
check 'crane missing' 1 0 match "$image" "$sha" "$test_root/empty"

for bad_sha in '' abcdef "${sha}a" 'ABCDEF0123456789abcdef0123456789abcdef0123' "$sha " "$sha"$'\n' 'main' 'v1.45.5'; do
  check 'malformed or moving source SHA' 2 0 match "$image" "$bad_sha"
done
for bad_image in \
  '' "$repo:latest" "$repo:$sha" "$repo:latest@$PROVENANCE_TEST_DIGEST" \
  "$repo@sha256:abc" "$repo@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" \
  "$repo@junk@$PROVENANCE_TEST_DIGEST" "$repo@$PROVENANCE_TEST_DIGEST " "$image"$'\n' \
  "https://$image" "GHCR.io/review-yeti-ai/review-yeti-bot@$PROVENANCE_TEST_DIGEST" \
  "ghcr.io/review-yeti-ai/unknown@$PROVENANCE_TEST_DIGEST" \
  "ghcr.io/review-yeti-ai/review-yeti-bot/extra@$PROVENANCE_TEST_DIGEST" \
  "ghcr.io.evil/review-yeti-ai/review-yeti-bot@$PROVENANCE_TEST_DIGEST" \
  "registry.digitalocean.com/calltelemetry/review-yeti-bot@$PROVENANCE_TEST_DIGEST"; do
  check 'malformed or untrusted image' 2 0 match "$bad_image" "$sha"
done

# Sourcing must not perform a lookup, change shell options, or print output;
# the exported function must also work in a child Bash without re-sourcing.
: >"$PROVENANCE_TEST_CALLS"
export PROVENANCE_TEST_MODE=match PROVENANCE_TEST_SOURCE_TAG="$repo:$sha"
output="$(PATH="$test_root/bin" "$BASH" -c '
  set -euo pipefail
  shopt -s nocasematch
  before_options="$(set +o)"
  source "$1"
  [[ "$(set +o)" == "$before_options" ]]
  shopt -q nocasematch
  [[ ! -s "$PROVENANCE_TEST_CALLS" ]]
  "$BASH" -c '\''verify_review_runtime_image_provenance "$1" "$2"'\'' bash "$2" "$3"
  shopt -q nocasematch
' bash "$library" "$image" "$sha" 2>&1)" || fail 'library export/options contract'
[[ -z "$output" ]] || fail 'successful verification must be silent'
passed=$((passed + 1))
printf 'ok - source/export/options contract\n'

for argument_count in 0 1 3; do
  : >"$PROVENANCE_TEST_CALLS"
  if PATH="$test_root/bin" "$BASH" -c '
    source "$1"
    case "$2" in
      0) verify_review_runtime_image_provenance ;;
      1) verify_review_runtime_image_provenance "$3" ;;
      3) verify_review_runtime_image_provenance "$3" "$4" extra ;;
    esac
  ' bash "$library" "$argument_count" "$image" "$sha" >/dev/null 2>&1; then
    fail 'invalid argument count accepted'
  else
    [[ "$?" == 2 ]] || fail 'invalid argument count exit code'
  fi
  [[ ! -s "$PROVENANCE_TEST_CALLS" ]] || fail 'invalid argument count performed a lookup'
  passed=$((passed + 1))
done
printf 'PASS: %s provenance checks (fake crane only)\n' "$passed"
