import { describe, expect, it, vi } from 'vitest';
import { PostgresMergeGroupGateRepository } from '../../src/persistence/mergeGroupGateRepository';

const HEAD = 'a'.repeat(40);
const CLAIM = '12345678-1234-4123-8123-123456789abc';

function pool(rowsFor: (text: string) => any[] = () => []) {
  const query = vi.fn(async (text: string) => ({ rows: rowsFor(text) }));
  const release = vi.fn();
  return { query, release, value: { connect: vi.fn(async () => ({ query, release })) } };
}

describe('Postgres merge-group gate repository', () => {
  it('claims work in a short committed transaction and releases the connection', async () => {
    const fixture = pool();
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.claim(614653796, HEAD, CLAIM)).resolves.toEqual({ status: 'acquired' });
    expect(fixture.query.mock.calls.map(([text]) => text)).toEqual(expect.arrayContaining([
      'BEGIN', "SET LOCAL lock_timeout = '5s'", expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('SELECT check_id'), expect.stringContaining('INSERT INTO merge_group_gates'), 'COMMIT',
    ]));
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it.each([
    [{ check_id: 77, conclusion: 'failure', lease_active: false },
      { status: 'terminal', result: { checkId: 77, conclusion: 'failure' } }],
    [{ check_id: null, conclusion: null, lease_active: true }, { status: 'busy' }],
  ])('returns an existing terminal or active lease without replacing it', async (row, expected) => {
    const fixture = pool((text) => text.includes('SELECT check_id') ? [row] : []);
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.claim(614653796, HEAD, CLAIM)).resolves.toEqual(expected);
    expect(fixture.query.mock.calls.some(([text]) => text.includes('INSERT INTO merge_group_gates'))).toBe(false);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it('persists a terminal result under the owned claim in a separate short transaction', async () => {
    const fixture = pool((text) => text.includes('RETURNING check_id') ? [{ check_id: 91 }] : []);
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.complete(614653796, HEAD, CLAIM,
      { checkId: 91, conclusion: 'success' })).resolves.toBeUndefined();
    expect(fixture.query.mock.calls.map(([text]) => text)).toEqual(expect.arrayContaining([
      'BEGIN', expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('UPDATE merge_group_gates'), 'COMMIT',
    ]));
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it('rolls back completion when the lease is no longer owned', async () => {
    const fixture = pool();
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.complete(614653796, HEAD, CLAIM,
      { checkId: 91, conclusion: 'success' })).rejects.toThrow('claim is no longer owned');
    expect(fixture.query.mock.calls.map(([text]) => text)).toContain('ROLLBACK');
  });

  it('releases only its own unfinished lease after an external failure', async () => {
    const fixture = pool();
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await repository.release(614653796, HEAD, CLAIM);
    expect(fixture.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM merge_group_gates'),
      [614653796, HEAD, CLAIM]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
