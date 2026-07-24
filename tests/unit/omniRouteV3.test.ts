import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmniRouteClient } from '../../src/gateway/omniRouteClient';

describe('OmniRoute 3.8.48 OpenAI-compatible adapter', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requests non-streaming output and preserves exact OmniRoute provenance', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body).toEqual({
        model: 'codex/gpt-5.6-sol-high',
        messages: [{ role: 'user', content: 'review' }],
        stream: false,
      });
      return new Response(JSON.stringify({
        model: 'gpt-5.6-sol-high',
        choices: [{ message: { content: 'result' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }), {
        status: 200,
        headers: {
          'x-omniroute-provider': 'cx',
          'x-omniroute-model': 'gpt-5.6-sol-high',
          'x-omniroute-response-cost': '0.000345',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await new OmniRouteClient({ baseUrl: 'http://omniroute:9090' }).complete({
      model: 'codex/gpt-5.6-sol-high',
      messages: [{ role: 'user', content: 'review' }],
      timeoutMs: 1000,
    });

    expect(result.model).toBe('codex/gpt-5.6-sol-high');
    expect(result.usage).toEqual({ prompt: 10, completion: 2, total: 12 });
    expect(result.costUSD).toBe(0.000345);
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

  it('rejects silent provider substitution even when the model leaf matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      model: 'claude-opus-4-8',
      choices: [{ message: { content: 'result' } }],
    }), {
      status: 200,
      headers: {
        'x-omniroute-provider': 'agy',
        'x-omniroute-model': 'claude-opus-4-8',
      },
    })));

    await expect(new OmniRouteClient({ baseUrl: 'http://omniroute:9090' }).complete({
      model: 'claude/claude-opus-4-8',
      messages: [{ role: 'user', content: 'review' }],
      timeoutMs: 1000,
    })).rejects.toThrow(/substituted provider/i);
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
