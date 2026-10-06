import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthoritativeReviewServiceOptions } from '../../src/review/authoritativeReviewService';
import type { AuthoritativeServiceConfig } from '../../src/auth/authoritativeServiceConfig';
import type { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
import type { StoredReviewGate } from '../../src/review/reviewGateContracts';
import { createReviewCiLanePlan } from '../../src/review/reviewCi';
import { deriveReviewRunId } from '../../src/review/reviewAdmission';
import { AUTHORITATIVE_REVIEW_APP_ID } from '../../src/auth/authoritativeServiceIdentity';
import {
  PUBLIC_REVIEW_APP_ID,
  PUBLIC_REVIEW_REPOSITORY_ID,
} from '../../src/auth/repositoryReviewAuthority';

const mocks = vi.hoisted(() => {
  const pool = { query: vi.fn() };
  const initialize = vi.fn(async () => undefined);
  const getPool = vi.fn(() => pool);
  const closeStore = vi.fn(async () => undefined);
  const serverClose = vi.fn();
  const listen = vi.fn(() => ({ close: serverClose }));
  const createApp = vi.fn((_options: unknown) => ({ listen }));
  const repository = vi.fn(function (_pool: unknown, _queryable: unknown, _options: unknown) {});
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
  const token = vi.fn(async () => ({ token: 'ghs_generation_recovery' }));
  const installationClient = vi.fn();
  const getPullRequest = vi.fn(async (owner: string, repo: string) => ({
    repositoryId: owner === 'review-yeti-ai' && repo === 'review-yeti-bot' ? 1326169548 : 123,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
  }));
  const readGenerationRecovery = vi.fn(async () => []);
  const botLogin = vi.fn(async () => 'synthetic-review-bot[bot]');
  const remoteMcpRouter = vi.fn((_options: unknown) => ({ tag: 'mcp-router' }));
  const error = vi.fn();
  const warn = vi.fn();
  const legacyReaper = vi.fn();
  return { pool, initialize, getPool, closeStore, listen, serverClose, createApp, repository, gateStorage, gateRepository, getPrepared,
    validateAdmission, authoritative, serviceConfig, lookup, token, installationClient, readGenerationRecovery,
    error, warn, legacyReaper, resolver, enqueueCi, ciRunOnce, ciRoutes, ciRuntime, getPullRequest, botLogin, remoteMcpRouter };
});

vi.mock('../../src/auth/githubActionsOidc', () => ({
  githubActionsOidcPolicyFromEnv: () => ({ allowAppGate: true }),
  GitHubActionsOidcVerifier: class {},
}));
vi.mock('../../src/dispatchServer', () => ({ createActionDispatchApp: mocks.createApp }));
vi.mock('../../src/telemetry', () => ({ initTelemetry: vi.fn() }));
vi.mock('../../src/api/actionDispatchApi', () => ({ createWorkerCompletionVerifier: vi.fn() }));
vi.mock('../../src/persistence/postgresStore', () => ({
  PostgresStore: class { initialize = mocks.initialize; getPool = mocks.getPool; close = mocks.closeStore; },
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
  GitHubInstallationClient: class {
    readReviewGenerationRecovery = mocks.readGenerationRecovery;
    getPullRequest = mocks.getPullRequest;
    constructor(options: unknown) { mocks.installationClient(options); }
  },
  REVIEW_REFRESH_ACTION: Object.freeze({ identifier: 'review-yeti/refresh' }),
}));
vi.mock('../../src/github/appAuth', () => ({ getGitHubAppRepositoryPublishToken: vi.fn(), getGitHubAppBotLogin: mocks.botLogin }));
vi.mock('../../src/mcp/server/remoteMcpRouter', () => ({ createRemoteMcpRouter: mocks.remoteMcpRouter }));
vi.mock('../../src/dispatchModelClient', () => ({ resolveModelClientFromEnv: vi.fn(() => ({ generate: vi.fn() })) }));
vi.mock('../../src/auth/authoritativeServiceConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/auth/authoritativeServiceConfig')>(),
  authoritativeServiceConfigFromEnv: mocks.serviceConfig,
}));
vi.mock('../../src/review/authoritativeReviewService', () => ({ createAuthoritativeReviewService: mocks.authoritative }));
vi.mock('../../src/utils/logger', () => ({ logger: { error: mocks.error, info: vi.fn(), warn: mocks.warn } }));
vi.mock('../../src/github/boundedAppToken', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/github/boundedAppToken')>(),
  getBoundedRepositoryInstallationId: mocks.lookup,
  getBoundedRepositoryToken: mocks.token,
}));

function authoritativeConfig(): AuthoritativeServiceConfig {
  return { expectedAppId: AUTHORITATIVE_REVIEW_APP_ID, admissionEnabled: false, repositoryIds: [123], tickMs: 1000,
    policyRepository: { repositoryId: 987, owner: 'central', repo: 'policy' },
    policyRef: 'refs/heads/main', policyPath: 'policy.json',
    transport: { baseUrl: 'https://gateway.example.invalid/v1', model: 'configured-model' } };
}
function enableCi() {
  const config = authoritativeConfig(); mocks.serviceConfig.mockReturnValue(config);
  const repository = { repositoryId: 123, ownerId: 99, owner: 'exampleorg', repo: 'example-meta',
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
  return { coordinates: { repositoryId: 123, owner: 'exampleorg', repo: 'example-meta', prNumber: 42,
    runId, attemptId: `${runId}-g2-e1`, executionAttempt: 1,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64) },
    reviewGeneration: 2, expectedAppId: AUTHORITATIVE_REVIEW_APP_ID, externalId: 'synthetic-gate-id', checkId: 1234,
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
    mocks.pool.query.mockReset().mockResolvedValue({ rows: [{ ready: 1 }] });
    mocks.serviceConfig.mockReturnValue(undefined);
    mocks.enqueueCi.mockReset().mockResolvedValue(undefined);
    mocks.ciRunOnce.mockReset().mockResolvedValue(undefined);
    mocks.token.mockReset().mockResolvedValue({ token: 'ghs_generation_recovery' });
    mocks.readGenerationRecovery.mockReset().mockResolvedValue([]);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.spyOn(process, 'once').mockReturnValue(process);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected network call'); }));
    vi.stubEnv('ACTION_DISPATCH_ENABLED', 'true');
    vi.stubEnv('ACTION_DISPATCH_REQUIRE_EXPECTED_GENERATION', undefined);
    vi.stubEnv('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES', undefined);
    vi.stubEnv('REVIEW_YETI_PUBLIC_TARGET_APP_ID', undefined);
    vi.stubEnv('REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY', undefined);
    vi.stubEnv('GITHUB_APP_ID', String(AUTHORITATIVE_REVIEW_APP_ID));
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
    vi.stubEnv('REVIEW_YETI_INCREMENTAL_MAX_AGE_HOURS', undefined);
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
    await expect(options.resolveInstallationId('exampleorg', 'example-meta')).resolves.toBe(987);
    expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith({
      appId: String(AUTHORITATIVE_REVIEW_APP_ID), privateKey: 'synthetic-startup-private-key', owner: 'exampleorg', repo: 'example-meta',
      baseUrl: baseUrl ? 'https://api.example.invalid/api/v3' : 'https://api.github.com',
    });
    expect(mocks.repository).toHaveBeenCalledWith(mocks.pool, undefined, {
      lifecycleEvents: 'enabled',
      requireExpectedGeneration: false,
    });
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      requireExpectedGeneration: false,
      centralExternalRepositories: new Map(),
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
      lifecycleEvents: 'enabled',
      requireExpectedGeneration: true,
    });
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      requireExpectedGeneration: true,
    }));
    expect(mocks.listen).toHaveBeenCalledOnce();
  });

  it('wires only the exact configured self-hosted central-dispatch target', async () => {
    vi.stubEnv('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES', 'review-yeti-ai/review-yeti-bot');
    vi.stubEnv('REVIEW_YETI_PUBLIC_TARGET_APP_ID', String(PUBLIC_REVIEW_APP_ID));
    vi.stubEnv('REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY', 'synthetic-public-target-private-key');
    vi.stubEnv('REVIEW_YETI_MCP_ENABLED', 'true');
    vi.stubEnv('REVIEW_YETI_MCP_AUTH_TOKEN', 'synthetic-mcp-token');
    await start();

    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.createApp).toHaveBeenCalledWith(expect.objectContaining({
      centralExternalRepositories: new Map([['review-yeti-ai/review-yeti-bot', PUBLIC_REVIEW_REPOSITORY_ID]]),
    }));
    const options = mocks.createApp.mock.calls[0][0] as unknown as {
      resolveInstallationId(owner: string, repo: string): Promise<number>;
    };
    await expect(options.resolveInstallationId('review-yeti-ai', 'review-yeti-bot')).resolves.toBe(987);
    await expect(options.resolveInstallationId('exampleorg', 'example-meta')).resolves.toBe(987);
    expect(mocks.lookup).toHaveBeenNthCalledWith(1, {
      appId: String(PUBLIC_REVIEW_APP_ID), privateKey: 'synthetic-public-target-private-key',
      owner: 'review-yeti-ai', repo: 'review-yeti-bot', baseUrl: 'https://api.github.com',
    });
    expect(mocks.lookup).toHaveBeenNthCalledWith(2, {
      appId: String(AUTHORITATIVE_REVIEW_APP_ID), privateKey: 'synthetic-startup-private-key',
      owner: 'exampleorg', repo: 'example-meta', baseUrl: 'https://api.github.com',
    });

    mocks.token.mockClear();
    mocks.lookup.mockClear();
    mocks.installationClient.mockClear();
    mocks.getPullRequest.mockClear();
    mocks.botLogin.mockClear();
    const mcpOptions = mocks.remoteMcpRouter.mock.calls[0][0] as {
      triggerDeps: { resolveGitHubPullRequest(owner: string, repo: string, pullNumber: number): Promise<unknown> };
    };
    const appOptions = mocks.createApp.mock.calls[0][0] as unknown as {
      findingThreads: { transportFor(owner: string, repo: string): Promise<unknown> };
    };

    await expect(mcpOptions.triggerDeps.resolveGitHubPullRequest('review-yeti-ai', 'review-yeti-bot', 42)).resolves.toEqual({
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), repositoryId: PUBLIC_REVIEW_REPOSITORY_ID, installationId: 987,
    });
    await expect(appOptions.findingThreads.transportFor('review-yeti-ai', 'review-yeti-bot')).resolves.toEqual({
      token: 'ghs_generation_recovery', baseUrl: 'https://api.github.com', botLogin: 'synthetic-review-bot[bot]',
    });
    await expect(mcpOptions.triggerDeps.resolveGitHubPullRequest('exampleorg', 'example-meta', 42)).resolves.toEqual({
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), repositoryId: 123, installationId: 987,
    });
    await expect(appOptions.findingThreads.transportFor('exampleorg', 'example-meta')).resolves.toEqual({
      token: 'ghs_generation_recovery', baseUrl: 'https://api.github.com', botLogin: 'synthetic-review-bot[bot]',
    });
    expect(mocks.token).toHaveBeenNthCalledWith(1, {
      appId: String(PUBLIC_REVIEW_APP_ID), privateKey: 'synthetic-public-target-private-key',
      owner: 'review-yeti-ai', repo: 'review-yeti-bot', baseUrl: 'https://api.github.com',
    }, 'read');
    expect(mocks.token).toHaveBeenNthCalledWith(2, {
      appId: String(PUBLIC_REVIEW_APP_ID), privateKey: 'synthetic-public-target-private-key',
      owner: 'review-yeti-ai', repo: 'review-yeti-bot', baseUrl: 'https://api.github.com',
    }, 'review-threads');
    expect(mocks.token).toHaveBeenNthCalledWith(3, {
      appId: String(AUTHORITATIVE_REVIEW_APP_ID), privateKey: 'synthetic-startup-private-key',
      owner: 'exampleorg', repo: 'example-meta', baseUrl: 'https://api.github.com',
    }, 'read');
    expect(mocks.token).toHaveBeenNthCalledWith(4, {
      appId: String(AUTHORITATIVE_REVIEW_APP_ID), privateKey: 'synthetic-startup-private-key',
      owner: 'exampleorg', repo: 'example-meta', baseUrl: 'https://api.github.com',
    }, 'review-threads');
    expect(mocks.botLogin).toHaveBeenNthCalledWith(1, {
      appId: String(PUBLIC_REVIEW_APP_ID), privateKey: 'synthetic-public-target-private-key', baseUrl: 'https://api.github.com',
    });
    expect(mocks.botLogin).toHaveBeenNthCalledWith(2, {
      appId: String(AUTHORITATIVE_REVIEW_APP_ID), privateKey: 'synthetic-startup-private-key', baseUrl: 'https://api.github.com',
    });
    expect(mocks.listen).toHaveBeenCalledOnce();
  });

  it.each([
    ['7654321', undefined],
    [undefined, 'synthetic-public-target-private-key'],
    [undefined, undefined],
    ['not-a-number', 'synthetic-public-target-private-key'],
    ['0', 'synthetic-public-target-private-key'],
    ['9007199254740992', 'synthetic-public-target-private-key'],
  ])('rejects external dispatch without a complete dedicated App credential pair', async (publicAppId, publicKey) => {
    vi.stubEnv('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES', 'review-yeti-ai/review-yeti-bot');
    vi.stubEnv('REVIEW_YETI_PUBLIC_TARGET_APP_ID', publicAppId);
    vi.stubEnv('REVIEW_YETI_PUBLIC_TARGET_APP_PRIVATE_KEY', publicKey);
    await start();

    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith('Action dispatch service failed to start', {
      error: 'Dedicated public-target GitHub App credentials are required for external dispatch',
    });
    expect(process.exitCode).toBe(1);
  });

  it.each(['', 'review-yeti-ai/other-repository', 'other-owner/review-yeti-bot'])(
    'rejects invalid external central-dispatch configuration before initialization: %j',
    async (value) => {
      vi.stubEnv('ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES', value);
      await start();

      expect(mocks.initialize).not.toHaveBeenCalled();
      expect(mocks.repository).not.toHaveBeenCalled();
      expect(mocks.createApp).not.toHaveBeenCalled();
      expect(mocks.listen).not.toHaveBeenCalled();
      expect(mocks.error).toHaveBeenCalledWith('Action dispatch service failed to start', {
        error: 'ACTION_DISPATCH_CENTRAL_EXTERNAL_REPOSITORIES must contain only explicit supported repositories',
      });
      expect(process.exitCode).toBe(1);
    },
  );

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

  it('feeds REVIEW_YETI_INCREMENTAL_MAX_AGE_HOURS to both trusted verification and the planning read', async () => {
    vi.stubEnv('REVIEW_YETI_INCREMENTAL_MAX_AGE_HOURS', '24');
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    await start();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.gateRepository).toHaveBeenCalledExactlyOnceWith(mocks.pool, expect.objectContaining({
      incrementalMaxAgeMs: 24 * 60 * 60 * 1000,
    }));
    expect((mocks.createApp.mock.calls[0] as unknown[])[0]).toHaveProperty('incrementalBase.maxAgeMs', 24 * 60 * 60 * 1000);
  });

  it('feeds REVIEW_YETI_INCREMENTAL_MAX_CHAIN to trusted verification, ignoring invalid values', async () => {
    vi.stubEnv('REVIEW_YETI_INCREMENTAL_MAX_CHAIN', '2');
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    await start();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.gateRepository).toHaveBeenCalledExactlyOnceWith(mocks.pool, expect.objectContaining({ incrementalMaxChain: 2 }));
  });

  it('feeds REVIEW_YETI_VERDICT_CACHE_MAX_AGE_HOURS to both trusted verification and the planning read', async () => {
    vi.stubEnv('REVIEW_YETI_VERDICT_CACHE_MAX_AGE_HOURS', '12');
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    await start();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.gateRepository).toHaveBeenCalledExactlyOnceWith(mocks.pool, expect.objectContaining({
      verdictCacheMaxAgeMs: 12 * 60 * 60 * 1000,
      // Independent of W7's age: an unset incremental age stays at its own default.
      incrementalMaxAgeMs: 72 * 60 * 60 * 1000,
    }));
    expect((mocks.createApp.mock.calls[0] as unknown[])[0]).toHaveProperty('verdictCacheBase.maxAgeMs', 12 * 60 * 60 * 1000);
  });

  it('composes bounded storage and prepared lookup, then passes the exact service validator into admission', async () => {
    const config = authoritativeConfig();
    mocks.serviceConfig.mockReturnValue(config);
    await start();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.gateRepository).toHaveBeenCalledExactlyOnceWith(mocks.pool, {
      lifecycleEvents: 'enabled', completionResolutionTimeoutMs: 15_000,
      // REL-1084: the service's incremental age limit (72 h default), shared with the planning read.
      incrementalMaxAgeMs: 72 * 60 * 60 * 1000,
      // ADR 0771: the delta carry-chain cap (default 4), used by trusted verification.
      incrementalMaxChain: 4,
      // REL-1085: the verdict cache's age limit (72 h default), shared with its planning read.
      verdictCacheMaxAgeMs: 72 * 60 * 60 * 1000,
    });
    expect((mocks.createApp.mock.calls[0] as unknown[])[0]).toHaveProperty('incrementalBase.maxAgeMs', 72 * 60 * 60 * 1000);
    expect((mocks.createApp.mock.calls[0] as unknown[])[0]).toHaveProperty('verdictCacheBase.maxAgeMs', 72 * 60 * 60 * 1000);
    expect(mocks.authoritative).toHaveBeenCalledExactlyOnceWith({
      config, repository: mocks.gateStorage, getStoredPrepared: expect.any(Function), appId: String(AUTHORITATIVE_REVIEW_APP_ID),
      privateKey: 'synthetic-startup-private-key', baseUrl: 'https://api.github.com',
      workerId: 'authoritative-review-startup-test',
      // ADR 0002: resolves the review App's bot login for finding-thread author verification.
      findingThreadAuthor: expect.any(Function),
      operatorPassthroughRepository: { pool: mocks.pool },
      passthroughEnabled: false,
      listPausedAdmissions: expect.any(Function),
    });
    const options = mocks.authoritative.mock.calls[0][0];
    expect(options.repository).toBe(mocks.gateStorage);
    expect(options.operatorPassthroughRepository).toMatchObject({ pool: mocks.pool });
    expect(options.passthroughEnabled).toBe(false);
    expect(options.listPausedAdmissions).toEqual(expect.any(Function));
    expect(mocks.getPrepared).not.toHaveBeenCalled();
    const digest = 'a'.repeat(64);
    await expect(options.getStoredPrepared(digest, new AbortController().signal)).resolves.toBeNull();
    expect(mocks.getPrepared).toHaveBeenCalledExactlyOnceWith(mocks.pool, digest);
    expect(mocks.initialize.mock.invocationCallOrder[0]).toBeLessThan(mocks.gateRepository.mock.invocationCallOrder[0]);
    expect(mocks.gateRepository.mock.invocationCallOrder[0]).toBeLessThan(mocks.authoritative.mock.invocationCallOrder[0]);
    expect(mocks.repository).toHaveBeenCalledExactlyOnceWith(mocks.pool, undefined, {
      lifecycleEvents: 'enabled',
      resolveGenerationRecovery: expect.any(Function),
      retireOperatorPassthroughInTransaction: expect.any(Function),
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

  it('passes an explicitly enabled operator pause into the authoritative service', async () => {
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');

    await start();

    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.authoritative).toHaveBeenCalledOnce();
    expect(mocks.authoritative.mock.calls[0][0]).toMatchObject({
      passthroughEnabled: true,
      operatorPassthroughRepository: { pool: mocks.pool },
      listPausedAdmissions: expect.any(Function),
    });
  });

  it('opens under a valid operator pause when the outbound primary App signing key is unavailable', async () => {
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', undefined);

    await start();

    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(mocks.authoritative.mock.calls[0][0]).toMatchObject({
      appId: String(AUTHORITATIVE_REVIEW_APP_ID), privateKey: '', passthroughEnabled: true,
    });
  });

  it('keeps a missing outbound App signing key fatal outside operator pause', async () => {
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', undefined);

    await start();

    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.error).toHaveBeenCalledWith('Action dispatch service failed to start', {
      error: 'GITHUB_APP_PRIVATE_KEY is required for the Action dispatch service',
    });
  });

  it('opens a pause-safe listener after DB bootstrap fails, retries single-flight, and keeps CI and sweeps off until storage is ready', async () => {
    const { repository } = enableCi();
    mocks.initialize.mockRejectedValueOnce(new Error('synthetic database unavailable'));
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');

    await start();

    expect(mocks.getPool).toHaveBeenCalledOnce();
    expect(mocks.getPool.mock.invocationCallOrder[0]).toBeLessThan(mocks.initialize.mock.invocationCallOrder[0]);
    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.ciRuntime).not.toHaveBeenCalled();
    const appOptions = mocks.createApp.mock.calls[0][0] as any;
    expect(appOptions).toMatchObject({ passthroughEnabled: true, operatorPauseReadinessEnabled: true,
      storageInitialized: expect.any(Function) });
    expect(appOptions.storageInitialized()).toBe(false);
    expect(appOptions.ci).toBeUndefined();
    expect(mocks.gateRepository.mock.calls[0][1]).not.toHaveProperty('onEligibleCompletion');
    expect(vi.getTimerCount()).toBe(1); // One bounded storage retry; no review/publisher sweep yet.
    expect(mocks.authoritative.mock.results[0].value.runOnce).not.toHaveBeenCalled();
    expect(mocks.ciRunOnce).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.initialize).toHaveBeenCalledTimes(2);
    expect(appOptions.storageInitialized()).toBe(true);
    expect(mocks.ciRuntime).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.authoritative.mock.results[0].value.runOnce).toHaveBeenCalledOnce();
    expect(mocks.ciRunOnce).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2); // Publisher reconciliation and background health probe start after recovery.
    expect(mocks.repository).toHaveBeenCalledExactlyOnceWith(mocks.pool, undefined, expect.any(Object));
    expect(repository.repositoryId).toBe(123);
  });

  it('opens pause startup while a post-bootstrap health probe remains pending', async () => {
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    const probe = Promise.withResolvers<{ rows: Array<{ ready: number }> }>();
    mocks.pool.query.mockReturnValueOnce(probe.promise);
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');

    await start();

    expect(mocks.listen).toHaveBeenCalledOnce();
    expect(mocks.pool.query).toHaveBeenCalledExactlyOnceWith({ text: 'SELECT 1 AS ready', query_timeout: 1_500 });
    const appOptions = mocks.createApp.mock.calls[0][0] as any;
    expect(appOptions.pauseDatabaseProbe()).toMatchObject({
      status: 'unknown', databaseReady: null, inProgress: true, checkedAt: null,
    });
    expect(appOptions.databaseReady).toEqual(expect.any(Function));

    probe.resolve({ rows: [{ ready: 1 }] });
    await probe.promise;
    await Promise.resolve();
    expect(appOptions.pauseDatabaseProbe()).toMatchObject({ status: 'ready', databaseReady: true, inProgress: false });
  });

  it('waits for the tracked pause health probe before closing its pool on shutdown', async () => {
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    const probe = Promise.withResolvers<{ rows: Array<{ ready: number }> }>();
    mocks.pool.query.mockReturnValueOnce(probe.promise);
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');

    await start();
    mocks.serverClose.mockImplementationOnce((callback: () => void) => callback());
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const stop = vi.mocked(process.once).mock.calls.find(([event]) => event === 'SIGTERM')?.[1];
    expect(stop).toEqual(expect.any(Function));
    stop!();
    await Promise.resolve();
    expect(mocks.closeStore).not.toHaveBeenCalled();

    probe.resolve({ rows: [{ ready: 1 }] });
    await probe.promise;
    await vi.waitFor(() => expect(mocks.closeStore).toHaveBeenCalledOnce());
  });

  it('opens the pause-safe listener while the first storage initialization remains in flight', async () => {
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    const initialization = Promise.withResolvers<undefined>();
    mocks.initialize.mockReturnValueOnce(initialization.promise);

    await start();

    expect(mocks.initialize).toHaveBeenCalledOnce();
    expect(mocks.listen).toHaveBeenCalledOnce();
    const appOptions = mocks.createApp.mock.calls[0][0] as any;
    expect(appOptions.operatorPauseReadinessEnabled).toBe(true);
    expect(appOptions.storageInitialized()).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // Do not retry or run sweeps while one DDL attempt is still active.

    initialization.resolve(undefined);
    await initialization.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(appOptions.storageInitialized()).toBe(true);
  });

  it('keeps pause startup fail-closed for static database TLS configuration errors', async () => {
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    mocks.getPool.mockImplementationOnce(() => { throw new Error('DATABASE_CA_CERT must be trusted'); });

    await start();

    expect(mocks.getPool).toHaveBeenCalledOnce();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects operator pause before storage startup when authoritative enrollment is not configured', async () => {
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');

    await start();

    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.error).toHaveBeenCalledWith('Action dispatch service failed to start', {
      error: 'Operator pause requires valid authoritative review configuration',
    });
  });

  it('keeps static CI enrollment validation active during pause while omitting CI runtime', async () => {
    vi.stubEnv('REVIEW_YETI_PASSTHROUGH', 'true');
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    vi.stubEnv('REVIEW_CI_ENABLED', 'true');
    vi.stubEnv('REVIEW_CI_REPOSITORIES', '{"invalid":"enrollment"}');

    await start();

    expect(mocks.initialize).not.toHaveBeenCalled();
    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.ciRuntime).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(mocks.error).toHaveBeenCalledWith('Action dispatch service failed to start', {
      error: 'Review CI service configuration is invalid',
    });
  });

  it('preserves ordinary startup failure when storage initialization fails outside pause mode', async () => {
    mocks.initialize.mockRejectedValueOnce(new Error('synthetic database unavailable'));

    await start();

    expect(mocks.listen).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(process.exitCode).toBe(1);
  });

  it('wires exact immutable identity into the production generation-recovery reader', async () => {
    mocks.serviceConfig.mockReturnValue(authoritativeConfig());
    await start();
    const options = mocks.repository.mock.calls[0][2] as {
      resolveGenerationRecovery(input: any): Promise<unknown[]>;
    };
    const identity = {
      owner: 'exampleorg', repo: 'example-api', prNumber: 42,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      snapshotDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
    };
    const input = {
      identity,
      expectedGeneration: 2,
      authoritativeGate: { expectedAppId: 4_385_771 },
    };

    await expect(options.resolveGenerationRecovery(input)).resolves.toEqual([]);
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith({
      appId: String(AUTHORITATIVE_REVIEW_APP_ID), privateKey: 'synthetic-startup-private-key',
      owner: 'exampleorg', repo: 'example-api', baseUrl: 'https://api.github.com',
    }, 'publish');
    expect(mocks.installationClient).toHaveBeenCalledExactlyOnceWith({
      token: 'ghs_generation_recovery', baseUrl: 'https://api.github.com',
    });
    expect(mocks.readGenerationRecovery).toHaveBeenCalledExactlyOnceWith({
      owner: 'exampleorg', repo: 'example-api', headSha: 'a'.repeat(40),
      runId: deriveReviewRunId(identity as any), expectedGeneration: 2, expectedAppId: 4_385_771,
    });

    await expect(options.resolveGenerationRecovery({ identity, expectedGeneration: 2 }))
      .rejects.toThrow('generation recovery identity is unavailable');
    await expect(options.resolveGenerationRecovery({ identity, authoritativeGate: { expectedAppId: 4_385_771 } }))
      .rejects.toThrow('generation recovery identity is unavailable');
    expect(mocks.token).toHaveBeenCalledOnce();
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
      lifecycleEvents: 'enabled', completionResolutionTimeoutMs: 15_000, onEligibleCompletion: expect.any(Function),
      incrementalMaxAgeMs: 72 * 60 * 60 * 1000, incrementalMaxChain: 4, verdictCacheMaxAgeMs: 72 * 60 * 60 * 1000,
    });
    const serviceOptions = mocks.authoritative.mock.calls[0][0];
    expect(serviceOptions.repository).toBe(mocks.gateStorage);
    expect(serviceOptions).not.toHaveProperty('pool'); expect(serviceOptions).not.toHaveProperty('ciConfig');
    expect(mocks.enqueueCi).not.toHaveBeenCalled();
    const client = { query: vi.fn() }; const gate = eligibleGate(); const now = 123_456;
    await completionHook()(client, gate, now);
    expect(mocks.enqueueCi).toHaveBeenCalledExactlyOnceWith(client, gate.coordinates.attemptId, now);
    expect(mocks.ciRuntime).toHaveBeenCalledExactlyOnceWith({
      config: { expectedAppId: AUTHORITATIVE_REVIEW_APP_ID, repositories: [repository], admissionEnabled: false,
        repositoryDispatchEnabled: false, tickMs: 2000 },
      pool: mocks.pool, appId: String(AUTHORITATIVE_REVIEW_APP_ID), privateKey: 'synthetic-startup-private-key',
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
