import { describe, expect, it } from 'vitest';
import {
  createGetReviewStatusTool,
  type ReviewStatusDbClient,
} from '../../src/mcp/server/tools/getReviewStatus';
import { fetchRunResource } from '../../src/mcp/server/resources/runResource';
import type { ResourceDbClient } from '../../src/mcp/server/resources/resourceTypes';

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
