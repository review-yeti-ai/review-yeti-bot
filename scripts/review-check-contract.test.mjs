import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateExactCheckRuns,
  QUALIFYING_MERGE_QUEUE_STATES,
} from './review-check-contract.mjs';

const head = 'a'.repeat(40);
const checks = [
  { id: 10, name: 'Review Yeti / Review Yeti', app: { id: 15368 }, head_sha: head, status: 'completed', conclusion: 'success' },
  { id: 11, name: 'Review Yeti', app: { slug: 'ct-review-bot' }, head_sha: head, status: 'completed', conclusion: 'success' },
];

test('shares only the qualifying merge-queue state policy', () => {
  assert.deepEqual(QUALIFYING_MERGE_QUEUE_STATES, ['QUEUED', 'AWAITING_CHECKS', 'SPECULATIVE', 'BUILT']);
  assert.throws(() => QUALIFYING_MERGE_QUEUE_STATES.push('LOCKED'), TypeError);
});

test('selects latest exact-head evidence within each required App identity', () => {
  const result = evaluateExactCheckRuns([...checks,
    { ...checks[0], id: 20, app: { id: 123 }, conclusion: 'failure' },
    { ...checks[1], id: 21, app: { slug: 'unrelated-operator-app' }, conclusion: 'failure' },
  ], head);
  assert.deepEqual(result.failures, []);
  assert.equal(result.context.id, 10);
  assert.equal(result.verdict.id, 11);
});

test('rejects required check evidence without an immutable check-run ID', () => {
  for (const id of [0, -1, 1.5, '1.5', '1e3', ' 10', 'not-a-check-id', '9007199254740992']) {
    const result = evaluateExactCheckRuns([
      { ...checks[0], id },
      checks[1],
    ], head);
    assert.match(result.failures.join(' '), /no valid immutable id/u, `id=${String(id)}`);
  }
});

for (const index of [0, 1]) {
  test(`a foreign green cannot replace a failed official check ${index}`, () => {
    const result = evaluateExactCheckRuns([
      ...checks,
      { ...checks[index], id: 22, conclusion: 'failure' },
      { ...checks[index], id: 23, app: { id: 123, slug: 'unrelated-operator-app' } },
    ], head);
    assert.match(result.failures.join(' '), /latest exact-head run is not successful/u);
  });

  test(`a foreign green alone cannot supply required check ${index}`, () => {
    const result = evaluateExactCheckRuns(checks.map((run, offset) => offset === index
      ? { ...run, app: { id: 123, slug: 'unrelated-operator-app' } } : run), head);
    assert.match(result.failures.join(' '), /required publisher/u);
  });
}
