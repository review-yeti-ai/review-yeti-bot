import { GitHubInstallationClient } from '../github/installationClient';

export * from '../github/installationClient';
export { GitHubInstallationClient };

/**
 * Idiomatic publisher facade for GitHub Checks.
 */
export class GitHubCheckPublisher {
  constructor(private readonly client: GitHubInstallationClient) {}

  public async createCheck(
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<number> {
    return this.client.createCheck(owner, repo, headSha);
  }

  public async completeCheck(options: {
    owner: string;
    repo: string;
    checkId: number;
    conclusion: 'success' | 'failure' | 'cancelled';
    title: string;
    summary: string;
  }): Promise<void> {
    return this.client.completeCheck(options);
  }

  public async updateCheck(options: {
    owner: string;
    repo: string;
    checkId: number;
    status?: 'queued' | 'in_progress' | 'completed';
    title?: string;
    summary?: string;
  }): Promise<void> {
    return this.client.updateCheck(options);
  }
}
