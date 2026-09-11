import { GitHubReviewGateClient, type ReviewGateClientOptions,
  type ReviewCiCheckCreateRequest, type ReviewCiCheckUpdateRequest, type ReviewGateUpdate } from './reviewGateClient';
import { REVIEW_CI_CHECK_NAME, reviewCiCoordinatesSchema, reviewCiIdentityDigest,
  type ReviewCiValidationIdentity } from '../review/reviewCi';
import type { ReviewGateCheck, ReviewCiCheckCoordinates } from '../review/reviewCheckIdentity';
import { REVIEW_CI_APP_ID } from './reviewCiClient';

export type ReviewCiCheckClient = {
  reconcile(coordinates: ReviewCiCheckCoordinates): Promise<ReviewGateCheck | null>;
  createPending(coordinates: ReviewCiCheckCoordinates, options?: Omit<ReviewCiCheckCreateRequest, 'coordinates'>): Promise<ReviewGateCheck>;
  createPending(request: ReviewCiCheckCreateRequest): Promise<ReviewGateCheck>;
  updateExisting(request: ReviewCiCheckUpdateRequest): Promise<ReviewGateCheck>;
  updateExisting(coordinates: ReviewCiCheckCoordinates, checkId: number, update: ReviewGateUpdate): Promise<ReviewGateCheck>;
};

/** Reuse the bounded check transport, identity readback and unknown-create
 * reconciliation rules. The facade exposes only typed CI coordinates; callers
 * cannot provide a free-form check name or external ID. */
export function createReviewCiCheckClient(options: Omit<ReviewGateClientOptions, 'checkName'>): ReviewCiCheckClient {
  if (options.expectedAppId !== REVIEW_CI_APP_ID) throw new Error('Untrusted CI check identity');
  const client = new GitHubReviewGateClient({ ...options, checkName: REVIEW_CI_CHECK_NAME });
  return {
    reconcile: (coordinates) => client.reconcileCi(coordinates),
    createPending: (coordinatesOrRequest: ReviewCiCheckCoordinates | ReviewCiCheckCreateRequest,
      createOptions: Omit<ReviewCiCheckCreateRequest, 'coordinates'> = {}) =>
      'coordinates' in coordinatesOrRequest
        ? client.createCiPending(coordinatesOrRequest)
        : client.createCiPending(coordinatesOrRequest, createOptions),
    updateExisting: (coordinatesOrRequest: ReviewCiCheckCoordinates | ReviewCiCheckUpdateRequest,
      checkId?: number, update?: ReviewGateUpdate) =>
      'coordinates' in coordinatesOrRequest
        ? client.updateCiExisting(coordinatesOrRequest)
        : client.updateCiExisting(coordinatesOrRequest, checkId as number, update as ReviewGateUpdate),
  };
}

/** Publish on PR H; bind the actually tested C, workflow SHA/lane plan, review
 * attempt, request UUID and CI epoch in the immutable correlation digest. */
export function reviewCiCheckCoordinates(identity: ReviewCiValidationIdentity, epoch: number): ReviewCiCheckCoordinates {
  try {
    if (identity.expectedAppId !== REVIEW_CI_APP_ID) throw new Error();
    const review = reviewCiCoordinatesSchema.parse(identity.review);
    if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new Error();
    return { owner: review.owner, repo: review.repo, repositoryId: review.repositoryId, prNumber: review.prNumber,
      headSha: review.headSha, baseSha: review.baseSha, policyDigest: review.policyDigest,
      requestId: identity.requestId, immutableBindingDigest: reviewCiIdentityDigest(identity), epoch };
  } catch { throw new Error('Invalid CI check binding'); }
}

export { deriveReviewCiCheckExternalId } from '../review/reviewCheckIdentity';
