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
    // Operator directive 2026-08-19: budgets unlocked — generous defaults,
    // higher runaway backstops; the lane deadline is the cost governor.
    expect(contracts.normalizeInvestigationLimits({ maxCalls: 999, enabled: false })).toEqual({
      maxCalls: 100,
      maxReadLines: 800,
      maxSearchMatches: 100,
      maxResultBytes: 32000,
      maxRepeatedCalls: 2,
      maxCandidateFindings: 10,
      maxVerifierCallsPerFinding: 3,
      maxTurns: 3,
    });
  });

  it('clamps an explicit maxTurns at the unlocked hard ceiling of 8', () => {
    expect(contracts.normalizeInvestigationLimits({ maxTurns: 99 }).maxTurns).toBe(8);
    expect(contracts.normalizeInvestigationLimits({ maxTurns: 1 }).maxTurns).toBe(1);
    expect(contracts.normalizeInvestigationLimits({ maxTurns: 6 }).maxTurns).toBe(6);
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

  it('allowlists library_docs as a fifth evidence tool and receipts it like the other four', () => {
    expect(contracts.EVIDENCE_TOOLS.has('library_docs')).toBe(true);
    const receipt = contracts.createEvidenceReceipt({
      identity,
      request: { personaId: 'security', riskId: 'risk-1', tool: 'library_docs', args: { library: 'react', topic: 'useEffect cleanup' } },
      result: { status: 'ok', byteCount: 42 },
    });
    expect(receipt).toMatchObject({ tool: 'library_docs', status: 'ok' });
    // The receipt is built from the tool's bounded result object, never from raw config/env --
    // an argumentDigest, not the args themselves, is what's persisted.
    expect(receipt.argumentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain('CONTEXT7_API_KEY');
  });
});
