import { AUTHORITATIVE_REVIEW_APP_ID } from './authoritativeServiceIdentity';
import {
  PUBLIC_REVIEW_REPOSITORY,
  PUBLIC_REVIEW_REPOSITORY_ID,
  PUBLIC_REVIEW_APP_ID,
} from '../config/repositoryReviewAuthorityConstants';

export { PUBLIC_REVIEW_REPOSITORY, PUBLIC_REVIEW_REPOSITORY_ID, PUBLIC_REVIEW_APP_ID }
  from '../config/repositoryReviewAuthorityConstants';

export interface ReviewAuthorityRepository { repositoryId: number; owner: string; repo: string }
export interface ReviewAuthorityAdmission {
  expectedAppId: number;
  expectedAppIdFor?: (repository: ReviewAuthorityRepository) => number;
  repositoryIds: readonly number[];
}

/** A configured credential never grants another repository this App's authority. */
export function isPublicReviewRepository(repository: ReviewAuthorityRepository): boolean {
  return repository.repositoryId === PUBLIC_REVIEW_REPOSITORY_ID
    && `${repository.owner}/${repository.repo}` === PUBLIC_REVIEW_REPOSITORY;
}

/** The callback is control-plane configuration, never part of a review request. */
export function expectedReviewAppIdFor(admission: ReviewAuthorityAdmission,
  repository: ReviewAuthorityRepository): number {
  if (!admission.repositoryIds.includes(repository.repositoryId)) {
    throw new Error('Repository is outside authoritative review admission');
  }
  const publicId = repository.repositoryId === PUBLIC_REVIEW_REPOSITORY_ID;
  const publicName = `${repository.owner}/${repository.repo}` === PUBLIC_REVIEW_REPOSITORY;
  if (publicId !== publicName) throw new Error('Public review repository identity is invalid');
  const appId = publicId ? PUBLIC_REVIEW_APP_ID : admission.expectedAppId;
  if (!Number.isSafeInteger(appId)
    || (publicId && appId !== PUBLIC_REVIEW_APP_ID)
    || (!publicId && appId !== AUTHORITATIVE_REVIEW_APP_ID)) {
    throw new Error('Repository review App authority is invalid');
  }
  if (admission.expectedAppIdFor && admission.expectedAppIdFor(repository) !== appId) {
    throw new Error('Repository review App authority is invalid');
  }
  return appId;
}
