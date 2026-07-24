#!/usr/bin/env bash
set -euo pipefail

namespace=ct-review-system
host="${REVIEW_BOT_HOST:-https://review-bot.calltelemetry.com}"

kubectl -n "$namespace" rollout status statefulset/omniroute --timeout=5m
kubectl -n "$namespace" rollout status deployment/ct-review-bot --timeout=5m

bot_image="$(kubectl -n "$namespace" get deployment ct-review-bot -o jsonpath='{.spec.template.spec.containers[0].image}')"
omni_image="$(kubectl -n "$namespace" get statefulset omniroute -o jsonpath='{.spec.template.spec.containers[0].image}')"
case "$bot_image" in *@sha256:*) ;; *) echo "verify-doks: bot image is not digest-pinned: $bot_image" >&2; exit 1;; esac
case "$omni_image" in *@sha256:*) ;; *) echo "verify-doks: OmniRoute image is not digest-pinned: $omni_image" >&2; exit 1;; esac

kubectl -n "$namespace" get pods,svc,ingress,pvc
curl --fail --silent --show-error "$host/health"
curl --fail --silent --show-error "$host/ready"
