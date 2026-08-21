import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProviderCapacityLimiter,
  resolveProviderCapacity,
  ProviderQueueStallError,
  DEFAULT_PROVIDER_CAPACITIES,
} from '../../src/gateway/providerCapacityManager';

describe('ProviderCapacityManager', () => {
  let limiter: ProviderCapacityLimiter;

  beforeEach(() => {
    limiter = ProviderCapacityLimiter.getInstance();
    limiter.reset();
  });

  it('resolves correct default capacities per provider', () => {
    const fireworksCap = resolveProviderCapacity('fireworks');
    expect(fireworksCap.maxConcurrentLanes).toBe(2);
    expect(fireworksCap.ttftTimeoutMs).toBe(15_000);

    const ollamaCap = resolveProviderCapacity('ollama');
    expect(ollamaCap.maxConcurrentLanes).toBe(2);
    expect(ollamaCap.ttftTimeoutMs).toBe(20_000);

    const openrouterCap = resolveProviderCapacity('openrouter');
    expect(openrouterCap.maxConcurrentLanes).toBe(10);
    expect(openrouterCap.ttftTimeoutMs).toBe(30_000);

    const geminiCap = resolveProviderCapacity('google/gemini-3.7-flash');
    expect(geminiCap.maxConcurrentLanes).toBe(20);
    expect(geminiCap.ttftTimeoutMs).toBe(15_000);
  });

  it('tracks in-flight concurrency and enforces capacity limits', () => {
    // Fireworks capacity is 2
    expect(limiter.canAccept('fireworks')).toBe(true);
    expect(limiter.tryAcquire('fireworks')).toBe(true);
    expect(limiter.getActiveCount('fireworks')).toBe(1);

    expect(limiter.canAccept('fireworks')).toBe(true);
    expect(limiter.tryAcquire('fireworks')).toBe(true);
    expect(limiter.getActiveCount('fireworks')).toBe(2);

    // 3rd attempt must be rejected/saturated
    expect(limiter.canAccept('fireworks')).toBe(false);
    expect(limiter.tryAcquire('fireworks')).toBe(false);
    expect(limiter.getActiveCount('fireworks')).toBe(2);

    // Releasing a slot allows new acquisitions
    limiter.release('fireworks');
    expect(limiter.getActiveCount('fireworks')).toBe(1);
    expect(limiter.canAccept('fireworks')).toBe(true);
    expect(limiter.tryAcquire('fireworks')).toBe(true);
  });

  it('supports custom capacity overrides', () => {
    limiter.setCapacity('custom-gpu-cluster', { maxConcurrentLanes: 1, ttftTimeoutMs: 5_000 });
    const cap = limiter.getCapacity('custom-gpu-cluster');
    expect(cap.maxConcurrentLanes).toBe(1);
    expect(cap.ttftTimeoutMs).toBe(5_000);

    expect(limiter.tryAcquire('custom-gpu-cluster')).toBe(true);
    expect(limiter.tryAcquire('custom-gpu-cluster')).toBe(false);
  });

  it('creates ProviderQueueStallError with proper metadata', () => {
    const err = new ProviderQueueStallError('fireworks', 15_000);
    expect(err.name).toBe('ProviderQueueStallError');
    expect(err.providerId).toBe('fireworks');
    expect(err.elapsedMs).toBe(15_000);
    expect(err.isRetryableFailover).toBe(true);
    expect(err.message).toContain('15000ms');
  });
});
