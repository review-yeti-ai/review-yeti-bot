import type { PRReviewJobProjection } from './reviewJobProjection';

/**
 * REL-1073: a 2xx patch is not proof of cancellation. A CRD whose schema lacks
 * spec.cancelRequested prunes the field and still answers 200, so the result
 * carries the stored value for the caller to verify.
 */
export type CancellationPatchResult =
  | { status: 'not-found' }
  | { status: 'patched'; cancelRequested: unknown }
  /** The CRD refused the patch (422) because the stored CR is already cancelled. */
  | { status: 'already-cancelled' };

export interface ReviewJobProjector {
  /** Ensure is idempotent for metadata.name and must reject a conflicting existing resource. */
  ensure(projection: PRReviewJobProjection): Promise<void>;
  /**
   * Patch cancellation into an existing PRReviewJob CR using Kubernetes merge-patch.
   * Reports what the API server stored so callers can verify the flag landed.
   */
  patchCancellation(name: string, namespace: string, cancelReason?: string): Promise<CancellationPatchResult>;
}
