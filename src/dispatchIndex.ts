import { GitHubActionsOidcVerifier, githubActionsOidcPolicyFromEnv } from './auth/githubActionsOidc';
import { createActionDispatchApp } from './dispatchServer';
import { createWorkerCompletionVerifier } from './api/actionDispatchApi';
import { getBoundedRepositoryInstallationId, validateGitHubAppApiBaseUrl } from './github/boundedAppToken';
import { PostgresReviewDispatchRepository } from './persistence/reviewDispatchRepository';
import { PostgresReviewGateRepository } from './persistence/reviewGateRepository';
import { getPreparedPublishingPolicy } from './persistence/preparedReviewRepository';
import { AbandonedRunReaper } from './review/abandonedRunReaper';
import { GitHubInstallationClient } from './github/installationClient';
import { getGitHubAppRepositoryPublishToken } from './github/appAuth';
import { PostgresStore } from './persistence/postgresStore';
import { logger } from './utils/logger';
import { authoritativeServiceConfigFromEnv } from './auth/authoritativeServiceConfig';
import { createAuthoritativeReviewService } from './review/authoritativeReviewService';

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
  const store = new PostgresStore();
  await store.initialize();
  const pool = store.getPool();
  const authoritative = authoritativeConfig ? createAuthoritativeReviewService({
    config: authoritativeConfig, appId, privateKey, baseUrl,
    repository: new PostgresReviewGateRepository(pool, { completionResolutionTimeoutMs: 15_000 }),
    getStoredPrepared: (policyDigest) => getPreparedPublishingPolicy(pool, policyDigest),
    workerId: `authoritative-review-${environment.HOSTNAME || 'local'}`,
  }) : undefined;
  const repository = new PostgresReviewDispatchRepository(pool, undefined,
    authoritative ? { validateAuthoritativeAdmission: authoritative.validateAdmission } : undefined);
  const app = createActionDispatchApp({
    verifier: new GitHubActionsOidcVerifier({ policy }),
    admission: repository,
    allowAppGate: policy.allowAppGate,
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
  });
  // Legacy REL-586: the only component that creates the raw check is the worker, so any
  // failure before its pod starts leaves the head with no check at all -- on a
  // required gate, merges blocked with nothing red. This service is the right home
  // for the sweep: it already holds the App credentials and the database.
  const reaperIntervalMs = Number(environment.ACTION_DISPATCH_REAPER_INTERVAL_MS || 60_000);
  if (!Number.isSafeInteger(reaperIntervalMs) || reaperIntervalMs < 5_000) {
    throw new Error('ACTION_DISPATCH_REAPER_INTERVAL_MS must be at least 5000');
  }
  const reaper = new AbandonedRunReaper({
    repository,
    workerId: `action-dispatch-${environment.HOSTNAME || 'local'}`,
    // Minted per run: a token is scoped to one repository, so it cannot be reused
    // across the sweep.
    checkClientFor: async (run) => {
      const minted = await getGitHubAppRepositoryPublishToken({
        appId, privateKey, owner: run.owner, repo: run.repo, baseUrl,
      });
      return new GitHubInstallationClient({ token: minted.token, baseUrl });
    },
  });
  const reaperTimer = setInterval(() => {
    void reaper.runOnce().catch((error) => logger.error('Abandoned-run sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    }));
  }, reaperIntervalMs);
  // Never hold the process open for the sweep; shutdown clears it explicitly.
  reaperTimer.unref();
  const authoritativeTimer = authoritative && authoritativeConfig ? setInterval(() => {
    void authoritative.runOnce().catch(() => logger.error('Authoritative review reconciliation unavailable'));
  }, authoritativeConfig.tickMs) : undefined;
  authoritativeTimer?.unref();

  const port = Number(environment.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');
  const host = environment.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => logger.info('Review Yeti Action dispatch service listening', { host, port }));

  const shutdown = (signal: string) => {
    logger.info('Stopping Review Yeti Action dispatch service', { signal });
    clearInterval(reaperTimer);
    if (authoritativeTimer) clearInterval(authoritativeTimer);
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
