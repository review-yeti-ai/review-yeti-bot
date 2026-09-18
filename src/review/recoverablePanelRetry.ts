import { sha256 } from './reviewCore';
import { TERMINAL_DEADLINE_MS } from '../config/terminalDeadline';
import { RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS, isRecoverablePanelRetryEligible } from './publicationFailurePolicy';
import type { ReviewAdmission, ReviewAdmissionInput, ReviewRunIdentity, PublicationMode } from './reviewRun';
import type { WorkerTerminalFailure } from './workerCompletion';

/** Narrow run context the retry decision needs, independent of the full
 * persisted `review_runs` row shape. */
export interface RunRetryContext {
  publicationMode: PublicationMode;
  authoritativeGateAppId: number | null;
  repositoryId: number;
  installationId: number;
  identity: ReviewRunIdentity;
}

/**
 * The exact repository surface `requeueRecoverableIncompletePanelFailure`
 * needs. Kept narrow and separate from the full `ReviewDispatchRepository` so
 * this service can be unit-tested against a fake without a database.
 */
export interface RecoverablePanelRetryRepository {
  admit(input: ReviewAdmissionInput): Promise<ReviewAdmission>;
  /** Read-only lookup of the run's current retry-relevant metadata. Returns
   * `null` when the run no longer exists. */
  readRunRetryContext(runId: string): Promise<RunRetryContext | null>;
}

export interface RecoverablePanelRetryLogger {
  error(message: string, meta: Record<string, unknown>): void;
}

export interface RequeueRecoverableIncompletePanelFailureOptions {
  input: WorkerTerminalFailure;
  now: number;
  repository: RecoverablePanelRetryRepository;
  logger: RecoverablePanelRetryLogger;
}

/**
 * Bounded automatic recovery for a recoverable-incomplete-panel terminal
 * failure (REL-620). Re-queues the exact same review identity for a fresh
 * execution attempt through the identical admission path the manual
 * exact-head refresh uses (`retryRequested` + `retryAfterExecutionAttempt`),
 * so the same durable eligibility fence -- an outbox row proving this exact
 * attempt actually ran -- governs both. A no-op for every other failure
 * class, for a non-app-gate run, for an authoritative-gate run (its
 * `authoritativeGateAppId` is never null, so it is excluded below in addition
 * to `markWorkerFailure` never transitioning one), and once the attempt cap
 * is reached.
 *
 * This is the review/dispatch *service* layer, not the persistence layer: it
 * owns the decision of whether to re-admit and the shape of the admission
 * payload. Callers (currently the worker-completion HTTP handler) invoke it
 * only after `repository.markWorkerFailure` durably transitions a run to
 * `'failed'`, exactly as they would any other post-transition side effect.
 * A failed re-admission must never surface as a completion-callback error --
 * the worker's terminal failure is already durably recorded; losing the
 * automatic retry only means this run needs its exact-head manual refresh
 * instead, exactly as it did before REL-620 -- so this function swallows and
 * logs its own `admit` failure rather than throwing.
 */
export async function requeueRecoverableIncompletePanelFailure(
  options: RequeueRecoverableIncompletePanelFailureOptions,
): Promise<void> {
  const { input, now, repository, logger } = options;
  if (input.diagnostics?.recoverableIncompletePanel !== true) return;
  if (!isRecoverablePanelRetryEligible(input.executionAttempt)) return;
  const context = await repository.readRunRetryContext(input.runId);
  if (!context) return;
  if (context.publicationMode !== 'app-gate' || context.authoritativeGateAppId != null) return;
  const isProvider5xx = input.diagnostics?.reason === 'provider_5xx';
  const delayMs = isProvider5xx
    ? Math.min(300_000, 15_000 * Math.pow(2, Math.max(0, input.executionAttempt - 1)))
    : RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS;
  const receivedAt = now;
  try {
    await repository.admit({
      deliveryId: `internal-recoverable-panel-retry:${input.runId}:a${input.executionAttempt}`,
      eventName: isProvider5xx ? 'internal_provider_5xx_retry' : 'internal_recoverable_panel_retry',
      repositoryId: context.repositoryId,
      installationId: context.installationId,
      receivedAt,
      terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
      payloadDigest: sha256({ runId: input.runId, executionAttempt: input.executionAttempt,
        reason: isProvider5xx ? 'provider_5xx' : 'recoverable_incomplete_panel' }),
      publicationMode: 'app-gate',
      centralActionDispatch: false,
      retryRequested: true,
      retryAfterExecutionAttempt: input.executionAttempt,
      availableAt: receivedAt + delayMs,
      identity: context.identity,
    });
  } catch (error) {
    logger.error('Automatic recoverable-panel retry admission failed', {
      runId: input.runId,
      executionAttempt: input.executionAttempt,
      reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
  }
}
