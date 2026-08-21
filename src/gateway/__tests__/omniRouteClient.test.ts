import { describe, it, expect, vi, afterEach } from 'vitest';
import { OmniRouteClient, GatewayConnectionError } from '../omniRouteClient';
import { logger } from '../../utils/logger';

describe('OmniRouteClient — Network Errors & Removal of Synthetic Offline Fallbacks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws GatewayConnectionError on simulated fetch network failure (ECONNREFUSED) and logs error', async () => {
    const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9090')));

    const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });

    let caughtError: any = null;
    try {
      await client.complete({
        model: 'codex/gpt-5.6-sol-high',
        messages: [{ role: 'user', content: 'CT_REVIEW_NONCE:test-nonce\nreview code' }],
        timeoutMs: 5000,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(GatewayConnectionError);
    expect(caughtError?.message).toContain('OmniRoute connection failure for model codex/gpt-5.6-sol-high');
    expect(caughtError?.message).toContain('ECONNREFUSED');
    expect(loggerSpy).toHaveBeenCalledWith('OmniRoute network failure or timeout', expect.objectContaining({
      model: 'codex/gpt-5.6-sol-high',
    }));
  });

  it('throws GatewayConnectionError on simulated request timeout / AbortError', async () => {
    const loggerSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError')));

    const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });

    await expect(
      client.complete({
        model: 'codex/gpt-5.6-sol-high',
        messages: [{ role: 'user', content: 'CT_REVIEW_NONCE:test-nonce\nreview code' }],
        timeoutMs: 100,
      })
    ).rejects.toThrow(GatewayConnectionError);

    expect(loggerSpy).toHaveBeenCalled();
  });

  it('throws HTTP error on non-200 HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ error: 'Service Unavailable' }),
    }));

    const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });

    await expect(
      client.complete({
        model: 'codex/gpt-5.6-sol-high',
        messages: [{ role: 'user', content: 'review' }],
        timeoutMs: 5000,
      })
    ).rejects.toThrow('OmniRoute HTTP 503');
  });

  it('legacy completion shim propagates GatewayConnectionError on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    const client = new OmniRouteClient({ baseUrl: 'http://127.0.0.1:9090' });

    await expect(
      client.completion({ provider: 'codex/gpt-5.6-sol-high', prompt: 'test' })
    ).rejects.toThrow(GatewayConnectionError);
  });
});
