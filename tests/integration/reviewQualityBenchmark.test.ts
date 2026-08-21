import { describe, expect, it } from 'vitest';
import { measureQuality } from '../../src/review/qualityMetrics';

describe('review quality benchmark metrics', () => {
  it('reports precision, recall, duplicates, and stale context without claiming perfection', () => {
    const metrics = measureQuality({
      snapshotSha: 'a'.repeat(40),
      expectedFindingKeys: ['src/a.ts:2:bug', 'src/b.ts:4:leak'],
      findings: [
        { severity: 'P1', path: 'src/a.ts', line: 2, title: 'bug', commitSha: 'a'.repeat(40) },
        { severity: 'P1', path: 'src/a.ts', line: 2, title: 'bug', commitSha: 'a'.repeat(40) },
        { severity: 'P2', path: 'src/c.ts', line: 1, title: 'noise', commitSha: 'b'.repeat(40) },
      ],
      providerFailures: 1,
    });
    expect(metrics.precision).toBe(0.5);
    expect(metrics.recall).toBe(0.5);
    expect(metrics.duplicateRate).toBeCloseTo(1 / 3);
    expect(metrics.staleContextRate).toBeCloseTo(1 / 3);
    expect(metrics.providerFailures).toBe(1);
  });

  it('does not classify a finding without a commit as stale context', () => {
    const metrics = measureQuality({
      snapshotSha: 'a'.repeat(40),
      expectedFindingKeys: [],
      findings: [{ severity: 'P2', path: 'src/a.ts', line: 2, title: 'unbound finding' }],
    });
    expect(metrics.staleContextRate).toBe(0);
  });
});
