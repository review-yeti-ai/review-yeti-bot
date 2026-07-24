import { describe, it, expect, beforeEach } from 'vitest';
import supertest from 'supertest';
import {
  ProviderNode,
  ProviderPool,
  ProviderPoolExhaustedError,
} from '../../src/router/providerPool';
import { createApp, getProviderPool, getTokenManager } from '../../src/app';

describe('Challenger M2 Empirical Stress Test Suite (OmniRoute Router & Token Management)', () => {
  describe('1. Cascading Provider Failures & Fallback Execution', () => {
    let pool: ProviderPool;

    beforeEach(() => {
      pool = new ProviderPool('priority_fallback');
      pool.registerProvider({ id: 'primary-1', name: 'Primary Model A', priority: 1 });
      pool.registerProvider({ id: 'primary-2', name: 'Primary Model B', priority: 2 });
      pool.registerProvider({ id: 'fallback-1', name: 'Fallback Model C', priority: 3 });
      pool.registerProvider({ id: 'fallback-2', name: 'Emergency Fallback D', priority: 4 });
    });

    it('1.1 Cascades through 5xx/429 errors from primary providers to execute on healthy fallback provider', async () => {
      const operationCallCount: Record<string, number> = {
        'primary-1': 0,
        'primary-2': 0,
        'fallback-1': 0,
        'fallback-2': 0,
      };

      const result = await pool.executeWithFailover(async (node) => {
        operationCallCount[node.id]++;
        if (node.id === 'primary-1') {
          const err: any = new Error('Rate limit exceeded');
          err.status = 429;
          err.headers = { 'retry-after': '60' };
          throw err;
        }
        if (node.id === 'primary-2') {
          const err: any = new Error('503 Service Unavailable');
          err.status = 503;
          throw err;
        }
        return `success-from-${node.id}`;
      });

      expect(result.result).toBe('success-from-fallback-1');
      expect(result.providerUsed).toBe('fallback-1');

      expect(operationCallCount['primary-1']).toBe(1);
      expect(operationCallCount['primary-2']).toBe(1);
      expect(operationCallCount['fallback-1']).toBe(1);
      expect(operationCallCount['fallback-2']).toBe(0);

      // Verify node states
      const primary1Node = pool.getProvider('primary-1')!;
      expect(primary1Node.circuitState).toBe('OPEN');
      expect(primary1Node.healthState).toBe('cooling_down');
      expect(primary1Node.metrics.rateLimitHits).toBe(1);

      const primary2Node = pool.getProvider('primary-2')!;
      expect(primary2Node.healthState).toBe('degraded');
      expect(primary2Node.metrics.serverErrors).toBe(1);

      const fallback1Node = pool.getProvider('fallback-1')!;
      expect(fallback1Node.healthState).toBe('healthy');
      expect(fallback1Node.metrics.successfulRequests).toBe(1);
    });

    it('1.2 Throws ProviderPoolExhaustedError when ALL primary and fallback providers fail', async () => {
      const attemptedProviders: string[] = [];

      await expect(
        pool.executeWithFailover(async (node) => {
          attemptedProviders.push(node.id);
          const err: any = new Error(`HTTP 500 failure from ${node.id}`);
          err.status = 500;
          throw err;
        })
      ).rejects.toThrow(ProviderPoolExhaustedError);

      expect(attemptedProviders).toEqual(['primary-1', 'primary-2', 'fallback-1', 'fallback-2']);
      const snapshot = pool.getStatusSnapshot();
      expect(snapshot.status).toBe('ok'); // snapshot checks available vs total; degraded nodes with < 3 failures are still available
    });

    it('1.3 Correctly trips circuit breakers on repeated 5xx errors across multiple fallback attempts', async () => {
      // Execute failing operations 3 times to trigger 3 consecutive failures on primary-1
      for (let i = 0; i < 3; i++) {
        await pool
          .executeWithFailover(async (node) => {
            if (node.id === 'primary-1') {
              const err: any = new Error('500 Internal Error');
              err.status = 500;
              throw err;
            }
            return 'ok';
          })
          .catch(() => {});
      }

      const p1 = pool.getProvider('primary-1')!;
      expect(p1.metrics.consecutiveFailures).toBe(3);
      expect(p1.circuitState).toBe('OPEN');
      expect(p1.healthState).toBe('cooling_down');
      expect(p1.isAvailable()).toBe(false);

      // Next executeWithFailover should skip primary-1 completely and start at primary-2
      const res = await pool.executeWithFailover(async (node) => `ok-from-${node.id}`);
      expect(res.providerUsed).toBe('primary-2');
    });

    it('1.4 Respects Retry-After header integer vs string formatting during 429 failover', () => {
      const p1 = pool.getProvider('primary-1')!;
      const p2 = pool.getProvider('primary-2')!;

      p1.recordStart();
      p1.recordFailure(429, 'Rate Limit', '120'); // string seconds

      p2.recordStart();
      p2.recordFailure(429, 'Rate Limit', 45); // number seconds

      expect(p1.coolingDownUntil).toBeCloseTo(Date.now() + 120000, -3);
      expect(p2.coolingDownUntil).toBeCloseTo(Date.now() + 45000, -3);
    });
  });

  describe('2. High Concurrency Throughput under Least-Loaded and Round-Robin Strategies', () => {
    let pool: ProviderPool;

    beforeEach(() => {
      pool = new ProviderPool();
      pool.registerProvider({ id: 'node-a', name: 'Node A', priority: 1 });
      pool.registerProvider({ id: 'node-b', name: 'Node B', priority: 2 });
      pool.registerProvider({ id: 'node-c', name: 'Node C', priority: 3 });
    });

    it('2.1 least_loaded strategy dynamically balances high concurrency in-flight requests', async () => {
      pool.setStrategy('least_loaded');
      const concurrency = 60;
      const executionCounts: Record<string, number> = { 'node-a': 0, 'node-b': 0, 'node-c': 0 };

      // Simulate 60 concurrent requests with mock latency delay
      const tasks = Array.from({ length: concurrency }).map(async (_, idx) => {
        return pool.executeWithFailover(async (node) => {
          executionCounts[node.id]++;
          // Variable delay based on node to test dynamic rebalancing
          const delay = node.id === 'node-a' ? 30 : node.id === 'node-b' ? 15 : 5;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return `resp-${idx}`;
        });
      });

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(60);

      // Verify that all nodes received requests (distributed dynamic load)
      expect(executionCounts['node-a']).toBeGreaterThan(0);
      expect(executionCounts['node-b']).toBeGreaterThan(0);
      expect(executionCounts['node-c']).toBeGreaterThan(0);
      expect(executionCounts['node-a'] + executionCounts['node-b'] + executionCounts['node-c']).toBe(60);

      // Verify in-flight count returns to zero after completion
      for (const node of [pool.getProvider('node-a')!, pool.getProvider('node-b')!, pool.getProvider('node-c')!]) {
        expect(node.metrics.activeInFlightRequests).toBe(0);
        expect(node.metrics.successfulRequests).toBe(executionCounts[node.id]);
      }
    });

    it('2.2 round_robin strategy distributes concurrent requests sequentially and skips offline nodes', async () => {
      pool.setStrategy('round_robin');

      // Trip node-b into OPEN state
      const nodeB = pool.getProvider('node-b')!;
      nodeB.recordFailure(429, 'Rate limit');
      expect(nodeB.isAvailable()).toBe(false);

      const selections: string[] = [];
      for (let i = 0; i < 6; i++) {
        const node = pool.selectProvider();
        selections.push(node.id);
      }

      // Should alternate strictly between node-a and node-c, skipping node-b
      expect(selections).toEqual(['node-a', 'node-c', 'node-a', 'node-c', 'node-a', 'node-c']);
    });

    it('2.3 Concurrent successes and failures maintain exact metrics integrity without race conditions', async () => {
      pool.setStrategy('round_robin');
      const totalOps = 100;

      const tasks = Array.from({ length: totalOps }).map(async (_, idx) => {
        return pool.executeWithFailover(async (node) => {
          if (idx % 4 === 0) {
            const err: any = new Error('500 Error');
            err.status = 500;
            throw err;
          }
          return 'ok';
        });
      });

      await Promise.allSettled(tasks);

      let totalSuccess = 0;
      let totalFailed = 0;
      let totalActive = 0;

      for (const id of ['node-a', 'node-b', 'node-c']) {
        const node = pool.getProvider(id)!;
        totalSuccess += node.metrics.successfulRequests;
        totalFailed += node.metrics.failedRequests;
        totalActive += node.metrics.activeInFlightRequests;
      }

      expect(totalSuccess + totalFailed).toBeGreaterThanOrEqual(totalOps);
      expect(totalActive).toBe(0);
    });
  });

  describe('3. Circuit Breaker Recovery in HALF_OPEN State', () => {
    let node: ProviderNode;

    beforeEach(() => {
      node = new ProviderNode({
        id: 'test-provider',
        name: 'Test Provider',
        priority: 1,
      });
      // Force into OPEN state
      node.recordStart();
      node.recordFailure(429, 'Rate limited');
      expect(node.circuitState).toBe('OPEN');
    });

    it('3.1 Successful probe in HALF_OPEN recovers provider to CLOSED and healthy state', () => {
      // Simulate cooldown expiry
      node.coolingDownUntil = Date.now() - 1000;

      // isAvailable() triggers transition to HALF_OPEN
      expect(node.isAvailable()).toBe(true);
      expect(node.circuitState).toBe('HALF_OPEN');

      // Probe operation succeeds
      node.recordStart();
      node.recordSuccess(120);

      expect(node.circuitState).toBe('CLOSED');
      expect(node.healthState).toBe('healthy');
      expect(node.coolingDownUntil).toBeNull();
      expect(node.metrics.consecutiveFailures).toBe(0);
      expect(node.metrics.successfulRequests).toBe(1);
    });

    it('3.2 Failed probe (5xx) in HALF_OPEN immediately re-trips circuit breaker to OPEN', () => {
      // Simulate cooldown expiry
      node.coolingDownUntil = Date.now() - 1000;

      expect(node.isAvailable()).toBe(true);
      expect(node.circuitState).toBe('HALF_OPEN');

      // Probe operation fails with 500
      node.recordStart();
      node.recordFailure(500, 'Server Error');

      expect(node.circuitState).toBe('OPEN');
      expect(node.healthState).toBe('cooling_down');
      expect(node.coolingDownUntil).toBeGreaterThan(Date.now());
      expect(node.isAvailable()).toBe(false);
    });

    it('3.3 Failed probe (429) in HALF_OPEN increases exponential backoff cooldown', () => {
      const initialCooldownEnd = node.coolingDownUntil!;
      node.coolingDownUntil = Date.now() - 1000;

      expect(node.isAvailable()).toBe(true);
      expect(node.circuitState).toBe('HALF_OPEN');

      // Probe fails again with 429
      node.recordStart();
      node.recordFailure(429, 'Rate Limit');

      expect(node.circuitState).toBe('OPEN');
      // Second trip should have double the base cooldown (20,000ms instead of 10,000ms)
      expect(node.coolingDownUntil! - Date.now()).toBeGreaterThan(15000);
    });

    it('3.4 Full recovery cycle: OPEN -> HALF_OPEN -> Fail -> OPEN -> HALF_OPEN -> Pass -> CLOSED', () => {
      // 1. First probe fails
      node.coolingDownUntil = Date.now() - 100;
      expect(node.isAvailable()).toBe(true); // HALF_OPEN
      node.recordStart();
      node.recordFailure(503, 'Service unavailable');
      expect(node.circuitState).toBe('OPEN');

      // 2. Second cooldown expires
      node.coolingDownUntil = Date.now() - 100;
      expect(node.isAvailable()).toBe(true); // HALF_OPEN

      // 3. Second probe succeeds
      node.recordStart();
      node.recordSuccess(80);

      expect(node.circuitState).toBe('CLOSED');
      expect(node.healthState).toBe('healthy');
      expect(node.isAvailable()).toBe(true);
    });

    it('3.5 High concurrency race condition on HALF_OPEN allows ONLY 1 probe request through while rejecting concurrent requests', () => {
      node.coolingDownUntil = Date.now() - 1000;

      const availabilityResults = Array.from({ length: 50 }).map(() => node.isAvailable());
      const allowedProbes = availabilityResults.filter(Boolean).length;
      const rejectedRequests = availabilityResults.filter((v) => !v).length;

      expect(allowedProbes).toBe(1);
      expect(rejectedRequests).toBe(49);
      expect(node.circuitState).toBe('HALF_OPEN');
    });
  });

  describe('4. HTTP GET /api/router/status Output Correctness under High-Load & Failover', () => {
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
      app = createApp();
      // Reset global provider pool state if needed
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

    it('4.1 Returns 200 OK with correct status JSON schema and healthy counts', async () => {
      const res = await supertest(app).get('/api/router/status');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).toHaveProperty('timestamp');
      expect(res.body).toHaveProperty('strategy', 'priority_fallback');
      expect(res.body.activeProvidersCount).toBe(4);
      expect(res.body.totalProvidersCount).toBe(4);

      expect(res.body.providers).toHaveProperty('openai');
      expect(res.body.providers).toHaveProperty('anthropic');
      expect(res.body.providers).toHaveProperty('google');
      expect(res.body.providers).toHaveProperty('deepseek');

      expect(res.body.metrics).toHaveProperty('totalTokens');
      expect(res.body.metrics).toHaveProperty('byPersona');
    });

    it('4.2 Updates status to degraded when primary provider trips circuit breaker', async () => {
      const pool = getProviderPool();
      const openai = pool.getProvider('openai')!;

      // Trip primary provider
      openai.recordStart();
      openai.recordFailure(429, 'Rate Limit Exceeded');

      const res = await supertest(app).get('/api/router/status');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('degraded');
      expect(res.body.activeProvidersCount).toBe(3);
      expect(res.body.totalProvidersCount).toBe(4);

      expect(res.body.providers.openai.circuitState).toBe('OPEN');
      expect(res.body.providers.openai.healthState).toBe('cooling_down');
      expect(res.body.providers.openai.metrics.rateLimitHits).toBe(1);
    });

    it('4.3 Updates status to exhausted when ALL providers trip circuit breaker, and /health reflects degraded status', async () => {
      const pool = getProviderPool();

      for (const id of ['openai', 'anthropic', 'google', 'deepseek']) {
        const node = pool.getProvider(id)!;
        node.recordStart();
        node.recordFailure(429, 'All rate limited');
      }

      const routerRes = await supertest(app).get('/api/router/status');
      expect(routerRes.status).toBe(200);
      expect(routerRes.body.status).toBe('exhausted');
      expect(routerRes.body.activeProvidersCount).toBe(0);

      const healthRes = await supertest(app).get('/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe('degraded');
      expect(healthRes.body.router.poolStatus).toBe('exhausted');
      expect(healthRes.body.router.activeProviders).toBe(0);
    });
  });
});
