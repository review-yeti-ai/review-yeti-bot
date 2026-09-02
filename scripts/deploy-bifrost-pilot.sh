#!/usr/bin/env bash
set -euo pipefail

if [[ "${DEPLOY_BIFROST_PILOT:-}" != "YES" ]]; then
  echo "set DEPLOY_BIFROST_PILOT=YES to deploy the reviewed pilot" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/bifrost-pilot-settings.sh
source "$repo_root/scripts/bifrost-pilot-settings.sh"
expected_context="do-nyc1-cluster-ny1"
doppler_project="ct-llm-gateway"
doppler_config="prd"
ephemeral_doppler_token=""
ephemeral_doppler_token_slug=""

cleanup() {
  if [[ -n "$ephemeral_doppler_token_slug" ]]; then
    doppler configs tokens revoke --slug "$ephemeral_doppler_token_slug" \
      --project "$doppler_project" \
      --config "$doppler_config" \
      --silent >/dev/null 2>&1 || true
    unset ephemeral_doppler_token ephemeral_doppler_token_slug
  fi
}
trap cleanup EXIT

if [[ "$(kubectl config current-context)" != "$expected_context" ]]; then
  echo "refusing deployment outside Kubernetes context $expected_context" >&2
  exit 1
fi

"$repo_root/scripts/bifrost-pilot-contract.test.sh"

kubectl apply --filename "$repo_root/deploy/bifrost-pilot/namespace.yaml"

if [[ -n "${DOPPLER_TOKEN:-}" ]]; then
  doppler run --project "$doppler_project" --config "$doppler_config" -- \
    "$repo_root/scripts/materialize-bifrost-runtime.sh"
else
  # Restricted secrets cannot be downloaded with an ordinary personal CLI
  # token. Mint a short-lived, read-only config token and revoke it on exit.
  token_json="$(
    doppler configs tokens create \
      --project "$doppler_project" \
      --config "$doppler_config" \
      --access read \
      --max-age 15m \
      --name "bifrost-bootstrap-$(date -u +%Y%m%d%H%M%S)" \
      --json \
      --silent
  )"
  ephemeral_doppler_token="$(jq -er '.token' <<<"$token_json")"
  ephemeral_doppler_token_slug="$(jq -er '.slug' <<<"$token_json")"
  unset token_json
  DOPPLER_TOKEN="$ephemeral_doppler_token" doppler run \
    --project "$doppler_project" \
    --config "$doppler_config" -- \
    "$repo_root/scripts/materialize-bifrost-runtime.sh"
fi

helm repo add bifrost https://maximhq.github.io/bifrost/helm-charts --force-update
helm repo update bifrost

helm upgrade --install "$BIFROST_PILOT_RELEASE" "$BIFROST_PILOT_CHART" \
  --version "$BIFROST_PILOT_CHART_VERSION" \
  --namespace "$BIFROST_PILOT_NAMESPACE" \
  --values "$repo_root/deploy/bifrost-pilot/values.yaml" \
  --atomic \
  --wait \
  --timeout 10m

kubectl rollout status deployment/ct-llm-gateway-bifrost \
  --namespace "$BIFROST_PILOT_NAMESPACE" \
  --timeout 5m

kubectl get deployment,pod,service,ingress \
  --namespace "$BIFROST_PILOT_NAMESPACE" \
  --selector app.kubernetes.io/instance="$BIFROST_PILOT_RELEASE"
