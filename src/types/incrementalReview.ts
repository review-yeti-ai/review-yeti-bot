/**
 * Value types for incremental re-review on synchronize (REL-1084), shared by the
 * worker, both review engines, `PanelResult` and the trusted completion side.
 * They live in this neutral module, like `diffShrink`, so the panel's result
 * contract does not compile against the worker planning logic in
 * `../review/incrementalReview`.
 */

/** The exact prior review a carry-forward rests on. */
export interface IncrementalPriorIdentity {
  runId: string;
  executionAttempt: number;
  headSha: string;
  baseSha: string;
  /** Content digest of the stored completion record the service verifies. */
  completionDigest: string;
}

/**
 * The worker's incremental decision, handed to the engines. The engines apply it
 * strictly AFTER the shared applicability decision and replace only patch text,
 * so the lanes stay exactly those the trusted completion side derives.
 */
export interface IncrementalReviewScope {
  previous: IncrementalPriorIdentity;
  /** Changed paths unchanged since the previous reviewed head; content is not sent. */
  carriedForwardPaths: string[];
  /** Unchanged paths re-reviewed in full because a prior finding on them is still open. */
  openFindingPaths: string[];
}

/** What an engine actually carried forward, published in the check summary. */
export interface IncrementalReviewDisclosure {
  previous: IncrementalPriorIdentity;
  /** Paths whose content was replaced by a carry-forward note. */
  carriedForwardPaths: string[];
  /** Unchanged paths re-reviewed in full because of an open finding. */
  reReviewedOpenFindingPaths: string[];
  /** Paths sent in full. */
  reviewedPaths: string[];
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}
