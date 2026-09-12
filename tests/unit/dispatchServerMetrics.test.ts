import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createActionDispatchApp } from "../../src/dispatchServer";
import { initTelemetry, getMetrics } from "../../src/telemetry";

function createApp(ready = true) {
  return createActionDispatchApp({
    verifier: { verify: vi.fn() } as any,
    admission: { admit: vi.fn() } as any,
    resolveInstallationId: vi.fn(),
    databaseReady: vi.fn(async () => ready),
    allowAppGate: false,
  });
}

describe("Action dispatch metrics endpoint", () => {
  beforeEach(() => {
    initTelemetry("ct-review-action-dispatch");
  });

  it("exposes GET /metrics with Prometheus exposition format", async () => {
    const metrics = getMetrics();
    metrics.jobsQueued.add(1, { repository: "calltelemetry/ct-infrastructure" });

    const response = await request(createApp()).get("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["content-type"]).toContain("version=0.0.4");
    expect(response.text).toContain("# HELP ct_queue_jobs_queued_total");
    expect(response.text).toContain("# TYPE ct_queue_jobs_queued_total counter");
    expect(response.text).toContain("ct_queue_jobs_queued_total");
  });
});
