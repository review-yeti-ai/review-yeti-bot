import { formatIncompleteInfrastructureTitle } from './reviewCheckIdentity';

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

/**
 * REL-1113: lane failure classes that describe the path to the model, not an
 * answer from it. A lane that failed with one of these produced no review of
 * the diff; the run is incomplete for an infrastructure reason. `malformed_output`,
 * `budget_exhausted`, `auth`, `contract` and `internal_error` are deliberately
 * excluded: a fresh attempt is not expected to clear them.
 */
export const INFRASTRUCTURE_LANE_FAILURE_CLASSES = ['transport', 'provider_error', 'rate_limit', 'timeout'] as const;

/** REL-1113: the bounded diagnostic reason (and log/metric reason class) for a
 * run that is incomplete because lanes failed on infrastructure. */
export const INCOMPLETE_INFRASTRUCTURE_REASON = 'lane_infrastructure_incomplete';

/** Structural subset of `WorkerReviewResult` the shared decision reads. Kept
 * structural so this pure module imports nothing from the completion boundary. */
export interface InfrastructureIncompleteResultShape {
  personas: ReadonlyArray<{
    decision: string;
    status?: string;
    errorClass?: string;
    findings: readonly unknown[];
    evidenceSource?: string;
  }>;
  coverageComplete: boolean;
  quorumSatisfied: boolean;
  failureDiagnostics?: { reason?: string; recoverableIncompletePanel?: boolean };
}

/**
 * REL-1113: the ONE decision, shared by the publishing worker and the trusted
 * completion service, that an authoritative review result is "incomplete for
 * an infrastructure reason" rather than a review verdict.
 *
 * The worker evaluates it on the exact payload it reports, and chooses its
 * published check from it (INCOMPLETE, never BLOCK); the service evaluates it
 * on the same authenticated payload and re-admits a fresh execution attempt
 * from it. Because both read the same bytes through the same function, the
 * two sides cannot disagree about which runs are retried.
 *
 * True only when ALL of these hold:
 * - the worker explicitly marked the result (`failureDiagnostics.reason` is
 *   `INCOMPLETE_INFRASTRUCTURE_REASON` and `recoverableIncompletePanel`);
 * - coverage was complete (a file no lane could read is deterministic and a
 *   retry reads the same diff) and quorum was NOT satisfied;
 * - no gating lane reported any finding (a finding is evidence about the code:
 *   a findings BLOCK stays a BLOCK and is never re-rolled);
 * - at least one gating lane failed, and every failed gating lane failed with
 *   an infrastructure class.
 * Shadow lanes (`evidenceSource: 'shadow'`) are non-gating and ignored, except
 * that a shadow finding does not make the run retryable either way.
 */
export function isInfrastructureIncompleteResult(result: InfrastructureIncompleteResultShape | null | undefined): boolean {
  if (!result || !Array.isArray(result.personas)) return false;
  const diagnostics = result.failureDiagnostics;
  if (diagnostics?.reason !== INCOMPLETE_INFRASTRUCTURE_REASON || diagnostics.recoverableIncompletePanel !== true) return false;
  if (result.coverageComplete !== true || result.quorumSatisfied !== false) return false;
  const gating = result.personas.filter((persona) => persona.evidenceSource !== 'shadow');
  if (gating.length === 0) return false;
  if (gating.some((persona) => !Array.isArray(persona.findings) || persona.findings.length > 0)) return false;
  const failed = gating.filter((persona) => persona.decision === 'ERROR' || persona.status === 'ERROR');
  if (failed.length === 0) return false;
  return failed.every((persona) => (INFRASTRUCTURE_LANE_FAILURE_CLASSES as readonly string[]).includes(String(persona.errorClass)));
}

/** REL-1113: delay before an automatic infrastructure re-attempt becomes
 * claimable. Grows per attempt so a gateway still recovering gets more room:
 * 30s after attempt 1, 60s after attempt 2, capped at five minutes. */
export function infrastructureRetryDelayMs(executionAttempt: number): number {
  const attempt = Number.isSafeInteger(executionAttempt) && executionAttempt >= 1 ? executionAttempt : 1;
  return Math.min(300_000, RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS * 2 ** (attempt - 1));
}

/** One failed lane as the check summary and title describe it: identity, coded
 * class and, when one was observed, the provider HTTP status. Never free text. */
export interface IncompleteLaneDescription {
  id: string;
  failureClass: string;
  providerStatus?: number;
}

/** REL-1113: extract a provider HTTP status (e.g. the nginx `HTTP 502`) from a
 * lane's free-form error without publishing any of that text. */
export function laneProviderStatus(error: unknown): number | undefined {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const matches = [...message.matchAll(/\bHTTP (\d{3})\b/gu)];
  const last = matches.length > 0 ? Number(matches[matches.length - 1][1]) : Number.NaN;
  return Number.isInteger(last) && last >= 400 && last <= 599 ? last : undefined;
}

function laneReason(lane: IncompleteLaneDescription): string {
  return lane.providerStatus !== undefined ? String(lane.providerStatus) : lane.failureClass;
}

/**
 * REL-1113: the check title for an infrastructure-incomplete run. Always
 * "INCOMPLETE", never a verdict word, e.g.
 * `Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed: 502)`.
 * Bounded to GitHub's 140-character title limit by shortening the lane detail,
 * never the fixed prefix or the retry suffix, so the result always satisfies
 * `isRecoverableFailureTitle` and keeps the exact-head recovery action.
 */
export function renderIncompleteInfrastructureTitle(
  lanes: readonly IncompleteLaneDescription[],
  retry?: { nextAttempt: number; maxAttempts: number },
): string {
  const shown = lanes.slice(0, 3);
  const detail = shown.length === 0
    ? 'lane failed'
    : shown.length === 1
      ? `lane ${shown[0].id} failed: ${laneReason(shown[0])}`
      : `lanes ${shown.map((lane) => `${lane.id} ${laneReason(lane)}`).join(', ')}${lanes.length > shown.length ? ', …' : ''} failed`;
  return formatIncompleteInfrastructureTitle(detail, retry);
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
