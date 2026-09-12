import {
  JetStreamTransportError,
  LIFECYCLE_SUBJECT_PREFIX,
  type JetStreamHealth,
  type JetStreamPublishAck,
  type ReviewEventPublishClient,
} from './jetStreamClient';
import type {
  ReviewEventClaim,
} from '../persistence/reviewEventRepository';
import type { ReviewYetiLifecycleEventV1 } from './reviewYetiEvent';
import { createHash } from 'node:crypto';

export interface ReviewEventOutboxRepository {
  claimNext(workerId: string, now: number, leaseMs: number): Promise<ReviewEventClaim | null>;
  markPublished(eventId: string, workerId: string, now: number, publishAck?: string): Promise<boolean>;
  releaseForRetry(eventId: string, workerId: string, now: number, delayMs: number): Promise<boolean>;
}

export type ReviewEventPublisherStatus = 'disabled' | 'idle' | 'published' | 'retry' | 'error';

export interface ReviewEventPublisherOutcome {
  status: ReviewEventPublisherStatus;
  claimed: number;
  published: number;
  failed: number;
  released: number;
  leaseLost: number;
  errorCode?: string;
  health?: JetStreamHealth;
}

export interface ReviewEventOutboxPublisherOptions {
  enabled: boolean;
  repository: ReviewEventOutboxRepository;
  client: ReviewEventPublishClient;
  workerId: string;
  batchSize: number;
  leaseMs: number;
  retryDelayMs: number;
  now?: () => number;
}

/**
 * Keep subject routing opaque to the event contents. The aggregate identity is
 * hashed so owner/repository/customer text cannot become observable through a
 * NATS subject, while the fixed prefix remains easy to authorize in JetStream.
 */
export function lifecycleSubjectFor(event: ReviewYetiLifecycleEventV1): string {
  const aggregate = [event.repository_id, event.run_id, event.attempt_id].join(':');
  const suffix = createHash('sha256').update(aggregate, 'utf8').digest('hex').slice(0, 24);
  return `${LIFECYCLE_SUBJECT_PREFIX}.${suffix}`;
}

function encodeEvent(event: ReviewYetiLifecycleEventV1): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}

function errorCode(error: unknown): string {
  if (error instanceof JetStreamTransportError) return error.code;
  return 'publish_failed';
}

function emptyOutcome(status: ReviewEventPublisherStatus): ReviewEventPublisherOutcome {
  return { status, claimed: 0, published: 0, failed: 0, released: 0, leaseLost: 0 };
}

export class ReviewEventOutboxPublisher {
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly options: ReviewEventOutboxPublisherOptions) {}

  async runOnce(signal?: AbortSignal): Promise<ReviewEventPublisherOutcome> {
    if (!this.options.enabled) return emptyOutcome('disabled');

    const outcome: ReviewEventPublisherOutcome = {
      status: 'idle',
      claimed: 0,
      published: 0,
      failed: 0,
      released: 0,
      leaseLost: 0,
    };

    for (let index = 0; index < this.options.batchSize; index += 1) {
      if (signal?.aborted) break;
      let claim: ReviewEventClaim | null;
      try {
        const claimAt = this.currentTime();
        claim = await this.options.repository.claimNext(this.options.workerId, claimAt, this.options.leaseMs);
      } catch {
        outcome.status = 'error';
        outcome.errorCode = 'claim_failed';
        break;
      }
      if (!claim) break;
      outcome.claimed += 1;

      if (signal?.aborted) {
        await this.releaseClaimIfCurrent(claim, outcome, 'aborted');
        break;
      }
      const publishAt = this.currentTime();
      if (publishAt >= claim.leaseExpiresAt) {
        outcome.leaseLost += 1;
        outcome.errorCode = 'lease_expired';
        break;
      }

      let ack: JetStreamPublishAck;
      try {
        ack = await this.options.client.publish(
          lifecycleSubjectFor(claim.event),
          encodeEvent(claim.event),
          {
            messageId: claim.event.event_id,
            ...(signal ? { signal } : {}),
          },
        );
      } catch (error: unknown) {
        outcome.failed += 1;
        outcome.errorCode = errorCode(error);
        await this.releaseClaimIfCurrent(claim, outcome, outcome.errorCode);
        if (signal?.aborted) break;
        continue;
      }

      if (signal?.aborted) {
        await this.releaseClaimIfCurrent(claim, outcome, 'aborted');
        break;
      }

      const markAt = this.currentTime();
      if (markAt >= claim.leaseExpiresAt) {
        outcome.leaseLost += 1;
        outcome.errorCode = 'lease_expired_after_ack';
        break;
      }

      try {
        const marked = await this.options.repository.markPublished(
          claim.event.event_id,
          this.options.workerId,
          markAt,
          ack.duplicate ? 'duplicate' : 'acknowledged',
        );
        if (marked) outcome.published += 1;
        else outcome.leaseLost += 1;
      } catch {
        outcome.failed += 1;
        outcome.errorCode = 'mark_published_failed';
      }
    }

    outcome.status = outcome.status === 'error'
      ? 'error'
      : outcome.failed > 0 || outcome.leaseLost > 0 || outcome.released > 0
      ? 'retry'
      : outcome.published > 0
        ? 'published'
        : 'idle';
    outcome.health = this.options.client.health();
    return outcome;
  }

  private currentTime(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async releaseClaimIfCurrent(
    claim: ReviewEventClaim,
    outcome: ReviewEventPublisherOutcome,
    fallbackCode: string,
  ): Promise<void> {
    outcome.errorCode = fallbackCode;
    const releaseAt = this.currentTime();
    if (releaseAt >= claim.leaseExpiresAt) {
      outcome.leaseLost += 1;
      outcome.errorCode = fallbackCode;
      return;
    }
    try {
      if (await this.options.repository.releaseForRetry(
        claim.event.event_id,
        this.options.workerId,
        releaseAt,
        this.options.retryDelayMs,
      )) outcome.released += 1;
      else outcome.leaseLost += 1;
    } catch {
      outcome.errorCode = 'retry_release_failed';
    }
  }

  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.options.client.drain().then(() => undefined);
    }
    await this.shutdownPromise;
  }
}

export interface ReviewEventPublisherLoopOptions {
  signal: AbortSignal;
  pollIntervalMs: number;
  onOutcome?: (outcome: ReviewEventPublisherOutcome) => void;
}

function waitForNextCycle(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runReviewEventPublisherLoop(
  publisher: ReviewEventOutboxPublisher,
  options: ReviewEventPublisherLoopOptions,
): Promise<void> {
  while (!options.signal.aborted) {
    const outcome = await publisher.runOnce(options.signal);
    options.onOutcome?.(outcome);
    if (!options.signal.aborted) await waitForNextCycle(options.pollIntervalMs, options.signal);
  }
}
