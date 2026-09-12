import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createActionDispatchApp } from "../../src/dispatchServer";
import { initTelemetry, getMetrics } from "../../src/telemetry";
import * as telemetryMetrics from "../../src/telemetry/metrics";

function createApp(options: { ready?: boolean; metricsAuthToken?: string; rateLimiter?: any } = {}) {
  return createActionDispatchApp({
    verifier: { verify: vi.fn() } as any,
    admission: { admit: vi.fn() } as any,
    resolveInstallationId: vi.fn(),
    databaseReady: vi.fn(async () => options.ready ?? true),
    allowAppGate: false,
    metricsAuthToken: options.metricsAuthToken,
    rateLimiter: options.rateLimiter,
  });
}

describe("Action dispatch metrics endpoint", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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

  it("enforces authentication when metricsAuthToken is configured", async () => {
    const app = createApp({ metricsAuthToken: "test-metrics-token-123" });

    const unauthenticated = await request(app).get("/metrics");
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body).toEqual({ error: "Unauthorized" });

    const invalidAuth = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer wrong-token");
    expect(invalidAuth.status).toBe(401);
    expect(invalidAuth.body).toEqual({ error: "Unauthorized" });

    const authenticated = await request(app)
      .get("/metrics")
      .set("Authorization", "Bearer test-metrics-token-123");
    expect(authenticated.status).toBe(200);
    expect(authenticated.text).toContain("# HELP");
  });

  it("returns 500 when metrics generation fails", async () => {
    vi.spyOn(telemetryMetrics, "getPrometheusMetrics").mockRejectedValueOnce(
      new Error("simulated metrics failure")
    );

    const response = await request(createApp()).get("/metrics");
    expect(response.status).toBe(500);
    expect(response.text).toBe("# Error generating metrics\n");
  });

  it("applies rate limiter to /metrics", async () => {
    const limiter = vi.fn((req, res, next) => next());
    await request(createApp({ rateLimiter: limiter })).get("/metrics");
    expect(limiter).toHaveBeenCalled();
  });
});
