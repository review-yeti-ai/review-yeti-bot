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

  it.each(['42P08', 'A'.repeat(32)])(
    'reports safe error fingerprint %s and applies bounded backoff instead of exiting', async (errorCode) => {
    const controller = new AbortController();
    const failure = Object.assign(new Error('postgres://secret-bearing-error'), { code: errorCode });
    const engine = { runOnce: vi.fn(async () => { throw failure; }) };
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

    expect(onCycleError).toHaveBeenCalledWith({ status: 'cycle-error', errorCode });
    expect(JSON.stringify(onCycleError.mock.calls)).not.toContain('secret-bearing');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a primitive throw', 'postgres://secret-bearing-error'],
    ['a non-string code', Object.assign(new Error('private provider response'), { code: 42 })],
    ['an empty code', Object.assign(new Error('private provider response'), { code: '' })],
    ['a free-form lowercase code', Object.assign(new Error('private provider response'), { code: 'secret-bearing' })],
    ['a code with spaces', Object.assign(new Error('private provider response'), { code: 'SQL STATE' })],
    ['an overlong code', Object.assign(new Error('private provider response'), { code: 'A'.repeat(33) })],
    ['a throwing code getter', Object.defineProperty(new Error('private provider response'), 'code', {
      get: () => { throw new Error('secret-bearing getter'); },
    })],
  ])('drops unsafe diagnostic content from %s', async (_label, failure) => {
    const controller = new AbortController();
    const engine = { runOnce: vi.fn(async () => { throw failure; }) };
    const onCycleError = vi.fn();
    const sleep = vi.fn(async () => { controller.abort(); });

    await runReviewJobDispatcherLoop(engine, {
      signal: controller.signal,
      idleDelayMs: 1_000,
      activeDelayMs: 50,
      errorDelayMs: 5_000,
      sleep,
      onCycleError,
    });

    expect(onCycleError).toHaveBeenCalledWith({ status: 'cycle-error' });
    expect(JSON.stringify(onCycleError.mock.calls)).not.toMatch(/secret-bearing|private provider response/u);
  });
});
