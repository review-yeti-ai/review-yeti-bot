import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ProviderNode,
  ProviderPool,
  ProviderPoolExhaustedError,
} from '../../src/router/providerPool';

describe('Challenger M2 Iteration 2 Empirical Stress Test Suite (Provider Pool, Circuit Breaker HALF_OPEN & Failover)', () => {
  describe('1. HALF_OPEN Circuit Breaker Atomic Probing Lock & Concurrency', () => {
    let node: ProviderNode;

    beforeEach(() => {
      node = new ProviderNode({
        id: 'openai-test',
        name: 'OpenAI Test Node',
        priority: 1,
      });
      // Force node into OPEN state
      node.recordStart();
      node.recordFailure(429, 'Rate limited');
      expect(node.circuitState).toBe('OPEN');
    });

    it('1.1 permits exactly 1 probe request upon cooldown expiry and sets HALF_OPEN & isProbing flags', () => {
      node.coolingDownUntil = Date.now() - 500; // Cooldown expired

      const isAvailableFirst = node.isAvailable();
      expect(isAvailableFirst).toBe(true);
      expect(node.circuitState).toBe('HALF_OPEN');

      const snapshot = node.getSnapshot();
      expect(snapshot.circuitState).toBe('HALF_OPEN');
    });

    it('1.2 rejects 100 concurrent caller checks during HALF_OPEN state (permitting exactly 1 probe)', () => {
      node.coolingDownUntil = Date.now() - 500;

      const results = Array.from({ length: 100 }).map(() => node.isAvailable());
      const passedCount = results.filter(Boolean).length;
      const rejectedCount = results.filter((r) => !r).length;

      expect(passedCount).toBe(1);
      expect(rejectedCount).toBe(99);
      expect(node.circuitState).toBe('HALF_OPEN');
    });

    it('1.3 rejects subsequent callers while probe operation is in-flight', async () => {
      node.coolingDownUntil = Date.now() - 500;

      // Caller 1 initiates probe
      expect(node.isAvailable()).toBe(true);

      // Callers 2, 3, 4 while probe is in flight
      expect(node.isAvailable()).toBe(false);
      expect(node.isAvailable()).toBe(false);
      expect(node.isAvailable()).toBe(false);

      // Probe completes
      node.recordStart();
      node.recordSuccess(100);

      // Post-recovery callers succeed
      expect(node.circuitState).toBe('CLOSED');
      expect(node.isAvailable()).toBe(true);
    });

    it('1.4 re-trips circuit to OPEN upon probe failure (429 or 5xx) with exponential cooldown', () => {
      node.coolingDownUntil = Date.now() - 500;

      expect(node.isAvailable()).toBe(true); // Transitions to HALF_OPEN
      expect(node.circuitState).toBe('HALF_OPEN');

      node.recordStart();
      node.recordFailure(503, 'Service Unavailable');

      expect(node.circuitState).toBe('OPEN');
      expect(node.healthState).toBe('cooling_down');
      expect(node.coolingDownUntil).toBeGreaterThan(Date.now());
      expect(node.isAvailable()).toBe(false);
    });

    it('1.5 probe failure with 401 Unauthorized trips circuit breaker to OPEN', () => {
      node.coolingDownUntil = Date.now() - 500;

      expect(node.isAvailable()).toBe(true); // Transitions to HALF_OPEN
      expect(node.circuitState).toBe('HALF_OPEN');

      node.recordStart();
      node.recordFailure(401, 'Unauthorized');

      // Observe state after 401 failure: circuit breaker trips to OPEN
      expect(node.circuitState).toBe('OPEN');
    });

    it('1.6 allows new probe if probe startTime exceeds 30-second timeout threshold', () => {
      node.coolingDownUntil = Date.now() - 500;

      expect(node.isAvailable()).toBe(true); // First probe lock acquired
      expect(node.isAvailable()).toBe(false); // Immediate 2nd attempt blocked

      // Simulate probe hanging for > 30 seconds
      // @ts-ignore - access private field for empirical verification
      node.probeStartTime = Date.now() - 31000;

      // Now next attempt should be permitted as fallback probe
      expect(node.isAvailable()).toBe(true);
    });
  });

  describe('2. Failover under Round-Robin Load-Balancing Strategy', () => {
    let pool: ProviderPool;

    beforeEach(() => {
      pool = new ProviderPool('round_robin');
      pool.registerProvider({ id: 'p1', name: 'Provider 1', priority: 1 });
      pool.registerProvider({ id: 'p2', name: 'Provider 2', priority: 2 });
      pool.registerProvider({ id: 'p3', name: 'Provider 3', priority: 3 });
    });

    it('2.1 FINDING / DEFECT: round_robin failover skips provider p2 when primary p1 fails at index 0', async () => {
      const attempted: string[] = [];

      const result = await pool.executeWithFailover(async (node) => {
        attempted.push(node.id);
        if (node.id === 'p1') {
          const err: any = new Error('500 Server Error');
          err.status = 500;
          throw err;
        }
        return `success-${node.id}`;
      });

      // EMPIRICAL OBSERVATION:
      // roundRobinIndex is incremented from 0 to 1 when p1 is selected.
      // When p1 fails, candidate list shrinks to [p2, p3] (length 2).
      // selectProviderFromList evaluates 1 % 2 = 1, selecting candidates[1] = p3!
      // Therefore, p2 (index 0 of remaining candidates) is SKIPPED!
      expect(result.providerUsed).toBe('p3');
      expect(attempted).toEqual(['p1', 'p3']); // p2 was skipped during failover
    });

    it('2.2 demonstrates round_robin index shift behavior across starting index positions', async () => {
      // Test starting from index 0, 1, and 2
      const attemptedPerRun: string[][] = [];

      for (let initialCall = 0; initialCall < 3; initialCall++) {
        const testPool = new ProviderPool('round_robin');
        testPool.registerProvider({ id: 'n1', name: 'N1', priority: 1 });
        testPool.registerProvider({ id: 'n2', name: 'N2', priority: 2 });
        testPool.registerProvider({ id: 'n3', name: 'N3', priority: 3 });

        // Advance roundRobinIndex
        for (let i = 0; i < initialCall; i++) {
          testPool.selectProvider();
        }

        const attemptedThisRun: string[] = [];
        await testPool.executeWithFailover(async (node) => {
          attemptedThisRun.push(node.id);
          if (attemptedThisRun.length === 1) {
            const err: any = new Error('429 Rate Limit');
            err.status = 429;
            throw err;
          }
          return `ok-${node.id}`;
        });
        attemptedPerRun.push(attemptedThisRun);
      }

      // Starting at index 0 (selects n1 -> fails -> candidates [n2, n3], index 1 -> selects n3)
      expect(attemptedPerRun[0]).toEqual(['n1', 'n3']);
      // Starting at index 1 (selects n2 -> fails -> candidates [n1, n3], index 2 % 2 = 0 -> selects n1)
      expect(attemptedPerRun[1]).toEqual(['n2', 'n1']);
      // Starting at index 2 (selects n3 -> fails -> candidates [n1, n2], index 0 % 2 = 0 -> selects n1)
      expect(attemptedPerRun[2]).toEqual(['n3', 'n1']);
    });
  });

  describe('3. Failover under Least-Loaded Load-Balancing Strategy', () => {
    let pool: ProviderPool;

    beforeEach(() => {
      pool = new ProviderPool('least_loaded');
      pool.registerProvider({ id: 'node-a', name: 'Node A', priority: 1 });
      pool.registerProvider({ id: 'node-b', name: 'Node B', priority: 2 });
      pool.registerProvider({ id: 'node-c', name: 'Node C', priority: 3 });
    });

    it('3.1 selects provider with minimum activeInFlightRequests during failover', async () => {
      const nodeA = pool.getProvider('node-a')!;
      const nodeB = pool.getProvider('node-b')!;
      const nodeC = pool.getProvider('node-c')!;

      // Load node-c with existing in-flight traffic
      nodeC.recordStart();
      nodeC.recordStart();
      nodeC.recordStart(); // node-c in-flight = 3

      // node-a and node-b have 0 in-flight. Priority tie-breaker selects node-a first.
      const attempted: string[] = [];

      const res = await pool.executeWithFailover(async (node) => {
        attempted.push(node.id);
        if (node.id === 'node-a') {
          const err: any = new Error('500 Error');
          err.status = 500;
          throw err;
        }
        return `ok-${node.id}`;
      });

      expect(attempted).toEqual(['node-a', 'node-b']);
      expect(res.providerUsed).toBe('node-b'); // Selected node-b over node-c because 0 in-flight < 3 in-flight
    });

    it('3.2 correctly updates activeInFlightRequests on failed attempt before failover selection', async () => {
      const nodeA = pool.getProvider('node-a')!;
      const nodeB = pool.getProvider('node-b')!;
      const nodeC = pool.getProvider('node-c')!;

      // Load nodeB and nodeC so nodeA has lowest in-flight count (0 vs 2 and 3)
      nodeB.recordStart();
      nodeB.recordStart(); // nodeB in-flight = 2

      nodeC.recordStart();
      nodeC.recordStart();
      nodeC.recordStart(); // nodeC in-flight = 3

      let inFlightDuringNodeAFailure = -1;

      await pool.executeWithFailover(async (node) => {
        if (node.id === 'node-a') {
          inFlightDuringNodeAFailure = node.metrics.activeInFlightRequests;
          const err: any = new Error('500 Error');
          err.status = 500;
          throw err;
        }
        return 'ok';
      });

      expect(inFlightDuringNodeAFailure).toBe(1); // recordStart incremented to 1
      expect(nodeA.metrics.activeInFlightRequests).toBe(0); // recordFailure decremented back to 0
    });

    it('3.3 high-concurrency failover stress test under least_loaded strategy', async () => {
      const concurrency = 30;

      const tasks = Array.from({ length: concurrency }).map(async (_, idx) => {
        return pool.executeWithFailover(async (node) => {
          if (node.id === 'node-a' && idx % 2 === 1) {
            const err: any = new Error('429 Rate limit');
            err.status = 429;
            throw err;
          }
          await new Promise((r) => setTimeout(r, 10));
          return `resp-${idx}`;
        });
      });

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(concurrency);

      // Verify all in-flight counters return to 0
      expect(pool.getProvider('node-a')!.metrics.activeInFlightRequests).toBe(0);
      expect(pool.getProvider('node-b')!.metrics.activeInFlightRequests).toBe(0);
      expect(pool.getProvider('node-c')!.metrics.activeInFlightRequests).toBe(0);
    });
  });

  describe('4. Exhaustion & Edge Cases during Load-Balanced Failover', () => {
    it('4.1 throws ProviderPoolExhaustedError with attempted provider IDs when all providers fail', async () => {
      const pool = new ProviderPool('least_loaded');
      pool.registerProvider({ id: 'x1', name: 'X1', priority: 1 });
      pool.registerProvider({ id: 'x2', name: 'X2', priority: 2 });

      let thrownErr: any = null;
      try {
        await pool.executeWithFailover(async (node) => {
          const err: any = new Error(`Error from ${node.id}`);
          err.status = 500;
          throw err;
        });
      } catch (err: any) {
        thrownErr = err;
      }

      expect(thrownErr).toBeInstanceOf(ProviderPoolExhaustedError);
      expect(thrownErr.attemptedProviders).toEqual(['x1', 'x2']);
      expect(thrownErr.message).toContain('x1, x2');
    });
  });
});
