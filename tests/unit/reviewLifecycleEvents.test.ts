import { describe, expect, it, vi } from 'vitest';
import { PostgresReviewCiRepository } from '../../src/persistence/reviewCiRepository';
import { PostgresReviewCompletionRepository } from '../../src/persistence/reviewCompletionRepository';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
import {
  REVIEW_EVENT_SCHEMA_SQL,
  ReviewLifecycleBatchLockUnavailableError,
  appendLifecycleEventsForRuns,
} from '../../src/persistence/reviewEventRepository';

const constructors = [
  ['CI', (pool: unknown, options?: unknown) => new (PostgresReviewCiRepository as any)(pool, options)],
  ['completion', (pool: unknown, options?: unknown) => new (PostgresReviewCompletionRepository as any)(pool, options)],
  ['dispatch', (pool: unknown, options?: unknown) => new (PostgresReviewDispatchRepository as any)(pool, undefined, options)],
  ['gate', (pool: unknown, options?: unknown) => new (PostgresReviewGateRepository as any)(pool, options)],
] as const;

describe('explicit lifecycle event mode', () => {
  it.each(constructors)('fails closed when the %s repository omits its mode', (_name, create) => {
    expect(() => create({ connect: vi.fn() })).toThrow(/explicit lifecycle event mode/i);
  });

  it.each(constructors)('rejects an invalid mode for the %s repository', (_name, create) => {
    expect(() => create({ connect: vi.fn() }, { lifecycleEvents: 'sometimes' })).toThrow(/explicit lifecycle event mode/i);
  });

  it.each(constructors)('accepts an explicit mode without relying on a pool end decorator for the %s repository', (_name, create) => {
    expect(() => create({ connect: vi.fn() }, { lifecycleEvents: 'enabled' })).not.toThrow();
    expect(() => create({ connect: vi.fn() }, { lifecycleEvents: 'disabled' })).not.toThrow();
  });

  it('requires a real connection pool when completion lifecycle events are enabled', () => {
    expect(() => new PostgresReviewCompletionRepository(
      { query: vi.fn() } as any,
      { lifecycleEvents: 'enabled' },
    )).toThrow(/connection pool/i);
  });

  it('rejects more than 256 lifecycle intents before querying or scanning run state', async () => {
    const query = vi.fn(async () => {
      throw new Error('database query must not run for an oversized batch');
    });
    const inputs = Array.from({ length: 257 }, (_, index) => ({
      runId: `run_batch_limit_${index}`,
      eventKind: 'review.lifecycle.queued',
      orderingKey: String(index).padStart(3, '0'),
    }));

    await expect(appendLifecycleEventsForRuns({ query }, inputs)).rejects.toThrow(/batch.*maximum.*256/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('converts only PostgreSQL lock_not_available during batch reference acquisition', async () => {
    const lockUnavailable = Object.assign(new Error('could not obtain lock on row'), { code: '55P03' });
    const query = vi.fn().mockRejectedValue(lockUnavailable);

    await expect(appendLifecycleEventsForRuns({ query }, [{
      runId: 'run_reference_lock_unavailable',
      eventKind: 'review.lifecycle.queued',
    }])).rejects.toBeInstanceOf(ReviewLifecycleBatchLockUnavailableError);
  });

  it('does not convert unrelated PostgreSQL batch failures into retry signals', async () => {
    const databaseFailure = Object.assign(new Error('database unavailable'), { code: '57P01' });
    const query = vi.fn().mockRejectedValue(databaseFailure);

    await expect(appendLifecycleEventsForRuns({ query }, [{
      runId: 'run_reference_database_failure',
      eventKind: 'review.lifecycle.queued',
    }])).rejects.toBe(databaseFailure);
  });

  it('keeps lifecycle migration defaults, constraints, and uniqueness in the exported schema contract', () => {
    const schema = REVIEW_EVENT_SCHEMA_SQL.replace(/\s+/gu, ' ');

    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS review_event_sequence_counters/u);
    expect(schema).toMatch(/next_sequence BIGINT NOT NULL DEFAULT 0 CHECK \(next_sequence >= 0\)/u);
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS review_event_outbox/u);
    expect(schema).toMatch(/state TEXT NOT NULL DEFAULT 'pending'/u);
    expect(schema).toMatch(/attempt_count INTEGER NOT NULL DEFAULT 0 CHECK \(attempt_count >= 0\)/u);
    expect(schema).toMatch(/CHECK \(schema = 'review-yeti-event\.v1'\)/u);
    expect(schema).toMatch(/CHECK \(event_kind LIKE 'review\.lifecycle\.%'\)/u);
    expect(schema).toMatch(/CHECK \(visibility = 'internal'\)/u);
    expect(schema).toMatch(/UNIQUE \(run_id, sequence\)/u);
  });
});
