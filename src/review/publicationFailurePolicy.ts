export interface IncompletePanelEvidence {
  authoritative: boolean;
  unreadableDiffCount: number;
  mode: string;
  rosterValid: boolean;
  failedLaneCount: number;
  quorumSatisfied: boolean;
  rawFindingCount: number;
  canonicalFindingCount: number;
}

/**
 * Classify execution evidence; never approve code. This never decides a
 * verdict -- it only tells the caller whether the incompleteness is the
 * narrow "optional lane died, nothing else found anything" shape that the
 * bounded automatic retry below (and, before that, the manual exact-head
 * refresh) is allowed to replace with a fresh execution attempt instead of
 * publishing an unrepeatable BLOCK.
 */
export function isRecoverableIncompletePanel(evidence: IncompletePanelEvidence): boolean {
  return evidence.authoritative === false
    && evidence.unreadableDiffCount === 0
    && evidence.mode === 'panel'
    && evidence.rosterValid === true
    && Number.isSafeInteger(evidence.failedLaneCount) && evidence.failedLaneCount > 0
    && evidence.quorumSatisfied === false
    && evidence.rawFindingCount === 0
    && evidence.canonicalFindingCount === 0;
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
 * Delay, in milliseconds, before a re-queued recoverable-panel attempt
 * becomes claimable. A transient provider blip (rate limit, momentary
 * timeout) gets a short window to clear instead of an instant re-hit of the
 * same failing dependency.
 */
export const RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS = 30_000;
