#!/usr/bin/env bash
set -euo pipefail

workflow=.github/workflows/worker-parity-qualification.yml

test -f "$workflow"
grep -Fq 'workflow_dispatch:' "$workflow"
grep -Eq '^    timeout-minutes: 15$' "$workflow"
grep -Fq 'contents: read' "$workflow"
grep -Fq 'pull-requests: read' "$workflow"
grep -Fq 'registry\.digitalocean\.com/exampleorg/review-yeti-worker@sha256:' "$workflow"
grep -Fq 'REVIEW_SAME_HEAD_QUALIFICATION_ONLY=true' "$workflow"
grep -Fq 'REVIEW_PUBLICATION_MODE=disabled' "$workflow"
grep -Fq 'REVIEW_QUALIFICATION_PROVIDER_ID=openrouter' "$workflow"
grep -Fq 'deepseek/deepseek-v4-flash-0731' "$workflow"
grep -Fq -- '--platform linux/amd64' "$workflow"
grep -Fq -- '--read-only' "$workflow"
grep -Fq 'REVIEW_ENGINE_REVISION' "$workflow"
grep -Fq 'githubWrites == 0' "$workflow"
grep -Fq 'actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f' "$workflow"

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

if grep -Eq 'issues: write|pull-requests: write|contents: write|continue-on-error: true' "$workflow"; then
  echo 'worker parity qualification must remain read-only and fail closed' >&2
  exit 1
fi
if grep -Eq 'openrouter/auto|model: auto|publicationMode: enabled' "$workflow"; then
  echo 'worker parity qualification must use the direct model and disabled publication' >&2
  exit 1
fi

echo 'worker parity qualification contract passed'
