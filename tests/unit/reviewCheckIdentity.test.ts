import { describe, expect, it } from 'vitest';
import {
  deriveOperatorPassthroughExternalId,
  isLegacyOperatorMaintenanceReviewExternalId,
  isOperatorPassthroughReviewExternalId,
  REVIEW_GATE_CHECK_NAME,
  REVIEW_WORKER_CHECK_NAME,
} from '../../src/review/reviewCheckIdentity';

const PUBLICATION_ID = 'a'.repeat(64);
const AUDIT_DIGEST = 'b'.repeat(64);

describe('operator passthrough Review check identity', () => {
  it('recognizes the derived worker ID and excludes the separately derived Gate ID', () => {
    const reviewId = deriveOperatorPassthroughExternalId(
      PUBLICATION_ID, AUDIT_DIGEST, REVIEW_WORKER_CHECK_NAME);
    const gateId = deriveOperatorPassthroughExternalId(
      PUBLICATION_ID, AUDIT_DIGEST, REVIEW_GATE_CHECK_NAME);

    expect(isOperatorPassthroughReviewExternalId(reviewId)).toBe(true);
    expect(isOperatorPassthroughReviewExternalId(gateId)).toBe(false);
  });

  it.each([
    ['ordinary review run ID', 'run_ordinary:a1'],
    ['other namespace version', `review-yeti-operator-passthrough:v2:${PUBLICATION_ID}:${AUDIT_DIGEST}`],
    ['empty value', ''],
    ['non-string value', null],
  ])('rejects %s as a worker passthrough ID', (_label, value) => {
    expect(isOperatorPassthroughReviewExternalId(value)).toBe(false);
  });

  it('recognizes only the deployed legacy raw maintenance identity shape', () => {
    const digest = 'c'.repeat(64);
    expect(isLegacyOperatorMaintenanceReviewExternalId(`review-yeti-maintenance:v1:${digest}:raw`)).toBe(true);
    expect(isLegacyOperatorMaintenanceReviewExternalId(`review-yeti-maintenance:v1:${digest}:gate`)).toBe(false);
    expect(isLegacyOperatorMaintenanceReviewExternalId(`review-yeti-maintenance:v1:${'C'.repeat(64)}:raw`)).toBe(false);
    expect(isLegacyOperatorMaintenanceReviewExternalId(`review-yeti-maintenance:v2:${digest}:raw`)).toBe(false);
    expect(isLegacyOperatorMaintenanceReviewExternalId(null)).toBe(false);
  });
});
