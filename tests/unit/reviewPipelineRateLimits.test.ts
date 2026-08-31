import { describe, expect, it } from 'vitest';
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

function successResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
  };
}

describe('direct-provider rate limits', () => {
  it('does not admit more retries than the fixed request recovery envelope', () => {
    expect(pipeline.resolveTransportRateLimitPolicy({
      rateLimit: { scope: 'provider', max_retries: 2, max_retry_after_ms: 2000 },
    })).toEqual({ scope: 'provider', maxRetries: 1, maxRetryAfterMs: 2000 });
  });

  it('preserves capacity and rate-limit controls from the central transport handoff', () => {
    const config = pipeline.resolveModelConfig({
      SYNTHETIC_API_KEY: 'synthetic-key',
      REVIEW_YETI_DISPATCH_MODE: 'striped',
      REVIEW_YETI_TRANSPORTS: JSON.stringify([{
        name: 'synthetic',
        base_url: 'https://api.synthetic.new/openai/v1',
        api_key_env: 'SYNTHETIC_API_KEY',
        model: 'hf:zai-org/GLM-5.3-Flash',
        dispatch_weight: 1,
        max_in_flight: 1,
        concurrency_scope: 'model',
        capacity_wait_timeout_ms: 5000,
        circuit_breaker_scope: 'model',
        quota_probe: 'synthetic-v2',
        rate_limit: { scope: 'provider', max_retries: 1, max_retry_after_ms: 2000 },
      }]),
    });

    expect(config.dispatchMode).toBe('striped');
    expect(config.transports[0]).toMatchObject({
      dispatchWeight: 1,
      maxInFlight: 1,
      concurrencyScope: 'model',
      capacityWaitTimeoutMs: 5000,
      circuitBreakerScope: 'model',
      quotaProbe: 'synthetic-v2',
      rateLimit: { scope: 'provider', max_retries: 1, max_retry_after_ms: 2000 },
    });
  });

  it('honors a short direct-provider Retry-After once', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: '1' }, null, {
      transports: [{
        name: 'synthetic',
        baseUrl: 'https://api.synthetic.new/openai/v1',
        apiKey: 'test-key',
        model: 'hf:zai-org/GLM-5.3-Flash',
        stream: false,
        rateLimit: { scope: 'provider', max_retries: 1, max_retry_after_ms: 2000 },
      }],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: new Headers({ 'retry-after': '1' }),
            text: async () => 'rate limited',
          };
        }
        return successResponse();
      },
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager: new pipeline.ProviderCapacityManager(),
    });

    expect(result.decision).toBe('APPROVE');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(result.recoveryAction).toBe('rate_limit_retry');
    expect(result.retryReasons).toEqual(['http_429']);
  });

  it('fails over immediately when Retry-After exceeds the admitted queue budget', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const breaker = new pipeline.RunTransportCircuitBreaker();
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: '2' }, null, {
      transports: [{
        name: 'synthetic',
        baseUrl: 'https://api.synthetic.new/openai/v1',
        apiKey: 'synthetic-key',
        model: 'hf:zai-org/GLM-5.3-Flash',
        stream: false,
        rateLimit: { scope: 'provider', max_retries: 1, max_retry_after_ms: 2000 },
      }, {
        name: 'backup',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'backup-key',
        model: 'backup-model',
        stream: false,
      }],
      fetchImpl: async (url: string) => {
        calls.push(url);
        if (url.includes('synthetic.new')) {
          return {
            ok: false,
            status: 429,
            headers: new Headers({ 'retry-after': '900' }),
            text: async () => 'five-hour quota exhausted',
          };
        }
        return successResponse();
      },
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
      circuitBreaker: breaker,
      capacityManager: new pipeline.ProviderCapacityManager(),
    });

    expect(result.decision).toBe('APPROVE');
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([]);
    expect(breaker.isTripped('synthetic')).toBe(true);
    expect(result.transport).toBe('backup');
  });

  it('skips later models from a provider tripped during the current lane', async () => {
    const calls: string[] = [];
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: '3' }, null, {
      transports: [{
        name: 'synthetic-primary',
        provider: 'synthetic',
        baseUrl: 'https://api.synthetic.new/openai/v1',
        apiKey: 'synthetic-key',
        model: 'hf:zai-org/GLM-5.3-Flash',
        stream: false,
        rateLimit: { scope: 'provider', max_retries: 0, max_retry_after_ms: 0 },
      }, {
        name: 'synthetic-secondary',
        provider: 'synthetic',
        baseUrl: 'https://api.synthetic.new/openai/v1',
        apiKey: 'synthetic-key',
        model: 'hf:deepseek-ai/DeepSeek-V3.2',
        stream: false,
        rateLimit: { scope: 'provider', max_retries: 0, max_retry_after_ms: 0 },
      }, {
        name: 'backup',
        provider: 'backup',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'backup-key',
        model: 'backup-model',
        stream: false,
      }],
      fetchImpl: async (url: string) => {
        calls.push(url);
        if (url.includes('synthetic.new')) {
          return {
            ok: false,
            status: 429,
            headers: new Headers(),
            text: async () => 'provider quota exhausted',
          };
        }
        return successResponse();
      },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager: new pipeline.ProviderCapacityManager(),
    });

    expect(result.decision).toBe('APPROVE');
    expect(calls).toEqual([
      'https://api.synthetic.new/openai/v1/chat/completions',
      'https://backup.example/v1/chat/completions',
    ]);
    expect(result.transport).toBe('backup');
  });
});

describe('Synthetic quota preflight', () => {
  it('normalizes the documented advisory quota payload without inferring concurrency', async () => {
    const result = await pipeline.probeSyntheticQuota({
      name: 'synthetic',
      baseUrl: 'https://api.synthetic.new/openai/v1',
      apiKeyEnv: 'SYNTHETIC_API_KEY',
      apiKey: 'test-key',
    }, async (url: string, init: any) => {
      expect(url).toBe('https://api.synthetic.new/v2/quotas');
      expect(init.headers.Authorization).toBe('Bearer test-key');
      return {
        ok: true,
        status: 200,
        json: async () => ({ subscription: { limit: 500, requests: 12.5, renewsAt: '2026-09-01T00:00:00.000Z' } }),
      };
    });

    expect(result).toEqual({
      status: 'available',
      snapshot: { limit: 500, requests: 12.5, renewsAt: '2026-09-01T00:00:00.000Z' },
    });
    expect(result.snapshot).not.toHaveProperty('concurrency');
  });

  it('degrades an unavailable quota endpoint to advisory status', async () => {
    const result = await pipeline.probeSyntheticQuota({
      name: 'synthetic',
      baseUrl: 'https://api.synthetic.new/openai/v1',
      apiKeyEnv: 'SYNTHETIC_API_KEY',
      apiKey: 'test-key',
    }, async () => {
      throw new Error('network unavailable');
    });
    expect(result).toEqual({ status: 'unavailable', reason: 'request_failed' });
  });

  it('never forwards an unrelated transport credential to the Synthetic quota endpoint', async () => {
    let called = false;
    const result = await pipeline.probeSyntheticQuota({
      name: 'custom-provider',
      baseUrl: 'https://custom.example/v1',
      apiKeyEnv: 'CUSTOM_API_KEY',
      apiKey: 'unrelated-secret',
    }, async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) };
    });

    expect(called).toBe(false);
    expect(result).toEqual({ status: 'unavailable', reason: 'untrusted_transport' });
  });
});
