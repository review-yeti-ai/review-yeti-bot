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
});
