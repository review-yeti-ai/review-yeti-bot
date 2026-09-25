/**
 * REL-1122: a coverage-contract failure closes the Review Yeti Gate at once.
 *
 * When the shared applicability decision (`resolveReviewApplicability`) finds a
 * changed file that no enabled lane covers, the worker fails closed before any
 * LLM call and reports a terminal ERROR completion. The trusted completion
 * context runs the SAME decision on the service's own exact-head diff and
 * reaches the same answer, `coverage-no-persona`. Before this module that
 * answer was thrown out of the completion transaction and returned as HTTP 422,
 * so the very body reporting the failure was refused: nothing was recorded and
 * the Gate stayed pending until the 30-minute deadline reaper marked it
 * `timed_out` (14 of 14 no-persona failures on 2026-09-24/25).
 *
 * The service now records the failure itself. The decision is taken from the
 * service's own derivation, never from anything the worker sent: whatever the
 * worker claims, a head whose changed files no lane covers is not reviewed.
 *
 * Semantics, consistent with REL-1113:
 * - The Gate concludes `failure` with the existing reason `incomplete-review`
 *   (no new durable reason, so the V1 event-snapshot vocabulary is unchanged).
 * - It is NOT `infrastructure-failure`: re-running cannot change a
 *   deterministic coverage gap, so REL-1113's automatic re-attempt, which only
 *   fires on that reason, never re-admits it.
 * - It is never an approval and never a findings verdict.
 */
import type { ReviewGateDecision } from './reviewGatePolicy';
import {
  TrustedCompletionResolutionError,
  type TrustedCompletionResolutionReason,
} from './workerCompletionPersistenceError';

/**
 * The durable diagnostics reason for a no-persona coverage gap. The worker
 * tags its terminal ERROR completion with it (`personaCoverageError`) and the
 * service records it from its own derivation, so both sides name one class.
 */
export const PERSONA_COVERAGE_FAILURE_REASON = 'coverage_no_persona';

/** Finite detail recorded alongside the decision, safe to log and to publish. */
export const coverageContractGateDetails = ['coverage-no-persona'] as const;
export type CoverageContractGateDetail = typeof coverageContractGateDetails[number];

/**
 * Only the classes that are a verdict ON the head's coverage. Every other
 * deterministic class (bounds, identity/policy mismatch, patch-less file) keeps
 * the REL-1056 422 contract rejection unchanged.
 */
const terminalCoverageReasons: ReadonlySet<TrustedCompletionResolutionReason> = new Set(['coverage-no-persona']);

export type CoverageContractGateDecision =
  Extract<ReviewGateDecision, { status: 'failure' }> & { detail: CoverageContractGateDetail };

/**
 * The terminal Gate decision for a trusted-completion failure that is a
 * coverage-contract verdict on the current head, or undefined when the failure
 * must keep its existing handling (transient 503 or contract 422).
 *
 * The trusted context throws `coverage-no-persona` only after it re-read the
 * current candidate (open, same head, same base, same policy digest) and the
 * exact-head diff, so the decision is about the head this gate attempt covers.
 */
export function coverageContractGateDecision(error: unknown): CoverageContractGateDecision | undefined {
  if (!(error instanceof TrustedCompletionResolutionError)) return undefined;
  if (!terminalCoverageReasons.has(error.reason)) return undefined;
  return { status: 'failure', eligible: false, reason: 'incomplete-review', detail: 'coverage-no-persona' };
}

/** Read a recorded decision's detail back, accepting only the finite set. */
export function coverageContractGateDetailOf(decision: unknown): CoverageContractGateDetail | undefined {
  const detail = decision && typeof decision === 'object' ? (decision as { detail?: unknown }).detail : undefined;
  return (coverageContractGateDetails as readonly unknown[]).includes(detail)
    ? detail as CoverageContractGateDetail : undefined;
}

/**
 * The published Gate title and summary. Deliberately outside REL-1113's
 * `Review Yeti: INCOMPLETE — infrastructure (` family, so the exact-head
 * re-run affordance is not offered for a condition a re-run cannot fix.
 */
export function coverageContractGateMetadata(detail: CoverageContractGateDetail): { title: string; summary: string } {
  switch (detail) {
    case 'coverage-no-persona':
      return {
        title: 'Review Yeti Gate: INCOMPLETE — coverage (no review lane covers a changed file)',
        summary: 'Review Yeti Gate failed: no enabled review lane covers at least one changed file in this head, '
          + 'so the head was not reviewed. This is an incomplete review, not a findings verdict and not an '
          + 'infrastructure failure; re-running will not change it. Extend a lane\'s paths to cover the file, '
          + 'or have a human review the change.',
      };
  }
}
