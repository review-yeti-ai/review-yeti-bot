import os from 'node:os';

/**
 * Wall-clock budget for a test assertion, adjusted for parallel execution (REL-560).
 *
 * These budgets exist to catch a pathological regression -- an O(n^2) filter, a "parallel" panel
 * that silently serialised -- not to certify latency. Once test *files* run in parallel, the
 * elapsed time measured inside one worker also contains whatever the other workers are doing on
 * the same runner. A budget tuned against an idle single-file run then reports its neighbours'
 * load as a product regression: `expect(50.50752199999988).toBeLessThan(50)` is what reddened
 * main after fileParallelism was enabled, missing by half a millisecond.
 *
 * Scale by the number of workers that can actually contend, capped at 4 -- past roughly four
 * the OS scheduler rather than the worker count dominates, and a larger multiplier would stop
 * the assertion detecting anything. Floored at 1, so a serial run keeps the original number.
 *
 * Use this for any assertion over a measured elapsed duration. Do NOT use it for lower bounds
 * (`toBeGreaterThan`) -- contention only makes those more true -- or for deterministic counts
 * like token estimates.
 */
function contentionFactor(): number {
  const detected = Number(process.env.VITEST_MAX_WORKERS)
    || (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
  return Math.min(Math.max(1, detected || 1), 4);
}

export function timeBudgetMs(idleBudgetMs: number): number {
  return idleBudgetMs * contentionFactor();
}

/**
 * The mirror of `timeBudgetMs` for a throughput *floor* -- an assertion of the form
 * `expect(itemsPerSecond).toBeGreaterThan(n)`. Contention reduces throughput for exactly the same
 * reason it inflates elapsed time, so the floor has to come down by the same factor rather than up.
 */
export function throughputFloorPerSec(idleRate: number): number {
  return idleRate / contentionFactor();
}
