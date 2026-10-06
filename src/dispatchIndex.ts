import { GitHubActionsOidcVerifier, githubActionsOidcPolicyFromEnv } from './auth/githubActionsOidc';
import type { QueryConfig } from 'pg';
import { PostgresWorkerCompletionStore } from './persistence/workerCompletionStore';
import { createActionDispatchApp } from './dispatchServer';
import { McpAuthenticator } from './mcp/server/mcpAuthenticator';
import { SlidingWindowRateLimiter } from './mcp/server/mcpRateLimiter';
import { createRemoteMcpRouter, type RemoteMcpRouter } from './mcp/server/remoteMcpRouter';
import { createWorkerCompletionVerifier } from './api/actionDispatchApi';
import { OpenRouterClient } from './gateway/openRouterClient';
import {
  getBoundedRepositoryInstallationId, getBoundedRepositoryToken, validateGitHubAppApiBaseUrl,
} from './github/boundedAppToken';
import { GitHubInstallationClient } from './github/installationClient';
import { getGitHubAppBotLogin } from './github/appAuth';
import { AuthoritativeReviewReader } from './github/authoritativeReviewReader';
import { PostgresReviewDispatchRepository } from './persistence/reviewDispatchRepository';
import { PostgresReviewGateRepository } from './persistence/reviewGateRepository';
import { PostgresOperatorPassthroughRepository } from './persistence/operatorPassthroughRepository';
import { enqueueReviewCiCompletionInTransaction } from './persistence/reviewCiRepository';
import { getPreparedPublishingPolicy } from './persistence/preparedReviewRepository';
import { PostgresStore } from './persistence/postgresStore';
import { RetryingStorageInitializer } from './persistence/retryingStorageInitializer';
import { logger } from './utils/logger';
import { authoritativeServiceConfigFromEnv } from './auth/authoritativeServiceConfig';
import { createAuthoritativeReviewService } from './review/authoritativeReviewService';
import { githubWebhookConfigFromEnv } from './auth/githubWebhookConfig';
import { createGitHubWebhookAdmissionHandler } from './review/githubWebhookAdmission';
import { PostgresMergeGroupGateRepository } from './persistence/mergeGroupGateRepository';
import { createMergeGroupGate } from './review/mergeGroupGate';
import { reviewCiConfigFromEnv } from './auth/reviewCiConfig';
import { createReviewCiRuntime } from './reviewCiRuntime';
import { findReviewCiEnrollment } from './review/reviewCi';
import { actionDispatchConfigFromEnv } from './config/actionDispatchConfig';
import { initTelemetry } from './telemetry';
import { deriveReviewRunId } from './review/reviewAdmission';
import { PostgresIncrementalBaseLookup } from './persistence/incrementalPriorReview';
import { incrementalMaxAgeMsFrom } from './review/incrementalReview';
import { incrementalMaxChainFrom } from './review/incrementalDelta';
import { PostgresVerdictCacheBaseLookup } from './persistence/verdictCacheSource';
import { verdictCacheMaxAgeMsFrom } from './review/verdictCache';
import { PROVIDER_CONCURRENCY_ENV, providerLeaseServiceConfigFromEnv } from './config/providerConcurrency';
import { PostgresProviderLeaseStore } from './persistence/providerConcurrencyLeaseRepository';
import { canonicalJson, sha256 } from './review/reviewCore';
import type { PauseDatabaseProbeSnapshot } from './health/readinessContract';

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Action dispatch service`);
  return value;
}

import { resolveModelClientFromEnv } from './dispatchModelClient';
export { resolveModelClientFromEnv };

async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (environment.ACTION_DISPATCH_ENABLED !== 'true') {
    throw new Error('ACTION_DISPATCH_ENABLED must be true for the dedicated Action dispatch service');
  }
  initTelemetry('ct-review-action-dispatch');
  const dispatchConfig = actionDispatchConfigFromEnv(environment);
  const policy = githubActionsOidcPolicyFromEnv(environment);
  const appId = required(environment, 'GITHUB_APP_ID');
  const privateKey = dispatchConfig.passthroughEnabled === true
    ? (environment.GITHUB_APP_PRIVATE_KEY?.trim().replace(/\\n/g, '\n') ?? '')
    : required(environment, 'GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n');
  const baseUrl = validateGitHubAppApiBaseUrl(environment.GITHUB_API_BASE_URL);
  // ADR 0002: the review App's bot login, read once per App from GitHub's authenticated /app
  // endpoint, so only the App's own finding threads are trusted.
  const botLogins = new Map<string, Promise<string>>();
  const findingThreadBotLogin = (credentials: { appId: string; privateKey: string; baseUrl?: string }): Promise<string> => {
    let login = botLogins.get(credentials.appId);
    if (!login) {
      login = getGitHubAppBotLogin({ appId: credentials.appId, privateKey: credentials.privateKey, baseUrl: credentials.baseUrl });
      login.catch(() => botLogins.delete(credentials.appId));
      botLogins.set(credentials.appId, login);
    }
    return login;
  };
  /** The Gate's completion context has a fixed budget: an unavailable lookup leaves resolutions untrusted. */
  const boundedBotLogin = (credentials: { appId: string; privateKey: string; baseUrl?: string }): Promise<string | undefined> =>
    Promise.race([
      findingThreadBotLogin(credentials).catch(() => undefined),
      new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), 3_000).unref?.(); }),
    ]);
  // Exact configured public targets use their installed dedicated App. Primary
  // policy reads and private-target authority remain on the primary service App.
  const installationCredentialsForRepository = (owner: string, repo: string) => {
    const external = dispatchConfig.centralExternalAppCredentials;
    return external && dispatchConfig.centralExternalRepositories.has(`${owner}/${repo}`)
      ? { ...external, owner, repo, baseUrl }
      : { appId, privateKey, owner, repo, baseUrl };
  };
  const authoritativeConfig = authoritativeServiceConfigFromEnv(environment, policy, dispatchConfig);
  const configuredAuthoritativeRepositoryIds = authoritativeConfig
    ? [...authoritativeConfig.repositoryIds,
      ...(authoritativeConfig.publicRepository ? [authoritativeConfig.publicRepository.repositoryId] : [])]
    : [];
  const configuredAuthoritativeAppIds = authoritativeConfig
    ? [authoritativeConfig.expectedAppId,
      ...(authoritativeConfig.publicRepository ? [authoritativeConfig.publicRepository.expectedAppId] : [])]
    : [];
  // REL-1084: one configured age for both the worker's planning read and trusted verification.
  const incrementalMaxAgeMs = incrementalMaxAgeMsFrom(environment);
  const incrementalMaxChain = incrementalMaxChainFrom(environment);
  // REL-1085: likewise one configured age for the verdict cache's planning read and verification.
  const verdictCacheMaxAgeMs = verdictCacheMaxAgeMsFrom(environment);
  const webhookConfig = githubWebhookConfigFromEnv(environment, policy);
  // Validate any configured CI enrollment/workflow identity even when pause
  // prevents creating its runtime, routes, completion hook, or reconciliation timer.
  const configuredCiConfig = reviewCiConfigFromEnv(environment, authoritativeConfig);
  if (dispatchConfig.passthroughEnabled === true && !authoritativeConfig) {
    throw new Error('Operator pause requires valid authoritative review configuration');
  }
  const ciConfig = dispatchConfig.passthroughEnabled === true ? undefined : configuredCiConfig;
  const port = Number(environment.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');
  const host = environment.HOST || '0.0.0.0';
  const store = new PostgresStore();
  const pool = store.getPool();
  let storageInitialized = false;
  let onStorageInitialized: () => void = () => {};
  let pauseDatabaseProbe: PauseDatabaseProbeSnapshot = {
    status: 'not_initialized', databaseReady: false, checkedAt: null, inProgress: false,
  };
  let pauseDatabaseProbeTimer: NodeJS.Timeout | undefined;
  let pauseDatabaseProbeInFlight: Promise<void> | undefined;
  let storageInitializer: RetryingStorageInitializer | undefined;
  if (dispatchConfig.passthroughEnabled === true) {
    storageInitializer = new RetryingStorageInitializer(() => store.initialize(), {
      retryInitialMs: 1_000,
      retryMaxMs: 60_000,
      onInitialized: () => {
        storageInitialized = true;
        pauseDatabaseProbe = { status: 'unknown', databaseReady: null, checkedAt: null, inProgress: false };
        onStorageInitialized();
      },
      onFailure: () => logger.warn('Review storage initialization is unavailable during operator pause', {
        code: 'review_storage_initialization_unavailable',
      }),
      onCallbackError: () => logger.error('Review storage initialization lifecycle callback failed', {
        code: 'review_storage_initializer_callback_failed',
      }),
    });
    // Listen for authenticated pause responses while the tracked schema attempt
    // runs in the background; no DDL attempt is abandoned or raced.
    void storageInitializer.initializeOnce();
  } else {
    await store.initialize();
    storageInitialized = true;
    pauseDatabaseProbe = { status: 'unknown', databaseReady: null, checkedAt: null, inProgress: false };
  }
  const storageIsInitialized = () => storageInitialized;
  const operatorPassthroughRepository = new PostgresOperatorPassthroughRepository(pool);
  // Cross-review provider concurrency. Off unless configured; a malformed value leaves the route
  // unmounted (workers fail open to their local cap) instead of stopping this service.
  const providerLeaseConfig = providerLeaseServiceConfigFromEnv(environment);
  if (providerLeaseConfig.status === 'invalid') {
    logger.error('Provider concurrency leases disabled: invalid configuration', {
      variable: PROVIDER_CONCURRENCY_ENV, reason: providerLeaseConfig.reason,
    });
  }
  const providerLease = providerLeaseConfig.status === 'enabled' && dispatchConfig.passthroughEnabled !== true
    ? new PostgresProviderLeaseStore(pool, providerLeaseConfig.config)
    : undefined;
  const authoritative = authoritativeConfig ? createAuthoritativeReviewService({
    config: authoritativeConfig, appId, privateKey, baseUrl,
    ...(dispatchConfig.centralExternalAppCredentials ? { publicAppCredentials: dispatchConfig.centralExternalAppCredentials } : {}),
    findingThreadAuthor: (selected) => boundedBotLogin(installationCredentialsForRepository(selected.owner, selected.repo)),
    repository: new PostgresReviewGateRepository(pool, { lifecycleEvents: 'enabled', completionResolutionTimeoutMs: 15_000,
      incrementalMaxAgeMs, incrementalMaxChain, verdictCacheMaxAgeMs,
      ...(ciConfig ? { onEligibleCompletion: async (client, gate, now) => {
        if (findReviewCiEnrollment(ciConfig,
          { expectedAppId: gate.expectedAppId, repository: gate.coordinates })) {
          await enqueueReviewCiCompletionInTransaction(client, gate.coordinates.attemptId, now);
        }
      } } : {}),
    }),
    operatorPassthroughRepository,
    passthroughEnabled: dispatchConfig.passthroughEnabled,
    listPausedAdmissions: (limit, after) => operatorPassthroughRepository.listPausedAdmissions(
      configuredAuthoritativeRepositoryIds, configuredAuthoritativeAppIds, limit, after),
    getStoredPrepared: (policyDigest) => getPreparedPublishingPolicy(pool, policyDigest),
    workerId: `authoritative-review-${environment.HOSTNAME || 'local'}`,
  }) : undefined;
  const ci = ciConfig && authoritative ? createReviewCiRuntime({
    config: ciConfig, pool, appId, privateKey, baseUrl, resolver: authoritative.resolver,
    workerId: `review-ci-${environment.HOSTNAME || 'local'}`,
  }) : undefined;
  const repository = new PostgresReviewDispatchRepository(pool, undefined, { lifecycleEvents: 'enabled',
    ...(authoritative ? { validateAuthoritativeAdmission: authoritative.validateAdmission } : {}),
    ...(authoritative ? { retireOperatorPassthroughInTransaction: async (client, input, now) => {
      await operatorPassthroughRepository.retireInTransaction(client, {
        repositoryId: input.repositoryId, prNumber: input.identity.prNumber, headSha: input.identity.headSha,
      }, 'normal-review-admitted', now);
    } } : {}),
    ...(authoritative ? { resolveGenerationRecovery: async (input) => {
      if (!input.authoritativeGate || input.expectedGeneration === undefined) {
        throw new Error('Authoritative generation recovery identity is unavailable');
      }
      const minted = await getBoundedRepositoryToken({
        ...installationCredentialsForRepository(input.identity.owner, input.identity.repo),
      }, 'publish');
      return new GitHubInstallationClient({ token: minted.token, baseUrl }).readReviewGenerationRecovery({
        owner: input.identity.owner,
        repo: input.identity.repo,
        headSha: input.identity.headSha,
        runId: deriveReviewRunId(input.identity),
        expectedGeneration: input.expectedGeneration,
        expectedAppId: input.authoritativeGate.expectedAppId,
        ...(input.incompleteP2Recovery === true ? { incompleteP2Recovery: true as const } : {}),
        ...(input.gracefulComposedContinuation === true ? { gracefulComposedContinuation: true as const } : {}),
      });
    } } : {}),
    requireExpectedGeneration: dispatchConfig.requireExpectedGeneration,
  });
  const githubWebhook = webhookConfig ? {
    secret: webhookConfig.secret,
    onEvent: createGitHubWebhookAdmissionHandler({
      config: webhookConfig,
      admission: repository,
      currentPullRequestForClose: async ({ repositoryId, owner, repo, prNumber }) => {
        const minted = await getBoundedRepositoryToken(installationCredentialsForRepository(owner, repo), 'read');
        const reader = new AuthoritativeReviewReader({ token: minted.token, baseUrl });
        const current = await reader.currentCandidate({ repositoryId, owner, repo, prNumber });
        return { open: current.open };
      },
      ...(authoritative ? { currentPullRequestForPassthrough: async ({ repositoryId, owner, repo, prNumber }) =>
        authoritative.resolver.readCurrentCandidate({ repositoryId, owner, repo, prNumber }) } : {}),
      ...(authoritative ? { authoritativePublishing: authoritative.admission } : {}),
      storageInitialized: storageIsInitialized,
      mergeGroupGate: createMergeGroupGate({
        config: webhookConfig,
        repository: new PostgresMergeGroupGateRepository(pool),
        baseUrl,
        tokenFor: async (owner, repo) => (await getBoundedRepositoryToken({
          appId, privateKey, owner, repo, baseUrl,
        }, 'merge-group')).token,
        ...(dispatchConfig.passthroughEnabled === true && authoritative?.admission.recordOperatorPassthrough
          ? { ensureOperatorPassthrough: async (input) => {
            const current = await authoritative.resolver.readCurrentCandidate({ repositoryId: input.repositoryId,
              owner: input.owner, repo: input.repo, prNumber: input.prNumber });
            if (!current.open || current.draft || current.headSha !== input.headSha) return null;
            const requested = { repositoryId: current.repositoryId, owner: current.owner, repo: current.repo,
              prNumber: current.prNumber, headSha: current.headSha, baseSha: current.baseSha };
            const resolved = await authoritative.resolver.resolve(requested);
            const audit = { version: 'MergeGroupOperatorAdmission.v1', queueSnapshotDigest: input.queueSnapshotDigest,
              sourceDeliveryDigest: input.deliveryDigest, requested,
              currentPolicyDigest: resolved.prepared.policy.effectivePolicyDigest };
            const deliveryDigest = sha256(canonicalJson(audit));
            const deliveryPrefix = sha256(input.deliveryId).slice(0, 24);
            const publication = await authoritative.admission.recordOperatorPassthrough!({ requested,
              event: { transport: 'github-app', eventName: 'merge_group',
                deliveryId: `github-app:merge-group:${deliveryPrefix}:${input.prNumber}:${input.headSha}:${resolved.prepared.policy.effectivePolicyDigest}`,
                deliveryDigest } });
            return publication;
          } } : {}),
      }),
    }),
  } : undefined;
  const verifier = new GitHubActionsOidcVerifier({ policy });

  let mcpAuthenticator: McpAuthenticator | undefined;
  let mcpRateLimiter: SlidingWindowRateLimiter | undefined;
  let mcpRouter: RemoteMcpRouter | undefined;

  if (dispatchConfig.mcp.enabled) {
    mcpAuthenticator = new McpAuthenticator({
      staticAuthToken: dispatchConfig.mcp.authToken,
      oidcVerifier: verifier,
    });
    mcpRateLimiter = new SlidingWindowRateLimiter({
      windowMs: dispatchConfig.mcp.rateLimitWindowMs,
      maxRequests: dispatchConfig.mcp.rateLimitMax,
    });

    const modelClient = dispatchConfig.passthroughEnabled === true
      ? undefined
      : resolveModelClientFromEnv(environment);

    mcpRouter = createRemoteMcpRouter({
      db: pool,
      passthroughEnabled: dispatchConfig.passthroughEnabled,
      storageInitialized: storageIsInitialized,
      admissionRepository: repository,
      modelClient,
      triggerDeps: {
        passthroughEnabled: dispatchConfig.passthroughEnabled,
        storageInitialized: storageIsInitialized,
        authoritativePublishing: authoritative?.admission,
        resolveGitHubPullRequest: async (owner: string, repo: string, pullNumber: number) => {
          const credentials = installationCredentialsForRepository(owner, repo);
          const [minted, installationId] = await Promise.all([
            getBoundedRepositoryToken(credentials, 'read'),
            getBoundedRepositoryInstallationId(credentials),
          ]);
          const snapshot = await new GitHubInstallationClient({
            token: minted.token,
            baseUrl,
          }).getPullRequest(owner, repo, pullNumber);
          if (!snapshot.repositoryId) {
            throw new Error('GitHub pull request repository identity is unavailable');
          }
          return {
            headSha: snapshot.headSha,
            baseSha: snapshot.baseSha,
            repositoryId: snapshot.repositoryId,
            installationId,
          };
        },
      },
      authenticator: mcpAuthenticator,
      sessionTtlMs: dispatchConfig.mcp.sessionTtlMs,
      maxSessions: dispatchConfig.mcp.maxSessions,
    });
    logger.info('Remote MCP endpoint initialized', { path: dispatchConfig.mcp.path });
  }

  const app = createActionDispatchApp({
    verifier,
    admission: repository,
    allowAppGate: policy.allowAppGate,
    passthroughEnabled: dispatchConfig.passthroughEnabled,
    storageInitialized: storageIsInitialized,
    operatorPauseReadinessEnabled: dispatchConfig.passthroughEnabled === true,
    pauseDatabaseProbe: () => pauseDatabaseProbe,
    requireExpectedGeneration: dispatchConfig.requireExpectedGeneration,
    centralExternalRepositories: dispatchConfig.centralExternalRepositories,
    mcpConfig: dispatchConfig.mcp,
    mcpRouter,
    mcpAuthenticator,
    mcpRateLimiter,
    ...(ci ? { ci: ci.routes } : {}),
    ...(authoritative ? { authoritativePublishing: authoritative.admission,
      authoritativeWorkerCompletion: authoritative.completion } : {}),
    workerCompletion: {
      verifier: createWorkerCompletionVerifier(),
      repository,
      evidence: new PostgresWorkerCompletionStore(pool),
    },
    incrementalBase: new PostgresIncrementalBaseLookup(pool, { maxAgeMs: incrementalMaxAgeMs }),
    incompleteP2Recovery: pool,
    reviewCheckpoint: pool,
    findingThreads: {
      db: pool,
      transportFor: async (owner, repo) => {
        // Finding threads use the same repository-bound App as raw-check publication.
        const credentials = installationCredentialsForRepository(owner, repo);
        const [minted, botLogin] = await Promise.all([
          getBoundedRepositoryToken(credentials, 'review-threads'),
          findingThreadBotLogin(credentials),
        ]);
        return { token: minted.token, baseUrl, botLogin };
      },
    },
    prLifecycleHistory: pool,
    verdictCacheBase: new PostgresVerdictCacheBaseLookup(pool, { maxAgeMs: verdictCacheMaxAgeMs }),
    ...(providerLease ? { providerLease } : {}),
    databaseReady: async () => (await pool.query('SELECT 1 AS ready')).rows[0]?.ready === 1,
    resolveInstallationId: (owner, repo) => getBoundedRepositoryInstallationId(
      installationCredentialsForRepository(owner, repo)),
    metricsAuthToken: environment.ACTION_DISPATCH_METRICS_TOKEN?.trim() || undefined,
    ...(githubWebhook ? { githubWebhook } : {}),
  });
  // Admission credentials may belong to a different App. Only the worker-token
  // dispatcher reconciles legacy raw checks. The separately opted-in service
  // controller validates its authoritative App identity before it is constructed.
  let shuttingDown = false;
  let storageWorkStarted = false;
  let authoritativeTimer: NodeJS.Timeout | undefined;
  let ciTimer: NodeJS.Timeout | undefined;
  const probePauseDatabase = (): Promise<void> => {
    if (dispatchConfig.passthroughEnabled !== true || !storageInitialized || shuttingDown) return Promise.resolve();
    if (pauseDatabaseProbeInFlight) return pauseDatabaseProbeInFlight;
    pauseDatabaseProbe = { ...pauseDatabaseProbe, inProgress: true };
    let tracked: Promise<void>;
    const query = { text: 'SELECT 1 AS ready', query_timeout: 1_500 } as QueryConfig & { query_timeout: number };
    tracked = pool.query<{ ready: number }>(query).then((result) => {
      const ready = result.rows[0]?.ready === 1;
      pauseDatabaseProbe = { status: ready ? 'ready' : 'unavailable', databaseReady: ready,
        checkedAt: new Date().toISOString(), inProgress: false };
    }).catch(() => {
      pauseDatabaseProbe = { status: 'unavailable', databaseReady: false,
        checkedAt: new Date().toISOString(), inProgress: false };
    }).finally(() => {
      if (pauseDatabaseProbeInFlight === tracked) pauseDatabaseProbeInFlight = undefined;
    });
    pauseDatabaseProbeInFlight = tracked;
    return tracked;
  };
  const startPauseDatabaseProbe = () => {
    if (dispatchConfig.passthroughEnabled !== true || !storageInitialized || shuttingDown || pauseDatabaseProbeTimer) return;
    void probePauseDatabase();
    pauseDatabaseProbeTimer = setInterval(() => { void probePauseDatabase(); }, 10_000);
    pauseDatabaseProbeTimer.unref?.();
  };
  const startStorageDependentWork = () => {
    if (!storageInitialized || shuttingDown || storageWorkStarted) return;
    storageWorkStarted = true;
    authoritativeTimer = authoritative && authoritativeConfig ? setInterval(() => {
      void authoritative.runOnce().catch(() => logger.error('Authoritative review reconciliation unavailable'));
    }, authoritativeConfig.tickMs) : undefined;
    authoritativeTimer?.unref();
    ciTimer = ci && ciConfig ? setInterval(() => {
      void ci.runOnce().catch(() => logger.error('Review CI reconciliation unavailable'));
    }, ciConfig.tickMs) : undefined;
    ciTimer?.unref();
  };
  onStorageInitialized = () => {
    startStorageDependentWork();
    startPauseDatabaseProbe();
  };
  // If pause-mode storage finished while the route graph was constructed, start
  // its publisher/reconciliation only now. In ordinary mode this is immediate.
  startStorageDependentWork();
  startPauseDatabaseProbe();

  const server = app.listen(port, host, () => logger.info('Review Yeti Action dispatch service listening', { host, port }));

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Stopping Review Yeti Action dispatch service', { signal });
    if (authoritativeTimer) clearInterval(authoritativeTimer);
    if (ciTimer) clearInterval(ciTimer);
    if (pauseDatabaseProbeTimer) clearInterval(pauseDatabaseProbeTimer);
    if (mcpRateLimiter) mcpRateLimiter.close();
    if (mcpRouter) mcpRouter.destroy();
    server.close(() => {
      void (async () => {
        await storageInitializer?.stop();
        await pauseDatabaseProbeInFlight;
        await store.close();
        process.exit(0);
      })();
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error) => {
  logger.error('Action dispatch service failed to start', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
