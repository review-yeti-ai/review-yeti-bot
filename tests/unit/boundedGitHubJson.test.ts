import { describe, expect, it, vi } from 'vitest';
import { createBoundedGitHubJsonClient, MAX_GITHUB_JSON_RESPONSE_BYTES } from '../../src/github/boundedGitHubJson';

describe('bounded GitHub JSON transport', () => {
  it('pins GitHub.com, rejects redirects, and authenticates a bounded JSON request', async () => {
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;
    const client = createBoundedGitHubJsonClient({ token: 'ghs_test', fetchImplementation });
    await expect(client.request('/graphql', { method: 'POST', body: '{}' })).resolves.toEqual({ ok: true });
    expect(fetchImplementation).toHaveBeenCalledExactlyOnceWith('https://api.github.com/graphql', expect.objectContaining({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
      headers: expect.objectContaining({ authorization: 'Bearer ghs_test' }),
    }));
  });

  it.each([
    { token: 'ghp_not_an_installation_token' },
    { token: 'ghs_test', baseUrl: 'https://github.example.test/api/v3' },
    { token: 'ghs_test', timeoutMs: 30_001 },
  ])('rejects unsafe configuration before transport %#', async (override) => {
    const fetchImplementation = vi.fn();
    expect(() => createBoundedGitHubJsonClient({ fetchImplementation, ...override }))
      .toThrow('configuration is invalid');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each(['graphql', '//other.example.test/path', '/path#fragment', '/path\nother'])
  ('rejects an unsafe request path %j before transport', async (path) => {
    const fetchImplementation = vi.fn();
    const client = createBoundedGitHubJsonClient({ token: 'ghs_test', fetchImplementation });
    await expect(client.request(path)).rejects.toThrow('path is invalid');
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('rejects an oversized response without parsing it', async () => {
    const fetchImplementation = vi.fn(async () => new Response('{}', {
      status: 200, headers: { 'content-length': String(MAX_GITHUB_JSON_RESPONSE_BYTES + 1) },
    })) as typeof fetch;
    const client = createBoundedGitHubJsonClient({ token: 'ghs_test', fetchImplementation });
    await expect(client.request('/graphql')).rejects.toThrow('exceeded the byte limit');
  });
});
