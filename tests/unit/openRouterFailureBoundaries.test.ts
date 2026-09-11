import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenRouterClient,
  OpenRouterConnectionError,
  OpenRouterTimeoutError,
} from '../../src/gateway/openRouterClient';

const request = {
  model: 'fixture-model',
  messages: [{ role: 'user' as const, content: 'Synthetic failure-boundary fixture.' }],
  stream: true,
  timeoutMs: 50,
};

afterEach(() => vi.useRealTimers());

describe('OpenRouter transport failure boundaries', () => {
  it('settles at the total deadline even when initial fetch ignores AbortSignal', async () => {
    vi.useFakeTimers();
    let resolveFetch!: (response: Response) => void;
    const fetchImplementation = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    const client = new OpenRouterClient({ apiKey: 'synthetic-key', fetchImplementation });
    let settled = false;
    let failure: unknown;
    const pending = client.complete(request).then(
      () => { settled = true; },
      (error: unknown) => { settled = true; failure = error; },
    );

    try {
      await vi.advanceTimersByTimeAsync(60);
      expect(fetchImplementation).toHaveBeenCalledOnce();
      expect(settled).toBe(true);
      expect(failure).toBeInstanceOf(OpenRouterTimeoutError);
      expect(failure).toMatchObject({ kind: 'request' });
    } finally {
      // Release even the defective implementation; the red test must not
      // leave a pending transport or rely on the test runner's own timeout.
      resolveFetch(new Response('data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }));
      await pending;
    }
  });

  it('preserves a stream connection reset as a connection failure, not a timeout', async () => {
    const reset = new Error('ECONNRESET synthetic stream fixture');
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(reset); } });
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }));
    const client = new OpenRouterClient({ apiKey: 'synthetic-key', fetchImplementation });
    const failure = await client.complete({ ...request, timeoutMs: 1_000 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OpenRouterConnectionError);
    expect(failure).not.toBeInstanceOf(OpenRouterTimeoutError);
    expect(failure).toMatchObject({ message: expect.stringContaining('ECONNRESET') });
  });

  it('bounds SDK startup when its fetch implementation ignores AbortSignal', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'synthetic-warmup', object: 'chat.completion', created: 1,
        model: 'fixture-model', system_fingerprint: null,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ready' } }],
      }), { headers: { 'content-type': 'application/json' } }))
      .mockImplementation(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const client = new OpenRouterClient({ apiKey: 'synthetic-key', fetchImplementation });
    // Exclude cold module loading from this transport-specific regression.
    await client.complete({ ...request, stream: false, timeoutMs: 2_000 });
    fetchImplementation.mockClear();
    let settled = false;
    let failure: unknown;
    const pending = client.complete({ ...request, stream: false, timeoutMs: 100 }).then(
      () => { settled = true; },
      (error: unknown) => { settled = true; failure = error; },
    );

    try {
      await vi.waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(true);
      expect(failure).toBeInstanceOf(OpenRouterTimeoutError);
      expect(failure).toMatchObject({ kind: 'request' });
    } finally {
      resolveFetch?.(new Response('data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }));
      await pending;
    }
  });
});
