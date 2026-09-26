import { describe, expect, it } from 'vitest';
import { repositoryFlagEnabledFor } from '../../src/review/repositoryFlag';
import { diffShrinkEnabledFor } from '../../src/review/diffShrink';
import { reviewBudgetEnabledFor } from '../../src/review/reviewBudget';
import { incrementalReviewEnabledFor } from '../../src/review/incrementalReview';
import { skipEmptyModerationEnabledFor } from '../../src/review/emptyModeration';

/** One grammar for every per-repository review flag: each flag delegates to the same helper. */
const flags: Array<[string, (env: Record<string, string | undefined>, repo: string) => boolean]> = [
  ['REVIEW_YETI_DIFF_SHRINK', diffShrinkEnabledFor],
  ['REVIEW_YETI_BUDGET', reviewBudgetEnabledFor],
  ['REVIEW_YETI_INCREMENTAL', incrementalReviewEnabledFor],
  ['REVIEW_YETI_SKIP_EMPTY_MODERATION', skipEmptyModerationEnabledFor],
];
const values = [undefined, '', 'off', '0', 'FALSE', 'on', 'all', '1', 'acme/app', 'Acme/App,other/x', 'other/x acme/app', 'acme/app-2'];

describe('repositoryFlagEnabledFor', () => {
  it.each(flags)('%s agrees with the shared grammar on every value', (flag, enabledFor) => {
    for (const value of values) {
      const env = { [flag]: value };
      expect(enabledFor(env, 'acme/app')).toBe(repositoryFlagEnabledFor(env, flag, 'acme/app'));
    }
  });
  it('parses off, on and allowlists', () => {
    const on = (value: string | undefined, repo = 'acme/app') => repositoryFlagEnabledFor({ F: value }, 'F', repo);
    expect([undefined, '', ' off ', '0', 'false'].map((v) => on(v))).toEqual([false, false, false, false, false]);
    expect(['1', 'true', 'ON', 'all'].map((v) => on(v))).toEqual([true, true, true, true]);
    expect(on('Acme/App,other/x')).toBe(true);
    expect(on('acme/app-2')).toBe(false);
    expect(on('acme/app', '')).toBe(false);
  });
});
