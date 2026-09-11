import { describe, expect, it, vi } from 'vitest';
import {
  REVIEW_EVENT_SCHEMA_SQL,
  appendLifecycleEvent,
  type ReviewLifecycleEventInput,
} from '../../src/persistence/reviewEventRepository';

const eventId = '01J8Z5M6V7Q8R9S0T1V2W3X4Y5';

function lifecycleEvent(overrides: Partial<ReviewLifecycleEventInput> = {}): ReviewLifecycleEventInput {
  return {
    schema: 'review-yeti-event.v1',
    event_id: eventId,
    event_kind: 'review.lifecycle.queued',
    occurred_at: '2026-09-11T12:00:00.000Z',
    repository_id: 123,
    pr_number: 42,
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    attempt_id: 'run_00000000000000000000000000000000-g0-e1',
    run_id: 'run_00000000000000000000000000000000',
    sequence: 999,
    correlation_id: 'delivery-42',
    trace_id: 'trace-42',
    visibility: 'internal',
    data: { stage: 'queued' },
    ...overrides,
  };
}

describe('Postgres review lifecycle event persistence', () => {
  it('declares the idempotent outbox and atomic per-run sequence counter', () => {
    expect(REVIEW_EVENT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS review_event_outbox');
    expect(REVIEW_EVENT_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS review_event_sequence_counters');
    expect(REVIEW_EVENT_SCHEMA_SQL).toContain('UNIQUE (run_id, sequence)');
    expect(REVIEW_EVENT_SCHEMA_SQL).not.toMatch(/MAX\s*\(/iu);
  });

  it('appends a closed lifecycle event on the caller client without owning its transaction', async () => {
    const persisted = {
      event_id: eventId,
      run_id: lifecycleEvent().run_id,
      sequence: 1,
      state: 'pending',
      attempt_count: 0,
      lease_owner: null,
      lease_expires_at: null,
      next_attempt_at: new Date('2026-09-11T12:00:00.000Z'),
      publish_acknowledged_at: null,
      publish_ack: null,
      created_at: new Date('2026-09-11T12:00:00.000Z'),
      updated_at: new Date('2026-09-11T12:00:00.000Z'),
      payload: { ...lifecycleEvent(), sequence: 1 },
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (/pg_advisory_xact_lock/iu.test(sql)) return { rows: [] };
        if (/SELECT .*review_event_outbox.*event_id/isu.test(sql)) return { rows: [] };
        if (/review_event_sequence_counters/iu.test(sql)) return { rows: [{ next_sequence: '1' }] };
        if (/INSERT INTO review_event_outbox/iu.test(sql)) return { rows: [persisted] };
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };

    const record = await appendLifecycleEvent(client, lifecycleEvent());

    expect(record.event.sequence).toBe(1);
    expect(client.query.mock.calls.map(([sql]) => String(sql))).not.toContain('BEGIN');
    expect(client.query.mock.calls.map(([sql]) => String(sql))).not.toContain('COMMIT');
    const counterSql = client.query.mock.calls.find(([sql]) => /review_event_sequence_counters/iu.test(String(sql)))?.[0];
    expect(String(counterSql)).toContain('ON CONFLICT (run_id) DO UPDATE');
    expect(String(counterSql)).toContain('next_sequence = review_event_sequence_counters.next_sequence + 1');
  });

  it('replays the same event id without allocating a second sequence', async () => {
    const persisted = {
      event_id: eventId,
      run_id: lifecycleEvent().run_id,
      sequence: 4,
      state: 'pending',
      attempt_count: 0,
      lease_owner: null,
      lease_expires_at: null,
      next_attempt_at: new Date('2026-09-11T12:00:00.000Z'),
      publish_acknowledged_at: null,
      publish_ack: null,
      created_at: new Date('2026-09-11T12:00:00.000Z'),
      updated_at: new Date('2026-09-11T12:00:00.000Z'),
      payload: { ...lifecycleEvent(), sequence: 4 },
    };
    const client = { query: vi.fn(async (sql: string) => {
      if (/pg_advisory_xact_lock/iu.test(sql)) return { rows: [] };
      if (/SELECT .*review_event_outbox.*event_id/isu.test(sql)) return { rows: [persisted] };
      throw new Error(`unexpected SQL: ${sql}`);
    }) };

    const record = await appendLifecycleEvent(client, lifecycleEvent({ sequence: 999 }));

    expect(record.sequence).toBe(4);
    expect(client.query).toHaveBeenCalledTimes(2);
  });
});
