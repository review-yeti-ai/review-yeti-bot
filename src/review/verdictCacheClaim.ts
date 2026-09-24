/**
 * The verdict-cache record a worker adds to `WorkerReviewResult.v1`
 * (REL-1085, `REVIEW_YETI_VERDICT_CACHE`).
 *
 * Kept in its own module, free of other review imports, so the completion
 * schema (`workerReviewCompletion.ts`) can embed it without an import cycle.
 * The field is optional and additive: a worker that never sets it, or a service
 * that predates it, keeps `WorkerReviewCompletion.v1` unchanged.
 *
 * It has two parts:
 *
 * - `entries`: files this run's lanes reviewed without any finding, keyed by
 *   content and view. They are stored with the completion, in the existing
 *   `review_worker_completions` row, and are what a later run of the same pull
 *   request may reuse. They are never trusted as written: the service re-derives
 *   every content key from GitHub before a later run may rest on one.
 * - `hits`: files whose content this run did NOT send because a named earlier
 *   record already covered them. A hit is never evidence on its own: the
 *   trusted completion side must verify it (`verifyVerdictCacheClaim`) or
 *   `deriveCanonicalWorkerReviewEvidence` refuses the completion.
 */
import { z } from 'zod';

export const VERDICT_CACHE_CLAIM_VERSION = 'VerdictCache.v1' as const;

/** Compare lists at most 300 files, so no run can hold more cacheable entries. */
export const MAX_VERDICT_CACHE_ENTRIES = 300;
/** Longer paths are never cached, which keeps the record well inside the completion size limit. */
export const MAX_VERDICT_CACHE_PATH_CHARACTERS = 1_024;
const MAX_LANES = 64;

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const laneId = z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/u);
const path = z.string().min(1).max(MAX_VERDICT_CACHE_PATH_CHARACTERS);

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const verdictCacheEntrySchema = z.object({
  path,
  contentKey: digest,
  viewDigest: digest,
  lanes: z.array(laneId).min(1).max(MAX_LANES).refine(unique, 'lanes must be unique'),
}).strict();

export const verdictCacheClaimSchema = z.object({
  version: z.literal(VERDICT_CACHE_CLAIM_VERSION),
  /** Lane keys of this run, by persona id. */
  laneKeys: z.record(laneId, digest).refine((keys) => Object.keys(keys).length <= MAX_LANES, 'too many lane keys'),
  entries: z.array(verdictCacheEntrySchema).max(MAX_VERDICT_CACHE_ENTRIES)
    .refine((entries) => unique(entries.map((entry) => entry.path)), 'entry paths must be unique'),
  hits: z.object({
    runId: z.string().regex(/^run_[a-f0-9]{32}$/u),
    executionAttempt: z.number().int().positive().safe(),
    completionDigest: digest,
    paths: z.array(path).min(1).max(MAX_VERDICT_CACHE_ENTRIES).refine(unique, 'hit paths must be unique'),
  }).strict().optional(),
}).strict();

export type VerdictCacheClaim = z.infer<typeof verdictCacheClaimSchema>;
