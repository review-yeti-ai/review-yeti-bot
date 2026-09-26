import { describe, it, expect, vi, beforeEach } from 'vitest';

// REL-1138: a lane/arbiter/moderator call that dies on transport used to log only
// "fetch failed" / "terminated". The undici cause (connect timeout, socket closed) was
// dropped, so ct-infrastructure#834 could not be diagnosed. These drive the real
// OpenRouterClient.complete() path and assert on the captured logger calls.
const mocks = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({ logger: mocks }));

import { OpenRouterClient, OpenRouterConnectionError } from '../../src/gateway/openRouterClient';

const SECRET = 'sk-CAUSESECRET1234567890ABCDEF';

function connectTimeout(): TypeError {
  const cause = Object.assign(
    new Error('Connect Timeout Error (attempted address: 10.245.1.7:443, timeout: 10000ms)'),
    { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT', body: `request body with ${SECRET}` },
  );
  return new TypeError('fetch failed', { cause });
}

function request(stream: boolean, persona = 'arch-lane') {
  return { model: 'openai/gpt-4o-mini', messages: [{ role: 'user' as const, content: 'review this diff' }], timeoutMs: 1_000, stream, persona };
}

function failureLog(): Record<string, unknown> {
  const call = mocks.error.mock.calls.find((args) => args[0] === 'OpenRouter SDK network failure or timeout');
  if (!call) throw new Error('SDK network failure log was never emitted');
  return call[1] as Record<string, unknown>;
}

describe('REL-1138 OpenRouterClient transport-failure cause', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockClear();
  });

  it.each([true, false])('logs the undici code and the role for a "fetch failed" connect timeout (stream=%s)', async (stream) => {
    const client = new OpenRouterClient({ apiKey: 'k', fetchImplementation: vi.fn().mockRejectedValue(connectTimeout()), maxRetries: 0 });
    const error = await client.complete(request(stream)).catch((e) => e);
    expect(error).toBeInstanceOf(OpenRouterConnectionError);

    const meta = failureLog();
    expect(meta.persona).toBe('arch-lane');
    expect(meta.errorCauseCode).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(JSON.stringify(meta.errorCause)).toContain('attempted address: 10.245.1.7:443');
  });

  it('logs UND_ERR_SOCKET for a stream cut mid-response ("terminated")', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"x","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n'));
      },
      pull(controller) {
        const cause = Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' });
        controller.error(new TypeError('terminated', { cause }));
      },
    });
    const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const client = new OpenRouterClient({ apiKey: 'k', fetchImplementation: vi.fn().mockResolvedValue(response), maxRetries: 0 });

    const error = await client.complete(request(true, 'arbiter')).catch((e) => e);
    expect(error).toBeInstanceOf(OpenRouterConnectionError);
    const meta = failureLog();
    expect(meta.persona).toBe('arbiter');
    expect(meta.error).toBe('terminated');
    expect(meta.errorCauseCode).toBe('UND_ERR_SOCKET');
  });

  it('carries a sanitized causeChain on the thrown error, never the raw cause object', async () => {
    const client = new OpenRouterClient({ apiKey: 'k', fetchImplementation: vi.fn().mockRejectedValue(connectTimeout()), maxRetries: 0 });
    const error = await client.complete(request(true)).catch((e) => e) as OpenRouterConnectionError;
    expect(error.causeChain?.map((entry) => entry.code).filter(Boolean)).toEqual(['UND_ERR_CONNECT_TIMEOUT']);
    expect((error as any).cause).toBeUndefined();
    expect(JSON.stringify(error.causeChain)).not.toContain(SECRET);
    expect(JSON.stringify(failureLog())).not.toContain(SECRET);
  });

  it('logs only the top error, and no cause code, when the failure has no cause', async () => {
    const client = new OpenRouterClient({ apiKey: 'k', fetchImplementation: vi.fn().mockRejectedValue(new TypeError('fetch failed')), maxRetries: 0 });
    await client.complete(request(true)).catch(() => undefined);
    const meta = failureLog();
    expect(meta.errorCauseCode).toBeUndefined();
    expect(meta.errorCause).toEqual([{ depth: 0, name: 'TypeError', message: 'fetch failed' }]);
  });
});
