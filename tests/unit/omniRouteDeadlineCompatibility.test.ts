import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmniRouteClient, type OmniRouteRequest } from '../../src/gateway/omniRouteClient';

type DeadlineRequest = OmniRouteRequest & {
  inactivityTimeoutMs?: number;
  signal?: AbortSignal;
};

const makeRequest = (overrides: Partial<DeadlineRequest> = {}): DeadlineRequest => ({
  model: 'synthetic/model',
  messages: [{ role: 'user', content: 'Synthetic timeout compatibility fixture.' }],
  timeoutMs: 5_000,
  ...overrides,
});

function pendingFetch() {
  let capturedSignal: AbortSignal | undefined;
  let rejectPending: ((reason?: unknown) => void) | undefined;
  const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    capturedSignal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      rejectPending = reject;
    });
  });

  return {
    fetchImplementation,
    get signal() {
      return capturedSignal;
    },
    reject(reason: unknown = new Error('compatibility fixture cleanup')) {
      rejectPending?.(reason);
    },
  };
}

describe('OmniRoute legacy deadline compatibility', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('aborts the injected transport at the finite provider cap before a long total budget', async () => {
    const fixture = pendingFetch();
    vi.stubGlobal('fetch', fixture.fetchImplementation);
    const startedAt = Date.now();
    const completion = new OmniRouteClient({ baseUrl: 'http://omniroute.test', accessToken: 'test-token' }).complete(
      makeRequest({ timeoutMs: 5_000, inactivityTimeoutMs: 35 }),
    );

    try {
      await vi.waitFor(() => {
        expect(fixture.signal).toBeInstanceOf(AbortSignal);
        expect(fixture.signal?.aborted).toBe(true);
      }, { timeout: 750, interval: 5 });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      fixture.reject();
      await completion.catch(() => undefined);
    }
  });

  it('propagates caller cancellation through the transport signal', async () => {
    const fixture = pendingFetch();
    vi.stubGlobal('fetch', fixture.fetchImplementation);
    const caller = new AbortController();
    const completion = new OmniRouteClient({ baseUrl: 'http://omniroute.test', accessToken: 'test-token' }).complete(
      makeRequest({ timeoutMs: 5_000, inactivityTimeoutMs: 5_000, signal: caller.signal }),
    );

    try {
      await vi.waitFor(() => expect(fixture.signal).toBeInstanceOf(AbortSignal));
      expect(fixture.signal?.aborted).toBe(false);
      caller.abort();
      await vi.waitFor(() => expect(fixture.signal?.aborted).toBe(true), { timeout: 250, interval: 5 });
      fixture.reject();
      await expect(completion).rejects.toBeInstanceOf(Error);
    } finally {
      fixture.reject();
      await completion.catch(() => undefined);
    }
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 5_000])(
    'does not let invalid or larger inactivityTimeoutMs=%s widen the total deadline',
    async (inactivityTimeoutMs) => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      const fixture = pendingFetch();
      vi.stubGlobal('fetch', fixture.fetchImplementation);
      const completion = new OmniRouteClient({ baseUrl: 'http://omniroute.test', accessToken: 'test-token' }).complete(
        makeRequest({ timeoutMs: 80, inactivityTimeoutMs }),
      );

      try {
        await vi.waitFor(() => expect(fixture.signal).toBeInstanceOf(AbortSignal));
        expect(timeout).toHaveBeenCalledWith(80);
        await vi.waitFor(() => expect(fixture.signal?.aborted).toBe(true), { timeout: 500, interval: 5 });
      } finally {
        fixture.reject();
        await completion.catch(() => undefined);
      }
    },
  );
});
