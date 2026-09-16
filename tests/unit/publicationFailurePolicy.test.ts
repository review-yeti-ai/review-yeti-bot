import { describe, expect, it } from 'vitest';
import {
  isRecoverableIncompletePanel,
  isRecoverablePanelRetryEligible,
  RECOVERABLE_PANEL_AUTO_RETRY_CAP,
  type IncompletePanelEvidence,
} from '../../src/review/publicationFailurePolicy';

const incomplete: IncompletePanelEvidence = {
  authoritative: false,
  unreadableDiffCount: 0,
  mode: 'panel',
  rosterValid: true,
  failedLaneCount: 1,
  quorumSatisfied: false,
  rawFindingCount: 0,
  canonicalFindingCount: 0,
};

describe('incomplete publication evidence policy', () => {
  it('recognizes a no-findings failed panel without granting approval', () => {
    expect(isRecoverableIncompletePanel(incomplete)).toBe(true);
  });

  it.each<[string, Partial<IncompletePanelEvidence>]>([
    ['satisfied canonical quorum', { quorumSatisfied: true }],
    ['authoritative publication', { authoritative: true }],
    ['unreadable diff', { unreadableDiffCount: 1 }],
    ['fast ship', { mode: 'fast_ship' }],
    ['zero lane', { mode: 'zero_lane' }],
    ['invalid roster', { rosterValid: false }],
    ['no failed lane', { failedLaneCount: 0 }],
    ['invalid failure count', { failedLaneCount: NaN }],
    ['fractional failure count', { failedLaneCount: 0.5 }],
    ['raw finding even if discarded', { rawFindingCount: 1 }],
    ['canonical finding', { canonicalFindingCount: 1 }],
  ])('does not reclassify %s', (_label, changed) => {
    expect(isRecoverableIncompletePanel({ ...incomplete, ...changed })).toBe(false);
  });
});

// Single source of truth for both the dispatcher's re-queue gate and the
// worker's "no further automatic retry" exhaustion summary (REL-620); a
// boundary mismatch between the two would let one side retry an attempt the
// other side already reported as exhausted, or vice versa.
describe('recoverable-panel auto-retry eligibility boundary', () => {
  it('is eligible on the first attempt', () => {
    expect(isRecoverablePanelRetryEligible(1)).toBe(true);
  });

  it('is eligible exactly at the cap', () => {
    expect(isRecoverablePanelRetryEligible(RECOVERABLE_PANEL_AUTO_RETRY_CAP)).toBe(true);
  });

  it('is not eligible one past the cap', () => {
    expect(isRecoverablePanelRetryEligible(RECOVERABLE_PANEL_AUTO_RETRY_CAP + 1)).toBe(false);
  });

  it.each<[string, number]>([
    ['zero', 0],
    ['negative', -1],
  ])('is not eligible for a non-positive attempt (%s): attempts are 1-based', (_label, attempt) => {
    expect(isRecoverablePanelRetryEligible(attempt)).toBe(false);
  });

  it.each<[string, number]>([
    ['NaN', NaN],
    ['fractional', 1.5],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('is not eligible for a non-safe-integer attempt (%s)', (_label, attempt) => {
    expect(isRecoverablePanelRetryEligible(attempt)).toBe(false);
  });
});
