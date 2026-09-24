/**
 * Value types for map-reduce review of huge diffs (REL-1083), shared by the
 * worker, both review engines and `PanelResult`. They live in this neutral
 * module, like `reviewBudget`, so the panel's result contract does not compile
 * against the chunking logic in `../review/mapReduceReview`.
 */
import type { BudgetDepth } from './reviewBudget';

/** Worker input for `REVIEW_YETI_MAP_REDUCE`. Absent or `enabled: false` reviews every lane in one call, as today. */
export interface MapReduceInput {
  enabled: boolean;
  /** Chunk calls in flight at once across the whole panel run. Defaults to `DEFAULT_MAP_REDUCE_CONCURRENCY` (3). */
  concurrency?: number;
  /**
   * Epoch ms by which the panel should be done so the worker can still publish
   * before its Job is killed. Derived from the review's terminal deadline when
   * the operator forwards it. Absent means only the panel's own deadline applies.
   */
  deadlineAtMs?: number;
}

/** One file (or one hunk range of a split file) as a chunk received it. */
export interface MapReduceChunkFile {
  path: string;
  depth: BudgetDepth;
  /** Set when the file's hunks were split across chunks; the part number, 1-based. */
  part?: number;
  parts?: number;
}

export interface MapReduceChunkDisclosure {
  /** 1-based. */
  index: number;
  /** Directories the chunk covers, for the summary. */
  label: string;
  files: MapReduceChunkFile[];
  packedChars: number;
  /**
   * Set when this chunk holds the files of several planned chunks because
   * the lane had more chunks than the cap or than the worker deadline allows.
   * It is packed like a W5 budget lane: files that do not fit are summarized
   * or listed, never removed.
   */
  collapsed?: { reason: 'max-chunks' | 'deadline'; plannedChunks: number };
  /** Set when even the collapsed chunk could not list every file: it was sent today's content. */
  fallback?: boolean;
}

export type MapReduceReduceStatus =
  | 'completed'
  | 'single-chunk'
  | 'skipped-deadline'
  | 'failed';

export interface MapReduceLaneDisclosure {
  laneId: string;
  plannedChunks: number;
  chunks: MapReduceChunkDisclosure[];
  findings: {
    /** Findings the chunk calls returned. */
    fromChunks: number;
    /** Exact duplicates (same path, line and title) merged in code. */
    exactDuplicates: number;
    /** Duplicates the reduce pass merged (same path, nearby line), after validation. */
    reduceMerged: number;
    /** Cross-chunk findings the reduce pass added, anchored to a provided changed line. */
    crossChunk: number;
    /** Reduce-pass suggestions rejected by validation (unknown id, different path, unanchored). */
    rejected: number;
    /** Findings dropped to stay within the per-lane findings limit, lowest severity first. */
    capped: number;
  };
  reduce: { status: MapReduceReduceStatus; reason?: string };
}

export interface MapReduceDisclosure {
  flag: 'REVIEW_YETI_MAP_REDUCE';
  concurrency: number;
  budgetChars: number;
  lanes: MapReduceLaneDisclosure[];
  /**
   * Contexts the flag was on for and that exceeded one budget, but that this
   * engine does not chunk (the composed engine plans one context). They keep
   * today's content, or the W5 budget when that flag is on.
   */
  notApplied?: Array<{ laneId: string; reason: 'composed-engine'; files: number; chars: number }>;
}
