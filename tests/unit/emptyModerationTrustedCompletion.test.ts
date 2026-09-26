import { describe, expect, it } from 'vitest';
import {
  deriveCanonicalWorkerReviewEvidence,
  parseWorkerReviewCompletion,
  type TrustedReviewCoverageContract,
  type WorkerReviewCompletion,
} from '../../src/review/workerReviewCompletion';

/**
 * REL-1139 (ct-meta ADR 0687): the trusted completion side re-runs the shared empty-moderation
 * decision on its own exact-head facts. A completion that claims a skipped moderator is accepted
 * only when that decision allows it; every disqualifier refuses the claim (fail closed).
 */

const changedFiles = [{ path: 'src/example.ts', patch: '@@ -1,0 +1,2 @@\n+const first = 1;\n+const second = 2;\n' }];
const coordinates = {
  runId: `run_${'a'.repeat(32)}`, repositoryId: 3210, owner: 'calltelemetry', repo: 'review-yeti-bot', prNumber: 42,
  headSha: 'b'.repeat(40), baseSha: 'c'.repeat(40), policyDigest: 'd'.repeat(64), configDigest: 'e'.repeat(64), executionAttempt: 2,
} as const;
const disclosures = { truncatedFiles: 0, unavailablePatches: 0, omittedSourcePaths: 0, routedFiles: 0, uncoveredPaths: 0 };

function contract(overrides: Partial<TrustedReviewCoverageContract> = {}): TrustedReviewCoverageContract {
  return {
    expectedCoordinates: coordinates, expectedPersonaIds: ['security', 'architecture'], changedFiles,
    coverageComplete: true, quorumSatisfied: true, emptyModeration: disclosures, ...overrides,
  };
}

const lane = (id: string, overrides: Record<string, unknown> = {}) => ({ id, decision: 'APPROVE', findings: [], ...overrides });

function completion(result: Record<string, unknown> = {}): WorkerReviewCompletion {
  return {
    version: 'WorkerReviewCompletion.v1', ...coordinates,
    result: {
      version: 'WorkerReviewResult.v1', completedAt: '2026-09-26T12:00:00.000Z',
      personas: [lane('security'), lane('architecture')], coverageComplete: true, quorumSatisfied: true,
      moderation: 'skipped-empty', ...result,
    },
  } as WorkerReviewCompletion;
}

function refusal(input: WorkerReviewCompletion, trusted: TrustedReviewCoverageContract): string {
  const derived = deriveCanonicalWorkerReviewEvidence(input, trusted);
  expect(derived.valid).toBe(false);
  return derived.valid ? '' : derived.message;
}

describe('trusted completion re-decides a skipped-moderator claim (REL-1139)', () => {
  it('accepts the claim on an eligible run, and the verdict is SHIP', () => {
    const derived = deriveCanonicalWorkerReviewEvidence(completion(), contract());
    expect(derived.valid).toBe(true);
    if (derived.valid) expect(derived.canonical.verdict).toBe('SHIP');
  });

  it('leaves a completion without the claim unchanged, even with no disclosures in the contract', () => {
    const input = completion();
    delete (input.result as Record<string, unknown>).moderation;
    expect(deriveCanonicalWorkerReviewEvidence(input, contract({ emptyModeration: undefined })).valid).toBe(true);
    // ...and with a lane finding or a sensitive path, which only a claim would make invalid.
    const sensitive = [{ path: 'src/auth/session.ts', patch: changedFiles[0].patch }];
    expect(deriveCanonicalWorkerReviewEvidence(input, contract({ changedFiles: sensitive })).valid).toBe(true);
  });

  it('only accepts the literal claim value', () => {
    expect(() => parseWorkerReviewCompletion(completion({ moderation: 'skipped' }))).toThrow();
  });

  it('refuses the claim when the trusted context has no disclosures', () => {
    expect(refusal(completion(), contract({ emptyModeration: undefined }))).toMatch(/no empty-moderation disclosures/u);
  });

  const P2 = { severity: 'P2', path: 'src/example.ts', line: 1, title: 'Nit', body: 'Tidy' };
  const cases: Array<[string, Record<string, unknown>, Partial<TrustedReviewCoverageContract>, RegExp]> = [
    ['a lane with a P2 finding (verdict still SHIP)', { personas: [lane('security', { decision: 'FINDINGS', findings: [P2] }), lane('architecture')] }, {}, /lane-not-approve/u],
    ['an APPROVE lane carrying a finding', { personas: [lane('security', { findings: [P2] }), lane('architecture')] }, {}, /lane-findings/u],
    ['a failed lane', { personas: [lane('security', { decision: 'ERROR', status: 'ERROR', errorClass: 'transport' }), lane('architecture')] }, {}, /lane-failed/u],
    ['a missing lane', { personas: [lane('security')] }, {}, /lane-missing/u],
    ['incomplete worker coverage', { coverageComplete: false }, {}, /coverage-incomplete/u],
    ['incomplete trusted coverage', {}, { coverageComplete: false }, /coverage-incomplete/u],
    ['a security-sensitive file', {}, { changedFiles: [...changedFiles, { path: 'package-lock.json', patch: '@@ -1 +1 @@\n-a\n+b\n' }] }, /security-sensitive-file/u],
    ['a truncated patch', {}, { emptyModeration: { ...disclosures, truncatedFiles: 1 } }, /truncated/u],
    ['an unavailable patch', {}, { emptyModeration: { ...disclosures, unavailablePatches: 1 } }, /patch-unavailable/u],
    ['omitted source', {}, { emptyModeration: { ...disclosures, omittedSourcePaths: 1 } }, /omitted-source/u],
    ['a routed file', {}, { emptyModeration: { ...disclosures, routedFiles: 1 } }, /routed-files/u],
    ['an uncovered path', {}, { emptyModeration: { ...disclosures, uncoveredPaths: 1 } }, /uncovered-paths/u],
  ];
  it.each(cases)('refuses the claim on %s', (_label, result, trusted, message) => {
    expect(refusal(completion(result), contract(trusted))).toMatch(message);
  });

  it('refuses the claim on a documentation-only exemption', () => {
    const input = completion({ personas: [lane('documentation-only', { status: 'COMPLETE' })] });
    const docs = [{ path: 'README.md', patch: '@@ -1 +1 @@\n-a\n+b\n' }];
    expect(refusal(input, contract({ changedFiles: docs }))).toMatch(/documentation-only completion claims a skipped moderator/u);
  });
});
