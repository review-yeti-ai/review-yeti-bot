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
  carriedForwardPaths: z.array(z.string().min(1).max(MAX_PATH_CHARACTERS)).min(1).max(MAX_CHANGED_FILES),
}).strict().superRefine((claim, context) => {
  if (new Set(claim.carriedForwardPaths).size !== claim.carriedForwardPaths.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['carriedForwardPaths'], message: 'carried-forward paths must be unique' });
  }
});

export type IncrementalReviewClaim = z.infer<typeof incrementalReviewClaimSchema>;
