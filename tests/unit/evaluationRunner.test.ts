import { describe, expect, it } from 'vitest';
import { compareEvaluationReceipts, runEvaluation } from '../../src/evaluation/evaluationRunner.js';
import { createEvaluationReceipt } from '../../src/evaluation/evaluationContracts.js';

const fixturePath = 'tests/fixtures/review-intelligence/offline-promotion-matrix.json';
const common = {
  repository: 'review-yeti-ai/review-yeti-bot',
  sourceSha: 'a'.repeat(40),
  fixtureId: 'offline-promotion-matrix',
  fixtureDigest: '0'.repeat(64),
  fixturePath,
};

describe('evaluation runner', () => {
  it('runs the checked-in offline evaluator and returns a receipt', async () => {
    const receipt = await runEvaluation(common);
    expect(receipt.request.mode).toBe('offline');
    expect(receipt.identity.fixtureDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.status).toBe('PASS');
    expect(receipt.scenarioResults.length).toBeGreaterThan(0);
  });

  it('does not call a live provider implicitly', async () => {
    let calls = 0;
    const receipt = await runEvaluation({ ...common, mode: 'live' }, {
      liveEvaluator: async () => { calls += 1; return { status: 'not_run', reason: 'provider_unavailable' }; },
    });
    expect(calls).toBe(1);
    expect(receipt.status).toBe('INCONCLUSIVE');
    expect(receipt.error).toBe('provider_unavailable');
  });

  it('blocks unsafe ships and reports metric regressions', () => {
    const baseline = createEvaluationReceipt({ request: { ...common, mode: 'offline' }, status: 'PASS', summary: { expectedDecisionAccuracy: 0.9, unsafeShipRate: 0, costUSD: 1, latencyMsP95: 100 } });
    const candidate = createEvaluationReceipt({ request: { ...common, mode: 'offline' }, status: 'PASS', summary: { expectedDecisionAccuracy: 0.8, unsafeShipRate: 0.1, costUSD: 2, latencyMsP95: 200 } });
    const comparison = compareEvaluationReceipts(baseline, candidate);
    expect(comparison.status).toBe('BLOCKED');
    expect(comparison.failures).toEqual(expect.arrayContaining(['unsafe_ship', 'accuracy_regression', 'cost_regression', 'latency_regression']));
  });
});
