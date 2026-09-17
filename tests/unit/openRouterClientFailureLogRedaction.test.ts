import { describe, it, expect, vi, beforeEach } from 'vitest';

// REL-892: `src/gateway/openRouterClient.ts` logs two raw provider-error tails without
// redaction before this change:
//   1. `completeInternal`'s transient-retry warn (~line 1766): "OpenRouter transient
//      failure, retrying in <ms>ms ..." carries `error.message` from a classified
//      transient gateway error (502/503/504). A provider or intermediate proxy can echo
//      request headers -- including an outbound bearer token -- back into that error
//      body.
//   2. `executeSingleAttempt`'s SDK-network-failure branch (~line 2112): "OpenRouter SDK
//      network failure or timeout" carries `sdkMessage` from a raw (non-HTTP-status)
//      transport failure, which can likewise echo a credential-shaped fragment appended
//      by the SDK's own error formatting.
// Both sites now redact through `redactWorkerFailureLogTail`. These tests drive each
// site through the real `OpenRouterClient.complete()` call path (never the redaction
// helper directly) and assert on the captured `logger` call arguments.
const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({ logger: mocks }));

import { OpenRouterClient, OpenRouterConnectionError } from '../../src/gateway/openRouterClient';

const SECRET_TOKEN = 'sk-TESTSECRETKEY1234567890ABCDEF';

// The transient-retry site (completeInternal) is exercised through the direct-fetch
// streaming path: the non-streaming path routes through the OpenRouter SDK client,
// which discards a non-2xx JSON body's message and substitutes its own generic
// "Response validation failed" text -- verified by hand while building this test --
// so it cannot carry the fixture's secret-shaped text through to the log line at all.
const streamingRequest = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user' as const, content: 'review this diff' }],
  timeoutMs: 1_000,
  stream: true,
};

// The SDK-network-failure site only fires on the non-streaming (SDK client) path --
// the streaming path's own fetch rejection is classified elsewhere.
const nonStreamingRequest = {
  model: 'openai/gpt-4o-mini',
  messages: [{ role: 'user' as const, content: 'review this diff' }],
  timeoutMs: 1_000,
  stream: false,
};

function findLogCall(mock: ReturnType<typeof vi.fn>, message: string): unknown[] {
  const call = mock.mock.calls.find((args) => typeof args[0] === 'string' && args[0].startsWith(message));
  if (!call) throw new Error(`logger call was never made with a message starting "${message}"`);
  return call;
}

function sseSuccessResponse(content: string): Response {
  const chunk = JSON.stringify({
    id: 'chatcmpl-replay',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'openai/gpt-4o-mini',
    choices: [{ index: 0, finish_reason: 'stop', delta: { content } }],
  });
  return new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function badGatewayResponse(): Response {
  return new Response(JSON.stringify({
    error: { message: `Bad Gateway upstream; token=Bearer ${SECRET_TOKEN}` },
  }), {
    status: 502,
    headers: { 'content-type': 'application/json' },
  });
}

describe('REL-892: OpenRouterClient transient-retry log redaction', () => {
  beforeEach(() => {
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.info.mockClear();
    mocks.debug.mockClear();
  });

  it('never emits the raw secret-shaped provider error text on a transient-retry warn', async () => {
    let callCount = 0;
    const fetchImplementation = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount === 1 ? badGatewayResponse() : sseSuccessResponse('RECOVERED'));
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new OpenRouterClient({
      apiKey: 'test-openrouter-key',
      fetchImplementation,
      sleep,
      maxRetries: 2,
    });

    const result = await client.complete(streamingRequest);
    expect(result.content).toBe('RECOVERED');
    expect(fetchImplementation).toHaveBeenCalledTimes(2);

    const [, meta] = findLogCall(mocks.warn, 'OpenRouter transient failure, retrying') as [string, Record<string, unknown>];
    const serializedMeta = JSON.stringify(meta);
    expect(serializedMeta).not.toContain(SECRET_TOKEN);
    expect(serializedMeta).not.toContain('Bearer');
  });

  it('preserves the HTTP status and gateway classification in the redacted transient-retry log line', async () => {
    let callCount = 0;
    const fetchImplementation = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount === 1 ? badGatewayResponse() : sseSuccessResponse('RECOVERED'));
    });
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new OpenRouterClient({
      apiKey: 'test-openrouter-key',
      fetchImplementation,
      sleep,
      maxRetries: 2,
    });

    await client.complete(streamingRequest);

    const [, meta] = findLogCall(mocks.warn, 'OpenRouter transient failure, retrying') as [string, Record<string, unknown>];
    // The bounded, non-secret classification (HTTP status + upstream reason) survives.
    expect(String(meta.error)).toContain('502');
    expect(String(meta.error)).toContain('Bad Gateway');
    expect(String(meta.error)).toContain('[REDACTED]');
  });
});

describe('REL-892: OpenRouterClient SDK network-failure log redaction', () => {
  beforeEach(() => {
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.info.mockClear();
    mocks.debug.mockClear();
  });

  it('never emits the raw secret-shaped SDK transport error text to the log sink', async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(
      new TypeError(`fetch failed: connect ECONNREFUSED; Authorization=Bearer ${SECRET_TOKEN}`),
    );
    const client = new OpenRouterClient({
      apiKey: 'test-openrouter-key',
      fetchImplementation,
      maxRetries: 0,
    });

    await expect(client.complete(nonStreamingRequest)).rejects.toBeInstanceOf(OpenRouterConnectionError);

    const [, meta] = findLogCall(mocks.error, 'OpenRouter SDK network failure or timeout') as [string, Record<string, unknown>];
    const serializedMeta = JSON.stringify(meta);
    expect(serializedMeta).not.toContain(SECRET_TOKEN);
    expect(serializedMeta).not.toContain('Bearer');
  });

  it('preserves the target model and a useful failure classification in the redacted SDK-failure log line', async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(
      new TypeError(`fetch failed: connect ECONNREFUSED; Authorization=Bearer ${SECRET_TOKEN}`),
    );
    const client = new OpenRouterClient({
      apiKey: 'test-openrouter-key',
      fetchImplementation,
      maxRetries: 0,
    });

    await expect(client.complete(nonStreamingRequest)).rejects.toBeInstanceOf(OpenRouterConnectionError);

    const [, meta] = findLogCall(mocks.error, 'OpenRouter SDK network failure or timeout') as [string, Record<string, unknown>];
    expect(meta.model).toBe('openai/gpt-4o-mini');
    expect(String(meta.error)).toContain('ECONNREFUSED');
    expect(String(meta.error)).toContain('[REDACTED]');
  });
});
