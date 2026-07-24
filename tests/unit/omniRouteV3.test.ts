import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

describe('OmniRoute 3.8.48 OpenAI-compatible adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends exact model/messages and preserves unavailable accounting', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        model: 'codex/gpt-5.6-sol-high',
        messages: [{ role: 'user', content: 'review' }],
      });
      return new Response(JSON.stringify({
        model: 'codex/gpt-5.6-sol-high',
        choices: [{ message: { content: 'result' } }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OmniRouteClient({ baseUrl: 'http://omniroute:9090' }).complete({
      model: 'codex/gpt-5.6-sol-high',
      messages: [{ role: 'user', content: 'review' }],
      timeoutMs: 1000,
    });

    expect(result.usage).toBeNull();
    expect(result.costUSD).toBeNull();
  });

  it('rejects silent model substitution', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'openai/gpt-4o',
      choices: [{ message: { content: 'result' } }],
    }), { status: 200 })));

    await expect(new OmniRouteClient({ baseUrl: 'http://omniroute:9090' }).complete({
      model: 'codex/gpt-5.6-sol-high',
      messages: [{ role: 'user', content: 'review' }],
      timeoutMs: 1000,
    })).rejects.toThrow(/substituted model/i);
  });

  it('does not report ready until every required provider family is active', async () => {
    const required = [
      'codex/gpt-5.6-sol-high',
      'grok-cli/grok-4.5',
      'agy/claude-opus-4-6-thinking',
      'claude/claude-opus-4-8',
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'healthy',
        cryptography: { status: 'healthy' },
        providerSummary: { configuredCount: 4, activeCount: 3 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'healthy',
        cryptography: { status: 'healthy' },
        providerSummary: { configuredCount: 4, activeCount: 4 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: required.map((id) => ({ id })),
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new OmniRouteClient({ baseUrl: 'http://omniroute:20128' });

    await expect(client.health(required)).resolves.toBe(false);
    await expect(client.health(required)).resolves.toBe(true);
  });
});
