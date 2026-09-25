import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applySchemaOnce,
  createdTableNames,
  isRetryableSchemaLockError,
  SCHEMA_DDL_LOCK_TIMEOUT,
  SCHEMA_MIGRATIONS_TABLE,
  schemaFingerprint,
  withSchemaLockRetry,
  type SchemaQueryable,
} from '../../src/persistence/schemaMigrationGate';
import { PostgresStore } from '../../src/persistence/postgresStore';
import { logger } from '../../src/utils/logger';

const DDL = [
  'CREATE TABLE IF NOT EXISTS review_runs (run_id TEXT PRIMARY KEY);\nALTER TABLE review_runs ALTER COLUMN run_id SET NOT NULL;',
  'CREATE TABLE IF NOT EXISTS review_ci_requests (request_id UUID PRIMARY KEY);',
];

function pgError(code: string, message = `synthetic ${code}`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** A scripted fake: `recorded` says whether the fingerprint row exists, `missing` which tables are gone. */
function fakeClient(state: { recorded: boolean; missing?: string[] }) {
  const statements: string[] = [];
  const client: SchemaQueryable = {
    query: vi.fn(async (text: string) => {
      statements.push(text);
      if (text.startsWith(`SELECT 1 AS applied FROM ${SCHEMA_MIGRATIONS_TABLE}`)) {
        return { rows: state.recorded ? [{ applied: 1 }] : [] };
      }
      if (text.includes('to_regclass')) return { rows: (state.missing ?? []).map((name) => ({ name })) };
      return { rows: [] };
    }),
  };
  return { client, statements };
}

describe('schemaFingerprint', () => {
  it('is stable for identical statements and changes when any statement, the order, or a boundary changes', () => {
    const base = schemaFingerprint(DDL);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
    expect(schemaFingerprint([...DDL])).toBe(base);
    expect(schemaFingerprint([DDL[0], `${DDL[1]} `])).not.toBe(base);
    expect(schemaFingerprint([DDL[1], DDL[0]])).not.toBe(base);
    expect(schemaFingerprint(['ab', 'c'])).not.toBe(schemaFingerprint(['a', 'bc']));
  });
});

describe('createdTableNames', () => {
  it('lists every CREATE TABLE IF NOT EXISTS target once, lower-cased and sorted', () => {
    expect(createdTableNames([
      ...DDL,
      'create table if not exists Review_Runs (x int); CREATE INDEX IF NOT EXISTS i ON review_runs (x);',
    ])).toEqual(['review_ci_requests', 'review_runs']);
  });
});

describe('applySchemaOnce', () => {
  it('skips every DDL statement when this schema fingerprint is already recorded and its tables exist', async () => {
    const { client, statements } = fakeClient({ recorded: true });

    await expect(applySchemaOnce(client, DDL)).resolves.toBe('skipped');

    for (const ddl of DDL) expect(statements).not.toContain(ddl);
    expect(statements.some((s) => s.includes('lock_timeout'))).toBe(false);
    expect(statements.some((s) => s.startsWith(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}`))).toBe(false);
  });

  it('applies the DDL under a bounded lock_timeout, in order, then records the fingerprint when it is new', async () => {
    const { client, statements } = fakeClient({ recorded: false });

    await expect(applySchemaOnce(client, DDL)).resolves.toBe('applied');

    const timeoutAt = statements.indexOf(`SET LOCAL lock_timeout = '${SCHEMA_DDL_LOCK_TIMEOUT}'`);
    const firstDdl = statements.indexOf(DDL[0]);
    const secondDdl = statements.indexOf(DDL[1]);
    const recordAt = statements.findIndex((s) => s.startsWith(`INSERT INTO ${SCHEMA_MIGRATIONS_TABLE}`));
    expect(timeoutAt).toBeGreaterThanOrEqual(0);
    expect(timeoutAt).toBeLessThan(firstDdl);
    expect(firstDdl).toBeLessThan(secondDdl);
    expect(secondDdl).toBeLessThan(recordAt);
    const insertCall = vi.mocked(client.query).mock.calls.find(([text]) => text.startsWith('INSERT INTO'));
    expect(insertCall?.[1]).toEqual([schemaFingerprint(DDL)]);
  });

  it('re-applies a recorded schema when one of its tables is missing', async () => {
    const { client, statements } = fakeClient({ recorded: true, missing: ['review_ci_requests'] });

    await expect(applySchemaOnce(client, DDL)).resolves.toBe('applied');

    expect(statements).toContain(DDL[0]);
    expect(statements).toContain(DDL[1]);
    const regclassCall = vi.mocked(client.query).mock.calls.find(([text]) => text.includes('to_regclass'));
    expect(regclassCall?.[1]).toEqual([['review_ci_requests', 'review_runs']]);
  });
});

describe('withSchemaLockRetry', () => {
  it('classifies only deadlock (40P01) and lock timeout (55P03) as retryable', () => {
    expect(isRetryableSchemaLockError(pgError('40P01'))).toBe(true);
    expect(isRetryableSchemaLockError(pgError('55P03'))).toBe(true);
    expect(isRetryableSchemaLockError(pgError('42P01'))).toBe(false);
    expect(isRetryableSchemaLockError(new Error('deadlock detected'))).toBe(false);
    expect(isRetryableSchemaLockError(null)).toBe(false);
  });

  it('retries lock conflicts with bounded backoff and returns the eventual result', async () => {
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const onRetry = vi.fn();
    const operation = vi.fn()
      .mockRejectedValueOnce(pgError('40P01'))
      .mockRejectedValueOnce(pgError('55P03'))
      .mockResolvedValueOnce('ok');

    await expect(withSchemaLockRetry(operation, { sleep, onRetry, random: () => 1, baseDelayMs: 100, maxDelayMs: 150 }))
      .resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 150]);
    expect(onRetry.mock.calls.map(([details]) => details.code)).toEqual(['40P01', '55P03']);
  });

  it('rethrows a non-lock error at once without retrying', async () => {
    const failure = pgError('42P01');
    const operation = vi.fn().mockRejectedValue(failure);
    const sleep = vi.fn(async () => undefined);

    await expect(withSchemaLockRetry(operation, { sleep })).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the attempt budget and rethrows the last conflict', async () => {
    const last = pgError('40P01', 'last');
    const operation = vi.fn()
      .mockRejectedValueOnce(pgError('40P01'))
      .mockRejectedValueOnce(pgError('40P01'))
      .mockRejectedValueOnce(last);

    await expect(withSchemaLockRetry(operation, { attempts: 3, sleep: async () => undefined })).rejects.toBe(last);
    expect(operation).toHaveBeenCalledTimes(3);
  });
});

describe('PostgresStore.initialize schema gate wiring', () => {
  afterEach(() => {
    delete process.env.DATABASE_URL;
    vi.restoreAllMocks();
  });

  function storeWithScript(respond: (statement: string, attempt: number) => unknown) {
    process.env.DATABASE_URL = 'postgresql://fixture:synthetic-password@127.0.0.1:5432/fixture';
    const store = new PostgresStore();
    const statements: string[] = [];
    let attempt = 0;
    const query = vi.fn(async (statement: string) => {
      if (statement === 'BEGIN') attempt += 1;
      statements.push(statement);
      const result = respond(statement, attempt);
      if (result instanceof Error) throw result;
      return result ?? { rows: [] };
    });
    const release = vi.fn();
    vi.spyOn(store.getPool(), 'connect').mockResolvedValue({ query, release } as never);
    return { store, statements, release, attempts: () => attempt };
  }

  it('runs no review_runs DDL on a start whose schema is already recorded', async () => {
    const { store, statements } = storeWithScript((statement) => (
      statement.startsWith(`SELECT 1 AS applied FROM ${SCHEMA_MIGRATIONS_TABLE}`) ? { rows: [{ applied: 1 }] } : undefined));
    try {
      await store.initialize();
      expect(statements.some((s) => s.includes('ALTER TABLE review_runs'))).toBe(false);
      expect(statements.some((s) => s.includes('DROP TRIGGER'))).toBe(false);
      expect(statements).toContain('COMMIT');
    } finally {
      await store.close();
    }
  });

  it('rolls back and retries the whole transaction when the DDL is chosen as a deadlock victim', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { store, statements, release, attempts } = storeWithScript((statement, attempt) => (
      attempt === 1 && statement.includes('ALTER TABLE review_runs') ? pgError('40P01', 'deadlock detected') : undefined));
    try {
      await store.initialize();
      expect(attempts()).toBe(2);
      expect(statements.filter((s) => s === 'ROLLBACK')).toHaveLength(1);
      expect(statements.filter((s) => s === 'COMMIT')).toHaveLength(1);
      expect(release).toHaveBeenCalledTimes(2);
      expect(errorLog).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        '[PostgresStore] Schema initialization lock conflict; retrying',
        expect.objectContaining({ code: 'postgres_initialization_lock_conflict', sqlState: '40P01', attempt: 1 }),
      );
    } finally {
      await store.close();
    }
  });

  it('logs postgres_initialization_failed and rejects with the original error when initialization cannot complete', async () => {
    const warnLog = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const failure = pgError('42P01', 'relation does not exist');
    const { store, statements, release, attempts } = storeWithScript((statement) => (
      statement.includes('ALTER TABLE review_runs') ? failure : undefined));
    try {
      await expect(store.initialize()).rejects.toBe(failure);
      expect(attempts()).toBe(1);
      expect(statements).toContain('ROLLBACK');
      expect(statements).not.toContain('COMMIT');
      expect(release).toHaveBeenCalledTimes(1);
      expect(warnLog).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith(
        '[PostgresStore] PostgreSQL database schema initialization failed',
        expect.objectContaining({ code: 'postgres_initialization_failed' }),
      );
    } finally {
      await store.close();
    }
  });
});
