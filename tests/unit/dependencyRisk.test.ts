import { describe, expect, it } from 'vitest';
import { buildDependencyRiskHints, classifyDependencySurface } from '../../src/review/dependencyRisk';

describe('dependency risk hints', () => {
  it('selects dependency evidence only for concrete changed dependency surfaces', () => {
    const unitIdsByPath = { 'package.json': 'ru-deps', 'src/client.ts': 'ru-client' };
    expect(buildDependencyRiskHints({ files: [
      { path: 'package.json', patch: '@@\n+"example":"2.0.0"' },
      { path: 'src/client.ts', patch: '@@\n+import { removedApi } from "example"' },
      { path: 'README.md', patch: '@@\n+dependency documentation' },
    ], unitIdsByPath })).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'manifest-change', path: 'package.json', unitId: 'ru-deps' }),
      expect.objectContaining({ kind: 'import-contract-change', path: 'src/client.ts', unitId: 'ru-client' }),
    ]));
  });

  it('returns no hint for unrelated source changes merely because the repository has a lockfile', () => {
    expect(buildDependencyRiskHints({ files: [{ path: 'src/math.ts', patch: '@@\n+return a + b' }] })).toEqual([]);
  });

  it('classifies lockfiles without reading or interpreting their contents', () => {
    expect(classifyDependencySurface({ path: 'nested/mix.lock', patch: '+opaque' })).toBe('lockfile-change');
  });
});
