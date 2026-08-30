import { GitHubActionsOidcVerifier, githubActionsOidcPolicyFromEnv } from './auth/githubActionsOidc';
import { createActionDispatchApp } from './dispatchServer';
import { getGitHubAppInstallationIdForRepository } from './github/appAuth';
import { PostgresReviewDispatchRepository } from './persistence/reviewDispatchRepository';
import { PostgresStore } from './persistence/postgresStore';
import { logger } from './utils/logger';

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for the Action dispatch service`);
  return value;
}

async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (environment.ACTION_DISPATCH_ENABLED !== 'true') {
    throw new Error('ACTION_DISPATCH_ENABLED must be true for the dedicated Action dispatch service');
  }
  const store = new PostgresStore();
  await store.initialize();
  const pool = store.getPool();
  const policy = githubActionsOidcPolicyFromEnv(environment);
  if (policy.allowAppGate) throw new Error('the qualification dispatch service requires ACTION_DISPATCH_ALLOW_APP_GATE=false');
  const appId = required(environment, 'GITHUB_APP_ID');
  const privateKey = required(environment, 'GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n');
  const baseUrl = environment.GITHUB_API_BASE_URL || 'https://api.github.com';
  const app = createActionDispatchApp({
    verifier: new GitHubActionsOidcVerifier({ policy }),
    admission: new PostgresReviewDispatchRepository(pool),
    allowAppGate: false,
    databaseReady: async () => (await pool.query('SELECT 1 AS ready')).rows[0]?.ready === 1,
    resolveInstallationId: (owner, repo) => getGitHubAppInstallationIdForRepository({
      appId,
      privateKey,
      owner,
      repo,
      baseUrl,
    }),
  });
  const port = Number(environment.PORT || 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be a valid TCP port');
  const host = environment.HOST || '0.0.0.0';
  const server = app.listen(port, host, () => logger.info('Review Yeti Action dispatch service listening', { host, port }));

  const shutdown = (signal: string) => {
    logger.info('Stopping Review Yeti Action dispatch service', { signal });
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
