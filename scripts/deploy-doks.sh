#!/usr/bin/env bash
set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "deploy-doks: missing required command: $1" >&2
    exit 2
  }
}

need kubectl
need envsubst

: "${CT_REVIEW_BOT_IMAGE:?set CT_REVIEW_BOT_IMAGE to an immutable image@sha256:digest}"
: "${OMNIROUTE_IMAGE:?set OMNIROUTE_IMAGE to an immutable image@sha256:digest}"

if [[ ! "$CT_REVIEW_BOT_IMAGE" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "deploy-doks: CT_REVIEW_BOT_IMAGE must use an immutable sha256 digest (*@sha256:64_hex_chars)" >&2
  exit 2
fi
if [[ ! "$OMNIROUTE_IMAGE" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "deploy-doks: OMNIROUTE_IMAGE must use an immutable sha256 digest (*@sha256:64_hex_chars)" >&2
  exit 2
fi

render_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$render_dir"
}
trap cleanup EXIT

envsubst '${CT_REVIEW_BOT_IMAGE}' < k8s/bot-deployment.yaml.tpl > "$render_dir/bot-deployment.yaml"
envsubst '${OMNIROUTE_IMAGE}' < k8s/omniroute-statefulset.yaml.tpl > "$render_dir/omniroute-statefulset.yaml"

kubectl apply --server-side -f k8s/namespace.yaml
kubectl apply --server-side -f k8s/rbac.yaml
kubectl apply --server-side -f k8s/config.yaml
kubectl apply --server-side -f k8s/ingress-network.yaml
kubectl apply --server-side -f "$render_dir/omniroute-statefulset.yaml"
kubectl apply --server-side -f "$render_dir/bot-deployment.yaml"

echo "Validating zero-downtime rollout status..."
kubectl -n ct-review-system rollout status statefulset/omniroute --timeout=5m
kubectl -n ct-review-system rollout status deployment/ct-review-bot --timeout=5m

echo "Validating pod readiness..."
kubectl -n ct-review-system wait --for=condition=ready pod -l app.kubernetes.io/name=ct-review-bot --timeout=3m
kubectl -n ct-review-system wait --for=condition=ready pod -l app.kubernetes.io/name=omniroute --timeout=3m

echo "Deployment to DOKS completed successfully."
