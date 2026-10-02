import { describe, expect, it, vi } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { renderIncompleteInfrastructureTitle } from '../../src/review/publicationFailurePolicy';
import {
  evaluateReviewGenerationRecoveryLedger,
  evaluateIncompleteP2RecoveryLedgerCandidate,
  selectIncompleteRecoveryGate,
  validateReviewGenerationRecoveryEvidence,
} from '../../src/review/reviewGenerationRecovery';

const headSha = 'a'.repeat(40);
const runId = `run_${'b'.repeat(32)}`;

function workerCheck(generation: number, overrides: Record<string, unknown> = {}) {
  return {
    id: 1_000 + generation,
    name: 'Review Yeti',
    head_sha: headSha,
    external_id: `${runId}:a${generation}`,
    status: 'completed',
    conclusion: 'failure',
    app: { id: 4_385_771, slug: 'ct-review-bot' },
    output: {
      title: 'Review Yeti: review did not complete',
      summary: 'No durable verdict was recorded.',
      text: null,
    },
    ...overrides,
  };
}

function clientFor(checks: unknown[]) {
  const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({
    total_count: checks.length,
    check_runs: checks,
  }), { status: 200, headers: { 'content-type': 'application/json' } }));
  return {
    client: new GitHubInstallationClient({ token: 'ghs_test', fetchImplementation }),
    fetchImplementation,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    owner: 'calltelemetry', repo: 'cisco-cdr', headSha, runId,
    expectedGeneration: 2, expectedAppId: 4_385_771,
    ...overrides,
  };
}

function incompleteWorkerCheck(
  generation: number,
  expected: number,
  completed: number,
  findingCounts: { canonical: number; raw: number },
  startedAt: string,
  completedAt: string,
) {
  const coverage = `Coverage: mode=panel; expected lanes=${expected}; completed lanes=${completed}; failed lanes=0; roster valid=false; quorum satisfied=false; full panel complete=false.`;
  return workerCheck(generation, {
    started_at: startedAt,
    completed_at: completedAt,
    output: {
      title: 'Review Yeti: BLOCK',
      summary: `Verdict \`BLOCK\` at \`${headSha}\`.\n\nFindings: ${findingCounts.canonical} (blocking P0/P1: 0; ${findingCounts.raw} raw persona finding(s) before clustering).\n\n${coverage}`,
      text: null,
    },
  });
}

function incompleteGateCheck(
  id: number,
  expected: number,
  completed: number,
  completedAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: 'Review Yeti Gate',
    head_sha: headSha,
    external_id: `review-yeti-gate:v1:${String(id).padStart(64, '0')}`,
    status: 'completed',
    conclusion: 'failure',
    app: { id: 4_385_771, slug: 'ct-review-bot' },
    completed_at: completedAt,
    output: {
      title: 'Review Yeti Gate: Failed (incomplete panel)',
      summary: `Review Yeti Gate failed: the panel expected ${expected} review lane(s) but ${completed} completed. This is an incomplete review, not a findings verdict; re-dispatch the review for this head.`,
      text: null,
    },
    ...overrides,
  };
}

function clientForPages(pages: Array<{ total_count: number; check_runs: unknown[] }>) {
  const fetchImplementation = vi.fn(async () => {
    const page = pages.shift();
    if (!page) throw new Error('unexpected recovery-ledger page');
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return {
    client: new GitHubInstallationClient({ token: 'ghs_test', fetchImplementation }),
    fetchImplementation,
  };
}

describe('Review Yeti worker-generation recovery ledger', () => {
  it('accepts only a contiguous recoverable App-owned ledger for the exact run and head', async () => {
    const { client, fetchImplementation } = clientFor([workerCheck(1)]);

    await expect(client.readReviewGenerationRecovery(request())).resolves.toEqual([{
      generation: 1,
      checkId: 1_001,
      externalId: `${runId}:a1`,
      conclusion: 'failure',
      title: 'Review Yeti: review did not complete',
    }]);
    const [requestUrl] = fetchImplementation.mock.calls[0] as unknown as [string];
    expect(new URL(requestUrl).searchParams.get('check_name')).toBe('Review Yeti');
  });

  it.each([
    ['a code-review verdict', workerCheck(1, { output: { title: 'Review Yeti: FIX_FIRST', summary: 'finding', text: null } })],
    ['a successful verdict', workerCheck(1, { conclusion: 'success' })],
    ['another App', workerCheck(1, { app: { id: 99, slug: 'attacker' } })],
    ['another durable run', workerCheck(1, { external_id: `run_${'c'.repeat(32)}:a1` })],
    ['a later generation', workerCheck(2)],
  ])('rejects %s instead of reconstructing service state', async (_label, check) => {
    const { client } = clientFor([check]);
    await expect(client.readReviewGenerationRecovery(request()))
      .rejects.toThrow(/generation recovery ledger/u);
  });

  // REL-1113: an infrastructure-incomplete worker check is recoverable on the generation-recovery
  // path too, so the admission path and the ledger never disagree about it.
  const exhaustedIncomplete = renderIncompleteInfrastructureTitle([{ id: 'arch-lane', failureClass: 'provider_error', providerStatus: 502 }]);
  const retryingIncomplete = renderIncompleteInfrastructureTitle([{ id: 'arch-lane', failureClass: 'transport' }], { nextAttempt: 2, maxAttempts: 3 });
  const lookalike = 'Review Yeti: INCOMPLETE — infrastructure (lane arch-lane failed: 502); retrying soon';

  it.each([exhaustedIncomplete, retryingIncomplete])('accepts an infrastructure-incomplete ledger row titled %s', async (title) => {
    const { client } = clientFor([workerCheck(1, { output: { title, summary: 'infra', text: null } })]);
    await expect(client.readReviewGenerationRecovery(request())).resolves.toEqual([{
      generation: 1, checkId: 1_001, externalId: `${runId}:a1`, conclusion: 'failure', title,
    }]);
    expect(validateReviewGenerationRecoveryEvidence(
      { ...request(), expectedGeneration: 2 } as never,
      [{ generation: 1, checkId: 1_001, externalId: `${runId}:a1`, conclusion: 'failure', title }],
    )).toHaveLength(1);
  });

  it('refuses a lookalike INCOMPLETE title on both generation-recovery validators', async () => {
    const { client } = clientFor([workerCheck(1, { output: { title: lookalike, summary: 'infra', text: null } })]);
    await expect(client.readReviewGenerationRecovery(request())).rejects.toThrow(/generation recovery ledger/u);
    expect(() => validateReviewGenerationRecoveryEvidence(
      { ...request(), expectedGeneration: 2 } as never,
      [{ generation: 1, checkId: 1_001, externalId: `${runId}:a1`, conclusion: 'failure', title: lookalike }],
    )).toThrow(/generation recovery ledger/u);
  });

  it('rejects a missing, duplicate, or non-contiguous prior generation', async () => {
    for (const checks of [[], [workerCheck(1), workerCheck(1, { id: 2_001 })]]) {
      const { client } = clientFor(checks);
      await expect(client.readReviewGenerationRecovery(request()))
        .rejects.toThrow(/generation recovery ledger/u);
    }
  });

  it('accepts an exact merge-group row without treating it as worker evidence', async () => {
    const mergeGroup = workerCheck(99, {
      id: 9_999,
      external_id: `merge-group:${headSha}`,
    });
    const { client } = clientFor([workerCheck(1), mergeGroup]);

    await expect(client.readReviewGenerationRecovery(request())).resolves.toEqual([
      expect.objectContaining({ generation: 1, checkId: 1_001 }),
    ]);

    const { client: malformed } = clientFor([
      workerCheck(1),
      { ...mergeGroup, head_sha: 'c'.repeat(40) },
    ]);
    await expect(malformed.readReviewGenerationRecovery(request()))
      .rejects.toThrow(/generation recovery ledger/u);
  });

  it('reads a complete stable two-page ledger', async () => {
    const mergeGroups = Array.from({ length: 100 }, (_, index) => workerCheck(99, {
      id: 10_000 + index,
      external_id: `merge-group:${headSha}`,
    }));
    const { client, fetchImplementation } = clientForPages([
      { total_count: 101, check_runs: mergeGroups },
      { total_count: 101, check_runs: [workerCheck(1)] },
    ]);

    await expect(client.readReviewGenerationRecovery(request())).resolves.toEqual([
      expect.objectContaining({ generation: 1, checkId: 1_001 }),
    ]);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    const [firstPageUrl] = fetchImplementation.mock.calls[0] as unknown as [string];
    const [secondPageUrl] = fetchImplementation.mock.calls[1] as unknown as [string];
    expect(new URL(firstPageUrl).searchParams.get('page')).toBe('1');
    expect(new URL(secondPageUrl).searchParams.get('page')).toBe('2');
  });

  it('sorts and validates both prior generations for an a3 recovery', async () => {
    const { client } = clientFor([workerCheck(2), workerCheck(1)]);

    await expect(client.readReviewGenerationRecovery(request({ expectedGeneration: 3 })))
      .resolves.toEqual([
        expect.objectContaining({ generation: 1, checkId: 1_001, externalId: `${runId}:a1` }),
        expect.objectContaining({ generation: 2, checkId: 1_002, externalId: `${runId}:a2` }),
      ]);
  });

  it('matches an older P2 Gate by its worker window and the newest incomplete Gate globally', () => {
    const first = incompleteWorkerCheck(1, 6, 5, { canonical: 2, raw: 3 },
      '2026-09-24T18:28:50Z', '2026-09-24T18:28:56Z');
    const second = incompleteWorkerCheck(2, 4, 3, { canonical: 0, raw: 0 },
      '2026-09-24T18:29:00Z', '2026-09-24T18:29:56Z');
    const gate1 = incompleteGateCheck(2_001, 6, 5, '2026-09-24T18:28:58Z');
    const gate2 = incompleteGateCheck(2_002, 4, 3, '2026-09-24T18:30:00Z');
    const candidate = request({ expectedGeneration: 3, incompleteP2Recovery: true });
    const evidence = evaluateReviewGenerationRecoveryLedger(candidate, [second, first], [gate2, gate1]);

    expect(evidence).toHaveLength(2);
    const firstProof = evidence[0].legacyIncompleteRoster!;
    const secondProof = evidence[1].legacyIncompleteRoster!;
    expect(firstProof.nextWorkerStartedAt).toBe('2026-09-24T18:29:00Z');
    expect(firstProof.workerStartedAt).toBe('2026-09-24T18:28:50Z');
    expect(selectIncompleteRecoveryGate(candidate, firstProof)?.id).toBe(gate1.id);
    expect(secondProof.nextWorkerStartedAt).toBeUndefined();
    expect(selectIncompleteRecoveryGate(candidate, secondProof)?.id).toBe(gate2.id);
  });

  it('keeps the generic App-ledger validator strict when the latest P2 proof lacks workerStartedAt', () => {
    const candidate = request({ expectedGeneration: 2, incompleteP2Recovery: true });
    const worker = incompleteWorkerCheck(1, 4, 3, { canonical: 1, raw: 1 },
      '2026-09-24T18:28:50Z', '2026-09-24T18:28:56Z');
    const gate = incompleteGateCheck(2_001, 4, 3, '2026-09-24T18:28:58Z');
    const [proof] = evaluateReviewGenerationRecoveryLedger(candidate, [worker], [gate]);
    const { workerStartedAt: _oldStart, ...legacyRoster } = proof.legacyIncompleteRoster!;

    expect(() => validateReviewGenerationRecoveryEvidence(
      candidate,
      [{ ...proof, legacyIncompleteRoster: legacyRoster }],
    )).toThrow(/generation recovery ledger/u);
  });

  it.each([
    ['missing earlier Gate', (gate1: ReturnType<typeof incompleteGateCheck>, gate2: ReturnType<typeof incompleteGateCheck>) => [gate2]],
    ['earlier Gate completed after the next worker started', (gate1: ReturnType<typeof incompleteGateCheck>, gate2: ReturnType<typeof incompleteGateCheck>) => [
      { ...gate1, completed_at: '2026-09-24T18:29:01Z' }, gate2,
    ]],
    ['latest Gate is a successful verdict', (gate1: ReturnType<typeof incompleteGateCheck>, gate2: ReturnType<typeof incompleteGateCheck>) => [
      gate1,
      { ...gate2, conclusion: 'success', output: { title: 'Review Yeti Gate: Passed', summary: 'Passed.', text: null } },
    ]],
    ['conflicting same-time earlier Gates', (gate1: ReturnType<typeof incompleteGateCheck>, gate2: ReturnType<typeof incompleteGateCheck>) => [
      gate1,
      { ...gate1, id: 2_003, external_id: `review-yeti-gate:v1:${'d'.repeat(64)}`, output: { title: 'Review Yeti Gate: Failed', summary: 'Different same-time result.', text: null } },
      gate2,
    ]],
    ['conflicting same-time newest Gates', (gate1: ReturnType<typeof incompleteGateCheck>, gate2: ReturnType<typeof incompleteGateCheck>) => [
      gate1,
      gate2,
      { ...gate2, id: 2_004, external_id: `review-yeti-gate:v1:${'e'.repeat(64)}`, conclusion: 'success' },
    ]],
  ])('refuses P2 a3 recovery with %s', (_label, makeGates) => {
    const first = incompleteWorkerCheck(1, 6, 5, { canonical: 2, raw: 3 },
      '2026-09-24T18:28:50Z', '2026-09-24T18:28:56Z');
    const second = incompleteWorkerCheck(2, 4, 3, { canonical: 0, raw: 0 },
      '2026-09-24T18:29:00Z', '2026-09-24T18:29:56Z');
    const gate1 = incompleteGateCheck(2_001, 6, 5, '2026-09-24T18:28:58Z');
    const gate2 = incompleteGateCheck(2_002, 4, 3, '2026-09-24T18:30:00Z');
    expect(() => evaluateReviewGenerationRecoveryLedger(
      request({ expectedGeneration: 3, incompleteP2Recovery: true }),
      [first, second],
      makeGates(gate1, gate2),
    )).toThrow(/generation recovery ledger/u);
  });

  it('chooses the maximum check id for identical same-time Gates in a P2 window', () => {
    const first = incompleteWorkerCheck(1, 6, 5, { canonical: 2, raw: 3 },
      '2026-09-24T18:28:50Z', '2026-09-24T18:28:56Z');
    const second = incompleteWorkerCheck(2, 4, 3, { canonical: 0, raw: 0 },
      '2026-09-24T18:29:00Z', '2026-09-24T18:29:56Z');
    const gate1 = incompleteGateCheck(2_001, 6, 5, '2026-09-24T18:28:58Z');
    const tiedGate1 = { ...gate1, id: 2_005 };
    const gate2 = incompleteGateCheck(2_002, 4, 3, '2026-09-24T18:30:00Z');
    const candidate = request({ expectedGeneration: 3, incompleteP2Recovery: true });
    const evidence = evaluateReviewGenerationRecoveryLedger(candidate, [first, second], [gate1, tiedGate1, gate2]);
    expect(selectIncompleteRecoveryGate(candidate, evidence[0].legacyIncompleteRoster!)?.id).toBe(tiedGate1.id);
  });

  it('keeps zero-only tied Gate recovery on the previous maximum check-id behavior', () => {
    const worker = incompleteWorkerCheck(1, 4, 3, { canonical: 0, raw: 0 },
      '2026-09-24T18:28:50Z', '2026-09-24T18:28:56Z');
    const failed = incompleteGateCheck(2_101, 4, 3, '2026-09-24T18:28:58Z');
    const lowerIdSuccess = { ...failed, id: 2_100, conclusion: 'success' };
    const evidence = evaluateReviewGenerationRecoveryLedger(request(), [worker], [lowerIdSuccess, failed]);
    expect(evidence).toHaveLength(1);
    expect(selectIncompleteRecoveryGate(request(), evidence[0].legacyIncompleteRoster!)?.id).toBe(failed.id);
  });

  it('checks ambiguity only at the latest Gate timestamp, independently of inventory order', () => {
    const worker = incompleteWorkerCheck(1, 4, 3, { canonical: 1, raw: 1 },
      '2026-09-24T18:28:50Z', '2026-09-24T18:28:56Z');
    const older = incompleteGateCheck(2_100, 4, 3, '2026-09-24T18:28:57Z');
    const olderConflict = { ...older, id: 2_101, conclusion: 'success' };
    const latest = incompleteGateCheck(2_102, 4, 3, '2026-09-24T18:28:58Z');
    const candidate = request({ incompleteP2Recovery: true });
    for (const gates of [[older, olderConflict, latest], [latest, olderConflict, older]]) {
      const evidence = evaluateReviewGenerationRecoveryLedger(candidate, [worker], gates);
      expect(selectIncompleteRecoveryGate(candidate, evidence[0].legacyIncompleteRoster!)?.id).toBe(latest.id);
    }
  });

  it('rejects invalid calendar timestamps in a P2 recovery timeline', () => {
    const first = incompleteWorkerCheck(1, 6, 5, { canonical: 2, raw: 3 },
      '2026-02-30T18:28:50Z', '2026-09-24T18:28:56Z');
    const second = incompleteWorkerCheck(2, 4, 3, { canonical: 0, raw: 0 },
      '2026-09-24T18:29:00Z', '2026-09-24T18:29:56Z');
    const gates = [
      incompleteGateCheck(2_001, 6, 5, '2026-09-24T18:28:58Z'),
      incompleteGateCheck(2_002, 4, 3, '2026-09-24T18:30:00Z'),
    ];
    expect(() => evaluateReviewGenerationRecoveryLedger(
      request({ expectedGeneration: 3, incompleteP2Recovery: true }), [first, second], gates,
    )).toThrow(/generation recovery ledger/u);
  });

  it('rejects an inverted worker interval while its P2 Gates otherwise match', () => {
    const first = incompleteWorkerCheck(1, 6, 5, { canonical: 2, raw: 3 },
      '2026-09-24T18:28:58Z', '2026-09-24T18:28:56Z');
    const second = incompleteWorkerCheck(2, 4, 3, { canonical: 1, raw: 1 },
      '2026-09-24T18:29:00Z', '2026-09-24T18:29:06Z');
    const gates = [
      incompleteGateCheck(2_001, 6, 5, '2026-09-24T18:28:58Z'),
      incompleteGateCheck(2_002, 4, 3, '2026-09-24T18:29:08Z'),
    ];

    expect(() => evaluateReviewGenerationRecoveryLedger(
      request({ expectedGeneration: 3, incompleteP2Recovery: true }), [first, second], gates,
    )).toThrow(/generation recovery ledger/u);
  });

  it.each([
    ['overlapping workers', '2026-09-24T18:28:59Z'],
    ['workers meeting exactly at the boundary', '2026-09-24T18:29:00Z'],
  ])('rejects %s in P2 recovery while the newest Gate otherwise matches', (_label, secondStartedAt) => {
    // Keep the first row as a recognized infrastructure-incomplete failure so
    // the overlap guard is the only thing rejecting this otherwise-valid
    // ledger. The candidate is still evaluated with incomplete-P2 recovery
    // enabled, and the newest P2 row has an exact matching canonical Gate.
    const first = workerCheck(1, {
      started_at: '2026-09-24T18:28:50Z',
      completed_at: '2026-09-24T18:29:00Z',
      output: { title: exhaustedIncomplete, summary: 'infra', text: null },
    });
    const second = incompleteWorkerCheck(2, 4, 3, { canonical: 1, raw: 1 },
      secondStartedAt, '2026-09-24T18:29:06Z');
    const matchingLatestGate = incompleteGateCheck(2_002, 4, 3, '2026-09-24T18:29:08Z');

    expect(() => evaluateReviewGenerationRecoveryLedger(
      request({ expectedGeneration: 3, incompleteP2Recovery: true }), [first, second], [matchingLatestGate],
    )).toThrow(/generation recovery ledger/u);
  });

  it('refuses recovery beyond the bounded a3 generation without calling GitHub', async () => {
    const fetchImplementation = vi.fn();
    const client = new GitHubInstallationClient({ token: 'ghs_test', fetchImplementation });

    await expect(client.readReviewGenerationRecovery(request({ expectedGeneration: 4 })))
      .rejects.toThrow(/generation recovery ledger/u);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    ['a changing total count', [
      { total_count: 101, check_runs: Array.from({ length: 100 }, (_, index) => workerCheck(99, {
        id: 20_000 + index, external_id: `merge-group:${headSha}`,
      })) },
      { total_count: 102, check_runs: [workerCheck(1)] },
    ]],
    ['an id repeated across pages', [
      { total_count: 101, check_runs: Array.from({ length: 100 }, (_, index) => workerCheck(99, {
        id: 30_000 + index, external_id: `merge-group:${headSha}`,
      })) },
      { total_count: 101, check_runs: [workerCheck(1, { id: 30_000 })] },
    ]],
    ['an incomplete short page', [
      { total_count: 2, check_runs: [workerCheck(1)] },
    ]],
    ['an unbounded ledger', [
      { total_count: 1_000, check_runs: [] },
    ]],
  ] as const)('rejects %s', async (_label, pages) => {
    const { client } = clientForPages(pages.map((page) => ({
      total_count: page.total_count,
      check_runs: [...page.check_runs],
    })));
    await expect(client.readReviewGenerationRecovery(request()))
      .rejects.toThrow(/generation recovery ledger/u);
  });

  it('rejects malformed immutable identity before issuing a GitHub request', async () => {
    const fetchImplementation = vi.fn();
    const client = new GitHubInstallationClient({ token: 'ghs_test', fetchImplementation });

    await expect(client.readReviewGenerationRecovery(request({ headSha: '../check-runs?app_id=1' }) as any))
      .rejects.toThrow(/generation recovery ledger/u);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe('historical archive fetch candidates', () => {
  it('preserves historical wording for locked verification while ordinary admission stays strict', async () => {
    const candidate = request({ incompleteP2Recovery: true });
    const worker = incompleteWorkerCheck(1, 7, 3, { canonical: 3, raw: 3 },
      '2026-09-29T11:59:58Z', '2026-09-29T12:00:00Z');
    const original = worker.output.summary.replace('P0/P1: 0', 'P0/P1/P2: 3');
    worker.output.summary = original;
    const gate = incompleteGateCheck(2001, 7, 3, '2026-09-29T12:00:02Z');
    expect(() => evaluateReviewGenerationRecoveryLedger(candidate, [worker], [gate])).toThrow();
    const proof = evaluateIncompleteP2RecoveryLedgerCandidate(candidate, [worker], [gate]);
    expect(proof[0].legacyIncompleteRoster?.workerSummary).toBe(original);
    expect(() => validateReviewGenerationRecoveryEvidence(candidate, proof)).toThrow();
    const { client } = clientForPages([
      { total_count: 1, check_runs: [worker] }, { total_count: 1, check_runs: [gate] },
    ]);
    await expect(client.readReviewGenerationRecovery(candidate)).resolves.toEqual(proof);
  });

  it('rejects foreign App and successful Gate candidates before reading any archive', () => {
    const candidate = request({ incompleteP2Recovery: true });
    const worker = incompleteWorkerCheck(1, 7, 3, { canonical: 3, raw: 3 },
      '2026-09-29T11:59:58Z', '2026-09-29T12:00:00Z');
    const gate = incompleteGateCheck(2001, 7, 3, '2026-09-29T12:00:02Z');
    expect(() => evaluateIncompleteP2RecoveryLedgerCandidate(candidate,
      [{ ...worker, app: { ...worker.app, id: 1 } }], [gate])).toThrow();
    expect(() => evaluateIncompleteP2RecoveryLedgerCandidate(candidate,
      [worker], [{ ...gate, conclusion: 'success' }])).toThrow();
  });
});

describe('graceful composed continuation candidates', () => {
  const gracefulRequest = request({ gracefulComposedContinuation: true });
  const gracefulWorkerSummary = (format: 'current' | 'historical') => {
    const findings = format === 'current'
      ? 'Findings: 3 (blocking P0/P1: 0; 4 raw persona finding(s) before clustering).'
      : 'Findings: 3 (blocking P0/P1/P2: 3; 4 raw persona finding(s) before clustering).';
    return [
      `Evidence collection reached its 20-minute cutoff at \`${headSha}\`. The final closeout preserved and published 3 validated finding(s); 4 risk-ordered task(s) remain. This is fail-closed, not an approval. An exact-head rerun resumes the durable completed-task checkpoint.`,
      `Verdict \`BLOCK\` at \`${headSha}\`.`,
      findings,
      'Coverage: engine=composed; planned tasks=7; expected tasks=7; completed tasks=3; failed tasks=0; roster valid=false; quorum satisfied=false; task coverage complete=false.',
    ].join('\n\n');
  };
  const gracefulWorker = (format: 'current' | 'historical' = 'current') => workerCheck(1, {
    started_at: '2026-09-29T11:59:58Z',
    completed_at: '2026-09-29T12:00:00Z',
    output: {
      title: 'Review Yeti: INCOMPLETE (partial evidence published)',
      summary: gracefulWorkerSummary(format),
      text: null,
    },
  });
  const gracefulGate = () => incompleteGateCheck(2_101, 7, 3, '2026-09-29T12:00:02Z');

  it.each(['current', 'historical'] as const)(
    'retains the exact %s graceful summary and marker through candidate evaluation and GitHub pages',
    async (format) => {
      const worker = gracefulWorker(format);
      const gate = gracefulGate();
      const proof = evaluateIncompleteP2RecoveryLedgerCandidate(gracefulRequest, [worker], [gate]);

      expect(proof).toHaveLength(1);
      expect(proof[0].legacyIncompleteRoster).toEqual(expect.objectContaining({
        workerSummary: worker.output.summary,
        gracefulComposedPartial: true,
        workerStartedAt: '2026-09-29T11:59:58Z',
        workerCompletedAt: '2026-09-29T12:00:00Z',
        gateChecks: [gate],
      }));
      if (format === 'current') {
        expect(validateReviewGenerationRecoveryEvidence(gracefulRequest, proof)).toEqual(proof);
      } else {
        expect(() => validateReviewGenerationRecoveryEvidence(gracefulRequest, proof))
          .toThrow(/generation recovery ledger/u);
      }

      const { client, fetchImplementation } = clientForPages([
        { total_count: 1, check_runs: [worker] },
        { total_count: 1, check_runs: [gate] },
      ]);
      const fetched = await client.readReviewGenerationRecovery(gracefulRequest);
      expect(fetched[0].legacyIncompleteRoster).toEqual(expect.objectContaining({
        workerSummary: worker.output.summary,
        gracefulComposedPartial: true,
      }));
      expect(fetchImplementation).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ['foreign App', (worker: ReturnType<typeof gracefulWorker>, gate: ReturnType<typeof gracefulGate>) => [
      { ...worker, app: { id: 99, slug: 'foreign-app' } }, gate,
    ]],
    ['successful Gate', (worker: ReturnType<typeof gracefulWorker>, gate: ReturnType<typeof gracefulGate>) => [
      worker, { ...gate, conclusion: 'success', output: { title: 'Review Yeti Gate: Passed', summary: 'Passed.', text: null } },
    ]],
    ['inverted worker interval', (worker: ReturnType<typeof gracefulWorker>, gate: ReturnType<typeof gracefulGate>) => [
      { ...worker, started_at: '2026-09-29T12:00:01Z' }, gate,
    ]],
  ])('rejects a graceful candidate with %s using only injected response pages', async (_label, corrupt) => {
    const worker = gracefulWorker();
    const gate = gracefulGate();
    const [invalidWorker, invalidGate] = corrupt(worker, gate) as [typeof worker, typeof gate];
    const { client, fetchImplementation } = clientForPages([
      { total_count: 1, check_runs: [invalidWorker] },
      { total_count: 1, check_runs: [invalidGate] },
    ]);

    await expect(client.readReviewGenerationRecovery(gracefulRequest))
      .rejects.toThrow(/generation recovery ledger/u);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it('keeps graceful and incomplete-P2 request modes mutually exclusive before GitHub access', async () => {
    const { client, fetchImplementation } = clientForPages([]);
    await expect(client.readReviewGenerationRecovery(request({
      incompleteP2Recovery: true,
      gracefulComposedContinuation: true,
    }))).rejects.toThrow(/generation recovery ledger/u);
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});
