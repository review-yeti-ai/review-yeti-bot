import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { PostgresStore } from './persistence/postgresStore';
import { PostgresReviewEventRepository } from './persistence/reviewEventRepository';
import {
  JetStreamPublishClient,
  type ReviewEventPublishClient,
} from './events/jetStreamClient';
import {
  ReviewEventOutboxPublisher,
  runReviewEventPublisherLoop,
  type ReviewEventOutboxRepository,
} from './events/reviewEventOutboxPublisher';
import { natsConfigFromEnv, type NatsEventPublisherConfig } from './events/natsConfig';
import { logger } from './utils/logger';

type ReviewEventPublisherPool = ReturnType<PostgresStore['getPool']>;

interface ReviewEventPublisherStore {
  initialize(): Promise<void>;
  getPool(): ReviewEventPublisherPool;
  close(): Promise<void>;
}

export interface ReviewEventPublisherMainDependencies {
  createStore(): ReviewEventPublisherStore;
  createRepository(pool: ReviewEventPublisherPool): ReviewEventOutboxRepository;
  createClient(config: NatsEventPublisherConfig): ReviewEventPublishClient;
  scheduleForcedExit(milliseconds: number): () => void;
}

const DEFAULT_DEPENDENCIES: ReviewEventPublisherMainDependencies = {
  createStore: () => new PostgresStore(),
  createRepository: (pool) => new PostgresReviewEventRepository(pool),
  createClient: (config) => new JetStreamPublishClient(config),
  scheduleForcedExit: (milliseconds) => {
    const timer = setTimeout(() => {
      process.exitCode = 1;
      process.exit(1);
    }, milliseconds);
    return () => clearTimeout(timer);
  },
};

export function createReviewEventPublisherWorkerId(name: string): string {
  const incarnation = createHash('sha256')
    .update(hostname(), 'utf8')
    .update(':', 'utf8')
    .update(String(process.pid), 'utf8')
    .update(':', 'utf8')
    .update(randomBytes(16))
    .digest('hex')
    .slice(0, 16);
  return `${name.slice(0, 64)}:outbox:${incarnation}`;
}

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Partial<ReviewEventPublisherMainDependencies> = {},
): Promise<void> {
  const config = natsConfigFromEnv(environment);
  if (!config.enabled) {
    logger.info('Review Yeti lifecycle event publisher is disabled', { enabled: false });
    return;
  }

  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const store = dependencies.createStore();
  await store.initialize();
  const client = dependencies.createClient(config);
  const publisher = new ReviewEventOutboxPublisher({
    enabled: config.enabled,
    repository: dependencies.createRepository(store.getPool()),
    client,
    workerId: createReviewEventPublisherWorkerId(config.name),
    batchSize: config.batchSize,
    leaseMs: config.leaseMs,
    retryDelayMs: config.retryDelayMs,
  });
  const controller = new AbortController();
  let cancelForcedExit: (() => void) | undefined;
  const stop = (signal: 'SIGTERM' | 'SIGINT') => {
    if (controller.signal.aborted) return;
    logger.info('Stopping Review Yeti lifecycle event publisher', { signal });
    cancelForcedExit = dependencies.scheduleForcedExit(config.drainTimeoutMs);
    controller.abort();
  };
  const onSigterm = () => stop('SIGTERM');
  const onSigint = () => stop('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  let runFailed = false;
  let shutdownFailed = false;
  try {
    logger.info('Review Yeti lifecycle event publisher started', {
      enabled: true,
      serverCount: config.servers.length,
      batchSize: config.batchSize,
    });
    await runReviewEventPublisherLoop(publisher, {
      signal: controller.signal,
      pollIntervalMs: config.pollIntervalMs,
      onOutcome: (outcome) => {
        if (outcome.status !== 'idle') logger.info('Review Yeti lifecycle publication cycle completed', {
          status: outcome.status,
          claimed: outcome.claimed,
          published: outcome.published,
          failed: outcome.failed,
          released: outcome.released,
          leaseLost: outcome.leaseLost,
          errorCode: outcome.errorCode,
        });
      },
    });
  } catch {
    runFailed = true;
  } finally {
    try {
      try {
        await publisher.shutdown();
      } catch {
        shutdownFailed = true;
        logger.error('Review Yeti lifecycle event publisher transport shutdown failed');
        try {
          await client.close();
        } catch {
          logger.error('Review Yeti lifecycle event publisher transport close failed');
        }
      }
      try {
        await store.close();
      } catch {
        shutdownFailed = true;
        logger.error('Review Yeti lifecycle event publisher store shutdown failed');
      }
    } finally {
      cancelForcedExit?.();
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT', onSigint);
    }
  }

  if (runFailed || shutdownFailed) {
    process.exitCode = 1;
    throw new Error('Review event publisher shutdown failed');
  }
}

if (require.main === module) {
  void main().catch(() => {
    logger.error('Review Yeti lifecycle event publisher failed to start');
    process.exitCode = 1;
  });
}
