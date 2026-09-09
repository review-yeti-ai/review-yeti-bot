import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoritativeReviewServiceOptions } from '../../src/review/authoritativeReviewService';

const mocks = vi.hoisted(() => {
  const pool = { query: vi.fn() };
  const initialize = vi.fn(async () => undefined);
  const listen = vi.fn(() => ({ close: vi.fn() }));
  const createApp = vi.fn((_options: unknown) => ({ listen }));
  const repository = vi.fn(function () {});
  const gateStorage = { recordWorkerResult: vi.fn(), claimPublication: vi.fn(), publishLocked: vi.fn(),
    retryPublication: vi.fn(), reapTerminalAttempts: vi.fn(), advanceProjectedAttempts: vi.fn() };
  const gateRepository = vi.fn(function (_pool: unknown, _options: unknown) { return gateStorage; });
  const getPrepared = vi.fn(async (_pool: unknown, _digest: string) => null);
  const validateAdmission = vi.fn(async () => undefined);
  const authoritative = vi.fn((_options: AuthoritativeReviewServiceOptions) =>
    ({ admission: {}, completion: {}, runOnce: vi.fn(async () => undefined), validateAdmission }));
  const serviceConfig = vi.fn<() => { tickMs: number } | undefined>(() => undefined);
  const lookup = vi.fn(async () => 987);
  const error = vi.fn();
  return { pool, initialize, listen, createApp, repository, gateStorage, gateRepository, getPrepared,
    validateAdmission, authoritative, serviceConfig, lookup, error };
});

vi.mock('../../src/auth/githubActionsOidc', () => ({
  githubActionsOidcPolicyFromEnv: () => ({ allowAppGate: true }),
  GitHubActionsOidcVerifier: class {},
}));
vi.mock('../../src/dispatchServer', () => ({ createActionDispatchApp: mocks.createApp }));
vi.mock('../../src/api/actionDispatchApi', () => ({ createWorkerCompletionVerifier: vi.fn() }));
vi.mock('../../src/persistence/postgresStore', () => ({
  PostgresStore: class { initialize = mocks.initialize; getPool = () => mocks.pool; close = vi.fn(); },
}));
vi.mock('../../src/persistence/reviewDispatchRepository', () => ({ PostgresReviewDispatchRepository: mocks.repository }));
vi.mock('../../src/persistence/reviewGateRepository', () => ({ PostgresReviewGateRepository: mocks.gateRepository }));
vi.mock('../../src/persistence/preparedReviewRepository', () => ({ getPreparedPublishingPolicy: mocks.getPrepared }));
vi.mock('../../src/review/abandonedRunReaper', () => ({ AbandonedRunReaper: class { runOnce = vi.fn(); } }));
vi.mock('../../src/github/installationClient', () => ({ GitHubInstallationClient: class {} }));
vi.mock('../../src/github/appAuth', () => ({ getGitHubAppRepositoryPublishToken: vi.fn() }));
vi.mock('../../src/auth/authoritativeServiceConfig', () => ({ authoritativeServiceConfigFromEnv: mocks.serviceConfig }));
vi.mock('../../src/review/authoritativeReviewService', () => ({ createAuthoritativeReviewService: mocks.authoritative }));
vi.mock('../../src/utils/logger', () => ({ logger: { error: mocks.error, info: vi.fn() } }));
vi.mock('../../src/github/boundedAppToken', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/github/boundedAppToken')>(),
  getBoundedRepositoryInstallationId: mocks.lookup,
}));

describe('Action dispatch startup transport and admission wiring', () => {
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
    vi.resetModules();
    vi.clearAllMocks();
    mocks.serviceConfig.mockReturnValue(undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(process, 'once').mockReturnValue(process);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected network call'); }));
    vi.stubEnv('ACTION_DISPATCH_ENABLED', 'true');
    vi.stubEnv('GITHUB_APP_ID', '4385771');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'synthetic-startup-private-key');
    vi.stubEnv('HOSTNAME', 'startup-test');
    vi.stubEnv('GITHUB_API_BASE_URL', undefined);
    vi.stubEnv('ACTION_DISPATCH_REAPER_INTERVAL_MS', '60000');
    vi.stubEnv('PORT', '3000');
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.exitCode = exitCode;
  });

  async function start() {
    await import('../../src/dispatchIndex');
    await vi.dynamicImportSettled();
  }

  it.each(['', 'http://api.example.invalid', 'https://user:synthetic-secret@api.example.invalid',
    'https://api.example.invalid?', 'https://api.example.invalid#', ' https://api.example.invalid',
    'https://api.example.invalid/\nv3'])('rejects unsafe API base before initializing or listening: %j', async (baseUrl) => {
    vi.stubEnv('GITHUB_API_BASE_URL', baseUrl);
    await start();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.serviceConfig).not.toHaveBeenCalled();
    expect(mocks.authoritative).not.toHaveBeenCalled();
    expect(mocks.gateRepository).not.toHaveBeenCalled();
    expect(mocks.getPrepared).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('Action dispatch service failed to start', {
      error: 'GitHub App API base URL must be HTTPS without credentials, query, or fragment',
    });
    expect(process.exitCode).toBe(1);
  });

  it.each([undefined, 'https://api.example.invalid/api/v3/'])('wires only the bounded lookup for safe base %s', async (baseUrl) => {
    vi.stubEnv('GITHUB_API_BASE_URL', baseUrl);
    await start();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.listen).toHaveBeenCalledOnce();
    const options = mocks.createApp.mock.calls[0][0] as unknown as {
      resolveInstallationId(owner: string, repo: string): Promise<number>;
    };
    await expect(options.resolveInstallationId('calltelemetry', 'ct-meta')).resolves.toBe(987);
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith({
      appId: '4385771', privateKey: 'synthetic-startup-private-key', owner: 'calltelemetry', repo: 'ct-meta',
      baseUrl: baseUrl ? 'https://api.example.invalid/api/v3' : 'https://api.github.com',
    });
    expect(mocks.repository).toHaveBeenCalledWith(mocks.pool, undefined, undefined);
    expect(mocks.gateRepository).not.toHaveBeenCalled();
    expect(mocks.getPrepared).not.toHaveBeenCalled();
    expect(mocks.authoritative).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1); // Only the unchanged legacy reaper runs by default.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('composes bounded storage and prepared lookup, then passes the exact service validator into admission', async () => {
    const config = { tickMs: 1_000 };
    mocks.serviceConfig.mockReturnValue(config);
    await start();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.gateRepository).toHaveBeenCalledExactlyOnceWith(mocks.pool, { completionResolutionTimeoutMs: 15_000 });
    expect(mocks.authoritative).toHaveBeenCalledExactlyOnceWith({
      config, repository: mocks.gateStorage, getStoredPrepared: expect.any(Function), appId: '4385771',
      privateKey: 'synthetic-startup-private-key', baseUrl: 'https://api.github.com',
      workerId: 'authoritative-review-startup-test',
    });
    const options = mocks.authoritative.mock.calls[0][0];
    expect(options.repository).toBe(mocks.gateStorage);
    expect(mocks.getPrepared).not.toHaveBeenCalled();
    const digest = 'a'.repeat(64);
    await expect(options.getStoredPrepared(digest, new AbortController().signal)).resolves.toBeNull();
    expect(mocks.getPrepared).toHaveBeenCalledExactlyOnceWith(mocks.pool, digest);
    expect(mocks.initialize.mock.invocationCallOrder[0]).toBeLessThan(mocks.gateRepository.mock.invocationCallOrder[0]);
    expect(mocks.gateRepository.mock.invocationCallOrder[0]).toBeLessThan(mocks.authoritative.mock.invocationCallOrder[0]);
    expect(mocks.repository).toHaveBeenCalledExactlyOnceWith(mocks.pool, undefined, {
      validateAuthoritativeAdmission: mocks.validateAdmission,
    });
    expect(mocks.authoritative.mock.invocationCallOrder[0]).toBeLessThan(mocks.repository.mock.invocationCallOrder[0]);
    const service = mocks.authoritative.mock.results[0].value;
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      authoritativePublishing: service.admission, authoritativeWorkerCompletion: service.completion,
    }));
    expect(mocks.validateAdmission).not.toHaveBeenCalled();
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.runOnce).toHaveBeenCalledOnce();
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  it('does not construct the service or listen if composed gate storage fails', async () => {
    mocks.serviceConfig.mockReturnValue({ tickMs: 1_000 });
    mocks.gateRepository.mockImplementationOnce(() => { throw new Error('storage configuration invalid'); });
    await start();
    expect(mocks.authoritative).not.toHaveBeenCalled();
    expect(mocks.repository).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.getPrepared).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(process.exitCode).toBe(1);
  });
});
