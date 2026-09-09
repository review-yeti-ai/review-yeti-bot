#!/usr/bin/env bash
set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "deploy-review-job-dispatcher: missing required command: $1" >&2
    exit 2
  }
}

need kubectl
need envsubst

runner_mode="${CT_REVIEW_RUNNER_MODE:-${RUNNER_MODE:-prebaked}}"
# Server-side apply refuses to take a field another manager owns. A field set once
# by `kubectl patch` (manager "kubectl-patch") therefore wedges every later deploy:
# the manifest can never reclaim it, and the script exits 1 with a conflict it
# offers no way to resolve. Observed on .data.REVIEW_JOB_WORKER_IMAGE, which had
# been hand-patched, blocking an otherwise valid rollout.
#
# Opt-in and off by default: forcing silently would let a deploy overwrite a
# deliberate manual pin with no one noticing, which is the failure this guard is
# protecting against in the first place.
force_conflicts=""
for arg in "$@"; do
  case "$arg" in
    --runner-mode=*)
      runner_mode="${arg#*=}"
      ;;
    --force-conflicts)
      force_conflicts="--force-conflicts"
      ;;
  esac
done

if [[ "$runner_mode" != "prebaked" && "$runner_mode" != "generic" ]]; then
  echo "deploy-review-job-dispatcher: runner mode must be prebaked or generic" >&2
  exit 2
fi
export CT_REVIEW_RUNNER_MODE="$runner_mode"

: "${CT_REVIEW_JOB_DISPATCHER_IMAGE:?set CT_REVIEW_JOB_DISPATCHER_IMAGE to a trusted bot image@sha256:digest}"

if [[ ! "$CT_REVIEW_JOB_DISPATCHER_IMAGE" =~ ^(ghcr\.io/review-yeti-ai/review-yeti-bot|registry\.digitalocean\.com/calltelemetry/ct-review-bot)@sha256:[0-9a-f]{64}$ ]]; then
  echo "deploy-review-job-dispatcher: CT_REVIEW_JOB_DISPATCHER_IMAGE must use a trusted repository and an immutable lowercase sha256 digest" >&2
  exit 2
fi

if [[ "$runner_mode" == "generic" ]]; then
  CT_REVIEW_WORKER_IMAGE="${CT_REVIEW_WORKER_IMAGE:-node:24-bookworm-slim}"
  if [[ ! "$CT_REVIEW_WORKER_IMAGE" =~ ^(node:[a-zA-Z0-9_.-]+|ghcr\.io/review-yeti-ai/[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+|(ghcr\.io/review-yeti-ai/review-yeti-worker|registry\.digitalocean\.com/calltelemetry/review-yeti-worker)@sha256:[0-9a-f]{64})$ ]]; then
    echo "deploy-review-job-dispatcher: in generic runner mode, CT_REVIEW_WORKER_IMAGE must be a valid node/runner image (e.g. node:24-bookworm-slim)" >&2
    exit 2
  fi
else
  : "${CT_REVIEW_WORKER_IMAGE:?set CT_REVIEW_WORKER_IMAGE to a trusted worker image@sha256:digest}"
  if [[ ! "$CT_REVIEW_WORKER_IMAGE" =~ ^(ghcr\.io/review-yeti-ai/review-yeti-worker|registry\.digitalocean\.com/calltelemetry/review-yeti-worker)@sha256:[0-9a-f]{64}$ ]]; then
    echo "deploy-review-job-dispatcher: CT_REVIEW_WORKER_IMAGE must use a trusted repository and an immutable lowercase sha256 digest" >&2
    exit 2
  fi
fi
export CT_REVIEW_WORKER_IMAGE

kubectl apply --server-side -f k8s/namespace.yaml
# Go-template variables are interpreted by kubectl.
# shellcheck disable=SC2016
secret_keys="$(kubectl -n ct-review-system get secret ct-review-job-dispatcher-runtime \
  -o go-template='{{range $key, $value := .data}}{{printf "%s\n" $key}}{{end}}' | LC_ALL=C sort)"
if [[ "$secret_keys" != $'DATABASE_CA_CERT\nDATABASE_URL' ]]; then
  echo "deploy-review-job-dispatcher: runtime secret must contain exactly DATABASE_CA_CERT and DATABASE_URL" >&2
  exit 2
fi
kubectl -n ct-review-system get secret calltelemetry >/dev/null

render_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$render_dir"
}
trap cleanup EXIT

# The variable list lives in scripts/lib/review-job-dispatcher-render.sh and is
# shared with advance-review-worker.sh so the two renderers cannot drift.
# shellcheck source=scripts/lib/review-job-dispatcher-render.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/review-job-dispatcher-render.sh"
render_review_job_dispatcher_template k8s/review-job-dispatcher.yaml.tpl "$render_dir/review-job-dispatcher.yaml"

if [[ -n "$force_conflicts" ]]; then
  echo "deploy-review-job-dispatcher: --force-conflicts given; this manifest will take ownership of any field another manager holds" >&2
fi
# `replicas: 0` in the template is an INSTALL boundary -- a first install must not
# start consuming the queue before an operator activates it. It is not a statement
# that the dispatcher should be off. Applying it unconditionally made this script
# scale a live production dispatcher from 1 to 0 and then report success:
#
#   - replicas: 1
#   + replicas: 0
#   "Review job dispatcher resources are installed at zero replicas"
#
# Since this is also the only script that moves the dispatcher image, the only way
# to deploy a fix was to take review dispatch down. So: keep `replicas` in the
# manifest for a create (inert install, no start-up race), and strip it for an
# update so server-side apply never takes ownership of a field the operator and
# the scale subresource own. This is the documented pattern for a replica count
# managed outside the manifest.
if kubectl -n ct-review-system get deployment ct-review-job-dispatcher >/dev/null 2>&1; then
  deployment_existed="1"
  replicas_before="$(kubectl -n ct-review-system get deployment ct-review-job-dispatcher -o jsonpath='{.spec.replicas}')"
else
  deployment_existed=""
  replicas_before=""
fi

manifest="$render_dir/review-job-dispatcher.yaml"
if [[ -n "$deployment_existed" ]]; then
  # Remove exactly the one replica line, and refuse to guess if the template
  # shape ever changes.
  found="$(grep -c '^  replicas: 0$' "$manifest" || true)"
  if [[ "$found" != "1" ]]; then
    echo "deploy-review-job-dispatcher: expected exactly one 'replicas: 0' line in the rendered manifest, found ${found}" >&2
    exit 2
  fi
  # Strip in place so the applied path stays exactly the rendered manifest.
  grep -v '^  replicas: 0$' "$manifest" > "${manifest}.tmp"
  mv "${manifest}.tmp" "$manifest"
fi

# shellcheck disable=SC2086
kubectl apply --server-side $force_conflicts -f "$manifest"

replicas="$(kubectl -n ct-review-system get deployment ct-review-job-dispatcher -o jsonpath='{.spec.replicas}')"
if [[ -z "$deployment_existed" ]]; then
  if [[ "$replicas" != "0" ]]; then
    echo "deploy-review-job-dispatcher: expected zero replicas after a first install; refusing activation" >&2
    exit 1
  fi
  echo "Review job dispatcher resources are installed at zero replicas; no queue consumption was activated."
else
  if [[ "$replicas" != "$replicas_before" ]]; then
    echo "deploy-review-job-dispatcher: apply changed replicas ${replicas_before} -> ${replicas}; this script must never scale a live dispatcher" >&2
    exit 1
  fi
  echo "Review job dispatcher resources updated; replicas left unchanged at ${replicas} (activation state is not this script's to change)."
fi
