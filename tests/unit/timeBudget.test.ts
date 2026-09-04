import { describe, expect, it, afterEach } from 'vitest';
import os from 'node:os';
import { timeBudgetMs } from '../support/timeBudget';

describe('timeBudgetMs (REL-560)', () => {
  const original = process.env.VITEST_MAX_WORKERS;
  afterEach(() => {
    if (original === undefined) delete process.env.VITEST_MAX_WORKERS;
    else process.env.VITEST_MAX_WORKERS = original;
  });

  it('keeps the original budget when nothing can contend', () => {
    process.env.VITEST_MAX_WORKERS = '1';
    expect(timeBudgetMs(50)).toBe(50);
  });

  it('scales with the number of contending workers', () => {
    process.env.VITEST_MAX_WORKERS = '4';
    expect(timeBudgetMs(50)).toBe(200);
    // The 50.5ms measurement that reddened main must now pass, and a genuinely pathological
    // number must still fail.
    expect(50.50752199999988).toBeLessThan(timeBudgetMs(50));
    expect(5_000).toBeGreaterThan(timeBudgetMs(50));
  });

  it('caps the multiplier so the assertion keeps detecting something', () => {
    process.env.VITEST_MAX_WORKERS = '64';
    expect(timeBudgetMs(50)).toBe(200);
  });

  it('never returns less than the idle budget on this machine', () => {
    delete process.env.VITEST_MAX_WORKERS;
    expect(timeBudgetMs(100)).toBeGreaterThanOrEqual(100);
    expect(timeBudgetMs(100)).toBeLessThanOrEqual(400);
    expect(os.cpus().length).toBeGreaterThan(0);
  });
});
