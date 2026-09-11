import { sha256 } from '../review/reviewCore';
import {
  normalizeReviewCiBinding,
  reviewCiCoordinatesSchema,
  reviewCiExecutionSchema,
  reviewCiIdentityDigest,
  reviewCiTerminalReceiptSchema,
  type StoredReviewCiRequest,
} from '../review/reviewCi';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

/** Every review persistence surface must serialize a repository PR on this
 * exact key. Keep construction centralized so related tables cannot drift. */
export function reviewDispatchPrLockKey(repositoryId: number, prNumber: number): string {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error('Invalid review dispatch PR lock identity');
  }
  return `review-dispatch:${repositoryId}:${prNumber}`;
}

/** Canonical parser for rows read from review_ci_requests. Both the request
 * coordinator and check publisher enforce the same durable identity rules. */
export function storedReviewCiRequestFromRow(row: any): StoredReviewCiRequest {
  const review = reviewCiCoordinatesSchema.parse(row.review);
  const binding = row.binding === null ? null : normalizeReviewCiBinding(row.binding);
  const result: StoredReviewCiRequest = {
    requestId: row.request_id, review, expectedAppId: Number(row.expected_app_id), state: row.state,
    binding, identityDigest: row.identity_digest, workflowEpoch: Number(row.workflow_epoch),
    execution: row.execution === null ? null : reviewCiExecutionSchema.parse(row.execution),
    terminalReceipt: row.terminal_receipt === null ? null : reviewCiTerminalReceiptSchema.parse(row.terminal_receipt),
  };
  if (typeof result.requestId !== 'string' || !UUID.test(result.requestId)
    || !Number.isSafeInteger(result.expectedAppId) || result.expectedAppId <= 0
    || row.attempt_id !== review.attemptId || Number(row.repository_id) !== review.repositoryId
    || Number(row.pr_number) !== review.prNumber
    || (binding && result.identityDigest !== reviewCiIdentityDigest({ ...result, binding }))
    || (result.terminalReceipt && row.terminal_digest !== sha256(result.terminalReceipt))) {
    throw new Error('Invalid stored Review CI identity');
  }
  return result;
}
