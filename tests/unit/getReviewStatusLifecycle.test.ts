import { describe, expect, it } from 'vitest';
import { createGetReviewStatusTool } from '../../src/mcp/server/tools/getReviewStatus';
import { fetchRunResource } from '../../src/mcp/server/resources/runResource';
import { projectReviewStatusPhase } from '../../src/mcp/server/reviewStatusVerdict';

const HEAD = 'a'.repeat(40);
const CREATED = '2026-09-30T12:00:00.000Z';
const STARTED = '2026-09-30T12:00:10.000Z';
const FINISHED = '2026-09-30T12:20:00.000Z';
const args = { owner: 'review-yeti-ai', repo: 'review-yeti-bot', pull_number: 42 };

function row(overrides: Record<string, unknown> = {}) {
  return { run_id: 'run_lifecycle', owner: args.owner, repo: args.repo, pr_number: 42,
    head_sha: HEAD, run_status: 'queued', run_stage: 'admission', desired_state: 'queued',
    decision: null, attempt: 1, attempt_id: 'run_lifecycle-g1-e1', current_attempt: true,
    check_id: 1234, lease_owner: null, lease_expires_at: null,
    received_at: CREATED, created_at: CREATED, updated_at: FINISHED, ...overrides };
}

async function toolStatus(value: Record<string, unknown>, head = HEAD) {
  const db = { async query(sql: string) {
    return { rows: sql.includes('review_event_outbox') ? [
      { event_kind: 'review.lifecycle.started', occurred_at: STARTED },
      { event_kind: 'review.lifecycle.terminal', occurred_at: FINISHED },
    ] : [value] };
  } };
  const result = await createGetReviewStatusTool(db).execute({ ...args, head_sha: head });
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe('native lifecycle phase projection', () => {
  it.each([
    ['queued', 'queued', 'admission', 'queued'],
    ['in_progress', 'queued', 'admission', 'running'],
    ['in_progress', 'running', 'evaluate', 'evaluating_personas'],
    ['in_progress', 'publishing', 'publish', 'arbitration'],
    ['queued', 'running', 'evaluate', 'evaluating_personas'],
    [null, 'queued', 'admission', 'queued'],
    [null, 'running', 'evaluate', 'evaluating_personas'],
    [null, 'publishing', 'arbitration', 'arbitration'],
    [null, 'future-status', 'admission', 'unknown'],
    ['future-state', 'queued', 'admission', 'unknown'],
    ['future-state', 'succeeded', 'complete', 'unknown'],
    ['in_progress', 'failed', 'complete', 'unknown'],
    ['queued', 'failed', 'complete', 'unknown'],
    [null, null, null, 'unknown'],
  ])('projects gate=%s run=%s stage=%s as %s', (desiredState, runStatus, runStage, expected) => {
    expect(projectReviewStatusPhase({ desiredState, runStatus, runStage })).toBe(expected);
  });

  it.each(['success', 'failure', 'cancelled', 'timed_out'])('terminal native gate %s wins over delayed run', (desiredState) => {
    expect(projectReviewStatusPhase({ desiredState, runStatus: 'queued', runStage: 'admission' })).toBe('completed');
  });

  it.each(['succeeded', 'complete', 'completed', 'failed', 'cancelled', 'superseded', 'terminal'])('legacy terminal run %s is completed without a gate', (runStatus) => {
    expect(projectReviewStatusPhase({ desiredState: null, runStatus, runStage: 'complete' })).toBe('completed');
  });

  it.each([0, false, {}, []])('invalid native gate %j remains unknown', (desiredState) => {
    expect(projectReviewStatusPhase({ desiredState, runStatus: 'running', runStage: 'evaluate' })).toBe('unknown');
  });
});

describe('status tool and resource lifecycle parity', () => {
  it('follows the same head through queue, projected running and completed without approving progress', async () => {
    for (const [desired_state, run_status, expectedPhase, expectedVerdict] of [
      ['queued', 'queued', 'queued', 'PENDING'],
      ['in_progress', 'queued', 'running', 'RUNNING'],
      ['success', 'succeeded', 'completed', 'SHIP'],
    ]) {
      const value = row({ desired_state, run_status });
      const tool = await toolStatus(value);
      const resource = await fetchRunResource(args.owner, args.repo, 42, { async query() { return { rows: [value] }; } });
      for (const status of [tool, resource]) {
        expect(status.phase).toBe(expectedPhase);
        expect(status.verdict).toBe(expectedVerdict);
        expect(status.head_sha).toBe(HEAD);
        expect(status.attempt_id).toBe(value.attempt_id);
        expect(status.check_run?.id).toBe(1234);
      }
    }
  });

  it('labels existing timing as control-plane lifecycle without changing durable timestamps or inventing worker time', async () => {
    const active = await toolStatus(row({ desired_state: 'in_progress' }));
    expect(active.timing.basis).toBe('control_plane_lifecycle');
    expect(active.timing.started_at).toBe(STARTED);
    expect(active.timing.completed_at).toBeNull();
    expect(active.timing.execution_seconds).toBeNull();
    expect(active.active_worker).toBeNull();
    const terminal = await toolStatus(row({ desired_state: 'success', run_status: 'succeeded' }));
    expect(terminal.timing.started_at).toBe(STARTED);
    expect(terminal.timing.completed_at).toBe(FINISHED);
    expect(terminal.timing.queue_seconds).toBe(10);
    expect(terminal.timing.execution_seconds).toBe(1190);
  });

  it.each([undefined, { async query() { return { rows: [] }; } }, { async query() { throw Error('untrusted database credential-shaped text'); } }])('unavailable/missing evidence remains unknown without rendering database errors', async (db) => {
    const result = await createGetReviewStatusTool(db).execute({ ...args, head_sha: HEAD });
    const tool = JSON.parse((result.content[0] as { text: string }).text);
    const resource = await fetchRunResource(args.owner, args.repo, 42, db);
    for (const status of [tool, resource]) {
      expect(status.found).toBe(false);
      expect(status.phase).toBe('unknown');
      expect(status.verdict).toBe('PENDING');
      expect(status.check_run).toBeNull();
      expect(status.attempt_id).toBeNull();
      expect(JSON.stringify(status)).not.toContain('credential-shaped');
    }
  });

  it('refuses a stale requested head and returns no old approval/check/timing', async () => {
    const status = await toolStatus(row({ desired_state: 'success', run_status: 'succeeded' }), 'b'.repeat(40));
    expect(status.found).toBe(false);
    expect(status.phase).toBe('unknown');
    expect(status.head_sha).toBe('b'.repeat(40));
    expect(status.check_run).toBeNull();
    expect(status.timing).toBeUndefined();
  });

  it.each([{ owner: 'foreign' }, { repo: 'foreign' }, { pr_number: 99 }, { head_sha: 'not-a-sha' }])('rejects foreign/malformed returned identity %j on both surfaces', async (identity) => {
    const value = row({ ...identity, artifacts: { unsafe: 'private provider payload' }, decision: { verdict: 'SHIP' } });
    const tool = await toolStatus(value);
    const resource = await fetchRunResource(args.owner, args.repo, 42, { async query() { return { rows: [value] }; } });
    for (const status of [tool, resource]) {
      expect(status.found).toBe(false);
      expect(status.phase).toBe('unknown');
      expect(status.verdict).toBe('PENDING');
      expect(status.check_run).toBeNull();
      expect(JSON.stringify(status)).not.toContain('provider payload');
    }
  });

  it('accepts the documented abbreviated head input only for a matching full stored identity', async () => {
    expect((await toolStatus(row(), HEAD.slice(0, 7))).head_sha).toBe(HEAD);
  });

  it('unknown lifecycle cannot become a completed review while its approval verdict remains fail closed', async () => {
    const status = await toolStatus(row({ desired_state: 'future-state', run_status: 'future-status', decision: { verdict: 'SHIP' } }));
    expect(status.phase).toBe('unknown');
    expect(status.verdict).toBe('FAILED');
  });
});
