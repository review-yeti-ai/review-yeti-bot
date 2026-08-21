import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';

describe('base-SHA policy protection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fetches .ct-review.yaml at the immutable PR base SHA', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/contents/.ct-review.yaml?ref=base-immutable-sha');
      return new Response(JSON.stringify({
        encoding: 'base64',
        content: Buffer.from('version: 3').toString('base64'),
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new GitHubInstallationClient({
      token: 'ghs_installation_token',
      baseUrl: 'https://api.github.test',
    });
    expect(await client.getBasePolicy('calltelemetry', 'ct-meta', 'base-immutable-sha')).toBe('version: 3');
  });
});
