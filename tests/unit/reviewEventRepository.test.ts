import { describe, expect, it, vi } from 'vitest';
import {
  appendLifecycleEvent,
  appendLifecycleEventForRun,
  lifecycleEventsEnabledFromEnv,
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
      query: vi.fn(async (sql: string, _values?: unknown[]) => {
        if (/pg_advisory_xact_lock/iu.test(sql)) return { rows: [] };
        if (/SELECT .*review_event_outbox.*event_id/isu.test(sql)) return { rows: [] };
        if (/review_event_sequence_counters/iu.test(sql)) return { rows: [{ next_sequence: '1' }] };
        if (/INSERT INTO review_event_outbox/iu.test(sql)) return { rows: [persisted] };
        throw new Error(`unexpected SQL: ${sql}`);
      }),
    };

    const record = await appendLifecycleEvent(client, lifecycleEvent());

    expect(record.event.sequence).toBe(1);
    const calls = client.query.mock.calls;
    expect(calls.map(([sql]) => String(sql))).not.toContain('BEGIN');
    expect(calls.map(([sql]) => String(sql))).not.toContain('COMMIT');
    const counterIndex = calls.findIndex(([sql]) => /review_event_sequence_counters/iu.test(String(sql)));
    const insertIndex = calls.findIndex(([sql]) => /INSERT INTO review_event_outbox/iu.test(String(sql)));
    expect(counterIndex).toBeGreaterThan(0);
    expect(insertIndex).toBe(counterIndex + 1);
    expect(calls[counterIndex][1]).toEqual([lifecycleEvent().run_id, Date.parse(lifecycleEvent().occurred_at)]);
    expect(calls[insertIndex][1]).toEqual(expect.arrayContaining([eventId, lifecycleEvent().run_id, 1]));
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

  it('fails closed when the authoritative run metadata is incomplete', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (/FROM review_runs/iu.test(sql)) {
        return { rows: [{
          run_id: lifecycleEvent().run_id,
          repository_id: null,
          pr_number: 42,
          base_sha: 'a'.repeat(40),
          head_sha: 'b'.repeat(40),
          attempt: 0,
          effective_policy_digest: 'c'.repeat(64),
        }] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) };

    await expect(appendLifecycleEventForRun(client, {
      runId: lifecycleEvent().run_id,
      eventKind: 'review.lifecycle.queued',
    })).rejects.toThrow(/metadata/i);
    expect(client.query.mock.calls.some(([sql]) => /review_event_sequence_counters/iu.test(String(sql)))).toBe(false);
  });
});

describe('lifecycle outbox write gate', () => {
  // The outbox is the source half of the event plane. Its consumer
  // (reviewEventPublisherIndex.js) is not deployed and ct-review-nats is
  // suspended, so appended rows are never read, published, or acknowledged —
  // measured live at 35,981 rows, all state='pending'. The enable flag existed
  // for this purpose and the construction sites bypassed it by hardcoding
  // 'enabled', which is what produced unowned growth.
  it('defaults to disabled when the flag is absent', () => {
    expect(lifecycleEventsEnabledFromEnv({})).toBe(false);
  });

  it('defaults to disabled when the flag is blank', () => {
    expect(lifecycleEventsEnabledFromEnv({ CT_REVIEW_EVENTS_ENABLED: '   ' })).toBe(false);
  });

  it('enables only on the exact string "true"', () => {
    expect(lifecycleEventsEnabledFromEnv({ CT_REVIEW_EVENTS_ENABLED: 'true' })).toBe(true);
    expect(lifecycleEventsEnabledFromEnv({ CT_REVIEW_EVENTS_ENABLED: 'false' })).toBe(false);
  });

  it('refuses a malformed value instead of guessing', () => {
    // A typo must not silently start or stop the plane. Anything other than
    // true/false is an error, matching natsConfig's own parser.
    for (const bad of ['TRUE', '1', 'yes', 'on']) {
      expect(() => lifecycleEventsEnabledFromEnv({ CT_REVIEW_EVENTS_ENABLED: bad })).toThrow(
        /must be true or false/,
      );
    }
  });

  it('is wired at every production write site', () => {
    // Guards the actual defect: a hardcoded 'enabled' at any of these sites
    // re-opens unbounded growth regardless of the flag. app.ts is excluded
    // because nothing runs it in production.
    const fs = require('node:fs');
    const path = require('node:path');
    for (const file of [
      'src/dispatchIndex.ts',
      'src/reviewCiRuntime.ts',
      'src/reviewJobDispatcherIndex.ts',
    ]) {
      const text = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
      expect(text).not.toContain("lifecycleEvents: 'enabled'");
      expect(text).toContain('lifecycleEventsEnabledFromEnv()');
    }
  });
});
