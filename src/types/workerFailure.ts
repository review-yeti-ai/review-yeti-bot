/**
 * Canonical coded worker/persona-lane failure classes.
 *
 * This is the single neutral home for the closed set of reasons a review lane can fail closed --
 * shared by the panel domain (`PanelResult.optionalFailures[].failureClass` in `../panel/types`,
 * and `classifyPersonaAttemptFailure` in `../panel/panelEngine`) and the worker-completion/HTTP
 * boundary (`WorkerTerminalFailure.failureClass` in `../review/workerCompletion`). Previously
 * `../panel/types` imported this type from `../review/workerCompletion`, a boundary module with
 * its own documented "no dependency on GitHub/gateway transport types" contract -- a domain type
 * reaching into a boundary module for a plain value type (REL-892 finding 3). Moving the type here
 * lets both sides import it without either depending on the other.
 *
 * Deliberately dependency-free: this module must never import from `../panel/*`, `../review/*`,
 * or `../gateway/*`. `../review/workerCompletion` re-exports both names from here for external
 * callers that already import them from that path.
 */
export const workerFailureClasses = [
  'contract',
  'timeout',
  'budget_exhausted',
  'auth',
  'rate_limit',
  'transport',
  'provider_error',
  'malformed_output',
  'internal_error',
] as const;

export type WorkerFailureClass = typeof workerFailureClasses[number];
