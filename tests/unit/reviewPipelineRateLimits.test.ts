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

function successResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }),
  };
}

function ollamaTransport(overrides: Record<string, unknown> = {}) {
  return {
    name: 'ollama',
    baseUrl: 'https://ollama.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-v4-flash:cloud',
    maxInFlight: 1,
    capacityWaitTimeoutMs: 1000,
    stream: false,
    ...overrides,
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

  it('retries the same Ollama transport after HTTP 429 and honors bounded Retry-After', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'ollama-429' }, null, {
      transports: [ollamaTransport()],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: new Headers({ 'retry-after': '0.01' }),
            text: async () => 'shared account is at capacity',
          };
        }
        return successResponse();
      },
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager: new pipeline.ProviderCapacityManager(),
    });

    expect(result.decision).toBe('APPROVE');
    expect(result.transport).toBe('ollama');
    expect(calls).toBe(2);
    expect(sleeps).toEqual([10]);
    expect(result.recoveryAction).toBe('capacity_wait_retry');
    expect(result.capacityWaitMs).toBe(10);
  });

  it('retries the same Ollama transport after HTTP 503 without Retry-After', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'ollama-503' }, null, {
      transports: [ollamaTransport()],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 503,
            headers: new Headers(),
            text: async () => 'server is overloaded',
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
    expect(sleeps).toEqual([250]);
    expect(result.responseAttempts[0]).toMatchObject({
      responseStatus: 503,
      capacityLeaseAcquired: true,
    });
    expect(result.responseAttempts[0].providerExecutionMs).toBeTypeOf('number');
    expect(result.responseAttempts[0].capacityLeaseMs).toBeTypeOf('number');
  });

  it('does not misclassify a generic Ollama HTTP 503 as shared-capacity contention', async () => {
    const credential = 'sk-generic-503-secret';
    const sleeps: number[] = [];
    let calls = 0;
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'ollama-generic-503' }, null, {
      transports: [ollamaTransport({ apiKey: credential })],
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: false,
          status: 503,
          headers: new Headers(),
          text: async () => `maintenance failure echoed Authorization: Bearer ${credential}`,
        };
      },
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager: new pipeline.ProviderCapacityManager(),
    });

    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(result).toMatchObject({ decision: 'ERROR', error: 'HTTP 503: ollama_provider_error' });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(result.recoveryAction).not.toBe('capacity_wait_retry');
  });

  it('recognizes the documented in-band 503 request-queue-full overload shape', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'ollama-sse-503' }, null, {
      transports: [ollamaTransport()],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({
              error: { message: 'Streaming response failed: [503] The request queue is full.' },
            }),
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
    expect(sleeps).toEqual([250]);
    expect(result.transport).toBe('ollama');
  });

  it('falls back immediately on Ollama capacity when another provider is configured', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'ollama-budget' }, null, {
      transports: [ollamaTransport({ capacityWaitTimeoutMs: 300 }), {
        name: 'backup',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'backup-key',
        model: 'backup-model',
        stream: false,
      }],
      fetchImpl: async (url: string) => {
        calls.push(url);
        if (url.includes('ollama.com')) {
          return {
            ok: false,
            status: 503,
            headers: new Headers(),
            text: async () => 'The request queue is full.',
          };
        }
        return successResponse();
      },
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager: new pipeline.ProviderCapacityManager(),
    });

    expect(calls).toEqual([
      'https://ollama.com/v1/chat/completions',
      'https://backup.example/v1/chat/completions',
    ]);
    expect(sleeps).toEqual([]);
    expect(result).toMatchObject({ decision: 'APPROVE', transport: 'backup' });
    expect(result.retryReasons).toEqual(expect.arrayContaining(['provider_capacity']));
  });

  it('fails explicitly after the total capacity budget when Ollama is the only transport', async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'ollama-only-budget' }, null, {
      transports: [ollamaTransport({ capacityWaitTimeoutMs: 300 })],
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: false,
          status: 503,
          headers: new Headers(),
          text: async () => 'The request queue is full.',
        };
      },
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager: new pipeline.ProviderCapacityManager(),
    });

    expect(calls).toBe(2);
    expect(sleeps).toEqual([250, 50]);
    expect(result).toMatchObject({
      decision: 'ERROR',
      failureClass: 'provider_capacity',
      error: 'provider_capacity_wait_timeout',
      capacityWaitMs: 300,
    });
  });

  it('releases the local Ollama lease before remote-capacity backoff', async () => {
    const capacityManager = new pipeline.ProviderCapacityManager();
    let calls = 0;
    let sleepStartedResolve: (() => void) | null = null;
    let resumeSleep: (() => void) | null = null;
    let secondFetchResolve: (() => void) | null = null;
    const sleepStarted = new Promise<void>((resolve) => { sleepStartedResolve = resolve; });
    const sleepGate = new Promise<void>((resolve) => { resumeSleep = resolve; });
    const secondFetchStarted = new Promise<void>((resolve) => { secondFetchResolve = resolve; });
    const transport = ollamaTransport({ maxInFlight: 1 });
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: false,
          status: 503,
          headers: new Headers(),
          text: async () => 'server is overloaded',
        };
      }
      secondFetchResolve?.();
      return successResponse();
    };
    const first = pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'lease-1' }, null, {
      transports: [transport],
      fetchImpl,
      sleepImplementation: async () => {
        sleepStartedResolve?.();
        await sleepGate;
      },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager,
    });

    await sleepStarted;
    const second = pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'lease-2' }, null, {
      transports: [transport],
      fetchImpl,
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager,
    });
    await secondFetchStarted;
    expect(calls).toBe(2);
    resumeSleep?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.decision).toBe('APPROVE');
    expect(secondResult.decision).toBe('APPROVE');
  });

  it('never logs an Ollama credential or provider error detail while capacity-waiting', async () => {
    const credential = 'sk-sensitive-capacity-secret';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'ollama-redaction' }, null, {
        transports: [ollamaTransport({ apiKey: credential, capacityWaitTimeoutMs: 1 })],
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          headers: new Headers(),
          text: async () => `server is overloaded; Authorization: Bearer ${credential}`,
        }),
        sleepImplementation: async () => {},
        circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
        capacityManager: new pipeline.ProviderCapacityManager(),
      });

      expect(result.error).toBe('provider_capacity_wait_timeout');
      const serializedLogs = JSON.stringify([...warn.mock.calls, ...log.mock.calls]);
      expect(serializedLogs).not.toContain(credential);
      expect(serializedLogs).not.toContain('Authorization');
      expect(serializedLogs).not.toContain('Bearer');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it.each([401, 500])('redacts non-capacity Ollama HTTP %i error details', async (status) => {
    const credential = `sk-sensitive-http-${status}`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: `ollama-redaction-${status}` }, null, {
        transports: [ollamaTransport({ apiKey: credential })],
        fetchImpl: async () => ({
          ok: false,
          status,
          headers: new Headers(),
          text: async () => JSON.stringify({
            error: {
              code: credential,
              message: `provider echoed Authorization: Bearer ${credential}`,
            },
          }),
        }),
        circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
        capacityManager: new pipeline.ProviderCapacityManager(),
      });

      const serialized = JSON.stringify({ result, logs: [...warn.mock.calls, ...log.mock.calls] });
      expect(serialized).not.toContain(credential);
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Bearer');
      expect(result.error).toBe(`HTTP ${status}: ollama_provider_error`);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('redacts non-capacity in-band Ollama error details', async () => {
    const credential = 'sk-sensitive-in-band-secret';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: 'ollama-redaction-in-band' }, null, {
        transports: [ollamaTransport({ apiKey: credential })],
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            error: {
              code: credential,
              message: `provider echoed Authorization: Bearer ${credential}`,
            },
          }),
        }),
        circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
        capacityManager: new pipeline.ProviderCapacityManager(),
      });

      const serialized = JSON.stringify({ result, logs: [...warn.mock.calls, ...log.mock.calls] });
      expect(serialized).not.toContain(credential);
      expect(serialized).not.toContain('Authorization');
      expect(serialized).not.toContain('Bearer');
      expect(result.error).toBe('Provider returned an error payload: ollama_provider_error');
      expect(result.errorCode).toBe('ollama_provider_error');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
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
