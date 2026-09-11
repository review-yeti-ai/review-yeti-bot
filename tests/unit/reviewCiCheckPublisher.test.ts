import { describe, expect, it, vi } from 'vitest';
import { deriveReviewCiCheckExternalId, deriveReviewGateExternalId, REVIEW_GATE_CHECK_NAME, type ReviewGateCheck } from '../../src/github/reviewGateClient';
import { reviewCiCheckCoordinates } from '../../src/github/reviewCiCheckClient';
import type { ReviewCiCheckClient, ReviewCiCheckPublicationClaim, ReviewCiCheckPublisherRepository, StoredReviewCiCheck } from '../../src/review/reviewCiCheckContracts';
import { ReviewCiCheckPublisher, type ReviewCiCheckGateFreshness } from '../../src/review/reviewCiCheckPublisher';
import { createReviewCiLanePlan, reviewCiIdentityDigest, REVIEW_CI_CHECK_NAME, type ReviewCiValidationIdentity } from '../../src/review/reviewCi';

const identity: ReviewCiValidationIdentity = {
  requestId: '07b3c7a1-12a4-4e42-bc18-71df2e0cae1d', expectedAppId: 4385771,
  review: { repositoryId: 123, owner: 'calltelemetry', repo: 'ct-meta', prNumber: 42, baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40),
    policyDigest: 'c'.repeat(64), runId: `run_${'1'.repeat(32)}`, attemptId: `run_${'1'.repeat(32)}-g0-e1`, reviewGeneration: 0, executionAttempt: 1 },
  binding: { candidateSha: 'd'.repeat(40), workflowId: 3211, workflowPath: '.github/workflows/review-yeti-candidate.yml', workflowRef: 'refs/tags/review-ci-v1',
    workflowSha: 'e'.repeat(40), lanePlan: createReviewCiLanePlan(['core'], ['validate']) },
};
const request = { requestId: identity.requestId, review: identity.review, expectedAppId: identity.expectedAppId, state: 'admitted' as const,
  binding: identity.binding, identityDigest: reviewCiIdentityDigest(identity), workflowEpoch: 1, execution: null, terminalReceipt: null };
const coordinates = reviewCiCheckCoordinates(identity, 1);
const baseCheck: StoredReviewCiCheck = {
  request, coordinates, expectedAppId: identity.expectedAppId, immutableBindingDigest: identityDigest(),
  externalId: checkExternalId(), currentEpoch: 1, claimedExecution: null, desiredState: 'queued', desiredVersion: 1,
  publishedVersion: -1, checkId: null, creationState: 'reserved', terminalReceipt: null,
};

function identityDigest(): string { return reviewCiIdentityDigest(identity); }
function checkExternalId(): string {
  return deriveReviewCiCheckExternalId(coordinates);
}
function gateExternalId(): string {
  return deriveReviewGateExternalId({ owner: identity.review.owner, repo: identity.review.repo, repositoryId: identity.review.repositoryId,
    prNumber: identity.review.prNumber, headSha: identity.review.headSha, baseSha: identity.review.baseSha,
    policyDigest: identity.review.policyDigest, runId: identity.review.runId, attemptId: identity.review.attemptId,
    executionAttempt: identity.review.executionAttempt });
}
function githubCheck(check: StoredReviewCiCheck, id = check.checkId ?? 7001): ReviewGateCheck {
  const terminal = !['queued', 'in_progress'].includes(check.desiredState);
  return { id, name: REVIEW_CI_CHECK_NAME, appId: check.expectedAppId, headSha: check.request.review.headSha,
    externalId: check.externalId, status: terminal ? 'completed' : check.desiredState as 'queued' | 'in_progress',
    conclusion: terminal ? check.desiredState as 'success' | 'failure' | 'cancelled' | 'timed_out' : null };
}
function freshness(check: StoredReviewCiCheck): ReviewCiCheckGateFreshness {
  return { open: true, draft: false, repositoryId: check.request.review.repositoryId, prNumber: check.request.review.prNumber,
    baseSha: check.request.review.baseSha, headSha: check.request.review.headSha, policyDigest: check.request.review.policyDigest,
    candidateSha: check.request.binding!.candidateSha,
    reviewGate: { id: 8001, name: REVIEW_GATE_CHECK_NAME, appId: check.expectedAppId, headSha: check.request.review.headSha,
      externalId: gateExternalId(), status: 'completed', conclusion: 'success' },
  };
}

function fixture(overrides: Partial<StoredReviewCiCheck> = {}) {
  const check = { ...baseCheck, ...overrides };
  const claim: ReviewCiCheckPublicationClaim = { ...check, leaseOwner: 'ci-publisher', leaseToken: '00000000-0000-4000-8000-000000000001', mayCreate: check.checkId === null };
  const result = githubCheck(check);
  const client: ReviewCiCheckClient = {
    reconcile: vi.fn(async () => result),
    createPending: vi.fn(async () => result),
    updateExisting: vi.fn(async () => result),
  };
  const repository = {
    claimPublication: vi.fn(async () => claim),
    publishLocked: vi.fn(async (_claim: ReviewCiCheckPublicationClaim, publish: (check: StoredReviewCiCheck, mayCreate: boolean) => Promise<unknown>) => {
      const published = await publish(check, claim.mayCreate);
      return published && typeof published === 'object' && 'kind' in published ? 'retry' as const : 'published' as const;
    }),
    retryPublication: vi.fn(async () => true),
  } satisfies ReviewCiCheckPublisherRepository;
  const clientFor = vi.fn(async () => client);
  const currentSuccess = vi.fn<(check: StoredReviewCiCheck, signal: AbortSignal) => Promise<ReviewCiCheckGateFreshness>>(
    async () => freshness(check));
  const publisher = new ReviewCiCheckPublisher({ repository, clientFor, currentSuccess, workerId: 'ci-publisher', now: () => 1_000 });
  return { check, claim, client, repository, clientFor, currentSuccess, publisher };
}

describe('durable Review Yeti CI check publisher', () => {
  it('publishes queued CI state with one create claim and the service-owned identity', async () => {
    const f = fixture();
    expect(await f.publisher.runOnce()).toMatchObject({ status: 'published', requestId: identity.requestId });
    expect(f.client.createPending).toHaveBeenCalledOnce();
    expect(f.client.updateExisting).toHaveBeenCalledWith({ coordinates, checkId: 7001, update: { status: 'queued' } });
    expect(f.currentSuccess).not.toHaveBeenCalled();
  });

  it('requires exact fresh Gate readback before green and never writes on mismatch', async () => {
    const f = fixture({ desiredState: 'success', desiredVersion: 2, publishedVersion: 1, checkId: 7001, creationState: 'bound' });
    f.currentSuccess.mockResolvedValue({ ...freshness(f.check), reviewGate: { ...freshness(f.check).reviewGate, headSha: 'f'.repeat(40) } });
    expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
    expect(f.clientFor).not.toHaveBeenCalled();
    expect(f.client.createPending).not.toHaveBeenCalled();
    expect(f.client.updateExisting).not.toHaveBeenCalled();
    expect(f.repository.retryPublication).toHaveBeenCalledWith(expect.anything(), 1_000, 30_000, 'transport');
  });

  it('bounds a stalled current-success read, aborts it, and cannot start a check write afterward', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ desiredState: 'success', desiredVersion: 2, publishedVersion: 1, checkId: 7001, creationState: 'bound' });
      let signal!: AbortSignal;
      f.currentSuccess.mockImplementation((_check, observedSignal) => {
        signal = observedSignal;
        return new Promise<ReviewCiCheckGateFreshness>((resolve) => {
          setTimeout(() => resolve(freshness(f.check)), 1_000);
        });
      });
      const publisher = new ReviewCiCheckPublisher({ repository: f.repository, clientFor: f.clientFor, currentSuccess: f.currentSuccess,
        workerId: 'ci-publisher', now: () => 1_000, freshnessTimeoutMs: 250 });
      const outcome = publisher.runOnce();
      await vi.advanceTimersByTimeAsync(250);
      await expect(outcome).resolves.toMatchObject({ status: 'retry' });
      expect(signal.aborted).toBe(true);
      // The read callback resolves after the deadline; the publisher must not
      // resume into client preparation or an update when that happens.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.clientFor).not.toHaveBeenCalled();
      expect(f.client.updateExisting).not.toHaveBeenCalled();
      expect(f.repository.retryPublication).toHaveBeenCalledWith(expect.anything(), 1_000, 30_000, 'transport');
    } finally { vi.useRealTimers(); }
  });

  it('does not create a pending check when the pre-green freshness read times out', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ desiredState: 'success', checkId: null, creationState: 'reserved' });
      let signal!: AbortSignal;
      f.currentSuccess.mockImplementation((_check, observedSignal) => {
        signal = observedSignal;
        return new Promise<ReviewCiCheckGateFreshness>(() => undefined);
      });
      const publisher = new ReviewCiCheckPublisher({ repository: f.repository, clientFor: f.clientFor, currentSuccess: f.currentSuccess,
        workerId: 'ci-publisher', now: () => 1_000, freshnessTimeoutMs: 250 });
      const outcome = publisher.runOnce();
      await vi.advanceTimersByTimeAsync(250);
      await expect(outcome).resolves.toMatchObject({ status: 'retry' });
      expect(signal.aborted).toBe(true);
      expect(f.clientFor).not.toHaveBeenCalled();
      expect(f.client.createPending).not.toHaveBeenCalled();
      expect(f.client.updateExisting).not.toHaveBeenCalled();
      expect(f.repository.retryPublication).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('uses the bound check ID for terminal updates and never reconciles or creates another check', async () => {
    const f = fixture({ desiredState: 'failure', desiredVersion: 2, publishedVersion: 1, checkId: 7001, creationState: 'bound' });
    expect(await f.publisher.runOnce()).toMatchObject({ status: 'published' });
    expect(f.client.createPending).not.toHaveBeenCalled();
    expect(f.client.reconcile).not.toHaveBeenCalled();
    expect(f.client.updateExisting).toHaveBeenCalledWith({ coordinates, checkId: 7001, update: { conclusion: 'failure' } });
  });
});
