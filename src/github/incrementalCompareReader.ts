/**
 * REL-1084: the worker's commit-comparison reader for incremental re-review
 * planning. It is the same `AuthoritativeReviewReader.commitComparison` the
 * trusted completion side uses, built from the run's repository-scoped read
 * token, so both sides parse GitHub's answer identically.
 */
import { AuthoritativeReviewReader } from './authoritativeReviewReader';
import type { CommitComparisonReader } from '../review/incrementalReview';

export function createIncrementalCompareReader(input: {
  token: string;
  repositoryId: number;
  owner: string;
  repo: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}): CommitComparisonReader | undefined {
  try {
    const reader = new AuthoritativeReviewReader({
      token: input.token,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.fetchImplementation ? { fetchImplementation: input.fetchImplementation } : {}),
    });
    const repository = { repositoryId: input.repositoryId, owner: input.owner, repo: input.repo };
    return { compare: (baseSha, headSha, signal) => reader.commitComparison(repository, baseSha, headSha, signal) };
  } catch {
    return undefined;
  }
}
