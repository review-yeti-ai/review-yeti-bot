import { describe, expect, it } from 'vitest';
import { isRecoverableIncompletePanel, type IncompletePanelEvidence } from '../../src/review/publicationFailurePolicy';

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
