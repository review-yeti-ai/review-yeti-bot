import { deriveReviewGateExternalId, REVIEW_GATE_CHECK_NAME, type ReviewGateCheck } from './reviewCheckIdentity';
import type { ReviewCiCheckClient, ReviewCiCheckPublicationClaim, ReviewCiCheckPublicationNotStarted,
  ReviewCiCheckPublisherRepository, StoredReviewCiCheck } from './reviewCiCheckContracts';

export interface ReviewCiCheckGateFreshness {
  open: boolean;
  draft: boolean;
  repositoryId: number;
  prNumber: number;
  baseSha: string;
  headSha: string;
  policyDigest: string;
  candidateSha: string;
  reviewGate: {
    id: number;
    name: typeof REVIEW_GATE_CHECK_NAME;
    appId: number;
    headSha: string;
    externalId: string;
    status: 'completed';
    conclusion: 'success';
  };
}

export interface ReviewCiCheckPublisherOptions {
  repository: ReviewCiCheckPublisherRepository;
  clientFor(check: StoredReviewCiCheck): Promise<ReviewCiCheckClient>;
  /** Resolve current GitHub B/H/policy/C and the trusted Review Yeti Gate.
   * The callback is invoked under the shared PR lock before a successful CI
   * check is created or updated. It must honor the signal so a timed-out
   * freshness read cannot continue doing work after the publisher moves on. */
  currentSuccess(check: StoredReviewCiCheck, signal: AbortSignal): Promise<ReviewCiCheckGateFreshness>;
  workerId: string;
  now?: () => number;
  retryDelayMs?: number;
  clientFactoryTimeoutMs?: number;
  freshnessTimeoutMs?: number;
}

function isProgress(state: StoredReviewCiCheck['desiredState']): state is 'queued' | 'in_progress' {
  return state === 'queued' || state === 'in_progress';
}

function validFreshness(check: StoredReviewCiCheck, current: ReviewCiCheckGateFreshness): void {
  const review = check.request.review;
  const expectedGateCoordinates = {
    owner: review.owner, repo: review.repo, repositoryId: review.repositoryId, prNumber: review.prNumber,
    headSha: review.headSha, baseSha: review.baseSha, policyDigest: review.policyDigest,
    runId: review.runId, attemptId: review.attemptId, executionAttempt: review.executionAttempt,
  };
  if (!current.open || current.draft || current.repositoryId !== review.repositoryId || current.prNumber !== review.prNumber
    || current.baseSha !== review.baseSha || current.headSha !== review.headSha || current.policyDigest !== review.policyDigest
    || current.candidateSha !== check.request.binding?.candidateSha
    || current.reviewGate.id <= 0 || current.reviewGate.name !== REVIEW_GATE_CHECK_NAME
    || current.reviewGate.appId !== check.expectedAppId || current.reviewGate.headSha !== review.headSha
    || current.reviewGate.status !== 'completed' || current.reviewGate.conclusion !== 'success'
    || current.reviewGate.externalId !== deriveReviewGateExternalId(expectedGateCoordinates)) {
    throw new Error('Review CI successful check no longer matches current trusted review identity');
  }
}

/** Service-owned check outbox publisher. It never dispatches workflows and it
 * never creates a replacement after an uncertain POST. */
export class ReviewCiCheckPublisher {
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly clientFactoryTimeoutMs: number;
  private readonly freshnessTimeoutMs: number;
  constructor(private readonly options: ReviewCiCheckPublisherOptions) {
    if (!options.workerId.trim()) throw new Error('Review CI check publisher worker id is required');
    this.now = options.now ?? Date.now;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.clientFactoryTimeoutMs = options.clientFactoryTimeoutMs ?? 10_000;
    this.freshnessTimeoutMs = options.freshnessTimeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 1_000 || this.retryDelayMs > 300_000
      || !Number.isSafeInteger(this.clientFactoryTimeoutMs) || this.clientFactoryTimeoutMs < 250 || this.clientFactoryTimeoutMs > 45_000
      || !Number.isSafeInteger(this.freshnessTimeoutMs) || this.freshnessTimeoutMs < 250 || this.freshnessTimeoutMs > 45_000) {
      throw new Error('Review CI check publisher bounds are invalid');
    }
  }

  private async currentSuccess(check: StoredReviewCiCheck): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const current = await Promise.race([
        this.options.currentSuccess(check, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Review CI current Gate freshness deadline exceeded'));
          }, this.freshnessTimeoutMs);
        }),
      ]);
      if (controller.signal.aborted) throw new Error('Review CI current Gate freshness was aborted');
      validFreshness(check, current);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }

  async runOnce(): Promise<{ status: 'idle' | 'published' | 'stale-claim' | 'retry'; requestId?: string }> {
    const claim = await this.options.repository.claimPublication(this.options.workerId, this.now());
    if (!claim) return { status: 'idle' };
    try {
      const status = await this.options.repository.publishLocked(claim, async (check, mayCreate) => {
        if (check.desiredState === 'success') {
          try { await this.currentSuccess(check); }
          catch (error) {
            // Freshness is read-only and happens before client preparation or
            // any check operation. A first-creation claim can therefore be
            // safely returned to reserved; once a check ID exists, preserve
            // reconcile/update-only recovery instead.
            if (mayCreate && check.checkId === null) {
              return { kind: 'not-started' as const, retryDelayMs: this.retryDelayMs } satisfies ReviewCiCheckPublicationNotStarted;
            }
            throw error;
          }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        let client: ReviewCiCheckClient;
        try {
          client = await Promise.race([this.options.clientFor(check), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Review CI check client preparation unavailable')), this.clientFactoryTimeoutMs);
          })]);
        } catch {
          if (mayCreate && check.checkId === null) {
            return { kind: 'not-started' as const, retryDelayMs: this.retryDelayMs } satisfies ReviewCiCheckPublicationNotStarted;
          }
          throw new Error('Review CI check client preparation failed');
        } finally { if (timer !== undefined) clearTimeout(timer); }
        const result = check.checkId === null
          ? mayCreate
            ? await client.createPending(check.coordinates, isProgress(check.desiredState) ? { status: check.desiredState } : undefined)
            : await client.reconcile(check.coordinates)
          : { id: check.checkId } as ReviewGateCheck;
        if (!result) throw new Error('Review CI check creation remains uncertain');
        const update = isProgress(check.desiredState)
          ? { status: check.desiredState as 'queued' | 'in_progress' }
          : { conclusion: check.desiredState as 'success' | 'failure' | 'cancelled' | 'timed_out' };
        return client.updateExisting({ coordinates: check.coordinates, checkId: result.id, update });
      }, this.now());
      if (status === 'stale-claim') await this.options.repository.retryPublication(claim, this.now(), this.retryDelayMs, 'stale-claim');
      return { status, requestId: claim.request.requestId };
    } catch {
      await this.options.repository.retryPublication(claim, this.now(), this.retryDelayMs,
        claim.checkId === null ? 'unknown-create' : 'transport').catch(() => undefined);
      return { status: 'retry', requestId: claim.request.requestId };
    }
  }
}
