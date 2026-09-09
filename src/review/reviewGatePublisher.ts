import type { GitHubReviewGateClient } from '../github/reviewGateClient';
import type { PostgresReviewGateRepository, StoredReviewGate } from '../persistence/reviewGateRepository';

export interface ReviewGatePublisherOptions {
  repository: Pick<PostgresReviewGateRepository, 'claimPublication' | 'publishLocked' | 'retryPublication'>;
  clientFor(gate: StoredReviewGate): Promise<Pick<GitHubReviewGateClient, 'createPending' | 'reconcile' | 'updateExisting'>>;
  workerId: string;
  now?: () => number;
  retryDelayMs?: number;
}

/** One service-owned outbox tick. No runner waits, periodic workflow dispatch,
 * fallback App, candidate code, or worker-supplied check ID is involved. */
export class ReviewGatePublisher {
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  constructor(private readonly options: ReviewGatePublisherOptions) {
    if (!options.workerId.trim()) throw new Error('Gate publisher worker id is required');
    this.now = options.now || Date.now;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 1_000 || this.retryDelayMs > 300_000) {
      throw new Error('Gate publisher retry delay must be bounded');
    }
  }

  async runOnce(): Promise<{ status: 'idle' | 'published' | 'stale-claim' | 'retry'; attemptId?: string }> {
    const claim = await this.options.repository.claimPublication(this.options.workerId, this.now());
    if (!claim) return { status: 'idle' };
    const attemptId = claim.coordinates.attemptId;
    try {
      const status = await this.options.repository.publishLocked(claim, async (gate, mayCreate) => {
        const client = await this.options.clientFor(gate);
        // Only the one committed creation claim may POST. In particular, an
        // empty reconcile after a lost acknowledgement is not permission to
        // create a second check with the same immutable external ID.
        const check = gate.checkId === null
          ? mayCreate
            ? await client.createPending(gate.coordinates)
            : await client.reconcile(gate.coordinates)
          : { id: gate.checkId };
        if (!check) throw new Error('Gate creation remains uncertain');
        return client.updateExisting({
          coordinates: gate.coordinates,
          checkId: check.id,
          update: gate.desiredState === 'queued' || gate.desiredState === 'in_progress'
            ? { status: gate.desiredState }
            : { conclusion: gate.desiredState },
        });
      }, this.now);
      if (status === 'stale-claim') {
        await this.options.repository.retryPublication(claim, this.now(), this.retryDelayMs, 'stale-claim');
      }
      return { status, attemptId };
    } catch {
      // Do not publish exception text; DB/transport errors can contain secrets.
      // Preserve the committed intent and make the failure operator-visible in
      // durable state. Explicit new review generation is the recovery boundary
      // for a create that remains unobservable; this loop never recreates it.
      await this.options.repository.retryPublication(claim, this.now(), this.retryDelayMs,
        claim.checkId === null ? 'unknown-create' : 'transport');
      return { status: 'retry', attemptId };
    }
  }
}
