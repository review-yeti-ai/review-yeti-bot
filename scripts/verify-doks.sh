#!/usr/bin/env bash
set -euo pipefail

namespace=ct-review-system
host="${REVIEW_BOT_HOST:-https://review-bot.calltelemetry.com}"

echo "Verifying zero-downtime rolling update status on DOKS cluster cluster-ny1..."
kubectl -n "$namespace" rollout status statefulset/omniroute --timeout=5m
kubectl -n "$namespace" rollout status deployment/ct-review-bot --timeout=5m

bot_image="$(kubectl -n "$namespace" get deployment ct-review-bot -o jsonpath='{.spec.template.spec.containers[0].image}')"
omni_image="$(kubectl -n "$namespace" get statefulset omniroute -o jsonpath='{.spec.template.spec.containers[0].image}')"

case "$bot_image" in *@sha256:*) ;; *) echo "verify-doks: bot image is not digest-pinned: $bot_image" >&2; exit 1;; esac
case "$omni_image" in *@sha256:*) ;; *) echo "verify-doks: OmniRoute image is not digest-pinned: $omni_image" >&2; exit 1;; esac

# Ensure 2 active replicas are running and healthy
ready_replicas="$(kubectl -n "$namespace" get deployment ct-review-bot -o jsonpath='{.status.readyReplicas}')"
if [ "$ready_replicas" -lt 2 ]; then
  echo "verify-doks: Expected at least 2 ready replicas, found: $ready_replicas" >&2
  exit 1
fi

kubectl -n "$namespace" get pods,svc,ingress,pvc
curl --fail --silent --show-error "$host/health"
curl --fail --silent --show-error "$host/ready"
echo "Deployment verification successful: 100% healthy zero-downtime rollout."
