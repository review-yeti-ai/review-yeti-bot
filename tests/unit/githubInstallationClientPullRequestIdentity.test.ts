import { describe, expect, it, vi } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';

function clientFor(payload: unknown): GitHubInstallationClient {
  return new GitHubInstallationClient({
    token: `ghs_${'a'.repeat(40)}`,
    baseUrl: 'https://api.github.test',
    fetchImplementation: vi.fn(async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })),
  });
}

describe('GitHubInstallationClient pull request repository identity', () => {
  it('surfaces the positive safe base repository id used by MCP admission', async () => {
    const snapshot = await clientFor({
      head: { sha: 'a'.repeat(40) },
      base: { sha: 'b'.repeat(40), repo: { id: 190468701 } },
      title: 'Governed MCP trigger',
      body: 'Exact-head admission',
    }).getPullRequest('calltelemetry', 'cisco-cdr', 5135);

    expect(snapshot).toEqual({
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      title: 'Governed MCP trigger',
      body: 'Exact-head admission',
      repositoryId: 190468701,
    });
  });

  it('omits repositoryId when GitHub does not return a valid base repository id', async () => {
    const snapshot = await clientFor({
      head: { sha: 'a'.repeat(40) },
      base: { sha: 'b'.repeat(40) },
      title: 'Missing repository identity',
      body: '',
    }).getPullRequest('calltelemetry', 'cisco-cdr', 5135);

    expect(snapshot).not.toHaveProperty('repositoryId');
    expect(snapshot).toMatchObject({
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
    });
  });
});
