import { describe, expect, it } from 'vitest';

describe('memory provider evaluation corpus', () => {
  it('scores exact-head recall and correction safety from replayable cases', async () => {
    const evaluator = await import('../../scripts/evaluate-memory-providers.mjs');
    const result = evaluator.evaluateCorpus({
      providerId: 'fixture',
      cases: [
        { id: 'same-head', headSha: 'abc', expected: ['resolved'], recalled: [{ state: 'resolved', head_sha: 'abc' }] },
        { id: 'stale-head', headSha: 'abc', expected: [], recalled: [{ state: 'ignored', head_sha: 'old' }] },
      ],
    });
    expect(result).toMatchObject({ provider: 'fixture', cases: 2, exactHeadPass: 1, correctionSafetyPass: 1, score: 0.6667 });
  });
});
