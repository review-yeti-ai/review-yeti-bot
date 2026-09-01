#!/usr/bin/env bash
set -euo pipefail

# Install the reviewed DOKS review resources without activating review traffic.
#
# This is deliberately an installation boundary, not an activation command:
# the operator and durable dispatcher manifests both declare replicas: 0 and
# the script refuses to touch an already-active deployment. A later, explicit
# qualification command may scale the isolated workloads after the cluster
# state and receipts have been reviewed.

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "install-doks-review-runtime: missing required command: $1" >&2
    exit 2
  }
}

need kubectl
need envsubst

namespace=ct-review-system
operator_image="${CT_REVIEW_OPERATOR_IMAGE:-}"
dispatcher_image="${CT_REVIEW_JOB_DISPATCHER_IMAGE:-}"
worker_image="${CT_REVIEW_WORKER_IMAGE:-}"
service_ip="${KUBERNETES_SERVICE_IP:-}"
api_endpoint_cidr="${KUBERNETES_API_ENDPOINT_CIDR:-}"
api_cidr="${KUBERNETES_API_CIDR:-}"

require_value() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "install-doks-review-runtime: $name is required" >&2
    exit 2
  fi
}

require_value CT_REVIEW_OPERATOR_IMAGE "$operator_image"
require_value CT_REVIEW_JOB_DISPATCHER_IMAGE "$dispatcher_image"
require_value CT_REVIEW_WORKER_IMAGE "$worker_image"
require_value KUBERNETES_SERVICE_IP "$service_ip"
require_value KUBERNETES_API_ENDPOINT_CIDR "$api_endpoint_cidr"
require_value KUBERNETES_API_CIDR "$api_cidr"

if [[ ! "$operator_image" =~ ^registry\.digitalocean\.com/calltelemetry/review-yeti-operator@sha256:[0-9a-f]{64}$ ]]; then
  echo "install-doks-review-runtime: CT_REVIEW_OPERATOR_IMAGE must be a lowercase digest in the trusted operator repository" >&2
  exit 2
fi
if [[ ! "$dispatcher_image" =~ ^registry\.digitalocean\.com/calltelemetry/ct-review-bot@sha256:[0-9a-f]{64}$ ]]; then
  echo "install-doks-review-runtime: CT_REVIEW_JOB_DISPATCHER_IMAGE must be a lowercase digest in the trusted bot repository" >&2
  exit 2
fi
if [[ ! "$worker_image" =~ ^registry\.digitalocean\.com/calltelemetry/review-yeti-worker@sha256:[0-9a-f]{64}$ ]]; then
  echo "install-doks-review-runtime: CT_REVIEW_WORKER_IMAGE must be a lowercase digest in the trusted worker repository" >&2
  exit 2
fi

if [[ ! "$service_ip" =~ ^[0-9A-Fa-f:.]+$ ]]; then
  echo "install-doks-review-runtime: KUBERNETES_SERVICE_IP must be an IP address" >&2
  exit 2
fi
for cidr_name in KUBERNETES_API_ENDPOINT_CIDR KUBERNETES_API_CIDR; do
  cidr_value="${!cidr_name}"
  if [[ ! "$cidr_value" =~ ^[0-9A-Fa-f:.]+/[0-9]{1,3}$ || "$cidr_value" == "0.0.0.0/0" || "$cidr_value" == "::/0" ]]; then
    echo "install-doks-review-runtime: $cidr_name must be a concrete, non-default CIDR" >&2
    exit 2
  fi
done

# Never turn a previously active installation off as a side effect of a
# qualification install. Existing resources must already be absent or inert.
refuse_active_deployment() {
  local name="$1"
  local replicas
  replicas="$(kubectl -n "$namespace" get deployment "$name" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
  if [[ -n "$replicas" && "$replicas" != "0" ]]; then
    echo "install-doks-review-runtime: deployment $name already has replicas=$replicas; refusing to change active traffic" >&2
    exit 1
  fi
}

refuse_active_deployment ct-review-yeti-operator
refuse_active_deployment ct-review-job-dispatcher

# The dispatcher is allowed to start only with the exact database secret shape
# and the registry pull secret already present. Read names, never secret data.
# shellcheck disable=SC2016
secret_keys="$(kubectl -n "$namespace" get secret ct-review-job-dispatcher-runtime \
  -o go-template='{{range $key, $value := .data}}{{printf "%s\\n" $key}}{{end}}' | LC_ALL=C sort)"
if [[ "$secret_keys" != $'DATABASE_CA_CERT\nDATABASE_URL' ]]; then
  echo "install-doks-review-runtime: runtime secret must contain exactly DATABASE_CA_CERT and DATABASE_URL" >&2
  exit 2
fi
kubectl -n "$namespace" get secret calltelemetry >/dev/null

render_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$render_dir"
}
trap cleanup EXIT

kubectl apply --server-side -f k8s/namespace.yaml
kubectl apply --server-side -f k8s-operator/config/crd/bases/review-yeti.ai_prreviewjobs.yaml

# Restrict envsubst to the immutable image and exact DOKS API values used by
# the operator network policy. No ambient environment variable is rendered.
# shellcheck disable=SC2016
envsubst '${CT_REVIEW_OPERATOR_IMAGE} ${KUBERNETES_SERVICE_IP} ${KUBERNETES_API_ENDPOINT_CIDR} ${KUBERNETES_API_CIDR}' \
  < k8s/operator-deployment.yaml.tpl > "$render_dir/operator-deployment.yaml"
kubectl apply --server-side -f "$render_dir/operator-deployment.yaml"

export CT_REVIEW_JOB_DISPATCHER_IMAGE CT_REVIEW_WORKER_IMAGE
bash scripts/deploy-review-job-dispatcher.sh

operator_replicas="$(kubectl -n "$namespace" get deployment ct-review-yeti-operator -o jsonpath='{.spec.replicas}')"
dispatcher_replicas="$(kubectl -n "$namespace" get deployment ct-review-job-dispatcher -o jsonpath='{.spec.replicas}')"
if [[ "$operator_replicas" != "0" || "$dispatcher_replicas" != "0" ]]; then
  echo "install-doks-review-runtime: refused to accept a non-zero qualification deployment" >&2
  exit 1
fi

echo "DOKS review runtime installed at zero replicas; no queue consumption or review publication was activated."
