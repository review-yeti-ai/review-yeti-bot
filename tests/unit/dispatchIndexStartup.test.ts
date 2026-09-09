import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const pool = { query: vi.fn() };
  const initialize = vi.fn(async () => undefined);
  const listen = vi.fn(() => ({ close: vi.fn() }));
  const createApp = vi.fn((_options: unknown) => ({ listen }));
  const repository = vi.fn(function () {});
  const validateAdmission = vi.fn(async () => undefined);
  const authoritative = vi.fn(() => ({ admission: {}, completion: {}, runOnce: vi.fn(), validateAdmission }));
  const serviceConfig = vi.fn<() => { tickMs: number } | undefined>(() => undefined);
  const lookup = vi.fn(async () => 987);
  const error = vi.fn();
  return { pool, initialize, listen, createApp, repository, validateAdmission, authoritative, serviceConfig, lookup, error };
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
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('constructs the authoritative service first and passes its validator directly into repository options', async () => {
    mocks.serviceConfig.mockReturnValue({ tickMs: 1_000 });
    await start();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.authoritative).toHaveBeenCalledOnce();
    expect(mocks.repository).toHaveBeenCalledExactlyOnceWith(mocks.pool, undefined, {
      validateAuthoritativeAdmission: mocks.validateAdmission,
    });
    expect(mocks.authoritative.mock.invocationCallOrder[0]).toBeLessThan(mocks.repository.mock.invocationCallOrder[0]);
    expect(mocks.validateAdmission).not.toHaveBeenCalled();
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
