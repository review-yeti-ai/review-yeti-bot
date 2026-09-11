import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoritativeReviewServiceOptions } from '../../src/review/authoritativeReviewService';
import type { AuthoritativeServiceConfig } from '../../src/auth/authoritativeServiceConfig';
import type { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
import type { StoredReviewGate } from '../../src/review/reviewGateContracts';
import { createReviewCiLanePlan } from '../../src/review/reviewCi';

const mocks = vi.hoisted(() => {
  const pool = { query: vi.fn() };
  const initialize = vi.fn(async () => undefined);
  const serverClose = vi.fn();
  const listen = vi.fn(() => ({ close: serverClose }));
  const createApp = vi.fn((_options: unknown) => ({ listen }));
  const repository = vi.fn(function () {});
  const gateStorage = { recordWorkerResult: vi.fn(), claimPublication: vi.fn(), publishLocked: vi.fn(),
    retryPublication: vi.fn(), reapTerminalAttempts: vi.fn(), advanceProjectedAttempts: vi.fn() };
  const gateRepository = vi.fn(function (_pool: unknown, _options: unknown) { return gateStorage; });
  const getPrepared = vi.fn(async (_pool: unknown, _digest: string) => null);
  const validateAdmission = vi.fn(async () => undefined);
  const resolver = { resolve: vi.fn() };
  const authoritative = vi.fn((_options: AuthoritativeReviewServiceOptions) =>
    ({ admission: {}, completion: {}, resolver, runOnce: vi.fn(async () => undefined), validateAdmission }));
  const serviceConfig = vi.fn<() => AuthoritativeServiceConfig | undefined>(() => undefined);
  const enqueueCi = vi.fn(async () => undefined);
  const ciRunOnce = vi.fn(async () => undefined);
  const ciRoutes = { service: { tag: 'ci-service' }, verifier: { tag: 'ci-verifier' } };
  const ciRuntime = vi.fn((_options: unknown) => ({ routes: ciRoutes, runOnce: ciRunOnce }));
  const lookup = vi.fn(async () => 987);
  const error = vi.fn();
  const legacyReaper = vi.fn();
  return { pool, initialize, listen, serverClose, createApp, repository, gateStorage, gateRepository, getPrepared,
    validateAdmission, authoritative, serviceConfig, lookup, error, legacyReaper, resolver, enqueueCi, ciRunOnce,
    ciRoutes, ciRuntime };
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
vi.mock('../../src/persistence/reviewCiRepository', () => ({ enqueueReviewCiCompletionInTransaction: mocks.enqueueCi }));
vi.mock('../../src/reviewCiRuntime', () => ({ createReviewCiRuntime: mocks.ciRuntime }));
vi.mock('../../src/review/abandonedRunReaper', () => ({ AbandonedRunReaper: class {
  constructor() { mocks.legacyReaper(); }
  runOnce = vi.fn();
} }));
vi.mock('../../src/github/installationClient', () => ({
  GitHubInstallationClient: class {},
  REVIEW_REFRESH_ACTION: Object.freeze({ identifier: 'review-yeti/refresh' }),
}));
vi.mock('../../src/github/appAuth', () => ({ getGitHubAppRepositoryPublishToken: vi.fn() }));
vi.mock('../../src/auth/authoritativeServiceConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/auth/authoritativeServiceConfig')>(),
  authoritativeServiceConfigFromEnv: mocks.serviceConfig,
}));
vi.mock('../../src/review/authoritativeReviewService', () => ({ createAuthoritativeReviewService: mocks.authoritative }));
vi.mock('../../src/utils/logger', () => ({ logger: { error: mocks.error, info: vi.fn() } }));
vi.mock('../../src/github/boundedAppToken', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/github/boundedAppToken')>(),
  getBoundedRepositoryInstallationId: mocks.lookup,
}));

function authoritativeConfig(): AuthoritativeServiceConfig {
  return { expectedAppId: 4385771, admissionEnabled: false, repositoryIds: [123], tickMs: 1000,
    policyRepository: { repositoryId: 987, owner: 'central', repo: 'policy' },
    policyRef: 'refs/heads/main', policyPath: 'policy.json',
    transport: { baseUrl: 'https://gateway.example.invalid/v1', model: 'configured-model' } };
}
function enableCi() {
  const config = authoritativeConfig(); mocks.serviceConfig.mockReturnValue(config);
  const repository = { repositoryId: 123, ownerId: 99, owner: 'calltelemetry', repo: 'ct-meta',
    relay: { workflowId: 100, workflowPath: '.github/workflows/relay.yml', workflowRef: 'refs/heads/main', workflowSha: 'a'.repeat(40) },
    validation: { workflowId: 101, workflowPath: '.github/workflows/candidate.yml', workflowRef: 'refs/tags/ci-v1', workflowSha: 'b'.repeat(40) },
    lanePlan: createReviewCiLanePlan(['core'], ['validate']) };
  vi.stubEnv('REVIEW_CI_ENABLED', 'true');
  vi.stubEnv('REVIEW_CI_REPOSITORIES', JSON.stringify([repository]));
  vi.stubEnv('REVIEW_CI_TICK_MS', '2000');
  return { config, repository };
}
function eligibleGate(): StoredReviewGate {
  const runId = `run_${'1'.repeat(32)}`;
  return { coordinates: { repositoryId: 123, owner: 'calltelemetry', repo: 'ct-meta', prNumber: 42,
    runId, attemptId: `${runId}-g2-e1`, executionAttempt: 1,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64) },
    reviewGeneration: 2, expectedAppId: 4385771, externalId: 'synthetic-gate-id', checkId: 1234,
    creationState: 'bound', desiredState: 'success', desiredVersion: 2, publishedVersion: 1, current: true };
}
function completionHook() {
  const options = mocks.gateRepository.mock.calls[0][1] as NonNullable<ConstructorParameters<typeof PostgresReviewGateRepository>[1]>;
  return options.onEligibleCompletion!;
}

describe('Action dispatch startup transport and admission wiring', () => {
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
    vi.resetModules();
    vi.clearAllMocks();
    mocks.serviceConfig.mockReturnValue(undefined);
    mocks.enqueueCi.mockReset().mockResolvedValue(undefined);
    mocks.ciRunOnce.mockReset().mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.spyOn(process, 'once').mockReturnValue(process);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected network call'); }));
    vi.stubEnv('ACTION_DISPATCH_ENABLED', 'true');
    vi.stubEnv('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION', undefined);
    vi.stubEnv('GITHUB_APP_ID', '4385771');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', 'synthetic-startup-private-key');
    vi.stubEnv('HOSTNAME', 'startup-test');
    vi.stubEnv('GITHUB_API_BASE_URL', undefined);
    vi.stubEnv('ACTION_DISPATCH_REAPER_INTERVAL_MS', '60000');
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('REVIEW_CI_ENABLED', undefined);
    vi.stubEnv('REVIEW_CI_ADMISSION_ENABLED', undefined);
    vi.stubEnv('REVIEW_CI_REPOSITORY_DISPATCH_ENABLED', undefined);
    vi.stubEnv('REVIEW_CI_REPOSITORIES', undefined);
    vi.stubEnv('REVIEW_CI_TICK_MS', undefined);
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
    expect(mocks.ciRuntime).not.toHaveBeenCalled();
    expect(mocks.enqueueCi).not.toHaveBeenCalled();
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
    expect(mocks.repository).toHaveBeenCalledWith(mocks.pool, undefined, {
      requireExpectedGeneration: false,
    });
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      requireExpectedGeneration: false,
    }));
    expect(mocks.gateRepository).not.toHaveBeenCalled();
    expect(mocks.getPrepared).not.toHaveBeenCalled();
    expect(mocks.authoritative).not.toHaveBeenCalled();
    expect(mocks.legacyReaper).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); // Legacy publication belongs only to the worker-App dispatcher.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('wires enabled expected-generation enforcement into request and durable admission', async () => {
    vi.stubEnv('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION', 'true');
    await start();

    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.repository).toHaveBeenCalledExactlyOnceWith(mocks.pool, undefined, {
      requireExpectedGeneration: true,
    });
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      requireExpectedGeneration: true,
    }));
    expect(mocks.listen).toHaveBeenCalledOnce();
  });

  it('rejects an invalid expected-generation enforcement value before initialization', async () => {
    vi.stubEnv('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION', 'yes');
    await start();

    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.repository).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('Action dispatch service failed to start', {
      error: 'ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION must be exactly true or false',
    });
    expect(process.exitCode).toBe(1);
  });

  it('composes bounded storage and prepared lookup, then passes the exact service validator into admission', async () => {
    const config = authoritativeConfig();
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
      requireExpectedGeneration: false,
    });
    expect(mocks.authoritative.mock.invocationCallOrder[0]).toBeLessThan(mocks.repository.mock.invocationCallOrder[0]);
    const service = mocks.authoritative.mock.results[0].value;
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      authoritativePublishing: service.admission, authoritativeWorkerCompletion: service.completion,
      requireExpectedGeneration: false,
    }));
    expect(mocks.validateAdmission).not.toHaveBeenCalled();
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mocks.legacyReaper).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    expect(mocks.ciRuntime).not.toHaveBeenCalled();
    expect(mocks.enqueueCi).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.runOnce).toHaveBeenCalledOnce();
    expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  it.each(['SIGTERM', 'SIGINT'])('stops the opted-in authoritative timer on %s', async (signal) => {
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    await start();
    const service = mocks.authoritative.mock.results[0].value;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(service.runOnce).toHaveBeenCalledOnce();
    const stop = vi.mocked(process.once).mock.calls.find(([event]) => event === signal)?.[1];
    expect(stop).toEqual(expect.any(Function));
    // Do not arm the real process-exit fallback in this offline startup test.
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref: vi.fn() } as unknown as NodeJS.Timeout);
    stop!();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(service.runOnce).toHaveBeenCalledOnce();
    expect(mocks.legacyReaper).not.toHaveBeenCalled();
  });

  it('does not construct the service or listen if composed gate storage fails', async () => {
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
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

  it('composes the CI completion hook with the exact parent transaction, attempt and clock while admission is paused', async () => {
    const { repository } = enableCi(); await start();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.gateRepository).toHaveBeenCalledExactlyOnceWith(mocks.pool, {
      completionResolutionTimeoutMs: 15_000, onEligibleCompletion: expect.any(Function),
    });
    const serviceOptions = mocks.authoritative.mock.calls[0][0];
    expect(serviceOptions.repository).toBe(mocks.gateStorage);
    expect(serviceOptions).not.toHaveProperty('pool'); expect(serviceOptions).not.toHaveProperty('ciConfig');
    expect(mocks.enqueueCi).not.toHaveBeenCalled();
    const client = { query: vi.fn() }; const gate = eligibleGate(); const now = 123_456;
    await completionHook()(client, gate, now);
    expect(mocks.enqueueCi).toHaveBeenCalledExactlyOnceWith(client, gate.coordinates.attemptId, now);
    expect(mocks.ciRuntime).toHaveBeenCalledExactlyOnceWith({
      config: { expectedAppId: 4385771, repositories: [repository], admissionEnabled: false,
        repositoryDispatchEnabled: false, tickMs: 2000 },
      pool: mocks.pool, appId: '4385771', privateKey: 'synthetic-startup-private-key',
      baseUrl: 'https://api.github.com', resolver: mocks.resolver, workerId: 'review-ci-startup-test',
    });
    expect(mocks.authoritative.mock.invocationCallOrder[0]).toBeLessThan(mocks.ciRuntime.mock.invocationCallOrder[0]);
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({ ci: mocks.ciRoutes }));
    expect(mocks.pool.query).not.toHaveBeenCalled(); expect(client.query).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled(); expect(mocks.resolver.resolve).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.ciRunOnce).toHaveBeenCalledTimes(1);
    expect(mocks.authoritative.mock.results[0].value.runOnce).toHaveBeenCalledTimes(2);
  });

  it.each(['repositoryId', 'owner', 'repo', 'app'] as const)('does not enroll a completion with a mismatched %s', async (field) => {
    enableCi(); await start(); const gate = eligibleGate();
    if (field === 'repositoryId') gate.coordinates.repositoryId++;
    else if (field === 'app') gate.expectedAppId++;
    else gate.coordinates[field] = 'outside-enrollment';
    await completionHook()({ query: vi.fn() }, gate, 123_456);
    expect(mocks.enqueueCi).not.toHaveBeenCalled(); expect(mocks.pool.query).not.toHaveBeenCalled();
  });

  it('awaits a failing CI transaction helper so eligible completion cannot silently commit without its intent', async () => {
    enableCi(); await start(); const gate = eligibleGate(); const client = { query: vi.fn() };
    const pending = Promise.withResolvers<undefined>(); mocks.enqueueCi.mockReturnValueOnce(pending.promise);
    const settled = vi.fn(); const result = completionHook()(client, gate, 123_456);
    const rejected = expect(result).rejects.toThrow('synthetic outbox failure');
    void result.then(settled, settled); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
    pending.reject(new Error('synthetic outbox failure')); await rejected;
    expect(mocks.enqueueCi).toHaveBeenCalledExactlyOnceWith(client, gate.coordinates.attemptId, 123_456);
  });

  it.each(['SIGTERM', 'SIGINT'] as const)('clears the CI and authoritative timers on %s', async (signal) => {
    enableCi(); await start(); expect(vi.getTimerCount()).toBe(2);
    const handler = vi.mocked(process.once).mock.calls.find(([event]) => event === signal)![1];
    handler();
    expect(mocks.serverClose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1); // Only the bounded shutdown deadline remains.
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.ciRunOnce).not.toHaveBeenCalled();
    expect(mocks.authoritative.mock.results[0].value.runOnce).not.toHaveBeenCalled();
  });

  it('logs only the static CI reconciliation error on a failed interval', async () => {
    enableCi(); await start(); mocks.ciRunOnce.mockRejectedValueOnce(new Error('ghs_private_server_body'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith('Review CI reconciliation unavailable');
    expect(mocks.ciRunOnce).toHaveBeenCalledOnce();
  });
});
