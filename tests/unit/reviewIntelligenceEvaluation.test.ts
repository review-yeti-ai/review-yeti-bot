import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(__dirname, '../..');
const fixturePath = path.join(root, 'tests/fixtures/review-intelligence/offline-promotion-matrix.json');

describe('offline review-intelligence promotion gates', () => {
  it('covers repeated PR/feedback, recap, stale, provider, compaction, telemetry, MCP, lease, replay, and receipt cases deterministically', async () => {
    const { evaluateOfflinePromotionMatrix } = await import('../../scripts/evaluate-review-intelligence.mjs');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const result = await evaluateOfflinePromotionMatrix(fixture);

    expect(result).toMatchObject({ status: 'pass', deterministic: true, liveEvidence: false, score: 1 });
    expect(result.scenarios).toEqual(expect.arrayContaining([
      'repeated-pr-feedback-transitions', 'session-recap-exact-head', 'stale-head-rejected',
      'provider-failure-fail-open', 'compaction-bounded', 'otel-receipt-redacted',
      'mcp-poisoning-rejected', 'lease-loss-fenced', 'replay-dead-letter-authorized', 'secret-free-receipts',
    ]));
  });

  it('fails closed when a matrix overclaims live evidence or permits a poisoned receipt', async () => {
    const { evaluateOfflinePromotionMatrix } = await import('../../scripts/evaluate-review-intelligence.mjs');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    expect((await evaluateOfflinePromotionMatrix({ ...fixture, liveEvidence: true })).status).toBe('fail');
    fixture.scenarios.find((scenario: any) => scenario.id === 'secret-free-receipts').expected.receipt = { token: 'not-redacted' };
    await expect(evaluateOfflinePromotionMatrix(fixture)).resolves.toMatchObject({ status: 'fail', failures: expect.arrayContaining(['secret-free-receipts']) });
  });

  it('executes fixture-backed scenario checks instead of trusting matrix assertions', async () => {
    const { evaluateOfflinePromotionMatrix, loadOfflineEvaluationInputs } = await import('../../scripts/evaluate-review-intelligence.mjs');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const inputs = loadOfflineEvaluationInputs(fixture);

    await expect(evaluateOfflinePromotionMatrix(fixture, inputs)).resolves.toMatchObject({ status: 'pass', score: 1 });

    const changedExpected = structuredClone(inputs.workflowFixture);
    changedExpected.github.responses.ledger = 'unexpected-ledger';
    await expect(evaluateOfflinePromotionMatrix(fixture, { ...inputs, workflowFixture: changedExpected })).resolves.toMatchObject({
      status: 'fail',
      failures: expect.arrayContaining(['repeated-pr-feedback-transitions']),
    });

    const changedAssertion = structuredClone(fixture);
    changedAssertion.scenarios[0].expected.status = 'fail';
    await expect(evaluateOfflinePromotionMatrix(changedAssertion, inputs)).resolves.toMatchObject({
      status: 'fail',
      failures: expect.arrayContaining(['repeated-pr-feedback-transitions']),
    });
  });

  it('requires an exact, secret-free intelligence cassette with every scenario ID', async () => {
    const { evaluateOfflinePromotionMatrix, loadOfflineEvaluationInputs } = await import('../../scripts/evaluate-review-intelligence.mjs');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const inputs = loadOfflineEvaluationInputs(fixture);

    await expect(evaluateOfflinePromotionMatrix(fixture, inputs)).resolves.toMatchObject({ status: 'pass' });
    await expect(evaluateOfflinePromotionMatrix(fixture, { ...inputs, cassette: null })).resolves.toMatchObject({
      status: 'fail', failures: expect.arrayContaining(['vcr_fixture']),
    });
    const changedCassette = structuredClone(inputs.cassette);
    changedCassette.interactions[0].request.headers.authorization = 'Bearer fixture-secret';
    await expect(evaluateOfflinePromotionMatrix(fixture, { ...inputs, cassette: changedCassette })).resolves.toMatchObject({
      status: 'fail', failures: expect.arrayContaining(['vcr_fixture']),
    });
    const missingInteraction = structuredClone(inputs.cassette);
    missingInteraction.interactions.pop();
    await expect(evaluateOfflinePromotionMatrix(fixture, { ...inputs, cassette: missingInteraction })).resolves.toMatchObject({
      status: 'fail', failures: expect.arrayContaining(['vcr_fixture']),
    });
  });

  it('derives every scenario result from executable deterministic runners, not fixture result fields', async () => {
    const { createReviewIntelligenceScenarioRunner } = await import('../../scripts/review-intelligence-scenarios.mjs');
    const matrix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const workflowFixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/review-workflows/intelligence-evaluation.json'), 'utf8'));
    const { cassette } = (await import('../../scripts/evaluate-review-intelligence.mjs')).loadOfflineEvaluationInputs(matrix);
    const runner = createReviewIntelligenceScenarioRunner({ workflowFixture, cassette, root });

    for (const scenario of matrix.scenarios) {
      await expect(runner.run(scenario.id)).resolves.toMatchObject({
        status: scenario.expected.status,
        identity: workflowFixture.event,
        receipt: scenario.expected.receipt,
      });
    }
    expect(() => runner.assertComplete()).not.toThrow();
  });

  it('runs the promotion gate and plain-node Action load without optional live smoke', () => {
    const output = execFileSync(process.execPath, ['scripts/run-review-intelligence-promotion.mjs', '--fixture', fixturePath], { cwd: root, encoding: 'utf8' });
    const receipt = JSON.parse(output);
    expect(receipt).toMatchObject({ status: 'pass', offline: { status: 'pass' }, actionRuntime: { loadedTypescript: false }, liveSmoke: { status: 'not_run' } });
  });
});
