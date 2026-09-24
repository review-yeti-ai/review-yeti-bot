import type { ReviewDispatchRepository } from '../persistence/reviewDispatchRepository';
import type { ReviewDispatchClaim } from '../review/reviewRun';
import {
  buildReviewJobProjection,
  type PRReviewJobProjection,
  type RunnerMode,
} from './reviewJobProjection';

import type { CancellationPatchResult, ReviewJobProjector } from './reviewJobProjector';
export type { CancellationPatchResult, ReviewJobProjector };

/**
 * One cancellation the sweep could not apply; carries no upstream error text.
 * `field-pruned`: the API server accepted the patch but the stored object does
 * not have spec.cancelRequested === true (e.g. a CRD without the field).
 */
export interface CancellationSweepFailure {
  runId: string;
  projectionName: string;
  reason: 'patch-failed' | 'field-pruned';
  statusCode?: number;
}

/**
 * REL-1073: only a stored spec.cancelRequested === true (or a CR that no longer
 * exists) counts as propagated. A 2xx whose object lacks the flag means the
 * field was pruned, and marking it propagated would stop every retry.
 */
function cancellationLanded(result: CancellationPatchResult | undefined): boolean {
  if (result?.status === 'not-found') return true;
  return result?.status === 'patched' && result.cancelRequested === true;
}

/**
 * Provisions the per-run Secret a publishing review needs, before its PRReviewJob
 * exists. REL-586: the worker must never hold the App private key, so the control
 * plane mints a short-lived token scoped to the one repository with `checks: write`
 * from the App already installed, and delivers only that.
 */
export interface RunSecretProvisioner {
  /** Idempotent for the same run; must reject rather than reuse a foreign Secret. */
  provision(request: {
    runId: string;
    secretName: string;
    namespace: string;
    owner: string;
    repo: string;
  }): Promise<{ workerTokenDigest: string }>;
}

import { DispatchCircuitBreaker } from './dispatchCircuitBreaker';
export { DispatchCircuitBreaker };

export interface ReviewJobDispatchEngineOptions {
  repository: Pick<
    ReviewDispatchRepository,
    'claimNext' | 'markProjected' | 'bindWorkerTokenDigest' | 'releaseForRetry' | 'markTerminal'
  > & Partial<Pick<ReviewDispatchRepository, 'markCancelPropagated' | 'findPendingCancellations'>>;
  projector: ReviewJobProjector;
  /** Required to dispatch an app-gate review; absent, publishing runs are refused. */
  runSecretProvisioner?: RunSecretProvisioner;
  workerId: string;
  workerImage: string;
  namespace: string;
  runnerMode?: RunnerMode;
  /** Service-owned immutable policy read; absence must not fall back to legacy publishing. */
  preparedReviewFor?(claim: ReviewDispatchClaim): Promise<string>;
  now?: () => number;
  leaseMs?: number;
  retryDelayMs?: number;
  circuitBreaker?: DispatchCircuitBreaker | { isOpen(now?: number): boolean };
  isDispatchPaused?: () => boolean;
}

export type ReviewJobDispatchOutcome =
  | { status: 'idle' }
  | { status: 'projected'; runId: string; projectionName: string }
  | { status: 'terminal'; runId: string; reason: 'projection-rejected' | 'run-secret-unavailable' }
  | { status: 'retry'; runId: string; availableAt: number; reason: 'run-secret-provisioning' | 'projection' }
  | { status: 'lease-lost'; runId: string };

export class ReviewJobDispatchEngine {
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  public readonly circuitBreaker: DispatchCircuitBreaker | { isOpen(now?: number): boolean };

  constructor(private readonly options: ReviewJobDispatchEngineOptions) {
    this.now = options.now || Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.circuitBreaker = options.circuitBreaker ?? new DispatchCircuitBreaker({ now: this.now });
    if (!options.workerId.trim()) throw new Error('dispatcher worker id is required');
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) throw new Error('dispatcher lease must be positive');
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) throw new Error('dispatcher retry delay cannot be negative');
  }

  async runOnce(): Promise<ReviewJobDispatchOutcome> {
    const now = this.now();
    if (this.options.isDispatchPaused?.() || this.circuitBreaker.isOpen(now)) {
      return { status: 'idle' };
    }
    const claim = await this.options.repository.claimNext(this.options.workerId, now, this.leaseMs);
    if (!claim) return { status: 'idle' };

    let projection: PRReviewJobProjection;
    try {
      let preparedReview: string | undefined;
      if (claim.authoritativeGateAppId !== undefined) {
        if (!this.options.preparedReviewFor) throw new Error('Authoritative worker projection is not configured');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          preparedReview = await Promise.race([
            this.options.preparedReviewFor(claim),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Prepared policy read deadline exceeded')), 5_000);
            }),
          ]);
        } finally { if (timer !== undefined) clearTimeout(timer); }
        if (!preparedReview) throw new Error('Prepared policy is required for authoritative review');
      }
      projection = buildReviewJobProjection({
        runId: claim.runId,
        deliveryId: claim.deliveryId,
        executionAttempt: claim.executionAttempt,
        repositoryId: claim.repositoryId,
        repo: claim.repo,
        prNumber: claim.prNumber,
        headSha: claim.headSha,
        baseSha: claim.baseSha,
        receivedAt: claim.receivedAt,
        terminalDeadline: claim.terminalDeadline,
        policyDigest: claim.policyDigest,
        configDigest: claim.configDigest,
        publicationMode: claim.publicationMode,
        workerImage: this.options.workerImage,
        namespace: this.options.namespace,
        runnerMode: this.options.runnerMode,
        ...(preparedReview !== undefined ? { preparedReview } : {}),
      }, this.now());
    } catch {
      const marked = await this.options.repository.markTerminal(
        claim.runId,
        this.options.workerId,
        claim.claimAttempt,
        this.now(),
        'review job projection rejected',
        { reason: 'review_job_projection_rejected', logTail: 'review job projection rejected' },
      );
      return marked
        ? { status: 'terminal', runId: claim.runId, reason: 'projection-rejected' }
        : { status: 'lease-lost', runId: claim.runId };
    }

    let workerTokenDigest = claim.workerTokenDigest;
    // A publishing review needs its credential in place before the Job can start.
    // Provision first and fail closed: creating the PRReviewJob without the Secret
    // would start a worker that cannot publish, and because the lane fails closed
    // that surfaces as a failed check on the pull request rather than a dispatch
    // error anyone would look at.
    if (projection.spec.publicationMode === 'app-gate') {
      const provisioner = this.options.runSecretProvisioner;
      if (!provisioner) {
        const marked = await this.options.repository.markTerminal(
          claim.runId,
          this.options.workerId,
          claim.claimAttempt,
          this.now(),
          'publishing review dispatched without a run secret provisioner',
          { reason: 'run_secret_provisioner_unavailable', logTail: 'run secret provisioner unavailable' },
        );
        return marked
          ? { status: 'terminal', runId: claim.runId, reason: 'run-secret-unavailable' }
          : { status: 'lease-lost', runId: claim.runId };
      }
      const [owner, repoName] = claim.repo.split('/');
      try {
        if (!workerTokenDigest) {
          const provisioned = await provisioner.provision({
            runId: claim.runId,
            secretName: projection.spec.runSecretName,
            namespace: this.options.namespace,
            owner,
            repo: repoName,
          });
          workerTokenDigest = provisioned.workerTokenDigest;
          const bound = await this.options.repository.bindWorkerTokenDigest(
            claim.runId,
            this.options.workerId,
            claim.claimAttempt,
            workerTokenDigest,
            this.now(),
          );
          if (!bound) return { status: 'lease-lost', runId: claim.runId };
        }
      } catch {
        // Retry rather than terminate: a token mint is a network call and GitHub
        // rate limits are transient. The terminal deadline still bounds it.
        //
        // The stage is named, the upstream error text is not. A retry that reports
        // nothing is indistinguishable from one that can never succeed -- a
        // permanently failing mint looped here silently until someone read the
        // source. A fixed label restores that signal; interpolating the caught
        // error would not, because upstream failures can carry credential material.
        const reason = 'run-secret-provisioning' as const;
        const retryNow = this.now();
        const availableAt = retryNow + this.retryDelayMs;
        const released = await this.options.repository.releaseForRetry(
          claim.runId,
          this.options.workerId,
          claim.claimAttempt,
          retryNow,
          availableAt,
        );
        return released
          ? { status: 'retry', runId: claim.runId, availableAt, reason }
          : { status: 'lease-lost', runId: claim.runId };
      }
    }

    try {
      await this.options.projector.ensure(projection);
    } catch {
      const reason = 'projection' as const;
      const retryNow = this.now();
      const availableAt = retryNow + this.retryDelayMs;
      const released = await this.options.repository.releaseForRetry(
        claim.runId,
        this.options.workerId,
        claim.claimAttempt,
        retryNow,
        availableAt,
      );
      return released
        ? { status: 'retry', runId: claim.runId, availableAt, reason }
        : { status: 'lease-lost', runId: claim.runId };
    }

    const projected = workerTokenDigest
      ? await this.options.repository.markProjected(
        claim.runId,
        this.options.workerId,
        claim.claimAttempt,
        projection.metadata.name,
        this.now(),
        workerTokenDigest,
      )
      : await this.options.repository.markProjected(
        claim.runId,
        this.options.workerId,
        claim.claimAttempt,
        projection.metadata.name,
        this.now(),
      );
    return projected
      ? { status: 'projected', runId: claim.runId, projectionName: projection.metadata.name }
      : { status: 'lease-lost', runId: claim.runId };
  }

  async sweepPendingCancellations(limit = 10): Promise<{
    propagated: number;
    failed: number;
    failures: CancellationSweepFailure[];
  }> {
    if (
      !this.options.repository.findPendingCancellations ||
      !this.options.repository.markCancelPropagated ||
      typeof this.options.projector.patchCancellation !== 'function'
    ) {
      return { propagated: 0, failed: 0, failures: [] };
    }
    const pending = await this.options.repository.findPendingCancellations(limit);
    let propagated = 0;
    let failed = 0;
    const failures: CancellationSweepFailure[] = [];
    for (const item of pending) {
      try {
        const result = await this.options.projector.patchCancellation(
          item.projectionName,
          this.options.namespace,
          item.cancelReason,
        );
        if (!cancellationLanded(result)) {
          failed++;
          failures.push({ runId: item.runId, projectionName: item.projectionName, reason: 'field-pruned' });
          continue;
        }
        await this.options.repository.markCancelPropagated(item.runId, item.executionAttempt, this.now());
        propagated++;
      } catch (error) {
        failed++;
        // REL-1073: surfaced so a permanently failing patch (e.g. a 403 from a
        // Role without `patch`) is visible instead of retrying silently forever.
        // Projectors attach a structured `statusCode` (never upstream text); the
        // engine stays adapter-agnostic and reads only that field.
        const statusCode = projectorStatusCode(error);
        failures.push({
          runId: item.runId,
          projectionName: item.projectionName,
          reason: 'patch-failed',
          ...(statusCode !== undefined ? { statusCode } : {}),
        });
      }
    }
    return { propagated, failed, failures };
  }

  async handleCancellation(event: {
    runId: string;
    executionAttempt: number;
    projectionName: string;
    cancelReason?: string;
  }): Promise<boolean> {
    if (!this.options.repository.markCancelPropagated || typeof this.options.projector.patchCancellation !== 'function') {
      return false;
    }
    try {
      const result = await this.options.projector.patchCancellation(
        event.projectionName,
        this.options.namespace,
        event.cancelReason,
      );
      if (!cancellationLanded(result)) return false;
      await this.options.repository.markCancelPropagated(
        event.runId,
        event.executionAttempt,
        this.now(),
      );
      return true;
    } catch {
      return false;
    }
  }
}

function projectorStatusCode(error: unknown): number | undefined {
  const status = error !== null && typeof error === 'object'
    ? (error as { statusCode?: unknown }).statusCode
    : undefined;
  return Number.isSafeInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? Number(status) : undefined;
}
