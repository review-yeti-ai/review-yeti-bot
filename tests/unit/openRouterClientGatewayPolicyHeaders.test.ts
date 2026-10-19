import { describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../../src/gateway/openRouterClient';

const base = {
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'synthetic transport test' }],
  timeoutMs: 5_000,
};
const cloudflareBaseUrl = 'https://gateway.ai.cloudflare.com/v1/11111111111111111111111111111111/test/custom-example/v1';

function sse() {
  return new Response(
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n'
      + 'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"finish_reason":"stop","delta":{}}]}\n\n'
      + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function chatJson() {
  return new Response(JSON.stringify({
    id: 'c', object: 'chat.completion', created: 1, model: 'test-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function values(init: RequestInit | undefined, name: string): string[] {
  const raw = init?.headers;
  if (raw instanceof Headers) {
    const value = raw.get(name);
    return value === null ? [] : [value];
  }
  return Object.entries((raw || {}) as Record<string, string>)
    .filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);
}

describe('Cloudflare AI Gateway request authentication', () => {
  it.each([true, false])('uses cf-aig-authorization without retired gateway headers (stream=%s)', async (stream) => {
    const fetchImplementation = vi.fn(async () => (stream ? sse() : chatJson()));
    const client = new OpenRouterClient({
      apiKey: 'dedicated-run-token',
      baseUrl: cloudflareBaseUrl,
      authorizationHeaderName: 'cf-aig-authorization',
      fetchImplementation,
    });
    await expect(client.complete({ ...base, stream })).resolves.toMatchObject({ content: 'ok' });
    const init = (fetchImplementation.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(values(init, 'cf-aig-authorization')).toEqual(['Bearer dedicated-run-token']);
    expect(values(init, 'authorization')).toEqual([]);
    expect(values(init, 'x-openrouter-metadata')).toEqual([]);
    expect(values(init, 'x-bf-mcp-include-tools')).toEqual([]);
  });

  it.each([true, false])('prevents caller metadata from replacing the Run token (stream=%s)', async (stream) => {
    const fetchImplementation = vi.fn(async () => (stream ? sse() : chatJson()));
    const client = new OpenRouterClient({
      apiKey: 'dedicated-run-token',
      baseUrl: cloudflareBaseUrl,
      authorizationHeaderName: 'cf-aig-authorization',
      fetchImplementation,
    });
    await client.complete({
      ...base,
      stream,
      metadata: {
        Authorization: 'Bearer caller-value',
        'cf-aig-authorization': 'Bearer caller-value',
        'x-bf-mcp-include-tools': 'all',
        'x-openrouter-metadata': 'enabled',
      },
    } as any);
    const init = (fetchImplementation.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(values(init, 'cf-aig-authorization')).toEqual(['Bearer dedicated-run-token']);
    expect(values(init, 'authorization')).toEqual([]);
    expect(values(init, 'x-bf-mcp-include-tools')).toEqual([]);
    expect(values(init, 'x-openrouter-metadata')).toEqual([]);
  });

  it('never sends the retired gateway policy header through a generic compatible transport', async () => {
    const fetchImplementation = vi.fn(async () => sse());
    const client = new OpenRouterClient({
      apiKey: 'generic-test-key',
      baseUrl: 'https://gateway.example.invalid/v1',
      fetchImplementation,
    });
    await client.complete({ ...base, stream: true });
    const init = (fetchImplementation.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(values(init, 'x-bf-mcp-include-tools')).toEqual([]);
  });
});
