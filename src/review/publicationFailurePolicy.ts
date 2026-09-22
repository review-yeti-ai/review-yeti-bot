export interface IncompletePanelEvidence {
  authoritative: boolean;
  unreadableDiffCount: number;
  mode: string;
  rosterValid: boolean;
  failedLaneCount: number;
  quorumSatisfied: boolean;
  rawFindingCount: number;
  canonicalFindingCount: number;
  /** Configured roster lanes that returned no result at all (and did not
   * report a failure). Zero when the configured roster itself is invalid,
   * because "which lanes are missing" is then unknowable. */
  missingConfiguredLaneCount: number;
  /** Returned lanes that are not clean members of the configured roster:
   * unknown ids, duplicates, or any returned lane at all when the configured
   * roster is invalid. Any nonzero value means the panel's own output shape
   * is broken, which is never the silently-missing shape below. */
  malformedReturnedLaneCount: number;
}

/**
 * Classify execution evidence; never approve code. This never decides a
 * verdict -- it only tells the caller whether the incompleteness is one of
 * the narrow shapes that the bounded automatic retry below (and, before
 * that, the manual exact-head refresh) is allowed to replace with a fresh
 * execution attempt instead of publishing an unrepeatable BLOCK:
 *
 * 1. "Optional lane died, nothing else found anything" -- a valid roster
 *    with at least one explicitly failed lane.
 * 2. "Silently missing lanes" -- every returned lane is a clean member of
 *    the configured roster, at least one configured lane simply never
 *    returned (no failure was reported for it), and nothing was found. This
 *    is the provider-side silent dropout shape: the panel published a
 *    terminal BLOCK over a review that provably never ran to completion and
 *    that a fresh attempt can plausibly complete. A malformed return (ids
 *    outside the roster, duplicates, or an invalid configured roster) is
 *    deliberately excluded -- that is an engine-contract defect, not a
 *    transient dropout, and it keeps its own failure path.
 */
export function isRecoverableIncompletePanel(evidence: IncompletePanelEvidence): boolean {
  const isSafeCount = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
  const base = evidence.authoritative === false
    && evidence.unreadableDiffCount === 0
    && evidence.mode === 'panel'
    && evidence.quorumSatisfied === false
    && evidence.rawFindingCount === 0
    && evidence.canonicalFindingCount === 0
    && isSafeCount(evidence.missingConfiguredLaneCount)
    && isSafeCount(evidence.malformedReturnedLaneCount);
  const failedLaneShape = evidence.rosterValid === true
    && Number.isSafeInteger(evidence.failedLaneCount) && evidence.failedLaneCount > 0;
  const silentlyMissingLaneShape = evidence.missingConfiguredLaneCount > 0
    && evidence.malformedReturnedLaneCount === 0
    && Number.isSafeInteger(evidence.failedLaneCount) && evidence.failedLaneCount === 0;
  return base && (failedLaneShape || silentlyMissingLaneShape);
}

/**
 * Bounded count of automatic re-dispatches the dispatcher may perform for a
 * single review identity after a recoverable-incomplete-panel terminal
 * failure (REL-620). Attempts 1..CAP may be retried (producing attempts
 * 2..CAP+1); the attempt that fails as CAP+1 is left terminal. Named as a
 * cap on *retries*, not on total attempts, to match the operator-facing
 * "automatic retry cap" language in the published failure summary.
 */
export const RECOVERABLE_PANEL_AUTO_RETRY_CAP = 2;

/**
 * Single source of truth for "does this execution attempt still have an
 * automatic recoverable-panel retry available." Both the dispatcher's
 * re-queue gate (`recoverablePanelRetry.requeueRecoverableIncompletePanelFailure`)
 * and the worker's own "no further automatic retry" exhaustion summary
 * (`publishingReview.ts`) call this instead of inlining the comparison, so
 * the two can never drift on what counts as eligible (REL-620).
 */
export function isRecoverablePanelRetryEligible(executionAttempt: number): boolean {
  // Execution attempts are 1-based: the first worker execution reports
  // attempt 1. Zero or a negative value is not a real attempt and must never
  // be re-queued as `retryAfterExecutionAttempt: 0`.
  return Number.isSafeInteger(executionAttempt) && executionAttempt >= 1 && executionAttempt <= RECOVERABLE_PANEL_AUTO_RETRY_CAP;
}

/**
 * Delay, in milliseconds, before a re-queued recoverable-panel attempt
 * becomes claimable. A transient provider blip (rate limit, momentary
 * timeout) gets a short window to clear instead of an instant re-hit of the
 * same failing dependency.
 */
export const RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS = 30_000;
