import * as k8s from '@kubernetes/client-node';
import { KubernetesReviewJobProjector } from './k8s/kubernetesReviewJobProjector';
import { ReviewJobDispatchEngine } from './k8s/reviewJobDispatchEngine';
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
  const engine = new ReviewJobDispatchEngine({
    repository: new PostgresReviewDispatchRepository(store.getPool()),
    projector: new KubernetesReviewJobProjector(customObjects),
    workerId: config.workerId,
    workerImage: config.workerImage,
    namespace: config.namespace,
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
