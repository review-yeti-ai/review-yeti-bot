import * as k8s from '@kubernetes/client-node';
import { KubernetesReviewJobProjector } from './k8s/kubernetesReviewJobProjector';
import { ReviewJobDispatchEngine } from './k8s/reviewJobDispatchEngine';
import { KubernetesRunSecretProvisioner } from './k8s/kubernetesRunSecretProvisioner';
import {
  reviewJobDispatcherConfigFromEnv,
  runReviewJobDispatcherLoop,
} from './k8s/reviewJobDispatcherRuntime';
import { PostgresReviewDispatchRepository } from './persistence/reviewDispatchRepository';
import { PostgresStore } from './persistence/postgresStore';
import { logger } from './utils/logger';

async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = reviewJobDispatcherConfigFromEnv(environment);
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
  const appId = String(environment.GITHUB_APP_ID || '').trim();
  const privateKey = String(environment.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
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

  const engine = new ReviewJobDispatchEngine({
    repository: new PostgresReviewDispatchRepository(store.getPool()),
    projector: new KubernetesReviewJobProjector(customObjects),
    runSecretProvisioner,
    workerId: config.workerId,
    workerImage: config.workerImage,
    namespace: config.namespace,
    runnerMode: config.runnerMode,
  });
  const controller = new AbortController();
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
    await runReviewJobDispatcherLoop(engine, {
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
