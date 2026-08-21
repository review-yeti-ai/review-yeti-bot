import { describe, expect, it } from 'vitest';
import { resolveEffectivePolicy } from '../../src/policy/effectivePolicy';

describe('effective review policy', () => {
  it('applies precedence while preserving immutable platform safety flags', () => {
    const result = resolveEffectivePolicy([
      { name: 'platform', values: { maxTokens: 10_000, allowRecursiveSubmodules: false } },
      { name: 'organization', values: { maxTokens: 20_000, allowRecursiveSubmodules: true } },
      { name: 'repository', values: { maxTokens: 8_000, maxFiles: 100 } },
      { name: 'workflow', values: { maxTokens: 9_000 } },
    ]);
    expect(result.policy.maxTokens).toBe(8_000);
    expect(result.policy.allowRecursiveSubmodules).toBe(true);
    expect(result.sources.maxTokens).toEqual(['platform', 'organization', 'repository', 'workflow']);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
  });
});
