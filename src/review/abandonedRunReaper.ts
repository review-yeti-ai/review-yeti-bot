import type {
  AbandonedCheckRecoveryOutcome,
  AbandonedPublishingRun,
  ReviewDispatchRepository,
} from '../persistence/reviewDispatchRepository';
import { logger } from '../utils/logger';

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
  repository: Pick<ReviewDispatchRepository, 'claimAbandonedPublishingRuns' | 'reconcileAbandonedPublishingRun'>;
  /** Built per run: the token must be scoped to that run's repository. */
  checkClientFor(run: AbandonedPublishingRun, signal: AbortSignal): Promise<ReaperCheckClient>;
  /** Authenticated with the worker-token owner's App JWT, never PR metadata. */
  publisherAppId: number;
  workerId: string;
  now?: () => number;
  limit?: number;
}

export interface AbandonedRunReaperOutcome {
  swept: number;
  published: number;
  failed: number;
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
    const runs = await this.options.repository.claimAbandonedPublishingRuns(this.options.workerId, now, this.limit);
    let published = 0;
    let failed = 0;

    for (const run of runs) {
      if (signal?.aborted) break;
      try {
        let outcome: AbandonedCheckRecoveryOutcome | undefined;
        const reconciled = await this.options.repository.reconcileAbandonedPublishingRun(
          run, this.options.workerId, this.now(), async () => {
            // Started after acquiring the lock, and below the 60-second claim
            // lease. Shutdown aborts fetch and the transaction drains before DB
            // close; there is no detached timer racing an admission or a retry.
            const deadline = AbortSignal.timeout(20_000);
            const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
            bounded.throwIfAborted();
            const client = await this.options.checkClientFor(run, bounded);
            outcome = await client.failAbandonedCheck(run, this.options.publisherAppId, bounded);
            bounded.throwIfAborted();
            return outcome;
          },
        );
        if (!reconciled) continue;
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

    if (runs.length > 0) {
      logger.warn('Reaped publishing runs that never produced a verdict', {
        swept: runs.length,
        published,
        failed,
      });
    }
    return { swept: runs.length, published, failed };
  }
}
