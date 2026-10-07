import { findingFingerprint, type PriorFindingThread } from '../../src/review/findingConvergence';
import type { ReviewChangedFile } from '../../src/review/reviewCore';
import { evaluateReviewGate, type ReviewRiskAcceptance } from '../../src/review/reviewGatePolicy';
import {
  deriveCanonicalWorkerReviewEvidence,
  parseWorkerReviewCompletion,
  workerReviewCompletionDigest,
  type TrustedGroundedVerifierRouting,
} from '../../src/review/workerReviewCompletion';

/**
 * REL-1084/REL-1085: what the trusted completion transaction
 * (`PostgresReviewGateRepository.recordWorkerResult`) stores for a completion, computed by the
 * same two calls it makes: `deriveCanonicalWorkerReviewEvidence` over the service's trusted lane
 * set and changed files, then `evaluateReviewGate`. Returns the gate row
 * (`review_gate_attempts.worker_result_digest/evidence/decision`) and the run status it writes.
 *
 * Tests build a prior review record from this instead of hand-writing a SHIP verdict, so a
 * fixture can never again claim a verdict the gate would not have derived.
 */
export function gateRecordFor(completionInput: unknown, trusted: {
  expectedPersonaIds: readonly string[];
  changedFiles: readonly ReviewChangedFile[];
  coverageComplete?: boolean;
  quorumSatisfied?: boolean;
  acceptance?: ReviewRiskAcceptance;
  /** ADR 0002: the bot's finding threads the service read; a resolved-with-reason P2 is satisfied. */
  findingThreads?: readonly PriorFindingThread[];
  /** Trusted test-side mirror of the prepared primary/alternate verifier configuration. */
  groundedVerifierRouting?: TrustedGroundedVerifierRouting;
}) {
  const completion = parseWorkerReviewCompletion(completionInput);
  const { version: _version, result: _result, ...expectedCoordinates } = completion;
  const derived = deriveCanonicalWorkerReviewEvidence(completion, {
    expectedCoordinates,
    expectedPersonaIds: trusted.expectedPersonaIds,
    changedFiles: trusted.changedFiles,
    coverageComplete: trusted.coverageComplete ?? true,
    quorumSatisfied: trusted.quorumSatisfied ?? true,
    ...(trusted.groundedVerifierRouting ? { groundedVerifierRouting: trusted.groundedVerifierRouting } : {}),
    ...(trusted.findingThreads ? { findingThreads: trusted.findingThreads } : {}),
  });
  const candidate = {
    repositoryId: completion.repositoryId, prNumber: completion.prNumber,
    headSha: completion.headSha, baseSha: completion.baseSha, policyDigest: completion.policyDigest,
  };
  const evidence = derived.valid ? derived.evidence : undefined;
  const decision = evidence
    ? evaluateReviewGate({ candidate, current: { ...candidate, open: true, draft: false }, evidence,
      ...(trusted.acceptance ? { acceptance: trusted.acceptance } : {}) })
    : { status: 'failure' as const, eligible: false as const, reason: 'invalid-evidence' as const };
  const status = decision.status === 'success' ? 'succeeded' : decision.status === 'cancelled' ? 'superseded' : 'failed';
  return {
    status,
    decision,
    gate: {
      worker_result_digest: workerReviewCompletionDigest(completion),
      evidence: evidence ? JSON.stringify(evidence) : null,
      decision: JSON.stringify(decision),
    },
  };
}

/** ADR 0002: threads in which the author resolved each given P2 with a stated reason. */
export function resolvedThreadsFor(findings: ReadonlyArray<{ path: string; line: number; title: string }>): PriorFindingThread[] {
  return findings.map((finding) => ({
    fingerprint: findingFingerprint(finding), severity: 'P2', path: finding.path, line: finding.line, title: finding.title,
    resolved: true, outdated: false,
    resolution: { author: 'author1', reason: 'Intentional; documented in the module header and covered by a test.' },
  }));
}
