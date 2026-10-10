/**
 * The single CallTelemetry workflow allowed to dispatch an external App-gate
 * request through the central OIDC boundary. Keep these values pinned to the
 * protected caller workflow and its promoted reusable workflow; update this
 * authority only alongside a reviewed workflow-source change.
 */
export const TRUSTED_CENTRAL_ACTION_DISPATCH_CALLER = Object.freeze({
  repository: 'calltelemetry/ct-review-actions',
  repositoryId: 1339040553,
  repositoryOwnerId: 57884877,
  repositoryPrivate: true,
  appId: 4385771,
  eventNames: Object.freeze(['workflow_dispatch', 'repository_dispatch'] as const),
  ref: 'refs/heads/main',
  workflowRef: 'calltelemetry/ct-review-actions/.github/workflows/repository-dispatch.yml@refs/heads/main',
  workflowSha: 'e9ff216a33c5fddafe1295215f5eb58b19b8d610',
  jobWorkflowRef: 'calltelemetry/ct-review-actions/.github/workflows/review-yeti.yml@refs/heads/v1',
  jobWorkflowSha: 'e9ff216a33c5fddafe1295215f5eb58b19b8d610',
});
