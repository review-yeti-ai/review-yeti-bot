import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ProviderNode,
  ProviderPool,
  ProviderPoolExhaustedError,
} from '../../src/router/providerPool';

describe('ProviderPool Subsystem Unit Tests', () => {
  describe('ProviderNode State Machine & Circuit Breaker', () => {
    let node: ProviderNode;

    beforeEach(() => {
      node = new ProviderNode({
        id: 'openai',
        name: 'OpenAI GPT-4o',
        priority: 1,
      });
    });

    it('initializes in healthy / CLOSED state', () => {
      expect(node.healthState).toBe('healthy');
      expect(node.circuitState).toBe('CLOSED');
      expect(node.coolingDownUntil).toBeNull();
      expect(node.isAvailable()).toBe(true);
    });

    it('records start and success correctly', () => {
      node.recordStart();
      expect(node.metrics.totalRequests).toBe(1);
      expect(node.metrics.activeInFlightRequests).toBe(1);

      node.recordSuccess(100);
      expect(node.metrics.successfulRequests).toBe(1);
      expect(node.metrics.activeInFlightRequests).toBe(0);
      expect(node.metrics.avgLatencyMs).toBe(100);
    });

    it('trips circuit breaker on 429 Rate Limit', () => {
      node.recordStart();
      node.recordFailure(429, 'Rate limit exceeded');

      expect(node.healthState).toBe('cooling_down');
      expect(node.circuitState).toBe('OPEN');
      expect(node.coolingDownUntil).toBeGreaterThan(Date.now());
      expect(node.isAvailable()).toBe(false);
      expect(node.metrics.rateLimitHits).toBe(1);
    });

    it('parses Retry-After header for exact 429 cooldown', () => {
      node.recordStart();
      node.recordFailure(429, 'Rate limit exceeded', '30'); // 30 seconds

      expect(node.coolingDownUntil).toBeCloseTo(Date.now() + 30000, -3);
    });

    it('trips circuit breaker on 3 consecutive 5xx errors', () => {
      node.recordStart();
      node.recordFailure(500, 'Internal Server Error');
      expect(node.healthState).toBe('degraded');
      expect(node.circuitState).toBe('CLOSED');
      expect(node.isAvailable()).toBe(true);

      node.recordStart();
      node.recordFailure(502, 'Bad Gateway');
      expect(node.healthState).toBe('degraded');

      node.recordStart();
      node.recordFailure(503, 'Service Unavailable');
      expect(node.healthState).toBe('cooling_down');
      expect(node.circuitState).toBe('OPEN');
      expect(node.isAvailable()).toBe(false);
    });

    it('transitions to HALF_OPEN probe state after cooldown window expires', () => {
      node.recordStart();
      node.recordFailure(429, 'Rate limit');

      // Force coolingDownUntil into the past
      node.coolingDownUntil = Date.now() - 1000;

      expect(node.isAvailable()).toBe(true);
      expect(node.circuitState).toBe('HALF_OPEN');
    });

    it('recovers from HALF_OPEN to CLOSED / healthy on successful probe', () => {
      node.circuitState = 'HALF_OPEN';
      node.healthState = 'cooling_down';

      node.recordStart();
      node.recordSuccess(150);

      expect(node.circuitState).toBe('CLOSED');
      expect(node.healthState).toBe('healthy');
      expect(node.coolingDownUntil).toBeNull();
    });

    it('enforces single probe request limit in HALF_OPEN state via atomic isProbing lock', () => {
      node.recordStart();
      node.recordFailure(429, 'Rate limited');
      node.coolingDownUntil = Date.now() - 1000; // Cooldown expired

      // First caller acquires probe lock
      const firstAvailable = node.isAvailable();
      expect(firstAvailable).toBe(true);
      expect(node.circuitState).toBe('HALF_OPEN');

      // Concurrent second caller is rejected while probe is in flight
      const secondAvailable = node.isAvailable();
      expect(secondAvailable).toBe(false);

      // Probe completes successfully
      node.recordStart();
      node.recordSuccess(100);

      // After recovery, node is CLOSED and available for normal traffic
      expect(node.circuitState).toBe('CLOSED');
      expect(node.isAvailable()).toBe(true);
    });
  });

  describe('ProviderPool Load Balancing Strategies', () => {
    let pool: ProviderPool;

    beforeEach(() => {
      pool = new ProviderPool();
      pool.registerProvider({ id: 'openai', name: 'OpenAI', priority: 1 });
      pool.registerProvider({ id: 'anthropic', name: 'Anthropic', priority: 2 });
      pool.registerProvider({ id: 'google', name: 'Google', priority: 3 });
    });

    it('priority_fallback strategy picks highest priority healthy provider', () => {
      pool.setStrategy('priority_fallback');

      expect(pool.selectProvider().id).toBe('openai');

      // Trip primary provider
      pool.getProvider('openai')!.recordFailure(429, 'Rate limit');

      expect(pool.selectProvider().id).toBe('anthropic');

      // Trip secondary provider
      pool.getProvider('anthropic')!.recordFailure(429, 'Rate limit');

      expect(pool.selectProvider().id).toBe('google');
    });

    it('round_robin strategy distributes requests sequentially across active providers', () => {
      pool.setStrategy('round_robin');

      expect(pool.selectProvider().id).toBe('openai');
      expect(pool.selectProvider().id).toBe('anthropic');
      expect(pool.selectProvider().id).toBe('google');
      expect(pool.selectProvider().id).toBe('openai');
    });

    it('least_loaded strategy selects provider with lowest active in-flight count', () => {
      pool.setStrategy('least_loaded');

      const p1 = pool.getProvider('openai')!;
      const p2 = pool.getProvider('anthropic')!;
      const p3 = pool.getProvider('google')!;

      p1.recordStart();
      p1.recordStart(); // p1 has 2 in-flight

      p2.recordStart(); // p2 has 1 in-flight

      p3.recordStart();
      p3.recordStart();
      p3.recordStart(); // p3 has 3 in-flight

      const selected = pool.selectProvider();
      expect(selected.id).toBe('anthropic');
    });

    it('honors preferred provider request if available', () => {
      pool.setStrategy('priority_fallback');

      const selected = pool.selectProvider('google');
      expect(selected.id).toBe('google');
    });

    it('falls back to pool strategy if preferred provider is cooling down', () => {
      pool.getProvider('google')!.recordFailure(429, 'Rate limit');

      const selected = pool.selectProvider('google');
      expect(selected.id).toBe('openai');
    });

    it('selectProvider respects excludeIds array and applies active strategy to unattempted providers', () => {
      pool.setStrategy('round_robin');

      const sel1 = pool.selectProvider(undefined, ['openai']);
      expect(sel1.id).toBe('anthropic');

      const sel2 = pool.selectProvider(undefined, ['openai']);
      expect(sel2.id).toBe('google');

      const sel3 = pool.selectProvider(undefined, ['openai']);
      expect(sel3.id).toBe('anthropic');
    });

    it('throws ProviderPoolExhaustedError when all providers are unavailable', () => {
      pool.getProvider('openai')!.recordFailure(429, 'Rate limit');
      pool.getProvider('anthropic')!.recordFailure(429, 'Rate limit');
      pool.getProvider('google')!.recordFailure(429, 'Rate limit');

      expect(() => pool.selectProvider()).toThrow(ProviderPoolExhaustedError);
    });
  });

  describe('ProviderPool Failover Execution', () => {
    let pool: ProviderPool;

    beforeEach(() => {
      pool = new ProviderPool('priority_fallback');
      pool.registerProvider({ id: 'openai', name: 'OpenAI', priority: 1 });
      pool.registerProvider({ id: 'anthropic', name: 'Anthropic', priority: 2 });
    });

    it('executes operation successfully on primary provider', async () => {
      const operation = vi.fn().mockImplementation(async (node: ProviderNode) => {
        return `response-from-${node.id}`;
      });

      const { result, providerUsed } = await pool.executeWithFailover(operation);
      expect(result).toBe('response-from-openai');
      expect(providerUsed).toBe('openai');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('automatically fails over to next healthy provider when primary fails', async () => {
      const operation = vi.fn().mockImplementation(async (node: ProviderNode) => {
        if (node.id === 'openai') {
          const err: any = new Error('503 Service Unavailable');
          err.status = 503;
          throw err;
        }
        return `response-from-${node.id}`;
      });

      const { result, providerUsed } = await pool.executeWithFailover(operation);
      expect(result).toBe('response-from-anthropic');
      expect(providerUsed).toBe('anthropic');
      expect(operation).toHaveBeenCalledTimes(2);

      // Verify status snapshot reflects degraded/cooling state
      const snapshot = pool.getStatusSnapshot();
      expect(snapshot.providers['openai'].metrics.failedRequests).toBe(1);
      expect(snapshot.providers['anthropic'].metrics.successfulRequests).toBe(1);
    });

    it('executes failover using least_loaded strategy among remaining unattempted candidates', async () => {
      const multiPool = new ProviderPool('least_loaded');
      multiPool.registerProvider({ id: 'p1', name: 'P1', priority: 1 });
      multiPool.registerProvider({ id: 'p2', name: 'P2', priority: 2 });
      multiPool.registerProvider({ id: 'p3', name: 'P3', priority: 3 });

      // Load p3 with in-flight requests
      multiPool.getProvider('p3')!.recordStart();
      multiPool.getProvider('p3')!.recordStart();

      const operation = vi.fn().mockImplementation(async (node: ProviderNode) => {
        if (node.id === 'p1') {
          const err: any = new Error('500 Server Error');
          err.status = 500;
          throw err;
        }
        return `response-from-${node.id}`;
      });

      const { result, providerUsed } = await multiPool.executeWithFailover(operation);
      expect(providerUsed).toBe('p2'); // Selected because p2 has 0 in-flight vs p3's 2 in-flight
      expect(result).toBe('response-from-p2');
    });

    it('throws ProviderPoolExhaustedError if all attempted providers fail', async () => {
      const operation = vi.fn().mockImplementation(async (node: ProviderNode) => {
        const err: any = new Error(`HTTP 500 error from ${node.id}`);
        err.status = 500;
        throw err;
      });

      await expect(pool.executeWithFailover(operation)).rejects.toThrow(ProviderPoolExhaustedError);
    });
  });
});
