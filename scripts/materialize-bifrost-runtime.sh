#!/usr/bin/env bash
set -euo pipefail

namespace="${BIFROST_NAMESPACE:-ct-llm-gateway}"
secret_name="${BIFROST_SECRET_NAME:-bifrost-runtime}"

required=(
  OLLAMA_API_KEY
  BIFROST_POSTGRES_PASSWORD
  BIFROST_ENCRYPTION_KEY
  BIFROST_SETUP_TOKEN
  BIFROST_ADMIN_USERNAME
  BIFROST_ADMIN_PASSWORD
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "required Doppler value is missing: $name" >&2
    exit 1
  fi
done

kubectl get namespace "$namespace" >/dev/null

# Build the Secret on stdin so no credential is written to disk or placed in a
# kubectl command argument. kubectl reports only the resource name and status.
jq -n \
  --arg namespace "$namespace" \
  --arg name "$secret_name" \
  '{
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: $name,
      namespace: $namespace,
      labels: {
        "app.kubernetes.io/name": "ct-llm-gateway",
        "app.kubernetes.io/part-of": "ct-review",
        "app.kubernetes.io/managed-by": "doppler-cli"
      }
    },
    type: "Opaque",
    data: {
      "ollama-api-key": (env.OLLAMA_API_KEY | @base64),
      "postgres-password": (env.BIFROST_POSTGRES_PASSWORD | @base64),
      "encryption-key": (env.BIFROST_ENCRYPTION_KEY | @base64),
      "setup-token": (env.BIFROST_SETUP_TOKEN | @base64),
      "admin-username": (env.BIFROST_ADMIN_USERNAME | @base64),
      "admin-password": (env.BIFROST_ADMIN_PASSWORD | @base64)
    }
  }' | kubectl apply --filename -
