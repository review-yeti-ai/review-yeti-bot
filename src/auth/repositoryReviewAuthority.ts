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
  /** Optional source-configured map for authenticated callers without a numeric repository claim. */
  repositoryIdentities?: readonly ReviewAuthorityRepository[];
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

/**
 * Validate an authenticated repository claim against any optional local
 * name/ID binding. Repositories with no configured binding retain the
 * numeric-claim compatibility path; a partial or ambiguous binding is a
 * conflict and must be rejected before dependency reads.
 */
export function matchesConfiguredReviewRepositoryIdentity(admission: ReviewAuthorityAdmission,
  repository: ReviewAuthorityRepository): boolean {
  try { expectedReviewAppIdFor(admission, repository); } catch { return false; }
  const configured = admission.repositoryIdentities || [];
  const name = `${repository.owner}/${repository.repo}`.toLowerCase();
  const byId = configured.filter((entry) => entry.repositoryId === repository.repositoryId);
  const byName = configured.filter((entry) => `${entry.owner}/${entry.repo}`.toLowerCase() === name);
  if (byId.length === 0 && byName.length === 0) return true;
  return byId.length === 1 && byName.length === 1
    && byId[0].repositoryId === byName[0].repositoryId
    && `${byId[0].owner}/${byId[0].repo}`.toLowerCase()
      === `${byName[0].owner}/${byName[0].repo}`.toLowerCase();
}

/** Resolve only an already-enrolled locally configured repository name. */
export function authoritativeRepositoryForName(admission: ReviewAuthorityAdmission,
  owner: string, repo: string): ReviewAuthorityRepository | undefined {
  const requestedName = `${owner}/${repo}`.toLowerCase();
  if (requestedName === PUBLIC_REVIEW_REPOSITORY.toLowerCase()) {
    const fixed = { repositoryId: PUBLIC_REVIEW_REPOSITORY_ID,
      owner: PUBLIC_REVIEW_REPOSITORY.split('/')[0], repo: PUBLIC_REVIEW_REPOSITORY.split('/')[1] };
    if (!admission.repositoryIds.includes(fixed.repositoryId)) return undefined;
    expectedReviewAppIdFor(admission, fixed);
    return fixed;
  }
  const matches = (admission.repositoryIdentities || []).filter((identity) =>
    `${identity.owner}/${identity.repo}`.toLowerCase() === requestedName);
  if (matches.length !== 1) return undefined;
  const identity = matches[0];
  if (!admission.repositoryIds.includes(identity.repositoryId)) return undefined;
  expectedReviewAppIdFor(admission, identity);
  return { repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repo };
}
