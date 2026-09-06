import type { AbandonedPublishingRun } from '../persistence/reviewDispatchRepository';
import { logger } from '../utils/logger';

/**
 * Publishes a fail-closed check for publishing runs that died before their worker
 * ever started (REL-586).
 *
 * The only component that creates a check run is the worker itself. Every failure
 * upstream of its pod -- token mint, RBAC denial, capacity wait, workspace
 * contention, CR conflict, deadline expiry -- therefore leaves the head with no
 * check at all. On a required gate that is the worst possible shape: merges are
 * blocked and nothing is red, so there is nothing for anyone to go look at. This
 * closes that hole by turning silence into an explicit failure.
 *
 * It publishes `failure`, never `neutral`: a neutral check does not block a merge,
 * so reporting an unrun review as neutral would convert a silent block into a
 * silent *pass*, which is strictly worse.
 */
export interface ReaperCheckClient {
  createCheck(owner: string, repo: string, headSha: string): Promise<number>;
  completeCheck(options: {
    owner: string;
    repo: string;
    checkId: number;
    conclusion: 'success' | 'failure' | 'cancelled';
    title: string;
    summary: string;
  }): Promise<void>;
}

export interface AbandonedRunReaperOptions {
  repository: { claimAbandonedPublishingRuns(workerId: string, now: number, limit: number): Promise<AbandonedPublishingRun[]> };
  /** Built per run: the token must be scoped to that run's repository. */
  checkClientFor(run: AbandonedPublishingRun): Promise<ReaperCheckClient>;
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
    this.now = options.now || Date.now;
    this.limit = options.limit ?? 20;
  }

  async runOnce(): Promise<AbandonedRunReaperOutcome> {
    const now = this.now();
    const runs = await this.options.repository.claimAbandonedPublishingRuns(this.options.workerId, now, this.limit);
    let published = 0;
    let failed = 0;

    for (const run of runs) {
      try {
        const client = await this.options.checkClientFor(run);
        const checkId = await client.createCheck(run.owner, run.repo, run.headSha);
        await client.completeCheck({
          owner: run.owner,
          repo: run.repo,
          checkId,
          conclusion: 'failure',
          title: 'Review Yeti: review did not start',
          summary: [
            `No persona reviewed \`${run.headSha}\`.`,
            'The run was admitted but reached its terminal deadline before a worker'
            + ' published a verdict, so this is a failed review rather than an approval.',
            'Re-run the review workflow, or push a new commit, to dispatch a fresh run.',
          ].join('\n\n'),
        });
        published += 1;
      } catch (error) {
        // The row is already terminal, so a publish failure does not resurrect it.
        // Log loudly: this is the last line of defence against a silent block, and
        // if it fails the head is left with no check after all.
        failed += 1;
        logger.error('Failed to publish a fail-closed check for an abandoned review', {
          runId: run.runId,
          repo: `${run.owner}/${run.repo}`,
          headSha: run.headSha,
          error: error instanceof Error ? error.message : String(error),
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
