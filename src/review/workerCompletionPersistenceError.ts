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

/** Carries only a fixed service-owned location, never an upstream cause. */
export class TrustedCompletionResolutionError extends Error {
  constructor(readonly substage: TrustedCompletionResolutionSubstage) {
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

  constructor(stage: WorkerCompletionPersistenceStage, substage?: TrustedCompletionResolutionSubstage) {
    super(`Worker completion persistence failed at ${stage}`);
    this.name = 'WorkerCompletionPersistenceError';
    this.stage = stage;
    if (stage === 'trusted-completion-resolution' && substage !== undefined
      && trustedCompletionResolutionSubstages.includes(substage)) this.substage = substage;
  }
}

export function isWorkerCompletionPersistenceError(error: unknown): error is WorkerCompletionPersistenceError {
  return error instanceof WorkerCompletionPersistenceError;
}
