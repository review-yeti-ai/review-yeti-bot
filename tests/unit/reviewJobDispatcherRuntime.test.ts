import { describe, expect, it, vi } from 'vitest';
import {
  reviewJobDispatcherConfigFromEnv,
  runReviewJobDispatcherLoop,
} from '../../src/k8s/reviewJobDispatcherRuntime';

const workerImage = `registry.digitalocean.com/calltelemetry/review-yeti-worker@sha256:${'e'.repeat(64)}`;

describe('reviewJobDispatcherConfigFromEnv', () => {
  it('accepts only an explicitly enabled, digest-pinned queue consumer', () => {
    expect(reviewJobDispatcherConfigFromEnv({
      REVIEW_JOB_DISPATCH_ENABLED: 'true',
      REVIEW_JOB_NAMESPACE: 'ct-review-system',
      REVIEW_JOB_WORKER_IMAGE: workerImage,
      HOSTNAME: 'dispatcher-abc123',
    })).toEqual({
      namespace: 'ct-review-system',
      workerImage,
      workerId: 'review-job-dispatcher:dispatcher-abc123',
      runnerMode: 'prebaked',
      idleDelayMs: 1_000,
      activeDelayMs: 50,
      errorDelayMs: 5_000,
    });
  });

  it('accepts public ghcr.io digest-pinned worker image', () => {
    const ghcrWorker = `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'f'.repeat(64)}`;
    expect(reviewJobDispatcherConfigFromEnv({
      REVIEW_JOB_DISPATCH_ENABLED: 'true',
      REVIEW_JOB_NAMESPACE: 'ct-review-system',
      REVIEW_JOB_WORKER_IMAGE: ghcrWorker,
      HOSTNAME: 'dispatcher-ghcr123',
    })).toEqual({
      namespace: 'ct-review-system',
      workerImage: ghcrWorker,
      workerId: 'review-job-dispatcher:dispatcher-ghcr123',
      runnerMode: 'prebaked',
      idleDelayMs: 1_000,
      activeDelayMs: 50,
      errorDelayMs: 5_000,
    });
  });

  it.each([
    [{}, /must be true/i],
    [{ REVIEW_JOB_DISPATCH_ENABLED: 'true', REVIEW_JOB_NAMESPACE: 'ct-review-system', REVIEW_JOB_WORKER_IMAGE: 'worker:latest', HOSTNAME: 'pod' }, /digest-pinned/i],
    [{ REVIEW_JOB_DISPATCH_ENABLED: 'true', REVIEW_JOB_NAMESPACE: 'other', REVIEW_JOB_WORKER_IMAGE: workerImage, HOSTNAME: 'pod' }, /ct-review-system/i],
    [{ REVIEW_JOB_DISPATCH_ENABLED: 'true', REVIEW_JOB_NAMESPACE: 'ct-review-system', REVIEW_JOB_WORKER_IMAGE: workerImage }, /hostname/i],
  ])('fails closed for incomplete or expanded configuration', (environment, expected) => {
    expect(() => reviewJobDispatcherConfigFromEnv(environment)).toThrow(expected);
  });
});

describe('runReviewJobDispatcherLoop', () => {
  it('polls the durable queue without a schedule and backs off while idle', async () => {
    const controller = new AbortController();
    const engine = { runOnce: vi.fn(async () => ({ status: 'idle' as const })) };
    const sleep = vi.fn(async (milliseconds: number) => {
      expect(milliseconds).toBe(1_000);
      controller.abort();
    });

    await runReviewJobDispatcherLoop(engine, {
      signal: controller.signal,
      idleDelayMs: 1_000,
      activeDelayMs: 50,
      errorDelayMs: 5_000,
      sleep,
    });

    expect(engine.runOnce).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('continues after a projected row with only the short active delay', async () => {
    const controller = new AbortController();
    const engine = {
      runOnce: vi.fn(async () => ({
        status: 'projected' as const,
        runId: `run_${'1'.repeat(32)}`,
        projectionName: `ct-review-${'1'.repeat(32)}`,
      })),
    };
    const sleep = vi.fn(async (milliseconds: number) => {
      expect(milliseconds).toBe(50);
      controller.abort();
    });

    await runReviewJobDispatcherLoop(engine, {
      signal: controller.signal,
      idleDelayMs: 1_000,
      activeDelayMs: 50,
      errorDelayMs: 5_000,
      sleep,
    });
  });

  it('sanitizes cycle errors and applies bounded backoff instead of exiting', async () => {
    const controller = new AbortController();
    const engine = { runOnce: vi.fn(async () => { throw new Error('postgres://secret-bearing-error'); }) };
    const onCycleError = vi.fn();
    const sleep = vi.fn(async (milliseconds: number) => {
      expect(milliseconds).toBe(5_000);
      controller.abort();
    });

    await runReviewJobDispatcherLoop(engine, {
      signal: controller.signal,
      idleDelayMs: 1_000,
      activeDelayMs: 50,
      errorDelayMs: 5_000,
      sleep,
      onCycleError,
    });

    expect(onCycleError).toHaveBeenCalledWith({ status: 'cycle-error' });
    expect(JSON.stringify(onCycleError.mock.calls)).not.toContain('secret-bearing');
  });
});
