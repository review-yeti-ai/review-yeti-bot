import { writeFileSync } from 'node:fs';
import { logger } from '../utils/logger';
import { type ReviewSupersededError, workerSupersededTerminationMessage } from '../review/reviewSupersession';

/** Kubernetes' default container terminationMessagePath. */
export const DEFAULT_TERMINATION_MESSAGE_PATH = '/dev/termination-log';

/**
 * REL-1057: a superseded publishing worker ends successfully (exit 0) and says
 * why in its termination message, which the operator copies into
 * `status.workerTermination.message` and maps to a Cancelled/Superseded phase.
 * Exiting non-zero would make the PRReviewJob Failed and hand the old head to
 * the fail-closed publication reaper, which is the noise this removes.
 *
 * Writing the message is best effort: without it the operator records
 * Succeeded, which is still not a failure.
 */
export function recordSupersededWorkerExit(
  error: ReviewSupersededError,
  env: NodeJS.ProcessEnv = process.env,
  write: (path: string, data: string) => void = (path, data) => writeFileSync(path, data, 'utf8'),
): void {
  logger.info('Review run superseded by a newer pull request head; ending without a failure', {
    stage: error.stage,
    reviewedHeadSha: error.reviewedHeadSha,
    ...(error.currentHeadSha ? { currentHeadSha: error.currentHeadSha } : {}),
  });
  const path = String(env.REVIEW_WORKER_TERMINATION_MESSAGE_PATH || '').trim() || DEFAULT_TERMINATION_MESSAGE_PATH;
  try {
    write(path, workerSupersededTerminationMessage(error));
  } catch (writeError) {
    logger.warn('Could not record the superseded worker termination message', {
      reason: writeError instanceof Error ? writeError.message.slice(0, 200) : 'unknown',
    });
  }
}
