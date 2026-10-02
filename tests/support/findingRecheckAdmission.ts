import type { AuthoritativeReviewAdmission } from '../../src/review/authoritativeServiceContracts';
import type { AuthoritativePublishingResolution } from '../../src/review/authoritativePublishingResolver';

/** Deterministic service-owned current-truth reader for offline request tests. */
export function findingRecheckAdmission(identity: {
  repositoryId: number; owner: string; repo: string; prNumber: number; headSha: string;
  baseSha: string; policyDigest: string; configDigest: string;
}): AuthoritativeReviewAdmission {
  return {
    expectedAppId: 4385771, acceptNewRequests: true, repositoryIds: [identity.repositoryId],
    resolver: { resolve: async () => ({
      current: { repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repo,
        prNumber: identity.prNumber, headSha: identity.headSha, baseSha: identity.baseSha, open: true, draft: false },
      prepared: { policy: { effectivePolicyDigest: identity.policyDigest, effectiveConfigDigest: identity.configDigest } },
    } as AuthoritativePublishingResolution) },
  };
}
