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

: "${CT_REVIEW_JOB_DISPATCHER_IMAGE:?set CT_REVIEW_JOB_DISPATCHER_IMAGE to registry.digitalocean.com/calltelemetry/ct-review-bot@sha256:digest}"
: "${CT_REVIEW_WORKER_IMAGE:?set CT_REVIEW_WORKER_IMAGE to registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:digest}"

if [[ ! "$CT_REVIEW_JOB_DISPATCHER_IMAGE" =~ ^registry\.digitalocean\.com/calltelemetry/ct-review-bot@sha256:[0-9a-f]{64}$ ]]; then
  echo "deploy-review-job-dispatcher: CT_REVIEW_JOB_DISPATCHER_IMAGE must use the trusted repository and an immutable lowercase sha256 digest" >&2
  exit 2
fi
if [[ ! "$CT_REVIEW_WORKER_IMAGE" =~ ^registry\.digitalocean\.com/calltelemetry/review-yeti-worker@sha256:[0-9a-f]{64}$ ]]; then
  echo "deploy-review-job-dispatcher: CT_REVIEW_WORKER_IMAGE must use the trusted repository and an immutable lowercase sha256 digest" >&2
  exit 2
fi

kubectl apply --server-side -f k8s/namespace.yaml
# Go-template variables are interpreted by kubectl.
# shellcheck disable=SC2016
secret_keys="$(kubectl -n ct-review-system get secret ct-review-job-dispatcher-runtime \
  -o go-template='{{range $key, $value := .data}}{{printf "%s\\n" $key}}{{end}}' | LC_ALL=C sort)"
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

# Restrict envsubst to these two literal variable names.
# shellcheck disable=SC2016
envsubst '${CT_REVIEW_JOB_DISPATCHER_IMAGE} ${CT_REVIEW_WORKER_IMAGE}' \
  < k8s/review-job-dispatcher.yaml.tpl > "$render_dir/review-job-dispatcher.yaml"

kubectl apply --server-side -f "$render_dir/review-job-dispatcher.yaml"

replicas="$(kubectl -n ct-review-system get deployment ct-review-job-dispatcher -o jsonpath='{.spec.replicas}')"
if [[ "$replicas" != "0" ]]; then
  echo "deploy-review-job-dispatcher: expected zero replicas after apply; refusing activation" >&2
  exit 1
fi

echo "Review job dispatcher resources are installed at zero replicas; no queue consumption was activated."
