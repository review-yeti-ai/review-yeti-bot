import { describe, it, expect, vi, beforeEach } from 'vitest';

// REL-892: `src/gateway/omniRouteClient.ts`'s `OmniRouteClient.complete()` logs a raw
// network-failure/timeout message when the underlying `fetch()` call rejects
// (`logger.error('OmniRoute network failure or timeout', { error: networkErr.message,
// model: request.model })`). `networkErr.message` comes straight from the fetch
// implementation and can echo back a credential-shaped fragment (for example, a proxy
// or SDK sometimes appends the outbound `Authorization` header verbatim to a
// connection-failure message). This test proves the log line now redacts that raw text
// through `redactWorkerFailureLogTail` while still telling an operator which model the
// failed request targeted.
const mocks = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({ logger: mocks }));

import { OmniRouteClient, OmniRouteConnectionError } from '../../src/gateway/omniRouteClient';

const SECRET_TOKEN = 'sk-TESTSECRETKEY1234567890ABCDEF';
const NETWORK_ERROR_MESSAGE = `OmniRoute fetch failed: connect ETIMEDOUT; Authorization=Bearer ${SECRET_TOKEN}`;

function findNetworkFailureCall(): unknown[] {
  const call = mocks.error.mock.calls.find((args) => args[0] === 'OmniRoute network failure or timeout');
  if (!call) throw new Error('logger.error was never called with "OmniRoute network failure or timeout"');
  return call;
}

describe('REL-892: OmniRouteClient network-failure log redaction', () => {
  beforeEach(() => {
    mocks.warn.mockClear();
    mocks.error.mockClear();
    mocks.info.mockClear();
    mocks.debug.mockClear();
  });

  it('never emits the raw secret-shaped fetch failure text to the log sink', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError(NETWORK_ERROR_MESSAGE));
    vi.stubGlobal('fetch', mockFetch);

    const client = new OmniRouteClient({ baseUrl: 'http://localhost:8080/', accessToken: 'omni-access-token-123' });

    await expect(client.complete({
      model: 'claude-5-sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      timeoutMs: 5000,
    })).rejects.toBeInstanceOf(OmniRouteConnectionError);

    const [, meta] = findNetworkFailureCall() as [string, Record<string, unknown>];
    const serializedMeta = JSON.stringify(meta);
    expect(serializedMeta).not.toContain(SECRET_TOKEN);
    expect(serializedMeta).not.toContain('Bearer');

    vi.unstubAllGlobals();
  });

  it('preserves the target model and a useful failure classification in the redacted log line', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError(NETWORK_ERROR_MESSAGE));
    vi.stubGlobal('fetch', mockFetch);

    const client = new OmniRouteClient({ baseUrl: 'http://localhost:8080/', accessToken: 'omni-access-token-123' });

    await expect(client.complete({
      model: 'claude-5-sonnet',
      messages: [{ role: 'user', content: 'Hello' }],
      timeoutMs: 5000,
    })).rejects.toBeInstanceOf(OmniRouteConnectionError);

    const [, meta] = findNetworkFailureCall() as [string, Record<string, unknown>];
    // Model identity: an operator must still be able to tell which model the failed
    // request targeted.
    expect(meta.model).toBe('claude-5-sonnet');
    // The redacted free-form remainder still carries the operationally useful part of
    // the message (what failed and why), just not the credential.
    expect(String(meta.error)).toContain('ETIMEDOUT');
    expect(String(meta.error)).toContain('[REDACTED]');

    vi.unstubAllGlobals();
  });
});
