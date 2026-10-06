import { afterEach, describe, expect, it, vi } from 'vitest';
import { RetryingStorageInitializer } from '../../src/persistence/retryingStorageInitializer';

describe('RetryingStorageInitializer', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('shares an active initialization and waits for it during stop', async () => {
    vi.useFakeTimers();
    const attempt = Promise.withResolvers<void>();
    const initialize = vi.fn(() => attempt.promise);
    const onInitialized = vi.fn();
    const bootstrap = new RetryingStorageInitializer(initialize, { onInitialized });

    const first = bootstrap.initializeOnce();
    const second = bootstrap.initializeOnce();
    await Promise.resolve();
    expect(initialize).toHaveBeenCalledOnce();
    expect(bootstrap.initialized).toBe(false);

    let stopSettled = false;
    const stopping = bootstrap.stop().then(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    attempt.resolve();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await stopping;
    expect(stopSettled).toBe(true);
    expect(onInitialized).not.toHaveBeenCalled();
    expect(bootstrap.initialized).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates lifecycle callback failures from the tracked retry loop', async () => {
    vi.useFakeTimers();
    const initialize = vi.fn().mockRejectedValueOnce(new Error('synthetic storage outage'))
      .mockResolvedValueOnce(undefined);
    const onFailure = vi.fn(() => { throw new Error('synthetic logger failure'); });
    const onInitialized = vi.fn(() => { throw new Error('synthetic activation hook failure'); });
    const bootstrap = new RetryingStorageInitializer(initialize, {
      retryInitialMs: 100, onFailure, onInitialized,
    });

    await expect(bootstrap.initializeOnce()).resolves.toBe(false);
    expect(onFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(bootstrap.initialized).toBe(true);
    expect(onInitialized).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await bootstrap.stop();
  });

  it('retries one failure at a time with capped exponential backoff', async () => {
    vi.useFakeTimers();
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error('synthetic outage one'))
      .mockRejectedValueOnce(new Error('synthetic outage two'))
      .mockRejectedValueOnce(new Error('synthetic outage three'))
      .mockResolvedValue(undefined);
    const bootstrap = new RetryingStorageInitializer(initialize, { retryInitialMs: 100, retryMaxMs: 200 });

    await expect(bootstrap.initializeOnce()).resolves.toBe(false);
    expect(initialize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(99);
    expect(initialize).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(initialize).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(initialize).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(initialize).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200);
    expect(initialize).toHaveBeenCalledTimes(4);
    expect(bootstrap.initialized).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await bootstrap.stop();
  });

  it('cancels a scheduled retry without starting another storage attempt', async () => {
    vi.useFakeTimers();
    const initialize = vi.fn().mockRejectedValue(new Error('synthetic outage'));
    const bootstrap = new RetryingStorageInitializer(initialize, { retryInitialMs: 100 });

    await expect(bootstrap.initializeOnce()).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await bootstrap.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(initialize).toHaveBeenCalledOnce();
  });
});
