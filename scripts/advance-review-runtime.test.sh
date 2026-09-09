#!/usr/bin/env bash
set -euo pipefail

# Local-only contract tests. The fake kubectl records calls and serves fixture
# JSON; no cluster credentials or provider clients are used.

script_dir="$(cd "$(dirname "$0")" && pwd)"
helper="$script_dir/advance-review-runtime.sh"
test_root="$(mktemp -d)"
fake_bin="$test_root/bin"
mkdir -p "$fake_bin"
trap 'rm -rf "$test_root"' EXIT

fake_kubectl_log="$test_root/kubectl.log"
fake_patch_file="$test_root/patch.json"
fake_after_marker="$test_root/after.marker"
before_json="$test_root/deployment-before.json"
after_json="$test_root/deployment-after.json"
configmap_json="$test_root/configmap.json"
export FAKE_KUBECTL_LOG="$fake_kubectl_log"
export FAKE_PATCH_FILE="$fake_patch_file"
export FAKE_AFTER_MARKER="$fake_after_marker"
export FAKE_BEFORE_JSON="$before_json"
export FAKE_AFTER_JSON="$after_json"
export FAKE_CONFIGMAP_JSON="$configmap_json"
export FAKE_READBACK_FAILURE=0
export FAKE_ROLLOUT_STATUS_EXIT=0
export FAKE_PATCH_FAILURE=0

cat >"$fake_bin/kubectl" <<'FAKE_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$FAKE_KUBECTL_LOG"

if [[ "$1" == "-n" && "$2" == "ct-review-system" && "$3" == "get" && "$4" == "deployment" ]]; then
  if [[ -e "$FAKE_AFTER_MARKER" && "$FAKE_READBACK_FAILURE" == "1" ]]; then
    exit 1
  fi
  cat "$([[ -e "$FAKE_AFTER_MARKER" ]] && printf '%s' "$FAKE_AFTER_JSON" || printf '%s' "$FAKE_BEFORE_JSON")"
  exit 0
fi

if [[ "$1" == "-n" && "$2" == "ct-review-system" && "$3" == "get" && "$4" == "configmap" ]]; then
  cat "$FAKE_CONFIGMAP_JSON"
  exit 0
fi

if [[ "$1" == "-n" && "$2" == "ct-review-system" && "$3" == "patch" && "$4" == "deployment" ]]; then
  patch_payload=""
  previous=""
  for argument in "$@"; do
    if [[ "$previous" == "--patch" ]]; then
      patch_payload="$argument"
    fi
    previous="$argument"
  done
  [[ -n "$patch_payload" ]] || exit 1
  printf '%s' "$patch_payload" >"$FAKE_PATCH_FILE"
  if [[ "$FAKE_PATCH_FAILURE" == "1" ]]; then
    exit 1
  fi
  touch "$FAKE_AFTER_MARKER"
  exit 0
fi

if [[ "$1" == "-n" && "$2" == "ct-review-system" && "$3" == "rollout" && "$4" == "status" ]]; then
  exit "$FAKE_ROLLOUT_STATUS_EXIT"
fi

exit 1
FAKE_KUBECTL
chmod +x "$fake_bin/kubectl"
cat >"$fake_bin/crane" <<'FAKE_CRANE'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == digest && $# == 2 ]] || exit 1
printf '%s\n' "$FAKE_PROVENANCE_DIGEST"
FAKE_CRANE
chmod +x "$fake_bin/crane"

fail() {
  echo "not ok - $*" >&2
  exit 1
}

pass() {
  echo "ok - $*"
}

assert_no_patch() {
  [[ ! -e "$fake_patch_file" ]] || fail "unexpected Kubernetes patch"
}

assert_no_receipt() {
  [[ ! -e "$1" ]] || fail "unexpected receipt: $1"
}

reset_fake() {
  rm -f "$fake_after_marker" "$fake_patch_file"
  : >"$fake_kubectl_log"
  FAKE_READBACK_FAILURE=0
  FAKE_ROLLOUT_STATUS_EXIT=0
  FAKE_PATCH_FAILURE=0
  export FAKE_READBACK_FAILURE FAKE_ROLLOUT_STATUS_EXIT FAKE_PATCH_FAILURE
}

write_deployment() {
  local path="$1"
  local image="$2"
  local resource_version="$3"
  local generation="$4"
  local uid="$5"
  local deployment_name="$6"
  local container_name="$7"

  jq -nS \
    --arg image "$image" \
    --arg resourceVersion "$resource_version" \
    --arg uid "$uid" \
    --arg deployment "$deployment_name" \
    --arg container "$container_name" \
    --argjson generation "$generation" \
    '{
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: $deployment,
        namespace: "ct-review-system",
        uid: $uid,
        resourceVersion: $resourceVersion,
        generation: $generation,
        labels: {app: "review-yeti"},
        annotations: {
          "deployment.kubernetes.io/revision": "11",
          "review-yeti.example/owned": "keep"
        }
      },
      spec: {
        replicas: 1,
        selector: {matchLabels: {app: "review-yeti"}},
        template: {
          metadata: {labels: {app: "review-yeti"}},
          spec: {
            serviceAccountName: "review-yeti-runtime",
            imagePullSecrets: [{name: "registry-pull"}],
            containers: [{
              name: $container,
              image: $image,
              env: [
                {name: "DATABASE_URL", valueFrom: {secretKeyRef: {name: "review-yeti-runtime", key: "DATABASE_URL"}}},
                {name: "GITHUB_APP_ID", valueFrom: {secretKeyRef: {name: "review-yeti-runtime", key: "GITHUB_APP_ID"}}},
                {name: "LOG_LEVEL", value: "info"}
              ],
              resources: {requests: {cpu: "100m", memory: "128Mi"}},
              securityContext: {runAsNonRoot: true}
            }]
          }
        }
      },
      status: {observedGeneration: $generation, readyReplicas: 1}
    }' >"$path"
}

write_configmap() {
  jq -nS \
    --arg workerImage "$WORKER_IMAGE" \
    '{
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "ct-review-job-dispatcher",
        namespace: "ct-review-system",
        uid: "configmap-uid-1",
        resourceVersion: "23",
        generation: 1,
        labels: {app: "review-yeti"},
        annotations: {"review-yeti.example/owned": "keep"}
      },
      data: {
        REVIEW_JOB_RUNNER_MODE: "prebaked",
        REVIEW_JOB_WORKER_IMAGE: $workerImage
      }
    }' >"$configmap_json"
}

run_helper() {
  PATH="$fake_bin:$PATH" "$helper" "$@"
}

dispatcher_old="ghcr.io/review-yeti-ai/review-yeti-bot@sha256:5b3c4bbf7f08a582acdb4469701c70248d61b4d6fa6a7eb58d695a08b8909cee"
dispatcher_new="ghcr.io/review-yeti-ai/review-yeti-bot@sha256:81e629bf9e7aca11f140d926113f669d2d4ad2a2822fb47b5afac097ca751d65"
operator_old="ghcr.io/review-yeti-ai/review-yeti-operator@sha256:40dba5823563e5c453f49f5ac2857f3fd8a79e33e439e2f7a263a2064692dc95"
operator_new="ghcr.io/review-yeti-ai/review-yeti-operator@sha256:26cf06de3ea223970959b7a0b25e77c9f6042afb09c77b77e7d9f537833a0d62"
worker_image="ghcr.io/review-yeti-ai/review-yeti-worker@sha256:7a48bd8cea81a5aafac4df5f08c42fc6d6d06b1debcac4b20f12b707136e6b1d"
source_sha="0017baa9cf0b653ae97c2d7b5b33e5c6bc6996ae"
export WORKER_IMAGE="$worker_image"

prepare_dispatcher() {
  export FAKE_PROVENANCE_DIGEST="${dispatcher_new##*@}"
  write_deployment "$before_json" "$dispatcher_old" "17" 4 "deployment-uid-1" \
    "ct-review-job-dispatcher" "review-job-dispatcher"
  write_deployment "$after_json" "$dispatcher_new" "18" 5 "deployment-uid-1" \
    "ct-review-job-dispatcher" "review-job-dispatcher"
  write_configmap
  reset_fake
}

prepare_operator() {
  export FAKE_PROVENANCE_DIGEST="${operator_new##*@}"
  write_deployment "$before_json" "$operator_old" "31" 7 "operator-uid-1" \
    "ct-review-yeti-operator" "operator"
  write_deployment "$after_json" "$operator_new" "32" 8 "operator-uid-1" \
    "ct-review-yeti-operator" "operator"
  write_configmap
  reset_fake
}

prepare_dispatcher

invalid_receipt="$test_root/invalid.json"
if run_helper --component dispatcher \
  --expected-current-image "$dispatcher_old" \
  --expected-uid deployment-uid-1 \
  --expected-resource-version 17 \
  --target-image "ghcr.io/example/untrusted@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  --source-sha "$source_sha" \
  --apply --receipt "$invalid_receipt" >/dev/null 2>&1; then
  fail "untrusted target was accepted"
fi
assert_no_patch
assert_no_receipt "$invalid_receipt"
pass "rejects an untrusted target before any Kubernetes write"

prepare_dispatcher
stale_receipt="$test_root/stale.json"
if run_helper --component dispatcher \
  --expected-current-image "$dispatcher_old" \
  --expected-uid wrong-deployment-uid \
  --expected-resource-version 17 \
  --target-image "$dispatcher_new" \
  --source-sha "$source_sha" \
  --apply --receipt "$stale_receipt" >/dev/null 2>&1; then
  fail "stale UID was accepted"
fi
assert_no_patch
assert_no_receipt "$stale_receipt"
pass "rejects a stale UID without writing"

prepare_dispatcher
plan_receipt="$test_root/plan.json"
plan_output="$(run_helper --component dispatcher --expected-current-image "$dispatcher_old" --expected-uid deployment-uid-1 --expected-resource-version 17 --target-image "$dispatcher_new" --source-sha "$source_sha" --receipt "$plan_receipt")"
printf '%s\n' "$plan_output" | jq -e '.mode == "plan" and .deployment == "ct-review-job-dispatcher"' >/dev/null
assert_no_patch
assert_no_receipt "$plan_receipt"
pass "defaults to a read-only plan"

prepare_dispatcher
upgrade_receipt="$test_root/upgrade.json"
run_helper --component dispatcher \
  --expected-current-image "$dispatcher_old" \
  --expected-uid deployment-uid-1 \
  --expected-resource-version 17 \
  --target-image "$dispatcher_new" \
  --source-sha "$source_sha" \
  --apply --receipt "$upgrade_receipt" >/dev/null
jq -e \
  --arg worker "$worker_image" \
  --arg source "$source_sha" \
  '.operation == "upgrade"
   and .status == "applied"
   and .rollbackEligible == true
   and .deployment == "ct-review-job-dispatcher"
   and .patchPath == "/spec/template/spec/containers/0/image"
   and .reviewedSourceSha == $source
   and .before.workerConfigMap.runnerMode == "prebaked"
   and .before.workerConfigMap.workerImage == $worker
   and (. | tostring | contains("SECRET_VALUE") | not)' \
  "$upgrade_receipt" >/dev/null
jq -e \
  --arg old "$dispatcher_old" \
  --arg new "$dispatcher_new" \
  'length == 5
   and .[0] == {op: "test", path: "/metadata/uid", value: "deployment-uid-1"}
   and .[1].path == "/metadata/resourceVersion"
   and .[2].path == "/metadata/generation"
   and .[3].path == "/spec/template/spec/containers/0/image"
   and .[3].value == $old
   and .[4] == {op: "replace", path: "/spec/template/spec/containers/0/image", value: $new}' \
  "$fake_patch_file" >/dev/null
grep -q -- "patch deployment ct-review-job-dispatcher" "$fake_kubectl_log"
if grep -q -- "--force-conflicts" "$fake_kubectl_log"; then
  fail "patch unexpectedly used force-conflicts"
fi
if grep -q -- " apply " "$fake_kubectl_log"; then
  fail "patch unexpectedly used apply"
fi
pass "writes only the selected dispatcher image and records the worker ConfigMap"

prepare_dispatcher
readback_receipt="$test_root/readback.json"
export FAKE_READBACK_FAILURE=1
if run_helper --component dispatcher \
  --expected-current-image "$dispatcher_old" \
  --expected-uid deployment-uid-1 \
  --expected-resource-version 17 \
  --target-image "$dispatcher_new" \
  --source-sha "$source_sha" \
  --apply --receipt "$readback_receipt" >"$test_root/readback.out" 2>&1; then
  fail "readback failure was reported as success"
fi
export FAKE_READBACK_FAILURE=0
[[ -s "$fake_patch_file" ]] || fail "readback failure did not show the attempted narrow write"
assert_no_receipt "$readback_receipt"
grep -q -- "no success claimed" "$test_root/readback.out"
jq -e '.status == "intent" and .afterObserved == false and .rollbackEligible == true' "${readback_receipt}.intent" >/dev/null
pass "retains an immutable unconfirmed intent when post-write readback fails"

write_deployment "$before_json" "$dispatcher_new" "19" 5 "deployment-uid-1" \
  "ct-review-job-dispatcher" "review-job-dispatcher"
write_deployment "$after_json" "$dispatcher_old" "20" 6 "deployment-uid-1" \
  "ct-review-job-dispatcher" "review-job-dispatcher"
reset_fake
run_helper --rollback "${readback_receipt}.intent" --apply --receipt "$test_root/recovered-intent.json" >/dev/null
jq -e --arg image "$dispatcher_old" '.after.image == $image and .status == "applied"' "$test_root/recovered-intent.json" >/dev/null
pass "recovers a lost readback only after verifying the intent against live identity"

prepare_dispatcher
rollout_receipt="$test_root/rollout-failed.json"
export FAKE_ROLLOUT_STATUS_EXIT=1
if run_helper --component dispatcher \
  --expected-current-image "$dispatcher_old" \
  --expected-uid deployment-uid-1 \
  --expected-resource-version 17 \
  --target-image "$dispatcher_new" \
  --source-sha "$source_sha" \
  --apply --receipt "$rollout_receipt" >"$test_root/rollout.out" 2>&1; then
  fail "rollout failure was reported as success"
fi
export FAKE_ROLLOUT_STATUS_EXIT=0
jq -e '.status == "rollout_failed" and .rollbackEligible == true' "$rollout_receipt" >/dev/null
grep -q -- "rollout failed" "$test_root/rollout.out"
if grep -q -- "image updated and receipt written" "$test_root/rollout.out"; then
  fail "rollout failure was reported with success text"
fi
pass "records rollout failure without claiming a successful upgrade"

prepare_dispatcher
rollback_receipt="$test_root/rollback-source.json"
run_helper --component dispatcher \
  --expected-current-image "$dispatcher_old" \
  --expected-uid deployment-uid-1 \
  --expected-resource-version 17 \
  --target-image "$dispatcher_new" \
  --source-sha "$source_sha" \
  --apply --receipt "$rollback_receipt" >/dev/null
write_deployment "$before_json" "$dispatcher_new" "19" 6 "deployment-uid-1" \
  "ct-review-job-dispatcher" "review-job-dispatcher"
reset_fake
stale_rollback_receipt="$test_root/rollback-stale.json"
if run_helper --rollback "$rollback_receipt" --apply --receipt "$stale_rollback_receipt" >/dev/null 2>&1; then
  fail "stale rollback generation was accepted"
fi
assert_no_patch
assert_no_receipt "$stale_rollback_receipt"
pass "rejects rollback after a concurrent same-image generation change"

write_deployment "$before_json" "$dispatcher_new" "19" 5 "deployment-uid-1" \
  "ct-review-job-dispatcher" "review-job-dispatcher"
write_deployment "$after_json" "$dispatcher_old" "20" 6 "deployment-uid-1" \
  "ct-review-job-dispatcher" "review-job-dispatcher"
reset_fake
rollback_result="$test_root/rollback-result.json"
run_helper --rollback "$rollback_receipt" --apply --receipt "$rollback_result" >/dev/null
jq -e \
  --arg old "$dispatcher_old" \
  '.operation == "rollback"
   and .status == "applied"
   and .rollbackEligible == false
   and .after.image == $old' \
  "$rollback_result" >/dev/null
pass "performs a receipt-bound rollback despite harmless controller status revision changes"

prepare_operator
operator_plan="$(run_helper --component operator \
  --expected-current-image "$operator_old" \
  --expected-uid operator-uid-1 \
  --expected-resource-version 31 \
  --target-image "$operator_new" \
  --source-sha "$source_sha")"
printf '%s\n' "$operator_plan" | jq -e \
  '.deployment == "ct-review-yeti-operator"
   and .container == "operator"
   and .operation == "upgrade"' >/dev/null
assert_no_patch
pass "targets the exact active operator Deployment and container"

prepare_dispatcher
FAKE_PROVENANCE_DIGEST="sha256:$(printf '%064d' 0)"
export FAKE_PROVENANCE_DIGEST
if run_helper --component dispatcher --expected-current-image "$dispatcher_old" --expected-uid deployment-uid-1 \
  --expected-resource-version 17 --target-image "$dispatcher_new" --source-sha "$source_sha" \
  --apply --receipt "$test_root/mismatched-source.json" >/dev/null 2>&1; then
  fail "unproven source/image mapping was accepted"
fi
assert_no_patch
assert_no_receipt "$test_root/mismatched-source.json.intent"
pass "rejects an image that does not match the source-SHA tag before writing"

prepare_dispatcher
printf '%s\n' 'existing receipt' >"$test_root/occupied.json.intent"
if run_helper --component dispatcher --expected-current-image "$dispatcher_old" --expected-uid deployment-uid-1 \
  --expected-resource-version 17 --target-image "$dispatcher_new" --source-sha "$source_sha" \
  --apply --receipt "$test_root/occupied.json" >/dev/null 2>&1; then
  fail "existing intent was overwritten"
fi
assert_no_patch
[[ "$(cat "$test_root/occupied.json.intent")" == 'existing receipt' ]] || fail 'prior intent changed'
pass "never overwrites an existing recovery intent"

prepare_dispatcher
write_deployment "$before_json" "$dispatcher_old" "17" 4 "api-uid-1" "ct-review-action-dispatch" "action-dispatch"
write_deployment "$after_json" "$dispatcher_new" "18" 5 "api-uid-1" "ct-review-action-dispatch" "action-dispatch"
jq '.spec.replicas=2 | .status.readyReplicas=2' "$before_json" >"$test_root/api-before.json"
jq '.spec.replicas=2 | .status.readyReplicas=2' "$after_json" >"$test_root/api-after.json"
export FAKE_BEFORE_JSON="$test_root/api-before.json" FAKE_AFTER_JSON="$test_root/api-after.json"
run_helper --component api --expected-current-image "$dispatcher_old" --expected-uid api-uid-1 \
  --expected-resource-version 17 --target-image "$dispatcher_new" --source-sha "$source_sha" \
  --apply --receipt "$test_root/api-upgrade.json" >/dev/null
jq -e '.deployment == "ct-review-action-dispatch" and .container == "action-dispatch" and .after.replicas == "2"' "$test_root/api-upgrade.json" >/dev/null
pass "updates only the actual API service image and preserves its two replicas"

echo "advance-review-runtime focused tests: PASS"
