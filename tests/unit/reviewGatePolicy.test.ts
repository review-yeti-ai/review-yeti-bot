import { describe, expect, it } from 'vitest';
import { evaluateReviewGate, type ReviewGateEvidence, type ReviewRiskAcceptance } from '../../src/review/reviewGatePolicy';

const candidate = { repositoryId: 123, prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64) };
const current = { ...candidate, open: true, draft: false };
const clean: ReviewGateEvidence = {
  verdict: 'SHIP', completedAt: '2026-09-09T12:00:00Z', coverageComplete: true,
  quorumSatisfied: true, infrastructureFailure: false, p0Count: 0, p1Count: 0,
  expectedLanes: 6, completedLanes: 6,
};
const acceptance: ReviewRiskAcceptance = {
  label: 'review-yeti/accepted-risk', labelPresent: true, eventId: 99,
  actorLogin: 'reviewer', actorType: 'User', actorPermission: 'write', appliedAt: '2026-09-09T12:01:00Z',
};
const evaluate = (evidence = clean, risk?: ReviewRiskAcceptance) => evaluateReviewGate({ candidate, current, evidence, acceptance: risk });

describe('service review eligibility policy', () => {
  it('never treats dispatch admission as a completed review', () => {
    expect(evaluateReviewGate({ candidate, current })).toMatchObject({ status: 'pending', eligible: false });
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
