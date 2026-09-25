import { createHash } from 'node:crypto';

/**
 * Schema migration gate (REL-1127).
 *
 * WHY THIS EXISTS
 *
 * `PostgresStore.initialize()` serializes schema initialization across pods with
 * a transaction-scoped advisory lock, but it used to re-run the whole DDL script
 * on every pod start. That script contains `ALTER TABLE ... SET NOT NULL`,
 * `DROP/CREATE TRIGGER`, `ADD CONSTRAINT` and backfill `UPDATE`s against hot
 * tables (review_runs, the outboxes, review_ci_*). Those statements take
 * ACCESS EXCLUSIVE / SHARE ROW EXCLUSIVE locks. The advisory lock only orders
 * schema initializers against each other; it does nothing against the live
 * dispatcher and action-dispatch transactions of the pods that are still
 * serving. Every rollout therefore raced live traffic and Postgres broke the
 * cycle with `40P01 deadlock detected`: the new pod failed to start, or the
 * dispatcher cycle and in-flight worker completions failed with 503.
 *
 * The gate records a fingerprint of the exact DDL a build applies. A pod whose
 * fingerprint is already recorded skips the DDL entirely, so an ordinary
 * rollout takes no lock on any hot table. Only a build that really changes the
 * schema runs DDL, and it does so with a bounded `lock_timeout` so it cannot
 * queue behind (and in front of) live traffic indefinitely; a lock timeout or a
 * deadlock is retried with bounded backoff instead of crashing the pod.
 *
 * Every applied fingerprint is kept (not just the latest), so old and new pods
 * that restart during a rolling update both skip, and a rollback to an older
 * build does not re-run its older DDL over a newer schema.
 */

export const SCHEMA_MIGRATIONS_TABLE = 'review_yeti_schema_migrations';

/** Bump to force every deployment to re-apply the DDL once. */
export const SCHEMA_FINGERPRINT_VERSION = 'rel-1127-v1';

/** Upper bound a DDL statement may wait for a table lock before giving up. */
export const SCHEMA_DDL_LOCK_TIMEOUT = '5s';

export const SCHEMA_MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${SCHEMA_MIGRATIONS_TABLE} (
  fingerprint CHAR(64) PRIMARY KEY,
  applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
)`;

export interface SchemaQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type SchemaApplyOutcome = 'applied' | 'skipped';

/**
 * A stable digest of the ordered DDL statements. Each statement is length
 * prefixed so moving text between adjacent statements changes the digest.
 */
export function schemaFingerprint(statements: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update(`${SCHEMA_FINGERPRINT_VERSION}\n`);
  for (const statement of statements) {
    hash.update(`${Buffer.byteLength(statement, 'utf8')}:`);
    hash.update(statement);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Table names the statements create with `CREATE TABLE IF NOT EXISTS`, used as
 * a cheap catalog check that a recorded schema still exists (a table dropped by
 * hand or restored from a partial dump makes the gate re-apply the DDL).
 */
export function createdTableNames(statements: readonly string[]): string[] {
  const names = new Set<string>();
  const pattern = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/giu;
  for (const statement of statements) {
    for (const match of statement.matchAll(pattern)) names.add(match[1].toLowerCase());
  }
  return [...names].sort();
}

/**
 * Applies `statements` unless this exact schema is already recorded.
 *
 * Must run inside the caller's transaction, after the caller has taken the
 * schema advisory lock, so the check-then-apply-then-record sequence is atomic
 * across pods.
 */
export async function applySchemaOnce(
  client: SchemaQueryable,
  statements: readonly string[],
): Promise<SchemaApplyOutcome> {
  const fingerprint = schemaFingerprint(statements);
  await client.query(SCHEMA_MIGRATIONS_TABLE_SQL);
  const recorded = await client.query(
    `SELECT 1 AS applied FROM ${SCHEMA_MIGRATIONS_TABLE} WHERE fingerprint = $1`,
    [fingerprint],
  );
  if (recorded.rows.length > 0) {
    // to_regclass only reads the catalog; it takes no lock on the tables.
    const missing = await client.query(
      'SELECT name FROM unnest($1::text[]) AS name WHERE to_regclass(name) IS NULL',
      [createdTableNames(statements)],
    );
    if (missing.rows.length === 0) return 'skipped';
  }

  await client.query(`SET LOCAL lock_timeout = '${SCHEMA_DDL_LOCK_TIMEOUT}'`);
  for (const statement of statements) {
    await client.query(statement);
  }
  await client.query(
    `INSERT INTO ${SCHEMA_MIGRATIONS_TABLE} (fingerprint) VALUES ($1) ON CONFLICT (fingerprint) DO NOTHING`,
    [fingerprint],
  );
  return 'applied';
}

/** 40P01 deadlock_detected, 55P03 lock_not_available (lock_timeout). */
const RETRYABLE_SCHEMA_LOCK_CODES = new Set(['40P01', '55P03']);

export function isRetryableSchemaLockError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && RETRYABLE_SCHEMA_LOCK_CODES.has(code);
}

export interface SchemaRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  onRetry?: (details: { attempt: number; code: string; delayMs: number }) => void;
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds).unref?.();
});

/**
 * Runs `operation` (one whole schema transaction) and retries it on a lock
 * conflict with bounded, jittered backoff. Any other error, or the last
 * conflict, is rethrown unchanged.
 */
export async function withSchemaLockRetry<T>(
  operation: () => Promise<T>,
  options: SchemaRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 6);
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 4_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isRetryableSchemaLockError(error)) throw error;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = Math.round(ceiling / 2 + random() * (ceiling / 2));
      options.onRetry?.({ attempt, code: String((error as { code: string }).code), delayMs });
      await sleep(delayMs);
    }
  }
}
