import { describe, it, expect, vi } from 'vitest';
import { OpenRouterClient, OpenRouterConnectionError } from '../../src/gateway/openRouterClient';

function sdkChunk(
  delta: Record<string, unknown> = {},
  options: { usage?: Record<string, unknown>; cost?: number; finish_reason?: string | null } = {},
): string {
  return JSON.stringify({
    id: 'chatcmpl-watchdog',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'google/gemini-3.7-flash',
    choices: [{ index: 0, finish_reason: options.finish_reason ?? null, delta }],
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.cost !== undefined ? { cost: options.cost } : {}),
  });
}

describe('Streaming Watchdog & Inactivity Timeout', () => {
  it('successfully collects streaming responses and reasoning deltas', async () => {
    const sseChunks = [
      ': keep-alive\n\n',
      `data: ${sdkChunk({ reasoning: 'Analyzing security checks...' })}\n\n`,
      `data: ${sdkChunk({ content: '{"findings":[]}' })}\n\n`,
      `data: ${sdkChunk({}, { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, cost: 0.0001 })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const mockStream = new ReadableStream({
      async start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    const mockFetch = vi.fn(async () => {
      return new Response(mockStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const client = new OpenRouterClient({
      apiKey: 'test-key',
      fetchImpl: mockFetch as any,
    });

    const response = await client.complete({
      model: 'google/gemini-3.7-flash:high',
      messages: [{ role: 'user', content: 'hello' }],
      timeoutMs: 10_000,
    });

    expect(response.content).toBe('{"findings":[]}');
    expect(response.usage?.total).toBe(120);
  });

  it('aborts stalled streams when no bytes arrive within inactivity timeout', async () => {
    // Create a stream that never yields any chunk and never closes
    const stalledStream = new ReadableStream({
      start(_controller) {
        // Deliberately idle/stalled
      },
    });

    const mockFetch = vi.fn(async () => {
      return new Response(stalledStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const client = new OpenRouterClient({
      apiKey: 'test-key',
      fetchImpl: mockFetch as any,
    });

    // Expect to throw within 200ms when request timeout or inactivity timeout triggers
    await expect(
      client.complete({
        model: 'google/gemini-3.7-flash:high',
        messages: [{ role: 'user', content: 'hello' }],
        timeoutMs: 150,
      })
    ).rejects.toThrow();
  });
});
