import type { PendingCancellation, ReviewDispatchRepository } from '../persistence/reviewDispatchRepository';

/**
 * REL-1073 follow-up: the claimed-run supersede race.
 *
 * Admission (a newer head, or a closed pull request) can cancel a run while a
 * dispatcher holds its claim. The run has no projection name yet, so the cancel
 * query marks the cancellation propagated on the spot -- there is nothing to
 * patch. The dispatcher then creates the PRReviewJob anyway, markProjected finds
 * the row terminal and reports lease-lost, and the job runs uncancelled: the
 * sweep only looks at rows whose cancellation is still pending.
 *
 * After ensure() succeeded and markProjected lost, the dispatcher re-reads the
 * row. If a cancel retired it, the projection it just created is recorded and
 * the cancellation reopened, then patched through the same read-back verified
 * path the sweep uses. If that patch does not land, the reopened row is the
 * sweep's to retry, so the job cannot be orphaned by a transient failure here.
 */
export type OrphanedCancellationOutcome =
  /** The PRReviewJob was patched cancelled and the read-back confirmed it. */
  | 'propagated'
  /** Reopened; the patch did not land yet, the cancellation sweep will retry. */
  | 'pending-sweep'
  /** The re-read itself failed; nothing was recorded. */
  | 'unrecorded';

export interface OrphanedProjectionCancellationInput {
  repository: Pick<ReviewDispatchRepository, 'reopenOrphanedProjectionCancellation'>;
  /** The engine's verified cancellation path (patch, read back, mark propagated). */
  cancel(event: PendingCancellation): Promise<boolean>;
  runId: string;
  claimAttempt: number;
  projectionName: string;
  now: number;
}

/**
 * Returns undefined when the lost lease was not a cancellation (another
 * dispatcher's claim, an expired lease or deadline): nothing to cancel then.
 */
export async function recoverOrphanedProjectionCancellation(
  input: OrphanedProjectionCancellationInput,
): Promise<OrphanedCancellationOutcome | undefined> {
  let reopened: PendingCancellation | null;
  try {
    reopened = await input.repository.reopenOrphanedProjectionCancellation(
      input.runId,
      input.claimAttempt,
      input.projectionName,
      input.now,
    );
  } catch {
    return 'unrecorded';
  }
  if (!reopened) return undefined;
  const landed = await input.cancel(reopened).catch(() => false);
  return landed ? 'propagated' : 'pending-sweep';
}
