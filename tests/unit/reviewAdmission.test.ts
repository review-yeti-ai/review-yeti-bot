import { describe, expect, it } from 'vitest';
import { buildReviewRunIdentity } from '../../src/review/reviewAdmission';

describe('review admission identity', () => {
  it('binds the durable run to repository, PR, exact head/base, and the event snapshot', () => {
    const input = {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 42,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      changedFiles: [{ path: 'src/review.ts', patch: '@@ -1 +1 @@\n+new' }],
    };
    const first = buildReviewRunIdentity(input);
    const second = buildReviewRunIdentity({ ...input, changedFiles: [...input.changedFiles] });

    expect(first).toEqual(second);
    expect(first.headSha).toBe(input.headSha);
    expect(first.baseSha).toBe(input.baseSha);
    expect(first.snapshotDigest).toHaveLength(64);
    expect(first.configDigest).toHaveLength(64);
    expect(buildReviewRunIdentity({ ...input, headSha: 'c'.repeat(40) }).snapshotDigest).not.toBe(first.snapshotDigest);
  });
});
