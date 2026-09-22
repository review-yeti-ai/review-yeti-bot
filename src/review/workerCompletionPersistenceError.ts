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

/**
 * Deliberately discards the caught error. The public error holds only one
 * finite stage, so API logging cannot accidentally retain SQL, tokens,
 * payloads, or customer data from a lower persistence layer.
 */
export class WorkerCompletionPersistenceError extends Error {
  readonly stage: WorkerCompletionPersistenceStage;

  constructor(stage: WorkerCompletionPersistenceStage) {
    super(`Worker completion persistence failed at ${stage}`);
    this.name = 'WorkerCompletionPersistenceError';
    this.stage = stage;
  }
}

export function isWorkerCompletionPersistenceError(error: unknown): error is WorkerCompletionPersistenceError {
  return error instanceof WorkerCompletionPersistenceError;
}
