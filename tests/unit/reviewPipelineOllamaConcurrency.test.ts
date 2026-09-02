import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));

const persona = pipeline.PERSONA_CHARTERS.find((entry: any) => entry.id === 'testing');
const diffFiles = [{
  path: 'src/example.ts',
  patch: '@@ -0,0 +1 @@\n+export const value = 1;\n',
  addedLines: [{ text: 'export const value = 1;' }],
  deletedLines: [],
}];

function response() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
  };
}

function delayedFetch(delayMs: number) {
  let active = 0;
  let peak = 0;
  const impl = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    return response();
  };
  return { impl, peak: () => peak };
}

async function runReviews(count: number, transport: any, fetchImpl: any, capacityManager = new pipeline.ProviderCapacityManager()) {
  return Promise.all(Array.from({ length: count }, (_unused, index) => pipeline.reviewWithModel(
    persona,
    diffFiles,
    { repo: 'fixture/repository', prNumber: String(index + 1) },
    null,
    {
      transports: [transport],
      fetchImpl,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager,
    },
  )));
}

describe('Ollama request concurrency', () => {
  it('bounds capacity wait time and remains usable after a timed-out waiter', async () => {
    const semaphore = new pipeline.AsyncSemaphore(1);
    const release = await semaphore.acquire(100);
    await expect(semaphore.acquire(5)).rejects.toThrow('capacity_wait_timeout');
    release();
    const releaseAfterTimeout = await semaphore.acquire(100);
    releaseAfterTimeout();
  });

  it('admits local waiters in FIFO order', async () => {
    const semaphore = new pipeline.AsyncSemaphore(1);
    const releaseFirst = await semaphore.acquire(100);
    const order: string[] = [];
    const second = semaphore.acquire(100).then((release: () => void) => {
      order.push('second');
      return release;
    });
    const third = semaphore.acquire(100).then((release: () => void) => {
      order.push('third');
      return release;
    });

    releaseFirst();
    const releaseSecond = await second;
    expect(order).toEqual(['second']);
    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(['second', 'third']);
    releaseThird();
  });

  it('removes a cancelled local waiter without consuming the next slot', async () => {
    const semaphore = new pipeline.AsyncSemaphore(1);
    const releaseFirst = await semaphore.acquire(100);
    const controller = new AbortController();
    const cancelled = semaphore.acquire(100, 'capacity_wait_timeout', controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow('provider_capacity_wait_cancelled');

    releaseFirst();
    const releaseAfterCancellation = await semaphore.acquire(100);
    releaseAfterCancellation();
  });

  it('does not spend the provider request timeout while waiting for capacity', async () => {
    const capacityManager = new pipeline.ProviderCapacityManager();
    const transport = {
      name: 'openrouter-primary',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-flash-0731',
      maxInFlight: 1,
      concurrencyScope: 'provider',
      capacityWaitTimeoutMs: 200,
    };
    const first = await capacityManager.acquire(transport, transport.baseUrl, 10);
    const queued = capacityManager.acquire(transport, transport.baseUrl, 10);
    await new Promise((resolve) => setTimeout(resolve, 30));
    first.release();

    const second = await queued;
    expect(second.waitMs).toBeGreaterThan(10);
    second.release();
  });

  it('records a terminal local queue timeout without dispatching a provider request', async () => {
    const capacityManager = new pipeline.ProviderCapacityManager();
    const transport = {
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash:cloud',
      maxInFlight: 1,
      capacityWaitTimeoutMs: 10,
      stream: false,
    };
    const held = await capacityManager.acquire(transport, transport.baseUrl, 100);
    let calls = 0;
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'queue-timeout' }, null, {
      transports: [transport],
      fetchImpl: async () => { calls += 1; return response(); },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager,
    });
    held.release();

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      decision: 'ERROR',
      failureClass: 'provider_capacity',
      error: 'provider_capacity_wait_timeout',
    });
    expect(result.capacityWaitMs).toBeGreaterThanOrEqual(1);
    expect(result.responseAttempts[0].capacityWaitMs).toBeGreaterThanOrEqual(1);
  });

  it('records a cancelled local queue wait without consuming the held slot', async () => {
    const capacityManager = new pipeline.ProviderCapacityManager();
    const controller = new AbortController();
    const transport = {
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash:cloud',
      maxInFlight: 1,
      capacityWaitTimeoutMs: 100,
      stream: false,
    };
    const held = await capacityManager.acquire(transport, transport.baseUrl, 100);
    let calls = 0;
    const queued = pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'queue-cancelled' }, null, {
      transports: [transport],
      signal: controller.signal,
      fetchImpl: async () => { calls += 1; return response(); },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await queued;
    held.release();

    expect(calls).toBe(0);
    expect(result).toMatchObject({ decision: 'ERROR', failureClass: 'cancelled', error: 'review_cancelled' });
    expect(result.capacityWaitMs).toBeGreaterThanOrEqual(1);
    expect(result.responseAttempts[0].capacityWaitMs).toBeGreaterThanOrEqual(1);
  });

  it('uses a conservative process-local Ollama cap below the shared Team account ceiling', async () => {
    const fetch = delayedFetch(15);
    const results = await runReviews(20, {
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash:cloud',
      stream: false,
    }, fetch.impl);

    expect(results.every((result: any) => result.decision === 'APPROVE')).toBe(true);
    expect(fetch.peak()).toBe(pipeline.OLLAMA_MAX_IN_FLIGHT_REQUESTS);
    expect(fetch.peak()).toBe(3);
  });

  it('caps an explicit Ollama limit at the shared account ceiling', async () => {
    const policy = pipeline.resolveTransportCapacityPolicy({
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      maxInFlight: 20,
      capacityWaitTimeoutMs: 180_000,
    }, 'https://ollama.com/v1');
    expect(policy.maxInFlight).toBe(10);
    expect(policy.waitTimeoutMs).toBe(30_000);

    const fetch = delayedFetch(15);
    await runReviews(20, {
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash:cloud',
      maxInFlight: 20,
      stream: false,
    }, fetch.impl);
    expect(fetch.peak()).toBe(10);
  });

  it('defaults Synthetic to one in-flight request per model', async () => {
    const fetch = delayedFetch(15);
    const results = await runReviews(20, {
      name: 'synthetic',
      baseUrl: 'https://model.example/v1',
      apiKey: 'test-key',
      model: 'synthetic-reviewer',
      stream: false,
    }, fetch.impl);

    expect(results.every((result: any) => result.decision === 'APPROVE')).toBe(true);
    expect(fetch.peak()).toBe(pipeline.SYNTHETIC_MAX_IN_FLIGHT_PER_MODEL);
    expect(fetch.peak()).toBe(1);
    expect(results.some((result: any) => result.responseAttempts.some((attempt: any) => attempt.capacityWaitMs > 0))).toBe(true);
  });

  it('lets different Synthetic models run concurrently without sharing a model queue', async () => {
    const fetch = delayedFetch(15);
    const capacityManager = new pipeline.ProviderCapacityManager();
    const models = ['hf:zai-org/GLM-5.3-Flash', 'hf:zai-org/GLM-4.7-Flash'];
    const results = await Promise.all(models.flatMap((model) =>
      Array.from({ length: 4 }, (_unused, index) => pipeline.reviewWithModel(
        persona,
        diffFiles,
        { repo: 'fixture/repository', prNumber: `${model}-${index}` },
        null,
        {
          transports: [{
            name: 'synthetic',
            baseUrl: 'https://api.synthetic.new/openai/v1',
            apiKey: 'test-key',
            model,
            stream: false,
          }],
          fetchImpl: fetch.impl,
          circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
          capacityManager,
        },
      )),
    ));

    expect(results.every((result: any) => result.decision === 'APPROVE')).toBe(true);
    expect(fetch.peak()).toBe(2);
  });

  it('keeps unrelated custom transport capacity pools isolated', () => {
    const capacityManager = new pipeline.ProviderCapacityManager();
    expect(() => capacityManager.configure([{
      name: 'custom-a',
      baseUrl: 'https://a.example/v1',
      model: 'model-a',
      maxInFlight: 1,
      concurrencyScope: 'provider',
    }, {
      name: 'custom-b',
      baseUrl: 'https://b.example/v1',
      model: 'model-b',
      maxInFlight: 2,
      concurrencyScope: 'provider',
    }])).not.toThrow();
  });

  it('rejects conflicting provider-scoped limits before a request is dispatched', () => {
    const capacityManager = new pipeline.ProviderCapacityManager();
    expect(() => capacityManager.configure([{
      name: 'openrouter-primary',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'model-a',
      maxInFlight: 3,
      concurrencyScope: 'provider',
    }, {
      name: 'openrouter-fallback',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'model-b',
      maxInFlight: 2,
      concurrencyScope: 'provider',
    }])).toThrow('provider capacity limit conflict for openrouter:provider');
  });

  it('releases Ollama capacity after request failures', async () => {
    const transport = {
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash:cloud',
      stream: false,
    };
    const capacityManager = new pipeline.ProviderCapacityManager();
    const failed = await runReviews(20, transport, async () => {
      throw new Error('terminal provider failure');
    }, capacityManager);
    expect(failed.every((result: any) => result.decision === 'ERROR')).toBe(true);

    const recovered = await runReviews(1, transport, async () => response(), capacityManager);
    expect(recovered[0].decision).toBe('APPROVE');
  });

  it('releases an active Ollama lease when the review is cancelled', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const capacityManager = new pipeline.ProviderCapacityManager();
    const controller = new AbortController();
    let startedResolve: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const transport = {
      name: 'ollama',
      baseUrl: 'https://ollama.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash:cloud',
      maxInFlight: 1,
      stream: false,
    };

    const cancelledReview = pipeline.reviewWithModel(
      persona,
      diffFiles,
      { repo: 'fixture/repository', prNumber: 'cancelled' },
      null,
      {
        transports: [transport],
        signal: controller.signal,
        fetchImpl: async (_url: string, init: { signal: AbortSignal }) => {
          startedResolve?.();
          return new Promise((_resolve, reject) => {
            const rejectCancelled = () => reject(init.signal.reason || new Error('review_cancelled'));
            if (init.signal.aborted) rejectCancelled();
            else init.signal.addEventListener('abort', rejectCancelled, { once: true });
          });
        },
        circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
        capacityManager,
      },
    );

    await started;
    controller.abort();
    const cancelled = await cancelledReview;
    expect(cancelled).toMatchObject({ decision: 'ERROR', failureClass: 'cancelled', error: 'review_cancelled' });
    expect(cancelled.responseAttempts[0]).toMatchObject({
      capacityLeaseAcquired: true,
      failureClass: 'cancelled',
    });
    const cancellationLogs = JSON.stringify(log.mock.calls);
    expect(cancellationLogs).toContain('phase=provider_cancelled');
    expect(cancellationLogs).not.toContain('phase=queue_cancelled');

    const recovered = await runReviews(1, transport, async () => response(), capacityManager);
    expect(recovered[0].decision).toBe('APPROVE');
    log.mockRestore();
  });
});
