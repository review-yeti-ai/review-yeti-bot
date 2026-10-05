import type { AuthoritativeReviewAdmission } from '../review/authoritativeServiceContracts';
import { AUTHORITATIVE_REVIEW_APP_ID } from './authoritativeServiceIdentity';

export const PUBLIC_REVIEW_REPOSITORY = 'review-yeti-ai/review-yeti-bot';
export const PUBLIC_REVIEW_REPOSITORY_ID = 1326169548;
export const PUBLIC_REVIEW_APP_ID = 4552718;

export interface ReviewAuthorityRepository { repositoryId: number; owner: string; repo: string }

/** A configured credential never grants another repository this App's authority. */
export function isPublicReviewRepository(repository: ReviewAuthorityRepository): boolean {
  return repository.repositoryId === PUBLIC_REVIEW_REPOSITORY_ID
    && `${repository.owner}/${repository.repo}` === PUBLIC_REVIEW_REPOSITORY;
}

/** The callback is control-plane configuration, never part of a review request. */
export function expectedReviewAppIdFor(admission: AuthoritativeReviewAdmission,
  repository: ReviewAuthorityRepository): number {
  if (!admission.repositoryIds.includes(repository.repositoryId)) {
    throw new Error('Repository is outside authoritative review admission');
  }
  const publicId = repository.repositoryId === PUBLIC_REVIEW_REPOSITORY_ID;
  const publicName = `${repository.owner}/${repository.repo}` === PUBLIC_REVIEW_REPOSITORY;
  if (publicId !== publicName) throw new Error('Public review repository identity is invalid');
  const appId = admission.expectedAppIdFor?.(repository) ?? admission.expectedAppId;
  if (!Number.isSafeInteger(appId)
    || (publicId && appId !== PUBLIC_REVIEW_APP_ID)
    || (!publicId && appId !== AUTHORITATIVE_REVIEW_APP_ID)) {
    throw new Error('Repository review App authority is invalid');
  }
  return appId;
}
