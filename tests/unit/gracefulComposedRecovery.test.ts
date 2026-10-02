import { describe, expect, it } from 'vitest';
import {
  formatIncompleteRosterGateSummary,
  parseGracefulComposedSummary,
} from '../../src/review/incompleteRosterSummary';
import {
  evaluateReviewGenerationRecoveryLedger,
  validateReviewGenerationRecoveryEvidence,
} from '../../src/review/reviewGenerationRecovery';

const headSha = 'a'.repeat(40);
const otherHeadSha = 'c'.repeat(40);
const runId = `run_${'b'.repeat(32)}`;
const appId = 4_385_771;
const workerStartedAt = '2026-10-01T11:40:00Z';
const workerCompletedAt = '2026-10-01T12:00:00Z';
const gateCompletedAt = '2026-10-01T12:00:02Z';

function gracefulSummary(overrides: {
  head?: string;
  published?: number;
  remaining?: number;
  canonical?: number;
  blocking?: number;
  raw?: number;
  planned?: number;
  expected?: number;
  completed?: number;
} = {}): string {
  const head = overrides.head ?? headSha;
  const published = overrides.published ?? 1;
  const remaining = overrides.remaining ?? 2;
  const canonical = overrides.canonical ?? 1;
  const blocking = overrides.blocking ?? 0;
  const raw = overrides.raw ?? 2;
  const planned = overrides.planned ?? 4;
  const expected = overrides.expected ?? 4;
  const completed = overrides.completed ?? 2;
  return `Evidence collection reached its 20-minute cutoff at \`${head}\`. `
    + `The final closeout preserved and published ${published} validated finding(s); `
    + `${remaining} risk-ordered task(s) remain. This is fail-closed, not an approval. `
    + 'An exact-head rerun resumes the durable completed-task checkpoint.\n\n'
    + `Findings: ${canonical} (blocking P0/P1: ${blocking}; ${raw} raw persona finding(s) before clustering).\n\n`
    + `Coverage: engine=composed; planned tasks=${planned}; expected tasks=${expected}; `
    + `completed tasks=${completed}; failed tasks=0; roster valid=false; quorum satisfied=false; task coverage complete=false.`;
}

function workerCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 31_001,
    name: 'Review Yeti',
    head_sha: headSha,
    external_id: `${runId}:a1`,
    status: 'completed',
    conclusion: 'failure',
    started_at: workerStartedAt,
    completed_at: workerCompletedAt,
    app: { id: appId, slug: 'ct-review-bot' },
    output: {
      title: 'Review Yeti: INCOMPLETE (partial evidence published)',
      summary: gracefulSummary(),
      text: null,
    },
    ...overrides,
  };
}

function gateCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 31_002,
    name: 'Review Yeti Gate',
    head_sha: headSha,
    external_id: `review-yeti-gate:v1:${'d'.repeat(64)}`,
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-10-01T11:59:58Z',
    completed_at: gateCompletedAt,
    app: { id: appId, slug: 'ct-review-bot' },
    output: {
      title: 'Review Yeti Gate: Failed (incomplete panel)',
      summary: formatIncompleteRosterGateSummary(4, 2),
      text: null,
    },
    ...overrides,
  };
}

function gracefulRequest(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'exampleorg',
    repo: 'review-yeti-bot',
    headSha,
    runId,
    expectedGeneration: 2,
    expectedAppId: appId,
    gracefulComposedContinuation: true as const,
    ...overrides,
  };
}

describe('strict graceful composed recovery evidence', () => {
  it('accepts the exact a1 App/Gate evidence for a graceful a2 continuation', () => {
    const request = gracefulRequest();
    const evidence = evaluateReviewGenerationRecoveryLedger(request, [workerCheck()], [gateCheck()]);

    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      generation: 1,
      checkId: 31_001,
      externalId: `${runId}:a1`,
      conclusion: 'failure',
      title: 'Review Yeti: INCOMPLETE (partial evidence published)',
      legacyIncompleteRoster: {
        gracefulComposedPartial: true,
        workerSummary: gracefulSummary(),
        workerStartedAt,
        workerCompletedAt,
      },
    });
    expect(validateReviewGenerationRecoveryEvidence(request, evidence)).toEqual(evidence);
    expect(parseGracefulComposedSummary(gracefulSummary(), headSha)).toMatchObject({
      canonicalFindingCount: 1,
      rawFindingCount: 2,
      expectedLanes: 4,
      completedLanes: 2,
    });
  });

  it.each([
    ['a summary for a different head', gracefulSummary({ head: otherHeadSha })],
    ['a published count that disagrees with Findings', gracefulSummary({ published: 2 })],
    ['a remaining-task count that disagrees with coverage', gracefulSummary({ remaining: 1 })],
    ['a summary with a blocking P1', gracefulSummary({ blocking: 1 })],
    ['a raw count below the canonical count', gracefulSummary({ raw: 0 })],
    ['a composed plan whose planned and expected counts differ', gracefulSummary({ planned: 5 })],
  ])('rejects %s before treating the worker as a continuation proof', (_label, summary) => {
    expect(parseGracefulComposedSummary(summary, headSha)).toBeNull();
    expect(() => evaluateReviewGenerationRecoveryLedger(
      gracefulRequest(), [workerCheck({ output: { title: 'Review Yeti: INCOMPLETE (partial evidence published)', summary } })], [gateCheck()],
    )).toThrow(/generation recovery ledger/u);
  });

  it.each([
    ['a foreign worker App', [workerCheck({ app: { id: 77, slug: 'other-app' } })], [gateCheck()]],
    ['a foreign Gate App', [workerCheck()], [gateCheck({ app: { id: 77, slug: 'other-app' } })]],
    ['a Gate for a different head', [workerCheck()], [gateCheck({ head_sha: otherHeadSha })]],
    ['a Gate completed before its worker', [workerCheck()], [gateCheck({ completed_at: '2026-10-01T11:59:59Z' })]],
  ])('rejects %s even with a well-formed summary', (_label, workers, gates) => {
    expect(() => evaluateReviewGenerationRecoveryLedger(gracefulRequest(), workers, gates))
      .toThrow(/generation recovery ledger/u);
  });

  it('rejects conflicting latest App-Gate decisions at the same completion time', () => {
    const conflictingGate = gateCheck({
      id: 31_003,
      external_id: `review-yeti-gate:v1:${'e'.repeat(64)}`,
      conclusion: 'success',
      output: { title: 'Review Yeti Gate: Passed', summary: 'Passed.', text: null },
    });
    expect(() => evaluateReviewGenerationRecoveryLedger(
      gracefulRequest(), [workerCheck()], [gateCheck(), conflictingGate],
    )).toThrow(/generation recovery ledger/u);
  });

  it.each([
    ['the incomplete-P2 mode as well', { incompleteP2Recovery: true }],
    ['a third generation', { expectedGeneration: 3 }],
    ['a different head in the summary', { headSha: otherHeadSha }],
  ])('rejects graceful continuation when the request also selects %s', (_label, overrides) => {
    expect(() => evaluateReviewGenerationRecoveryLedger(
      gracefulRequest(overrides), [workerCheck()], [gateCheck()],
    )).toThrow(/generation recovery ledger/u);
  });

  it('does not accept a graceful worker marker when the caller omits the graceful mode', () => {
    const request = gracefulRequest({ gracefulComposedContinuation: undefined });
    expect(() => evaluateReviewGenerationRecoveryLedger(request, [workerCheck()], [gateCheck()]))
      .toThrow(/generation recovery ledger/u);
  });
});
