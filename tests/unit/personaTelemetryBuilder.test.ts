import { describe, expect, it, beforeEach } from 'vitest';
import { buildPersonaTelemetryPayload } from '../../src/review/workerReviewCompletion';
import { getPrometheusMetrics, initMetrics } from '../../src/telemetry/metrics';

function droppedCount(text: string, persona: string): number {
  const line = text
    .split('\n')
    .find((l) => l.startsWith('review_yeti_persona_telemetry_dropped_total{') && l.includes(`persona="${persona}"`));
  return line ? Number(line.slice(line.lastIndexOf(' ') + 1)) : 0;
}

const healthyLane = {
  id: 'sec-lane',
  model: 'ollama/glm-5.3-flash',
  turnsCount: 3,
  toolTurns: 2,
  correctionTurns: 1,
  durationMs: 1234,
  aggregateUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0 },
};

describe('buildPersonaTelemetryPayload is total', () => {
  beforeEach(() => { initMetrics(process.env); });

  it('builds telemetry for a well-formed lane', () => {
    const built = buildPersonaTelemetryPayload(healthyLane);
    expect(built).toBeDefined();
    expect(built?.model).toBe('ollama/glm-5.3-flash');
  });

  it('omits telemetry instead of throwing when a lane is malformed', async () => {
    // `telemetry` is an OPTIONAL, additive field. A lane carrying a string token count from an
    // unexpected producer must degrade to "no telemetry for this lane", never sink the publishing
    // run. The previous implementation ended in `personaTelemetrySchema.parse(...)`, which threw
    // on the worker's SUCCESS path and turned a measurement enhancement into a review failure.
    const malformed = {
      ...healthyLane,
      id: 'arch-lane',
      aggregateUsage: { promptTokens: 'not-a-number', completionTokens: 5, totalTokens: 15 },
    };
    let built: unknown;
    expect(() => { built = buildPersonaTelemetryPayload(malformed as never); }).not.toThrow();
    expect(built).toBeUndefined();

    const text = await getPrometheusMetrics();
    expect(droppedCount(text, 'arch-lane')).toBeGreaterThanOrEqual(1);
  });

  it('omits telemetry for a NaN numeric without throwing', () => {
    const malformed = { ...healthyLane, id: 'qual-lane', durationMs: Number.NaN };
    let built: unknown;
    expect(() => { built = buildPersonaTelemetryPayload(malformed as never); }).not.toThrow();
    expect(built).toBeUndefined();
  });

  it('a wrongly-typed field is filtered by the type guard, not counted as a drop', async () => {
    // The builder reads every field defensively by type, so a string `turnsCount` never reaches
    // the schema -- it is simply absent. That is a filter, not a degradation, and must not inflate
    // the dropped counter or the "measurement is degraded" signal would cry wolf.
    const before = droppedCount(await getPrometheusMetrics(), 'perf-lane');
    expect(() => buildPersonaTelemetryPayload({ ...healthyLane, id: 'perf-lane', turnsCount: 'x' } as never)).not.toThrow();
    expect(droppedCount(await getPrometheusMetrics(), 'perf-lane')).toBe(before);
  });

  it('records the drop under the lane id so a degraded lane is identifiable', async () => {
    buildPersonaTelemetryPayload({ ...healthyLane, id: 'db-lane', durationMs: Number.NaN } as never);
    const text = await getPrometheusMetrics();
    expect(droppedCount(text, 'db-lane')).toBeGreaterThanOrEqual(1);
  });

  it('a lane with no telemetry data at all is undefined, not a drop', async () => {
    const before = droppedCount(await getPrometheusMetrics(), 'unknown');
    expect(buildPersonaTelemetryPayload({})).toBeUndefined();
    expect(droppedCount(await getPrometheusMetrics(), 'unknown')).toBe(before);
  });
});
