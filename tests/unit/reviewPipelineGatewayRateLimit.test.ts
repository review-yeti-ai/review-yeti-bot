/**
 * The Action pipeline's gateway lane rides out an upstream concurrency rejection on the shared
 * rate-limit schedule (`planRateLimitRetry` in `src/review/laneInfrastructure.js`) instead of
 * tripping the breaker a few seconds after the first 429.
 *
 * Shape: one upstream account with 15 concurrent slots behind the gateway alias answers the
 * overflow with HTTP 429 "Concurrent limit reached ... 15/15 slots in use".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const concurrencyBody = JSON.stringify({ status_code: 429, error: { type: 'rate_limit_error', code: 'concurrent_budget_exceeded',
  message: 'Concurrent limit reached for example-model: 15/15 slots in use. Wait for a request to complete or upgrade your plan for more.' } });

function rejected(retryAfter?: string) {
  return { ok: false, status: 429, headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}), text: async () => concurrencyBody };
}
function success() {
  return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => ({ choices: [{ message: { content: '{"findings":[]}' } }] }) };
}
const gateway = { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-key', model: 'example-model', provider: 'openrouter', stream: false };

afterEach(() => { vi.restoreAllMocks(); delete process.env.REVIEW_ACTION_BUDGET_MS; });

describe('Action pipeline gateway rate-limit ladder', () => {
  it('keeps the lane alive through more consecutive 429s than the fixed recovery envelope allows', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    let calls = 0;
    const sleeps: number[] = [];
    const breaker = new pipeline.RunTransportCircuitBreaker();
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: '1' }, null, {
      transports: [gateway],
      fetchImplementation: async () => { calls += 1; return calls <= 8 ? rejected() : success(); },
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
      circuitBreaker: breaker,
      capacityManager: new pipeline.ProviderCapacityManager(),
    });
    expect(result.decision).toBe('APPROVE');
    expect(calls).toBe(9);
    expect(breaker.isTripped(gateway)).toBe(false);
    expect(result.recoveryAction).toBe('rate_limit_retry');
    // The envelope's own retry takes no wait (no Retry-After); then seven full-jitter waits with
    // random fixed at 0.5: half of min(30s, 2s * 2^(n-1)).
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });

  it('floors every wait at Retry-After', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: '2' }, null, {
      transports: [gateway],
      fetchImplementation: async () => { calls += 1; return calls <= 4 ? rejected('7') : success(); },
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager: new pipeline.ProviderCapacityManager(),
    });
    expect(result.decision).toBe('APPROVE');
    // The ladder's waits (after the envelope's own bounded retry) are never shorter than 7s.
    expect(sleeps.length).toBeGreaterThanOrEqual(3);
    expect(sleeps.slice(-3).every((milliseconds) => milliseconds >= 7_000)).toBe(true);
  });

  it('trips the breaker and fails the lane as http_429 only when no further wait fits the Action deadline', async () => {
    // A budget already inside the terminal margin: no rate-limit wait can fit.
    process.env.REVIEW_ACTION_BUDGET_MS = '1';
    const breaker = new pipeline.RunTransportCircuitBreaker();
    let calls = 0;
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: '3' }, null, {
      transports: [gateway],
      fetchImplementation: async () => { calls += 1; return rejected(); },
      sleepImplementation: async () => undefined,
      circuitBreaker: breaker,
      capacityManager: new pipeline.ProviderCapacityManager(),
    });
    expect(result.decision).toBe('ERROR');
    expect(result.failureClass).toBe('http_429');
    expect(breaker.isTripped(gateway)).toBe(true);
    expect(calls).toBe(2);
  });

  it('keeps fast failover when another transport is configured after the gateway', async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const result = await pipeline.reviewWithModel(persona, diffFiles, { repo: 'fixture/repository', prNumber: '4' }, null, {
      transports: [gateway, { name: 'backup', baseUrl: 'https://backup.example/v1', apiKey: 'backup-key', model: 'backup-model', stream: false }],
      fetchImplementation: async (url: string) => { calls.push(url); return url.includes('backup.example') ? success() : rejected(); },
      sleepImplementation: async (milliseconds: number) => { sleeps.push(milliseconds); },
      circuitBreaker: new pipeline.RunTransportCircuitBreaker(),
      capacityManager: new pipeline.ProviderCapacityManager(),
    });
    expect(result.decision).toBe('APPROVE');
    expect(result.transport).toBe('backup');
    // The gateway took only its fixed envelope (two calls), then failed over.
    expect(calls.filter((url) => !url.includes('backup.example'))).toHaveLength(2);
  });
});
