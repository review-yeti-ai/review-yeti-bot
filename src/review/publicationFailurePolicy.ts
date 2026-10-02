import {
  formatIncompleteInfrastructureTitle,
  INCOMPLETE_INFRASTRUCTURE_TITLE_PREFIX,
  renderIncompleteInfrastructureTitle,
  type IncompleteLaneDescription,
} from './laneInfrastructure';

// REL-1113: the lane-infrastructure decision, its classes/reason, the provider-status extractor and
// the INCOMPLETE title renderer are owned by `./laneInfrastructure` (plain CommonJS), so the
// publishing worker, the trusted completion service and the GitHub Action pipeline all evaluate the
// same code. This module keeps its public names by re-exporting them.
export {
  INCOMPLETE_INFRASTRUCTURE_REASON,
  INFRASTRUCTURE_LANE_FAILURE_CLASSES,
  isInfrastructureIncompleteResult,
  laneProviderStatus,
  renderIncompleteInfrastructureTitle,
} from './laneInfrastructure';
export type { IncompleteLaneDescription, InfrastructureIncompleteResultShape } from './laneInfrastructure';

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
 * automatic recoverable-panel retry available." The dispatcher's re-queue
 * gate calls this to decide eligibility. Worker-facing reporting uses
 * `recoverablePanelRetryReportingStatus` and does not treat eligibility as a
 * scheduling receipt (REL-620).
 */
export function isRecoverablePanelRetryEligible(executionAttempt: number): boolean {
  // Execution attempts are 1-based: the first worker execution reports
  // attempt 1. Zero or a negative value is not a real attempt and must never
  // be re-queued as `retryAfterExecutionAttempt: 0`.
  return Number.isSafeInteger(executionAttempt) && executionAttempt >= 1 && executionAttempt <= RECOVERABLE_PANEL_AUTO_RETRY_CAP;
}

export type RecoverablePanelRetryReportingStatus = 'not_confirmed' | 'cap_exhausted' | 'unknown';

/**
 * Reporting-only state for the worker. Eligibility is not a dispatch receipt:
 * the completion API acknowledges delivery before the service independently
 * validates and admits any replacement attempt.
 */
export function recoverablePanelRetryReportingStatus(executionAttempt: number): RecoverablePanelRetryReportingStatus {
  if (isRecoverablePanelRetryEligible(executionAttempt)) return 'not_confirmed';
  if (Number.isSafeInteger(executionAttempt) && executionAttempt === RECOVERABLE_PANEL_AUTO_RETRY_CAP + 1) return 'cap_exhausted';
  return 'unknown';
}

/** Worker-facing title: never turn retry eligibility or a delivery ACK into a scheduled-next-attempt claim. */
export function renderRecoverablePanelRetryTitle(
  lanes: readonly IncompleteLaneDescription[],
  executionAttempt: number,
): string {
  const sharedTitle = renderIncompleteInfrastructureTitle(lanes);
  const detail = sharedTitle.startsWith(INCOMPLETE_INFRASTRUCTURE_TITLE_PREFIX)
    ? sharedTitle.slice(INCOMPLETE_INFRASTRUCTURE_TITLE_PREFIX.length, sharedTitle.lastIndexOf(')'))
    : 'lane failed';
  const status = recoverablePanelRetryReportingStatus(executionAttempt);
  const statusText = status === 'not_confirmed'
    ? 'automatic retry NOT CONFIRMED'
    : status === 'cap_exhausted'
      ? 'automatic retry cap EXHAUSTED'
      : 'automatic retry status UNKNOWN';
  return formatIncompleteInfrastructureTitle(`${statusText}; ${detail}`);
}

/** Worker-facing summary, distinct from the compatibility renderer that accepts an actual schedule. */
export function renderRecoverablePanelRetrySummary(
  headSha: string,
  lanes: readonly IncompleteLaneDescription[],
  executionAttempt: number,
): string {
  const rows = lanes.map((lane) => `- \`${lane.id}\`: ${lane.failureClass}${lane.providerStatus !== undefined ? ` (provider HTTP ${lane.providerStatus})` : ''}`);
  const status = recoverablePanelRetryReportingStatus(executionAttempt);
  const retryStatus = status === 'not_confirmed'
    ? `Automatic retry is NOT CONFIRMED for execution attempt ${executionAttempt}. The completion API acknowledgement confirms delivery only; it does not confirm a retry was admitted or scheduled. No next attempt or supersession is promised.`
    : status === 'cap_exhausted'
      ? `Automatic retry is NOT CONFIRMED: the cap of ${RECOVERABLE_PANEL_AUTO_RETRY_CAP} additional attempts was exhausted at execution attempt ${executionAttempt}. No further automatic retry is available; re-run after the gateway recovers.`
      : `Automatic retry is NOT CONFIRMED for execution attempt ${executionAttempt}; this value proves neither retry eligibility nor cap exhaustion. No next attempt or supersession is promised.`;
  return [
    '### Review Yeti: INCOMPLETE — infrastructure',
    `This is **not a review verdict** for \`${headSha}\`. ${lanes.length === 1 ? 'A reviewer lane' : 'Reviewer lanes'} could not reach the model, so the panel did not complete; no lane reported a finding.`,
    '**Lanes that did not complete:**',
    ...rows,
    retryStatus,
  ].join('\n');
}

/**
 * Delay, in milliseconds, before a re-queued recoverable-panel attempt
 * becomes claimable. A transient provider blip (rate limit, momentary
 * timeout) gets a short window to clear instead of an instant re-hit of the
 * same failing dependency.
 */
export const RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS = 30_000;

/** REL-1113: delay before an automatic infrastructure re-attempt becomes
 * claimable. Grows per attempt so a gateway still recovering gets more room:
 * 30s after attempt 1, 60s after attempt 2, capped at five minutes. */
export function infrastructureRetryDelayMs(executionAttempt: number): number {
  const attempt = Number.isSafeInteger(executionAttempt) && executionAttempt >= 1 ? executionAttempt : 1;
  return Math.min(300_000, RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS * 2 ** (attempt - 1));
}

/** REL-1113: the check-summary block naming every lane that did not complete and why. */
export function renderIncompleteInfrastructureSummary(
  headSha: string,
  lanes: readonly IncompleteLaneDescription[],
  retry: { nextAttempt: number; maxAttempts: number } | undefined,
  executionAttempt: number,
): string {
  const rows = lanes.map((lane) => `- \`${lane.id}\`: ${lane.failureClass}${lane.providerStatus !== undefined ? ` (provider HTTP ${lane.providerStatus})` : ''}`);
  return [
    '### Review Yeti: INCOMPLETE — infrastructure',
    `This is **not a review verdict** for \`${headSha}\`. ${lanes.length === 1 ? 'A reviewer lane' : 'Reviewer lanes'} could not reach the model, so the panel did not complete; no lane reported a finding.`,
    '**Lanes that did not complete:**',
    ...rows,
    retry
      ? `Execution attempt ${executionAttempt} failed on infrastructure. A fresh attempt (${retry.nextAttempt} of ${retry.maxAttempts}) is scheduled automatically; this check is superseded by it.`
      : `Execution attempt ${executionAttempt} was the last automatic attempt (${executionAttempt} of ${RECOVERABLE_PANEL_AUTO_RETRY_CAP + 1}). Re-run the review once the gateway is healthy; do not merge on this result.`,
  ].join('\n');
}
