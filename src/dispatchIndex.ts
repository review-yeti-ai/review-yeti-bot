import { GitHubActionsOidcVerifier, githubActionsOidcPolicyFromEnv } from './auth/githubActionsOidc';
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
import { PostgresReviewDispatchRepository } from './persistence/reviewDispatchRepository';
import { PostgresReviewGateRepository } from './persistence/reviewGateRepository';
import { enqueueReviewCiCompletionInTransaction } from './persistence/reviewCiRepository';
import { getPreparedPublishingPolicy } from './persistence/preparedReviewRepository';
import { PostgresStore } from './persistence/postgresStore';
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
  const privateKey = required(environment, 'GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n');
  const baseUrl = validateGitHubAppApiBaseUrl(environment.GITHUB_API_BASE_URL);
  // External dispatch needs only an App installation lookup. Token minting for
  // publishing, merge groups, and MCP remains bound to the primary service App.
  const installationCredentialsForRepository = (owner: string, repo: string) => {
    const external = dispatchConfig.centralExternalAppCredentials;
    return external && dispatchConfig.centralExternalRepositories.has(`${owner}/${repo}`)
      ? { ...external, owner, repo, baseUrl }
      : { appId, privateKey, owner, repo, baseUrl };
  };
  const authoritativeConfig = authoritativeServiceConfigFromEnv(environment, policy);
  const webhookConfig = githubWebhookConfigFromEnv(environment, policy);
  const ciConfig = reviewCiConfigFromEnv(environment, authoritativeConfig);
  const store = new PostgresStore();
  await store.initialize();
  const pool = store.getPool();
  const authoritative = authoritativeConfig ? createAuthoritativeReviewService({
    config: authoritativeConfig, appId, privateKey, baseUrl,
    repository: new PostgresReviewGateRepository(pool, { lifecycleEvents: 'enabled', completionResolutionTimeoutMs: 15_000,
      ...(ciConfig ? { onEligibleCompletion: async (client, gate, now) => {
        if (findReviewCiEnrollment(ciConfig,
          { expectedAppId: gate.expectedAppId, repository: gate.coordinates })) {
          await enqueueReviewCiCompletionInTransaction(client, gate.coordinates.attemptId, now);
        }
      } } : {}),
    }),
    getStoredPrepared: (policyDigest) => getPreparedPublishingPolicy(pool, policyDigest),
    workerId: `authoritative-review-${environment.HOSTNAME || 'local'}`,
  }) : undefined;
  const ci = ciConfig && authoritative ? createReviewCiRuntime({
    config: ciConfig, pool, appId, privateKey, baseUrl, resolver: authoritative.resolver,
    workerId: `review-ci-${environment.HOSTNAME || 'local'}`,
  }) : undefined;
  const repository = new PostgresReviewDispatchRepository(pool, undefined, { lifecycleEvents: 'enabled',
    ...(authoritative ? { validateAuthoritativeAdmission: authoritative.validateAdmission } : {}),
    ...(authoritative ? { resolveGenerationRecovery: async (input) => {
      if (!input.authoritativeGate || input.expectedGeneration === undefined) {
        throw new Error('Authoritative generation recovery identity is unavailable');
      }
      const minted = await getBoundedRepositoryToken({
        appId, privateKey, owner: input.identity.owner, repo: input.identity.repo, baseUrl,
      }, 'publish');
      return new GitHubInstallationClient({ token: minted.token, baseUrl }).readReviewGenerationRecovery({
        owner: input.identity.owner,
        repo: input.identity.repo,
        headSha: input.identity.headSha,
        runId: deriveReviewRunId(input.identity),
        expectedGeneration: input.expectedGeneration,
        expectedAppId: input.authoritativeGate.expectedAppId,
      });
    } } : {}),
    requireExpectedGeneration: dispatchConfig.requireExpectedGeneration,
  });
  const githubWebhook = webhookConfig ? {
    secret: webhookConfig.secret,
    onEvent: createGitHubWebhookAdmissionHandler({
      config: webhookConfig,
      admission: repository,
      ...(authoritative ? { authoritativePublishing: authoritative.admission } : {}),
      mergeGroupGate: createMergeGroupGate({
        config: webhookConfig,
        repository: new PostgresMergeGroupGateRepository(pool),
        baseUrl,
        tokenFor: async (owner, repo) => (await getBoundedRepositoryToken({
          appId, privateKey, owner, repo, baseUrl,
        }, 'merge-group')).token,
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

    const modelClient = resolveModelClientFromEnv(environment);

    mcpRouter = createRemoteMcpRouter({
      db: pool,
      admissionRepository: repository,
      modelClient,
      triggerDeps: {
        authoritativePublishing: authoritative?.admission,
        resolveGitHubPullRequest: async (owner: string, repo: string, pullNumber: number) => {
          const credentials = { appId, privateKey, owner, repo, baseUrl };
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
    databaseReady: async () => (await pool.query('SELECT 1 AS ready')).rows[0]?.ready === 1,
    resolveInstallationId: (owner, repo) => getBoundedRepositoryInstallationId(
      installationCredentialsForRepository(owner, repo)),
    metricsAuthToken: environment.ACTION_DISPATCH_METRICS_TOKEN?.trim() || undefined,
    ...(githubWebhook ? { githubWebhook } : {}),
  });
  // Admission credentials may belong to a different App. Only the worker-token
  // dispatcher reconciles legacy raw checks. The separately opted-in service
  // controller validates its authoritative App identity before it is constructed.
  const authoritativeTimer = authoritative && authoritativeConfig ? setInterval(() => {
    void authoritative.runOnce().catch(() => logger.error('Authoritative review reconciliation unavailable'));
  }, authoritativeConfig.tickMs) : undefined;
  authoritativeTimer?.unref();
  const ciTimer = ci && ciConfig ? setInterval(() => {
    void ci.runOnce().catch(() => logger.error('Review CI reconciliation unavailable'));
  }, ciConfig.tickMs) : undefined;
  ciTimer?.unref();

  const port = Number(environment.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');
  const host = environment.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => logger.info('Review Yeti Action dispatch service listening', { host, port }));

  const shutdown = (signal: string) => {
    logger.info('Stopping Review Yeti Action dispatch service', { signal });
    if (authoritativeTimer) clearInterval(authoritativeTimer);
    if (ciTimer) clearInterval(ciTimer);
    if (mcpRateLimiter) mcpRateLimiter.close();
    if (mcpRouter) mcpRouter.destroy();
    server.close(() => void store.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

void main().catch((error) => {
  logger.error('Action dispatch service failed to start', { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
