import { describe, expect, it } from 'vitest';
import {
  isRecoverableIncompletePanel,
  isRecoverablePanelRetryEligible,
  recoverablePanelRetryReportingStatus,
  RECOVERABLE_PANEL_AUTO_RETRY_CAP,
  renderRecoverablePanelRetrySummary,
  renderRecoverablePanelRetryTitle,
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
  missingConfiguredLaneCount: 0,
  malformedReturnedLaneCount: 0,
};

describe('incomplete publication evidence policy', () => {
  it('recognizes a no-findings failed panel without granting approval', () => {
    expect(isRecoverableIncompletePanel(incomplete)).toBe(true);
  });

  it('recognizes silently missing lanes: clean returned subset, no failures, no findings', () => {
    // The production shape: 1 of 3 configured lanes returned, every returned
    // id is a clean roster member, nothing failed, nothing was found, and the
    // roster is invalid only because configured lanes are absent. A fresh
    // attempt can plausibly complete it; a terminal BLOCK cannot be repeated.
    expect(isRecoverableIncompletePanel({
      ...incomplete,
      rosterValid: false,
      failedLaneCount: 0,
      missingConfiguredLaneCount: 2,
    })).toBe(true);
  });

  it('does not reclassify a silently missing shape with any malformed return', () => {
    expect(isRecoverableIncompletePanel({
      ...incomplete,
      rosterValid: false,
      failedLaneCount: 0,
      missingConfiguredLaneCount: 2,
      malformedReturnedLaneCount: 1,
    })).toBe(false);
  });

  it('does not reclassify an invalid configured roster as silently missing', () => {
    // `missingConfiguredLaneCount` is defined as zero when the configured
    // roster itself is invalid, so this shape cannot be a known-lane dropout.
    expect(isRecoverableIncompletePanel({
      ...incomplete,
      rosterValid: false,
      failedLaneCount: 0,
      missingConfiguredLaneCount: 0,
      malformedReturnedLaneCount: 3,
    })).toBe(false);
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

describe('worker retry reporting does not infer scheduling from eligibility', () => {
  const lanes = [{ id: 'sec-lane', failureClass: 'transport' }];

  it.each([1, RECOVERABLE_PANEL_AUTO_RETRY_CAP])('reports attempt %s as not confirmed', (attempt) => {
    expect(recoverablePanelRetryReportingStatus(attempt)).toBe('not_confirmed');
    expect(renderRecoverablePanelRetryTitle(lanes, attempt)).toContain('automatic retry NOT CONFIRMED');
    const summary = renderRecoverablePanelRetrySummary('a'.repeat(40), lanes, attempt);
    expect(summary).toContain('completion API acknowledgement confirms delivery only');
    expect(summary).toContain('No next attempt or supersession is promised.');
    expect(summary).not.toContain('scheduled automatically');
  });

  it('reports only the exact terminal attempt as cap exhaustion', () => {
    const attempt = RECOVERABLE_PANEL_AUTO_RETRY_CAP + 1;
    expect(recoverablePanelRetryReportingStatus(attempt)).toBe('cap_exhausted');
    expect(renderRecoverablePanelRetryTitle(lanes, attempt)).toContain('automatic retry cap EXHAUSTED');
    expect(renderRecoverablePanelRetrySummary('a'.repeat(40), lanes, attempt))
      .toContain(`cap of ${RECOVERABLE_PANEL_AUTO_RETRY_CAP} additional attempts was exhausted at execution attempt ${attempt}`);
  });

  it.each([0, -1, Number.NaN, 1.5, RECOVERABLE_PANEL_AUTO_RETRY_CAP + 2])(
    'does not mislabel invalid or out-of-contract attempt %s as cap exhaustion', (attempt) => {
      expect(recoverablePanelRetryReportingStatus(attempt)).toBe('unknown');
      expect(renderRecoverablePanelRetryTitle(lanes, attempt)).toContain('automatic retry status UNKNOWN');
      expect(renderRecoverablePanelRetrySummary('a'.repeat(40), lanes, attempt))
        .toContain('this value proves neither retry eligibility nor cap exhaustion');
    },
  );
});
