import { describe, expect, it } from 'vitest';
import path from 'path';

const pipeline = require(path.resolve(
  __dirname,
  '../../.github/workflows/pipelines/review-pipeline.js',
));

describe('OpenRouter SDK stream cleanup', () => {
  it('cancels both response tee branches without waiting on upstream cancellation', async () => {
    let sourceCancelled = false;
    const encoder = new TextEncoder();
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode([
          'data: {"id":"generation","model":"deepseek/deepseek-v4-flash-0731","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"findings\\":[]}"},"finish_reason":null}]}',
          '',
        ].join('\n')));
      },
      cancel() {
        sourceCancelled = true;
        return new Promise(() => {});
      },
    });

    const result = await pipeline.callOpenRouterSdk({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      requestBody: {
        model: 'deepseek/deepseek-v4-flash-0731',
        messages: [{ role: 'user', content: 'Review this diff.' }],
        stream: true,
      },
      fetchImpl: async () => new Response(source, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
      signal: new AbortController().signal,
    });

    const reader = result.response.body.getReader();
    await Promise.race([
      reader.cancel('review deadline reached'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancel did not settle')), 100)),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sourceCancelled).toBe(true);
  });
});
