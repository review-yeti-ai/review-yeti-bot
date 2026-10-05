import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { canonicalJson, sha256 } from '../review/reviewCore';
import {
  createOperatorMaintenanceIntentId,
  operatorMaintenanceReceiptSchema,
  type OperatorMaintenanceClaimResult,
  type OperatorMaintenanceIdentity,
  type OperatorMaintenanceReceiptV1,
  type OperatorMaintenanceRepository,
} from '../review/operatorMaintenanceContracts';

export const OPERATOR_MAINTENANCE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS operator_maintenance_intents (
    intent_id TEXT PRIMARY KEY CHECK (intent_id ~ '^operator-maintenance:v1:[a-f0-9]{64}$'),
    identity_digest CHAR(64) UNIQUE NOT NULL CHECK (identity_digest ~ '^[a-f0-9]{64}$'),
    identity JSONB NOT NULL CHECK (jsonb_typeof(identity) = 'object'),
    receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt) = 'object'),
    status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'stale')),
    raw_state TEXT NOT NULL CHECK (raw_state IN ('reserved', 'creating', 'bound')),
    gate_state TEXT NOT NULL CHECK (gate_state IN ('blocked', 'reserved', 'creating', 'bound')),
    raw_check_id BIGINT CHECK (raw_check_id IS NULL OR raw_check_id > 0),
    gate_check_id BIGINT CHECK (gate_check_id IS NULL OR gate_check_id > 0),
    raw_claim_token UUID,
    raw_lease_expires_at TIMESTAMPTZ,
    gate_claim_token UUID,
    gate_lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((raw_state = 'creating') = (raw_claim_token IS NOT NULL AND raw_lease_expires_at IS NOT NULL)),
    CHECK ((gate_state = 'creating') = (gate_claim_token IS NOT NULL AND gate_lease_expires_at IS NOT NULL)),
    CHECK ((raw_state = 'bound') = (raw_check_id IS NOT NULL)),
    CHECK ((gate_state = 'bound') = (gate_check_id IS NOT NULL)),
    CHECK (gate_state <> 'reserved' OR raw_state = 'bound'),
    CHECK (gate_state <> 'creating' OR raw_state = 'bound'),
    CHECK (status <> 'published' OR gate_state = 'bound')
  );
  CREATE INDEX IF NOT EXISTS operator_maintenance_claims_idx
    ON operator_maintenance_intents (status, raw_state, gate_state, updated_at);
`;

const MAX_LEASE_MS = 5 * 60_000;
const receiptSelect = `SELECT intent_id, identity_digest, identity, receipt, status,
  raw_state, gate_state, raw_check_id, gate_check_id,
  raw_claim_token, raw_lease_expires_at, gate_claim_token, gate_lease_expires_at
  FROM operator_maintenance_intents`;

interface MaintenanceRow {
  intent_id: string;
  identity_digest: string;
  identity: OperatorMaintenanceIdentity;
  receipt: unknown;
  status: 'pending' | 'published' | 'stale';
  raw_state: 'reserved' | 'creating' | 'bound';
  gate_state: 'blocked' | 'reserved' | 'creating' | 'bound';
  raw_check_id: string | number | null;
  gate_check_id: string | number | null;
  raw_claim_token: string | null;
  raw_lease_expires_at: Date | null;
  gate_claim_token: string | null;
  gate_lease_expires_at: Date | null;
}

function parseReceipt(input: unknown): OperatorMaintenanceReceiptV1 {
  const receipt = operatorMaintenanceReceiptSchema.parse(input) as OperatorMaintenanceReceiptV1;
  // Source provenance has a canonical order upstream. Sorting here makes a
  // retried reservation insensitive only to equivalent ordering, not content.
  receipt.policy.sources.sort((left, right) => {
    const a = JSON.stringify(left); const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const expectedIntentId = createOperatorMaintenanceIntentId(receipt.identity);
  if (receipt.intentId !== expectedIntentId) throw new Error('Maintenance intent ID does not match its target identity');
  return receipt;
}

function identityDigest(identity: OperatorMaintenanceIdentity): string {
  return sha256({ version: 'OperatorMaintenanceTarget.v1', identity });
}

function comparableReceipt(receipt: OperatorMaintenanceReceiptV1): string {
  const { source: _source, ...immutableReceipt } = receipt;
  return canonicalJson(immutableReceipt);
}

function toCheckId(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Stored maintenance check ID is invalid');
  return parsed;
}

function requireDate(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Maintenance claim time is invalid');
}

function requireLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) {
    throw new Error(`Maintenance lease must be between 1 and ${MAX_LEASE_MS} milliseconds`);
  }
}

async function withTransaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* Preserve the triggering failure. */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Durable operator-authorized publication state. This table intentionally
 * has no review-run foreign key: passthrough did not perform a review run. */
export class PostgresOperatorMaintenanceRepository implements OperatorMaintenanceRepository {
  constructor(
    private readonly pool: Pool,
    private readonly newLeaseToken: () => string = randomUUID,
  ) {}

  async reserve(input: OperatorMaintenanceReceiptV1): Promise<OperatorMaintenanceReceiptV1> {
    const receipt = parseReceipt(input);
    const digest = identityDigest(receipt.identity);
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO operator_maintenance_intents
          (intent_id, identity_digest, identity, receipt, status, raw_state, gate_state)
         VALUES ($1, $2, $3::jsonb, $4::jsonb, 'pending', 'reserved', 'blocked')
         ON CONFLICT (identity_digest) DO NOTHING`,
        [receipt.intentId, digest, JSON.stringify(receipt.identity), JSON.stringify(receipt)],
      );
      const selected = await client.query<MaintenanceRow>(
        `${receiptSelect} WHERE identity_digest = $1 FOR UPDATE`,
        [digest],
      );
      const row = selected.rows[0];
      if (!row || row.intent_id !== receipt.intentId || canonicalJson(row.identity) !== canonicalJson(receipt.identity)) {
        throw new Error('Maintenance target identity conflicts with its persisted reservation');
      }
      const stored = parseReceipt(row.receipt);
      if (comparableReceipt(stored) !== comparableReceipt(receipt)) {
        throw new Error('Maintenance reservation conflicts with persisted immutable authority or policy');
      }
      return stored;
    });
  }

  async listPending(limit: number, afterIntentId?: string): Promise<OperatorMaintenanceReceiptV1[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Maintenance pending page limit must be between 1 and 100');
    }
    if (afterIntentId !== undefined && !/^operator-maintenance:v1:[a-f0-9]{64}$/u.test(afterIntentId)) {
      throw new Error('Maintenance pending cursor is invalid');
    }
    const result = await this.pool.query<{ receipt: unknown }>(
      `SELECT receipt FROM operator_maintenance_intents
        WHERE status = 'pending' AND ($1::text IS NULL OR intent_id > $1)
        ORDER BY intent_id ASC LIMIT $2`,
      [afterIntentId ?? null, limit],
    );
    return result.rows.map(({ receipt }) => parseReceipt(receipt));
  }

  claimRaw(intentId: string, now: Date, leaseMs: number): Promise<OperatorMaintenanceClaimResult> {
    return this.claim(intentId, 'raw', now, leaseMs);
  }

  bindRaw(intentId: string, leaseToken: string, checkId: number, now: Date): Promise<void> {
    return this.bind(intentId, 'raw', leaseToken, checkId, now);
  }

  claimGate(intentId: string, now: Date, leaseMs: number): Promise<OperatorMaintenanceClaimResult> {
    return this.claim(intentId, 'gate', now, leaseMs);
  }

  bindGate(intentId: string, leaseToken: string, checkId: number, now: Date): Promise<void> {
    return this.bind(intentId, 'gate', leaseToken, checkId, now);
  }

  async markStale(intentId: string, now: Date): Promise<void> {
    requireDate(now);
    const updated = await this.pool.query(
      `UPDATE operator_maintenance_intents
          SET status = 'stale', updated_at = $2
        WHERE intent_id = $1`,
      [intentId, now],
    );
    if (updated.rowCount !== 1) throw new Error('Maintenance intent was not reserved');
  }

  private async claim(
    intentId: string,
    stage: 'raw' | 'gate',
    now: Date,
    leaseMs: number,
  ): Promise<OperatorMaintenanceClaimResult> {
    requireDate(now);
    requireLease(leaseMs);
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<MaintenanceRow>(`${receiptSelect} WHERE intent_id = $1 FOR UPDATE`, [intentId]);
      const row = selected.rows[0];
      if (!row) throw new Error('Maintenance intent was not reserved');
      if (row.status === 'stale') return { kind: 'stale' as const };
      if (stage === 'gate' && row.raw_state !== 'bound') return { kind: 'blocked' as const };
      const state = stage === 'raw' ? row.raw_state : row.gate_state;
      const checkId = stage === 'raw' ? toCheckId(row.raw_check_id) : toCheckId(row.gate_check_id);
      if (state === 'bound') {
        if (checkId === null) throw new Error(`Bound ${stage} maintenance check has no ID`);
        return { kind: 'bound' as const, checkId };
      }
      if (state === 'blocked') return { kind: 'blocked' as const };

      const expires = stage === 'raw' ? row.raw_lease_expires_at : row.gate_lease_expires_at;
      const priorToken = stage === 'raw' ? row.raw_claim_token : row.gate_claim_token;
      if (state === 'creating' && expires && expires.getTime() > now.getTime()) return { kind: 'busy' as const };
      if (state === 'creating' && (!expires || !priorToken)) throw new Error(`Creating ${stage} claim has no lease fence`);

      const leaseToken = this.newLeaseToken();
      const stateColumn = stage === 'raw' ? 'raw_state' : 'gate_state';
      const tokenColumn = stage === 'raw' ? 'raw_claim_token' : 'gate_claim_token';
      const expiryColumn = stage === 'raw' ? 'raw_lease_expires_at' : 'gate_lease_expires_at';
      await client.query(
        `UPDATE operator_maintenance_intents
            SET ${stateColumn} = 'creating', ${tokenColumn} = $2::uuid,
                ${expiryColumn} = $3::timestamptz + ($4::int * interval '1 millisecond'), updated_at = $3
          WHERE intent_id = $1`,
        [intentId, leaseToken, now, leaseMs],
      );
      // The caller must inventory the exact app/name/head/external ID before a
      // POST on both first attempt and expired-lease recovery. GitHub's external
      // side effect is not claimed to be exactly once.
      return { kind: 'lease' as const, leaseToken, reconcileFirst: true as const };
    });
  }

  private async bind(
    intentId: string,
    stage: 'raw' | 'gate',
    leaseToken: string,
    checkId: number,
    now: Date,
  ): Promise<void> {
    requireDate(now);
    if (!Number.isSafeInteger(checkId) || checkId <= 0) throw new Error('Maintenance check ID must be a positive safe integer');
    let token: string;
    try { token = z.string().uuid().parse(leaseToken); } catch { throw new Error('Maintenance lease token is invalid'); }
    await withTransaction(this.pool, async (client) => {
      const update = stage === 'raw'
        ? `UPDATE operator_maintenance_intents
              SET raw_state = 'bound', raw_check_id = $3, raw_claim_token = NULL,
                  raw_lease_expires_at = NULL, gate_state = 'reserved', updated_at = $4
            WHERE intent_id = $1 AND status = 'pending' AND raw_state = 'creating'
              AND raw_claim_token = $2::uuid AND raw_lease_expires_at > $4`
        : `UPDATE operator_maintenance_intents
              SET gate_state = 'bound', gate_check_id = $3, gate_claim_token = NULL,
                  gate_lease_expires_at = NULL, status = 'published', updated_at = $4
            WHERE intent_id = $1 AND status = 'pending' AND raw_state = 'bound'
              AND gate_state = 'creating' AND gate_claim_token = $2::uuid AND gate_lease_expires_at > $4`;
      const result = await client.query(update, [intentId, token, checkId, now]);
      if (result.rowCount !== 1) throw new Error(`Maintenance ${stage} claim is stale, expired, or fenced by a newer claimant`);
    });
  }
}
