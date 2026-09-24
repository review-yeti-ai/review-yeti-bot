import { sha256 } from './reviewCore';
import { TERMINAL_DEADLINE_MS } from '../config/terminalDeadline';
import {
  RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS,
  infrastructureRetryDelayMs,
  isInfrastructureIncompleteResult,
  isRecoverablePanelRetryEligible,
} from './publicationFailurePolicy';
import { deriveReviewRunId } from './reviewAdmission';
import { reviewGateErrorText } from './reviewGatePolicy';
import type { WorkerReviewCompletion } from './workerReviewCompletion';
import type { AuthoritativeReviewAdmission } from './authoritativeServiceContracts';
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
  /** REL-1113: the run's durable status and error text after its terminal transition. The
   * authoritative completion path records `failed` / `review gate: <reason>`. */
  runStatus?: string;
  errorText?: string;
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

/** REL-1113: the error text the authoritative completion records for an
 * `infrastructure-failure` gate decision, from the recording side's own definition. */
export const AUTHORITATIVE_INFRASTRUCTURE_FAILURE_ERROR_TEXT = reviewGateErrorText('infrastructure-failure');

export interface RequeueAuthoritativeInfrastructureIncompleteOptions {
  event: WorkerReviewCompletion;
  now: number;
  repository: RecoverablePanelRetryRepository;
  authoritative: Pick<AuthoritativeReviewAdmission, 'expectedAppId' | 'acceptNewRequests' | 'repositoryIds' | 'resolver'>;
  logger: RecoverablePanelRetryLogger & { info?(message: string, meta: Record<string, unknown>): void };
}

export type AuthoritativeInfrastructureRequeueOutcome =
  | 'not-infrastructure-incomplete'
  | 'attempts-exhausted'
  | 'run-not-infrastructure-failure'
  | 'admission-paused'
  | 'candidate-changed'
  | 'requeued'
  | 'admission-failed';

/**
 * REL-1113: bounded automatic re-attempt for an AUTHORITATIVE review whose
 * lanes failed on infrastructure (a gateway 502, a reset connection) with no
 * finding anywhere. Before this, such a run was recorded as the gate decision
 * `infrastructure-failure`, published by the worker as "Review Yeti: BLOCK",
 * and never re-run: `requeueRecoverableIncompletePanelFailure` above excludes
 * authoritative runs, and the job itself completed, so no attempt retry fired.
 *
 * Re-admission is the SAME exact-head recovery the signed "re-run" check
 * action performs (`githubWebhookAdmission`): the service re-reads the current
 * candidate and prepared policy through its own resolver, refuses when the
 * pull request moved (a superseded head is never re-reviewed), and admits with
 * `retryRequested` bound to the attempt that just failed, so the repository's
 * durable eligibility fence -- an outbox row proving this exact attempt ran --
 * governs both paths.
 *
 * Retried only when all hold: the worker-reported result satisfies the shared
 * `isInfrastructureIncompleteResult` decision (the same function the worker
 * used to title its check INCOMPLETE); the attempt is within the automatic
 * cap; and the service itself durably recorded this run as an
 * `infrastructure-failure` (never a findings BLOCK, invalid evidence, a
 * timeout or a supersession). A failed re-admission is logged, never thrown:
 * the failure is already durably recorded and the manual re-run remains.
 */
export async function requeueAuthoritativeInfrastructureIncomplete(
  options: RequeueAuthoritativeInfrastructureIncompleteOptions,
): Promise<AuthoritativeInfrastructureRequeueOutcome> {
  const { event, now, repository, authoritative, logger } = options;
  if (!isInfrastructureIncompleteResult(event.result)) return 'not-infrastructure-incomplete';
  if (!isRecoverablePanelRetryEligible(event.executionAttempt)) return 'attempts-exhausted';
  const meta = { runId: event.runId, executionAttempt: event.executionAttempt, reasonClass: 'incomplete_infra' };
  try {
    const context = await repository.readRunRetryContext(event.runId);
    if (!context || context.publicationMode !== 'app-gate'
      || context.authoritativeGateAppId !== authoritative.expectedAppId
      || context.repositoryId !== event.repositoryId
      || context.runStatus !== 'failed'
      || context.errorText !== AUTHORITATIVE_INFRASTRUCTURE_FAILURE_ERROR_TEXT) {
      return 'run-not-infrastructure-failure';
    }
    if (authoritative.acceptNewRequests === false || !authoritative.repositoryIds.includes(event.repositoryId)) {
      return 'admission-paused';
    }
    const resolved = await authoritative.resolver.resolve({
      repositoryId: event.repositoryId, owner: event.owner, repo: event.repo, prNumber: event.prNumber,
      headSha: event.headSha, baseSha: event.baseSha,
    });
    if (deriveReviewRunId(resolved.identity) !== event.runId) return 'candidate-changed';
    const delayMs = infrastructureRetryDelayMs(event.executionAttempt);
    await repository.admit({
      deliveryId: `internal-infrastructure-incomplete-retry:${event.runId}:a${event.executionAttempt}`,
      eventName: 'internal_infrastructure_incomplete_retry',
      repositoryId: context.repositoryId,
      installationId: context.installationId,
      receivedAt: now,
      terminalDeadline: now + TERMINAL_DEADLINE_MS,
      payloadDigest: sha256({ runId: event.runId, executionAttempt: event.executionAttempt,
        reason: 'infrastructure_incomplete' }),
      publicationMode: 'app-gate',
      centralActionDispatch: false,
      retryRequested: true,
      retryAfterExecutionAttempt: event.executionAttempt,
      availableAt: now + delayMs,
      identity: resolved.identity,
      effectivePolicyDigest: resolved.prepared.policy.effectivePolicyDigest,
      authoritativeGate: { expectedAppId: authoritative.expectedAppId, prepared: resolved.prepared },
    });
    logger.info?.('Authoritative review re-admitted after an infrastructure-incomplete attempt', {
      ...meta, nextExecutionAttempt: event.executionAttempt + 1, delayMs,
    });
    return 'requeued';
  } catch (error) {
    logger.error('Automatic infrastructure-incomplete retry admission failed', {
      ...meta,
      reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown',
    });
    return 'admission-failed';
  }
}
