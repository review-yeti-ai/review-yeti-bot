export const AUTHORITATIVE_REVIEW_APP_ID = 4385771;
export const PUBLIC_REVIEW_APP_ID = 4552718;
export const PUBLIC_REVIEW_REPOSITORY_ID = 1326169548;
export const PUBLIC_REVIEW_REPOSITORY = 'review-yeti-ai/review-yeti-bot';

export interface ReviewRepositoryAuthorityIdentity {
  repositoryId: number;
  owner: string;
  repo: string;
}

/**
 * Return only the service-owned App identity for a resolved repository.
 * The public self repository has a dedicated App; every other enrolled target
 * uses the CT review App. A split ID/name match is a configuration conflict.
 */
export function reviewAppIdForRepository(identity: ReviewRepositoryAuthorityIdentity): number {
  const publicId = identity.repositoryId === PUBLIC_REVIEW_REPOSITORY_ID;
  const publicName = `${identity.owner}/${identity.repo}` === PUBLIC_REVIEW_REPOSITORY;
  if (publicId !== publicName) throw new Error('Review App repository identity conflict');
  return publicId ? PUBLIC_REVIEW_APP_ID : AUTHORITATIVE_REVIEW_APP_ID;
}

export function isPublicReviewRepository(identity: ReviewRepositoryAuthorityIdentity): boolean {
  return identity.repositoryId === PUBLIC_REVIEW_REPOSITORY_ID
    && `${identity.owner}/${identity.repo}` === PUBLIC_REVIEW_REPOSITORY;
}
