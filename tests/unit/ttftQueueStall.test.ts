import { describe, it, expect } from 'vitest';
import { OpenRouterClient } from '../../src/gateway/openRouterClient';
import { ProviderQueueStallError } from '../../src/gateway/providerCapacityManager';

describe('Streaming TTFT Queue Watchdog', () => {
  it('throws ProviderQueueStallError when stream does not emit initial token within TTFT window', async () => {
    // Mock response where stream opens but stalls on first read (queue wait)
    const mockResponse = {
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => ({
          read: () => new Promise((resolve) => setTimeout(() => resolve({ done: false, value: new Uint8Array() }), 200)),
        }),
      },
    } as unknown as Response;

    const client = new OpenRouterClient({
      baseUrl: 'https://api.fireworks.ai/inference/v1',
      apiKey: 'test-key',
      fetchImpl: async () => mockResponse,
    });

    await expect(
      client.complete({
        model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 5_000,
        providerId: 'fireworks',
        ttftTimeoutMs: 50, // Fast 50ms TTFT threshold for testing
      })
    ).rejects.toThrow(ProviderQueueStallError);
  });

  it('completes normally when stream emits tokens before TTFT window expires', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('data: {"choices":[{"delta":{"content":"{\\"decision\\":\\"APPROVE\\",\\"findings\\":[]}"}}]}\n\n'),
      encoder.encode('data: [DONE]\n\n'),
    ];
    let chunkIndex = 0;

    const mockResponse = {
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader: () => ({
          read: async () => {
            if (chunkIndex < chunks.length) {
              return { done: false, value: chunks[chunkIndex++] };
            }
            return { done: true, value: undefined };
          },
        }),
      },
    } as unknown as Response;

    const client = new OpenRouterClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      fetchImpl: async () => mockResponse,
    });

    const res = await client.complete({
      model: 'deepseek/deepseek-v4-flash-0731',
      messages: [{ role: 'user', content: 'test' }],
      timeoutMs: 5_000,
      ttftTimeoutMs: 200,
    });

    expect(res.content).toContain('APPROVE');
  });
});
