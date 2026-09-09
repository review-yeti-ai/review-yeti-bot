/** Pure eligibility policy. Inputs must be collected by the trusted service,
 * never taken from a label, dispatch payload or candidate-produced artifact. */
export interface ReviewGateCandidate {
  repositoryId: number;
  prNumber: number;
  headSha: string;
  baseSha: string;
  policyDigest: string;
}

export interface ReviewGateEvidence {
  verdict: 'SHIP' | 'FIX_FIRST' | 'BLOCK';
  completedAt: string;
  coverageComplete: boolean;
  quorumSatisfied: boolean;
  infrastructureFailure: boolean;
  p0Count: number;
  p1Count: number;
  /** Only a centrally verified exemption may replace a completed panel. */
  exemption?: { kind: 'recap-only' | 'no-reviewable-content'; auditDigest: string };
  expectedLanes: number;
  completedLanes: number;
}

export interface ReviewRiskAcceptance {
  label: string;
  labelPresent: boolean;
  eventId: number;
  actorLogin: string;
  actorType: string;
  actorPermission: string;
  appliedAt: string;
}

export type ReviewGateDecision =
  | { status: 'pending'; eligible: false; reason: 'review-pending' }
  | { status: 'cancelled'; eligible: false; reason: 'candidate-superseded' | 'pull-request-closed' }
  | { status: 'failure'; eligible: false; reason: 'invalid-evidence' | 'infrastructure-failure' | 'incomplete-review' | 'blocking-findings' }
  | { status: 'success'; eligible: true; reason: 'clean-review' | 'central-exemption' }
  | { status: 'success'; eligible: true; reason: 'human-accepted-risk'; audit: {
    eventId: number; actorLogin: string; actorPermission: string; appliedAt: string; reviewedAt: string;
  } };

function timestamp(value: string): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateValid(candidate: ReviewGateCandidate): boolean {
  return Number.isSafeInteger(candidate.repositoryId) && candidate.repositoryId > 0
    && Number.isSafeInteger(candidate.prNumber) && candidate.prNumber > 0
    && /^[a-f0-9]{40}$/u.test(candidate.headSha) && /^[a-f0-9]{40}$/u.test(candidate.baseSha)
    && /^[a-f0-9]{64}$/u.test(candidate.policyDigest);
}

export function evaluateReviewGate(input: {
  candidate: ReviewGateCandidate;
  current: ReviewGateCandidate & { open: boolean; draft: boolean };
  evidence?: ReviewGateEvidence;
  acceptance?: ReviewRiskAcceptance;
}): ReviewGateDecision {
  const { candidate, current, evidence, acceptance } = input;
  const invalid = { status: 'failure', eligible: false, reason: 'invalid-evidence' } as const;
  if (!candidateValid(candidate) || !candidateValid(current)
    || typeof current.open !== 'boolean' || typeof current.draft !== 'boolean') return invalid;
  if (!current.open) return { status: 'cancelled', eligible: false, reason: 'pull-request-closed' };
  if (candidate.repositoryId !== current.repositoryId || candidate.prNumber !== current.prNumber
    || candidate.headSha !== current.headSha || candidate.baseSha !== current.baseSha
    || candidate.policyDigest !== current.policyDigest) {
    return { status: 'cancelled', eligible: false, reason: 'candidate-superseded' };
  }
  if (!evidence) return { status: 'pending', eligible: false, reason: 'review-pending' };
  const reviewedAt = timestamp(evidence.completedAt);
  if (reviewedAt === null || !['SHIP', 'FIX_FIRST', 'BLOCK'].includes(evidence.verdict)
    || [evidence.p0Count, evidence.p1Count, evidence.expectedLanes, evidence.completedLanes]
      .some((count) => !Number.isSafeInteger(count) || count < 0)
    || [evidence.coverageComplete, evidence.quorumSatisfied, evidence.infrastructureFailure]
      .some((value) => typeof value !== 'boolean')) return invalid;
  if (evidence.infrastructureFailure) return { status: 'failure', eligible: false, reason: 'infrastructure-failure' };
  if (!evidence.coverageComplete || !evidence.quorumSatisfied) {
    return { status: 'failure', eligible: false, reason: 'incomplete-review' };
  }
  if (evidence.exemption) {
    // A provider-failed or findings-bearing review cannot be recast as exempt.
    if (!['recap-only', 'no-reviewable-content'].includes(evidence.exemption.kind)
      || !/^[a-f0-9]{64}$/u.test(evidence.exemption.auditDigest)
      || evidence.verdict !== 'SHIP' || evidence.p0Count !== 0 || evidence.p1Count !== 0
      || evidence.expectedLanes !== 0 || evidence.completedLanes !== 0) return invalid;
    return { status: 'success', eligible: true, reason: 'central-exemption' };
  }
  if (evidence.expectedLanes === 0 || evidence.completedLanes !== evidence.expectedLanes) {
    return { status: 'failure', eligible: false, reason: 'incomplete-review' };
  }
  if (evidence.verdict === 'SHIP' && evidence.p0Count === 0 && evidence.p1Count === 0) {
    // Eligibility is separate from author readiness. A reviewed draft remains
    // a draft; the CI admission transaction additionally requires !draft.
    return { status: 'success', eligible: true, reason: 'clean-review' };
  }
  const acceptedAt = acceptance ? timestamp(acceptance.appliedAt) : null;
  if (evidence.verdict === 'FIX_FIRST' && evidence.p0Count === 0 && evidence.p1Count > 0
    && acceptance?.label === 'review-yeti/accepted-risk' && acceptance.labelPresent === true
    && acceptance.actorType === 'User' && /^[A-Za-z0-9-]+$/u.test(acceptance.actorLogin)
    && ['admin', 'maintain', 'write'].includes(acceptance.actorPermission)
    && Number.isSafeInteger(acceptance.eventId) && acceptance.eventId > 0
    && acceptedAt !== null && acceptedAt >= reviewedAt) {
    return {
      status: 'success', eligible: true, reason: 'human-accepted-risk',
      audit: {
        eventId: acceptance.eventId, actorLogin: acceptance.actorLogin,
        actorPermission: acceptance.actorPermission, appliedAt: acceptance.appliedAt,
        reviewedAt: evidence.completedAt,
      },
    };
  }
  return { status: 'failure', eligible: false, reason: 'blocking-findings' };
}
