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

# Restrict envsubst to these literal variable names.
# shellcheck disable=SC2016
envsubst '${CT_REVIEW_JOB_DISPATCHER_IMAGE} ${CT_REVIEW_WORKER_IMAGE} ${CT_REVIEW_RUNNER_MODE}' \
  < k8s/review-job-dispatcher.yaml.tpl > "$render_dir/review-job-dispatcher.yaml"

if [[ -n "$force_conflicts" ]]; then
  echo "deploy-review-job-dispatcher: --force-conflicts given; this manifest will take ownership of any field another manager holds" >&2
fi
# shellcheck disable=SC2086
kubectl apply --server-side $force_conflicts -f "$render_dir/review-job-dispatcher.yaml"

replicas="$(kubectl -n ct-review-system get deployment ct-review-job-dispatcher -o jsonpath='{.spec.replicas}')"
if [[ "$replicas" != "0" ]]; then
  echo "deploy-review-job-dispatcher: expected zero replicas after apply; refusing activation" >&2
  exit 1
fi

echo "Review job dispatcher resources are installed at zero replicas; no queue consumption was activated."
