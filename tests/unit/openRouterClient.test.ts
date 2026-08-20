import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';
import { normalizeOpenRouterModel, OpenRouterClient, OpenRouterConnectionError } from '../../src/gateway/openRouterClient';

const request = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user' as const, content: 'review this diff' }],
  timeoutMs: 1_000,
  stream: false,
};

describe('OpenRouterClient', () => {
  it('normalizes legacy provider-router model names without using the old route', () => {
    expect(normalizeOpenRouterModel('codex/gpt-5.6-sol-high')).toBe('openai/gpt-5.6-sol');
    expect(normalizeOpenRouterModel('grok-cli/grok-4.5')).toBe('x-ai/grok-4.5');
    expect(normalizeOpenRouterModel('claude-opus-4-8')).toBe('anthropic/claude-opus-4.8');
    expect(normalizeOpenRouterModel('openrouter/auto')).toBe('openrouter/auto');
    expect(normalizeOpenRouterModel('openrouter/5.6-luna-high')).toBe('openai/gpt-5.6-luna');
    expect(normalizeOpenRouterModel('5.6-luna-high')).toBe('openai/gpt-5.6-luna');
    expect(normalizeOpenRouterModel('openrouter/openai/gpt-5.6-luna')).toBe('openai/gpt-5.6-luna');
    expect(normalizeOpenRouterModel('openai/gpt-5.6-luna')).toBe('openai/gpt-5.6-luna');
  });

  it('normalizes openrouter/5.6-luna-high in requests and computes estimated luna token cost', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'openai/gpt-5.6-luna',
      choices: [{ message: { role: 'assistant', content: 'APPROVE' } }],
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const client = new OpenRouterClient({
      baseUrl: 'https://openrouter.test/api/v1',
      apiKey: 'test-openrouter-key',
      fetchImplementation,
    });

    const res = await client.complete({
      model: 'openrouter/5.6-luna-high',
      messages: [{ role: 'user', content: 'analyze this PR' }],
      timeoutMs: 2000,
    });

    expect(res.model).toBe('openai/gpt-5.6-luna');
    expect(res.content).toBe('APPROVE');
    // Luna rate: $0.002 prompt / 1k + $0.006 completion / 1k
    // 1000 * 0.000002 + 500 * 0.000006 = 0.002 + 0.003 = 0.005 USD
    expect(res.costUSD).toBe(0.005);

    const init = fetchImplementation.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'openai/gpt-5.6-luna' });
  });

  it('uses the injected transport, OpenRouter endpoint, and exact request payload', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: request.model,
      choices: [{ message: { role: 'assistant', content: 'SHIP' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new OpenRouterClient({
      baseUrl: 'https://openrouter.test/api/v1',
      apiKey: 'test-openrouter-key',
      fetchImplementation,
      now: () => 1_700_000_000_000,
    });

    await expect(client.complete(request)).resolves.toMatchObject({
      model: request.model,
      content: 'SHIP',
      usage: { prompt: 10, completion: 4, total: 14 },
    });

    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://openrouter.test/api/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    const init = fetchImplementation.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-openrouter-key');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: request.model, stream: false });
  });

  it('replays a streaming OpenRouter response deterministically', async () => {
    const stream = [
      ': OPENROUTER PROCESSING\n',
      'data: {"model":"openai/gpt-4o-mini","choices":[{"delta":{"content":"FIX"}}]}\n',
      'data: {"choices":[{"delta":{"content":"_FIRST"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n',
      'data: [DONE]\n',
    ].join('');
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const client = new OpenRouterClient({ apiKey: 'test-openrouter-key', fetchImplementation });

    await expect(client.complete({ ...request, stream: true })).resolves.toMatchObject({
      content: 'FIX_FIRST',
      usage: { prompt: 3, completion: 2, total: 5 },
    });
  });

  it('replays a credential-free OpenRouter cassette and rejects an unmatched request', async () => {
    const cassette = createCassetteFetch({
      cassettePath: path.resolve(__dirname, '../fixtures/cassettes/openrouter-chat.json'),
    });
    const client = new OpenRouterClient({
      baseUrl: 'https://openrouter.test/api/v1',
      apiKey: 'redacted-test-key',
      fetchImplementation: cassette.fetchImplementation,
    });

    await expect(client.complete({
      ...request,
      messages: [{ role: 'user', content: 'replay this review' }],
    })).resolves.toMatchObject({ content: '{"verdict":"SHIP"}' });
    await expect(cassette.fetchImplementation('https://openrouter.test/unmatched')).rejects.toThrow(
      'No cassette interaction matches',
    );
    cassette.assertComplete();
  });

  it('fails closed when the key is missing or the provider response is malformed', async () => {
    const noKey = new OpenRouterClient({ fetchImplementation: vi.fn() });
    await expect(noKey.complete(request)).rejects.toThrow(OpenRouterConnectionError);

    const malformed = new OpenRouterClient({
      apiKey: 'test-openrouter-key',
      fetchImplementation: vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 })),
    });
    await expect(malformed.complete(request)).rejects.toThrow('empty completion content');
  });
});
