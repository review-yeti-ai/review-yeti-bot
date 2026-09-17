import type {
  AbandonedCheckRecoveryOutcome,
  AbandonedPublishingRun,
  AbandonedRunReconciliation,
  DelegatedFailureCandidateInput,
  ReviewDispatchRepository,
} from '../persistence/reviewDispatchRepository';
import { getMetrics } from '../telemetry/metrics';
import { logger } from '../utils/logger';

/** Narrow interface so the reaper depends only on the read it needs, not the
 * concrete `DelegatedFailureReader` class (`../k8s/delegatedFailureReader`). */
export interface DelegatedFailureCandidateSource {
  listCandidates(): Promise<DelegatedFailureCandidateInput[]>;
}

/**
 * Reconciles publishing attempts that expired without a durable verdict.
 * The worker may have started. Only the worker-token owner's App can publish.
 *
 * Recover an existing orphan check, or create an explicit failure if no worker
 * check exists. Publication errors remain pending; no success is synthesized.
 */
export interface ReaperCheckClient {
  failAbandonedCheck(run: AbandonedPublishingRun, publisherAppId: number, signal: AbortSignal):
    Promise<AbandonedCheckRecoveryOutcome>;
}

export interface AbandonedRunReaperOptions {
  repository: Pick<ReviewDispatchRepository,
    'claimAbandonedPublishingRuns' | 'reconcileAbandonedPublishingRun' | 'retireExpiredNonPublishableRuns'>;
  /** Built per run: the token must be scoped to that run's repository. */
  checkClientFor(run: AbandonedPublishingRun, signal: AbortSignal): Promise<ReaperCheckClient>;
  /** Authenticated with the worker-token owner's App JWT, never PR metadata. */
  publisherAppId: number;
  workerId: string;
  now?: () => number;
  limit?: number;
  /**
   * REL-896: optional source of the Go operator's delegated-failure signal.
   * When present, its candidates make a queued/running run eligible for
   * claim before terminal_deadline. Omitted entirely, behavior is byte-for-byte
   * the pre-REL-896 deadline-only reaper (no fourth argument is even passed
   * to claimAbandonedPublishingRuns).
   */
  delegatedFailureReader?: DelegatedFailureCandidateSource;
}

export interface AbandonedRunReaperOutcome {
  swept: number;
  published: number;
  failed: number;
  /** Rows retired without publication because their delivery identities diverged. */
  quarantined?: number;
  /** Obsolete rows retired because a completed newer App check owns the same head. */
  superseded?: number;
  /** Non-publishable (not 'app-gate') rows past their deadline, retired without touching GitHub. */
  retiredNonPublishable?: number;
  /** Claimed because the operator's delegated-failure signal matched, not terminal_deadline. */
  delegated?: number;
}

export class AbandonedRunReaper {
  private readonly now: () => number;
  private readonly limit: number;

  constructor(private readonly options: AbandonedRunReaperOptions) {
    if (!options.workerId.trim()) throw new Error('reaper worker id is required');
    if (!Number.isSafeInteger(options.publisherAppId) || options.publisherAppId <= 0) {
      throw new Error('authenticated publisher App id is required');
    }
    this.now = options.now || Date.now;
    this.limit = options.limit ?? 20;
  }

  async runOnce(signal?: AbortSignal): Promise<AbandonedRunReaperOutcome> {
    if (signal?.aborted) return { swept: 0, published: 0, failed: 0 };
    const now = this.now();
    // Non-publishable (not 'app-gate') runs have no App check to fail closed --
    // claimAbandonedPublishingRuns below only ever claims 'app-gate' rows, so a
    // 'disabled'-mode run that is never claimed before its deadline would
    // otherwise stay 'queued'/'running' forever. This sweep only terminalizes;
    // it never mints a token or calls GitHub.
    const retiredNonPublishable = await this.options.repository.retireExpiredNonPublishableRuns(now, this.limit);
    // No reader configured keeps the exact pre-REL-896 3-argument call; a
    // configured reader always passes its (possibly empty) candidate list so
    // an eligible signal is never skipped by an unlucky poll-interval gap.
    const delegatedCandidates = this.options.delegatedFailureReader
      ? await this.options.delegatedFailureReader.listCandidates()
      : undefined;
    const runs = delegatedCandidates
      ? await this.options.repository.claimAbandonedPublishingRuns(
        this.options.workerId, now, this.limit, delegatedCandidates,
      )
      : await this.options.repository.claimAbandonedPublishingRuns(this.options.workerId, now, this.limit);
    let published = 0;
    let failed = 0;
    let quarantined = 0;
    let superseded = 0;

    for (const run of runs) {
      if (signal?.aborted) break;
      try {
        const reconciliation: AbandonedRunReconciliation = await this.options.repository.reconcileAbandonedPublishingRun(
          run, this.options.workerId, this.now(), async () => {
            // Started after acquiring the lock, and below the 60-second claim
            // lease. Shutdown aborts fetch and the transaction drains before DB
            // close; there is no detached timer racing an admission or a retry.
            const deadline = AbortSignal.timeout(20_000);
            const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
            bounded.throwIfAborted();
            const client = await this.options.checkClientFor(run, bounded);
            const outcome = await client.failAbandonedCheck(run, this.options.publisherAppId, bounded);
            bounded.throwIfAborted();
            return outcome;
          },
        );
        if (!reconciliation.reconciled) continue;
        const outcome = reconciliation.outcome;
        if (outcome === 'quarantined') quarantined += 1;
        if (outcome === 'superseded') superseded += 1;
        if (outcome === 'failure-published') published += 1;
        if (outcome === 'creation-unconfirmed') failed += 1;
      } catch {
        // The claim expires and remains eligible after rollback. Never expose
        // token-mint or GitHub response bodies in logs.
        failed += 1;
        logger.error('Failed to publish a fail-closed check for an abandoned review', {
          runId: run.runId,
          repo: `${run.owner}/${run.repo}`,
          headSha: run.headSha,
          reason: 'failure_publication_pending',
        });
      }
    }

    const delegated = runs.filter((run) => run.delegatedReason !== undefined).length;

    if (runs.length > 0) {
      logger.warn('Reaped publishing runs that never produced a verdict', {
        swept: runs.length,
        published,
        failed,
        quarantined,
        superseded,
        ...(delegated > 0 ? { delegated } : {}),
      });
    }
    if (retiredNonPublishable > 0) {
      logger.warn('Retired non-publishable runs past their terminal deadline', {
        retiredNonPublishable,
      });
    }

    const metrics = getMetrics();
    metrics.reviewReaperSwept.add(runs.length);
    metrics.reviewReaperPublished.add(published);
    metrics.reviewReaperFailed.add(failed);
    if (superseded > 0) metrics.reviewReaperSuperseded.add(superseded);
    if (retiredNonPublishable > 0) metrics.reviewReaperRetiredNonPublishable.add(retiredNonPublishable);
    if (delegated > 0) metrics.reviewReaperDelegated.add(delegated);

    return {
      swept: runs.length,
      published,
      failed,
      ...(quarantined > 0 ? { quarantined } : {}),
      ...(superseded > 0 ? { superseded } : {}),
      ...(retiredNonPublishable > 0 ? { retiredNonPublishable } : {}),
      ...(delegated > 0 ? { delegated } : {}),
    };
  }
}
