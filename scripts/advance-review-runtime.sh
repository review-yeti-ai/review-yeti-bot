#!/usr/bin/env bash
set -euo pipefail

# Advance exactly one active Review Yeti runtime Deployment image through a
# compare-and-swap JSON patch. This is deliberately separate from the inert
# installer and dispatcher manifest paths: it owns one image field only.
#
# Usage:
#   scripts/advance-review-runtime.sh \
#     --component api|dispatcher|operator \
#     --expected-current-image <trusted-image@sha256:digest> \
#     --expected-uid <deployment-uid> \
#     --expected-resource-version <resource-version> \
#     --target-image <trusted-image@sha256:digest> \
#     --source-sha <reviewed-40-hex-source-sha> \
#     [--receipt <path>] [--apply]
#
# Rollback is bounded to a receipt produced by this script:
#   scripts/advance-review-runtime.sh --rollback <receipt> \
#     --receipt <new-receipt> --apply

namespace="ct-review-system"
field_manager="review-yeti-runtime-upgrade"
rollout_timeout="${REVIEW_RUNTIME_ROLLOUT_TIMEOUT:-3m}"
receipt_schema="review-yeti-runtime-receipt.v1"
# shellcheck source=scripts/lib/review-runtime-image-provenance.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/review-runtime-image-provenance.sh"

usage() {
  cat >&2 <<'USAGE'
usage:
  advance-review-runtime.sh --component api|dispatcher|operator \
    --expected-current-image <trusted-image@sha256:digest> \
    --expected-uid <deployment-uid> \
    --expected-resource-version <resource-version> \
    --target-image <trusted-image@sha256:digest> \
    --source-sha <reviewed-40-hex-source-sha> \
    [--receipt <path>] [--apply]

  advance-review-runtime.sh --rollback <receipt> \
    [--receipt <new-receipt>] [--apply]

The default is a read-only plan. --apply is required for a Kubernetes write.
USAGE
}

die() {
  echo "advance-review-runtime: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

need kubectl
need jq
need date

if command -v shasum >/dev/null 2>&1; then
  hash_command="shasum"
elif command -v sha256sum >/dev/null 2>&1; then
  hash_command="sha256sum"
else
  die "missing required command: shasum or sha256sum"
fi

is_digest() {
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]
}

is_source_sha() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]]
}

trusted_image() {
  local component="$1"
  local image="$2"
  local digest="${image##*@}"
  is_digest "$digest" || return 1
  case "$component" in
    api|dispatcher)
      [[ "$image" == "ghcr.io/review-yeti-ai/review-yeti-bot@$digest" || "$image" == "registry.digitalocean.com/calltelemetry/ct-review-bot@$digest" ]]
      return $?
      ;;
    operator)
      [[ "$image" == "ghcr.io/review-yeti-ai/review-yeti-operator@$digest" || "$image" == "registry.digitalocean.com/calltelemetry/review-yeti-operator@$digest" ]]
      return $?
      ;;
  esac
  return 1
}

hash_stream() {
  if [[ "$hash_command" == "shasum" ]]; then
    shasum -a 256 | awk '{print $1}'
  else
    sha256sum | awk '{print $1}'
  fi
}

component_details() {
  case "$component" in
    api)
      deployment_name="ct-review-action-dispatch"
      container_name="action-dispatch"
      ;;
    dispatcher)
      deployment_name="ct-review-job-dispatcher"
      container_name="review-job-dispatcher"
      ;;
    operator)
      deployment_name="ct-review-yeti-operator"
      container_name="operator"
      ;;
    *)
      die "component must be api, dispatcher or operator"
      ;;
  esac
}

deployment_identity() {
  kubectl -n "$namespace" get deployment "$deployment_name" -o json |
    jq -c --arg container "$container_name" '
      [ .spec.template.spec.containers[]? | select(.name == $container) ] as $matches |
      {uid: (.metadata.uid // ""),
       resourceVersion: (.metadata.resourceVersion // ""),
       generation: (.metadata.generation // 0),
       replicas: (.spec.replicas // 0),
       matchingContainers: ($matches | length),
       containerIndex: (([.spec.template.spec.containers[]?.name] | index($container)) // -1),
       image: ($matches[0].image // "")}'
}

deployment_protected_hash() {
  # Hash the declared Deployment shape with only the selected image omitted.
  # Values are consumed by the digest process and never printed or persisted.
  kubectl -n "$namespace" get deployment "$deployment_name" -o json |
    jq -cS --arg container "$container_name" '
      del(.status, .metadata.uid, .metadata.resourceVersion,
          .metadata.generation, .metadata.creationTimestamp,
          .metadata.managedFields)
      | .metadata.annotations = ((.metadata.annotations // {}) |
          del(.[ "deployment.kubernetes.io/revision" ]))
      | .spec.template.spec.containers |= map(
          if .name == $container then del(.image) else . end
        )' |
    hash_stream
}

configmap_identity() {
  kubectl -n "$namespace" get configmap ct-review-job-dispatcher -o json |
    jq -c '{uid: (.metadata.uid // ""),
            resourceVersion: (.metadata.resourceVersion // ""),
            generation: (.metadata.generation // 0),
            runnerMode: (.data.REVIEW_JOB_RUNNER_MODE // ""),
            workerImage: (.data.REVIEW_JOB_WORKER_IMAGE // "")}'
}

configmap_protected_hash() {
  # The worker ConfigMap is not written by this helper. Hash all declared
  # ConfigMap data and its user metadata without retaining it in a receipt.
  kubectl -n "$namespace" get configmap ct-review-job-dispatcher -o json |
    jq -cS '{metadata: {labels: (.metadata.labels // {}),
                        annotations: (.metadata.annotations // {})},
             data: (.data // {})}' |
    hash_stream
}

read_snapshot() {
  local identity config_identity
  identity="$(deployment_identity)" || return 1
  config_identity="$(configmap_identity)" || return 1

  deployment_uid="$(jq -r '.uid' <<<"$identity")"
  deployment_resource_version="$(jq -r '.resourceVersion' <<<"$identity")"
  deployment_generation="$(jq -r '.generation' <<<"$identity")"
  deployment_replicas="$(jq -r '.replicas' <<<"$identity")"
  deployment_matching_containers="$(jq -r '.matchingContainers' <<<"$identity")"
  deployment_container_index="$(jq -r '.containerIndex' <<<"$identity")"
  deployment_image="$(jq -r '.image' <<<"$identity")"
  deployment_protected_hash="$(deployment_protected_hash)" || return 1

  configmap_uid="$(jq -r '.uid' <<<"$config_identity")"
  configmap_resource_version="$(jq -r '.resourceVersion' <<<"$config_identity")"
  configmap_generation="$(jq -r '.generation' <<<"$config_identity")"
  configmap_runner_mode="$(jq -r '.runnerMode' <<<"$config_identity")"
  configmap_worker_image="$(jq -r '.workerImage' <<<"$config_identity")"
  configmap_protected_hash="$(configmap_protected_hash)" || return 1
}

validate_snapshot() {
  [[ -n "$deployment_uid" && -n "$deployment_resource_version" ]] || die "deployment identity is incomplete"
  [[ "$deployment_matching_containers" == "1" && "$deployment_container_index" =~ ^[0-9]+$ ]] ||
    die "deployment ${deployment_name} must contain exactly one ${container_name} container"
  [[ "$deployment_replicas" =~ ^[0-9]+$ && "$deployment_replicas" -gt 0 ]] ||
    die "deployment ${deployment_name} is not active (replicas=${deployment_replicas})"
  [[ "$configmap_uid" != "" && "$configmap_resource_version" != "" ]] ||
    die "worker ConfigMap identity is incomplete"
}

snapshot_json() {
  jq -cn \
    --arg uid "$deployment_uid" \
    --arg resourceVersion "$deployment_resource_version" \
    --arg generation "$deployment_generation" \
    --arg replicas "$deployment_replicas" \
    --arg image "$deployment_image" \
    --arg protectedHash "$deployment_protected_hash" \
    --arg configUid "$configmap_uid" \
    --arg configResourceVersion "$configmap_resource_version" \
    --arg configGeneration "$configmap_generation" \
    --arg runnerMode "$configmap_runner_mode" \
    --arg workerImage "$configmap_worker_image" \
    --arg configProtectedHash "$configmap_protected_hash" \
    '{uid: $uid,
      resourceVersion: $resourceVersion,
      generation: $generation,
      replicas: $replicas,
      image: $image,
      protectedHash: $protectedHash,
      workerConfigMap: {
        name: "ct-review-job-dispatcher",
        uid: $configUid,
        resourceVersion: $configResourceVersion,
        generation: $configGeneration,
        runnerMode: $runnerMode,
        workerImage: $workerImage,
        protectedHash: $configProtectedHash
      }}'
}

compare_configmap_snapshot() {
  local expected_json="$1"
  [[ "$configmap_uid" == "$(jq -r '.uid' <<<"$expected_json")" ]] || return 1
  [[ "$configmap_resource_version" == "$(jq -r '.resourceVersion' <<<"$expected_json")" ]] || return 1
  [[ "$configmap_generation" == "$(jq -r '.generation' <<<"$expected_json")" ]] || return 1
  [[ "$configmap_runner_mode" == "$(jq -r '.runnerMode' <<<"$expected_json")" ]] || return 1
  [[ "$configmap_worker_image" == "$(jq -r '.workerImage' <<<"$expected_json")" ]] || return 1
  [[ "$configmap_protected_hash" == "$(jq -r '.protectedHash' <<<"$expected_json")" ]] || return 1
}

compare_deployment_protected_shape() {
  local expected_hash="$1"
  [[ "$deployment_protected_hash" == "$expected_hash" ]]
}

ensure_receipt_path_is_new() {
  [[ -n "$receipt_path" ]] || die "--receipt is required with --apply"
  [[ ! -e "$receipt_path" && ! -L "$receipt_path" ]] || die "receipt path already exists: $receipt_path"
  local parent_dir
  parent_dir="$(dirname "$receipt_path")"
  [[ -d "$parent_dir" ]] || die "receipt parent directory does not exist: $parent_dir"
}

write_receipt() {
  local operation="$1"
  local status="$2"
  local rollback_eligible="$3"
  local rollback_of="$4"
  local source_sha_value="$5"
  local before_json="$6"
  local after_json="$7"
  local destination="${8:-$receipt_path}"
  local receipt_id timestamp

  receipt_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! (umask 077; set -o noclobber; jq -n \
    --arg schema "$receipt_schema" \
    --arg receiptId "$receipt_id" \
    --arg timestamp "$timestamp" \
    --arg operation "$operation" \
    --arg status "$status" \
    --arg namespace "$namespace" \
    --arg component "$component" \
    --arg deployment "$deployment_name" \
    --arg container "$container_name" \
    --arg sourceSha "$source_sha_value" \
    --arg rollbackOf "$rollback_of" \
    --arg patchPath "$patch_path" \
    --argjson rollbackEligible "$rollback_eligible" \
    --argjson before "$before_json" \
    --argjson after "$after_json" \
    '{schema: $schema,
      receiptId: $receiptId,
      capturedAt: $timestamp,
      operation: $operation,
      status: $status,
      afterObserved: ($status != "intent"),
      rollbackEligible: $rollbackEligible,
      rollbackOf: (if $rollbackOf == "" then null else $rollbackOf end),
      namespace: $namespace,
      component: $component,
      deployment: $deployment,
      container: $container,
      reviewedSourceSha: (if $sourceSha == "" then null else $sourceSha end),
      patchPath: $patchPath,
      before: $before,
      after: $after}' >"$destination"); then
    return 1
  fi
}

write_intent() {
  local operation="$1" intended_image="$2" eligible="$3" rollback_of="${4:-}"
  local proposed_after
  proposed_after="$(jq -c --arg image "$intended_image" '
    .image = $image | .generation = ((.generation | tonumber) + 1 | tostring)
    | .resourceVersion = null' <<<"$before_json")"
  patch_path="/spec/template/spec/containers/$deployment_container_index/image"
  write_receipt "$operation" "intent" "$eligible" "$rollback_of" "$reviewed_source_sha" "$before_json" "$proposed_after" "${receipt_path}.intent" ||
    die "could not persist a new recovery intent; no image update attempted"
}

print_plan() {
  local operation="$1"
  local target_image_value="$2"
  local source_sha_value="$3"
  local before_json="$4"
  local rollback_of="$5"
  jq -n \
    --arg operation "$operation" \
    --arg namespace "$namespace" \
    --arg component "$component" \
    --arg deployment "$deployment_name" \
    --arg container "$container_name" \
    --arg targetImage "$target_image_value" \
    --arg sourceSha "$source_sha_value" \
    --arg receipt "$receipt_path" \
    --arg rollbackOf "$rollback_of" \
    --argjson before "$before_json" \
    '{mode: "plan",
      operation: $operation,
      namespace: $namespace,
      component: $component,
      deployment: $deployment,
      container: $container,
      expectedTargetImage: $targetImage,
      reviewedSourceSha: (if $sourceSha == "" then null else $sourceSha end),
      receiptPath: (if $receipt == "" then null else $receipt end),
      rollbackOf: (if $rollbackOf == "" then null else $rollbackOf end),
      before: $before}'
}

patch_image() {
  local expected_uid="$1"
  local expected_resource_version="$2"
  local expected_generation="$3"
  local expected_image="$4"
  local target_image_value="$5"
  local container_index="$6"
  local patch path

  path="/spec/template/spec/containers/$container_index/image"
  patch_path="$path"
  patch="$(jq -cn \
    --arg uid "$expected_uid" \
    --arg resourceVersion "$expected_resource_version" \
    --arg generation "$expected_generation" \
    --arg currentImage "$expected_image" \
    --arg targetImage "$target_image_value" \
    --arg path "$path" \
    '[{op: "test", path: "/metadata/uid", value: $uid},
      {op: "test", path: "/metadata/resourceVersion", value: $resourceVersion},
      {op: "test", path: "/metadata/generation", value: ($generation | tonumber)},
      {op: "test", path: $path, value: $currentImage},
      {op: "replace", path: $path, value: $targetImage}]')"

  kubectl -n "$namespace" patch deployment "$deployment_name" \
    --type=json \
    --field-manager="$field_manager" \
    --patch "$patch"
}

rollout_and_readback() {
  rollout_status="applied"
  if ! kubectl -n "$namespace" rollout status "deployment/${deployment_name}" --timeout="$rollout_timeout"; then
    rollout_status="rollout_failed"
    echo "advance-review-runtime: rollout failed for ${deployment_name}; no success claimed" >&2
  fi

  if ! read_snapshot; then
    echo "advance-review-runtime: post-write readback failed for ${deployment_name}; no success claimed. Retain the pre-write intent at ${receipt_path}.intent for identity-checked recovery." >&2
    exit 1
  fi
}

parse_args() {
  mode="upgrade"
  apply="0"
  component=""
  expected_current_image=""
  expected_uid=""
  expected_resource_version=""
  target_image=""
  reviewed_source_sha=""
  receipt_path=""
  rollback_receipt=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --component)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        component="$2"
        shift 2
        ;;
      --expected-current-image)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        expected_current_image="$2"
        shift 2
        ;;
      --expected-uid)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        expected_uid="$2"
        shift 2
        ;;
      --expected-resource-version)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        expected_resource_version="$2"
        shift 2
        ;;
      --target-image)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        target_image="$2"
        shift 2
        ;;
      --source-sha)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        reviewed_source_sha="$2"
        shift 2
        ;;
      --receipt)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        receipt_path="$2"
        shift 2
        ;;
      --rollback)
        [[ $# -ge 2 ]] || { usage; exit 2; }
        mode="rollback"
        rollback_receipt="$2"
        shift 2
        ;;
      --apply)
        apply="1"
        shift
        ;;
      -h|--help)
        usage >&1
        exit 0
        ;;
      *)
        usage
        exit 2
        ;;
    esac
  done
}

upgrade() {
  component_details
  is_digest "${expected_current_image##*@}" || die "expected current image must be a lowercase digest-pinned image"
  trusted_image "$component" "$expected_current_image" || die "expected current image is not trusted for ${component}"
  is_digest "${target_image##*@}" || die "target image must be a lowercase digest-pinned image"
  trusted_image "$component" "$target_image" || die "target image is not trusted for ${component}"
  is_source_sha "$reviewed_source_sha" || die "source SHA must be exactly 40 hexadecimal characters"
  [[ "$expected_uid" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "expected UID is invalid"
  [[ "$expected_resource_version" =~ ^[0-9]+$ ]] || die "expected resourceVersion is invalid"
  verify_review_runtime_image_provenance "$target_image" "$reviewed_source_sha" || die "target image/source provenance could not be verified"

  read_snapshot || die "could not read active ${deployment_name} and worker ConfigMap"
  validate_snapshot
  [[ "$deployment_uid" == "$expected_uid" ]] || die "stale target: deployment UID changed"
  [[ "$deployment_resource_version" == "$expected_resource_version" ]] || die "stale target: deployment resourceVersion changed"
  [[ "$deployment_image" == "$expected_current_image" ]] || die "stale target: current image does not match expected image"

  before_json="$(snapshot_json)"
  if [[ "$deployment_image" == "$target_image" ]]; then
    print_plan "upgrade-noop" "$target_image" "$reviewed_source_sha" "$before_json" ""
    return 0
  fi

  if [[ "$apply" != "1" ]]; then
    print_plan "upgrade" "$target_image" "$reviewed_source_sha" "$before_json" ""
    return 0
  fi

  ensure_receipt_path_is_new
  write_intent "upgrade" "$target_image" "true"
  patch_image "$deployment_uid" "$deployment_resource_version" "$deployment_generation" "$deployment_image" "$target_image" "$deployment_container_index" ||
    die "image patch was rejected or its outcome is uncertain; retain ${receipt_path}.intent for read-only reconciliation"

  rollout_and_readback
  [[ "$deployment_uid" == "$(jq -r '.uid' <<<"$before_json")" ]] || die "post-write UID changed; refusing receipt"
  [[ "$deployment_image" == "$target_image" ]] || die "post-write image readback does not match target"
  [[ "$deployment_replicas" == "$(jq -r '.replicas' <<<"$before_json")" ]] || die "post-write replicas changed; refusing receipt"
  compare_deployment_protected_shape "$(jq -r '.protectedHash' <<<"$before_json")" || die "post-write Deployment shape changed outside the image field"
  compare_configmap_snapshot "$(jq -c '.workerConfigMap' <<<"$before_json")" || die "worker ConfigMap changed during upgrade"

  after_json="$(snapshot_json)"
  if ! write_receipt "upgrade" "$rollout_status" "true" "" "$reviewed_source_sha" "$before_json" "$after_json"; then
    die "image upgrade completed but the immutable receipt could not be written"
  fi

  if [[ "$rollout_status" == "rollout_failed" ]]; then
    echo "advance-review-runtime: receipt written with status=rollout_failed at ${receipt_path}" >&2
    return 1
  fi
  echo "advance-review-runtime: ${deployment_name} image updated and receipt written at ${receipt_path}"
}

rollback() {
  [[ -f "$rollback_receipt" ]] || die "rollback receipt does not exist: $rollback_receipt"
  jq -e . "$rollback_receipt" >/dev/null || die "rollback receipt is not valid JSON"
  [[ "$(jq -r '.schema // empty' "$rollback_receipt")" == "$receipt_schema" ]] || die "rollback receipt schema is unsupported"
  [[ "$(jq -r '.operation // empty' "$rollback_receipt")" == "upgrade" ]] || die "rollback accepts only an upgrade receipt"
  jq -e '.rollbackEligible == true' "$rollback_receipt" >/dev/null || die "rollback receipt is not eligible"

  namespace_in_receipt="$(jq -r '.namespace // empty' "$rollback_receipt")"
  component="$(jq -r '.component // empty' "$rollback_receipt")"
  component_details
  [[ "$namespace_in_receipt" == "$namespace" ]] || die "rollback receipt namespace is not ${namespace}"
  [[ "$(jq -r '.deployment // empty' "$rollback_receipt")" == "$deployment_name" ]] || die "rollback receipt deployment is not ${deployment_name}"
  [[ "$(jq -r '.container // empty' "$rollback_receipt")" == "$container_name" ]] || die "rollback receipt container is not ${container_name}"

  receipt_id="$(jq -r '.receiptId // empty' "$rollback_receipt")"
  receipt_uid="$(jq -r '.after.uid // empty' "$rollback_receipt")"
  receipt_after_generation="$(jq -r '.after.generation // empty' "$rollback_receipt")"
  receipt_after_replicas="$(jq -r '.after.replicas // empty' "$rollback_receipt")"
  receipt_after_image="$(jq -r '.after.image // empty' "$rollback_receipt")"
  receipt_after_hash="$(jq -r '.after.protectedHash // empty' "$rollback_receipt")"
  rollback_image="$(jq -r '.before.image // empty' "$rollback_receipt")"
  receipt_after_configmap="$(jq -c '.after.workerConfigMap // empty' "$rollback_receipt")"
  trusted_image "$component" "$receipt_after_image" || die "rollback receipt target image is not trusted"
  trusted_image "$component" "$rollback_image" || die "rollback receipt prior image is not trusted"
  [[ -n "$receipt_id" && -n "$receipt_uid" && -n "$receipt_after_generation" ]] ||
    die "rollback receipt identity is incomplete"

  read_snapshot || die "could not read active ${deployment_name} and worker ConfigMap"
  validate_snapshot
  [[ "$deployment_uid" == "$receipt_uid" ]] || die "stale rollback: deployment UID changed"
  # Controller status updates change resourceVersion without changing spec. Use
  # the fresh version in the atomic patch, while binding rollback to the recorded
  # UID, generation, image and protected shape (also valid for a lost-ACK intent).
  [[ "$deployment_generation" == "$receipt_after_generation" ]] || die "stale rollback: Deployment changed after receipt"
  [[ "$deployment_replicas" == "$receipt_after_replicas" ]] || die "stale rollback: replica count changed"
  [[ "$deployment_image" == "$receipt_after_image" ]] || die "stale rollback: current image is not the receipt-bound target"
  compare_deployment_protected_shape "$receipt_after_hash" || die "stale rollback: unrelated Deployment configuration changed"
  compare_configmap_snapshot "$receipt_after_configmap" || die "stale rollback: worker ConfigMap changed"

  before_json="$(snapshot_json)"
  if [[ "$apply" != "1" ]]; then
    print_plan "rollback" "$rollback_image" "" "$before_json" "$receipt_id"
    return 0
  fi

  ensure_receipt_path_is_new
  write_intent "rollback" "$rollback_image" "false" "$receipt_id"
  patch_image "$deployment_uid" "$deployment_resource_version" "$deployment_generation" "$deployment_image" "$rollback_image" "$deployment_container_index" ||
    die "rollback patch was rejected; no receipt was written"

  rollout_and_readback
  [[ "$deployment_uid" == "$receipt_uid" ]] || die "post-rollback UID changed; refusing receipt"
  [[ "$deployment_image" == "$rollback_image" ]] || die "post-rollback image readback does not match receipt"
  [[ "$deployment_replicas" == "$receipt_after_replicas" ]] || die "post-rollback replicas changed; refusing receipt"
  compare_deployment_protected_shape "$receipt_after_hash" || die "post-rollback Deployment shape changed outside the image field"
  compare_configmap_snapshot "$receipt_after_configmap" || die "worker ConfigMap changed during rollback"

  after_json="$(snapshot_json)"
  if ! write_receipt "rollback" "$rollout_status" "false" "$receipt_id" "" "$before_json" "$after_json"; then
    die "rollback completed but the immutable receipt could not be written"
  fi

  if [[ "$rollout_status" == "rollout_failed" ]]; then
    echo "advance-review-runtime: rollback receipt written with status=rollout_failed at ${receipt_path}" >&2
    return 1
  fi
  echo "advance-review-runtime: ${deployment_name} rollback completed and receipt written at ${receipt_path}"
}

parse_args "$@"

if [[ "$mode" == "rollback" ]]; then
  [[ -z "$component" && -z "$expected_current_image" && -z "$expected_uid" && -z "$expected_resource_version" && -z "$target_image" && -z "$reviewed_source_sha" ]] ||
    die "rollback cannot be combined with upgrade arguments"
  rollback
else
  [[ -z "$rollback_receipt" ]] || die "--rollback is required for rollback mode"
  upgrade
fi
