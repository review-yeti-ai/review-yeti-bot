import { GitHubActionsOidcVerifier, githubActionsOidcPolicyFromEnv } from './auth/githubActionsOidc';
import { createActionDispatchApp } from './dispatchServer';
import { createWorkerCompletionVerifier } from './api/actionDispatchApi';
import {
  getBoundedRepositoryInstallationId, getBoundedRepositoryToken, validateGitHubAppApiBaseUrl,
} from './github/boundedAppToken';
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
import { createReviewCiRuntime } from './review/reviewCiRuntime';

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Action dispatch service`);
  return value;
}

async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (environment.ACTION_DISPATCH_ENABLED !== 'true') {
    throw new Error('ACTION_DISPATCH_ENABLED must be true for the dedicated Action dispatch service');
  }
  const policy = githubActionsOidcPolicyFromEnv(environment);
  const appId = required(environment, 'GITHUB_APP_ID');
  const privateKey = required(environment, 'GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n');
  const baseUrl = validateGitHubAppApiBaseUrl(environment.GITHUB_API_BASE_URL);
  const authoritativeConfig = authoritativeServiceConfigFromEnv(environment, policy);
  const webhookConfig = githubWebhookConfigFromEnv(environment, policy);
  const ciConfig = reviewCiConfigFromEnv(environment, authoritativeConfig);
  const store = new PostgresStore();
  await store.initialize();
  const pool = store.getPool();
  const authoritative = authoritativeConfig ? createAuthoritativeReviewService({
    config: authoritativeConfig, appId, privateKey, baseUrl,
    repository: new PostgresReviewGateRepository(pool, { completionResolutionTimeoutMs: 15_000,
      ...(ciConfig ? { onEligibleCompletion: async (client, gate, now) => {
        const enrolled = ciConfig.repositories.find((r) => r.repositoryId === gate.coordinates.repositoryId
          && r.owner === gate.coordinates.owner && r.repo === gate.coordinates.repo);
        if (enrolled && ciConfig.expectedAppId === gate.expectedAppId) {
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
  const repository = new PostgresReviewDispatchRepository(pool, undefined,
    authoritative ? { validateAuthoritativeAdmission: authoritative.validateAdmission } : undefined);
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
  const app = createActionDispatchApp({
    verifier: new GitHubActionsOidcVerifier({ policy }),
    admission: repository,
    allowAppGate: policy.allowAppGate,
    ...(ci ? { ci: ci.routes } : {}),
    ...(authoritative ? { authoritativePublishing: authoritative.admission,
      authoritativeWorkerCompletion: authoritative.completion } : {}),
    workerCompletion: {
      verifier: createWorkerCompletionVerifier(),
      repository,
    },
    databaseReady: async () => (await pool.query('SELECT 1 AS ready')).rows[0]?.ready === 1,
    resolveInstallationId: (owner, repo) => getBoundedRepositoryInstallationId({
      appId,
      privateKey,
      owner,
      repo,
      baseUrl,
    }),
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
