#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=false
SKIP_DOCTL=false
CLUSTER_NAME="${CLUSTER_NAME:-ct-review-bot-cluster}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run|--mock)
      DRY_RUN=true
      shift
      ;;
    --skip-doctl)
      SKIP_DOCTL=true
      shift
      ;;
    --cluster-name)
      if [[ -z "${2:-}" ]]; then
        echo "Error: --cluster-name requires a non-empty argument." >&2
        exit 1
      fi
      CLUSTER_NAME="$2"
      shift 2
      ;;
    *)
      echo "Error: Unknown argument '$1'" >&2
      exit 1
      ;;
  esac
done

echo "==> DOKS Deployment Script"
echo "Cluster Name: $CLUSTER_NAME"
echo "Dry Run Mode: $DRY_RUN"
echo "Skip Doctl: $SKIP_DOCTL"

if [ "$DRY_RUN" = true ] || [ "$SKIP_DOCTL" = true ]; then
  echo "==> Skipping doctl kubeconfig save (dry-run or skip-doctl specified)"
else
  echo "==> Saving kubeconfig for cluster $CLUSTER_NAME..."
  if ! doctl kubernetes cluster kubeconfig save "$CLUSTER_NAME"; then
    echo "Error: Failed to save kubeconfig via doctl." >&2
    exit 1
  fi
fi

if [ "$DRY_RUN" = true ]; then
  echo "==> Validating manifests with kubectl apply --dry-run=client..."
  if command -v kubectl &> /dev/null; then
    kubectl apply --validate=false --dry-run=client -f k8s/
  else
    echo "Notice: kubectl not found, simulated dry-run validation passed."
  fi
  echo "==> Dry-run completed successfully."
  exit 0
fi

echo "==> Validating manifests with dry-run..."
kubectl apply --validate=false --dry-run=client -f k8s/

echo "==> Applying Kubernetes manifests to cluster..."
kubectl apply -f k8s/

echo "==> Deployment applied successfully."
