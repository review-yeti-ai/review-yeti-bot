import { createServer, type Server } from 'node:http';
import { getPrometheusMetrics } from './telemetry/metrics';

export interface DispatcherMetricsConfig {
  host: string;
  port: number;
}

export interface DispatcherMetricsServerOptions {
  collectMetrics?: () => Promise<string>;
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
    if (request.url !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found\n');
      return;
    }
    try {
      const metrics = await collectMetrics();
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
    server.listen(config.port, config.host);
  });
}

export async function closeDispatcherMetricsServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
