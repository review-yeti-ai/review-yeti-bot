/**
 * Value types for the per-file verdict cache (REL-1085), shared by the worker,
 * both review engines, `PanelResult` and the trusted completion side. They live
 * in this neutral module, like `incrementalReview`, so the panel's result
 * contract does not compile against the planning logic in
 * `../review/verdictCache`.
 */

/** The exact stored review a cache hit rests on. */
export interface VerdictCacheSourceIdentity {
  runId: string;
  executionAttempt: number;
  headSha: string;
  baseSha: string;
  /** Content digest of the stored completion record the service verifies. */
  completionDigest: string;
}

/** One file's cached lane result: every listed lane reviewed exactly this content and view without a finding. */
export interface VerdictCacheEntry {
  path: string;
  /** Repository-scoped digest of the file's head blob and its exact merge-base patch (GitHub compare). */
  contentKey: string;
  /** Digest of the patch text the lanes received, after diff shrinking. */
  viewDigest: string;
  /** Lanes that reviewed this file, sorted. */
  lanes: string[];
}

/**
 * The worker's cache decision, handed to the engines. The engines apply it
 * strictly AFTER the shared applicability decision (and after shrinking and the
 * incremental scope) and replace only patch text, so the lanes stay exactly
 * those the trusted completion side derives.
 */
export interface VerdictCacheScope {
  /** Null when nothing may be served from cache; the engine still reports what it sent. */
  source: VerdictCacheSourceIdentity | null;
  /** Entries the shared decision permits serving from `source`. */
  permitted: VerdictCacheEntry[];
  /** This run's lane keys (persona, prompt, models, policy, config, engine, view flags). */
  laneKeys: Record<string, string>;
  /** The source record's lane keys. */
  sourceLaneKeys: Record<string, string>;
}

/** What an engine actually did with the cache, published in the check summary. */
export interface VerdictCacheDisclosure {
  source: VerdictCacheSourceIdentity | null;
  /** Files whose content was replaced by a cache note, with the lanes the shared decision routes each to. */
  cached: Array<{ path: string; lanes: string[] }>;
  /** Paths sent in full. */
  reviewedPaths: string[];
  /** Files sent in full whose lane results may seed the cache, with the lanes routed to each. */
  views: Array<{ path: string; viewDigest: string; lanes: string[] }>;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}
