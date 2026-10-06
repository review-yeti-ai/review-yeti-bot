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
  /**
   * Delta scope (`REVIEW_YETI_INCREMENTAL_DELTA`): touched files the previous review covered in full
   * and left with no open finding. Lanes see only the change since the previous head (`patch`);
   * every other file in the list stays whole. Absent when the sub-flag is off.
   */
  deltaFiles?: IncrementalDeltaFile[];
  /** Open prior findings on whole-reviewed files, the `prior:` items of the re-review ledger. */
  openFindings?: IncrementalOpenFinding[];
  /** Consecutive incremental reviews this one extends (0 for the first after a full review). */
  chainDepth?: number;
  /** Task count of the previous review's plan: a delta re-review never plans more tasks than that. */
  previousTaskCount?: number;
}

/** One delta-scoped file: the previous-head...head patch for a file the previous review covered whole. */
export interface IncrementalDeltaFile {
  path: string;
  /** GitHub compare patch between the previous reviewed head and this head; hunks are closed and validated. */
  patch: string;
  /** Hunks in `patch`; each is a `delta:<path>#<index>` ledger item. */
  hunks: number;
}

/** An open prior finding, identified by its fingerprint-independent stable ledger id. */
export interface IncrementalOpenFinding {
  id: string;
  path: string;
  line?: number;
  severity: string;
  title: string;
}

/**
 * The per-task outcome ledger of a delta re-review (ADR 0770): one explicit outcome for every open
 * prior finding and every delta hunk, grouped under the tasks the single plan turn produced.
 */
export interface IncrementalLedgerDisclosure {
  /** Upper bound on tasks this re-review could plan, and the number it did plan. */
  maxTasks: number;
  plannedTasks: number;
  tasks: Array<{
    taskId: string;
    dimension: string;
    entries: Array<{ item: string; outcome: string; note: string }>;
  }>;
  /** Tasks that carried items but ended without a recorded ledger (blocked, failed or resumed). */
  unrecordedTaskIds: string[];
  /** Items whose path no task covered; routed to the first task. */
  fallbackRoutedItems: string[];
  /** Total items, for the count shown beside the outcome totals. */
  itemCount: number;
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
  /** Delta-scoped paths: lanes saw only the change since the previous head. */
  deltaPaths?: string[];
  /** Total hunks across `deltaPaths`. */
  deltaHunkCount?: number;
  /** Chain depth of this review (see `IncrementalReviewScope.chainDepth`). */
  chainDepth?: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}
