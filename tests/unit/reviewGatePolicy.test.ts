import { describe, expect, it } from 'vitest';
import { evaluateReviewGate, type ReviewGateEvidence, type ReviewRiskAcceptance } from '../../src/review/reviewGatePolicy';
import { createReviewDecisionV2 } from '../../src/review/reviewDecision';

const candidate = { repositoryId: 123, prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64) };
const current = { ...candidate, open: true, draft: false };
const clean: ReviewGateEvidence = {
  verdict: 'SHIP', completedAt: '2026-09-09T12:00:00Z', coverageComplete: true,
  quorumSatisfied: true, infrastructureFailure: false, p0Count: 0, p1Count: 0, p2Count: 0,
  expectedLanes: 6, completedLanes: 6,
};
const decisionV2 = (overrides: Record<string, unknown> = {}) => createReviewDecisionV2({
  schemaVersion: 'review-yeti-decision.v2',
  policyVersion: 'review-yeti-severity.v2',
  policyDigest: candidate.policyDigest,
  coverageComplete: true,
  quorumSatisfied: true,
  infrastructureFailure: false,
  expectedLanes: 6,
  completedLanes: 6,
  counts: { p0Count: 0, p1Count: 0, p2Count: 1, p3Count: 1, nitCount: 1 },
  ...overrides,
} as Parameters<typeof createReviewDecisionV2>[0]);
const acceptance: ReviewRiskAcceptance = {
  label: 'review-yeti/accepted-risk', labelPresent: true, eventId: 99,
  actorLogin: 'reviewer', actorType: 'User', actorPermission: 'write', appliedAt: '2026-09-09T12:01:00Z',
};
const evaluate = (evidence = clean, risk?: ReviewRiskAcceptance) => evaluateReviewGate({ candidate, current, evidence, acceptance: risk });

describe('service review eligibility policy', () => {
  it('never treats dispatch admission as a completed review', () => {
    expect(evaluateReviewGate({ candidate, current })).toMatchObject({ status: 'pending', eligible: false });
  });
  it('does not let the legacy global passthrough boolean approve mismatched coordinates', () => {
    expect(evaluateReviewGate({ candidate, current: { ...current, headSha: 'e'.repeat(40) }, evidence: clean, passthrough: true }))
      .toMatchObject({ status: 'cancelled', eligible: false, reason: 'candidate-superseded' });
  });
  it('does not treat the global passthrough boolean as verified review evidence', () => {
    expect(evaluateReviewGate({ candidate, current, passthrough: true }))
      .toMatchObject({ status: 'pending', eligible: false, reason: 'review-pending' });
  });
  it.each(['headSha', 'baseSha', 'policyDigest', 'repositoryId', 'prNumber'] as const)('fences a changed %s', (field) => {
    const value = typeof current[field] === 'number' ? 321 : 'd'.repeat(String(current[field]).length);
    expect(evaluateReviewGate({ candidate, current: { ...current, [field]: value }, evidence: clean }))
      .toMatchObject({ status: 'cancelled', eligible: false, reason: 'candidate-superseded' });
  });
  it('rejects a closed PR and leaves draft readiness independent', () => {
    expect(evaluateReviewGate({ candidate, current: { ...current, open: false }, evidence: clean }).eligible).toBe(false);
    expect(evaluateReviewGate({ candidate, current: { ...current, draft: true }, evidence: clean }))
      .toEqual({ status: 'success', eligible: true, reason: 'clean-review' });
    expect(current.draft).toBe(false);
  });
  it.each([
    { infrastructureFailure: true }, { coverageComplete: false }, { quorumSatisfied: false },
    { completedLanes: 5 }, { completedLanes: 7 }, { expectedLanes: 0, completedLanes: 0 },
    { p0Count: 1 }, { p1Count: 1 }, { verdict: 'BLOCK' as const },
  ])('does not approve partial, contradictory or failed evidence: %j', (patch) => {
    expect(evaluate({ ...clean, ...patch }, acceptance).eligible).toBe(false);
  });
  it('retains actor, permission and after-verdict audit when accepting FIX_FIRST', () => {
    expect(evaluate({ ...clean, verdict: 'FIX_FIRST', p1Count: 1 }, acceptance)).toEqual({
      status: 'success', eligible: true, reason: 'human-accepted-risk',
      audit: { eventId: 99, actorLogin: 'reviewer', actorPermission: 'write', appliedAt: acceptance.appliedAt, reviewedAt: clean.completedAt },
    });
  });
  it.each([
    { label: 'approved' }, { labelPresent: false }, { actorType: 'Bot' },
    { actorPermission: 'read' }, { actorPermission: 'triage' }, { eventId: 0 },
    { appliedAt: '2026-09-09T11:59:59Z' }, { appliedAt: 'invalid' },
  ])('rejects ineffective human acceptance: %j', (patch) => {
    expect(evaluate({ ...clean, verdict: 'FIX_FIRST', p1Count: 1 }, { ...acceptance, ...patch }).eligible).toBe(false);
  });
  it('does not accept BLOCK or a P0 even with an authorized fresh label', () => {
    expect(evaluate({ ...clean, verdict: 'BLOCK', p1Count: 1 }, acceptance).eligible).toBe(false);
    expect(evaluate({ ...clean, verdict: 'FIX_FIRST', p0Count: 1, p1Count: 1 }, acceptance).eligible).toBe(false);
  });
  it.each(['recap-only', 'no-reviewable-content'] as const)('requires explicit audit for %s', (kind) => {
    const exemption = { kind, auditDigest: 'd'.repeat(64) };
    const evidence = { ...clean, expectedLanes: 0, completedLanes: 0, exemption };
    expect(evaluate(evidence)).toEqual({ status: 'success', eligible: true, reason: 'central-exemption' });
    expect(evaluate({ ...evidence, exemption: { kind, auditDigest: '' } }).eligible).toBe(false);
    expect(evaluate({ ...evidence, infrastructureFailure: true }).eligible).toBe(false);
    expect(evaluate({ ...evidence, verdict: 'BLOCK' }).eligible).toBe(false);
    expect(evaluate({ ...evidence, p1Count: 1 }).eligible).toBe(false);
  });
  it.each([{ p1Count: -1 }, { expectedLanes: NaN }, { completedAt: 'yesterday' }])('fails closed on malformed evidence: %j', (patch) => {
    expect(evaluate({ ...clean, ...patch })).toMatchObject({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
  });
});

describe('ADR 0002: a required P2 blocks the Gate exactly like a P0/P1', () => {
  it('fails a SHIP review that still carries a required P2', () => {
    expect(evaluate({ ...clean, p2Count: 1 })).toEqual({ status: 'failure', eligible: false, reason: 'blocking-findings' });
  });
  it('approves a SHIP review whose P2s were all fixed or satisfied', () => {
    expect(evaluate({ ...clean, p2Count: 0 })).toEqual({ status: 'success', eligible: true, reason: 'clean-review' });
  });
  it('refuses evidence that omits the required P2 count instead of treating it as zero (fail closed)', () => {
    const { p2Count: _omitted, ...withoutCount } = clean;
    expect(evaluate(withoutCount as typeof clean)).toMatchObject({ status: 'failure', reason: 'invalid-evidence' });
  });
  it('rejects a malformed count and never lets an exemption carry a required P2', () => {
    expect(evaluate({ ...clean, p2Count: -1 })).toMatchObject({ reason: 'invalid-evidence' });
    expect(evaluate({ ...clean, p2Count: 1.5 })).toMatchObject({ reason: 'invalid-evidence' });
    const exempt = { ...clean, expectedLanes: 0, completedLanes: 0, exemption: { kind: 'recap-only' as const, auditDigest: 'd'.repeat(64) } };
    expect(evaluate({ ...exempt, p2Count: 1 })).toMatchObject({ reason: 'invalid-evidence' });
  });
});

describe('ReviewYetiDecision.v2 eligibility', () => {
  it('approves a complete advisory-only review while retaining all advisory counts', () => {
    const evidence = {
      ...clean,
      // Under v2 this legacy column counts required P2 only; advisory totals remain in the receipt.
      p2Count: 0,
      reviewDecision: decisionV2(),
    };
    expect(evaluate(evidence as ReviewGateEvidence)).toEqual({
      status: 'success', eligible: true, reason: 'clean-review',
    });
  });

  it('approves a complete P3-only review under the new policy', () => {
    expect(evaluate({ ...clean, p2Count: 0, reviewDecision: decisionV2({
      counts: { p0Count: 0, p1Count: 0, p2Count: 0, p3Count: 1, nitCount: 0 },
    }) } as ReviewGateEvidence)).toEqual({ status: 'success', eligible: true, reason: 'clean-review' });
  });

  it('blocks one verified P1 even when the worker verdict says SHIP', () => {
    const evidence = {
      ...clean,
      verdict: 'SHIP' as const,
      p1Count: 1,
      reviewDecision: decisionV2({ counts: { p0Count: 0, p1Count: 1, p2Count: 0, p3Count: 0, nitCount: 0 } }),
    };
    expect(evaluate(evidence as ReviewGateEvidence).eligible).toBe(false);
  });

  it('fails closed when v2 coverage is incomplete even if there are no findings', () => {
    const evidence = {
      ...clean,
      coverageComplete: false,
      quorumSatisfied: false,
      reviewDecision: decisionV2({ coverageComplete: false, quorumSatisfied: false }),
    };
    expect(evaluate(evidence as ReviewGateEvidence)).toMatchObject({
      status: 'failure', eligible: false, reason: 'incomplete-review',
    });
  });

  it('rejects a v2 decision bound to another policy digest', () => {
    const evidence = {
      ...clean,
      p2Count: 1,
      reviewDecision: decisionV2({ policyDigest: 'd'.repeat(64) }),
    };
    expect(evaluate(evidence as ReviewGateEvidence)).toMatchObject({
      status: 'failure', eligible: false, reason: 'invalid-evidence',
    });
  });

  it('rejects a forged eligible bit and counts that disagree with service evidence', () => {
    const blocked = decisionV2({ counts: { p0Count: 0, p1Count: 1, p2Count: 0, p3Count: 0, nitCount: 0 } });
    expect(evaluate({ ...clean, verdict: 'FIX_FIRST', p1Count: 1,
      reviewDecision: { ...blocked, eligible: true } } as ReviewGateEvidence))
      .toMatchObject({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
    expect(evaluate({ ...clean, reviewDecision: decisionV2(), p2Count: 1 } as ReviewGateEvidence))
      .toMatchObject({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
  });

  it('rejects a clean receipt paired with a non-SHIP publication verdict', () => {
    expect(evaluate({ ...clean, verdict: 'FIX_FIRST', reviewDecision: decisionV2() } as ReviewGateEvidence))
      .toMatchObject({ status: 'failure', eligible: false, reason: 'invalid-evidence' });
  });
});
