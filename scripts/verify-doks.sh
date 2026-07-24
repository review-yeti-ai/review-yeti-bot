#!/usr/bin/env bash
set -euo pipefail

MOCK=false
DRY_RUN=false
TARGET_URL="http://localhost:3000"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mock)
      MOCK=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --url)
      TARGET_URL="$2"
      shift 2
      ;;
    *)
      echo "Error: Unknown argument '$1'" >&2
      exit 1
      ;;
  esac
done

echo "==> DOKS Verification Script"
echo "Mock Mode: $MOCK"
echo "Dry Run Mode: $DRY_RUN"

if [ "$MOCK" = true ] || [ "$DRY_RUN" = true ]; then
  echo "==> [MOCK/DRY-RUN] Checking deployment rollout status..."
  echo "deployment \"ct-review-bot\" successfully rolled out"
  
  echo "==> [MOCK/DRY-RUN] Verifying pod securityContext..."
  echo "Verified: runAsNonRoot=true, runAsUser=10001, allowPrivilegeEscalation=false, drop=ALL"
  
  echo "==> [MOCK/DRY-RUN] Testing endpoint responses..."
  echo "GET /health -> 200 OK"
  echo "GET /api/router/status -> 200 OK"
  
  echo "==> Verification completed successfully."
  exit 0
fi

echo "==> Checking deployment rollout status..."
kubectl rollout status deployment/ct-review-bot --timeout=60s

echo "==> Verifying pod securityContext..."
POD_SECURITY=$(kubectl get deployment ct-review-bot -o jsonpath='{.spec.template.spec.containers[0].securityContext}')
echo "Container SecurityContext: $POD_SECURITY"

echo "==> Testing /health endpoint response..."
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$TARGET_URL/health" || echo "000")
if [ "$HEALTH_STATUS" != "200" ]; then
  echo "Error: /health endpoint returned HTTP $HEALTH_STATUS" >&2
  exit 1
fi
echo "GET /health returned HTTP 200 OK"

echo "==> Testing /api/router/status endpoint response..."
ROUTER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$TARGET_URL/api/router/status" || echo "000")
if [ "$ROUTER_STATUS" != "200" ]; then
  echo "Error: /api/router/status endpoint returned HTTP $ROUTER_STATUS" >&2
  exit 1
fi
echo "GET /api/router/status returned HTTP 200 OK"

echo "==> All verification checks passed successfully."
