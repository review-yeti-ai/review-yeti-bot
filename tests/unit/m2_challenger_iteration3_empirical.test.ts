import { describe, it, expect, beforeEach } from 'vitest';
import supertest from 'supertest';
import {
  ProviderNode,
  ProviderPool,
  ProviderPoolExhaustedError,
} from '../../src/router/providerPool';
import { createApp, getProviderPool } from '../../src/app';

describe('Challenger M2 Iteration 3 Empirical Stress Test Suite (ProviderPool & Circuit Breaker)', () => {
  describe('1. Circuit Breaker Status Transitions & Backoff Calculation', () => {
    let node: ProviderNode;

    beforeEach(() => {
      node = new ProviderNode({
        id: 'test-node',
        name: 'Test Provider Node',
        priority: 1,
      });
    });

    it('1.1 429 Rate Limit trips circuit immediately to OPEN and applies exponential backoff', () => {
      expect(node.circuitState).toBe('CLOSED');
      expect(node.healthState).toBe('healthy');

      // 1st 429 trip: 10,000ms * 2^0 = 10,000ms (10s)
      node.recordStart();
      node.recordFailure(429, 'Too Many Requests');

      expect(node.circuitState).toBe('OPEN');
      expect(node.healthState).toBe('cooling_down');
      expect(node.isAvailable()).toBe(false);
      expect(node.metrics.rateLimitHits).toBe(1);
      expect(node.coolingDownUntil).toBeCloseTo(Date.now() + 10_000, -3);

      // Reset to test 2nd trip exponential scaling
      node.coolingDownUntil = Date.now() - 1000;
      expect(node.isAvailable()).toBe(true); // transitions to HALF_OPEN
      expect(node.circuitState).toBe('HALF_OPEN');

      // 2nd 429 trip: 10,000ms * 2^1 = 20,000ms (20s)
      node.recordStart();
      node.recordFailure(429, 'Rate limit second hit');
      expect(node.circuitState).toBe('OPEN');
      expect(node.coolingDownUntil).toBeCloseTo(Date.now() + 20_000, -3);

      // 3rd 429 trip: 10,000ms * 2^2 = 40,000ms (40s)
      node.coolingDownUntil = Date.now() - 1000;
      node.isAvailable(); // transition to HALF_OPEN
      node.recordStart();
      node.recordFailure(429, 'Rate limit third hit');
      expect(node.coolingDownUntil).toBeCloseTo(Date.now() + 40_000, -3);
    });

    it('1.2 429 Rate Limit caps maximum cooldown duration at 300,000ms (5 minutes)', () => {
      // Trigger 10 consecutive 429 trips
      for (let i = 0; i < 10; i++) {
        node.coolingDownUntil = Date.now() - 1000;
        node.isAvailable(); // HALF_OPEN
        node.recordStart();
        node.recordFailure(429, 'Rate limited');
      }

      // 10,000 * 2^9 = 5,120,000ms, but should be capped at 300,000ms
      expect(node.coolingDownUntil! - Date.now()).toBeLessThanOrEqual(300_000);
      expect(node.coolingDownUntil).toBeCloseTo(Date.now() + 300_000, -3);
    });

    it('1.3 429 Retry-After header overrides exponential backoff and respects numeric vs string parsing', () => {
      // String header in seconds
      node.recordStart();
      node.recordFailure(429, 'Rate Limit', '45');
      expect(node.coolingDownUntil).toBeCloseTo(Date.now() + 45_000, -3);

      // Numeric header in seconds
      node.coolingDownUntil = Date.now() - 1000;
      node.isAvailable();
      node.recordStart();
      node.recordFailure(429, 'Rate Limit', 90);
      expect(node.coolingDownUntil).toBeCloseTo(Date.now() + 90_000, -3);

      // Invalid header string falls back to exponential calculation without NaN
      node.coolingDownUntil = Date.now() - 1000;
      node.isAvailable();
      node.recordStart();
      node.recordFailure(429, 'Rate Limit', 'invalid_header_val');
      expect(isNaN(node.coolingDownUntil!)).toBe(false);
      expect(node.coolingDownUntil!).toBeGreaterThan(Date.now());
    });

    it('1.4 5xx Server Errors transition through DEGRADED state before tripping circuit on 3rd failure', () => {
      // 1st 500 error -> degraded state, circuit remains CLOSED
      node.recordStart();
      node.recordFailure(500, 'Internal Error');
      expect(node.healthState).toBe('degraded');
      expect(node.circuitState).toBe('CLOSED');
      expect(node.isAvailable()).toBe(true);
      expect(node.metrics.consecutiveFailures).toBe(1);

      // 2nd 502 error -> degraded state, circuit remains CLOSED
      node.recordStart();
      node.recordFailure(502, 'Bad Gateway');
      expect(node.healthState).toBe('degraded');
      expect(node.circuitState).toBe('CLOSED');
      expect(node.isAvailable()).toBe(true);
      expect(node.metrics.consecutiveFailures).toBe(2);

      // 3rd 503 error -> trips circuit to OPEN
      node.recordStart();
      node.recordFailure(503, 'Service Unavailable');

      expect(node.metrics.consecutiveFailures).toBe(3);
      expect(node.healthState).toBe('cooling_down');
      expect(node.circuitState).toBe('OPEN');
      expect(node.isAvailable()).toBe(false);
      // Note: consecutiveCoolDownTrips was incremented on each failure (became 3), so cooldown is 15s * 2^(3-1) = 60s
      expect(node.coolingDownUntil).toBeCloseTo(Date.now() + 60_000, -3);
    });

    it('1.5 Empirical Flaw Verification: recordFailure increments consecutiveCoolDownTrips on non-tripping errors', () => {
      // 1st degraded failure
      node.recordStart();
      node.recordFailure(500, 'Internal Error'); // degraded, consecutiveCoolDownTrips = 1

      // 2nd degraded failure
      node.recordStart();
      node.recordFailure(500, 'Internal Error'); // degraded, consecutiveCoolDownTrips = 2

      // Successful request resets consecutiveFailures to 0, BUT does NOT reset consecutiveCoolDownTrips
      node.recordStart();
      node.recordSuccess(100);
      expect(node.metrics.consecutiveFailures).toBe(0);

      // Subsequent 429 trip inherits pre-incremented consecutiveCoolDownTrips (becomes 3)
      node.recordStart();
      node.recordFailure(429, 'Rate limit');

      // Cooldown is 10,000 * 2^(3-1) = 40,000ms instead of base 10,000ms
      expect(node.coolingDownUntil).toBeCloseTo(Date.now() + 40_000, -3);
    });
  });

  describe('2. HALF_OPEN Probe Lock & Recovery Under High Concurrency', () => {
    let node: ProviderNode;

    beforeEach(() => {
      node = new ProviderNode({
        id: 'probe-node',
        name: 'Probe Test Node',
        priority: 1,
      });
      // Force node into OPEN state with expired cooldown
      node.recordStart();
      node.recordFailure(429, 'Rate Limit Exceeded');
      node.coolingDownUntil = Date.now() - 500;
    });

    it('2.1 High concurrency (100 parallel callers) permits EXACTLY 1 probe request in HALF_OPEN state', () => {
      // 100 concurrent requests attempt to check availability
      const results = Array.from({ length: 100 }).map(() => node.isAvailable());

      const allowedProbes = results.filter(Boolean).length;
      const rejectedRequests = results.filter((r) => !r).length;

      expect(allowedProbes).toBe(1);
      expect(rejectedRequests).toBe(99);
      expect(node.circuitState).toBe('HALF_OPEN');
    });

    it('2.2 Successful probe in HALF_OPEN fully recovers provider to CLOSED and clears consecutive trips', () => {
      expect(node.isAvailable()).toBe(true); // transitions to HALF_OPEN
      expect(node.circuitState).toBe('HALF_OPEN');

      node.recordStart();
      node.recordSuccess(100);

      expect(node.circuitState).toBe('CLOSED');
      expect(node.healthState).toBe('healthy');
      expect(node.coolingDownUntil).toBeNull();
      expect(node.isAvailable()).toBe(true);
    });

    it('2.3 Failed probe in HALF_OPEN immediately re-trips to OPEN with escalated cooldown', () => {
      expect(node.isAvailable()).toBe(true); // transitions to HALF_OPEN
      expect(node.circuitState).toBe('HALF_OPEN');

      // Probe fails with 500
      node.recordStart();
      node.recordFailure(500, 'Server Error during probe');

      expect(node.circuitState).toBe('OPEN');
      expect(node.healthState).toBe('cooling_down');
      expect(node.isAvailable()).toBe(false);
      // 2nd trip should escalate cooldown
      expect(node.coolingDownUntil!).toBeGreaterThan(Date.now() + 15_000);
    });

    it('2.4 Probe timeout (>30s) allows a new probe request if previous probe hung', () => {
      expect(node.isAvailable()).toBe(true); // probe 1 lock acquired
      expect(node.circuitState).toBe('HALF_OPEN');

      // Immediate second attempt rejected
      expect(node.isAvailable()).toBe(false);

      // Fast-forward probe start time by 31 seconds to simulate hung probe
      // @ts-ignore - access private probeStartTime for empirical verification
      node['probeStartTime'] = Date.now() - 31_000;

      // New probe request allowed
      expect(node.isAvailable()).toBe(true);
    });
  });

  describe('3. High Concurrency Load Balancing & Failover Stress Engine', () => {
    let pool: ProviderPool;

    beforeEach(() => {
      pool = new ProviderPool();
      pool.registerProvider({ id: 'provider-1', name: 'Provider One', priority: 1 });
      pool.registerProvider({ id: 'provider-2', name: 'Provider Two', priority: 2 });
      pool.registerProvider({ id: 'provider-3', name: 'Provider Three', priority: 3 });
      pool.registerProvider({ id: 'provider-4', name: 'Provider Four', priority: 4 });
    });

    it('3.1 least_loaded strategy under 150 concurrent requests balances in-flight load across nodes', async () => {
      pool.setStrategy('least_loaded');
      const concurrency = 150;
      const providerDistribution: Record<string, number> = {
        'provider-1': 0,
        'provider-2': 0,
        'provider-3': 0,
        'provider-4': 0,
      };

      const tasks = Array.from({ length: concurrency }).map(async (_, idx) => {
        return pool.executeWithFailover(async (node) => {
          providerDistribution[node.id]++;
          // Simulate slight jitter in processing delay
          const delay = 5 + (idx % 10);
          await new Promise((resolve) => setTimeout(resolve, delay));
          return `result-${idx}`;
        });
      });

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(150);

      // Verify load was distributed across all 4 providers
      for (const id of ['provider-1', 'provider-2', 'provider-3', 'provider-4']) {
        expect(providerDistribution[id]).toBeGreaterThan(15);
      }
      expect(
        providerDistribution['provider-1'] +
          providerDistribution['provider-2'] +
          providerDistribution['provider-3'] +
          providerDistribution['provider-4']
      ).toBe(150);

      // Verify active in-flight requests cleanly reset to zero
      for (const id of ['provider-1', 'provider-2', 'provider-3', 'provider-4']) {
        const node = pool.getProvider(id)!;
        expect(node.metrics.activeInFlightRequests).toBe(0);
        expect(node.metrics.successfulRequests).toBe(providerDistribution[id]);
      }
    });

    it('3.2 round_robin strategy under high concurrency skips failing nodes without throwing or index corruption', async () => {
      pool.setStrategy('round_robin');

      // Trip provider-2 and provider-3 into OPEN state
      pool.getProvider('provider-2')!.recordFailure(429, 'Rate Limit');
      pool.getProvider('provider-3')!.recordFailure(429, 'Rate Limit');

      const concurrency = 100;
      const selections: string[] = [];

      const tasks = Array.from({ length: concurrency }).map(async () => {
        const node = pool.selectProvider();
        selections.push(node.id);
      });

      await Promise.all(tasks);

      expect(selections).toHaveLength(100);
      // All selections must be provider-1 or provider-4
      const invalidSelections = selections.filter((id) => id !== 'provider-1' && id !== 'provider-4');
      expect(invalidSelections).toHaveLength(0);

      // Verify non-zero distribution between active nodes
      const count1 = selections.filter((id) => id === 'provider-1').length;
      const count4 = selections.filter((id) => id === 'provider-4').length;
      expect(count1).toBeGreaterThan(30);
      expect(count4).toBeGreaterThan(30);
    });

    it('3.3 Cascading failover under high concurrency handles multi-tier failures seamlessly', async () => {
      pool.setStrategy('priority_fallback');
      const concurrency = 50;

      // Primary (provider-1) fails with 429
      // Secondary (provider-2) fails with 500
      // Tertiary (provider-3) succeeds
      const executionLogs: { provider: string; attempt: number }[] = [];

      const tasks = Array.from({ length: concurrency }).map(async (_, idx) => {
        return pool.executeWithFailover(async (node) => {
          executionLogs.push({ provider: node.id, attempt: idx });

          if (node.id === 'provider-1') {
            const err: any = new Error('Rate limit 429');
            err.status = 429;
            throw err;
          }
          if (node.id === 'provider-2') {
            const err: any = new Error('Server error 500');
            err.status = 500;
            throw err;
          }

          return `success-${idx}`;
        });
      });

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(50);
      for (const res of results) {
        expect(res.providerUsed).toBe('provider-3');
        expect(res.result).toMatch(/^success-\d+$/);
      }

      // Check metrics state
      const p1 = pool.getProvider('provider-1')!;
      expect(p1.circuitState).toBe('OPEN');
      expect(p1.metrics.rateLimitHits).toBe(50);

      const p2 = pool.getProvider('provider-2')!;
      // provider-2 accumulated 50 failures -> consecutiveFailures >= 3 trips circuit
      expect(p2.circuitState).toBe('OPEN');
      expect(p2.metrics.serverErrors).toBe(50);

      const p3 = pool.getProvider('provider-3')!;
      expect(p3.circuitState).toBe('CLOSED');
      expect(p3.metrics.successfulRequests).toBe(50);
    });

    it('3.4 Metric counter lockstep: 200 mixed successful and failing requests maintain 0 active in-flight leak', async () => {
      pool.setStrategy('round_robin');
      const totalOps = 200;

      const tasks = Array.from({ length: totalOps }).map(async (_, idx) => {
        return pool
          .executeWithFailover(async (node) => {
            if (idx % 3 === 0) {
              const err: any = new Error('503 Service Unavailable');
              err.status = 503;
              throw err;
            }
            return `ok-${idx}`;
          })
          .catch(() => {
            // Ignore pool exhaustion if experienced
          });
      });

      await Promise.all(tasks);

      // Verify active in-flight count on ALL nodes is exactly 0
      for (const id of ['provider-1', 'provider-2', 'provider-3', 'provider-4']) {
        const node = pool.getProvider(id)!;
        expect(node.metrics.activeInFlightRequests).toBe(0);
      }
    });
  });

  describe('4. Router Pool Snapshot & API Health Endpoint Integration', () => {
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
      app = createApp();
      const pool = getProviderPool();
      for (const id of ['openai', 'anthropic', 'google', 'deepseek']) {
        const p = pool.getProvider(id);
        if (p) {
          p.circuitState = 'CLOSED';
          p.healthState = 'healthy';
          p.coolingDownUntil = null;
          p.metrics = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            rateLimitHits: 0,
            serverErrors: 0,
            activeInFlightRequests: 0,
            consecutiveFailures: 0,
            avgLatencyMs: 0,
          };
        }
      }
    });

    it('4.1 /api/router/status reflects dynamic metrics and provider health transitions under load', async () => {
      const pool = getProviderPool();
      const openai = pool.getProvider('openai')!;
      const anthropic = pool.getProvider('anthropic')!;

      // Simulate OpenAI 429 trip
      openai.recordStart();
      openai.recordFailure(429, 'Rate limit exceeded');

      // Simulate Anthropic 500 error (degraded)
      anthropic.recordStart();
      anthropic.recordFailure(500, 'Server Error');

      const res = await supertest(app).get('/api/router/status');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.activeProvidersCount).toBe(3); // openai is cooling down, anthropic is degraded (still available)

      expect(res.body.providers.openai.circuitState).toBe('OPEN');
      expect(res.body.providers.openai.healthState).toBe('cooling_down');

      expect(res.body.providers.anthropic.circuitState).toBe('CLOSED');
      expect(res.body.providers.anthropic.healthState).toBe('degraded');
    });

    it('4.2 ProviderPoolExhaustedError lists attempted providers when pool is exhausted', async () => {
      const testPool = new ProviderPool('priority_fallback');
      testPool.registerProvider({ id: 'p1', name: 'P1', priority: 1 });
      testPool.registerProvider({ id: 'p2', name: 'P2', priority: 2 });

      testPool.getProvider('p1')!.recordFailure(429, 'Rate Limit');
      testPool.getProvider('p2')!.recordFailure(429, 'Rate Limit');

      try {
        testPool.selectProvider();
        expect.fail('Should have thrown ProviderPoolExhaustedError');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ProviderPoolExhaustedError);
        expect(err.attemptedProviders).toContain('p1');
        expect(err.attemptedProviders).toContain('p2');
      }
    });
  });
});
