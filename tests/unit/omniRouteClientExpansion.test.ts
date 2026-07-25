import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

describe('omniRouteClient.ts — Comprehensive Unit Expansion Tests', () => {
  const baseUrl = 'http://localhost:8080/';
  const token = 'omni-access-token-123';
  let client: OmniRouteClient;

  beforeEach(() => {
    client = new OmniRouteClient({ baseUrl, accessToken: token });
  });

  it('strips trailing slashes from baseUrl in constructor', () => {
    const c = new OmniRouteClient({ baseUrl: 'http://localhost:8080///' });
    expect((c as any).baseUrl).toBe('http://localhost:8080');
  });

  it('health returns true when monitoring endpoint and models check succeed', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'healthy',
          cryptography: { status: 'healthy' },
          providerSummary: { activeCount: 2 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-5-sonnet' },
            { id: 'gpt-5.6-sol' },
          ],
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const isHealthy = await client.health(['claude-5-sonnet', 'gpt-5.6-sol']);

    expect(isHealthy).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it('health returns false when monitoring endpoint status is not healthy', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'degraded' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const isHealthy = await client.health();
    expect(isHealthy).toBe(false);

    vi.unstubAllGlobals();
  });

  it('health returns false when required models are missing from /v1/models', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          status: 'healthy',
          cryptography: { status: 'healthy' },
          providerSummary: { activeCount: 10 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: 'claude-5-sonnet' }],
        }),
      });
    vi.stubGlobal('fetch', mockFetch);

    const isHealthy = await client.health(['claude-5-sonnet', 'deepseek-v4-pro']);
    expect(isHealthy).toBe(false);

    vi.unstubAllGlobals();
  });

  it('complete sends POST request to /v1/chat/completions with Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'claude-5-sonnet',
        choices: [{ message: { content: 'Test response content' } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        cost_usd: 0.0005,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await client.complete({
      model: 'claude-5-sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      timeoutMs: 5000,
    });

    expect(result.model).toBe('claude-5-sonnet');
    expect(result.content).toBe('Test response content');
    expect(result.usage).toEqual({ prompt: 10, completion: 20, total: 30 });
    expect(result.costUSD).toBe(0.0005);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8080/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer omni-access-token-123',
        }),
      })
    );

    vi.unstubAllGlobals();
  });

  it('complete throws error on HTTP non-200 response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Provider overloaded' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      client.complete({
        model: 'claude-5-sonnet',
        messages: [{ role: 'user', content: 'Hi' }],
        timeoutMs: 5000,
      })
    ).rejects.toThrow('OmniRoute HTTP 503');

    vi.unstubAllGlobals();
  });

  it('complete throws error on silent model substitution', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'gpt-4o-mini', // Substituted model!
        choices: [{ message: { content: 'Text' } }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      client.complete({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'Hi' }],
        timeoutMs: 5000,
      })
    ).rejects.toThrow('OmniRoute silently substituted model gpt-4o-mini for gpt-5.6-sol');

    vi.unstubAllGlobals();
  });

  it('complete throws error on empty completion content', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'gpt-5.6-sol',
        choices: [{ message: { content: '   ' } }],
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await expect(
      client.complete({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'Hi' }],
        timeoutMs: 5000,
      })
    ).rejects.toThrow('OmniRoute returned empty completion content');

    vi.unstubAllGlobals();
  });

  it('legacy completion shim throws error if provider or prompt is missing', async () => {
    await expect(client.completion({ prompt: 'Hello' })).rejects.toThrow('Legacy completion requires an exact model');
    await expect(client.completion({ provider: 'claude-5-sonnet' })).rejects.toThrow('Legacy completion requires an exact model');
  });

  it('legacy completion shim returns formatted legacy data object', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'claude-5-sonnet',
        choices: [{ message: { content: 'Legacy content' } }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        cost_usd: 0.0001,
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const legacyRes = await client.completion({ provider: 'claude-5-sonnet', prompt: 'Legacy prompt' });

    expect(legacyRes.status).toBe(200);
    expect(legacyRes.providerUsed).toBe('claude-5-sonnet');
    expect(legacyRes.modelUsed).toBe('claude-5-sonnet');
    expect(legacyRes.content).toBe('Legacy content');

    vi.unstubAllGlobals();
  });
});
