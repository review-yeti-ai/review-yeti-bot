import { describe, expect, it, vi } from 'vitest';
import { PostgresReviewCiRepository } from '../../src/persistence/reviewCiRepository';
import { PostgresReviewCompletionRepository } from '../../src/persistence/reviewCompletionRepository';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
import { REVIEW_EVENT_SCHEMA_SQL } from '../../src/persistence/reviewEventRepository';

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
