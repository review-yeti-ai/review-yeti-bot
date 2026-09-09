#!/usr/bin/env bash
set -euo pipefail

# Advance the production review-job-dispatcher worker digest through the
# rendered manifest, not a hand kubectl patch.
#
# Context: deploy-review-job-dispatcher.sh only ever installs at replicas: 0
# and refuses to activate a deployment (by design -- it is an install/upgrade
# boundary, not an activation switch). install-doks-review-runtime.sh refuses
# to touch a deployment that already has non-zero replicas. Neither script has
# a sanctioned path to move the worker image forward once a dispatcher is
# live. Doing that by hand with `kubectl patch` leaves the field-manager
# "kubectl-patch" owning data.REVIEW_JOB_WORKER_IMAGE, which then makes the
# next server-side apply from either script conflict (see the header comment
# in deploy-review-job-dispatcher.sh). This script is the sanctioned path: it
# only ever runs against an already-active dispatcher, and it always writes
# through the same rendered ConfigMap document the deploy script uses, so
# manifest ownership of that field is restored rather than repeatedly fought
# over.
#
# Usage: advance-review-worker.sh <commit-sha|release-tag> [--dry-run]

usage() {
  echo "usage: advance-review-worker.sh <commit-sha|release-tag> [--dry-run]" >&2
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "advance-review-worker: missing required command: $1" >&2
    exit 2
  }
}

need kubectl
need curl
need jq
need envsubst
need git

namespace="ct-review-system"
deployment_name="ct-review-job-dispatcher"
configmap_name="ct-review-job-dispatcher"
worker_repo="review-yeti-ai/review-yeti-worker"
worker_image_repo="ghcr.io/${worker_repo}"
gh_repo="${ADVANCE_REVIEW_WORKER_GH_REPO:-review-yeti-ai/review-yeti-bot}"
rollout_timeout="${ADVANCE_REVIEW_WORKER_ROLLOUT_TIMEOUT:-3m}"

ref=""
dry_run=""
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run="1"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      echo "advance-review-worker: unknown flag: $arg" >&2
      usage
      exit 2
      ;;
    *)
      if [[ -n "$ref" ]]; then
        echo "advance-review-worker: unexpected extra argument: $arg" >&2
        usage
        exit 2
      fi
      ref="$arg"
      ;;
  esac
done

if [[ -z "$ref" ]]; then
  usage
  exit 2
fi

# --- Step 1: resolve the argument to a 40-hex commit SHA ---------------------

is_full_sha() {
  [[ "$1" =~ ^[0-9a-fA-F]{40}$ ]]
}

resolve_commit() {
  local input="$1"

  if is_full_sha "$input"; then
    printf '%s\n' "${input,,}"
    return 0
  fi

  # Try a local git resolution first (works when run from a checkout that has
  # the tag, and dereferences an annotated tag to the commit it points at).
  local local_sha=""
  if local_sha="$(git rev-parse --verify -q "refs/tags/${input}^{commit}" 2>/dev/null)"; then
    if is_full_sha "$local_sha"; then
      printf '%s\n' "${local_sha,,}"
      return 0
    fi
  fi

  # Fall back to the GitHub API: resolve the tag ref, then dereference an
  # annotated tag object to the commit it targets.
  need gh
  local ref_json object_type object_sha
  if ! ref_json="$(gh api "repos/${gh_repo}/git/ref/tags/${input}" 2>/dev/null)"; then
    echo "advance-review-worker: could not resolve '${input}' to a commit via git or the GitHub API (repo ${gh_repo})" >&2
    return 1
  fi
  object_type="$(jq -r '.object.type // empty' <<<"$ref_json")"
  object_sha="$(jq -r '.object.sha // empty' <<<"$ref_json")"
  if [[ -z "$object_type" || -z "$object_sha" ]]; then
    echo "advance-review-worker: malformed tag ref response for '${input}'" >&2
    return 1
  fi
  if [[ "$object_type" == "tag" ]]; then
    # Annotated tag object: dereference to the commit it targets.
    if ! object_sha="$(gh api "repos/${gh_repo}/git/tags/${object_sha}" --jq '.object.sha' 2>/dev/null)"; then
      echo "advance-review-worker: could not dereference annotated tag '${input}'" >&2
      return 1
    fi
  fi
  if ! is_full_sha "$object_sha"; then
    echo "advance-review-worker: resolved '${input}' to a non-commit-shaped value: ${object_sha}" >&2
    return 1
  fi
  printf '%s\n' "${object_sha,,}"
}

# The ref is interpolated into a GitHub API path. Refuse anything outside the
# characters a tag or commit can contain, and any path-traversal segment, before
# it is used anywhere; gh api does not percent-encode path components.
if [[ ! "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ || "$ref" == *..* ]]; then
  echo "advance-review-worker: refusing ref '${ref}': only [A-Za-z0-9._/-] are allowed and '..' is not" >&2
  exit 1
fi
commit_sha="$(resolve_commit "$ref")" || exit 1
echo "advance-review-worker: resolved ${ref} -> commit ${commit_sha}"

# --- Step 2: resolve the commit to the GHCR multi-arch index digest --------

ghcr_token="$(curl -fsS "https://ghcr.io/token?scope=repository:${worker_repo}:pull" | jq -r '.token // empty')"
if [[ -z "$ghcr_token" ]]; then
  echo "advance-review-worker: could not obtain an anonymous GHCR pull token for ${worker_repo}" >&2
  exit 1
fi

accept_header="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json"
manifest_url="https://ghcr.io/v2/${worker_repo}/manifests/${commit_sha}"

head_response="$(curl -fsSI \
  -H "Authorization: Bearer ${ghcr_token}" \
  -H "Accept: ${accept_header}" \
  "$manifest_url")"

target_digest="$(printf '%s' "$head_response" | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}' | tail -n1)"
if [[ -z "$target_digest" ]]; then
  echo "advance-review-worker: GHCR HEAD response for commit ${commit_sha} carried no Docker-Content-Digest header" >&2
  exit 1
fi
if [[ ! "$target_digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "advance-review-worker: GHCR digest is not a lowercase sha256 digest: ${target_digest}" >&2
  exit 1
fi

manifest_body="$(curl -fsS \
  -H "Authorization: Bearer ${ghcr_token}" \
  -H "Accept: ${accept_header}" \
  "$manifest_url")"

media_type="$(jq -r '.mediaType // empty' <<<"$manifest_body")"
case "$media_type" in
  application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json)
    ;;
  *)
    echo "advance-review-worker: refusing single-manifest image for commit ${commit_sha} (mediaType: ${media_type:-<none>}); a multi-arch index is required" >&2
    exit 1
    ;;
esac

architectures="$(jq -r '[.manifests[]?.platform.architecture] | unique | join(",")' <<<"$manifest_body")"
if [[ "$architectures" != *"amd64"* || "$architectures" != *"arm64"* ]]; then
  echo "advance-review-worker: refusing image index for commit ${commit_sha} that does not cover both amd64 and arm64 (found: ${architectures:-<none>})" >&2
  exit 1
fi

target_image="${worker_image_repo}@${target_digest}"
echo "advance-review-worker: resolved commit ${commit_sha} -> ${target_image} (architectures: ${architectures})"

# --- Step 3: require the dispatcher to already be an active, prebaked lane -

if ! replicas="$(kubectl -n "$namespace" get deployment "$deployment_name" -o jsonpath='{.spec.replicas}' 2>&1)"; then
  echo "advance-review-worker: could not read deployment ${deployment_name} in namespace ${namespace} (${replicas}); this script advances a live dispatcher, it does not create one. Use install-doks-review-runtime.sh / deploy-review-job-dispatcher.sh first." >&2
  exit 1
fi
if ! [[ "$replicas" =~ ^[0-9]+$ ]] || [[ "$replicas" -le 0 ]]; then
  echo "advance-review-worker: deployment ${deployment_name} has replicas=${replicas}; this script advances a live dispatcher, it does not activate one. Run install-doks-review-runtime.sh / deploy-review-job-dispatcher.sh to install, then scale it up deliberately, before running this script." >&2
  exit 1
fi

if ! runner_mode="$(kubectl -n "$namespace" get configmap "$configmap_name" -o jsonpath='{.data.REVIEW_JOB_RUNNER_MODE}' 2>&1)"; then
  echo "advance-review-worker: could not read configmap ${configmap_name} in namespace ${namespace} (${runner_mode})" >&2
  exit 1
fi
if [[ "$runner_mode" != "prebaked" ]]; then
  echo "advance-review-worker: expected REVIEW_JOB_RUNNER_MODE=prebaked on configmap ${configmap_name}, found '${runner_mode}'. This script only advances the digest-pinned prebaked-worker lane; a generic-runner lane is not this script's concern." >&2
  exit 1
fi

if ! current_image="$(kubectl -n "$namespace" get configmap "$configmap_name" -o jsonpath='{.data.REVIEW_JOB_WORKER_IMAGE}' 2>&1)"; then
  echo "advance-review-worker: could not read REVIEW_JOB_WORKER_IMAGE from configmap ${configmap_name} (${current_image})" >&2
  exit 1
fi
if [[ -z "$current_image" ]]; then
  echo "advance-review-worker: configmap ${configmap_name} has no REVIEW_JOB_WORKER_IMAGE key" >&2
  exit 1
fi

if ! dispatcher_image="$(kubectl -n "$namespace" get deployment "$deployment_name" -o jsonpath='{.spec.template.spec.containers[0].image}' 2>&1)"; then
  echo "advance-review-worker: could not read the live dispatcher container image from deployment ${deployment_name} (${dispatcher_image})" >&2
  exit 1
fi
if [[ -z "$dispatcher_image" ]]; then
  echo "advance-review-worker: deployment ${deployment_name} reported an empty container image" >&2
  exit 1
fi

echo "advance-review-worker: old worker image -> ${current_image}"
echo "advance-review-worker: new worker image -> ${target_image}"

already_pinned=""
if [[ "$current_image" == "$target_image" ]]; then
  # Still apply the ConfigMap through the manifest: a matching value may have
  # been set by a hand patch, which leaves field-manager "kubectl-patch" owning
  # the key and makes the next server-side apply conflict. Reclaiming ownership
  # is part of what this script is for; only the restart is skipped.
  already_pinned="1"
  echo "advance-review-worker: dispatcher already pinned to ${target_image}; re-applying the ConfigMap to reclaim manifest ownership, no restart unless the running pod disagrees"
fi

if [[ -n "$dry_run" ]]; then
  echo "advance-review-worker: --dry-run given; stopping before any apply"
  exit 0
fi

# --- Step 4: apply the change through the manifest, not a patch ------------
#
# Render the full template through the shared renderer (one variable list for
# this script and the deploy script), then keep only the first YAML document -- the
# ConfigMap -- so nothing else in the manifest (Deployment, RBAC, NetworkPolicy)
# is re-applied or re-evaluated by this script. CT_REVIEW_JOB_DISPATCHER_IMAGE
# is read from the live deployment purely so envsubst has every variable the
# template references; the ConfigMap document does not use it and no other
# field changes.
work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT

export CT_REVIEW_JOB_DISPATCHER_IMAGE="$dispatcher_image"
export CT_REVIEW_WORKER_IMAGE="$target_image"
export CT_REVIEW_RUNNER_MODE="$runner_mode"

# shellcheck source=scripts/lib/review-job-dispatcher-render.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/review-job-dispatcher-render.sh"
render_review_job_dispatcher_template k8s/review-job-dispatcher.yaml.tpl "$work_dir/rendered-full.yaml"

awk '/^---[[:space:]]*$/{exit} {print}' "$work_dir/rendered-full.yaml" > "$work_dir/configmap-only.yaml"

if ! grep -q '^kind: ConfigMap$' "$work_dir/configmap-only.yaml"; then
  echo "advance-review-worker: internal error: extracted document is not a ConfigMap" >&2
  exit 1
fi

# --force-conflicts is correct HERE and only here: this script is the single
# writer that ever moves REVIEW_JOB_WORKER_IMAGE on a live dispatcher, and its
# whole purpose is to reclaim ownership of that field from a prior hand patch
# (field-manager "kubectl-patch") back to a manifest-driven apply. The deploy
# script keeps --force-conflicts opt-in because it is a general install path
# that must not silently clobber a deliberate manual pin nobody asked it to
# touch; this script IS that deliberate, reviewed change.
kubectl apply --server-side --force-conflicts -f "$work_dir/configmap-only.yaml"

# --- Step 5: restart (when the value changed) and verify -------------------

if [[ -z "$already_pinned" ]]; then
  kubectl -n "$namespace" rollout restart "deployment/${deployment_name}"
  kubectl -n "$namespace" rollout status "deployment/${deployment_name}" --timeout="$rollout_timeout"
fi

if ! pod_name="$(kubectl -n "$namespace" get pods \
  -l "app.kubernetes.io/name=${deployment_name}" \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[-1:].metadata.name}' 2>&1)"; then
  echo "advance-review-worker: could not list running pods for deployment ${deployment_name} (${pod_name})" >&2
  exit 1
fi
if [[ -z "$pod_name" ]]; then
  echo "advance-review-worker: rollout reported ready but no running pod was found for deployment ${deployment_name}; cannot verify" >&2
  exit 1
fi

# Deliberately single-quoted: this expands inside the pod's shell via `exec`,
# not in this script's shell.
# shellcheck disable=SC2016
if ! observed_image="$(kubectl -n "$namespace" exec "$pod_name" -- sh -c 'printf "%s" "$REVIEW_JOB_WORKER_IMAGE"' 2>&1)"; then
  echo "advance-review-worker: could not exec into pod ${pod_name} to verify REVIEW_JOB_WORKER_IMAGE (${observed_image})" >&2
  exit 1
fi
if [[ "$observed_image" != "$target_image" && -n "$already_pinned" ]]; then
  # The ConfigMap already carried the target but the running pod does not: a
  # hand edit without a restart. Restart once and verify again.
  echo "advance-review-worker: ConfigMap is pinned but pod ${pod_name} reports '${observed_image}'; restarting so the running dispatcher matches the manifest"
  kubectl -n "$namespace" rollout restart "deployment/${deployment_name}"
  kubectl -n "$namespace" rollout status "deployment/${deployment_name}" --timeout="$rollout_timeout"
  if ! pod_name="$(kubectl -n "$namespace" get pods \
    -l "app.kubernetes.io/name=${deployment_name}" \
    --field-selector=status.phase=Running \
    -o jsonpath='{.items[-1:].metadata.name}' 2>&1)" || [[ -z "$pod_name" ]]; then
    echo "advance-review-worker: no running pod found after restart of ${deployment_name}; cannot verify" >&2
    exit 1
  fi
  # shellcheck disable=SC2016
  if ! observed_image="$(kubectl -n "$namespace" exec "$pod_name" -- sh -c 'printf "%s" "$REVIEW_JOB_WORKER_IMAGE"' 2>&1)"; then
    echo "advance-review-worker: could not exec into pod ${pod_name} after restart (${observed_image})" >&2
    exit 1
  fi
fi
if [[ "$observed_image" != "$target_image" ]]; then
  echo "advance-review-worker: verification failed: pod ${pod_name} reports REVIEW_JOB_WORKER_IMAGE='${observed_image}', expected '${target_image}'" >&2
  exit 1
fi

echo "advance-review-worker: verified pod ${pod_name} is running with REVIEW_JOB_WORKER_IMAGE=${target_image}"
