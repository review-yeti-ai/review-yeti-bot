import { describe, expect, it, vi } from 'vitest';
import { PostgresMergeGroupGateRepository } from '../../src/persistence/mergeGroupGateRepository';

const HEAD = 'a'.repeat(40);
const SNAPSHOT = 'b'.repeat(64);
const PRIOR = 'c'.repeat(64);
const CLAIM = '12345678-1234-4123-8123-123456789abc';

function pool(rowsFor: (text: string, values?: unknown[]) => any[] = () => []) {
  const query = vi.fn(async (text: string, values?: unknown[]) => ({ rows: rowsFor(text, values) }));
  const release = vi.fn();
  return { query, release, value: { connect: vi.fn(async () => ({ query, release })) } };
}

describe('Postgres merge-group gate repository', () => {
  it('claims work in a short committed transaction with per-snapshot identity', async () => {
    const fixture = pool((text) => text.includes('SELECT EXISTS') ? [{ lease_active: false }] : []);
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.claim(614653796, HEAD, SNAPSHOT, CLAIM)).resolves.toEqual({ status: 'acquired' });
    const insert = fixture.query.mock.calls.find(([text]) => text.includes('INSERT INTO merge_group_gate_publications'));
    expect(insert?.[1]).toEqual([614653796, HEAD, SNAPSHOT, CLAIM]);
    expect(insert?.[0]).toContain('ON CONFLICT (repository_id, head_sha, snapshot_digest)');
    expect(fixture.query.mock.calls.map(([text]) => text)).toEqual(expect.arrayContaining([
      'BEGIN', "SET LOCAL lock_timeout = '5s'", expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('SELECT EXISTS'), 'COMMIT',
    ]));
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it('leaves an active lease on any same-head snapshot untouched', async () => {
    const fixture = pool((text) => text.includes('SELECT EXISTS') ? [{ lease_active: true }] : []);
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.claim(614653796, HEAD, SNAPSHOT, CLAIM)).resolves.toEqual({ status: 'busy' });
    expect(fixture.query.mock.calls.some(([text]) => text.includes('INSERT INTO merge_group_gate_publications'))).toBe(false);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it('keeps distinct queue or pause digests as independent durable rows', async () => {
    const fixture = pool((text) => text.includes('SELECT EXISTS') ? [{ lease_active: false }] : []);
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.claim(614653796, HEAD, SNAPSHOT, CLAIM)).resolves.toEqual({ status: 'acquired' });
    const insert = fixture.query.mock.calls.find(([text]) => text.includes('INSERT INTO merge_group_gate_publications'));
    expect(insert?.[0]).toContain('ON CONFLICT (repository_id, head_sha, snapshot_digest)');
    expect(insert?.[0]).not.toContain('snapshot_digest = EXCLUDED.snapshot_digest');
    expect(insert?.[1]).toEqual([614653796, HEAD, SNAPSHOT, CLAIM]);
  });

  it('commits one create reservation and refuses an uncertain duplicate reservation', async () => {
    let creationStarted = false;
    const fixture = pool((text) => {
      if (text.includes('SELECT check_id,check_creation_started')) {
        return [{ check_id: null, check_creation_started: creationStarted }];
      }
      if (text.includes('SELECT 1 FROM merge_group_gate_publications') && text.includes('snapshot_digest<>$3')) return [];
      if (text.includes('RETURNING repository_id') && text.includes('check_creation_started=TRUE')) {
        creationStarted = true;
        return [{ repository_id: 614653796 }];
      }
      return [];
    });
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.reserveCheckCreation(614653796, HEAD, SNAPSHOT, CLAIM)).resolves.toBe(true);
    await expect(repository.reserveCheckCreation(614653796, HEAD, SNAPSHOT, CLAIM)).resolves.toBe(false);
    expect(fixture.query.mock.calls.filter(([text]) => text.includes('SET check_creation_started=TRUE'))).toHaveLength(1);
  });

  it('blocks a newer digest until the older unknown-ACK snapshot is settled', async () => {
    let settled = false;
    let currentReserved = false;
    const fixture = pool((text) => {
      if (text.includes('claim_token=$4') && text.includes('SELECT 1 FROM merge_group_gate_publications')) {
        return [{ '?column?': 1 }];
      }
      if (text.includes('SELECT check_id,check_creation_started')) {
        return [{ check_id: null, check_creation_started: false }];
      }
      if (text.includes('snapshot_digest<>$3') && text.includes('SELECT 1 FROM merge_group_gate_publications')) {
        return settled ? [] : [{ snapshot_digest: PRIOR }];
      }
      if (text.includes("SET check_id=$4") && text.includes("conclusion='failure'")) {
        settled = true;
        return [{ check_id: 900 }];
      }
      if (text.includes('RETURNING repository_id') && text.includes('check_creation_started=TRUE')) {
        currentReserved = true;
        return [{ repository_id: 614653796 }];
      }
      return [];
    });
    const repository = new PostgresMergeGroupGateRepository(fixture.value);

    await expect(repository.reserveCheckCreation(614653796, HEAD, SNAPSHOT, CLAIM)).resolves.toBe(false);
    expect(currentReserved).toBe(false);
    await expect(repository.settlePriorPublication(614653796, HEAD, SNAPSHOT, CLAIM, PRIOR, 900)).resolves.toBeUndefined();
    await expect(repository.reserveCheckCreation(614653796, HEAD, SNAPSHOT, CLAIM)).resolves.toBe(true);
    expect(currentReserved).toBe(true);
    expect(fixture.query.mock.calls.some(([text]) => text.includes("SET check_id=$4")
      && text.includes("conclusion='failure'"))).toBe(true);
  });

  it('lists only unresolved prior snapshots while validating the active claim', async () => {
    const fixture = pool((text) => {
      if (text.includes('SELECT 1 FROM merge_group_gate_publications') && text.includes('claim_token=$4')) return [{ '?column?': 1 }];
      if (text.includes('SELECT snapshot_digest,check_id')) return [{ snapshot_digest: PRIOR, check_id: null,
        check_creation_started: true, conclusion: null }];
      return [];
    });
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.listPriorPublications(614653796, HEAD, SNAPSHOT, CLAIM)).resolves.toEqual([{
      snapshotDigest: PRIOR, checkId: null, checkCreationStarted: true, conclusion: null,
    }]);
  });

  it('persists a terminal result under the owned snapshot claim', async () => {
    const fixture = pool((text) => text.includes('RETURNING check_id') ? [{ check_id: 91 }] : []);
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.complete(614653796, HEAD, SNAPSHOT, CLAIM,
      { checkId: 91, conclusion: 'success', snapshotDigest: SNAPSHOT })).resolves.toBeUndefined();
    expect(fixture.query.mock.calls.map(([text]) => text)).toEqual(expect.arrayContaining([
      'BEGIN', expect.stringContaining('pg_advisory_xact_lock'),
      expect.stringContaining('UPDATE merge_group_gate_publications'), 'COMMIT',
    ]));
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it('rolls back completion when the lease is no longer owned', async () => {
    const fixture = pool();
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await expect(repository.complete(614653796, HEAD, SNAPSHOT, CLAIM,
      { checkId: 91, conclusion: 'success', snapshotDigest: SNAPSHOT })).rejects.toThrow('claim is no longer owned');
    expect(fixture.query.mock.calls.map(([text]) => text)).toContain('ROLLBACK');
  });

  it('releases only its unfinished snapshot lease while preserving its create reservation', async () => {
    const fixture = pool();
    const repository = new PostgresMergeGroupGateRepository(fixture.value);
    await repository.release(614653796, HEAD, SNAPSHOT, CLAIM);
    expect(fixture.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE merge_group_gate_publications'),
      [614653796, HEAD, SNAPSHOT, CLAIM]);
    expect(fixture.query.mock.calls.some(([text]) => text.includes('DELETE FROM'))).toBe(false);
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
