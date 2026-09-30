import { describe, expect, it, vi } from 'vitest';
import {
  createGetReviewStatusTool,
  buildReviewTiming,
  type ReviewStatusDbClient,
} from '../../src/mcp/server/tools/getReviewStatus';

/**
 * get_review_status timing surface.
 *
 * Two independent contracts are pinned here:
 *
 * 1. COMPLETENESS -- every query branch selects the review_runs-native timing
 *    columns. There are FOUR branches (head_sha, non-head_sha, and the two
 *    fallbacks used when review_gate_attempts is absent). A column added to one
 *    branch and forgotten in another is the realistic defect, so each branch is
 *    driven for real and its SQL asserted.
 *
 * 2. HONESTY -- a run that has not terminated reports NULL, never a count-up to
 *    "now" and never a partial span republished as final. This is the defect
 *    that shipped in a sibling change (a span of 595s reported while two checks
 *    were still running).
 *
 * The masking trap this file deliberately avoids: `created_at == received_at`
 * for ~97% of live rows, so a test that only checks a *derived* number can pass
 * even when `received_at` was dropped from a branch (a created_at fallback
 * covers it). The branch assertions therefore check the SQL text itself, and
 * give received_at and created_at deliberately DIFFERENT values so an
 * accidental substitution cannot hide.
 */

const TIMING_COLUMNS = [
  'received_at',
  'burst_started_at',
  'cancel_requested_at',
  'cancel_propagated_at',
  'terminal_deadline',
] as const;

/** Distinct instants: received_at and created_at must not be substitutable. */
const T0 = '2026-09-28T19:00:00.000Z'; // received_at
const T0B = '2026-09-28T19:00:30.000Z'; // created_at  (deliberately different)
const T1 = '2026-09-28T19:00:12.000Z'; // dispatched
const T2 = '2026-09-28T19:00:20.000Z'; // started
const T3 = '2026-09-28T19:02:50.000Z'; // terminal
const DEADLINE = '2026-09-28T19:20:00.000Z';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: 'run_timing_1',
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    pr_number: 42,
    head_sha: 'a'.repeat(40),
    run_status: 'running',
    run_stage: 'review',
    attempt: 1,
    lease_owner: 'review-worker-pr-42-pod',
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: T0B,
    updated_at: T1,
    attempt_id: 'attempt-42-1',
    check_id: '998877',
    desired_state: 'in_progress',
    decision: null,
    received_at: T0,
    burst_started_at: T0,
    cancel_requested_at: null,
    cancel_propagated_at: null,
    terminal_deadline: DEADLINE,
    ...overrides,
  };
}

interface Captured {
  statements: string[];
  markerQueries: number;
  markerParameters: unknown[][];
}

/**
 * Mock DB that records every statement. `markers` are returned for the
 * lifecycle-marker read; the main run query returns `row`.
 * `failGateJoin` drives the two fallback branches by rejecting the first query.
 */
function makeDb(
  row: Record<string, unknown>,
  markers: Record<string, string> = {},
  options: { failGateJoin?: boolean } = {},
): { db: ReviewStatusDbClient; captured: Captured } {
  const captured: Captured = { statements: [], markerQueries: 0, markerParameters: [] };
  let mainQueries = 0;
  const db: ReviewStatusDbClient = {
    async query(sql: string, parameters?: unknown[]) {
      captured.statements.push(sql);
      if (sql.includes('review_event_outbox')) {
        captured.markerQueries += 1;
        captured.markerParameters.push(parameters ?? []);
        return {
          rows: Object.entries(markers).map(([event_kind, occurred_at]) => ({
            event_kind,
            occurred_at,
          })),
        };
      }
      mainQueries += 1;
      if (options.failGateJoin && mainQueries === 1) {
        throw new Error('relation "review_gate_attempts" does not exist');
      }
      // The schema fallback cannot select an identity from an absent gate table.
      return { rows: [options.failGateJoin ? { ...row, attempt_id: undefined } : row] };
    },
  };
  return { db, captured };
}

async function runTimingCase(
  row: Record<string, unknown>,
  markers: Record<string, string> = {},
  options: { headSha?: string; failGateJoin?: boolean } = {},
) {
  const { db, captured } = makeDb(row, markers, options);
  const tool = createGetReviewStatusTool(db);
  const result = await tool.execute({
    owner: 'review-yeti-ai',
    repo: 'review-yeti-bot',
    pull_number: 42,
    ...(options.headSha ? { head_sha: options.headSha } : {}),
  });
  const data = JSON.parse((result.content[0] as any).text);
  return { data, captured };
}

/** Every statement the tool issues against review_runs (excludes the marker read). */
function mainStatements(captured: Captured): string[] {
  const statements = captured.statements.filter((s) => !s.includes('review_event_outbox'));
  if (statements.length === 0) throw new Error('no main review_runs query was issued');
  return statements;
}

describe('get_review_status timing: every query branch selects the timing columns', () => {
  // Four branches, driven for real. Each must carry every timing column.
  const branches: Array<{ name: string; headSha?: string; failGateJoin?: boolean }> = [
    { name: 'head_sha branch', headSha: 'a'.repeat(40) },
    { name: 'non-head_sha branch' },
    { name: 'fallback head_sha branch (no review_gate_attempts)', headSha: 'a'.repeat(40), failGateJoin: true },
    { name: 'fallback non-head_sha branch (no review_gate_attempts)', failGateJoin: true },
  ];

  it.each(branches)('$name selects every timing column', async (branch) => {
    const { captured } = await runTimingCase(baseRow(), {}, branch);

    // Assert EVERY statement, not just the first: a fallback branch issues the
    // gate-join query (which fails) and then its own. Checking only one of them
    // is how a missing column in the other slips through.
    for (const sql of mainStatements(captured)) {
      for (const column of TIMING_COLUMNS) {
        expect(sql, `${branch.name} must select r.${column}`).toContain(`r.${column}`);
      }
      if (branch.failGateJoin && !sql.includes('review_gate_attempts')) {
        expect(sql).toMatch(/r\.artifacts\s*,\s*r\.received_at/u);
      }
    }
  });

  it('drives each branch exactly once and reads the lifecycle ledger', async () => {
    // Guards the harness itself: if a branch silently stopped being reachable,
    // the assertions above would pass without proving anything.
    for (const branch of branches) {
      const { captured } = await runTimingCase(baseRow(), {}, branch);
      expect(captured.markerQueries, branch.name).toBe(1);
      // Fallbacks issue a gate-join query before falling back to their own.
      const expected = branch.failGateJoin ? 2 : 1;
      expect(captured.statements.length, branch.name).toBe(expected + 1);
      const markerSql = captured.statements.find((sql) => sql.includes('review_event_outbox'));
      expect(markerSql).toContain("payload->>'attempt_id' = $3");
      expect(captured.markerParameters[0]).toEqual([
        'run_timing_1',
        ['review.lifecycle.dispatched', 'review.lifecycle.started', 'review.lifecycle.terminal'],
        branch.failGateJoin ? null : 'attempt-42-1', T0,
      ]);
    }
  });
});

describe('get_review_status timing: retries cannot inherit earlier execution markers', () => {
  it('binds the current attempt when the run id is reused', async () => {
    const events = [
      { attempt_id: 'attempt-42-1', event_kind: 'review.lifecycle.started', occurred_at: '2026-09-28T18:00:00.000Z' },
      { attempt_id: 'attempt-42-1', event_kind: 'review.lifecycle.terminal', occurred_at: '2026-09-28T18:30:00.000Z' },
      { attempt_id: 'attempt-42-2', event_kind: 'review.lifecycle.started', occurred_at: T2 },
      { attempt_id: 'attempt-42-2', event_kind: 'review.lifecycle.terminal', occurred_at: T3 },
    ];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (!sql.includes('review_event_outbox')) return { rows: [baseRow({ attempt_id: 'attempt-42-2', run_status: 'failed' })] };
      // Emulate the ledger predicate: the old run-only query sees both attempts.
      const scoped = sql.includes("payload->>'attempt_id'") ? events.filter(e => e.attempt_id === values?.[2]) : events;
      const first = new Map<string, typeof events[number]>();
      for (const event of scoped) if (!first.has(event.event_kind)) first.set(event.event_kind, event);
      return { rows: [...first.values()] };
    });
    const result = await createGetReviewStatusTool({ query }).execute({ owner: 'review-yeti-ai', repo: 'review-yeti-bot', pull_number: 42 });
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.attempt_id).toBe('attempt-42-2');
    expect(data.timing.started_at).toBe(T2);
    expect(data.timing.completed_at).toBe(T3);
    expect(data.timing.queue_seconds).toBe(20);
    expect(data.timing.execution_seconds).toBe(150);
    expect(query.mock.calls[1][1]?.[2]).toBe('attempt-42-2');
  });

  it('derives legacy timing only from unkeyed events after receipt', async () => {
    const events = [
      { attempt_id: null, event_kind: 'review.lifecycle.started', occurred_at: '2026-09-28T18:00:00.000Z' },
      { attempt_id: 'other-attempt', event_kind: 'review.lifecycle.started', occurred_at: T1 },
      { attempt_id: null, event_kind: 'review.lifecycle.started', occurred_at: T2 },
      { attempt_id: null, event_kind: 'review.lifecycle.terminal', occurred_at: T3 },
    ];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (!sql.includes('review_event_outbox')) return { rows: [baseRow({ attempt_id: null, run_status: 'failed' })] };
      const scoped = events.filter(e => e.attempt_id === null && e.occurred_at >= String(values?.[3]));
      return { rows: scoped };
    });
    const result = await createGetReviewStatusTool({ query }).execute({ owner: 'review-yeti-ai', repo: 'review-yeti-bot', pull_number: 42 });
    const data = JSON.parse((result.content[0] as any).text);
    expect(data.timing.started_at).toBe(T2);
    expect(data.timing.completed_at).toBe(T3);
    expect(data.timing.execution_seconds).toBe(150);
    const markerCall = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(markerCall[1].slice(2)).toEqual([null, T0]);
  });
});

describe('get_review_status timing: an unfinished run never reports a duration', () => {
  it('reports null execution_seconds and null completed_at while still running', async () => {
    // dispatched + started exist, the run has NOT terminated. A partial span
    // must not be published as a final duration.
    const { data } = await runTimingCase(baseRow({ run_status: 'running' }), {
      'review.lifecycle.dispatched': T1,
      'review.lifecycle.started': T2,
    });

    expect(data.timing.execution_seconds).toBeNull();
    expect(data.timing.completed_at).toBeNull();
  });

  it('does NOT count up to "now" for a long-running review', async () => {
    // A review that started long ago and is still running is the exact shape
    // that produced a bogus 595s span. Any number here would be a measurement
    // the system never took.
    const longAgo = new Date(Date.now() - 3_600_000).toISOString();
    const { data } = await runTimingCase(baseRow({ run_status: 'running', updated_at: longAgo }), {
      'review.lifecycle.started': longAgo,
    });

    expect(data.timing.execution_seconds).toBeNull();
    expect(data.timing.started_at).toBe(longAgo);
  });

  it('reports null execution_seconds when no start marker exists at all', async () => {
    const { data } = await runTimingCase(baseRow({ run_status: 'succeeded' }), {});

    // Terminal, but execution start was never durably recorded.
    expect(data.timing.started_at).toBeNull();
    expect(data.timing.execution_seconds).toBeNull();
  });

  it('treats an unrecognised status as not terminal (conservative)', async () => {
    const { data } = await runTimingCase(baseRow({ run_status: 'some_future_state' }), {
      'review.lifecycle.started': T2,
    });

    expect(data.timing.execution_seconds).toBeNull();
    expect(data.timing.completed_at).toBeNull();
  });

  it('still reports a queue wait once the run is merely claimed', async () => {
    // queue_seconds is known the moment a worker claims the run -- it must not
    // be withheld just because the run has not finished.
    const { data } = await runTimingCase(baseRow({ run_status: 'running' }), {
      'review.lifecycle.started': T2,
    });

    expect(data.timing.queue_seconds).toBeCloseTo(20, 5);
    expect(data.timing.execution_seconds).toBeNull();
  });
});

describe('get_review_status timing: a terminal run reports both spans', () => {
  it('treats legacy completed as terminal without changing the fail-closed gate verdict', async () => {
    const { data } = await runTimingCase(baseRow({
      run_status: 'completed',
      run_stage: 'continuation_completed',
      updated_at: T3,
      desired_state: 'failure',
      decision: { verdict: 'SHIP' },
    }), {
      'review.lifecycle.started': T2,
    });

    expect(data.verdict).toBe('FAILED');
    expect(data.timing.completed_at).toBe(T3);
    expect(data.timing.execution_seconds).toBeCloseTo(150, 5);
  });

  it('derives execution_seconds only when both ends are durable', async () => {
    const { data } = await runTimingCase(baseRow({ run_status: 'succeeded' }), {
      'review.lifecycle.dispatched': T1,
      'review.lifecycle.started': T2,
      'review.lifecycle.terminal': T3,
    });

    expect(data.timing.started_at).toBe(T2);
    expect(data.timing.completed_at).toBe(T3);
    expect(data.timing.execution_seconds).toBeCloseTo(150, 5);
  });

  it('uses created_at only as a queue-wait fallback, never as a substitute for received_at', () => {
    const timing = buildReviewTiming(
      { received_at: null, created_at: T0B, updated_at: T1 },
      new Map([['review.lifecycle.started', T2]]),
      'running',
    );

    // received_at absence is reported honestly rather than back-filled.
    expect(timing.received_at).toBeNull();
    expect(timing.created_at).toBe(T0B);
    // 19:00:30 -> 19:00:20 is negative, so no duration is claimed.
    expect(timing.queue_seconds).toBeNull();
  });

  it('refuses to report a negative span', () => {
    const timing = buildReviewTiming(
      { received_at: T0, created_at: T0B, updated_at: T1 },
      new Map([
        ['review.lifecycle.started', T3],
        ['review.lifecycle.terminal', T2],
      ]),
      'succeeded',
    );

    expect(timing.execution_seconds).toBeNull();
  });

  it('degrades to null durations when the ledger is unreadable, still returning status', async () => {
    const db: ReviewStatusDbClient = {
      async query(sql: string) {
        if (sql.includes('review_event_outbox')) throw new Error('relation does not exist');
        return { rows: [baseRow({ run_status: 'succeeded', desired_state: 'success' })] };
      },
    };
    const tool = createGetReviewStatusTool(db);
    const result = await tool.execute({ owner: 'review-yeti-ai', repo: 'review-yeti-bot', pull_number: 42 });
    const data = JSON.parse((result.content[0] as any).text);

    expect(data.found).toBe(true);
    expect(data.verdict).toBe('SHIP');
    expect(data.timing.execution_seconds).toBeNull();
    expect(data.timing.queue_seconds).toBeNull();
  });
});

describe('get_review_status timing: backward compatibility', () => {
  it('leaves every pre-existing field intact and adds timing additively', async () => {
    const { data } = await runTimingCase(baseRow({ run_status: 'running' }), {
      'review.lifecycle.started': T2,
    });

    // Fields existing consumers already read.
    expect(data.found).toBe(true);
    expect(data.verdict).toBe('RUNNING');
    expect(data.attempt_id).toBe('attempt-42-1');
    expect(data.head_sha).toBe('a'.repeat(40));
    expect(data.phase).toBe('evaluating_personas');
    expect(data.check_run.id).toBe(998877);
    expect(data.active_worker.pod_name).toBe('review-worker-pr-42-pod');

    // Purely additive.
    expect(data.timing).toBeDefined();
    expect(typeof data.timing).toBe('object');
  });

  it('omits timing when no run was found', async () => {
    const db: ReviewStatusDbClient = { async query() { return { rows: [] }; } };
    const tool = createGetReviewStatusTool(db);
    const result = await tool.execute({ owner: 'review-yeti-ai', repo: 'review-yeti-bot', pull_number: 9999 });
    const data = JSON.parse((result.content[0] as any).text);

    expect(data.found).toBe(false);
    expect(data.timing).toBeUndefined();
  });
});
