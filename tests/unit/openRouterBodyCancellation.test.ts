import { describe, expect, it, vi } from 'vitest';
import { OpenRouterClient } from '../../src/gateway/openRouterClient';

const request = {
  model: 'fixture-model',
  messages: [{ role: 'user' as const, content: 'Synthetic pending-body fixture.' }],
  timeoutMs: 5_000,
};

const successfulCompletion = {
  id: 'chatcmpl-body-release',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'fixture-model',
  choices: [{
    index: 0,
    finish_reason: 'stop',
    message: { role: 'assistant', content: 'BODY_OK' },
  }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
};

function pendingBody() {
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let readStarted = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sourceController = controller;
    },
    pull() {
      readStarted = true;
      // Keep the JSON document incomplete so response.json()/response.text() remains pending.
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    body,
    get readStarted() {
      return readStarted;
    },
    get cancelled() {
      return cancelled;
    },
    cleanup() {
      try {
        sourceController?.error(new Error('pending-body fixture cleanup'));
      } catch (_) {
        // The client may already have cancelled and released the body.
      }
    },
  };
}

describe('OpenRouter non-SSE body cancellation', () => {
  it.each([
    { transport: 'direct', stream: true },
    { transport: 'SDK', stream: false },
  ])('parses a successful $transport JSON response and releases its body', async ({ stream }) => {
    const response = new Response(JSON.stringify(successfulCompletion), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetchImplementation = vi.fn().mockResolvedValue(response);
    const client = new OpenRouterClient({ apiKey: 'synthetic-key', fetchImplementation });

    await expect(client.complete({ ...request, stream })).resolves.toMatchObject({
      model: 'fixture-model',
      content: 'BODY_OK',
      usage: { prompt: 2, completion: 1, total: 3 },
    });
    expect(response.body?.locked).toBe(false);
  });

  it('cancels and releases a pending direct application/json body on caller abort', async () => {
    const fixture = pendingBody();
    const response = new Response(fixture.body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetchImplementation = vi.fn().mockImplementation((_input: string, _init: RequestInit) => {
      // Deliberately ignore the signal and return a response whose body read never completes.
      return Promise.resolve(response);
    });
    const client = new OpenRouterClient({ apiKey: 'synthetic-key', fetchImplementation });
    const controller = new AbortController();

    try {
      const pending = client.complete({
        ...request,
        stream: true,
        signal: controller.signal,
      });
      await vi.waitFor(() => {
        expect(fixture.readStarted).toBe(true);
        expect(fixture.body.locked).toBe(true);
      });

      controller.abort();
      await expect(pending).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        kind: 'request',
      });
      await vi.waitFor(() => {
        expect(fixture.cancelled).toBe(true);
        expect(fixture.body.locked).toBe(false);
      });
    } finally {
      fixture.cleanup();
      await Promise.resolve();
    }
  });

  it('cancels and releases a pending SDK application/json body on caller abort', async () => {
    const fixture = pendingBody();
    const response = new Response(fixture.body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const fetchImplementation = vi.fn().mockImplementation((_input: string, _init: RequestInit) => {
      // The SDK adapter calls response.text(); this response intentionally never completes.
      return Promise.resolve(response);
    });
    const client = new OpenRouterClient({ apiKey: 'synthetic-key', fetchImplementation });
    const controller = new AbortController();

    try {
      const pending = client.complete({
        ...request,
        stream: false,
        signal: controller.signal,
      });
      await vi.waitFor(() => {
        expect(fixture.readStarted).toBe(true);
        expect(fixture.body.locked).toBe(true);
      });

      controller.abort();
      await expect(pending).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        kind: 'request',
      });
      await vi.waitFor(() => {
        expect(fixture.cancelled).toBe(true);
        expect(fixture.body.locked).toBe(false);
      });
    } finally {
      fixture.cleanup();
      await Promise.resolve();
    }
  });

  it('cancels and releases a pending direct HTTP-error body on caller abort', async () => {
    const fixture = pendingBody();
    const response = new Response(fixture.body, {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
    const fetchImplementation = vi.fn().mockResolvedValue(response);
    const client = new OpenRouterClient({ apiKey: 'synthetic-key', fetchImplementation });
    const controller = new AbortController();

    try {
      const pending = client.complete({
        ...request,
        stream: true,
        signal: controller.signal,
      });
      await vi.waitFor(() => {
        expect(fixture.readStarted).toBe(true);
        expect(fixture.body.locked).toBe(true);
      });

      controller.abort();
      await expect(pending).rejects.toMatchObject({
        name: 'OpenRouterTimeoutError',
        kind: 'request',
      });
      await vi.waitFor(() => {
        expect(fixture.cancelled).toBe(true);
        expect(fixture.body.locked).toBe(false);
      });
    } finally {
      fixture.cleanup();
      await Promise.resolve();
    }
  });
});
