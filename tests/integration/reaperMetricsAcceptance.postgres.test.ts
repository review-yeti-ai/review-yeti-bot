import { describe, expect, it } from 'vitest';
import {
  runReaperMetricsAcceptance,
} from '../support/reaperMetricsAcceptanceHarness';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const acceptanceEnabled = process.env.REVIEW_YETI_REAPER_ACCEPTANCE === '1';
const describeAcceptance = acceptanceEnabled ? describe : describe.skip;

describeAcceptance('REL-817 deterministic reaper metric acceptance', () => {
  it('attributes each cumulative counter increment to one isolated anomaly sweep', async () => {
    expect(databaseUrl, 'REVIEW_YETI_TEST_DATABASE_URL must select an owned disposable PostgreSQL service')
      .toBeTruthy();
    const receipt = await runReaperMetricsAcceptance(databaseUrl!);

    expect(receipt.githubReadCount).toBeGreaterThan(0);
    expect(receipt.githubWriteCount).toBe(0);
    expect(receipt.transitions.map(({ branch }) => branch)).toEqual([
      'delivery_identity_mismatch',
      'superseded_attempt',
      'delivery_identity_mismatch',
      'superseded_attempt',
    ]);
    expect(receipt.branches.map(({ runId }) => runId)).toEqual(
      receipt.transitions.map(({ runId }) => runId),
    );

    const { leasePreconditions } = receipt;
    expect(leasePreconditions).toHaveLength(4);
    for (const precondition of leasePreconditions) {
      expect(precondition.outboxStatus).toBe('projected');
      expect(precondition.outboxLeaseOwner).toMatch(/^rel817-orphan-(mismatch|superseded)-[12]$/u);
      expect(precondition.outboxLeaseExpiresAt).not.toBeNull();
      expect(Date.parse(precondition.outboxLeaseExpiresAt!)).toBeLessThan(precondition.sweepAt);
    }

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

    let expectedBefore = receipt.baseline;
    for (const transition of receipt.transitions) {
      expect(transition.before).toEqual(expectedBefore);
      expect(transition.retained).toEqual(transition.after);
      expect(transition.outcome).toMatchObject({
        swept: 1,
        published: 0,
        failed: 0,
      });

      if (transition.branch === 'delivery_identity_mismatch') {
        expect(transition.outcome).toMatchObject({ quarantined: 1, superseded: 0 });
        expect(transition.after).toEqual({
          deliveryIdentityMismatch: transition.before.deliveryIdentityMismatch + 1,
          supersededAttempt: transition.before.supersededAttempt,
        });
      } else {
        expect(transition.outcome).toMatchObject({ quarantined: 0, superseded: 1 });
        expect(transition.after).toEqual({
          deliveryIdentityMismatch: transition.before.deliveryIdentityMismatch,
          supersededAttempt: transition.before.supersededAttempt + 1,
        });
      }
      expectedBefore = transition.retained;
    }

    expect(expectedBefore).toEqual({
      deliveryIdentityMismatch: receipt.baseline.deliveryIdentityMismatch + 2,
      supersededAttempt: receipt.baseline.supersededAttempt + 2,
    });
    expect(expectedBefore.deliveryIdentityMismatch).toBeGreaterThan(0);
    expect(expectedBefore.supersededAttempt).toBeGreaterThan(0);
  });
});
