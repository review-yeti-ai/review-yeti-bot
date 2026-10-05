import { z } from 'zod';

/** Wire identity for the shared worker/Gate eligibility contract. */
export const REVIEW_DECISION_SCHEMA_V2 = 'review-yeti-decision.v2' as const;
/** Policy revision is explicit so legacy receipts keep their original P2 semantics. */
export const REVIEW_SEVERITY_POLICY_V2 = 'review-yeti-severity.v2' as const;

const countsSchema = z.object({
  p0Count: z.number().int().nonnegative().safe(),
  p1Count: z.number().int().nonnegative().safe(),
  p2Count: z.number().int().nonnegative().safe(),
  p3Count: z.number().int().nonnegative().safe(),
  nitCount: z.number().int().nonnegative().safe(),
}).strict();

export const reviewDecisionV2EvidenceSchema = z.object({
  schemaVersion: z.literal(REVIEW_DECISION_SCHEMA_V2),
  policyVersion: z.literal(REVIEW_SEVERITY_POLICY_V2),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  coverageComplete: z.boolean(),
  quorumSatisfied: z.boolean(),
  infrastructureFailure: z.boolean(),
  expectedLanes: z.number().int().nonnegative().safe(),
  completedLanes: z.number().int().nonnegative().safe(),
  counts: countsSchema,
}).strict();

export const reviewDecisionV2Schema = reviewDecisionV2EvidenceSchema.extend({
  classification: z.enum(['SHIP', 'FIX_FIRST', 'INCOMPLETE_REVIEW']),
  blocking: z.boolean(),
  eligible: z.boolean(),
  reason: z.enum(['clean-review', 'blocking-findings', 'incomplete-review']),
  explanation: z.string().min(1).max(500),
}).strict();

export type ReviewDecisionEvidenceV2 = z.infer<typeof reviewDecisionV2EvidenceSchema>;
export type ReviewDecisionV2 = z.infer<typeof reviewDecisionV2Schema>;

export type ReviewDecisionEvaluationV2 =
  | { valid: true; decision: ReviewDecisionV2 }
  | { valid: false; reason: 'invalid-evidence' };

function deriveDecision(evidence: ReviewDecisionEvidenceV2): Omit<ReviewDecisionV2, keyof ReviewDecisionEvidenceV2> {
  const complete = evidence.coverageComplete && evidence.quorumSatisfied && !evidence.infrastructureFailure
    && evidence.expectedLanes > 0 && evidence.completedLanes === evidence.expectedLanes;
  if (!complete) {
    return {
      classification: 'INCOMPLETE_REVIEW', blocking: false, eligible: false,
      reason: 'incomplete-review',
      explanation: 'Review coverage, quorum, lane completion, or infrastructure evidence is incomplete.',
    };
  }
  const blockingCount = evidence.counts.p0Count + evidence.counts.p1Count;
  if (blockingCount > 0) {
    return {
      classification: 'FIX_FIRST', blocking: true, eligible: false,
      reason: 'blocking-findings',
      explanation: `${blockingCount} verified P0/P1 finding(s) block this review.`,
    };
  }
  return {
    classification: 'SHIP', blocking: false, eligible: true,
    reason: 'clean-review',
    explanation: 'Review coverage is complete and no verified P0/P1 findings remain.',
  };
}

/** Build the one current-policy decision receipt from service or worker evidence. */
export function createReviewDecisionV2(input: ReviewDecisionEvidenceV2): ReviewDecisionV2 {
  const evidence = reviewDecisionV2EvidenceSchema.parse(input);
  return { ...evidence, ...deriveDecision(evidence) };
}

/** Recompute every decision field; claimed status text never controls eligibility. */
export function evaluateReviewDecisionV2(input: unknown): ReviewDecisionEvaluationV2 {
  const parsed = reviewDecisionV2Schema.safeParse(input);
  if (!parsed.success) return { valid: false, reason: 'invalid-evidence' };
  const { classification: _classification, blocking: _blocking, eligible: _eligible,
    reason: _reason, explanation: _explanation, ...evidence } = parsed.data;
  const expected = createReviewDecisionV2(evidence);
  const claimed = parsed.data;
  if (claimed.classification !== expected.classification || claimed.blocking !== expected.blocking
    || claimed.eligible !== expected.eligible || claimed.reason !== expected.reason
    || claimed.explanation !== expected.explanation) return { valid: false, reason: 'invalid-evidence' };
  return { valid: true, decision: expected };
}
