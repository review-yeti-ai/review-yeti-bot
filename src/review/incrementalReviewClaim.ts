/**
 * The carry-forward claim a worker adds to `WorkerReviewResult.v1` when an
 * incremental re-review (REL-1084, `REVIEW_YETI_INCREMENTAL`) replaced the
 * content of unchanged files with a carry-forward note.
 *
 * Kept in its own module, free of other review imports, so the completion
 * schema (`workerReviewCompletion.ts`) can embed it without an import cycle.
 * The field is optional and additive: a worker that never sets it, or a
 * service that predates it, keeps `WorkerReviewCompletion.v1` unchanged.
 *
 * A claim is never evidence on its own. The trusted completion side re-reads
 * the named prior review record, re-runs the shared decision against GitHub,
 * and refuses the completion unless every carried path is one that decision
 * permits (see `verifyIncrementalClaim`).
 */
import { z } from 'zod';
import { MAX_CHANGED_FILES, MAX_PATH_CHARACTERS } from './reviewEvidenceLimits';

export const INCREMENTAL_REVIEW_CLAIM_VERSION = 'IncrementalReview.v1' as const;

export const incrementalReviewClaimSchema = z.object({
  version: z.literal(INCREMENTAL_REVIEW_CLAIM_VERSION),
  previousRunId: z.string().regex(/^run_[a-f0-9]{32}$/u),
  previousExecutionAttempt: z.number().int().positive().safe(),
  previousHeadSha: z.string().regex(/^[a-f0-9]{40}$/u),
  previousBaseSha: z.string().regex(/^[a-f0-9]{40}$/u),
  previousCompletionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  /** Empty only when `deltaPaths` is not (a delta-only incremental review carries no whole file). */
  carriedForwardPaths: z.array(z.string().min(1).max(MAX_PATH_CHARACTERS)).max(MAX_CHANGED_FILES),
  /**
   * Delta scope (ADR 0771): touched files whose lanes saw only the change since `previousHeadSha`.
   * Absent unless the worker ran with `REVIEW_YETI_INCREMENTAL_DELTA`. The trusted side re-derives
   * the permitted set and refuses a path outside it.
   */
  deltaPaths: z.array(z.string().min(1).max(MAX_PATH_CHARACTERS)).min(1).max(MAX_CHANGED_FILES).optional(),
  /** Consecutive incremental reviews this one extends, 1 for the first after a full review. */
  chainDepth: z.number().int().min(1).max(1000).optional(),
}).strict().superRefine((claim, context) => {
  if (new Set(claim.carriedForwardPaths).size !== claim.carriedForwardPaths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['carriedForwardPaths'], message: 'carried-forward paths must be unique' });
  }
  if (claim.deltaPaths) {
    if (new Set(claim.deltaPaths).size !== claim.deltaPaths.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['deltaPaths'], message: 'delta paths must be unique' });
    }
    const carried = new Set(claim.carriedForwardPaths);
    if (claim.deltaPaths.some((path) => carried.has(path))) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['deltaPaths'], message: 'a path cannot be both carried forward and delta-scoped' });
    }
  } else if (claim.carriedForwardPaths.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['carriedForwardPaths'], message: 'a claim must carry forward or delta-scope at least one path' });
  }
});

export type IncrementalReviewClaim = z.infer<typeof incrementalReviewClaimSchema>;
