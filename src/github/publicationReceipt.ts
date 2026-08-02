import { canonicalJson, sha256 } from '../review/reviewCore';
import { PublishReviewRequest, PublishResult } from './commentPublisher';

export type PublicationFallbackPath = 'inline' | 'body_only' | 'issue_comment' | 'none';
export type PublicationVerificationStatus = 'verified' | 'unverified' | 'failed';

export interface PublicationReceipt {
  exactHeadSha: string;
  event: PublishReviewRequest['event'];
  idempotencyKey: string;
  requestDigest: string;
  responseIds: number[];
  commentsCreated: number;
  fallbackPath: PublicationFallbackPath;
  verificationStatus: PublicationVerificationStatus;
}

export function publicationRequestDigest(request: Pick<PublishReviewRequest, 'owner' | 'repo' | 'prNumber' | 'commitSha' | 'event' | 'body' | 'inlineComments'>): string {
  return sha256(canonicalJson({
    owner: request.owner,
    repo: request.repo,
    prNumber: request.prNumber,
    commitSha: request.commitSha,
    event: request.event,
    body: request.body,
    inlineComments: request.inlineComments || [],
  }));
}

export function createPublicationReceipt(request: PublishReviewRequest, result: PublishResult, options: {
  responseIds?: number[];
  fallbackPath?: PublicationFallbackPath;
  verificationStatus?: PublicationVerificationStatus;
} = {}): PublicationReceipt {
  const requestDigest = publicationRequestDigest(request);
  return {
    exactHeadSha: request.commitSha,
    event: request.event,
    idempotencyKey: request.idempotencyKey || `${request.owner}/${request.repo}#${request.prNumber}:${request.commitSha}:${requestDigest}`,
    requestDigest,
    responseIds: options.responseIds || (result.reviewId === undefined ? [] : [result.reviewId]),
    commentsCreated: result.commentsCreated,
    fallbackPath: options.fallbackPath || 'none',
    verificationStatus: options.verificationStatus || (result.success ? 'unverified' : 'failed'),
  };
}
