/**
 * REL-1057: a review run whose admitted head is no longer the pull request head
 * has been superseded by a newer push. That is a terminal outcome, not a worker
 * failure: the newer head gets its own admitted run and its own review.
 *
 * Where the worker learns it:
 * - `pre_review`: the qualification read found a different head before any
 *   persona ran (the push landed between receivedAt and worker start).
 * - `during_review`: the service's run-status poller reported the run is no
 *   longer current while the panel was running.
 * - `completion`: the legacy completion callback answered HTTP 409 and a fresh
 *   GitHub read shows the head has moved.
 *
 * This is the worker-side mirror of the trusted completion path's
 * `cancellation()` (`authoritativeCompletionContext.ts`), which already turns a
 * moved head into a cancelled gate decision instead of a failure.
 */
export type ReviewSupersessionStage = 'pre_review' | 'during_review' | 'completion';

export class ReviewSupersededError extends Error {
  constructor(
    readonly stage: ReviewSupersessionStage,
    readonly reviewedHeadSha: string,
    readonly currentHeadSha?: string,
  ) {
    super(`Review run superseded at ${stage}: pull request head ${reviewedHeadSha.slice(0, 12)} `
      + `is no longer current${currentHeadSha ? ` (now ${currentHeadSha.slice(0, 12)})` : ''}`);
    this.name = 'ReviewSupersededError';
  }
}

export function isReviewSuperseded(error: unknown): error is ReviewSupersededError {
  return error instanceof ReviewSupersededError;
}

/**
 * First token of the worker's termination message when it ends superseded. The
 * operator reads it from `status.workerTermination.message` on a successful
 * (exit 0) worker and records a Cancelled phase with reason `Superseded`
 * instead of `Succeeded`. It is only a label: it grants nothing, because a
 * successful worker already publishes nothing through the operator.
 * Keep in sync with `workerSupersededMarker` in the operator.
 */
export const WORKER_SUPERSEDED_TERMINATION_MARKER = 'review-yeti-worker-superseded';

export function workerSupersededTerminationMessage(error: ReviewSupersededError): string {
  return `${WORKER_SUPERSEDED_TERMINATION_MARKER} stage=${error.stage} head=${error.reviewedHeadSha}`
    + `${error.currentHeadSha ? ` current=${error.currentHeadSha}` : ''}\n`;
}
