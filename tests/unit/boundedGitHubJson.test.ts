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

  it('rejects a non-conforming redirected response even when its status is 200', async () => {
    const redirected = new Response('{}', { status: 200 });
    Object.defineProperty(redirected, 'redirected', { value: true });
    const fetchImplementation = vi.fn(async () => redirected) as typeof fetch;
    const client = createBoundedGitHubJsonClient({ token: 'ghs_test', fetchImplementation });
    await expect(client.request('/graphql')).rejects.toThrow('GitHub JSON request failed with HTTP 200');
  });

  it('cancels a chunked response as soon as the streaming byte cap is crossed', async () => {
    const cancel = vi.fn();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent < 3) {
          sent += 1;
          controller.enqueue(new Uint8Array(Math.floor(MAX_GITHUB_JSON_RESPONSE_BYTES / 2) + 1));
        } else controller.close();
      },
      cancel,
    });
    const fetchImplementation = vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch;
    const client = createBoundedGitHubJsonClient({ token: 'ghs_test', fetchImplementation });
    await expect(client.request('/graphql')).rejects.toThrow('response was unavailable');
    expect(cancel).toHaveBeenCalledOnce();
    expect(sent).toBeLessThanOrEqual(3);
  });
});
