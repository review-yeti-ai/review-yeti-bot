import type { ReviewDispatchRepository } from '../persistence/reviewDispatchRepository';
import {
  buildReviewJobProjection,
  type PRReviewJobProjection,
  type RunnerMode,
} from './reviewJobProjection';

export interface ReviewJobProjector {
  /** Ensure is idempotent for metadata.name and must reject a conflicting existing resource. */
  ensure(projection: PRReviewJobProjection): Promise<void>;
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
  }): Promise<void>;
}

export interface ReviewJobDispatchEngineOptions {
  repository: Pick<
    ReviewDispatchRepository,
    'claimNext' | 'markProjected' | 'releaseForRetry' | 'markTerminal'
  >;
  projector: ReviewJobProjector;
  /** Required to dispatch an app-gate review; absent, publishing runs are refused. */
  runSecretProvisioner?: RunSecretProvisioner;
  workerId: string;
  workerImage: string;
  namespace: string;
  runnerMode?: RunnerMode;
  now?: () => number;
  leaseMs?: number;
  retryDelayMs?: number;
}

export type ReviewJobDispatchOutcome =
  | { status: 'idle' }
  | { status: 'projected'; runId: string; projectionName: string }
  | { status: 'terminal'; runId: string; reason: 'projection-rejected' | 'run-secret-unavailable' }
  | { status: 'retry'; runId: string; availableAt: number }
  | { status: 'lease-lost'; runId: string };

export class ReviewJobDispatchEngine {
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: ReviewJobDispatchEngineOptions) {
    this.now = options.now || Date.now;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    if (!options.workerId.trim()) throw new Error('dispatcher worker id is required');
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) throw new Error('dispatcher lease must be positive');
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) throw new Error('dispatcher retry delay cannot be negative');
  }

  async runOnce(): Promise<ReviewJobDispatchOutcome> {
    const now = this.now();
    const claim = await this.options.repository.claimNext(this.options.workerId, now, this.leaseMs);
    if (!claim) return { status: 'idle' };

    let projection: PRReviewJobProjection;
    try {
      projection = buildReviewJobProjection({
        runId: claim.runId,
        deliveryId: claim.deliveryId,
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
      }, now);
    } catch {
      const marked = await this.options.repository.markTerminal(
        claim.runId,
        this.options.workerId,
        now,
        'review job projection rejected',
      );
      return marked
        ? { status: 'terminal', runId: claim.runId, reason: 'projection-rejected' }
        : { status: 'lease-lost', runId: claim.runId };
    }

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
          now,
          'publishing review dispatched without a run secret provisioner',
        );
        return marked
          ? { status: 'terminal', runId: claim.runId, reason: 'run-secret-unavailable' }
          : { status: 'lease-lost', runId: claim.runId };
      }
      const [owner, repoName] = claim.repo.split('/');
      try {
        await provisioner.provision({
          runId: claim.runId,
          secretName: projection.spec.runSecretName,
          namespace: this.options.namespace,
          owner,
          repo: repoName,
        });
      } catch {
        // Retry rather than terminate: a token mint is a network call and GitHub
        // rate limits are transient. The terminal deadline still bounds it.
        const availableAt = now + this.retryDelayMs;
        const released = await this.options.repository.releaseForRetry(
          claim.runId,
          this.options.workerId,
          now,
          availableAt,
        );
        return released
          ? { status: 'retry', runId: claim.runId, availableAt }
          : { status: 'lease-lost', runId: claim.runId };
      }
    }

    try {
      await this.options.projector.ensure(projection);
    } catch {
      const availableAt = now + this.retryDelayMs;
      const released = await this.options.repository.releaseForRetry(
        claim.runId,
        this.options.workerId,
        now,
        availableAt,
      );
      return released
        ? { status: 'retry', runId: claim.runId, availableAt }
        : { status: 'lease-lost', runId: claim.runId };
    }

    const projected = await this.options.repository.markProjected(
      claim.runId,
      this.options.workerId,
      projection.metadata.name,
      now,
    );
    return projected
      ? { status: 'projected', runId: claim.runId, projectionName: projection.metadata.name }
      : { status: 'lease-lost', runId: claim.runId };
  }
}
