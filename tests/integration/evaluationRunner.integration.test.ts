import { describe, expect, it } from 'vitest';
import { runOfflineEvaluation } from '../../src/evaluation/evaluationRunner.js';

describe('evaluation runner integration', () => {
  it('runs a deterministic fixture without provider credentials', async () => {
    const receipt = await runOfflineEvaluation({
      repository: 'review-yeti-ai/review-yeti-bot',
      sourceSha: 'a'.repeat(40),
      fixtureId: 'offline-promotion-matrix',
      fixtureDigest: '0'.repeat(64),
      fixturePath: 'tests/fixtures/review-intelligence/offline-promotion-matrix.json',
    });
    expect(receipt.status).toBe('PASS');
    expect(receipt.request.mode).toBe('offline');
    expect(receipt.summary.deterministic).toBe(true);
  });
});
