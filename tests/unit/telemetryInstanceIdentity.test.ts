import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * REL-1053: exercises the real initTelemetry -> initMetrics -> MeterProvider
 * chain (not the pure resource helper) so that dropping the identity anywhere
 * along it fails here. Two dispatcher replicas without a distinct
 * service.instance.id push cumulative counters as one series.
 */
describe('telemetry process identity reaches the exported metrics resource', () => {
  beforeEach(() => {
    // The metrics provider is a module singleton; each case needs a fresh one.
    vi.resetModules();
  });

  it('exports a long-lived replica under its own service name and instance id', async () => {
    const telemetry = await import('../../src/telemetry');
    telemetry.initTelemetry('ct-review-job-dispatcher', {
      serviceInstanceId: 'review-job-dispatcher:ct-review-job-dispatcher-7d9f-abcde',
    });
    const attributes = await telemetry.getMetricsResourceAttributes();
    expect(attributes['service.name']).toBe('ct-review-job-dispatcher');
    expect(attributes['service.instance.id']).toBe('review-job-dispatcher:ct-review-job-dispatcher-7d9f-abcde');
  });

  it('keeps processes without an instance id (ephemeral workers) off per-pod series', async () => {
    const telemetry = await import('../../src/telemetry');
    telemetry.initTelemetry('review-yeti-worker');
    const attributes = await telemetry.getMetricsResourceAttributes();
    expect(attributes['service.instance.id']).toBeUndefined();
  });
});
