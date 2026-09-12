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
  let store: ReviewEventPublisherStore | undefined;
  let client: ReviewEventPublishClient | undefined;
  let publisher: ReviewEventOutboxPublisher | undefined;
  let cancelForcedExit: (() => void) | undefined;
  let onSigterm: (() => void) | undefined;
  let onSigint: (() => void) | undefined;

  let startupFailed = false;
  let startupError: unknown;
  let runFailed = false;
  let shutdownFailed = false;
  let publisherShutdown = false;
  try {
    const initializedStore = dependencies.createStore();
    store = initializedStore;
    await initializedStore.initialize();

    const initializedClient = dependencies.createClient(config);
    client = initializedClient;
    const repository = dependencies.createRepository(initializedStore.getPool());
    publisher = new ReviewEventOutboxPublisher({
      enabled: config.enabled,
      repository,
      client: initializedClient,
      workerId: createReviewEventPublisherWorkerId(config.name),
      batchSize: config.batchSize,
      leaseMs: config.leaseMs,
      retryDelayMs: config.retryDelayMs,
    });

    const controller = new AbortController();
    const stop = (signal: 'SIGTERM' | 'SIGINT') => {
      if (controller.signal.aborted) return;
      logger.info('Stopping Review Yeti lifecycle event publisher', { signal });
      cancelForcedExit = dependencies.scheduleForcedExit(config.drainTimeoutMs);
      controller.abort();
    };
    onSigterm = () => stop('SIGTERM');
    onSigint = () => stop('SIGINT');
    process.once('SIGTERM', onSigterm);
    process.once('SIGINT', onSigint);

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
    }
  } catch (error) {
    startupFailed = true;
    startupError = error;
  } finally {
    try {
      if (publisher) {
        try {
          await publisher.shutdown();
          publisherShutdown = true;
        } catch {
          shutdownFailed = true;
          logger.error('Review Yeti lifecycle event publisher transport shutdown failed');
        }
      }

      if (client && !publisherShutdown) {
        try {
          await client.close();
        } catch {
          shutdownFailed = true;
          logger.error('Review Yeti lifecycle event publisher transport close failed');
        }
      }

      if (store) {
        try {
          await store.close();
        } catch {
          shutdownFailed = true;
          logger.error('Review Yeti lifecycle event publisher store shutdown failed');
        }
      }
    } finally {
      try {
        cancelForcedExit?.();
      } catch {
        shutdownFailed = true;
        logger.error('Review Yeti lifecycle event publisher watchdog cancellation failed');
      }
      if (onSigterm) process.removeListener('SIGTERM', onSigterm);
      if (onSigint) process.removeListener('SIGINT', onSigint);
    }
  }

  if (startupFailed) throw startupError;
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
