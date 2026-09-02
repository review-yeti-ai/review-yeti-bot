#!/usr/bin/env bash
set -euo pipefail

workflow=.github/workflows/worker-parity-qualification.yml
target_validator=scripts/validate-worker-parity-target.sh
receipt_validator=scripts/verify-worker-parity-receipt.sh

test -f "$workflow"
test -x "$target_validator"
test -x "$receipt_validator"
grep -Fq 'workflow_dispatch:' "$workflow"
grep -Eq '^    timeout-minutes: 15$' "$workflow"
grep -Fq 'contents: read' "$workflow"
grep -Fq 'pull-requests: read' "$workflow"
grep -Fq 'repo_owner:' "$workflow"
grep -Fq 'repo_name:' "$workflow"
grep -Fq 'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1' "$workflow"
grep -Fq 'permission-contents: read' "$workflow"
grep -Fq 'permission-pull-requests: read' "$workflow"
grep -Fq 'GH_TOKEN: ${{ steps.parity-token.outputs.token }}' "$workflow"
grep -Fq 'REVIEW_REPO: ${{ inputs.repo_owner }}/${{ inputs.repo_name }}' "$workflow"
grep -Fq 'scripts/validate-worker-parity-target.sh' "$workflow"
grep -Fq 'scripts/verify-worker-parity-receipt.sh' "$workflow"
grep -Fq 'registry\.digitalocean\.com/exampleorg/review-yeti-worker@sha256:' "$target_validator"
grep -Fq 'REVIEW_SAME_HEAD_QUALIFICATION_ONLY=true' "$workflow"
grep -Fq 'REVIEW_RECEIPT_PATH=/workspace/.review-yeti/receipt.json' "$workflow"
grep -Fq 'REVIEW_PUBLICATION_MODE=disabled' "$workflow"
grep -Fq 'REVIEW_QUALIFICATION_PROVIDER_ID=openrouter' "$workflow"
grep -Fq 'deepseek/deepseek-v4-flash-0731' "$workflow"
grep -Fq -- '--platform linux/amd64' "$workflow"
grep -Fq -- '--read-only' "$workflow"
grep -Fq 'REVIEW_ENGINE_REVISION' "$workflow"
grep -Fq 'githubWrites == 0' "$receipt_validator"
grep -Fq 'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f' "$workflow"
dollar='$'
grep -Fq "path: ${dollar}{{ runner.temp }}/review-yeti-worker-parity/.review-yeti/receipt.json" "$workflow"

WORKFLOW_PATH="$workflow" ruby <<'RUBY'
require 'yaml'

def validate_workflow(workflow)
  triggers = workflow['on'] || workflow[true]
  unless triggers.is_a?(Hash) && triggers.keys.map(&:to_s) == ['workflow_dispatch']
    raise 'worker parity qualification must contain only the manual workflow_dispatch trigger'
  end

  publication_values = []
  visit = lambda do |node|
    case node
    when Hash
      node.each do |key, value|
        publication_values << value.to_s if key.to_s == 'REVIEW_PUBLICATION_MODE'
        visit.call(value)
      end
    when Array
      node.each { |value| visit.call(value) }
    when String
      matches = node.scan(/REVIEW_PUBLICATION_MODE(?:\s*[:=]\s*|\s+)([A-Za-z0-9_-]+)/)
      if node.include?('REVIEW_PUBLICATION_MODE') && matches.empty?
        raise 'REVIEW_PUBLICATION_MODE must always carry an explicit value'
      end
      publication_values.concat(matches.flatten)
    end
  end
  visit.call(workflow)
  unless !publication_values.empty? && publication_values.all? { |value| value == 'disabled' }
    raise 'every REVIEW_PUBLICATION_MODE assignment must be disabled'
  end
end

def expect_rejection(source, message)
  validate_workflow(YAML.safe_load(source, aliases: false))
rescue RuntimeError => error
  raise error unless error.message.include?(message)
else
  raise 'structural workflow validator accepted a forbidden variant'
end

validate_workflow(YAML.safe_load(File.read(ENV.fetch('WORKFLOW_PATH')), aliases: false))
expect_rejection(<<~YAML, 'only the manual workflow_dispatch trigger')
  on: [workflow_dispatch, schedule]
  jobs:
    qualify:
      steps:
        - run: docker run --env REVIEW_PUBLICATION_MODE=disabled image
YAML
expect_rejection(<<~YAML, 'every REVIEW_PUBLICATION_MODE assignment must be disabled')
  on:
    workflow_dispatch: {}
  jobs:
    qualify:
      steps:
        - run: docker run --env REVIEW_PUBLICATION_MODE=enabled image
YAML
RUBY

if grep -Eq 'issues: write|pull-requests: write|contents: write|continue-on-error: true|--env [A-Z_]*PRIVATE_KEY' "$workflow"; then
  echo 'worker parity qualification must remain read-only and fail closed' >&2
  exit 1
fi
if grep -Eq 'openrouter/auto|model: auto|publicationMode: enabled' "$workflow"; then
  echo 'worker parity qualification must use the direct model and disabled publication' >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
mkdir -p "$tmp_dir/bin"
cat > "$tmp_dir/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'/pulls/'*) printf '%s\n' "${FAKE_PULL_IDENTITY:?}" ;;
  *) printf '%s\n' "${FAKE_REPOSITORY_ID:?}" ;;
esac
SH
chmod +x "$tmp_dir/bin/gh"

base_sha="$(printf 'a%.0s' {1..40})"
head_sha="$(printf 'b%.0s' {1..40})"
worker_image="registry.digitalocean.com/exampleorg/review-yeti-worker@sha256:$(printf 'c%.0s' {1..64})"
target_env=(
  "PATH=$tmp_dir/bin:$PATH"
  'GH_TOKEN=ghs_test'
  "GITHUB_OUTPUT=$tmp_dir/output"
  'CONFIRM=PARITY'
  'TARGET_OWNER=exampleorg'
  'TARGET_REPOSITORY=fixture-repo'
  'PR_NUMBER=5'
  "EXPECTED_BASE_SHA=$base_sha"
  "EXPECTED_HEAD_SHA=$head_sha"
  "WORKER_IMAGE=$worker_image"
  "FAKE_PULL_IDENTITY=$base_sha"$'\t'"$head_sha"
  'FAKE_REPOSITORY_ID=12345'
)
env "${target_env[@]}" "$target_validator"
grep -Fxq 'repository_id=12345' "$tmp_dir/output"
if env "${target_env[@]}" TARGET_OWNER=outside "$target_validator" >/dev/null 2>&1; then
  echo 'target validator accepted an outside owner' >&2
  exit 1
fi
if env "${target_env[@]}" TARGET_REPOSITORY='../escape' "$target_validator" >/dev/null 2>&1; then
  echo 'target validator accepted an invalid repository name' >&2
  exit 1
fi
if env "${target_env[@]}" FAKE_PULL_IDENTITY="$base_sha"$'\t'"$(printf 'd%.0s' {1..40})" \
  "$target_validator" >/dev/null 2>&1; then
  echo 'target validator accepted a moved head' >&2
  exit 1
fi

jq -n --arg engine "${worker_image##*@sha256:}" --arg base "$base_sha" --arg head "$head_sha" '{
  version: "ReviewYetiPanelQualification.v1", profile: "same-head", status: "succeeded",
  source: "github-pull-request", publicationMode: "disabled", engineRevision: $engine,
  repo: "exampleorg/fixture-repo", repositoryId: 12345, baseSha: $base, headSha: $head,
  providerId: "openrouter", requestedModel: "deepseek/deepseek-v4-flash-0731",
  githubReads: 3, githubWrites: 0, personaCount: 6, expectedPersonaCount: 6,
  optionalFailureCount: 0, quorumSatisfied: true, findingsCount: 1,
  findingFingerprintVersion: "ReviewYetiFindingFingerprint.v1",
  findingFingerprints: [{severity: "P1", anchorDigest: "a", contentDigest: "b"}],
  laneAttribution: [range(0; 8) | {lane: .}]
}' > "$tmp_dir/receipt.json"
receipt_env=(
  "RECEIPT_PATH=$tmp_dir/receipt.json"
  "WORKER_IMAGE=$worker_image"
  'EXPECTED_REPO=exampleorg/fixture-repo'
  'EXPECTED_REPOSITORY_ID=12345'
  "EXPECTED_BASE_SHA=$base_sha"
  "EXPECTED_HEAD_SHA=$head_sha"
)
env "${receipt_env[@]}" "$receipt_validator"
jq '.repo = "exampleorg/wrong"' "$tmp_dir/receipt.json" > "$tmp_dir/wrong-receipt.json"
if env "${receipt_env[@]}" RECEIPT_PATH="$tmp_dir/wrong-receipt.json" \
  "$receipt_validator" >/dev/null 2>&1; then
  echo 'receipt validator accepted a mismatched repository' >&2
  exit 1
fi

echo 'worker parity qualification contract passed'
