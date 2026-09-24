/**
 * REL-1085: the worker's comparison-content reader for verdict-cache planning.
 * It is the same `AuthoritativeReviewReader.comparisonContent` the trusted
 * completion side uses, built from the run's repository-scoped read token, so
 * both sides derive content keys from GitHub's answer identically.
 */
import { AuthoritativeReviewReader } from './authoritativeReviewReader';
import type { ComparisonContentReader } from '../review/verdictCache';

export function createVerdictCacheCompareReader(input: {
  token: string;
  repositoryId: number;
  owner: string;
  repo: string;
  baseUrl?: string;
  fetchImplementation?: typeof fetch;
}): ComparisonContentReader | undefined {
  try {
    const reader = new AuthoritativeReviewReader({
      token: input.token,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.fetchImplementation ? { fetchImplementation: input.fetchImplementation } : {}),
    });
    const repository = { repositoryId: input.repositoryId, owner: input.owner, repo: input.repo };
    return { content: (baseSha, headSha, signal) => reader.comparisonContent(repository, baseSha, headSha, signal) };
  } catch {
    return undefined;
  }
}
