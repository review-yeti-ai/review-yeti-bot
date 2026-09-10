import { z } from 'zod';
import type { GitHubWebhookConfig } from './githubWebhookConfig';

const positiveInteger = z.number().int().positive().safe();
const name = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/u);

export const githubWebhookRepositorySchema = z.object({
  id: positiveInteger,
  name,
  full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  owner: z.object({ id: positiveInteger, login: name }).passthrough(),
}).passthrough();

export class UnenrolledGitHubWebhookIdentityError extends Error {
  constructor() { super('GitHub webhook repository identity is not enrolled'); }
}

/** One enrollment rule shared by pull-request and merge-group admission. */
export function requireEnrolledGitHubWebhookRepository(
  repository: z.infer<typeof githubWebhookRepositorySchema>,
  config: GitHubWebhookConfig,
): { owner: string; repo: string } {
  const owner = repository.owner.login;
  const repo = repository.name;
  if (repository.full_name !== `${owner}/${repo}`
    || !config.repositoryIds.has(String(repository.id))
    || !config.ownerIds.has(String(repository.owner.id))) {
    throw new UnenrolledGitHubWebhookIdentityError();
  }
  return { owner, repo };
}
