import { createGitDiffSource, isGitDiffFallbackEnabled, type GitDiffSource } from './gitDiffSource';
import type { SameHeadReviewSourceOptions } from './qualificationReader';

/**
 * REL-1080 wiring for the git-derived large-diff source. Both sides use the one
 * `createGitDiffSource` implementation and the one acceptance rule
 * (`verifyGitDerivedDiff`); only their resource budgets differ.
 *
 * On by default (it only runs where GitHub already refused to render the diff),
 * with `REVIEW_YETI_GIT_DIFF_FALLBACK=off` as the kill switch for both sides.
 */

/** Worker pod: unbounded /tmp emptyDir, a long panel budget. */
export const WORKER_GIT_DIFF_TIMEOUT_MS = 180_000;
export const WORKER_GIT_DIFF_MAX_SCRATCH_BYTES = 1024 * 1024 * 1024;
/**
 * Trusted completion side: runs inside the dispatcher's 20-second completion
 * deadline, and its /tmp is a 32Mi emptyDir that evicts the pod when exceeded.
 * The watchdog polls every 100 ms, so 16 MiB leaves room for one poll interval
 * of transfer before the limit.
 */
export const TRUSTED_GIT_DIFF_TIMEOUT_MS = 10_000;
export const TRUSTED_GIT_DIFF_MAX_SCRATCH_BYTES = 16 * 1024 * 1024;

type Log = (message: string, fields: Record<string, unknown>) => void;

export function workerLargeDiffSourceOptions(env: Record<string, string | undefined>, log?: Log,
  gitDiffSource?: GitDiffSource): SameHeadReviewSourceOptions {
  if (!isGitDiffFallbackEnabled(env)) return {};
  return {
    gitDiffSource: gitDiffSource ?? createGitDiffSource({
      timeoutMs: WORKER_GIT_DIFF_TIMEOUT_MS, maxScratchBytes: WORKER_GIT_DIFF_MAX_SCRATCH_BYTES,
    }),
    onLargeDiffSource: (outcome) => log?.('GitHub could not render this diff; large-diff source selected', {
      source: outcome.source, ...(outcome.reason ? { gitDiffFailure: outcome.reason } : {}),
      ...(outcome.files !== undefined ? { files: outcome.files } : {}),
    }),
  };
}

/** Undefined (compare-only, the pre-REL-1080 behaviour) when disabled or the API base is unusable. */
export function trustedGitDiffSource(env: Record<string, string | undefined>, apiBaseUrl: string | undefined): GitDiffSource | undefined {
  if (!isGitDiffFallbackEnabled(env)) return undefined;
  try {
    return createGitDiffSource({
      apiBaseUrl: apiBaseUrl || undefined,
      timeoutMs: TRUSTED_GIT_DIFF_TIMEOUT_MS, maxScratchBytes: TRUSTED_GIT_DIFF_MAX_SCRATCH_BYTES,
    });
  } catch {
    return undefined;
  }
}
