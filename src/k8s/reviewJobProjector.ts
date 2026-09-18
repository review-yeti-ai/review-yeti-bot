import type { PRReviewJobProjection } from './reviewJobProjection';

export interface ReviewJobProjector {
  /** Ensure is idempotent for metadata.name and must reject a conflicting existing resource. */
  ensure(projection: PRReviewJobProjection): Promise<void>;
  /** Patch cancellation into an existing PRReviewJob CR using Kubernetes merge-patch. */
  patchCancellation(name: string, namespace: string, cancelReason?: string): Promise<void>;
}
