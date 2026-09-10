#!/usr/bin/env bash
# Single source of truth for rendering k8s/review-job-dispatcher.yaml.tpl.
#
# Used by the installation boundary in deploy-review-job-dispatcher.sh.
# Active worker upgrades use key-only CAS, not template application.
# Keep the install substitution list here to reject literal placeholders.
#
# shellcheck disable=SC2016
REVIEW_JOB_DISPATCHER_ENVSUBST_VARS='${CT_REVIEW_JOB_DISPATCHER_IMAGE} ${CT_REVIEW_WORKER_IMAGE} ${CT_REVIEW_RUNNER_MODE}'
readonly REVIEW_JOB_DISPATCHER_ENVSUBST_VARS

# render_review_job_dispatcher_template <template> <output>
# Expands exactly the variables above (all three must be exported by the caller).
render_review_job_dispatcher_template() {
  local template="$1" output="$2" name
  for name in CT_REVIEW_JOB_DISPATCHER_IMAGE CT_REVIEW_WORKER_IMAGE CT_REVIEW_RUNNER_MODE; do
    if [[ -z "${!name:-}" ]]; then
      echo "render_review_job_dispatcher_template: ${name} must be exported before rendering" >&2
      return 2
    fi
  done
  envsubst "$REVIEW_JOB_DISPATCHER_ENVSUBST_VARS" < "$template" > "$output"
  # shellcheck source=scripts/lib/assert-rendered.sh
  source "$(dirname "${BASH_SOURCE[0]}")/assert-rendered.sh"
  assert_no_unsubstituted_placeholders "$output" render_review_job_dispatcher_template
}
