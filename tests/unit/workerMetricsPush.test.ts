import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Decoder only: the exporter's own generated protobuf root, so the test reads the
// exact wire format VictoriaMetrics receives rather than a re-implementation.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const protoRoot = require('@opentelemetry/otlp-transformer/build/src/generated/root');

const ExportMetricsServiceRequest = protoRoot.opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest;
const AGGREGATION_TEMPORALITY_DELTA = 1;

/** A worker env for the SDK's ProcessEnv parameter (NODE_ENV is required by the type). */
function workerEnv(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...values } as NodeJS.ProcessEnv;
}

type Captured = { contentType: string | undefined; body: Buffer };

// REL-1104: worker pods are 2-10 minute Jobs nobody scrapes, and the operator
// never projected an endpoint, so worker counters (Jev, shadow triage, lanes)
// had zero series in VictoriaMetrics. These tests pin the push: delta, protobuf,
// bounded labels, and fail-open.
describe('REL-1104 worker metrics push', () => {
  let server: http.Server | null = null;
  const captured: Captured[] = [];

  async function startCollector(handler?: (res: http.ServerResponse) => void): Promise<string> {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        captured.push({ contentType: req.headers['content-type'], body: Buffer.concat(chunks) });
        if (handler) return handler(res);
        res.writeHead(204);
        res.end();
      });
    });
    // Default (dual-stack) bind: tests/setup.ts rewrites 127.0.0.1 requests to [::1].
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/opentelemetry/v1/metrics`;
  }

  async function freshMetrics() {
    vi.resetModules();
    return import('../../src/telemetry/metrics');
  }

  function decode(body: Buffer) {
    return ExportMetricsServiceRequest.toObject(ExportMetricsServiceRequest.decode(body), { longs: Number });
  }

  function sumPoints(requests: Captured[], name: string): Array<{ value: number; temporality: number; labels: Record<string, string> }> {
    const out: Array<{ value: number; temporality: number; labels: Record<string, string> }> = [];
    for (const request of requests) {
      for (const rm of decode(request.body).resourceMetrics ?? []) {
        for (const sm of rm.scopeMetrics ?? []) {
          for (const metric of sm.metrics ?? []) {
            if (metric.name !== name || !metric.sum) continue;
            for (const dp of metric.sum.dataPoints ?? []) {
              const labels: Record<string, string> = {};
              for (const kv of dp.attributes ?? []) labels[kv.key] = kv.value?.stringValue ?? '';
              out.push({ value: Number(dp.asDouble ?? dp.asInt ?? 0), temporality: metric.sum.aggregationTemporality, labels });
            }
          }
        }
      }
    }
    return out;
  }

  beforeEach(() => {
    captured.length = 0;
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    vi.resetModules();
  });

  it('resolves only absolute http(s) endpoints and ignores everything else (fail-open, never throws)', async () => {
    const { resolveWorkerMetricsEndpoint, WORKER_METRICS_ENDPOINT_ENV } = await freshMetrics();
    expect(WORKER_METRICS_ENDPOINT_ENV).toBe('REVIEW_YETI_WORKER_METRICS_ENDPOINT');
    const ok = 'http://victoria-metrics-server.observability.svc.cluster.local:8428/opentelemetry/v1/metrics';
    expect(resolveWorkerMetricsEndpoint(workerEnv({ REVIEW_YETI_WORKER_METRICS_ENDPOINT: ok }))).toBe(ok);
    expect(resolveWorkerMetricsEndpoint(workerEnv({ REVIEW_YETI_WORKER_METRICS_ENDPOINT: ` ${ok} ` }))).toBe(ok);
    for (const bad of [
      undefined,
      '',
      '   ',
      'not a url',
      'vm:8428',
      'ftp://vm:8428/opentelemetry/v1/metrics',
      'http://user:pw@vm:8428/opentelemetry/v1/metrics',
      'http://vm:8428/opentelemetry/v1/metrics#frag',
      'http://vm:8428/a b',
    ]) {
      expect(resolveWorkerMetricsEndpoint(workerEnv({ REVIEW_YETI_WORKER_METRICS_ENDPOINT: bad }))).toBeNull();
    }
  });

  it('pushes delta protobuf with only the bounded worker identity, then only the new increment', async () => {
    const url = await startCollector();
    const metrics = await freshMetrics();
    const env = {
      REVIEW_YETI_WORKER_METRICS_ENDPOINT: url,
      // Per-run identifiers present in the real worker env must never become labels.
      REVIEW_RUN_ID: 'run_deadbeefcafe',
      REVIEW_HEAD_SHA: '547cf452955a8cbe775dda2297dffeb332fd859d',
      REVIEW_WORKER_POD_NAME: 'ct-review-abc-worker-xyz12',
    };
    const counters = metrics.initMetrics(workerEnv(env));
    counters.jevTriageShadowFiles.add(3, { outcome: 'ok', category: 'source', risk_level: 'low' });
    counters.jevRequests.add(1, { seam: 'triage_shadow', outcome: 'ok' });
    counters.jevDuration.record(0.4, { seam: 'triage_shadow', outcome: 'ok' });

    await metrics.flushMetrics(5000);
    expect(captured.length).toBeGreaterThan(0);
    expect(captured.every((c) => c.contentType === 'application/x-protobuf')).toBe(true);

    const first = sumPoints(captured, 'review_yeti_jev_triage_shadow_files_total');
    expect(first).toEqual([
      { value: 3, temporality: AGGREGATION_TEMPORALITY_DELTA, labels: { outcome: 'ok', category: 'source', risk_level: 'low' } },
    ]);
    expect(sumPoints(captured, 'review_yeti_jev_requests_total')[0]).toMatchObject({
      value: 1,
      temporality: AGGREGATION_TEMPORALITY_DELTA,
      labels: { seam: 'triage_shadow', outcome: 'ok' },
    });

    const request = decode(captured[0].body);
    const resourceAttrs = Object.fromEntries(
      (request.resourceMetrics[0].resource.attributes ?? []).map((kv: any) => [kv.key, kv.value?.stringValue]),
    );
    // VictoriaMetrics promotes every resource attribute to a label, so the set must be
    // constant per image: the worker job plus the SDK's own fixed telemetry.sdk.* keys
    // (merged in by MeterProvider), and nothing per run, pod or host.
    expect(resourceAttrs).toMatchObject({ 'service.name': 'review-yeti-worker', job: 'review-yeti-worker' });
    expect(Object.keys(resourceAttrs).sort()).toEqual(
      ['job', 'service.name', 'telemetry.sdk.language', 'telemetry.sdk.name', 'telemetry.sdk.version'],
    );
    for (const c of captured) {
      const raw = c.body.toString('latin1');
      for (const forbidden of Object.values(env).slice(1)) expect(raw).not.toContain(forbidden);
    }

    // Delta, not cumulative: a second flush carries only what happened since.
    captured.length = 0;
    counters.jevTriageShadowFiles.add(2, { outcome: 'ok', category: 'source', risk_level: 'low' });
    await metrics.flushMetrics(5000);
    expect(sumPoints(captured, 'review_yeti_jev_triage_shadow_files_total').map((p) => p.value)).toEqual([2]);
  });

  it('pushes nothing when the endpoint is unset or malformed', async () => {
    const url = await startCollector();
    for (const value of [undefined, `${url}#frag`]) {
      const metrics = await freshMetrics();
      const counters = metrics.initMetrics(workerEnv({ REVIEW_YETI_WORKER_METRICS_ENDPOINT: value }));
      counters.jevRequests.add(1, { seam: 'triage_shadow', outcome: 'ok' });
      await metrics.flushMetrics(1000);
    }
    expect(captured).toHaveLength(0);
  });

  it('never pushes from a long-lived process that carries a replica identity', async () => {
    const url = await startCollector();
    const metrics = await freshMetrics();
    const counters = metrics.initMetrics(
      workerEnv({ REVIEW_YETI_WORKER_METRICS_ENDPOINT: url }),
      { serviceName: 'ct-review-job-dispatcher', serviceInstanceId: 'pod-a' },
    );
    counters.jevRequests.add(1, { seam: 'triage_shadow', outcome: 'ok' });
    await metrics.flushMetrics(1000);
    expect(captured).toHaveLength(0);
  });

  it('fails open: a hanging endpoint is bounded by the flush timeout and never throws', async () => {
    const url = await startCollector(() => { /* never respond */ });
    const metrics = await freshMetrics();
    metrics.initMetrics(workerEnv({ REVIEW_YETI_WORKER_METRICS_ENDPOINT: url })).jevRequests.add(1, { seam: 'triage_shadow', outcome: 'ok' });
    const started = Date.now();
    await expect(metrics.flushMetrics(300)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(captured.length).toBeGreaterThan(0);
  });

  it('fails open: a refusing or erroring endpoint never throws', async () => {
    const url = await startCollector((res) => { res.writeHead(500); res.end('boom'); });
    const metrics = await freshMetrics();
    metrics.initMetrics(workerEnv({ REVIEW_YETI_WORKER_METRICS_ENDPOINT: url })).jevRequests.add(1, { seam: 'triage_shadow', outcome: 'ok' });
    await expect(metrics.flushMetrics(2000)).resolves.toBeUndefined();

    const closed = await freshMetrics();
    closed.initMetrics(workerEnv({ REVIEW_YETI_WORKER_METRICS_ENDPOINT: 'http://127.0.0.1:1/opentelemetry/v1/metrics' }))
      .jevRequests.add(1, { seam: 'triage_shadow', outcome: 'ok' });
    await expect(closed.flushMetrics(2000)).resolves.toBeUndefined();
  });

  it('bounds a single push request well under the flush budget', async () => {
    const { WORKER_METRICS_EXPORT_TIMEOUT_MS } = await freshMetrics();
    expect(WORKER_METRICS_EXPORT_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});
