import { describe, expect, it } from 'vitest';
import { createReviewCiLanePlan, reviewCiIdentityDigest, type StoredReviewCiRequest } from '../../src/review/reviewCi';
import { reviewDispatchPrLockKey, storedReviewCiRequestFromRow } from '../../src/persistence/reviewCiPersistence';

const request: StoredReviewCiRequest = {
  requestId: '07b3c7a1-12a4-4e42-bc18-71df2e0cae1d', expectedAppId: 4385771, state: 'admitted', workflowEpoch: 1,
  review: { repositoryId: 123, owner: 'example', repo: 'pilot', prNumber: 42,
    baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), policyDigest: 'c'.repeat(64),
    runId: `run_${'d'.repeat(32)}`, attemptId: `run_${'d'.repeat(32)}-g0-e1`, reviewGeneration: 0, executionAttempt: 1 },
  binding: { candidateSha: 'e'.repeat(40), workflowId: 12, workflowPath: '.github/workflows/validation.yml',
    workflowRef: 'refs/heads/main', workflowSha: 'f'.repeat(40),
    lanePlan: createReviewCiLanePlan(['unit'], ['Required unit tests']) },
  identityDigest: null, execution: null, terminalReceipt: null,
};
request.identityDigest = reviewCiIdentityDigest({ ...request, binding: request.binding! });
const row = () => ({
  request_id: request.requestId, expected_app_id: request.expectedAppId, state: request.state,
  review: structuredClone(request.review), binding: structuredClone(request.binding), identity_digest: request.identityDigest,
  workflow_epoch: request.workflowEpoch, execution: null, terminal_receipt: null, terminal_digest: null,
  attempt_id: request.review.attemptId, repository_id: request.review.repositoryId, pr_number: request.review.prNumber,
});

describe('shared Review CI persistence identity', () => {
  it('owns the exact cross-repository PR lock key', () => {
    expect(reviewDispatchPrLockKey(123, 42)).toBe('review-dispatch:123:42');
    expect(() => reviewDispatchPrLockKey(0, 42)).toThrow('Invalid review dispatch PR lock identity');
    expect(() => reviewDispatchPrLockKey(123, Number.NaN)).toThrow('Invalid review dispatch PR lock identity');
  });
  it('parses one canonical request row for coordinator and check repositories', () => {
    expect(storedReviewCiRequestFromRow(row())).toEqual(request);
    expect(() => storedReviewCiRequestFromRow({ ...row(), attempt_id: 'foreign' }))
      .toThrow('Invalid stored Review CI identity');
    expect(() => storedReviewCiRequestFromRow({ ...row(), identity_digest: '0'.repeat(64) }))
      .toThrow('Invalid stored Review CI identity');
  });
});
