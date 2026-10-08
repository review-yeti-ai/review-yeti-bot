/**
 * Value types for deterministic diff shrinking (REL-1079), shared by the
 * worker, both review engines and `PanelResult`. They live in this neutral
 * module, like `workerFailure`, so the panel's result contract does not
 * compile against the worker-input logic in `../review/diffShrink`.
 */

/** `.gitattributes` attributes that exclude a path's content. */
export type LinguistAttribute = 'linguist-generated' | 'linguist-vendored';

/** Why the root `.gitattributes` linguist rules are or are not applied. */
export type LinguistRulesState =
  | { status: 'applied'; content: string }
  | { status: 'none-declared' }
  | { status: 'not-applied'; reason: string };

export interface DiffShrinkInput {
  enabled: boolean;
  linguist?: LinguistRulesState;
}

export type ShrinkRule = 'whitespace' | 'rename' | 'linguist';

export interface DiffShrinkRename {
  from: string;
  to: string;
  /** Percentage from the diff header, or 100 for a content-matched move; null when the header gave none. */
  similarity: number | null;
  kind: 'rename' | 'copy';
  detectedBy: 'diff-header' | 'content-match';
  /** `none` for a pure rename/move, `changed-hunks` when the file also changed. */
  contentSent: 'none' | 'changed-hunks';
}

export interface DiffShrinkDisclosure {
  whitespaceOnlyFiles: string[];
  collapsedWhitespaceHunks: Array<{ path: string; hunks: number }>;
  renames: DiffShrinkRename[];
  linguistExcluded: Array<{ path: string; attribute: LinguistAttribute }>;
  linguistRules: 'applied' | 'none-declared' | 'not-provided' | { notApplied: string };
  /** Security-sensitive files a rule would have shrunk, kept at full depth instead. */
  keptFullDepth: Array<{ path: string; rule: ShrinkRule }>;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  /**
   * REL-1141: changed files the current effective input did NOT receive in full
   * for reasons outside diff shrinking (hidden, summarized, truncated,
   * unavailable, or reduced by the review budget). The applicability snapshot
   * is reconciled against actually executed budget packs; budget
   * signatures/listings remain distinct from oversized-lockfile summaries.
   * Composed-engine PLAN input and original WORK source have separate scopes;
   * WORK completeness is established by TaskSourceDelivery receipts.
   * Absent without a decision.
   */
  notSentInFull?: Array<{ path: string; why: NotSentInFullReason }>;
}

export type NotSentInFullReason = 'filtered' | 'summarized' | 'truncated' | 'unavailable' | 'unreviewable'
  | 'budget-signatures' | 'budget-listed';
