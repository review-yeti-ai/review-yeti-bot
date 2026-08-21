#!/usr/bin/env bash
# Deploy JBJMLLC ct-review-bot instance to jbjmllc-review-system namespace.
# Shares OmniRoute from ct-review-system — no OmniRoute deploy needed.
set -euo pipefail

NAMESPACE="jbjmllc-review-system"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "deploy-jbjmllc: missing required command: $1" >&2
    exit 2
  }
}

need kubectl
need envsubst

: "${CT_REVIEW_BOT_IMAGE:?set CT_REVIEW_BOT_IMAGE to an immutable image@sha256:digest}"

if [[ ! "$CT_REVIEW_BOT_IMAGE" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "deploy-jbjmllc: CT_REVIEW_BOT_IMAGE must use an immutable sha256 digest (*@sha256:64_hex_chars)" >&2
  exit 2
fi

render_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$render_dir"
}
trap cleanup EXIT

envsubst '${CT_REVIEW_BOT_IMAGE}' < k8s/jbjmllc/bot-deployment.yaml.tpl > "$render_dir/bot-deployment.yaml"

echo "Deploying JBJMLLC instance to namespace: $NAMESPACE"
kubectl apply --server-side -f k8s/jbjmllc/namespace.yaml
kubectl apply --server-side -f k8s/jbjmllc/rbac.yaml
kubectl apply --server-side -f k8s/jbjmllc/config.yaml
kubectl apply --server-side -f k8s/jbjmllc/ingress-network.yaml
kubectl apply --server-side -f "$render_dir/bot-deployment.yaml"

echo "Validating rollout status..."
kubectl -n "$NAMESPACE" rollout status deployment/ct-review-bot --timeout=5m

echo "Validating pod readiness..."
kubectl -n "$NAMESPACE" wait --for=condition=ready pod -l app=ct-review-bot,instance=jbjmllc --timeout=3m

echo "JBJMLLC deployment to DOKS completed successfully."
