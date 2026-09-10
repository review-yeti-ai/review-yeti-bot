import { describe, expect, it, vi } from 'vitest';
import { PostgresMergeGroupGateRepository } from '../../src/persistence/mergeGroupGateRepository';

const HEAD = 'a'.repeat(40);

describe('Postgres merge-group gate repository', () => {
  it('serializes, persists, and commits one final gate result', async () => {
    const query = vi.fn(async (text: string) => ({ rows: text.includes('SELECT check_id') ? [] : [] }));
    const release = vi.fn();
    const repository = new PostgresMergeGroupGateRepository({ connect: vi.fn(async () => ({ query, release })) });
    const operation = vi.fn(async () => ({ checkId: 91, conclusion: 'success' as const, constituents: 2 }));
    await expect(repository.runExclusive(614653796, HEAD, operation)).resolves.toEqual({
      checkId: 91, conclusion: 'success', constituents: 2,
    });
    expect(operation).toHaveBeenCalledWith(undefined);
    expect(query.mock.calls.map(([text]) => text)).toEqual(expect.arrayContaining([
      'BEGIN', "SET LOCAL lock_timeout = '5s'", expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('SELECT check_id'), expect.stringContaining('INSERT INTO merge_group_gates'), 'COMMIT',
    ]));
    expect(release).toHaveBeenCalledOnce();
  });

  it('returns the stored terminal result through the operation and rolls back invalid results', async () => {
    const query = vi.fn(async (text: string) => ({ rows: text.includes('SELECT check_id')
      ? [{ check_id: 77, conclusion: 'failure' }] : [] }));
    const release = vi.fn();
    const repository = new PostgresMergeGroupGateRepository({ connect: vi.fn(async () => ({ query, release })) });
    const operation = vi.fn(async (stored) => ({ ...stored!, checkId: 0 }));
    await expect(repository.runExclusive(614653796, HEAD, operation)).rejects.toThrow('Merge-group gate result is invalid');
    expect(operation).toHaveBeenCalledWith({ checkId: 77, conclusion: 'failure' });
    expect(query.mock.calls.map(([text]) => text)).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
