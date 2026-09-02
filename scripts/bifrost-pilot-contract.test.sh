#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/bifrost-pilot-settings.sh
source "$repo_root/scripts/bifrost-pilot-settings.sh"
values_file="$repo_root/deploy/bifrost-pilot/values.yaml"
namespace_file="$repo_root/deploy/bifrost-pilot/namespace.yaml"

command -v helm >/dev/null

bash -n "$repo_root/scripts/materialize-bifrost-runtime.sh"
bash -n "$repo_root/scripts/deploy-bifrost-pilot.sh"

rendered="$(
  helm template "$BIFROST_PILOT_RELEASE" "$BIFROST_PILOT_CHART" \
    --version "$BIFROST_PILOT_CHART_VERSION" \
    --namespace "$BIFROST_PILOT_NAMESPACE" \
    --values "$values_file"
)"

config_json="$(
  awk '
    $0 == "  config.json: |" {
      getline
      sub(/^    /, "")
      print
      exit
    }
  ' <<<"$rendered"
)"

if ! jq -e '
  (.providers | keys) == ["ollama"] and
  (.providers.ollama.concurrency_and_buffer_size == {"buffer_size": 100, "concurrency": 10}) and
  (.client.allow_direct_keys == false) and
  (.client.disable_content_logging == true) and
  (.client.enforce_auth_on_inference == true) and
  ([.plugins[] | select(.name == "logging") | .config.disable_content_logging] == [true]) and
  ([.plugins[] | select(.name == "governance") | .config.is_vk_mandatory] == [true]) and
  (has("disable_auth_on_inference") | not)
' >/dev/null <<<"$config_json"; then
  echo 'rendered config must contain exactly the bounded Ollama provider' >&2
  exit 1
fi

expected_sources="$(printf '%s\n' \
  'bifrost/templates/configmap.yaml' \
  'bifrost/templates/deployment.yaml' \
  'bifrost/templates/ingress.yaml' \
  'bifrost/templates/service.yaml' \
  'bifrost/templates/serviceaccount.yaml')"
rendered_sources="$(sed -n 's/^# Source: //p' <<<"$rendered" | sort)"
if [[ "$rendered_sources" != "$expected_sources" ]]; then
  echo 'rendered manifest contains an unexpected workload or dependency' >&2
  diff -u <(printf '%s\n' "$expected_sources") <(printf '%s\n' "$rendered_sources") >&2 || true
  exit 1
fi

expect() {
  local pattern="$1"
  if ! grep -Eq -- "$pattern" <<<"$rendered"; then
    echo "missing required rendered contract: $pattern" >&2
    exit 1
  fi
}

reject() {
  local pattern="$1"
  if grep -Eq -- "$pattern" <<<"$rendered"; then
    echo "forbidden rendered contract present: $pattern" >&2
    exit 1
  fi
}

expect '^[[:space:]]+replicas: 1$'
expect '^[[:space:]]+type: Recreate$'
expect '^[[:space:]]+image: "docker.io/maximhq/bifrost:v1\.5\.13@sha256:424907512de223022836d6e61ff4e83bdcf0ad19a2caea1684663ae2ed23d91f"$'
expect '^[[:space:]]+cpu: 500m$'
expect '^[[:space:]]+memory: 512Mi$'
expect '^[[:space:]]+cpu: "1"$'
expect '^[[:space:]]+memory: 1Gi$'
expect '^[[:space:]]+- name: OLLAMA_API_KEY$'
expect '^[[:space:]]+- name: BIFROST_POSTGRES_PASSWORD$'
expect '^[[:space:]]+- name: BIFROST_ENCRYPTION_KEY$'
expect '^[[:space:]]+- name: BIFROST_ADMIN_USERNAME$'
expect '^[[:space:]]+- name: BIFROST_ADMIN_PASSWORD$'
expect '^[[:space:]]+- host: "llm-gateway\.exampleorg\.com"$'
expect '^automountServiceAccountToken: false$'
expect '^[[:space:]]+allowPrivilegeEscalation: false$'
expect '^[[:space:]]+seccompProfile:$'
expect '^[[:space:]]+type: RuntimeDefault$'

reject '^kind: StatefulSet$'
reject '^kind: PersistentVolumeClaim$'

grep -Eq '^  name: ct-llm-gateway$' "$namespace_file"
grep -Eq '^    requests.cpu: 600m$' "$namespace_file"
grep -Eq '^    requests.memory: 640Mi$' "$namespace_file"
grep -Eq '^    limits.cpu: 1200m$' "$namespace_file"
grep -Eq '^    limits.memory: 1280Mi$' "$namespace_file"
grep -Eq '^    persistentvolumeclaims: "0"$' "$namespace_file"

if [[ "${BIFROST_CONTRACT_RENDER_ONLY:-}" == "1" ]]; then
  echo "Bifrost pilot render contract passed"
  exit 0
fi

deploy_script="$repo_root/scripts/deploy-bifrost-pilot.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
export BIFROST_TEST_LOG="$test_dir/invocations.log"
deployment_output="$test_dir/deploy-output.log"
BIFROST_TEST_REAL_HELM="$(command -v helm)"
export BIFROST_TEST_REAL_HELM
export BIFROST_TEST_OLLAMA='test-ollama-credential-1e4426'
export BIFROST_TEST_POSTGRES='test-postgres-credential-8e0ad7'
export BIFROST_TEST_ENCRYPTION='test-encryption-credential-dd3342'
export BIFROST_TEST_SETUP='test-setup-credential-0b4aba'
export BIFROST_TEST_ADMIN_USER='test-admin-user-b4475e'
export BIFROST_TEST_ADMIN_PASSWORD='test-admin-password-af70b3'
export BIFROST_TEST_DOPPLER_TOKEN='dp.st.test-read-token-76ec9c'
export BIFROST_TEST_DOPPLER_SLUG='test-read-token-slug'
test_bin="$test_dir/bin"
mkdir -p "$test_bin"

cat >"$test_bin/helm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    *"$BIFROST_TEST_OLLAMA"*|*"$BIFROST_TEST_POSTGRES"*|*"$BIFROST_TEST_ENCRYPTION"*|*"$BIFROST_TEST_SETUP"*|*"$BIFROST_TEST_ADMIN_USER"*|*"$BIFROST_TEST_ADMIN_PASSWORD"*|*"$BIFROST_TEST_DOPPLER_TOKEN"*)
      echo 'secret material appeared in a helm argument' >&2
      exit 90
      ;;
  esac
done
if [[ "${1:-}" == "template" ]]; then
  exec "$BIFROST_TEST_REAL_HELM" "$@"
fi
if [[ "${1:-}" == "upgrade" ]]; then
  printf '%s\n' helm_upgraded >>"$BIFROST_TEST_LOG"
fi
EOF

cat >"$test_bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    *"$BIFROST_TEST_OLLAMA"*|*"$BIFROST_TEST_POSTGRES"*|*"$BIFROST_TEST_ENCRYPTION"*|*"$BIFROST_TEST_SETUP"*|*"$BIFROST_TEST_ADMIN_USER"*|*"$BIFROST_TEST_ADMIN_PASSWORD"*|*"$BIFROST_TEST_DOPPLER_TOKEN"*)
      echo 'secret material appeared in a kubectl argument' >&2
      exit 90
      ;;
  esac
done
if [[ "${1:-}" == "config" && "${2:-}" == "current-context" ]]; then
  printf '%s\n' do-nyc1-cluster-ny1
  exit 0
fi
if [[ "${1:-}" == "apply" && "${2:-}" == "--filename" && "${3:-}" == "-" ]]; then
  manifest="$(cat)"
  if ! jq -e \
    --arg ollama "$BIFROST_TEST_OLLAMA" \
    --arg postgres "$BIFROST_TEST_POSTGRES" \
    --arg encryption "$BIFROST_TEST_ENCRYPTION" \
    --arg setup "$BIFROST_TEST_SETUP" \
    --arg admin_user "$BIFROST_TEST_ADMIN_USER" \
    --arg admin_password "$BIFROST_TEST_ADMIN_PASSWORD" '
      .kind == "Secret" and
      .metadata.name == "bifrost-runtime" and
      .metadata.namespace == "ct-llm-gateway" and
      (.data | keys) == [
        "admin-password",
        "admin-username",
        "encryption-key",
        "ollama-api-key",
        "postgres-password",
        "setup-token"
      ] and
      .data["ollama-api-key"] == ($ollama | @base64) and
      .data["postgres-password"] == ($postgres | @base64) and
      .data["encryption-key"] == ($encryption | @base64) and
      .data["setup-token"] == ($setup | @base64) and
      .data["admin-username"] == ($admin_user | @base64) and
      .data["admin-password"] == ($admin_password | @base64)
    ' >/dev/null <<<"$manifest"; then
    echo 'runtime secret was not materialized exclusively through stdin' >&2
    exit 91
  fi
  printf '%s\n' runtime_secret_applied >>"$BIFROST_TEST_LOG"
  exit 0
fi
if [[ "${1:-}" == "rollout" && "${2:-}" == "status" ]]; then
  printf '%s\n' rollout_checked >>"$BIFROST_TEST_LOG"
fi
EOF

cat >"$test_bin/doppler" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    *"$BIFROST_TEST_OLLAMA"*|*"$BIFROST_TEST_POSTGRES"*|*"$BIFROST_TEST_ENCRYPTION"*|*"$BIFROST_TEST_SETUP"*|*"$BIFROST_TEST_ADMIN_USER"*|*"$BIFROST_TEST_ADMIN_PASSWORD"*|*"$BIFROST_TEST_DOPPLER_TOKEN"*)
      echo 'secret material appeared in a doppler argument' >&2
      exit 90
      ;;
  esac
done
if [[ "${1:-}" == "configs" && "${2:-}" == "tokens" && "${3:-}" == "create" ]]; then
  [[ " $* " == *' --access read '* ]]
  [[ " $* " == *' --max-age 15m '* ]]
  printf '%s\n' doppler_read_token_created >>"$BIFROST_TEST_LOG"
  jq -cn --arg token "$BIFROST_TEST_DOPPLER_TOKEN" --arg slug "$BIFROST_TEST_DOPPLER_SLUG" '{token:$token,slug:$slug}'
  exit 0
fi
if [[ "${1:-}" == "configs" && "${2:-}" == "tokens" && "${3:-}" == "revoke" ]]; then
  [[ " $* " == *" --slug $BIFROST_TEST_DOPPLER_SLUG "* ]]
  printf '%s\n' doppler_token_revoked >>"$BIFROST_TEST_LOG"
  exit 0
fi
if [[ "${1:-}" == "run" ]]; then
  [[ "${DOPPLER_TOKEN:-}" == "$BIFROST_TEST_DOPPLER_TOKEN" ]]
  printf '%s\n' doppler_run_env_only >>"$BIFROST_TEST_LOG"
  while [[ "${1:-}" != "--" ]]; do shift; done
  shift
  OLLAMA_API_KEY="$BIFROST_TEST_OLLAMA" \
    BIFROST_POSTGRES_PASSWORD="$BIFROST_TEST_POSTGRES" \
    BIFROST_ENCRYPTION_KEY="$BIFROST_TEST_ENCRYPTION" \
    BIFROST_SETUP_TOKEN="$BIFROST_TEST_SETUP" \
    BIFROST_ADMIN_USERNAME="$BIFROST_TEST_ADMIN_USER" \
    BIFROST_ADMIN_PASSWORD="$BIFROST_TEST_ADMIN_PASSWORD" \
    "$@"
  exit 0
fi
echo "unexpected doppler invocation: $*" >&2
exit 92
EOF

chmod +x "$test_bin/helm" "$test_bin/kubectl" "$test_bin/doppler"

(
  unset DOPPLER_TOKEN
  PATH="$test_bin:$PATH" \
    BIFROST_CONTRACT_RENDER_ONLY=1 \
    DEPLOY_BIFROST_PILOT=YES \
    "$deploy_script"
) >"$deployment_output" 2>&1

for expected_event in \
  doppler_read_token_created \
  doppler_run_env_only \
  runtime_secret_applied \
  doppler_token_revoked \
  helm_upgraded \
  rollout_checked; do
  grep -Fxq "$expected_event" "$BIFROST_TEST_LOG"
done

for secret in \
  "$BIFROST_TEST_OLLAMA" \
  "$BIFROST_TEST_POSTGRES" \
  "$BIFROST_TEST_ENCRYPTION" \
  "$BIFROST_TEST_SETUP" \
  "$BIFROST_TEST_ADMIN_USER" \
  "$BIFROST_TEST_ADMIN_PASSWORD" \
  "$BIFROST_TEST_DOPPLER_TOKEN"; do
  if grep -Fq "$secret" "$deployment_output" || grep -Fq "$secret" "$BIFROST_TEST_LOG"; then
    echo 'secret material leaked into deployment output or invocation logs' >&2
    exit 1
  fi
done

echo "Bifrost pilot contract passed"
