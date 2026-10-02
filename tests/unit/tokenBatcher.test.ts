import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenBatcher } from '../../src/gateway/tokenBatcher';

describe('TokenBatcher Unit Tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushes immediately when accumulated characters reach or exceed minBatchChars', () => {
    const emitted: string[] = [];
    const batcher = new TokenBatcher((chunk) => emitted.push(chunk), {
      minBatchChars: 20,
      batchIntervalMs: 50,
    });

    batcher.push('Hello ');
    expect(emitted).toEqual([]);
    expect(batcher.pendingLength).toBe(6);

    batcher.push('world, this exceeds 20 characters!');
    expect(emitted).toEqual(['Hello world, this exceeds 20 characters!']);
    expect(batcher.pendingLength).toBe(0);
  });

  it('flushes on timer interval when character threshold is not met', () => {
    const emitted: string[] = [];
    const batcher = new TokenBatcher((chunk) => emitted.push(chunk), {
      minBatchChars: 100,
      batchIntervalMs: 50,
    });

    batcher.push('short chunk');
    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(49);
    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(2);
    expect(emitted).toEqual(['short chunk']);
    expect(batcher.pendingLength).toBe(0);
  });

  it('flushes synchronously on explicit flush call with no token stranding', () => {
    const emitted: string[] = [];
    const batcher = new TokenBatcher((chunk) => emitted.push(chunk), {
      minBatchChars: 80,
      batchIntervalMs: 100,
    });

    batcher.push('final reasoning step before EOF');
    expect(emitted).toEqual([]);

    batcher.flush();
    expect(emitted).toEqual(['final reasoning step before EOF']);
    expect(batcher.pendingLength).toBe(0);

    // Calling flush again when buffer is empty is a no-op
    batcher.flush();
    expect(emitted).toHaveLength(1);
  });

  it('cancels pending timer and drops buffered tokens when cancel is called', () => {
    const emitted: string[] = [];
    const batcher = new TokenBatcher((chunk) => emitted.push(chunk), {
      minBatchChars: 80,
      batchIntervalMs: 50,
    });

    batcher.push('aborted reasoning trace');
    batcher.cancel();

    vi.advanceTimersByTime(100);
    expect(emitted).toEqual([]);
    expect(batcher.pendingLength).toBe(0);
  });

  it('ignores empty or falsy pushes cleanly', () => {
    const emitted: string[] = [];
    const batcher = new TokenBatcher((chunk) => emitted.push(chunk));

    batcher.push('');
    expect(batcher.pendingLength).toBe(0);
    expect(emitted).toEqual([]);
  });

  it('uses default values (80 chars, 50ms) when options are omitted', () => {
    const emitted: string[] = [];
    const batcher = new TokenBatcher((chunk) => emitted.push(chunk));

    batcher.push('a'.repeat(79));
    expect(emitted).toEqual([]);

    batcher.push('b');
    expect(emitted).toEqual(['a'.repeat(79) + 'b']);
  });
});
