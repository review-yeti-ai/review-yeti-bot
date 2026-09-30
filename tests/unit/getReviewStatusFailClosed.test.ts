import { describe, expect, it } from 'vitest';
import {
  createGetReviewStatusTool,
  type ReviewStatusDbClient,
} from '../../src/mcp/server/tools/getReviewStatus';
import { fetchRunResource } from '../../src/mcp/server/resources/runResource';
import type { ResourceDbClient } from '../../src/mcp/server/resources/resourceTypes';
import {
  evaluateReviewGate,
  REVIEW_GATE_REASONS,
  REVIEW_GATE_CANCELLATION_REASONS,
  reviewGateStatusForReason,
  type ReviewGateEvidence,
  type ReviewRiskAcceptance,
} from '../../src/review/reviewGatePolicy';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run_status_mapping',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    pr_number: 42,
    head_sha: 'a'.repeat(40),
    run_status: 'succeeded',
    run_stage: 'complete',
    attempt: 1,
    lease_owner: null,
    lease_expires_at: null,
    created_at: '2026-09-29T12:00:00.000Z',
    updated_at: '2026-09-29T12:01:00.000Z',
    attempt_id: 'attempt-status-mapping',
    check_id: null,
    desired_state: null,
    decision: null,
    ...overrides,
  };
}

async function getStatus(row: Record<string, unknown>) {
  const db: ReviewStatusDbClient = {
    async query(sql) {
      return { rows: sql.includes('review_event_outbox') ? [] : [row] };
    },
  };
  const tool = createGetReviewStatusTool(db);
  const result = await tool.execute({
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    pull_number: 42,
  });
  return JSON.parse((result.content[0] as { text: string }).text);
}

async function getResourceStatus(row: Record<string, unknown>) {
  const db: ResourceDbClient = { async query() { return { rows: [row] }; } };
  return fetchRunResource('review-yeti-ai', 'review-yeti-bot', 42, db);
}

const verdictProjectionCases: Array<{
  name: string;
  row: Record<string, unknown>;
  expected: string;
  expectedPhase?: string;
}> = [
  ...[
    { actorPermission: 'read' },
    { actorLogin: 'reviewer bot' },
    { eventId: 0 },
    { eventId: Number.MAX_SAFE_INTEGER + 1 },
    { appliedAt: '2026-09-29T12:01:00' },
    { reviewedAt: 'invalid' },
  ].map((auditPatch) => ({
    name: `accepted-risk rejects malformed field ${JSON.stringify(auditPatch)}`,
    row: baseRow({ desired_state: 'success', decision: { status: 'success', eligible: true, reason: 'human-accepted-risk', audit: {
      eventId: 1, actorLogin: 'reviewer', actorPermission: 'write',
      appliedAt: '2026-09-29T12:01:00Z', reviewedAt: '2026-09-29T12:00:00Z', ...auditPatch,
    } } }),
    expected: 'FAILED',
  })),
  ...[
    { desired_state: 'queued', run_status: 'queued', expected: 'PENDING' },
    { desired_state: 'in_progress', run_status: 'running', expected: 'RUNNING' },
    { desired_state: 'failure', run_status: 'failed', expected: 'FAILED' },
  ].map(({ expected, ...state }) => ({
    name: `native pending decision projects ${state.desired_state}`,
    row: baseRow({ ...state, decision: { status: 'pending', eligible: false, reason: 'review-pending' } }),
    expected,
  })),
  {
    name: 'native cancellation reason stays failed',
    row: baseRow({ desired_state: 'cancelled', decision: { status: 'cancelled', eligible: false, reason: 'operator-cancelled' } }),
    expected: 'FAILED',
  },
  {
    name: 'native timeout reason stays failed',
    row: baseRow({ desired_state: 'timed_out', decision: { status: 'timed_out', eligible: false, reason: 'review-deadline-exceeded' } }),
    expected: 'FAILED',
  },
  {
    name: 'native success requires eligibility true',
    row: baseRow({ desired_state: 'success', decision: { status: 'success', eligible: false, reason: 'clean-review' } }),
    expected: 'FAILED',
  },
  {
    name: 'native failure requires eligibility false',
    row: baseRow({ desired_state: 'failure', decision: { status: 'failure', eligible: true, reason: 'incomplete-review' } }),
    expected: 'FAILED',
  },
  ...['running', 'publishing'].flatMap((runStatus) => [
    ...['arbitration', 'publish'].map((runStage) => ({
      name: `${runStatus} at ${runStage} projects arbitration phase`,
      row: baseRow({ run_status: runStatus, run_stage: runStage }),
      expected: 'RUNNING', expectedPhase: 'arbitration',
    })),
    {
      name: `${runStatus} at evaluate projects evaluating phase`,
      row: baseRow({ run_status: runStatus, run_stage: 'evaluate' }),
      expected: 'RUNNING', expectedPhase: 'evaluating_personas',
    },
  ]),
  ...[null, undefined, ''].flatMap((desiredState) => [
    {
      name: `absent gate ${String(desiredState)} preserves explicit completed legacy approval`,
      row: baseRow({ desired_state: desiredState, run_status: 'completed', decision: { verdict: 'SHIP' } }),
      expected: 'SHIP',
    },
    {
      name: `absent gate ${String(desiredState)} does not invent completed legacy approval`,
      row: baseRow({ desired_state: desiredState, run_status: 'completed', decision: null }),
      expected: 'FAILED',
    },
  ]),
  ...[0, false].map((desiredState) => ({
    name: `invalid gate ${String(desiredState)} cannot conceal a native pending state`,
    row: baseRow({ desired_state: desiredState, decision: { status: 'pending', eligible: false, reason: 'review-pending' } }),
    expected: 'FAILED',
  })),
  {
    name: 'unknown gate preserves explicit FIX_FIRST findings',
    row: baseRow({ desired_state: 'future-state', decision: { verdict: 'FIX_FIRST' } }),
    expected: 'FIX_FIRST',
  },
  {
    name: 'unknown gate state cannot conceal a failed run without a decision',
    row: baseRow({ desired_state: 'future-state', run_status: 'failed', decision: null }),
    expected: 'FAILED',
  },
  {
    name: 'unknown gate state cannot approve an explicit SHIP',
    row: baseRow({ desired_state: 'future-state', decision: { verdict: 'SHIP' } }),
    expected: 'FAILED',
  },
  {
    name: 'unknown gate state cannot approve a native clean-review decision',
    row: baseRow({ desired_state: 'future-state', decision: { status: 'success', eligible: true, reason: 'clean-review' } }),
    expected: 'FAILED',
  },
  {
    name: 'unknown gate state cannot remain pending with a native pending decision',
    row: baseRow({ desired_state: 'future-state', decision: { status: 'pending', eligible: false, reason: 'review-pending' } }),
    expected: 'FAILED',
  },
  {
    name: 'numeric zero gate state is invalid rather than an absent gate',
    row: baseRow({ desired_state: 0, decision: { verdict: 'SHIP' } }),
    expected: 'FAILED',
  },
  {
    name: 'boolean false gate state is invalid rather than an absent gate',
    row: baseRow({ desired_state: false, decision: null }),
    expected: 'FAILED',
  },
  {
    name: 'native success cannot accept an incomplete-review failure reason',
    row: baseRow({ desired_state: 'success', decision: { status: 'success', eligible: true, reason: 'incomplete-review' } }),
    expected: 'FAILED',
  },
  {
    name: 'native success cannot accept an unknown reason',
    row: baseRow({ desired_state: 'success', decision: { status: 'success', eligible: true, reason: 'future-reason' } }),
    expected: 'FAILED',
  },
  {
    name: 'native accepted-risk success requires its audit record',
    row: baseRow({ desired_state: 'success', decision: { status: 'success', eligible: true, reason: 'human-accepted-risk' } }),
    expected: 'FAILED',
  },
  {
    name: 'native accepted-risk success rejects an acceptance before review',
    row: baseRow({ desired_state: 'success', decision: { status: 'success', eligible: true, reason: 'human-accepted-risk', audit: {
      eventId: 1, actorLogin: 'reviewer', actorPermission: 'write',
      appliedAt: '2026-09-29T11:00:00Z', reviewedAt: '2026-09-29T12:00:00Z',
    } } }),
    expected: 'FAILED',
  },
  {
    name: 'native accepted-risk success retains the existing valid audit contract',
    row: baseRow({ desired_state: 'success', decision: { status: 'success', eligible: true, reason: 'human-accepted-risk', audit: {
      eventId: 1, actorLogin: 'reviewer', actorPermission: 'write',
      appliedAt: '2026-09-29T12:01:00Z', reviewedAt: '2026-09-29T12:00:00Z',
    } } }),
    expected: 'SHIP',
  },
  {
    name: 'unknown explicit verdict cannot become SHIP through successful gate fallback',
    row: baseRow({ desired_state: 'success', decision: { verdict: 'FUTURE_VERDICT' } }),
    expected: 'FAILED',
  },
  {
    name: 'numeric explicit verdict is invalid regardless of fallback state',
    row: baseRow({ desired_state: 'success', decision: { verdict: 17 } }),
    expected: 'FAILED',
  },
  {
    name: 'null explicit verdict is invalid despite a successful run',
    row: baseRow({ run_status: 'complete', decision: { verdict: null } }),
    expected: 'FAILED',
  },
  {
    name: 'unknown explicit verdict cannot become FIX_FIRST through failed gate fallback',
    row: baseRow({ desired_state: 'failure', decision: { verdict: 'FUTURE_VERDICT' } }),
    expected: 'FAILED',
  },
  {
    name: 'malformed serialized decision is invalid despite successful gate fallback',
    row: baseRow({ desired_state: 'success', decision: '{not-json' }),
    expected: 'FAILED',
  },
  {
    name: 'non-object explicit decision is invalid despite successful gate fallback',
    row: baseRow({ desired_state: 'success', decision: 17 }),
    expected: 'FAILED',
  },
  {
    name: 'failed gate without a decision stays generic FAILED',
    row: baseRow({ run_status: 'queued', desired_state: 'failure', decision: null }),
    expected: 'FAILED',
    expectedPhase: 'completed',
  },
  {
    name: 'incomplete review gate does not imply completed findings',
    row: baseRow({
      run_status: 'queued',
      desired_state: 'failure',
      decision: { status: 'failure', eligible: false, reason: 'incomplete-review' },
    }),
    expected: 'FAILED',
    expectedPhase: 'completed',
  },
  {
    name: 'SHIP cannot override failed gate',
    row: baseRow({ run_status: 'failed', desired_state: 'failure', decision: { verdict: 'SHIP' } }),
    expected: 'FAILED',
  },
  {
    name: 'SHIP cannot override cancelled gate',
    row: baseRow({ run_status: 'cancelled', desired_state: 'cancelled', decision: { verdict: 'SHIP' } }),
    expected: 'FAILED',
  },
  {
    name: 'SHIP cannot override timed out gate',
    row: baseRow({ run_status: 'failed', desired_state: 'timed_out', decision: { verdict: 'SHIP' } }),
    expected: 'FAILED',
  },
  {
    name: 'SHIP cannot override queued gate',
    row: baseRow({ run_status: 'queued', desired_state: 'queued', decision: { verdict: 'SHIP' } }),
    expected: 'PENDING',
  },
  {
    name: 'SHIP cannot override in-progress gate',
    row: baseRow({ run_status: 'running', desired_state: 'in_progress', decision: { verdict: 'SHIP' } }),
    expected: 'RUNNING',
  },
  {
    name: 'SHIP without gate state cannot override queued run status',
    row: baseRow({ run_status: 'queued', decision: { verdict: 'SHIP' } }),
    expected: 'PENDING',
  },
  {
    name: 'SHIP without gate state cannot override running run status',
    row: baseRow({ run_status: 'running', decision: { verdict: 'SHIP' } }),
    expected: 'RUNNING',
  },
  {
    name: 'SHIP without gate state cannot override publishing run status',
    row: baseRow({ run_status: 'publishing', decision: { verdict: 'SHIP' } }),
    expected: 'RUNNING',
  },
  {
    name: 'SHIP without gate state cannot override failed run status',
    row: baseRow({ run_status: 'failed', decision: { verdict: 'SHIP' } }),
    expected: 'FAILED',
  },
  {
    name: 'explicit FIX_FIRST with completed finding remains FIX_FIRST on gate failure',
    row: baseRow({
      run_status: 'queued',
      desired_state: 'failure',
      decision: { verdict: 'FIX_FIRST', findings: [{ severity: 'P1', title: 'completed finding' }] },
    }),
    expected: 'FIX_FIRST',
    expectedPhase: 'completed',
  },
  {
    name: 'explicit BLOCK with completed finding remains NACK on gate failure',
    row: baseRow({
      desired_state: 'failure',
      decision: { verdict: 'BLOCK', findings: [{ severity: 'P0', title: 'completed blocking finding' }] },
    }),
    expected: 'NACK',
  },
  {
    name: 'explicit COMMENT mapping remains available on gate failure',
    row: baseRow({ desired_state: 'failure', decision: { verdict: 'COMMENT' } }),
    expected: 'COMMENT',
  },
  {
    name: 'matching explicit SHIP and successful gate remain SHIP',
    row: baseRow({ desired_state: 'success', decision: { verdict: 'SHIP', findings: [] } }),
    expected: 'SHIP',
  },
  {
    name: 'missing decision with native successful gate keeps compatibility SHIP',
    row: baseRow({ run_status: 'queued', desired_state: 'success', decision: null }),
    expected: 'SHIP',
    expectedPhase: 'completed',
  },
  {
    name: 'native successful gate decision remains SHIP with queued legacy run row',
    row: baseRow({
      run_status: 'queued',
      desired_state: 'success',
      decision: { status: 'success', eligible: true, reason: 'clean-review' },
    }),
    expected: 'SHIP',
    expectedPhase: 'completed',
  },
  {
    name: 'queued state without a decision remains PENDING',
    row: baseRow({ run_status: 'queued', desired_state: 'queued', decision: null }),
    expected: 'PENDING',
  },
  {
    name: 'in-progress state without a decision remains RUNNING',
    row: baseRow({ run_status: 'queued', desired_state: 'in_progress', decision: null }),
    expected: 'RUNNING',
    expectedPhase: 'queued',
  },
  {
    name: 'successful legacy run without gate or decision remains SHIP',
    row: baseRow({ run_status: 'complete', decision: null }),
    expected: 'SHIP',
  },
  {
    name: 'legacy continuation completed status preserves explicit SHIP',
    row: baseRow({ run_status: 'completed', decision: { verdict: 'SHIP' } }),
    expected: 'SHIP',
  },
  {
    name: 'legacy completed status alone is not evidence of SHIP',
    row: baseRow({ run_status: 'completed', decision: null }),
    expected: 'FAILED',
  },
  {
    name: 'unknown nonempty run status cannot approve explicit SHIP',
    row: baseRow({ run_status: 'future-status', decision: { verdict: 'SHIP' } }),
    expected: 'FAILED',
  },
];

describe('MCP run status surfaces share a fail-closed verdict projection', () => {
  it.each(verdictProjectionCases)('$name', async ({ row, expected, expectedPhase }) => {
    const [toolStatus, resourceStatus] = await Promise.all([
      getStatus(row),
      getResourceStatus(row),
    ]);

    expect(toolStatus.verdict).toBe(expected);
    expect(resourceStatus.verdict).toBe(expected);
    expect(toolStatus.verdict).toBe(resourceStatus.verdict);
    expect(toolStatus.phase).toBe(resourceStatus.phase);
    if (expectedPhase) {
      expect(toolStatus.phase).toBe(expectedPhase);
      expect(resourceStatus.phase).toBe(expectedPhase);
    }
  });
});

describe('MCP status validation uses the native policy vocabulary', () => {
  const candidate = { repositoryId: 123, prNumber: 42, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyDigest: 'c'.repeat(64) };
  const current = { ...candidate, open: true, draft: false };
  const clean: ReviewGateEvidence = {
    verdict: 'SHIP', completedAt: '2026-09-29T12:00:00Z', coverageComplete: true,
    quorumSatisfied: true, infrastructureFailure: false, p0Count: 0, p1Count: 0,
    expectedLanes: 4, completedLanes: 4,
  };
  const acceptance: ReviewRiskAcceptance = {
    label: 'review-yeti/accepted-risk', labelPresent: true, eventId: 99,
    actorLogin: 'reviewer', actorType: 'User', actorPermission: 'write', appliedAt: '2026-09-29T12:01:00Z',
  };
  const fixtures = [
    { name: 'pending', input: { candidate, current } },
    { name: 'superseded', input: { candidate, current: { ...current, headSha: 'd'.repeat(40) }, evidence: clean } },
    { name: 'closed', input: { candidate, current: { ...current, open: false }, evidence: clean } },
    { name: 'invalid evidence', input: { candidate, current, evidence: { ...clean, completedAt: 'invalid' } } },
    { name: 'infrastructure failure', input: { candidate, current, evidence: { ...clean, infrastructureFailure: true } } },
    { name: 'incomplete review', input: { candidate, current, evidence: { ...clean, coverageComplete: false } } },
    { name: 'blocking findings', input: { candidate, current, evidence: { ...clean, verdict: 'FIX_FIRST' as const, p1Count: 1 } } },
    { name: 'clean review', input: { candidate, current, evidence: clean } },
    { name: 'exemption', input: { candidate, current, evidence: { ...clean, expectedLanes: 0, completedLanes: 0,
      exemption: { kind: 'recap-only' as const, auditDigest: 'd'.repeat(64) } } } },
    { name: 'accepted risk', input: { candidate, current, evidence: { ...clean, verdict: 'FIX_FIRST' as const, p1Count: 1 }, acceptance } },
  ];

  it.each(fixtures)('matches the actual evaluator decision for $name', async ({ input }) => {
    const decision = evaluateReviewGate(input);
    expect(reviewGateStatusForReason(decision.reason)).toBe(decision.status);
    const expected = decision.status === 'success' ? 'SHIP' : decision.status === 'pending' ? 'PENDING' : 'FAILED';
    for (const value of [decision, JSON.stringify(decision)]) {
      const row = baseRow({ desired_state: decision.status === 'pending' ? 'queued' : decision.status, decision: value });
      const [tool, resource] = await Promise.all([getStatus(row), getResourceStatus(row)]);
      expect(tool.verdict).toBe(expected);
      expect(resource.verdict).toBe(expected);
    }
  });

  it('recognizes every unique canonical reason without a projection-owned mirror', () => {
    expect(new Set(REVIEW_GATE_REASONS).size).toBe(REVIEW_GATE_REASONS.length);
    for (const reason of REVIEW_GATE_REASONS) expect(reviewGateStatusForReason(reason)).toBeDefined();
  });

  it.each(REVIEW_GATE_CANCELLATION_REASONS)('preserves lifecycle cancellation %s', (reason) => {
    expect(reviewGateStatusForReason(reason)).toBe('cancelled');
  });

  it('preserves the lifecycle deadline status', () => {
    expect(reviewGateStatusForReason('review-deadline-exceeded')).toBe('timed_out');
  });

  it.each(['future-reason', ' clean-review', 'CLEAN-REVIEW', '__proto__', 'constructor', 'toString', null, undefined, 0, false, {}])(
    'does not coerce or normalize unknown reason %j', (reason) => {
      expect(reviewGateStatusForReason(reason)).toBeUndefined();
    },
  );
});
