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

case "$CT_REVIEW_BOT_IMAGE" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "deploy-doks: CT_REVIEW_BOT_IMAGE must use an immutable sha256 digest" >&2; exit 2 ;;
esac
case "$OMNIROUTE_IMAGE" in
  *@sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "deploy-doks: OMNIROUTE_IMAGE must use an immutable sha256 digest" >&2; exit 2 ;;
esac

render_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$render_dir"
}
trap cleanup EXIT

envsubst '${CT_REVIEW_BOT_IMAGE}' < k8s/bot-deployment.yaml.tpl > "$render_dir/bot-deployment.yaml"
envsubst '${OMNIROUTE_IMAGE}' < k8s/omniroute-statefulset.yaml.tpl > "$render_dir/omniroute-statefulset.yaml"

kubectl apply --server-side -f k8s/namespace.yaml
kubectl apply --server-side -f k8s/config.yaml
kubectl apply --server-side -f k8s/ingress-network.yaml
kubectl apply --server-side -f "$render_dir/omniroute-statefulset.yaml"
kubectl apply --server-side -f "$render_dir/bot-deployment.yaml"

kubectl -n ct-review-system rollout status statefulset/omniroute --timeout=10m
kubectl -n ct-review-system rollout status deployment/ct-review-bot --timeout=10m
