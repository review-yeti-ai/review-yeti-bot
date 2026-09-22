import { describe, expect, it, vi } from 'vitest';
import { parseComparisonFiles } from '../../src/github/comparisonFiles';

vi.mock('../../src/review/reviewEvidenceLimits', () => ({ MAX_PATH_CHARACTERS: 32 }));

const file = (filename: string) => ({
  sha: 'a'.repeat(40), filename, status: 'modified', additions: 1, deletions: 1, changes: 2,
  patch: '@@ -1 +1 @@\n-old\n+new',
});

describe('immutable comparison file evidence limits', () => {
  it('uses the shared path limit at the exact boundary and rejects the next character', () => {
    expect(parseComparisonFiles([file('a'.repeat(32))])).toHaveLength(1);
    expect(() => parseComparisonFiles([file('a'.repeat(33))]))
      .toThrow('Review reader file evidence unavailable');
  });
});
