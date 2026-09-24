import * as k8s from '@kubernetes/client-node';
import { KubernetesReviewJobProjector } from './k8s/kubernetesReviewJobProjector';
import { ReviewJobDispatchEngine } from './k8s/reviewJobDispatchEngine';
import { KubernetesRunSecretProvisioner } from './k8s/kubernetesRunSecretProvisioner';
import {
  reviewJobDispatcherConfigFromEnv,
  runReviewJobDispatcherLoop,
} from './k8s/reviewJobDispatcherRuntime';
import { PostgresReviewDispatchRepository } from './persistence/reviewDispatchRepository';
import { PostgresReviewCompletionRepository } from './persistence/reviewCompletionRepository';
import { ReviewCompletionDeliveryEngine } from './k8s/reviewCompletionDeliveryEngine';
import {
  createGitHubAppCIRequestClientFactory,
} from './k8s/reviewCompletionDeliveryRuntime';
import { PostgresStore } from './persistence/postgresStore';
import { getPreparedPublishingPolicy } from './persistence/preparedReviewRepository';
import { parsePreparedReviewExecution } from './review/preparedPublishingPolicy';
import { logger } from './utils/logger';
import { getGitHubAppIdentity, getGitHubAppRepositoryPublishToken } from './github/appAuth';
import { GitHubInstallationClient } from './github/installationClient';
import { AbandonedRunReaper } from './review/abandonedRunReaper';
import { DelegatedFailureReader } from './k8s/delegatedFailureReader';
import { initTelemetry } from './telemetry';
import { centralExternalTargetConfigFromEnv } from './config/actionDispatchConfig';
import {
  closeDispatcherMetricsServer,
  createDispatcherMetricsServer,
  DispatcherLoopHealth,
  dispatcherMetricsConfigFromEnv,
  listenDispatcherMetricsServer,
} from './dispatcherMetricsServer';

async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = reviewJobDispatcherConfigFromEnv(environment);
  // REL-1053: config.workerId is `review-job-dispatcher:<pod name>`, unique per
  // replica and the same identity this pod writes as a lease owner, so its
  // pushed metrics never collide with another replica's.
  initTelemetry('ct-review-job-dispatcher', { serviceInstanceId: config.workerId });
  const metricsConfig = dispatcherMetricsConfigFromEnv(environment);
  // Exactly the credentials used to provision worker publish tokens. Admission
  // has no publishing ownership, even when it runs under another installed App.
  const appId = String(environment.GITHUB_APP_ID || '').trim();
  const privateKey = String(environment.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  const external = centralExternalTargetConfigFromEnv(environment);
  const credentialsForRepository = (owner: string, repo: string) => {
    const dedicated = external.appCredentials;
    return dedicated && external.repositories.has(`${owner}/${repo}`)
      ? dedicated
      : { appId, privateKey };
  };
  const publisherAppIdForRepository = (owner: string, repo: string): number =>
    Number(credentialsForRepository(owner, repo).appId);
  const publisher = appId && privateKey ? await getGitHubAppIdentity({ appId, privateKey }) : undefined;
  const store = new PostgresStore();
  await store.initialize();

  const kubeConfig = new k8s.KubeConfig();
  kubeConfig.loadFromCluster();
  const customObjects = kubeConfig.makeApiClient(k8s.CustomObjectsApi);

  // Only constructed when App credentials are present. Absent, the engine refuses
  // app-gate dispatches outright rather than projecting a Job whose worker could
  // never publish -- and because that lane fails closed, an unpublishable worker
  // would surface as a failed check on the pull request rather than a dispatch
  // error anyone would look at.
  const runSecretProvisioner = appId && privateKey
    ? new KubernetesRunSecretProvisioner({
      // Thin adapter rather than widening CoreSecretClient: the generated client
      // types `body` as V1Secret, and loosening our interface to match would make
      // it unusable as a test double.
      client: (() => {
        const core = kubeConfig.makeApiClient(k8s.CoreV1Api);
        return {
          createNamespacedSecret: (request: {
            namespace: string;
            body: unknown;
            fieldManager: string;
            fieldValidation: 'Strict';
          }) => core.createNamespacedSecret({
            namespace: request.namespace,
            body: request.body as k8s.V1Secret,
            fieldManager: request.fieldManager,
            fieldValidation: request.fieldValidation,
          }),
          readNamespacedSecret: (request: { namespace: string; name: string }) =>
            core.readNamespacedSecret({ namespace: request.namespace, name: request.name }),
          deleteNamespacedSecret: (request: { namespace: string; name: string }) =>
            core.deleteNamespacedSecret({ namespace: request.namespace, name: request.name }),
        };
      })(),
      appId,
      privateKey,
      credentialsForRepository,
    })
    : undefined;
  if (!runSecretProvisioner) {
    logger.warn('No GitHub App credentials: publishing (app-gate) reviews will be refused');
  }

  const repository = new PostgresReviewDispatchRepository(store.getPool(), undefined, { lifecycleEvents: 'enabled' });
  const engine = new ReviewJobDispatchEngine({
    repository,
    projector: new KubernetesReviewJobProjector(customObjects),
    runSecretProvisioner,
    workerId: config.workerId,
    workerImage: config.workerImage,
    namespace: config.namespace,
    runnerMode: config.runnerMode,
    preparedReviewFor: async (claim) => {
      const prepared = await getPreparedPublishingPolicy(store.getPool(), claim.policyDigest);
      if (!prepared || prepared.policy.effectiveConfigDigest !== claim.configDigest) {
        throw new Error('Admitted prepared review policy is unavailable');
      }
      const json = JSON.stringify({ version: 'PreparedReviewExecution.v1',
        config: prepared.config, transport: prepared.transport });
      parsePreparedReviewExecution(json, claim.configDigest);
      return json;
    },
  });

  const completionRepository = new PostgresReviewCompletionRepository(store.getPool(), { lifecycleEvents: 'enabled' });
  const completionEngine = appId && privateKey
    ? new ReviewCompletionDeliveryEngine({
        repository: completionRepository,
        clientFactory: createGitHubAppCIRequestClientFactory(appId, privateKey),
        workerId: `${config.workerId}:completion`,
      })
    : undefined;

  const controller = new AbortController();
  // REL-896: reads the Go operator's delegated-failure signal directly off the
  // PRReviewJob CR so the reaper can claim before terminal_deadline. Fails
  // soft on its own (see DelegatedFailureReader) -- a missing `list` RBAC
  // grant or any other list error degrades to the pre-REL-896 deadline-only
  // path, never to a crash.
  const delegatedFailureReader = new DelegatedFailureReader({
    client: customObjects,
    namespace: config.namespace,
    pollIntervalMs: config.delegatedFailurePollMs,
  });
  const reaper = publisher ? new AbandonedRunReaper({
    repository,
    workerId: config.workerId,
    publisherAppId: publisher.id,
    publisherAppIdFor: (run) => publisherAppIdForRepository(run.owner, run.repo),
    // REL-896: defaults to 1 (see f84caf14 -- "One attempt per loop keeps the
    // sweep bounded without starving dispatch"). The reaper is awaited
    // serially before the dispatch engine on every loop, and each reap mints
    // a publish token and calls GitHub, so a larger default would add
    // unbounded per-loop latency ahead of dispatch. Now env-tunable via
    // REVIEW_ABANDONED_REAPER_LIMIT (clamped to [1, 100]) so an operator can
    // raise it temporarily to drain a large backlog after an outage, without
    // a code change.
    limit: config.abandonedReaperLimit,
    delegatedFailureReader,
    checkClientFor: async (run, signal) => {
      const credentials = credentialsForRepository(run.owner, run.repo);
      const minted = await getGitHubAppRepositoryPublishToken({
        ...credentials, owner: run.owner, repo: run.repo, signal,
      });
      return new GitHubInstallationClient({ token: minted.token });
    },
  }) : undefined;
  const loopHealth = new DispatcherLoopHealth(config.workerId);
  const stop = (signal: 'SIGTERM' | 'SIGINT') => {
    logger.info('Stopping Review Yeti review job dispatcher', { signal });
    loopHealth.markStopping();
    controller.abort();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  const metricsServer = createDispatcherMetricsServer({ loopHealth });
  try {
    await listenDispatcherMetricsServer(metricsServer, metricsConfig);
    logger.info('Review Yeti review job dispatcher started', {
      workerId: config.workerId,
      namespace: config.namespace,
      metricsHost: metricsConfig.host,
      metricsPort: metricsConfig.port,
    });
    // Serial with dispatch and awaited through shutdown: no detached sweep may
    // publish after the DB pool closes. Failed publications retain a 60s lease.
    await runReviewJobDispatcherLoop({ runOnce: async () => {
      await reaper?.runOnce(controller.signal);
      if (controller.signal.aborted) return { status: 'idle' };
      try {
        const sweep = await engine.sweepPendingCancellations();
        if (sweep.failed > 0) {
          logger.warn('Review cancellation sweep could not cancel superseded PRReviewJobs', {
            propagated: sweep.propagated,
            failed: sweep.failed,
            failures: sweep.failures,
          });
        }
      } catch (cancelErr) {
        logger.warn('Review cancellation sweep failed; continuing dispatch cycle', {
          error: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
        });
      }
      if (controller.signal.aborted) return { status: 'idle' };
      const dispatchOutcome = await engine.runOnce();
      if (controller.signal.aborted) return dispatchOutcome;
      if (completionEngine) {
        try {
          const completionOutcome = await completionEngine.runOnce();
          if (completionOutcome.status !== 'idle') {
            logger.info('Review completion delivery cycle completed', completionOutcome);
          }
        } catch (completionErr) {
          logger.warn('Review completion delivery cycle failed; applying bounded retry delay', {
            error: completionErr instanceof Error ? completionErr.message : String(completionErr),
          });
        }
      }
      return dispatchOutcome;
    } }, {
      signal: controller.signal,
      idleDelayMs: config.idleDelayMs,
      activeDelayMs: config.activeDelayMs,
      errorDelayMs: config.errorDelayMs,
      onOutcome: (outcome) => {
        loopHealth.markCycle();
        if (outcome.status !== 'idle') logger.info('Review job dispatch cycle completed', outcome);
      },
      onCycleError: (outcome) => {
        loopHealth.markCycle();
        logger.warn(
          'Review job dispatch cycle failed; applying bounded retry delay',
          outcome.errorCode ? { errorCode: outcome.errorCode } : undefined,
        );
      },
    });
  } finally {
    try {
      await closeDispatcherMetricsServer(metricsServer);
    } finally {
      await store.close();
    }
  }
}

void main().catch(() => {
  logger.error('Review Yeti review job dispatcher failed to start');
  process.exitCode = 1;
});
