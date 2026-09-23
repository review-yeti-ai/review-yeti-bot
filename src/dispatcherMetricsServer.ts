import { createServer, type Server } from 'node:http';
import { getPrometheusMetrics } from './telemetry/metrics';

export interface DispatcherMetricsConfig {
  host: string;
  port: number;
}

export interface DispatcherMetricsServerOptions {
  collectMetrics?: () => Promise<string>;
  collectionTimeoutMs?: number;
  /** REL-1053: this pod's own dispatch-loop progress, served on `/ready`. */
  loopHealth?: DispatcherLoopHealth;
}

const DEFAULT_READY_STALE_AFTER_MS = 120_000;

export interface DispatcherReadiness {
  ready: boolean;
  reason: 'ok' | 'starting' | 'stalled' | 'stopping';
  workerId: string;
  lastCycleAgeMs?: number;
}

/**
 * REL-1053: per-pod readiness for the review job dispatcher.
 *
 * `/health` answers "is this process serving HTTP" and stays the liveness
 * signal. With several replicas, each pod also needs to report whether its
 * own dispatch loop is making progress, so a pod whose loop has wedged (or
 * has not finished its first cycle, or is shutting down) leaves the Service
 * and fails a RollingUpdate. A stalled pod is not killed for this: it holds
 * no claim beyond its lease, so the other replicas keep draining the queue.
 *
 * Any completed cycle counts as progress, including one that failed and is
 * backing off. A database outage makes every replica fail cycles equally,
 * and reporting that as "not ready" would only hide the pods' metrics.
 */
export class DispatcherLoopHealth {
  private lastCycleAt: number | undefined;
  private stopping = false;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  constructor(readonly workerId: string, options: { staleAfterMs?: number; now?: () => number } = {}) {
    if (!workerId.trim()) throw new Error('dispatcher loop health requires the pod worker id');
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_READY_STALE_AFTER_MS;
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs < 1_000) {
      throw new Error('dispatcher readiness staleness bound must be at least 1000 ms');
    }
    this.now = options.now ?? Date.now;
  }

  markCycle(): void {
    this.lastCycleAt = this.now();
  }

  markStopping(): void {
    this.stopping = true;
  }

  snapshot(): DispatcherReadiness {
    if (this.stopping) return { ready: false, reason: 'stopping', workerId: this.workerId };
    if (this.lastCycleAt === undefined) return { ready: false, reason: 'starting', workerId: this.workerId };
    const lastCycleAgeMs = Math.max(0, this.now() - this.lastCycleAt);
    return lastCycleAgeMs > this.staleAfterMs
      ? { ready: false, reason: 'stalled', workerId: this.workerId, lastCycleAgeMs }
      : { ready: true, reason: 'ok', workerId: this.workerId, lastCycleAgeMs };
  }
}

const DEFAULT_COLLECTION_TIMEOUT_MS = 2_000;

function metricsCollectionTimeoutMs(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_COLLECTION_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('dispatcher metrics collection timeout must be 1-30000 ms');
  }
  return timeoutMs;
}

async function collectMetricsWithinTimeout(
  collectMetrics: () => Promise<string>,
  timeoutMs: number,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const collection = Promise.resolve().then(() => collectMetrics());
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('dispatcher metrics collection timed out')), timeoutMs);
    });
    return await Promise.race([collection, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface DispatcherMetricsEnvironment {
  [key: string]: string | undefined;
  REVIEW_JOB_METRICS_HOST?: string;
  REVIEW_JOB_METRICS_PORT?: string;
}

export function dispatcherMetricsConfigFromEnv(
  environment: DispatcherMetricsEnvironment = process.env,
): DispatcherMetricsConfig {
  const rawPort = environment.REVIEW_JOB_METRICS_PORT?.trim() || '9090';
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('REVIEW_JOB_METRICS_PORT must be a valid TCP port');
  }
  return {
    host: environment.REVIEW_JOB_METRICS_HOST?.trim() || '0.0.0.0',
    port,
  };
}

export function createDispatcherMetricsServer(options: DispatcherMetricsServerOptions = {}): Server {
  const collectMetrics = options.collectMetrics || getPrometheusMetrics;
  const collectionTimeoutMs = metricsCollectionTimeoutMs(options.collectionTimeoutMs);
  let inFlightCollection: Promise<string> | undefined;
  const collectMetricsSingleFlight = (): Promise<string> => {
    if (inFlightCollection) return inFlightCollection;
    const collection = Promise.resolve().then(() => collectMetrics());
    inFlightCollection = collection;
    const clear = () => {
      if (inFlightCollection === collection) inFlightCollection = undefined;
    };
    void collection.then(clear, clear);
    return collection;
  };
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Method Not Allowed\n');
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'ok', service: 'review-yeti-job-dispatcher' }));
      return;
    }
    if (request.url === '/ready') {
      // No loop wired means readiness cannot be judged; fail closed.
      const readiness = options.loopHealth?.snapshot()
        ?? { ready: false, reason: 'starting', workerId: 'unknown' };
      response.writeHead(readiness.ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ service: 'review-yeti-job-dispatcher', ...readiness }));
      return;
    }
    if (request.url !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found\n');
      return;
    }
    try {
      const metrics = await collectMetricsWithinTimeout(collectMetricsSingleFlight, collectionTimeoutMs);
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8; version=0.0.4' });
      response.end(metrics);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('# Error generating metrics\n');
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.maxConnections = 20;
  return server;
}

export async function listenDispatcherMetricsServer(
  server: Server,
  config: DispatcherMetricsConfig,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(config.port, config.host);
    } catch (error) {
      server.off('error', onError);
      server.off('listening', onListening);
      reject(error);
    }
  });
}

export async function closeDispatcherMetricsServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
