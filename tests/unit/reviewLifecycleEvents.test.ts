import { describe, expect, it, vi } from 'vitest';
import { PostgresReviewCiRepository } from '../../src/persistence/reviewCiRepository';
import { PostgresReviewCompletionRepository } from '../../src/persistence/reviewCompletionRepository';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';

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
});
