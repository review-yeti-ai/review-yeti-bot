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

async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = reviewJobDispatcherConfigFromEnv(environment);
  // Exactly the credentials used to provision worker publish tokens. Admission
  // has no publishing ownership, even when it runs under another installed App.
  const appId = String(environment.GITHUB_APP_ID || '').trim();
  const privateKey = String(environment.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
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
    })
    : undefined;
  if (!runSecretProvisioner) {
    logger.warn('No GitHub App credentials: publishing (app-gate) reviews will be refused');
  }

  const repository = new PostgresReviewDispatchRepository(store.getPool());
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

  const completionRepository = new PostgresReviewCompletionRepository(store.getPool());
  const completionEngine = appId && privateKey
    ? new ReviewCompletionDeliveryEngine({
        repository: completionRepository,
        clientFactory: createGitHubAppCIRequestClientFactory(appId, privateKey),
        workerId: `${config.workerId}:completion`,
      })
    : undefined;

  const controller = new AbortController();
  const reaper = publisher ? new AbandonedRunReaper({
    repository,
    workerId: config.workerId,
    publisherAppId: publisher.id,
    // One attempt per loop keeps the sweep bounded without starving dispatch.
    limit: 1,
    checkClientFor: async (run, signal) => {
      const minted = await getGitHubAppRepositoryPublishToken({
        appId, privateKey, owner: run.owner, repo: run.repo, signal,
      });
      return new GitHubInstallationClient({ token: minted.token });
    },
  }) : undefined;
  const stop = (signal: 'SIGTERM' | 'SIGINT') => {
    logger.info('Stopping Review Yeti review job dispatcher', { signal });
    controller.abort();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  logger.info('Review Yeti review job dispatcher started', {
    workerId: config.workerId,
    namespace: config.namespace,
  });
  try {
    // Serial with dispatch and awaited through shutdown: no detached sweep may
    // publish after the DB pool closes. Failed publications retain a 60s lease.
    await runReviewJobDispatcherLoop({ runOnce: async () => {
      await reaper?.runOnce(controller.signal);
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
        if (outcome.status !== 'idle') logger.info('Review job dispatch cycle completed', outcome);
      },
      onCycleError: () => logger.warn('Review job dispatch cycle failed; applying bounded retry delay'),
    });
  } finally {
    await store.close();
  }
}

void main().catch(() => {
  logger.error('Review Yeti review job dispatcher failed to start');
  process.exitCode = 1;
});
