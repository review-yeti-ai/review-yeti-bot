import { describe, expect, it } from 'vitest';
import {
  runReaperMetricsAcceptance,
  type ReaperMetricSample,
} from '../support/reaperMetricsAcceptanceHarness';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const acceptanceEnabled = process.env.REVIEW_YETI_REAPER_ACCEPTANCE === '1';
const describeAcceptance = acceptanceEnabled ? describe : describe.skip;

function values(
  samples: ReaperMetricSample[],
  key: keyof ReaperMetricSample,
): number[] {
  return samples.map((sample) => sample[key]);
}

describeAcceptance('REL-817 deterministic reaper metric acceptance', () => {
  it('terminalizes both anomaly branches and exports cumulative same-process counters', async () => {
    expect(databaseUrl, 'REVIEW_YETI_TEST_DATABASE_URL must select an owned disposable PostgreSQL service')
      .toBeTruthy();
    const receipt = await runReaperMetricsAcceptance(databaseUrl!);

    expect(receipt.githubReadCount).toBeGreaterThan(0);
    expect(receipt.githubWriteCount).toBe(0);
    expect(receipt.branches).toHaveLength(4);

    const mismatches = receipt.branches.filter(({ branch }) => branch === 'delivery_identity_mismatch');
    const superseded = receipt.branches.filter(({ branch }) => branch === 'superseded_attempt');
    expect(mismatches).toHaveLength(2);
    expect(superseded).toHaveLength(2);

    for (const branch of receipt.branches) {
      expect(branch).toMatchObject({
        status: 'terminal',
        stage: 'terminal',
        resultDigest: null,
        runLeaseOwner: null,
        runLeaseExpiresAt: null,
        outboxStatus: 'terminal',
        outboxLeaseOwner: null,
        outboxLeaseExpiresAt: null,
      });
    }
    for (const branch of mismatches) {
      expect(branch).toMatchObject({
        reason: 'dispatch_delivery_identity_mismatch',
        terminalClass: 'delivery_identity_mismatch',
      });
    }
    for (const branch of superseded) {
      expect(branch).toMatchObject({
        reason: 'superseded_publisher_owned_check',
        terminalClass: 'superseded_by_newer_check',
      });
    }

    expect(receipt.samples).toHaveLength(4);
    const mismatchValues = values(receipt.samples, 'deliveryIdentityMismatch');
    const supersededValues = values(receipt.samples, 'supersededAttempt');
    expect(mismatchValues).toEqual([
      receipt.baseline.deliveryIdentityMismatch + 1,
      receipt.baseline.deliveryIdentityMismatch + 1,
      receipt.baseline.deliveryIdentityMismatch + 2,
      receipt.baseline.deliveryIdentityMismatch + 2,
    ]);
    expect(supersededValues).toEqual([
      receipt.baseline.supersededAttempt + 1,
      receipt.baseline.supersededAttempt + 1,
      receipt.baseline.supersededAttempt + 2,
      receipt.baseline.supersededAttempt + 2,
    ]);
    expect(mismatchValues.every((value, index) => index === 0 || value >= mismatchValues[index - 1]))
      .toBe(true);
    expect(supersededValues.every((value, index) => index === 0 || value >= supersededValues[index - 1]))
      .toBe(true);
    expect(mismatchValues.every((value) => value > 0)).toBe(true);
    expect(supersededValues.every((value) => value > 0)).toBe(true);
  });
});
