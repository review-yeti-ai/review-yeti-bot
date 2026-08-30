#!/usr/bin/env bash
set -euo pipefail

namespace=ct-review-system
deployment=ct-review-action-dispatch

image="$(kubectl -n "$namespace" get deployment "$deployment" -o jsonpath='{.spec.template.spec.containers[0].image}')"
if [[ ! "$image" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "verify-action-dispatch: image is not digest-pinned: $image" >&2
  exit 1
fi

kubectl -n "$namespace" rollout status "deployment/$deployment" --timeout=3m
kubectl -n "$namespace" exec "deployment/$deployment" -- node -e \
  "Promise.all(['/health','/ready'].map(async p=>{const r=await fetch('http://127.0.0.1:3000'+p);if(!r.ok)throw new Error(p+' '+r.status)}))"

if kubectl -n "$namespace" get pvc -o name | grep -q .; then
  echo "verify-action-dispatch: qualification namespace must not contain PVCs" >&2
  exit 1
fi
if kubectl -n "$namespace" get jobs -o name | grep -q .; then
  echo "verify-action-dispatch: qualification namespace must not contain Jobs" >&2
  exit 1
fi

status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --request POST --header 'content-type: application/json' --data '{}' \
  https://review-bot.calltelemetry.com/api/dispatch/action)"
if [[ "$status" != "401" ]]; then
  echo "verify-action-dispatch: expected authenticated endpoint to reject an anonymous request with 401, got $status" >&2
  exit 1
fi

echo "Admission-only Action dispatch verification passed."
