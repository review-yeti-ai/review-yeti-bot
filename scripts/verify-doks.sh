#!/usr/bin/env bash
set -euo pipefail

namespace=ct-review-system
host="${REVIEW_BOT_HOST:-https://review-bot.calltelemetry.com}"

echo "Verifying zero-downtime rolling update status on DOKS cluster cluster-ny1..."
kubectl -n "$namespace" rollout status statefulset/omniroute --timeout=5m
kubectl -n "$namespace" rollout status deployment/ct-review-bot --timeout=5m

bot_image="$(kubectl -n "$namespace" get deployment ct-review-bot -o jsonpath='{.spec.template.spec.containers[0].image}')"
omni_image="$(kubectl -n "$namespace" get statefulset omniroute -o jsonpath='{.spec.template.spec.containers[0].image}')"

if [[ ! "$bot_image" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "verify-doks: bot image is not digest-pinned (*@sha256:64_hex_chars): $bot_image" >&2
  exit 1
fi
if [[ ! "$omni_image" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "verify-doks: OmniRoute image is not digest-pinned (*@sha256:64_hex_chars): $omni_image" >&2
  exit 1
fi

# Ensure 2 active replicas are running and healthy
ready_replicas="$(kubectl -n "$namespace" get deployment ct-review-bot -o jsonpath='{.status.readyReplicas}')"
if [ "${ready_replicas:-0}" -lt 2 ]; then
  echo "verify-doks: Expected at least 2 ready replicas, found: ${ready_replicas:-0}" >&2
  exit 1
fi

echo "Validating pod readiness..."
kubectl -n "$namespace" wait --for=condition=ready pod -l app.kubernetes.io/name=ct-review-bot --timeout=2m
kubectl -n "$namespace" wait --for=condition=ready pod -l app.kubernetes.io/name=omniroute --timeout=2m

kubectl -n "$namespace" get pods,svc,ingress,pvc
curl --fail --silent --show-error "$host/health"
curl --fail --silent --show-error "$host/ready"
curl --fail --silent --show-error "$host/api/version"
echo "Deployment verification successful: 100% healthy zero-downtime rollout."
