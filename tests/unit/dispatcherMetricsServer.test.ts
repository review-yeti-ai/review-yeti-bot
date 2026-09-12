import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  closeDispatcherMetricsServer,
  createDispatcherMetricsServer,
  dispatcherMetricsConfigFromEnv,
  listenDispatcherMetricsServer,
} from '../../src/dispatcherMetricsServer';
import { getMetrics, initTelemetry } from '../../src/telemetry';

function metricValue(text: string, name: string): number {
  const line = text.split('\n').find((entry) => entry.startsWith(`${name} `));
  if (!line) throw new Error(`missing metric ${name}`);
  return Number(line.slice(name.length + 1));
}

describe('review job dispatcher metrics server', () => {
  it('uses a bounded internal default and rejects invalid ports', () => {
    expect(dispatcherMetricsConfigFromEnv({})).toEqual({ host: '0.0.0.0', port: 9090 });
    expect(dispatcherMetricsConfigFromEnv({ REVIEW_JOB_METRICS_HOST: '127.0.0.1',
      REVIEW_JOB_METRICS_PORT: '9191' })).toEqual({ host: '127.0.0.1', port: 9191 });
    for (const value of ['0', '65536', '1.5', 'not-a-port']) {
      expect(() => dispatcherMetricsConfigFromEnv({ REVIEW_JOB_METRICS_PORT: value }))
        .toThrow('REVIEW_JOB_METRICS_PORT must be a valid TCP port');
    }
  });

  it('rejects an unbounded or invalid collection timeout', () => {
    for (const collectionTimeoutMs of [0, -1, 1.5, Number.NaN, 30_001]) {
      expect(() => createDispatcherMetricsServer({ collectionTimeoutMs }))
        .toThrow('dispatcher metrics collection timeout must be 1-30000 ms');
    }
  });

  it('serves health and only the two internal GET routes', async () => {
    const server = createDispatcherMetricsServer({ collectMetrics: async () => 'metric 1\n' });
    expect(server.requestTimeout).toBe(5_000);
    expect(server.headersTimeout).toBe(5_000);
    expect(server.keepAliveTimeout).toBe(5_000);
    expect(server.maxRequestsPerSocket).toBe(100);
    expect(server.maxConnections).toBe(20);
    await request(server).get('/health').expect(200, { status: 'ok', service: 'review-yeti-job-dispatcher' });
    await request(server).get('/metrics').expect('Content-Type', /version=0\.0\.4/).expect(200, 'metric 1\n');
    await request(server).get('/private').expect(404, 'Not Found\n');
    await request(server).post('/metrics').expect('Allow', 'GET').expect(405, 'Method Not Allowed\n');
  });

  it('exports increments from the dispatcher process that owns reaper counters', async () => {
    initTelemetry('ct-review-job-dispatcher-test');
    const server = createDispatcherMetricsServer();
    const before = await request(server).get('/metrics').expect(200);
    getMetrics().reviewReaperDeliveryIdentityMismatches.add(1);
    getMetrics().reviewReaperSupersededAttempts.add(1);
    const after = await request(server).get('/metrics').expect(200);
    for (const name of [
      'ct_review_reaper_delivery_identity_mismatch_total',
      'ct_review_reaper_superseded_attempt_total',
    ]) {
      expect(metricValue(after.text, name)).toBe(metricValue(before.text, name) + 1);
    }
  });

  it('starts and closes the owned listener cleanly', async () => {
    const server = createDispatcherMetricsServer();
    await listenDispatcherMetricsServer(server, { host: '127.0.0.1', port: 0 });
    expect(server.listening).toBe(true);
    await closeDispatcherMetricsServer(server);
    expect(server.listening).toBe(false);
  });

  it('rejects a real bind failure and removes the stale listening handler', async () => {
    const blocker = createDispatcherMetricsServer();
    const candidate = createDispatcherMetricsServer();
    const baselineListeningListeners = candidate.listeners('listening');
    const baselineErrorListeners = candidate.listeners('error');
    await listenDispatcherMetricsServer(blocker, { host: '127.0.0.1', port: 0 });
    try {
      const address = blocker.address();
      if (!address || typeof address === 'string') throw new Error('missing blocker TCP address');

      await expect(listenDispatcherMetricsServer(candidate, {
        host: '127.0.0.1',
        port: address.port,
      })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(candidate.listening).toBe(false);
      expect(candidate.listeners('listening')).toEqual(baselineListeningListeners);
      expect(candidate.listeners('error')).toEqual(baselineErrorListeners);
    } finally {
      await closeDispatcherMetricsServer(candidate);
      await closeDispatcherMetricsServer(blocker);
    }
  });

  it('fails closed without leaking collector errors', async () => {
    const server = createDispatcherMetricsServer({ collectMetrics: async () => {
      throw new Error('synthetic-sensitive-collector-error');
    } });
    await request(server).get('/metrics').expect(500, '# Error generating metrics\n');
  });

  it('bounds a never-resolving collector and lets shutdown complete', async () => {
    const server = createDispatcherMetricsServer({
      collectionTimeoutMs: 10,
      collectMetrics: () => new Promise<string>(() => undefined),
    });
    const response = await request(server).get('/metrics')
      .expect(500, '# Error generating metrics\n');
    expect(response.text).not.toContain('synthetic-sensitive');
    expect(server.listening).toBe(false);
  });
});
