#!/usr/bin/env bash
set -euo pipefail

# Bash test harness for scripts/advance-review-worker.sh.
#
# There is no existing scripts/*.test.sh precedent in this repository (the
# sibling reviewJobDispatcher tests are Vitest specs that fork the real
# deploy script with fake `kubectl`/`envsubst` binaries on PATH -- see
# tests/unit/reviewJobDispatcherDeployment.test.ts). This harness follows the
# same fake-bin-on-PATH pattern in plain bash so it can run without a Node
# toolchain: fake kubectl, curl, gh, and git binaries are written into a
# scratch bin directory, behavior is driven entirely by environment
# variables set per scenario, and every invocation is logged so assertions
# can check exactly what the script under test did (and did not) call.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_under_test="$repo_root/scripts/advance-review-worker.sh"

# Respect $TMPDIR (never hardcode /tmp -- this host's default is already a
# per-user TMPDIR, and this suite must not depend on or collide with /tmp).
suite_dir="$(mktemp -d)"
cleanup_suite() {
  rm -rf -- "$suite_dir"
}
trap cleanup_suite EXIT

fakebin_dir="$suite_dir/fakebin"
mkdir -p "$fakebin_dir"

pass_count=0
fail_count=0

report_pass() {
  pass_count=$((pass_count + 1))
  echo "PASS: $1"
}

report_fail() {
  fail_count=$((fail_count + 1))
  echo "FAIL: $1" >&2
}

assert_equal() {
  local description="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    report_pass "$description"
  else
    report_fail "$description (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local description="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    report_pass "$description"
  else
    report_fail "$description (expected to find '$needle')"
  fi
}

assert_not_contains() {
  local description="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    report_pass "$description"
  else
    report_fail "$description (did not expect to find '$needle')"
  fi
}

# --- Fixed test fixtures -----------------------------------------------------

commit_sha="$(printf '9%.0s' $(seq 1 40))"
good_digest_hex="$(printf 'c%.0s' $(seq 1 64))"
good_digest="sha256:${good_digest_hex}"
target_image="ghcr.io/review-yeti-ai/review-yeti-worker@${good_digest}"

single_arch_digest_hex="$(printf 'e%.0s' $(seq 1 64))"
single_arch_digest="sha256:${single_arch_digest_hex}"

old_digest_hex="$(printf 'a%.0s' $(seq 1 64))"
old_image="ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${old_digest_hex}"

wrong_digest_hex="$(printf 'f%.0s' $(seq 1 64))"
wrong_image="ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${wrong_digest_hex}"

dispatcher_image="ghcr.io/review-yeti-ai/review-yeti-bot@sha256:$(printf 'b%.0s' $(seq 1 64))"
pod_name="ct-review-job-dispatcher-abc123"

multi_arch_body='{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"architecture":"amd64","os":"linux"}},{"platform":{"architecture":"arm64","os":"linux"}}]}'
single_arch_body='{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"platform":{"architecture":"amd64","os":"linux"}}]}'
single_manifest_body='{"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{},"layers":[]}'

# --- Fake binaries ------------------------------------------------------------
#
# Behavior is driven by environment variables (FAKE_*) exported per scenario;
# every invocation is appended to the matching *_LOG file so assertions can
# check exactly what happened -- including that a call was never made.

cat > "$fakebin_dir/kubectl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_KUBECTL_LOG"

case "$*" in
  *"get deployment ct-review-job-dispatcher -o jsonpath={.spec.replicas}"*)
    if [[ "${FAKE_DEPLOYMENT_MISSING:-}" == "1" ]]; then
      echo "Error from server (NotFound): deployments.apps \"ct-review-job-dispatcher\" not found" >&2
      exit 1
    fi
    printf '%s' "${FAKE_REPLICAS:?FAKE_REPLICAS not set}"
    ;;
  *"get configmap ct-review-job-dispatcher -o jsonpath={.data.REVIEW_JOB_RUNNER_MODE}"*)
    printf '%s' "${FAKE_RUNNER_MODE:?FAKE_RUNNER_MODE not set}"
    ;;
  *"get configmap ct-review-job-dispatcher -o jsonpath={.data.REVIEW_JOB_WORKER_IMAGE}"*)
    printf '%s' "${FAKE_CURRENT_IMAGE:?FAKE_CURRENT_IMAGE not set}"
    ;;
  *"get deployment ct-review-job-dispatcher -o jsonpath={.spec.template.spec.containers[0].image}"*)
    printf '%s' "${FAKE_DISPATCHER_IMAGE:?FAKE_DISPATCHER_IMAGE not set}"
    ;;
  "apply --server-side --force-conflicts -f "*)
    src="${*: -1}"
    cp "$src" "$FAKE_APPLIED_MANIFEST"
    ;;
  *"rollout restart deployment/ct-review-job-dispatcher"*)
    :
    ;;
  *"rollout status deployment/ct-review-job-dispatcher --timeout="*)
    exit "${FAKE_ROLLOUT_STATUS_EXIT:-0}"
    ;;
  *"get pods -l app.kubernetes.io/name=ct-review-job-dispatcher --field-selector=status.phase=Running -o jsonpath={.items[-1:].metadata.name}"*)
    # Empty is a legitimate answer ("no running pod"); only unset is a harness bug.
    printf '%s' "${FAKE_POD_NAME?FAKE_POD_NAME not set}"
    ;;
  *"exec "*"-- sh -c"*)
    printf '%s' "${FAKE_VERIFY_IMAGE:-}"
    ;;
  *)
    echo "fake kubectl: unhandled invocation: $*" >&2
    exit 1
    ;;
esac
SHIM

cat > "$fakebin_dir/curl" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_CURL_LOG"

case "$*" in
  *"ghcr.io/token?scope="*)
    printf '{"token":"fake-ghcr-token"}'
    ;;
  "-fsSI "*)
    printf 'HTTP/1.1 200 OK\r\n'
    if [[ -z "${FAKE_NO_DIGEST_HEADER:-}" ]]; then
      printf 'Docker-Content-Digest: %s\r\n' "${FAKE_DIGEST:?FAKE_DIGEST not set}"
    fi
    printf '\r\n'
    ;;
  "-fsS "*)
    cat "${FAKE_MANIFEST_BODY_FILE:?FAKE_MANIFEST_BODY_FILE not set}"
    ;;
  *)
    echo "fake curl: unhandled invocation: $*" >&2
    exit 1
    ;;
esac
SHIM

cat > "$fakebin_dir/git" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_GIT_LOG"

case "$*" in
  "rev-parse --verify -q refs/tags/"*)
    # Default: no such local tag, so resolution falls through to the GitHub API.
    # With FAKE_LOCAL_TAG_SHA set, the tag exists locally as an ANNOTATED tag:
    # the ^{commit} peel yields the commit; the bare ref yields the tag object.
    if [[ -n "${FAKE_LOCAL_TAG_SHA:-}" ]]; then
      if [[ "$*" == *"^{commit}" ]]; then
        printf '%s\n' "$FAKE_LOCAL_TAG_SHA"
      else
        printf '%s\n' "${FAKE_LOCAL_TAG_OBJECT_SHA:?FAKE_LOCAL_TAG_OBJECT_SHA not set}"
      fi
      exit 0
    fi
    exit 1
    ;;
  *)
    echo "fake git: unhandled invocation: $*" >&2
    exit 1
    ;;
esac
SHIM

cat > "$fakebin_dir/gh" <<'SHIM'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_GH_LOG"

case "$*" in
  "api repos/review-yeti-ai/review-yeti-bot/git/ref/tags/"*)
    printf '{"object":{"type":"%s","sha":"%s"}}' \
      "${FAKE_TAG_OBJECT_TYPE:?FAKE_TAG_OBJECT_TYPE not set}" \
      "${FAKE_TAG_OBJECT_SHA:?FAKE_TAG_OBJECT_SHA not set}"
    ;;
  "api repos/review-yeti-ai/review-yeti-bot/git/tags/"*" --jq .object.sha")
    printf '%s' "${FAKE_TAG_COMMIT_SHA:?FAKE_TAG_COMMIT_SHA not set}"
    ;;
  *)
    echo "fake gh: unhandled invocation: $*" >&2
    exit 1
    ;;
esac
SHIM

chmod +x "$fakebin_dir/kubectl" "$fakebin_dir/curl" "$fakebin_dir/git" "$fakebin_dir/gh"

# --- Scenario runner ----------------------------------------------------------

run_script() {
  local scenario_dir="$1"
  shift
  local manifest_body_file="$scenario_dir/manifest-body.json"
  printf '%s' "${SCENARIO_MANIFEST_BODY:-$multi_arch_body}" > "$manifest_body_file"

  set +e
  stdout="$(
    env \
      PATH="$fakebin_dir:$PATH" \
      FAKE_KUBECTL_LOG="$scenario_dir/kubectl.log" \
      FAKE_CURL_LOG="$scenario_dir/curl.log" \
      FAKE_GIT_LOG="$scenario_dir/git.log" \
      FAKE_GH_LOG="$scenario_dir/gh.log" \
      FAKE_NO_DIGEST_HEADER="${SCENARIO_NO_DIGEST_HEADER:-}" \
      FAKE_APPLIED_MANIFEST="$scenario_dir/applied.yaml" \
      FAKE_DIGEST="${SCENARIO_DIGEST:-$good_digest}" \
      FAKE_MANIFEST_BODY_FILE="$manifest_body_file" \
      FAKE_REPLICAS="${SCENARIO_REPLICAS:-1}" \
      FAKE_RUNNER_MODE="${SCENARIO_RUNNER_MODE:-prebaked}" \
      FAKE_CURRENT_IMAGE="${SCENARIO_CURRENT_IMAGE:-$old_image}" \
      FAKE_DISPATCHER_IMAGE="$dispatcher_image" \
      FAKE_POD_NAME="${SCENARIO_POD_NAME-$pod_name}" \
      FAKE_ROLLOUT_STATUS_EXIT="${SCENARIO_ROLLOUT_STATUS_EXIT:-0}" \
      FAKE_LOCAL_TAG_SHA="${SCENARIO_LOCAL_TAG_SHA:-}" \
      FAKE_LOCAL_TAG_OBJECT_SHA="${SCENARIO_LOCAL_TAG_OBJECT_SHA:-}" \
      FAKE_VERIFY_IMAGE="${SCENARIO_VERIFY_IMAGE:-$target_image}" \
      FAKE_DEPLOYMENT_MISSING="${SCENARIO_DEPLOYMENT_MISSING:-}" \
      FAKE_TAG_OBJECT_TYPE="${SCENARIO_TAG_OBJECT_TYPE:-}" \
      FAKE_TAG_OBJECT_SHA="${SCENARIO_TAG_OBJECT_SHA:-}" \
      FAKE_TAG_COMMIT_SHA="${SCENARIO_TAG_COMMIT_SHA:-}" \
      bash "$script_under_test" "$@" 2>"$scenario_dir/stderr.log"
  )"
  status=$?
  set -e
  stderr="$(cat "$scenario_dir/stderr.log")"
  kubectl_log="$([[ -f "$scenario_dir/kubectl.log" ]] && cat "$scenario_dir/kubectl.log" || true)"
  applied_manifest="$([[ -f "$scenario_dir/applied.yaml" ]] && cat "$scenario_dir/applied.yaml" || true)"
}

new_scenario_dir() {
  mktemp -d "$suite_dir/scenario.XXXXXX"
}

# --- Scenario 1: single-arch index is refused --------------------------------

scenario_dir="$(new_scenario_dir)"
SCENARIO_MANIFEST_BODY="$single_arch_body" \
  SCENARIO_DIGEST="$single_arch_digest" \
  run_script "$scenario_dir" "$commit_sha"
assert_equal "single-arch index: exits non-zero" "1" "$status"
assert_contains "single-arch index: error explains the amd64/arm64 requirement" "$stderr" "amd64 and arm64"
assert_not_contains "single-arch index: never reaches kubectl" "$kubectl_log" "get deployment"

# --- Scenario 1b: a single image manifest (not an index) is refused ----------

scenario_dir="$(new_scenario_dir)"
SCENARIO_MANIFEST_BODY="$single_manifest_body" \
  SCENARIO_DIGEST="$single_arch_digest" \
  run_script "$scenario_dir" "$commit_sha"
assert_equal "single manifest: exits non-zero" "1" "$status"
assert_contains "single manifest: error says an index is required" "$stderr" "multi-arch index is required"
assert_not_contains "single manifest: never reaches kubectl" "$kubectl_log" "get deployment"

# --- Scenario 1c: a HEAD response without Docker-Content-Digest is refused ---

scenario_dir="$(new_scenario_dir)"
SCENARIO_NO_DIGEST_HEADER="1" \
  SCENARIO_MANIFEST_BODY="$multi_arch_body" \
  SCENARIO_DIGEST="$good_digest" \
  run_script "$scenario_dir" "$commit_sha"
assert_equal "missing digest header: exits non-zero" "1" "$status"
assert_contains "missing digest header: error names the header" "$stderr" "Docker-Content-Digest"
assert_not_contains "missing digest header: never reaches kubectl" "$kubectl_log" "get deployment"

# --- Scenario 1d: a ref with path metacharacters is refused before any call --

scenario_dir="$(new_scenario_dir)"
run_script "$scenario_dir" "../../other-repo/git/ref?x=1"
assert_equal "hostile ref: exits non-zero" "1" "$status"
assert_contains "hostile ref: error explains the allowed characters" "$stderr" "refusing ref"
curl_log="$([[ -f "$scenario_dir/curl.log" ]] && cat "$scenario_dir/curl.log" || true)"
gh_log="$([[ -f "$scenario_dir/gh.log" ]] && cat "$scenario_dir/gh.log" || true)"
assert_equal "hostile ref: no curl call was made" "" "$curl_log"
assert_equal "hostile ref: no gh call was made" "" "$gh_log"

# --- Scenario 1e: a generic-runner lane is refused ---------------------------

scenario_dir="$(new_scenario_dir)"
SCENARIO_RUNNER_MODE="generic" run_script "$scenario_dir" "$commit_sha"
assert_equal "generic runner mode: exits non-zero" "1" "$status"
assert_contains "generic runner mode: error names the expected mode" "$stderr" "REVIEW_JOB_RUNNER_MODE=prebaked"
assert_not_contains "generic runner mode: never applies" "$kubectl_log" "apply"

# --- Scenario 1f: a failed rollout status is a failure, not a pass -----------

scenario_dir="$(new_scenario_dir)"
SCENARIO_ROLLOUT_STATUS_EXIT="1" run_script "$scenario_dir" "$commit_sha"
assert_equal "rollout status failure: exits non-zero" "1" "$status"
assert_not_contains "rollout status failure: never claims verification" "$stdout" "verified"

# --- Scenario 1g: rollout ready but no running pod cannot verify --------------

scenario_dir="$(new_scenario_dir)"
SCENARIO_POD_NAME="" run_script "$scenario_dir" "$commit_sha"
assert_equal "no running pod: exits non-zero" "1" "$status"
assert_contains "no running pod: error says it cannot verify" "$stderr" "no running pod was found"

# --- Scenario 1h: a local annotated tag resolves to its commit, not the tag object

scenario_dir="$(new_scenario_dir)"
tag_object_sha="$(printf 'd%.0s' $(seq 1 40))"
SCENARIO_LOCAL_TAG_SHA="$commit_sha" \
  SCENARIO_LOCAL_TAG_OBJECT_SHA="$tag_object_sha" \
  SCENARIO_CURRENT_IMAGE="$target_image" \
  run_script "$scenario_dir" "v9.9.9"
assert_equal "local tag: exits zero (already pinned path)" "0" "$status"
gh_log="$([[ -f "$scenario_dir/gh.log" ]] && cat "$scenario_dir/gh.log" || true)"
assert_equal "local tag: the GitHub API was not consulted" "" "$gh_log"
assert_contains "local tag: the commit, not the tag object, was resolved" "$stdout" "$commit_sha"
assert_not_contains "local tag: the tag object sha never appears" "$stdout" "$tag_object_sha"

# --- Scenario 2: inactive dispatcher (replicas 0) is refused -----------------

scenario_dir="$(new_scenario_dir)"
SCENARIO_REPLICAS="0" run_script "$scenario_dir" "$commit_sha"
assert_equal "inactive dispatcher: exits non-zero" "1" "$status"
assert_contains "inactive dispatcher: points at install-doks-review-runtime.sh" "$stderr" "install-doks-review-runtime.sh"
assert_contains "inactive dispatcher: points at deploy-review-job-dispatcher.sh" "$stderr" "deploy-review-job-dispatcher.sh"
assert_not_contains "inactive dispatcher: never applies" "$kubectl_log" "apply"

# --- Scenario 2b: missing dispatcher deployment is refused -------------------

scenario_dir="$(new_scenario_dir)"
SCENARIO_DEPLOYMENT_MISSING="1" run_script "$scenario_dir" "$commit_sha"
assert_equal "missing dispatcher: exits non-zero" "1" "$status"
assert_contains "missing dispatcher: points at install-doks-review-runtime.sh" "$stderr" "install-doks-review-runtime.sh"

# --- Scenario 3: already pinned is a no-op -----------------------------------

scenario_dir="$(new_scenario_dir)"
SCENARIO_CURRENT_IMAGE="$target_image" run_script "$scenario_dir" "$commit_sha"
assert_equal "already pinned: exits zero" "0" "$status"
assert_contains "already pinned: says there is nothing to do" "$stdout" "nothing to do"
assert_not_contains "already pinned: never applies" "$kubectl_log" "apply"
assert_not_contains "already pinned: never restarts" "$kubectl_log" "rollout restart"

# --- Scenario 4: --dry-run stops before any apply ----------------------------

scenario_dir="$(new_scenario_dir)"
run_script "$scenario_dir" "$commit_sha" --dry-run
assert_equal "dry-run: exits zero" "0" "$status"
assert_contains "dry-run: says it is stopping" "$stdout" "dry-run"
assert_not_contains "dry-run: never applies" "$kubectl_log" "apply"
assert_not_contains "dry-run: never restarts" "$kubectl_log" "rollout restart"

# --- Scenario 5: happy path ---------------------------------------------------

scenario_dir="$(new_scenario_dir)"
run_script "$scenario_dir" "$commit_sha"
assert_equal "happy path: exits zero" "0" "$status"
assert_contains "happy path: applies via server-side apply --force-conflicts" "$kubectl_log" "apply --server-side --force-conflicts -f"
assert_contains "happy path: restarts the dispatcher" "$kubectl_log" "rollout restart deployment/ct-review-job-dispatcher"
assert_contains "happy path: waits on rollout status" "$kubectl_log" "rollout status deployment/ct-review-job-dispatcher --timeout="
assert_contains "happy path: applied document is a ConfigMap" "$applied_manifest" "kind: ConfigMap"
assert_not_contains "happy path: applied document carries no Deployment" "$applied_manifest" "kind: Deployment"
assert_not_contains "happy path: applied document carries no RBAC" "$applied_manifest" "kind: Role"
assert_contains "happy path: applied document carries the new digest" "$applied_manifest" "REVIEW_JOB_WORKER_IMAGE: \"$target_image\""
assert_contains "happy path: verifies the in-pod value" "$stdout" "verified pod $pod_name"

# --- Scenario 6: verification mismatch is refused ----------------------------

scenario_dir="$(new_scenario_dir)"
SCENARIO_VERIFY_IMAGE="$wrong_image" run_script "$scenario_dir" "$commit_sha"
assert_equal "verification mismatch: exits non-zero" "1" "$status"
assert_contains "verification mismatch: explains the mismatch" "$stderr" "verification failed"
assert_contains "verification mismatch: still restarted before verifying" "$kubectl_log" "rollout restart deployment/ct-review-job-dispatcher"

# --- Scenario 7: an annotated release tag resolves via the GitHub API -------

scenario_dir="$(new_scenario_dir)"
tag_object_sha="$(printf '1%.0s' $(seq 1 40))"
SCENARIO_TAG_OBJECT_TYPE="tag" \
  SCENARIO_TAG_OBJECT_SHA="$tag_object_sha" \
  SCENARIO_TAG_COMMIT_SHA="$commit_sha" \
  run_script "$scenario_dir" "v1.2.3" --dry-run
assert_equal "tag resolution: exits zero" "0" "$status"
git_log_content="$(cat "$scenario_dir/git.log" 2>/dev/null || true)"
assert_contains "tag resolution: tries the local git ref first" "$git_log_content" "rev-parse --verify -q refs/tags/v1.2.3^{commit}"
gh_log_content="$(cat "$scenario_dir/gh.log" 2>/dev/null || true)"
assert_contains "tag resolution: falls back to gh api for the ref" "$gh_log_content" "api repos/review-yeti-ai/review-yeti-bot/git/ref/tags/v1.2.3"
assert_contains "tag resolution: dereferences the annotated tag object" "$gh_log_content" "api repos/review-yeti-ai/review-yeti-bot/git/tags/$tag_object_sha --jq .object.sha"
assert_contains "tag resolution: reports the resolved commit" "$stdout" "commit $commit_sha"

# --- Summary -------------------------------------------------------------------

echo
echo "advance-review-worker.test.sh: ${pass_count} passed, ${fail_count} failed"
if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi
