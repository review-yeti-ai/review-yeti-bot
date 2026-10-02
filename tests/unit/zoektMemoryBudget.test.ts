import { describe, expect, it } from 'vitest';

const budget = require('../../src/mcp/zoektMemoryBudget.js');
const MiB = 1024 * 1024;

function fsWith(files: Record<string, string>) {
  return {
    readFileSync: (file: string) => {
      if (!(file in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files[file];
    },
  };
}

describe('zoektMemoryBudget (REL-1282)', () => {
  it('reads a cgroup v2 limit', () => {
    expect(budget.readCgroupMemoryLimitBytes(fsWith({ '/sys/fs/cgroup/memory.max': `${512 * MiB}\n` }))).toBe(512 * MiB);
  });

  it('falls back to cgroup v1', () => {
    expect(budget.readCgroupMemoryLimitBytes(fsWith({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': `${256 * MiB}` }))).toBe(256 * MiB);
  });

  it.each([
    ['v2 "max"', { '/sys/fs/cgroup/memory.max': 'max\n' }],
    ['v1 unlimited sentinel', { '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }],
    ['no cgroup files', {}],
    ['garbage', { '/sys/fs/cgroup/memory.max': 'lots' }],
  ])('treats %s as an unknown limit, never as a large one', (_label, files) => {
    expect(budget.readCgroupMemoryLimitBytes(fsWith(files))).toBeUndefined();
  });

  it('reads the cgroup high-water mark when exposed', () => {
    expect(budget.readCgroupMemoryPeakBytes(fsWith({ '/sys/fs/cgroup/memory.peak': '12345' }))).toBe(12345);
    expect(budget.readCgroupMemoryPeakBytes(fsWith({}))).toBeUndefined();
  });

  it('refuses a container below the floor with an explicit reason', () => {
    expect(budget.groundingMemoryDecision({ limitBytes: 256 * MiB })).toMatchObject({
      allowed: false, verified: true, reason: 'memory_limit_below_floor', limitBytes: 256 * MiB,
    });
  });

  it('allows a container at or above the floor', () => {
    expect(budget.groundingMemoryDecision({ limitBytes: budget.GROUNDING_MEMORY_FLOOR_BYTES })).toMatchObject({ allowed: true, verified: true });
    expect(budget.groundingMemoryDecision({ limitBytes: 1024 * MiB })).toMatchObject({ allowed: true, verified: true });
  });

  it('allows an unknown limit but marks the decision unverified', () => {
    expect(budget.groundingMemoryDecision({})).toMatchObject({ allowed: true, verified: false });
  });

  it('pins the sizing constants the measurements support', () => {
    expect(budget.GROUNDING_INDEXER_HEAP_LIMIT_BYTES).toBe(192 * MiB);
    expect(budget.GROUNDING_MEMORY_FLOOR_BYTES).toBe(512 * MiB);
  });
});
