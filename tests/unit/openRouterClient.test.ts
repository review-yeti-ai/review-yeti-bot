import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createCassetteFetch } from '../support/cassetteFetch';
import {
  buildOpenRouterChatRequest,
  normalizeOpenRouterModel,
  OpenRouterClient,
  OpenRouterConnectionError,
  OpenRouterTimeoutError,
  getStaticModelMetadata,
  resolveModelMetadata,
  calculateSafeDiffCapacity,
  clearModelMetadataCache,
} from '../../src/gateway/openRouterClient';

const request = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user' as const, content: 'review this diff' }],
  timeoutMs: 1_000,
  stream: false,
};

describe('OpenRouterClient', () => {
  it('builds a stable OpenRouter request with routing, privacy, and structured-output controls', () => {
    expect(buildOpenRouterChatRequest({
      ...request,
      model: 'openrouter/5.6-luna-high',
      reasoningEffort: 'high',
      maxTokens: 24_576,
      temperature: 0,
      responseFormat: { type: 'json_object' },
      provider: {
        allow_fallbacks: true,
        require_parameters: true,
        ignore: ['morph', 'fireworks'],
        data_collection: 'deny',
      },
      plugins: [{ id: 'auto-router', allowed_models: ['openai/gpt-5.6-luna'] }],
      metadata: { 'x-ct-test': 'replay' },
    })).toEqual({
      model: 'openai/gpt-5.6-luna',
      messages: request.messages,
      stream: false,
      max_tokens: 24_576,
      temperature: 0,
      reasoning_effort: 'high',
      response_format: { type: 'json_object' },
      provider: {
        allow_fallbacks: true,
        require_parameters: true,
        ignore: ['morph', 'fireworks'],
        data_collection: 'deny',
      },
      plugins: [{ id: 'auto-router', allowed_models: ['openai/gpt-5.6-luna'] }],
      metadata: { 'x-ct-test': 'replay' },
    });
  });

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
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toMatchObject({ model: request.model, stream: false });
  });

  it('replays a streaming OpenRouter response deterministically', async () => {
    const stream = [
      ': OPENROUTER PROCESSING\n',
      'data: {"model":"openai/gpt-4o-mini","choices":[{"delta":{"content":"FIX"}}]}\n',
      'data: {"choices":[{"delta":{"content":"_FIRST"}}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"total_cost":"0.0081"}}\n',
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
      costUSD: 0.0081,
    });
    const init = fetchImplementation.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('accept')).toBe('text/event-stream');
  });

  it('replays fragmented SSE frames and keepalives without losing usage or cost metadata', async () => {
    const encoded = [
      ': keep-alive\n\n',
      'data: {"choices":[{"delta":{"content":"{\\"findings\\": ["}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" ]}"}}],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
      'data: {"usage":{"cost_details":{"upstream_inference_cost":"0.0042"}}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const splitAt = encoded.indexOf('findings') + 4;
    const chunks = [encoded.slice(0, splitAt), encoded.slice(splitAt)].map((part) => new TextEncoder().encode(part));
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const client = new OpenRouterClient({ apiKey: 'test-openrouter-key', fetchImplementation });

    await expect(client.complete({ ...request, stream: true })).resolves.toMatchObject({
      content: '{"findings": [ ]}',
      usage: { prompt: 7, completion: 3, total: 10 },
      costUSD: 0.0042,
    });
  });

  it('replays OpenRouter reasoning_details SSE entries as reasoning text', async () => {
    const stream = [
      'data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"checking the diff"}]}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"{\\"findings\\":[]}"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const client = new OpenRouterClient({ apiKey: 'test-openrouter-key', fetchImplementation });

    await expect(client.complete({ ...request, stream: true })).resolves.toMatchObject({
      content: '{"findings":[]}',
      raw: expect.objectContaining({
        choices: [expect.objectContaining({
          message: expect.objectContaining({ reasoning: 'checking the diff' }),
        })],
      }),
    });
  });

  it('replays provider error, malformed-body, and SSE boundary fixtures without network access', async () => {
    const cassette = createCassetteFetch({
      cassettePath: path.resolve(__dirname, '../fixtures/cassettes/openrouter/reliability-boundaries.json'),
      fetchImplementation: vi.fn(async () => {
        throw new Error('network escaped replay');
      }),
    });
    const client = new OpenRouterClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-openrouter-key',
      fetchImplementation: cassette.fetchImplementation,
    });

    for (const status of [401, 429, 503]) {
      await expect(client.complete({
        ...request,
        messages: [{ role: 'user', content: 'replay reliability boundary' }],
      })).rejects.toMatchObject({
        name: 'OpenRouterResponseError',
        status,
      });
    }

    await expect(client.complete({
      ...request,
      messages: [{ role: 'user', content: 'replay reliability boundary' }],
    })).rejects.toBeInstanceOf(OpenRouterConnectionError);
    await expect(client.complete({
      ...request,
      messages: [{ role: 'user', content: 'replay reliability boundary' }],
    })).rejects.toBeInstanceOf(OpenRouterConnectionError);

    await expect(client.complete({
      ...request,
      stream: true,
      messages: [{ role: 'user', content: 'replay reliability boundary' }],
    })).resolves.toMatchObject({
      content: '{"findings": [ ]}',
      usage: { prompt: 7, completion: 3, total: 10 },
      costUSD: 0.0042,
    });

    cassette.assertComplete();
    expect(cassette.observedFingerprints).toHaveLength(6);
    expect(JSON.stringify(cassette.interactions)).not.toContain('test-openrouter-key');
  });

  it.each([
    [401, 'unauthorized'],
    [429, 'rate limited'],
    [503, 'upstream unavailable'],
  ])('fails closed on OpenRouter HTTP %s without client-side retry', async (status, detail) => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: detail } }), {
      status,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new OpenRouterClient({ apiKey: 'test-openrouter-key', fetchImplementation });

    await expect(client.complete({ ...request, stream: false })).rejects.toMatchObject({
      name: 'OpenRouterResponseError',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed streaming frames instead of accepting partial JSON', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(
      'data: {"choices":[{"delta":{"content":"not-json"}}]\n\ndata: {broken}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ));
    const client = new OpenRouterClient({ apiKey: 'test-openrouter-key', fetchImplementation });

    await expect(client.complete({ ...request, stream: true })).rejects.toThrow('malformed streaming JSON');
  });

  it('fails closed when the first streamed chunk exceeds the TTFT deadline', async () => {
    const stalledStream = new ReadableStream({
      start() {},
      cancel() {},
    });
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(stalledStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const client = new OpenRouterClient({ apiKey: 'test-openrouter-key', fetchImplementation });

    await expect(client.complete({
      ...request,
      stream: true,
      timeoutMs: 500,
      ttftTimeoutMs: 10,
    })).rejects.toThrow(OpenRouterTimeoutError);
  });

  it('does not count SSE keepalives as first data for TTFT', async () => {
    const keepaliveOnlyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
      },
      cancel() {},
    });
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(keepaliveOnlyStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const client = new OpenRouterClient({ apiKey: 'test-openrouter-key', fetchImplementation });

    await expect(client.complete({
      ...request,
      stream: true,
      timeoutMs: 500,
      ttftTimeoutMs: 10,
    })).rejects.toMatchObject({
      name: 'OpenRouterTimeoutError',
      kind: 'ttft',
    });
  });

  it('cancels and aborts an active-delta stream at a deterministic total deadline', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let requestSignal: AbortSignal | null = null;
    try {
      const encoder = new TextEncoder();
      const activeStream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'data: {"choices":[{"delta":{"content":"active"}}]}\n\n',
          ));
          interval = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(
                'data: {"choices":[{"delta":{"content":" delta"}}]}\n\n',
              ));
            } catch {
              // The reader has been cancelled by the total deadline.
            }
          }, 5);
        },
        cancel() {
          cancelled = true;
          if (interval) clearInterval(interval);
        },
      });
      const fetchImplementation = vi.fn().mockImplementation((_input, init: RequestInit) => {
        requestSignal = init.signal ?? null;
        return Promise.resolve(new Response(activeStream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }));
      });
      const client = new OpenRouterClient({ apiKey: 'test-openrouter-key', fetchImplementation });
      const rejection = expect(client.complete({
        ...request,
        stream: true,
        timeoutMs: 50,
        ttftTimeoutMs: 20,
      })).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        kind: 'total',
      });

      // Let fetch resolve and the first active delta enter the reader before advancing the clock.
      await vi.advanceTimersByTimeAsync(0);
      expect(requestSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      await rejection;

      expect(requestSignal?.aborted).toBe(true);
      expect(cancelled).toBe(true);
    } finally {
      if (interval) clearInterval(interval);
      vi.useRealTimers();
    }
  });

  it('does not wait indefinitely when a timed-out reader ignores cancellation', async () => {
    let cancelCalled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const activeStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}\n\n',
        ));
        interval = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(
              'data: {"choices":[{"delta":{"reasoning":" still thinking"}}]}\n\n',
            ));
          } catch {
            // The reader has already been detached; cleanup below stops the fixture.
          }
        }, 2);
      },
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => {});
      },
    });
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(activeStream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));
    const client = new OpenRouterClient({ apiKey: 'test-openrouter-key', fetchImplementation });
    const started = Date.now();

    try {
      await expect(client.complete({
        ...request,
        stream: true,
        timeoutMs: 35,
        ttftTimeoutMs: 20,
      })).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        kind: 'total',
      });
      expect(cancelCalled).toBe(true);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      if (interval) clearInterval(interval);
    }
  });

  it.each([
    ['usage.total_cost', { total_cost: '0.0081' }, 0.0081],
    ['usage.cost_details.upstream_inference_cost', { cost_details: { upstream_inference_cost: '0.0092' } }, 0.0092],
  ])('uses %s when OpenRouter reports cost outside data.cost', async (_label, usage, expectedCost) => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: 'openai/gpt-5.6-luna',
      choices: [{ message: { role: 'assistant', content: 'SHIP' } }],
      usage,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new OpenRouterClient({
      baseUrl: 'https://openrouter.test/api/v1',
      apiKey: 'test-openrouter-key',
      fetchImplementation,
    });

    await expect(client.complete({ ...request, stream: false })).resolves.toMatchObject({
      costUSD: expectedCost,
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

describe('Dynamic Model Context Window Discovery & Budget Calculation', () => {
  describe('getStaticModelMetadata (Offline Fallbacks)', () => {
    it('resolves DeepSeek V4 Flash variants to 128,000 context tokens', () => {
      const low = getStaticModelMetadata('deepseek/deepseek-v4-flash-0731:low');
      expect(low.contextLength).toBe(128_000);
      expect(low.contextTokens).toBe(128_000);
      expect(low.supportsReasoning).toBe(true);

      const high = getStaticModelMetadata('deepseek/deepseek-v4-flash-0731:high');
      expect(high.contextLength).toBe(128_000);

      const fireworks = getStaticModelMetadata('accounts/fireworks/models/deepseek-v4-flash-0731');
      expect(fireworks.contextLength).toBe(128_000);
    });

    it('resolves OpenRouter 5.6-Luna variants to 128,000 context tokens', () => {
      const luna = getStaticModelMetadata('openrouter/5.6-luna-high');
      expect(luna.contextLength).toBe(128_000);
      expect(luna.promptCostPer1M).toBe(2.0);
      expect(luna.completionCostPer1M).toBe(6.0);

      const gptLuna = getStaticModelMetadata('openai/gpt-5.6-luna');
      expect(gptLuna.contextLength).toBe(128_000);
    });

    it('resolves Qwen models to 128,000 context tokens', () => {
      const qwenHigh = getStaticModelMetadata('qwen/qwen-3.8-27b:high');
      expect(qwenHigh.contextLength).toBe(128_000);

      const qwenCoder = getStaticModelMetadata('qwen/qwen-2.5-72b-instruct');
      expect(qwenCoder.contextLength).toBe(128_000);
    });

    it('resolves Google Gemini Flash models to 1,048,576 (1M) context tokens', () => {
      const gemini37 = getStaticModelMetadata('google/gemini-3.7-flash:high');
      expect(gemini37.contextLength).toBe(1_048_576);
      expect(gemini37.contextTokens).toBe(1_048_576);

      const gemini25 = getStaticModelMetadata('google/gemini-2.5-flash');
      expect(gemini25.contextLength).toBe(1_048_576);
    });

    it('resolves Google Gemini Pro models to 2,097,152 (2M) context tokens', () => {
      const gemini25Pro = getStaticModelMetadata('google/gemini-2.5-pro');
      expect(gemini25Pro.contextLength).toBe(2_097_152);

      const gemini15Pro = getStaticModelMetadata('google/gemini-1.5-pro');
      expect(gemini15Pro.contextLength).toBe(2_097_152);
    });

    it('resolves Anthropic Claude models to 200,000 context tokens', () => {
      const sonnet = getStaticModelMetadata('anthropic/claude-3.7-sonnet');
      expect(sonnet.contextLength).toBe(200_000);

      const opus = getStaticModelMetadata('anthropic/claude-opus-4.8');
      expect(opus.contextLength).toBe(200_000);
    });

    it('resolves OpenAI GPT-4o models to 128,000 context tokens', () => {
      const gpt4o = getStaticModelMetadata('openai/gpt-4o');
      expect(gpt4o.contextLength).toBe(128_000);

      const gpt4oMini = getStaticModelMetadata('openai/gpt-4o-mini');
      expect(gpt4oMini.contextLength).toBe(128_000);
    });

    it('provides default fallback metadata (128,000 tokens) for unknown models', () => {
      const unknown = getStaticModelMetadata('custom-org/some-unknown-model-v1');
      expect(unknown.contextLength).toBe(128_000);
      expect(unknown.contextTokens).toBe(128_000);
      expect(unknown.supportsTools).toBe(true);
    });
  });

  describe('calculateSafeDiffCapacity', () => {
    it('calculates C_safe for 128k context model (DeepSeek V4 Flash / Luna / Qwen)', () => {
      // (128,000 - 4,000 - 16,000) * 3.8 = 108,000 * 3.8 = 410,400 chars
      const cap = calculateSafeDiffCapacity('deepseek/deepseek-v4-flash-0731:low');
      expect(cap.contextTokens).toBe(128_000);
      expect(cap.usableDiffTokens).toBe(108_000);
      expect(cap.safeDiffChars).toBe(410_400);
      expect(cap.systemPromptTokens).toBe(4_000);
      expect(cap.toolReserveTokens).toBe(16_000);
      expect(Number(cap)).toBe(410_400);
      expect(+cap).toBe(410_400);
      expect(cap > 24_000).toBe(true);
    });

    it('calculates C_safe for 1M context model (Gemini 3.7 Flash)', () => {
      // (1,048,576 - 20,000) * 3.8 = 1,028,576 * 3.8 = 3,908,588.8 -> 3,908,588 chars
      const cap = calculateSafeDiffCapacity('google/gemini-3.7-flash:high');
      expect(cap.contextTokens).toBe(1_048_576);
      expect(cap.usableDiffTokens).toBe(1_028_576);
      expect(cap.safeDiffChars).toBe(3_908_588);
    });

    it('calculates C_safe for 2M context model (Gemini 2.5 Pro)', () => {
      // (2,097,152 - 20,000) * 3.8 = 2,077,152 * 3.8 = 7,893,177.6 -> 7,893,177 chars
      const cap = calculateSafeDiffCapacity('google/gemini-2.5-pro');
      expect(cap.contextTokens).toBe(2_097_152);
      expect(cap.usableDiffTokens).toBe(2_077_152);
      expect(cap.safeDiffChars).toBe(7_893_177);
    });

    it('calculates C_safe for 200k context model (Claude 3.7 Sonnet)', () => {
      // (200,000 - 20,000) * 3.8 = 180,000 * 3.8 = 684,000 chars
      const cap = calculateSafeDiffCapacity('anthropic/claude-3.7-sonnet');
      expect(cap.contextTokens).toBe(200_000);
      expect(cap.usableDiffTokens).toBe(180_000);
      expect(cap.safeDiffChars).toBe(684_000);
    });

    it('accepts raw context token numbers and custom options', () => {
      const cap = calculateSafeDiffCapacity(200_000, {
        systemPromptTokens: 2_000,
        toolReserveTokens: 8_000,
        charsPerToken: 4.0,
      });
      // (200,000 - 10,000) * 4.0 = 190,000 * 4.0 = 760,000
      expect(cap.usableDiffTokens).toBe(190_000);
      expect(cap.safeDiffChars).toBe(760_000);
    });
  });

  describe('resolveModelMetadata (API Discovery & Caching)', () => {
    it('fetches metadata dynamically from OpenRouter /models endpoint', async () => {
      clearModelMetadataCache();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'deepseek/deepseek-v4-flash-0731',
                name: 'DeepSeek V4 Flash Online',
                context_length: 131072,
                pricing: { prompt: '0.00000014', completion: '0.00000028' },
                top_provider: { context_length: 131072, max_completion_tokens: 8192 },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      const meta = await resolveModelMetadata('deepseek/deepseek-v4-flash-0731:low', 'test-api-key', {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
      });

      expect(meta.id).toBe('deepseek/deepseek-v4-flash-0731:low');
      expect(meta.contextLength).toBe(131072);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://openrouter.test/api/v1/models',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('uses 1-hour TTL in-memory cache without repeating HTTP calls', async () => {
      clearModelMetadataCache();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'google/gemini-3.7-flash',
                name: 'Google Gemini 3.7 Flash',
                context_length: 1048576,
                pricing: { prompt: '0.00000015', completion: '0.00000060' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      const meta1 = await resolveModelMetadata('google/gemini-3.7-flash', 'test-api-key', {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
      });
      const meta2 = await resolveModelMetadata('google/gemini-3.7-flash', 'test-api-key', {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
      });

      expect(meta1.contextLength).toBe(1048576);
      expect(meta2.contextLength).toBe(1048576);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Cached on second call
    });

    it('deduplicates concurrent in-flight requests (single-flight)', async () => {
      clearModelMetadataCache();
      let resolveFetch: (val: any) => void;
      const delayedPromise = new Promise((resolve) => {
        resolveFetch = resolve;
      });
      const mockFetch = vi.fn().mockImplementation(() => delayedPromise);

      const p1 = resolveModelMetadata('openrouter/5.6-luna-high', 'test-key', {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
      });
      const p2 = resolveModelMetadata('openrouter/5.6-luna-high', 'test-key', {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
      });

      resolveFetch!(
        new Response(
          JSON.stringify({
            data: [{ id: 'openai/gpt-5.6-luna', context_length: 128000 }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      );

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1.contextLength).toBe(128000);
      expect(res2.contextLength).toBe(128000);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('gracefully degrades to static offline fallback when OpenRouter returns 500 error', async () => {
      clearModelMetadataCache();
      const mockFetch = vi.fn().mockResolvedValue(
        new Response('Internal Server Error', { status: 500 })
      );

      const meta = await resolveModelMetadata('google/gemini-2.5-pro', 'test-key', {
        baseUrl: 'https://openrouter.test/api/v1',
        fetchImplementation: mockFetch,
      });

      expect(meta.contextLength).toBe(2_097_152); // Fallback to static table
    });

    it('gracefully degrades to static offline fallback when no API key is provided', async () => {
      clearModelMetadataCache();
      const prevKey = process.env.OPENROUTER_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      try {
        const mockFetch = vi.fn();
        const meta = await resolveModelMetadata('anthropic/claude-3.7-sonnet', '', {
          fetchImplementation: mockFetch,
        });
        expect(meta.contextLength).toBe(200_000);
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        if (prevKey) process.env.OPENROUTER_API_KEY = prevKey;
      }
    });
  });
});
