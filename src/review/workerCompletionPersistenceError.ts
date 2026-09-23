/**
 * Finite, redacted locations within authoritative worker-completion
 * persistence. These are intentionally operational breadcrumbs only: no
 * database or worker-supplied details are allowed to cross this boundary.
 */
export const workerCompletionPersistenceStages = [
  'transaction-begin',
  'binding-lookup',
  'advisory-lock',
  'state-load',
  'trusted-completion-resolution',
  'gate-update',
  'completion-insert',
  'outbox-update',
  'run-update',
  'lifecycle-append',
  'eligible-completion-hook',
  'commit',
] as const;

export type WorkerCompletionPersistenceStage = typeof workerCompletionPersistenceStages[number];
export const unknownWorkerCompletionPersistenceStage = 'unknown' as const;

export const trustedCompletionResolutionSubstages = [
  'stored-policy', 'token', 'current-candidate', 'policy-refresh', 'exact-diff',
] as const;
export type TrustedCompletionResolutionSubstage = typeof trustedCompletionResolutionSubstages[number];

/**
 * Finite, service-owned reason classes for a trusted-completion failure.
 *
 * REL-1056: every failure in the exact-diff block previously collapsed into one
 * message, so a deterministic contract mismatch (a diff with no applicable
 * persona, or a file GitHub returns without a patch) was indistinguishable from
 * a transient read failure — it was logged as `persistence_unavailable` and
 * returned HTTP 503, telling the worker to retry forever against a condition
 * that can never succeed. These classes are safe to log and return: each is a
 * fixed token chosen by this service, never upstream text, a token, or payload.
 *
 * `deterministic` marks the classes where retrying cannot possibly help.
 */
export const trustedCompletionResolutionReasons = [
  'deadline',
  'identity-mismatch',
  'policy-mismatch',
  'bounds',
  'no-patch-file',
  'coverage-no-persona',
  'reader-unavailable',
  'unknown',
] as const;
export type TrustedCompletionResolutionReason = typeof trustedCompletionResolutionReasons[number];

/** Retrying cannot change the outcome for these classes. */
const deterministicReasons: ReadonlySet<TrustedCompletionResolutionReason> = new Set([
  'identity-mismatch', 'policy-mismatch', 'bounds', 'no-patch-file', 'coverage-no-persona',
]);

export function isDeterministicCompletionFailure(reason: TrustedCompletionResolutionReason | undefined): boolean {
  return reason !== undefined && deterministicReasons.has(reason);
}

/** Carries only a fixed service-owned location and reason, never an upstream cause. */
export class TrustedCompletionResolutionError extends Error {
  constructor(readonly substage: TrustedCompletionResolutionSubstage,
              readonly reason: TrustedCompletionResolutionReason = 'unknown') {
    super('Authoritative completion context unavailable');
    this.name = 'TrustedCompletionResolutionError';
  }
}

/**
 * Deliberately discards the caught error. The public error holds only a finite
 * stage and optional resolution substage, so API logging cannot retain SQL, tokens,
 * payloads, or customer data from a lower persistence layer.
 */
export class WorkerCompletionPersistenceError extends Error {
  readonly stage: WorkerCompletionPersistenceStage;
  readonly substage?: TrustedCompletionResolutionSubstage;
  /** REL-1056: finite service-owned class, safe to log and to return. */
  readonly reason?: TrustedCompletionResolutionReason;

  constructor(stage: WorkerCompletionPersistenceStage, substage?: TrustedCompletionResolutionSubstage,
              reason?: TrustedCompletionResolutionReason) {
    super(`Worker completion persistence failed at ${stage}`);
    this.name = 'WorkerCompletionPersistenceError';
    this.stage = stage;
    if (stage === 'trusted-completion-resolution' && substage !== undefined
      && trustedCompletionResolutionSubstages.includes(substage)) this.substage = substage;
    if (stage === 'trusted-completion-resolution' && reason !== undefined
      && trustedCompletionResolutionReasons.includes(reason)) this.reason = reason;
  }
}

export function isWorkerCompletionPersistenceError(error: unknown): error is WorkerCompletionPersistenceError {
  return error instanceof WorkerCompletionPersistenceError;
}
