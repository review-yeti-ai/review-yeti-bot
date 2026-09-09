import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getGitHubAppInstallationIdForRepository, getGitHubAppRepositoryReadToken, getGitHubAppRepositoryPublishToken, type GitHubRepositoryInstallationConfig } from '../../src/github/appAuth';

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const callers = [
  ['installation lookup', getGitHubAppInstallationIdForRepository, 1],
  ['read token', getGitHubAppRepositoryReadToken, 2],
  ['publish token', getGitHubAppRepositoryPublishToken, 2],
] as const;
const config = (signal?: AbortSignal): GitHubRepositoryInstallationConfig => ({ appId: '123456', privateKey, owner: 'example', repo: 'repo', signal });

describe.each(callers)('real %s cancellation', (_name, call, stages) => {
  it('still performs the intended request with a timeout when no caller signal is supplied', async () => {
    const permissions = _name === 'read token' ? { contents: 'read', pull_requests: 'read' } : { checks: 'write' };
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init!.signal!.aborted).toBe(false);
      return new Response(JSON.stringify(String(url).endsWith('/installation') ? { id: 987 } : { token: 'ghs_test', expires_at: '2099-01-01T00:00:00Z', permissions }));
    });
    const result = await call(config(), fetchFn);
    expect(result).toEqual(stages === 1 ? 987 : { token: 'ghs_test', expiresAt: '2099-01-01T00:00:00Z', permissions });
    expect(fetchFn).toHaveBeenCalledTimes(stages);
  });

  it('refuses an already-aborted caller before any fetch', async () => {
    const controller = new AbortController();
    const reason = new Error('ordinary cancellation');
    controller.abort(reason);
    const fetchFn = vi.fn<typeof fetch>();
    await expect(call(config(controller.signal), fetchFn)).rejects.toBe(reason);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  for (let stage = 1; stage <= stages; stage++) {
    it(`propagates an in-flight abort through the actual request signal at stage ${stage}`, async () => {
      const controller = new AbortController();
      const reason = new Error('ordinary cancellation');
      const reached = Promise.withResolvers<void>();
      let count = 0;
      // Only HTTP is replaced: a signal-aware deferred transport rejects on abort.
      // Dropping config.signal or forwarding only the timeout makes this test fail.
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
        if (++count < stage) return new Response(JSON.stringify({ id: 987 }));
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        const pending = Promise.withResolvers<Response>();
        init!.signal!.addEventListener('abort', () => pending.reject(init!.signal!.reason), { once: true });
        reached.resolve();
        return pending.promise;
      });
      const operation = call(config(controller.signal), fetchFn);
      const rejected = expect(operation).rejects.toBe(reason);
      await reached.promise;
      controller.abort(reason);
      await rejected;
      expect(fetchFn).toHaveBeenCalledTimes(stage);
    });
  }

  if (stages === 2) {
    it('does not mint when cancellation arrives after installation lookup', async () => {
      const controller = new AbortController();
      const reason = new Error('cancel before mint');
      const fetchFn = vi.fn<typeof fetch>(async () => {
        controller.abort(reason);
        return new Response(JSON.stringify({ id: 987 }));
      });
      await expect(call(config(controller.signal), fetchFn)).rejects.toBe(reason);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  }
});
