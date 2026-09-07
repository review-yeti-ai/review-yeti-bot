#!/usr/bin/env bash
set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "deploy-action-dispatch: missing required command: $1" >&2
    exit 2
  }
}

need kubectl
need envsubst

: "${CT_REVIEW_DISPATCH_IMAGE:?set CT_REVIEW_DISPATCH_IMAGE to an immutable image@sha256:digest}"
: "${ACTION_DISPATCH_REPOSITORY_IDS:?set the explicit GitHub repository id allowlist}"
: "${ACTION_DISPATCH_OWNER_IDS:?set the explicit GitHub owner id allowlist}"
: "${ACTION_DISPATCH_WORKFLOW_REFS:?set the explicit GitHub workflow ref allowlist}"
: "${ACTION_DISPATCH_WORKFLOW_SHAS:?set the explicit GitHub workflow sha allowlist}"

if [[ ! "$CT_REVIEW_DISPATCH_IMAGE" =~ ^.+@sha256:[0-9a-fA-F]{64}$ ]]; then
  echo "deploy-action-dispatch: CT_REVIEW_DISPATCH_IMAGE must use an immutable sha256 digest (*@sha256:64_hex_chars)" >&2
  exit 2
fi
if [[ ! "$ACTION_DISPATCH_REPOSITORY_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "deploy-action-dispatch: repository ids must be an explicit comma-separated numeric allowlist" >&2
  exit 2
fi
if [[ ! "$ACTION_DISPATCH_OWNER_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  echo "deploy-action-dispatch: owner ids must be an explicit comma-separated numeric allowlist" >&2
  exit 2
fi
if [[ "$ACTION_DISPATCH_WORKFLOW_SHAS" != "*" && ! "$ACTION_DISPATCH_WORKFLOW_SHAS" =~ ^[0-9a-fA-F]{40}(,[0-9a-fA-F]{40})*$ ]]; then
  echo "deploy-action-dispatch: workflow shas must be * or an explicit comma-separated 40-hex allowlist" >&2
  exit 2
fi

render_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$render_dir"
}
trap cleanup EXIT

# No default. The manifest documents this as off-by-default and says to turn it on
# deliberately once the lane is proven, but defaulting it here to `true` silently
# overrode that on every deploy -- the safety default could never take effect,
# because envsubst always received a value. Defaulting to `false` instead would be
# the mirror-image bug: a routine redeploy would quietly disable publishing and
# reviews would stop appearing with nothing red to explain it.
#
# Both silent directions are wrong for a flag that decides whether reviews publish,
# so require the operator to say which one they mean.
if [[ -z "${ACTION_DISPATCH_ALLOW_APP_GATE:-}" ]]; then
  echo "deploy-action-dispatch: set ACTION_DISPATCH_ALLOW_APP_GATE=true|false explicitly." >&2
  echo "  true  -- admission accepts app-gate dispatches; the DOKS lane publishes reviews" >&2
  echo "  false -- app-gate dispatches are refused; receipt-only lanes are unaffected" >&2
  exit 2
fi
if [[ "$ACTION_DISPATCH_ALLOW_APP_GATE" != "true" && "$ACTION_DISPATCH_ALLOW_APP_GATE" != "false" ]]; then
  echo "deploy-action-dispatch: ACTION_DISPATCH_ALLOW_APP_GATE must be exactly true or false" >&2
  exit 2
fi
echo "deploy-action-dispatch: app-gate admission = ${ACTION_DISPATCH_ALLOW_APP_GATE}"

envsubst '${CT_REVIEW_DISPATCH_IMAGE} ${ACTION_DISPATCH_REPOSITORY_IDS} ${ACTION_DISPATCH_OWNER_IDS} ${ACTION_DISPATCH_WORKFLOW_REFS} ${ACTION_DISPATCH_WORKFLOW_SHAS} ${ACTION_DISPATCH_ALLOW_APP_GATE}' \
  < k8s/action-dispatch.yaml.tpl > "$render_dir/action-dispatch.yaml"

kubectl apply --server-side -f k8s/namespace.yaml
kubectl -n ct-review-system get secret ct-review-action-dispatch-runtime >/dev/null
kubectl -n ct-review-system get secret calltelemetry >/dev/null
kubectl apply --server-side -f "$render_dir/action-dispatch.yaml"
kubectl -n ct-review-system rollout status deployment/ct-review-action-dispatch --timeout=3m
kubectl -n ct-review-system wait --for=condition=ready pod \
  -l app.kubernetes.io/name=ct-review-action-dispatch --timeout=2m

echo "Admission-only Action dispatch deployment is ready."
