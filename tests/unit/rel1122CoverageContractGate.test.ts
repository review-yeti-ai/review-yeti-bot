import { describe, expect, it } from 'vitest';
import {
  coverageContractGateDecision,
  coverageContractGateDetailOf,
  coverageContractGateMetadata,
  PERSONA_COVERAGE_FAILURE_REASON,
} from '../../src/review/coverageContractGate';
import {
  TrustedCompletionResolutionError,
  trustedCompletionResolutionReasons,
} from '../../src/review/workerCompletionPersistenceError';
import { isRecoverableFailureTitle } from '../../src/review/reviewCheckIdentity';
import { personaCoverageError } from '../../src/panel/panelEngine';
import { buildWorkerFailureDiagnostics } from '../../src/review/workerCompletion';
import { isInfrastructureIncompleteResult } from '../../src/review/laneInfrastructure';

// REL-1122: a coverage-contract failure found by the trusted context is a terminal
// gate outcome (failure / incomplete-review), not a refusal of the completion.
describe('REL-1122 coverage-contract gate decision', () => {
  it('turns a trusted coverage-no-persona failure into a terminal incomplete-review failure', () => {
    const decision = coverageContractGateDecision(new TrustedCompletionResolutionError('applicability', 'coverage-no-persona'));
    expect(decision).toEqual({ status: 'failure', eligible: false, reason: 'incomplete-review', detail: 'coverage-no-persona' });
  });

  // Negative proof: every other class keeps its existing handling (422 or 503).
  it.each(trustedCompletionResolutionReasons.filter((reason) => reason !== 'coverage-no-persona'))(
    'leaves %s to its existing handling', (reason) => {
      expect(coverageContractGateDecision(new TrustedCompletionResolutionError('exact-diff', reason))).toBeUndefined();
    });

  it('never trusts a look-alike error that is not the service-owned resolution error', () => {
    const forged = Object.assign(new Error('Authoritative completion context unavailable'), { reason: 'coverage-no-persona' });
    expect(coverageContractGateDecision(forged)).toBeUndefined();
    expect(coverageContractGateDecision({ reason: 'coverage-no-persona' })).toBeUndefined();
    expect(coverageContractGateDecision(undefined)).toBeUndefined();
  });

  it('is never an approval and never the infrastructure reason REL-1113 re-attempts', () => {
    const decision = coverageContractGateDecision(new TrustedCompletionResolutionError('applicability', 'coverage-no-persona'))!;
    expect(decision.eligible).toBe(false);
    expect(decision.status).toBe('failure');
    expect(decision.reason).not.toBe('infrastructure-failure');
  });

  it('reads back only the finite detail set', () => {
    expect(coverageContractGateDetailOf({ detail: 'coverage-no-persona' })).toBe('coverage-no-persona');
    for (const value of [undefined, null, 'coverage-no-persona', {}, { detail: 'bounds' }, { detail: 'x'.repeat(500) }, { detail: 1 }]) {
      expect(coverageContractGateDetailOf(value)).toBeUndefined();
    }
  });

  it('publishes a bounded INCOMPLETE title outside the recoverable infrastructure family', () => {
    const { title, summary } = coverageContractGateMetadata('coverage-no-persona');
    expect(title).toMatch(/^Review Yeti Gate: INCOMPLETE — coverage \(/u);
    expect(title.length).toBeLessThanOrEqual(140);
    // A re-run cannot fix a coverage gap, so the exact-head recovery affordance is not offered.
    expect(isRecoverableFailureTitle(title)).toBe(false);
    expect(summary).toContain('not a findings verdict');
    expect(summary).toContain('not an infrastructure failure');
    expect(summary).not.toMatch(/SHIP|approved/u);
  });
});

describe('REL-1122 worker side: the no-persona ERROR completion names its class', () => {
  it('tags the shared coverage error with the finite reason and never the retry marker', () => {
    const error = personaCoverageError('o/r', 'a'.repeat(40), ['.tool-versions'], [{ id: 'sec-lane' }]);
    expect(error.failureClass).toBe('contract');
    expect(error.failureReason).toBe(PERSONA_COVERAGE_FAILURE_REASON);
    const diagnostics = buildWorkerFailureDiagnostics(error, 'contract');
    expect(diagnostics.reason).toBe('coverage_no_persona');
    expect(diagnostics.recoverableIncompletePanel).toBeUndefined();
  });

  it('negative: a contract failure that is not a coverage gap keeps the generic reason', () => {
    const diagnostics = buildWorkerFailureDiagnostics(new Error('publishing review worker contract is invalid'), 'contract');
    expect(diagnostics.reason).toBe('worker_contract_invalid');
  });
});

describe('REL-1122 stays outside REL-1113 automatic re-attempt', () => {
  it('the worker no-persona ERROR body is not an infrastructure-incomplete result', () => {
    const error = personaCoverageError('o/r', 'a'.repeat(40), ['.tool-versions'], [{ id: 'sec-lane' }]);
    expect(isInfrastructureIncompleteResult({
      personas: ['sec-lane', 'arch-lane'].map((id) => ({ id, decision: 'ERROR', status: 'ERROR', errorClass: 'contract', findings: [] })),
      coverageComplete: false, quorumSatisfied: false,
      failureDiagnostics: buildWorkerFailureDiagnostics(error, 'contract'),
    } as never)).toBe(false);
  });
});
