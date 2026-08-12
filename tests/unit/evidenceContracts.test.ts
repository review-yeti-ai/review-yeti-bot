import { describe, expect, it } from 'vitest';

const contracts = require('../../src/review/evidenceContracts.js');
const { createReviewIdentity, reviewIdentityDigest } = require('../../src/review/reviewContracts.js');

const identity = createReviewIdentity({
  repository: 'review-yeti-ai/review-yeti-bot',
  prNumber: 31,
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  trustedConfig: { review: { investigation: {} } },
  effectivePolicy: { personas: ['security'] },
});

describe('bounded evidence contracts', () => {
  it('clamps trusted limits and ignores PR-controlled enablement fields', () => {
    expect(contracts.normalizeInvestigationLimits({ maxCalls: 99, enabled: false })).toEqual({
      maxCalls: 40,
      maxReadLines: 400,
      maxSearchMatches: 50,
      maxResultBytes: 8000,
      maxRepeatedCalls: 2,
      maxCandidateFindings: 5,
      maxVerifierCallsPerFinding: 3,
      // REL-272: bounded default dropped 4 -> 2.
      maxTurns: 2,
    });
  });

  it('clamps an explicit maxTurns at the hard ceiling of 3 (REL-272)', () => {
    expect(contracts.normalizeInvestigationLimits({ maxTurns: 99 }).maxTurns).toBe(3);
    expect(contracts.normalizeInvestigationLimits({ maxTurns: 1 }).maxTurns).toBe(1);
    expect(contracts.normalizeInvestigationLimits({ maxTurns: 3 }).maxTurns).toBe(3);
  });

  it('binds every lane receipt to the immutable review identity', () => {
    const plan = contracts.createRiskPlan({
      identity,
      personaId: 'security',
      items: [{ id: 'risk-1', unitIds: ['ru_abc'], statement: 'authorization can be bypassed', evidenceNeeded: ['read caller'], allowedTools: ['file_read'] }],
    });
    const evidence = contracts.createEvidenceReceipt({
      identity,
      request: { personaId: 'security', riskId: 'risk-1', tool: 'file_read', args: { path: 'src/a.js' } },
      result: { status: 'ok', content: 'bounded', byteCount: 7 },
    });
    const lane = contracts.createLaneExecutionReceipt({ identity, personaId: 'security', plan, evidence: [evidence], findings: [], termination: 'completed' });
    expect(lane.identityDigest).toBe(reviewIdentityDigest(identity));
    expect(contracts.validateLaneExecutionReceipt({ ...lane, identityDigest: '0'.repeat(64) })).toMatchObject({ valid: false, reason: 'identity_mismatch' });
  });

  it('rejects tool and termination values outside the contract', () => {
    expect(() => contracts.createEvidenceReceipt({ identity, request: { personaId: 'security', riskId: 'risk-1', tool: 'bash', args: {} }, result: { status: 'ok' } })).toThrow(/allowlisted/);
    expect(() => contracts.createLaneExecutionReceipt({ identity, personaId: 'security', plan: { planDigest: 'p'.repeat(64) }, termination: 'green' })).toThrow(/allowlisted/);
  });
});
