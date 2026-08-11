import { describe, expect, it } from 'vitest';

const { deriveReceiptOutcome } = require('../../src/review/reviewOutcome.js');
const { createReviewIdentity } = require('../../src/review/reviewContracts.js');
const { createRiskPlan, createLaneExecutionReceipt } = require('../../src/review/evidenceContracts.js');

const identity = createReviewIdentity({
  repository: 'review-yeti-ai/review-yeti-bot',
  prNumber: 31,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  trustedConfig: {},
  effectivePolicy: {},
});
const plan = createRiskPlan({
  identity,
  personaId: 'security',
  items: [{ id: 'risk-1', unitIds: ['ru_abc'], statement: 'guard can be bypassed', evidenceNeeded: [], allowedTools: [] }],
});
const validLane = createLaneExecutionReceipt({ identity, personaId: 'security', plan, termination: 'completed' });
const timeoutLane = createLaneExecutionReceipt({ identity, personaId: 'testing', plan, termination: 'timeout' });
const completeManifest = { coverage: { complete: true } };
const completeVerification = { summary: { incomplete: false } };
const cleanShip = { verdict: 'SHIP', status: 'SHIP', rationale: 'clean', metrics: {} };

describe('receipt-derived review outcome', () => {
  it.each([
    'budget_exhausted', 'provider_failure', 'timeout', 'cancelled', 'repeated_call',
    'malformed_response', 'unresolved_evidence', 'verification_incomplete',
  ])('never leaves merge eligibility latched after %s', (termination) => {
    const result = deriveReceiptOutcome({
      arbitration: { ...cleanShip, mergeEligible: true },
      unitManifest: completeManifest,
      laneReceipts: [{ ...validLane, termination }],
      findingVerification: { summary: { incomplete: termination === 'verification_incomplete' } },
      headCurrent: true,
    });
    expect(result).toMatchObject({ verdict: 'BLOCK', gateDecision: 'BLOCKED', mergeEligible: false, promotionReady: false });
    expect(['PARTIAL_REVIEW', 'INCOMPLETE_REVIEW']).toContain(result.status);
  });

  it('preserves a clean complete SHIP only when every receipt is valid', () => {
    expect(deriveReceiptOutcome({
      arbitration: cleanShip,
      unitManifest: completeManifest,
      laneReceipts: [validLane],
      findingVerification: completeVerification,
      headCurrent: true,
    })).toMatchObject({ verdict: 'SHIP', status: 'SHIP', coverageStatus: 'complete', gateDecision: 'PASS', mergeEligible: true, promotionReady: true });
  });

  it('does not depend on lane input order when deriving termination reasons', () => {
    const first = deriveReceiptOutcome({ arbitration: cleanShip, unitManifest: completeManifest, laneReceipts: [validLane, timeoutLane], findingVerification: completeVerification, headCurrent: true });
    const second = deriveReceiptOutcome({ arbitration: cleanShip, unitManifest: completeManifest, laneReceipts: [timeoutLane, validLane], findingVerification: completeVerification, headCurrent: true });
    expect(first.executionTerminationReasons).toEqual(second.executionTerminationReasons);
  });

  it('preserves completed evidence while blocking a mixed run', () => {
    const failedLane = createLaneExecutionReceipt({ identity, personaId: 'testing', plan, termination: 'provider_failure' });
    const result = deriveReceiptOutcome({ arbitration: { ...cleanShip, findings: [{ title: 'confirmed' }] }, unitManifest: completeManifest, laneReceipts: [validLane, failedLane], findingVerification: completeVerification, headCurrent: true });
    expect(result).toMatchObject({ status: 'PARTIAL_REVIEW', verdict: 'BLOCK', mergeEligible: false });
    expect(result.findings).toEqual([{ title: 'confirmed' }]);
  });

  // Regression coverage for the cisco-cdr false-BLOCK incident (2026-08-11): a monorepo whose
  // navigation snapshot exceeds the bounded-file cap (reviewNavigationTools.js) deliberately
  // disables evidence tooling for the whole review (PR #37, "fail-soft registry construction").
  // That is a known, expected degradation -- not a lane execution failure -- so it must not
  // force BLOCK on a review where every persona actually completed and approved.
  describe('evidence-tooling-unavailable degradation (does not force a false BLOCK)', () => {
    it('CORE REGRESSION: ships a clean SHIP verdict with zero lane receipts when evidence tooling was deliberately unavailable', () => {
      const result = deriveReceiptOutcome({
        arbitration: cleanShip,
        unitManifest: completeManifest,
        laneReceipts: [],
        findingVerification: completeVerification,
        headCurrent: true,
        evidenceEnabled: false,
      });
      expect(result).toMatchObject({ verdict: 'SHIP', gateDecision: 'PASS', mergeEligible: true, promotionReady: true });
      // Must not silently claim full coverage -- the degraded state stays visible.
      expect(result.coverageStatus).not.toBe('complete');
    });

    it('OVER-CORRECTION GUARD: still BLOCKs on zero lane receipts when evidence tooling was enabled (a genuine failure)', () => {
      const result = deriveReceiptOutcome({
        arbitration: cleanShip,
        unitManifest: completeManifest,
        laneReceipts: [],
        findingVerification: completeVerification,
        headCurrent: true,
        evidenceEnabled: true,
      });
      expect(result).toMatchObject({ verdict: 'BLOCK', gateDecision: 'BLOCKED', mergeEligible: false });
    });

    it('FINDINGS ALWAYS WIN: still blocks a FIX_FIRST/BLOCK arbitration verdict even when evidence tooling was unavailable', () => {
      const fixFirst = { verdict: 'FIX_FIRST', status: 'FIX_FIRST', rationale: 'Real defect found.', mergeEligible: false, findings: [{ title: 'sql injection' }] };
      const result = deriveReceiptOutcome({
        arbitration: fixFirst,
        unitManifest: completeManifest,
        laneReceipts: [],
        findingVerification: completeVerification,
        headCurrent: true,
        evidenceEnabled: false,
      });
      expect(result).toMatchObject({ verdict: 'FIX_FIRST', gateDecision: 'BLOCKED', mergeEligible: false });
    });

    it('reproduces the live incident shape: 5 completed persona lanes, finding-verifier flagged incomplete only because navigation was truncated', () => {
      // This mirrors the exact production shape: laneReceipts are NOT empty (every persona
      // lane completed normally), but findingVerification.summary.incomplete was forced true
      // upstream by the monorepo navigation-snapshot truncation, not a real defect.
      const completedLanes = ['security', 'testing', 'style', 'architecture', 'performance'].map((personaId) => (
        createLaneExecutionReceipt({ identity, personaId, plan, termination: 'completed' })
      ));
      const result = deriveReceiptOutcome({
        arbitration: cleanShip,
        unitManifest: completeManifest,
        laneReceipts: completedLanes,
        findingVerification: { summary: { incomplete: true, needsReview: 0 } },
        headCurrent: true,
        evidenceEnabled: false,
      });
      expect(result).toMatchObject({ verdict: 'SHIP', gateDecision: 'PASS', mergeEligible: true });
    });
  });
});
