import { evaluateReviewDecisionV2, type ReviewDecisionV2 } from './reviewDecision';
import { z } from 'zod';

/** Canonical service-derived P0/P1 payload retained for the post-completion thread publisher. */
export const reviewGateBlockingFindingSchema = z.object({
  fingerprint: z.string().regex(/^fp1_[a-f0-9]{24}$/u),
  severity: z.enum(['P0', 'P1']),
  path: z.string().min(1).max(4_000),
  line: z.number().int().positive().safe(),
  title: z.string().min(1).max(4_000),
  body: z.string().min(1).max(16_000),
  blockerEvidence: z.object({
    trigger: z.string().min(12).max(2_000),
    impact: z.string().min(12).max(2_000),
    violatedContract: z.string().min(12).max(2_000),
  }).strict(),
}).strict();
export const reviewGateBlockingFindingsSchema = z.array(reviewGateBlockingFindingSchema).max(400);
export type ReviewGateBlockingFinding = z.infer<typeof reviewGateBlockingFindingSchema>;

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
  /** Service-verified engine for stored prior rechecks; absent on older panel records. */
  reviewEngine?: 'composed';
  completedAt: string;
  coverageComplete: boolean;
  quorumSatisfied: boolean;
  infrastructureFailure: boolean;
  p0Count: number;
  p1Count: number;
  /**
   * V1: P2 findings still required after convergence. V2: must be zero; advisory P2/P3/NIT counts
   * are carried in the exact decision receipt. Required for both contracts so legacy evidence
   * keeps its existing meaning and v2 cannot be selected through an omitted field.
   */
  p2Count: number;
  /** Present only when the trusted effective policy selected the v2 severity contract. */
  reviewDecision?: ReviewDecisionV2;
  /** Canonical current-head P0/P1 identities, computed by the trusted completion resolver. */
  blockingFingerprints?: string[];
  /** Canonical current-head P0/P1 content and blocker proof, computed by the trusted resolver. */
  blockingFindings?: ReviewGateBlockingFinding[];
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

/**
 * Cancellation reasons are a shared persistence and event-wire contract.
 * Keep their runtime values and TypeScript type sourced from this tuple so a
 * new reason cannot compile in one gate path while snapshots reject it.
 */
export const REVIEW_GATE_CANCELLATION_REASONS = [
  'candidate-superseded',
  'pull-request-closed',
  'pull-request-draft',
  'review-opted-out',
  'operator-cancelled',
] as const;

export type ReviewGateCancellationReason = typeof REVIEW_GATE_CANCELLATION_REASONS[number];

const REVIEW_GATE_PENDING_REASONS = ['review-pending'] as const;
const REVIEW_GATE_TIMEOUT_REASONS = ['review-deadline-exceeded'] as const;
const REVIEW_GATE_FAILURE_REASONS = [
  'invalid-evidence',
  'infrastructure-failure',
  'incomplete-review',
  'blocking-findings',
] as const;
const REVIEW_GATE_AUTOMATIC_SUCCESS_REASONS = ['clean-review', 'central-exemption', 'passthrough'] as const;
const REVIEW_GATE_ACCEPTED_RISK_REASONS = ['human-accepted-risk'] as const;

/** Complete durable gate-decision vocabulary shared by policy and wire schemas. */
export const REVIEW_GATE_REASONS = [
  ...REVIEW_GATE_PENDING_REASONS,
  ...REVIEW_GATE_TIMEOUT_REASONS,
  ...REVIEW_GATE_CANCELLATION_REASONS,
  ...REVIEW_GATE_FAILURE_REASONS,
  ...REVIEW_GATE_AUTOMATIC_SUCCESS_REASONS,
  ...REVIEW_GATE_ACCEPTED_RISK_REASONS,
] as const;

export function isReviewGateCancellationReason(value: unknown): value is ReviewGateCancellationReason {
  return typeof value === 'string'
    && (REVIEW_GATE_CANCELLATION_REASONS as readonly string[]).includes(value);
}

export type ReviewGateDecision =
  | { status: 'pending'; eligible: false; reason: typeof REVIEW_GATE_PENDING_REASONS[number] }
  | { status: 'timed_out'; eligible: false; reason: typeof REVIEW_GATE_TIMEOUT_REASONS[number] }
  | { status: 'cancelled'; eligible: false; reason: ReviewGateCancellationReason }
  | { status: 'failure'; eligible: false; reason: typeof REVIEW_GATE_FAILURE_REASONS[number] }
  | { status: 'success'; eligible: true; reason: typeof REVIEW_GATE_AUTOMATIC_SUCCESS_REASONS[number] }
  | { status: 'success'; eligible: true; reason: typeof REVIEW_GATE_ACCEPTED_RISK_REASONS[number]; audit: {
    eventId: number; actorLogin: string; actorPermission: string; appliedAt: string; reviewedAt: string;
  } };

/** Validate persisted status/reason pairs from the policy's own vocabulary. */
export function reviewGateStatusForReason(reason: unknown): ReviewGateDecision['status'] | undefined {
  if (typeof reason !== 'string') return undefined;
  for (const [reasons, status] of [
    [REVIEW_GATE_PENDING_REASONS, 'pending'],
    [REVIEW_GATE_TIMEOUT_REASONS, 'timed_out'],
    [REVIEW_GATE_CANCELLATION_REASONS, 'cancelled'],
    [REVIEW_GATE_FAILURE_REASONS, 'failure'],
    [REVIEW_GATE_AUTOMATIC_SUCCESS_REASONS, 'success'],
    [REVIEW_GATE_ACCEPTED_RISK_REASONS, 'success'],
  ] as const) {
    if ((reasons as readonly string[]).includes(reason)) return status;
  }
  return undefined;
}

/**
 * REL-1113: the durable `review_runs.error_text` a terminal gate decision records. The ONE
 * definition of that convention: the gate repository writes it and the authoritative
 * infrastructure re-attempt reads it, so a wording change is a compile-time contract, not a
 * silently disabled retry.
 */
export function reviewGateErrorText(reason: Exclude<ReviewGateDecision, { status: 'success' }>['reason']): string {
  return `review gate: ${reason}`;
}

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
    || [evidence.p0Count, evidence.p1Count, evidence.p2Count, evidence.expectedLanes, evidence.completedLanes]
      .some((count) => !Number.isSafeInteger(count) || count < 0)
    || [evidence.coverageComplete, evidence.quorumSatisfied, evidence.infrastructureFailure]
      .some((value) => typeof value !== 'boolean')) return invalid;
  if (evidence.infrastructureFailure) return { status: 'failure', eligible: false, reason: 'infrastructure-failure' };
  if (!evidence.coverageComplete || !evidence.quorumSatisfied) {
    return { status: 'failure', eligible: false, reason: 'incomplete-review' };
  }
  if (evidence.reviewDecision !== undefined) {
    const evaluated = evaluateReviewDecisionV2(evidence.reviewDecision);
    if (!evaluated.valid) return invalid;
    const decision = evaluated.decision;
    // The decision is service-derived, tied to this exact policy, and mirrored by the established
    // evidence columns. A stale or internally inconsistent receipt cannot select new semantics.
    if (decision.policyDigest !== candidate.policyDigest
      || decision.coverageComplete !== evidence.coverageComplete
      || decision.quorumSatisfied !== evidence.quorumSatisfied
      || decision.infrastructureFailure !== evidence.infrastructureFailure
      || decision.expectedLanes !== evidence.expectedLanes
      || decision.completedLanes !== evidence.completedLanes
      || decision.counts.p0Count !== evidence.p0Count
      || decision.counts.p1Count !== evidence.p1Count
      || evidence.p2Count !== 0) return invalid;
    const expectedVerdict = decision.classification === 'SHIP' ? 'SHIP'
      : decision.classification === 'FIX_FIRST'
        ? (decision.counts.p0Count > 0 ? 'BLOCK' : 'FIX_FIRST')
        : 'BLOCK';
    if (evidence.verdict !== expectedVerdict) return invalid;
    if (decision.reason === 'incomplete-review') {
      return { status: 'failure', eligible: false, reason: 'incomplete-review' };
    }
    if (decision.reason === 'clean-review') {
      return { status: 'success', eligible: true, reason: 'clean-review' };
    }
    const acceptedAt = acceptance ? timestamp(acceptance.appliedAt) : null;
    if (evidence.verdict === 'FIX_FIRST' && decision.counts.p0Count === 0 && decision.counts.p1Count > 0
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
  if (evidence.exemption) {
    // A provider-failed or findings-bearing review cannot be recast as exempt.
    if (!['recap-only', 'no-reviewable-content'].includes(evidence.exemption.kind)
      || !/^[a-f0-9]{64}$/u.test(evidence.exemption.auditDigest)
      || evidence.verdict !== 'SHIP' || evidence.p0Count !== 0 || evidence.p1Count !== 0 || evidence.p2Count !== 0
      || evidence.expectedLanes !== 0 || evidence.completedLanes !== 0) return invalid;
    return { status: 'success', eligible: true, reason: 'central-exemption' };
  }
  if (evidence.expectedLanes === 0 || evidence.completedLanes !== evidence.expectedLanes) {
    return { status: 'failure', eligible: false, reason: 'incomplete-review' };
  }
  // ADR 0002: a required P2 blocks exactly like a P0/P1.
  if (evidence.verdict === 'SHIP' && evidence.p0Count === 0 && evidence.p1Count === 0 && evidence.p2Count === 0) {
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
