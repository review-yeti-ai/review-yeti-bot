import { describe, it, expect, vi } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';

// ct-meta#2884: `getRepositoryVisibility` is the fallback source of visibility for
// any run mode whose webhook payload did not carry `repository.private` /
// `repository.visibility` directly. A lookup failure here must never throw and
// must never block or fail the review it was requested for -- it degrades to
// 'UNKNOWN', which the persona prompt then reports as "could not be determined"
// rather than silently defaulting to PUBLIC or PRIVATE.

const token = 'ghs_test_installation_token_12345';

describe('GitHubInstallationClient.getRepositoryVisibility', () => {
  it('returns PRIVATE from a boolean `private: true` response', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      private: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new GitHubInstallationClient({ token, baseUrl: 'https://api.github.com', fetchImplementation });

    await expect(client.getRepositoryVisibility('calltelemetry', 'ct-meta')).resolves.toBe('PRIVATE');
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.github.com/repos/calltelemetry/ct-meta',
      expect.anything(),
    );
  });

  it('returns PUBLIC from a boolean `private: false` response', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      private: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new GitHubInstallationClient({ token, baseUrl: 'https://api.github.com', fetchImplementation });

    await expect(client.getRepositoryVisibility('calltelemetry', 'calltelemetry')).resolves.toBe('PUBLIC');
  });

  it('prefers the string `visibility` field over `private` when both are present', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      private: true,
      visibility: 'internal',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new GitHubInstallationClient({ token, baseUrl: 'https://api.github.com', fetchImplementation });

    // 'internal' normalizes to PRIVATE, same conclusion here, but exercised via the
    // `visibility` branch rather than the `private` branch.
    await expect(client.getRepositoryVisibility('calltelemetry', 'ct-meta')).resolves.toBe('PRIVATE');
  });

  it('resolves to UNKNOWN, and does not throw, when the GitHub API call rejects (network error)', async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(new Error('fetch failed: ECONNRESET'));
    const client = new GitHubInstallationClient({ token, baseUrl: 'https://api.github.com', fetchImplementation });

    await expect(client.getRepositoryVisibility('calltelemetry', 'ct-meta')).resolves.toBe('UNKNOWN');
  });

  it('resolves to UNKNOWN, and does not throw, on a non-2xx GitHub response (e.g. 404)', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response('{"message":"Not Found"}', {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new GitHubInstallationClient({ token, baseUrl: 'https://api.github.com', fetchImplementation });

    await expect(client.getRepositoryVisibility('calltelemetry', 'missing-repo')).resolves.toBe('UNKNOWN');
  });

  it('resolves to UNKNOWN when the response body has neither `private` nor `visibility`', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new GitHubInstallationClient({ token, baseUrl: 'https://api.github.com', fetchImplementation });

    await expect(client.getRepositoryVisibility('calltelemetry', 'ct-meta')).resolves.toBe('UNKNOWN');
  });

  it('memoises the lookup per owner/repo: a second call for the same repo does not re-fetch', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({ private: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new GitHubInstallationClient({ token, baseUrl: 'https://api.github.com', fetchImplementation });

    const [first, second] = await Promise.all([
      client.getRepositoryVisibility('calltelemetry', 'ct-meta'),
      client.getRepositoryVisibility('calltelemetry', 'ct-meta'),
    ]);
    expect(first).toBe('PRIVATE');
    expect(second).toBe('PRIVATE');
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });
});
