import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import type { DashboardData } from '../../src/persistence/dashboardStore';
import { ADVISORY_LOCK_ID, PostgresStore } from '../../src/persistence/postgresStore';
import { REVIEW_EVENT_SCHEMA_SQL } from '../../src/persistence/reviewEventRepository';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const ownedSchema = /^review_yeti_v2_storage_test_[0-9a-f]{16}$/u;
const baseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const eventAlphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const eventSeed = '01J8Z5M6V7Q8R9S0T1V2W3X4Y5';
const runIds = [
  'run_legacy_pending_0000000000000000000000',
  'run_legacy_claimed_0000000000000000000000',
  'run_legacy_published_000000000000000000000',
];
const storageEnvironmentKeys = ['DATABASE_URL', 'POSTGRES_URL', 'NATS_URL'] as const;
type StorageEnvironmentKey = typeof storageEnvironmentKeys[number];
type EnvironmentSnapshot = Record<StorageEnvironmentKey, { present: boolean; value?: string }>;

function snapshotEnvironment(): EnvironmentSnapshot {
  return Object.fromEntries(storageEnvironmentKeys.map((key) => [key, {
    present: Object.prototype.hasOwnProperty.call(process.env, key),
    value: process.env[key],
  }])) as EnvironmentSnapshot;
}

function restoreEnvironment(snapshot: EnvironmentSnapshot): void {
  for (const key of storageEnvironmentKeys) {
    if (snapshot[key].present) process.env[key] = snapshot[key].value!;
    else delete process.env[key];
  }
}

function configureFixtureEnvironment(connectionString: string): void {
  process.env.DATABASE_URL = connectionString;
  delete process.env.POSTGRES_URL;
  delete process.env.NATS_URL;
}

function expectEnvironmentState(snapshot: EnvironmentSnapshot): void {
  for (const key of storageEnvironmentKeys) {
    const expected = snapshot[key];
    const present = Object.prototype.hasOwnProperty.call(process.env, key);
    expect(present, `${key} presence`).toBe(expected.present);
    if (expected.present) expect(process.env[key] === expected.value, `${key} value equality`).toBe(true);
    else expect(process.env[key] === undefined, `${key} absence`).toBe(true);
  }
}

function eventId(index: number): string {
  return `${eventSeed.slice(0, -1)}${eventAlphabet[index]}`;
}

function v1Payload(runId: string, sequence: number) {
  return {
    schema: 'review-yeti-event.v1',
    event_id: eventId(sequence),
    event_kind: 'review.lifecycle.queued',
    occurred_at: '2026-09-11T12:00:00.000Z',
    repository_id: 123,
    pr_number: 42,
    base_sha: baseSha,
    head_sha: headSha,
    attempt_id: `${runId}-attempt`,
    run_id: runId,
    sequence,
    correlation_id: `${runId}-correlation`,
    trace_id: `${runId}-trace`,
    visibility: 'internal',
    data: { stage: 'queued' },
  };
}

interface V2RowOverrides {
  eventId?: string;
  repositoryId?: number;
  prNumber?: number;
  sequence?: number;
  attemptId?: string;
  eventKind?: string;
  occurredAt?: string;
  correlationId?: string;
  traceId?: string;
  data?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  payloadPatch?: Record<string, unknown>;
  state?: 'pending' | 'claimed' | 'published';
  attemptCount?: number;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  publishAcknowledgedAt?: string | null;
  publishAck?: string | null;
}

interface V2Row {
  eventId: string;
  runId: string;
  attemptId: string;
  repositoryId: number;
  prNumber: number;
  sequence: number;
  eventKind: string;
  occurredAt: string;
  correlationId: string;
  traceId: string;
  state: 'pending' | 'claimed' | 'published';
  attemptCount: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  publishAcknowledgedAt: string | null;
  publishAck: string | null;
  payload: Record<string, unknown>;
}

function buildV2Row(runId: string, index: number, overrides: V2RowOverrides = {}): V2Row {
  const eventIdValue = overrides.eventId ?? eventId(index);
  const repositoryId = overrides.repositoryId ?? 123;
  const prNumber = overrides.prNumber ?? 42;
  const sequence = overrides.sequence ?? 1;
  const attemptId = overrides.attemptId ?? `${runId}-attempt`;
  const eventKind = overrides.eventKind ?? 'review.lifecycle.terminal';
  const occurredAt = overrides.occurredAt ?? '2026-09-11T12:00:00.000Z';
  const correlationId = overrides.correlationId ?? `${runId}-correlation`;
  const traceId = overrides.traceId ?? `${runId}-trace`;
  const defaultPayload = {
    schema: 'review-yeti-event.v2',
    event_id: eventIdValue,
    event_kind: eventKind,
    occurred_at: occurredAt,
    repository_id: repositoryId,
    pr_number: prNumber,
    base_sha: baseSha,
    head_sha: headSha,
    attempt_id: attemptId,
    run_id: runId,
    sequence,
    sequence_domain: 'pr_lifecycle_v2',
    correlation_id: correlationId,
    trace_id: traceId,
    visibility: 'internal',
    data: overrides.data ?? { stage: 'terminal' },
  };
  return {
    eventId: eventIdValue,
    runId,
    attemptId,
    repositoryId,
    prNumber,
    sequence,
    eventKind,
    occurredAt,
    correlationId,
    traceId,
    state: overrides.state ?? 'pending',
    attemptCount: overrides.attemptCount ?? 0,
    leaseOwner: overrides.leaseOwner ?? null,
    leaseExpiresAt: overrides.leaseExpiresAt ?? null,
    publishAcknowledgedAt: overrides.publishAcknowledgedAt ?? null,
    publishAck: overrides.publishAck ?? null,
    payload: overrides.payload ?? { ...defaultPayload, ...overrides.payloadPatch },
  };
}

describeWithPostgres('Review Yeti v2 additive storage foundation', () => {
  let adminPool: Pool;
  let pool: Pool;
  let schema: string;
  let scopedDatabaseUrl: string;
  let environmentBeforeSuite: EnvironmentSnapshot;
  let environmentBeforeTest: EnvironmentSnapshot | undefined;

  async function insertV2Row(overrides: V2RowOverrides = {}, runId = runIds[0], index = 0): Promise<void> {
    const row = buildV2Row(runId, index, overrides);
    await pool.query(`INSERT INTO review_event_v2_outbox (
      event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
      schema, event_kind, occurred_at, sequence_domain, correlation_id, trace_id, visibility, payload,
      state, attempt_count, lease_owner, lease_expires_at, publish_acknowledged_at, publish_ack
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'review-yeti-event.v2', $9, $10,
      'pr_lifecycle_v2', $11, $12, 'internal', $13, $14, $15, $16, $17, $18, $19)`, [
      row.eventId,
      row.runId,
      row.attemptId,
      row.repositoryId,
      row.prNumber,
      baseSha,
      headSha,
      row.sequence,
      row.eventKind,
      row.occurredAt,
      row.correlationId,
      row.traceId,
      JSON.stringify(row.payload),
      row.state,
      row.attemptCount,
      row.leaseOwner,
      row.leaseExpiresAt,
      row.publishAcknowledgedAt,
      row.publishAck,
    ]);
  }

  async function expectConstraintFailure(action: () => Promise<unknown>, constraintPattern: RegExp): Promise<void> {
    let error: { constraint?: string; message?: string } | undefined;
    try {
      await action();
    } catch (caught) {
      error = caught as { constraint?: string; message?: string };
    }
    if (!error) throw new Error('Expected the database operation to fail, but it succeeded');
    expect(error.constraint, error.message).toMatch(constraintPattern);
  }

  beforeAll(async () => {
    environmentBeforeSuite = snapshotEnvironment();
    schema = `review_yeti_v2_storage_test_${randomBytes(8).toString('hex')}`;
    if (!ownedSchema.test(schema)) throw new Error(`Generated schema is not owned by this test: ${schema}`);
    adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` });
    await createLegacyPreV2State();
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    scopedDatabaseUrl = url.toString();
  });

  beforeEach(async () => {
    environmentBeforeTest = snapshotEnvironment();
    try {
      configureFixtureEnvironment(scopedDatabaseUrl);
      await pool.query('DROP TABLE IF EXISTS review_event_v2_outbox, review_event_v2_sequence_counters CASCADE');
    } catch (error) {
      restoreEnvironment(environmentBeforeTest);
      environmentBeforeTest = undefined;
      throw error;
    }
  });

  afterEach(async () => {
    try {
      if (!pool) return;
      await pool.query('DROP TABLE IF EXISTS review_event_v2_outbox, review_event_v2_sequence_counters CASCADE').catch(() => undefined);
    } finally {
      if (environmentBeforeTest) {
        const expectedEnvironment = environmentBeforeTest;
        restoreEnvironment(expectedEnvironment);
        environmentBeforeTest = undefined;
        expectEnvironmentState(expectedEnvironment);
      }
    }
  });

  afterAll(async () => {
    try {
      if (adminPool && ownedSchema.test(schema)) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await pool?.end();
      await adminPool?.end();
      try {
        expectEnvironmentState(environmentBeforeSuite);
      } finally {
        restoreEnvironment(environmentBeforeSuite);
      }
    }
  });

  async function createLegacyPreV2State(): Promise<void> {
    await pool.query(`CREATE TABLE review_runs (
      run_id VARCHAR(255) PRIMARY KEY,
      identity_digest VARCHAR(64) UNIQUE NOT NULL,
      owner VARCHAR(255) NOT NULL,
      repo VARCHAR(255) NOT NULL,
      pr_number BIGINT NOT NULL,
      head_sha VARCHAR(255) NOT NULL,
      base_sha VARCHAR(255) NOT NULL,
      snapshot_digest VARCHAR(64) NOT NULL,
      config_digest VARCHAR(64) NOT NULL,
      effective_policy_digest VARCHAR(64) NOT NULL,
      effective_config_digest VARCHAR(64) NOT NULL,
      index_epoch BIGINT NOT NULL DEFAULT 0,
      identity JSONB NOT NULL,
      publication_mode TEXT NOT NULL DEFAULT 'disabled'
        CHECK (publication_mode IN ('disabled', 'app-gate')),
      status VARCHAR(32) NOT NULL,
      stage VARCHAR(32) NOT NULL,
      attempt INT NOT NULL DEFAULT 0,
      lease_owner VARCHAR(255),
      lease_expires_at TIMESTAMP WITH TIME ZONE,
      publication_fence VARCHAR(64),
      result_digest VARCHAR(64),
      artifacts JSONB NOT NULL DEFAULT '{}'::jsonb,
      error_text TEXT,
      failure_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
      repository_id BIGINT,
      installation_id BIGINT,
      delivery_id TEXT,
      received_at TIMESTAMP WITH TIME ZONE,
      terminal_deadline TIMESTAMP WITH TIME ZONE
    )`);
    await pool.query(REVIEW_EVENT_SCHEMA_SQL);

    for (const [index, runId] of runIds.entries()) {
      await pool.query(`INSERT INTO review_runs (
        run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
        snapshot_digest, config_digest, effective_policy_digest, effective_config_digest,
        identity, status, stage
      ) VALUES ($1, $2, 'legacy-owner', 'legacy-repo', 42, $3, $4, $5, $6, $7, $7, $8, 'completed', 'terminal')`, [
        runId,
        `${String(index + 1).repeat(64)}`,
        headSha,
        baseSha,
        `${String(index + 2).repeat(64)}`,
        `${String(index + 3).repeat(64)}`,
        `${String(index + 4).repeat(64)}`,
        JSON.stringify({ source: 'legacy-fixture', index }),
      ]);
      await pool.query(
        `INSERT INTO review_event_sequence_counters (run_id, next_sequence, updated_at)
         VALUES ($1, $2, '2026-09-11T12:05:00.000Z')`,
        [runId, 7 + index],
      );
    }

    const legacyRows = [
      { runId: runIds[0], state: 'pending', attemptCount: 0, leaseOwner: null, leaseExpiresAt: null, ackAt: null, ack: null },
      { runId: runIds[1], state: 'claimed', attemptCount: 2, leaseOwner: 'legacy-worker', leaseExpiresAt: '2026-09-11T13:00:00.000Z', ackAt: null, ack: null },
      { runId: runIds[2], state: 'published', attemptCount: 3, leaseOwner: null, leaseExpiresAt: null, ackAt: '2026-09-11T12:10:00.000Z', ack: 'legacy-ack-3' },
    ];
    for (const [index, row] of legacyRows.entries()) {
      const payload = v1Payload(row.runId, index + 1);
      await pool.query(`INSERT INTO review_event_outbox (
        event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha, sequence,
        schema, event_kind, occurred_at, correlation_id, trace_id, visibility, payload,
        state, attempt_count, lease_owner, lease_expires_at, next_attempt_at,
        publish_acknowledged_at, publish_ack, created_at, updated_at
      ) VALUES ($1, $2, $3, 123, 42, $4, $5, $6, 'review-yeti-event.v1', 'review.lifecycle.queued',
        '2026-09-11T12:00:00.000Z', $7, $8, 'internal', $9, $10, $11, $12, $13,
        '2026-09-11T12:01:00.000Z', $14, $15, '2026-09-11T12:02:00.000Z', '2026-09-11T12:03:00.000Z')`, [
        payload.event_id,
        row.runId,
        `${row.runId}-attempt`,
        baseSha,
        headSha,
        index + 1,
        payload.correlation_id,
        payload.trace_id,
        JSON.stringify(payload),
        row.state,
        row.attemptCount,
        row.leaseOwner,
        row.leaseExpiresAt,
        row.ackAt,
        row.ack,
      ]);
    }
  }

  async function legacySnapshot(): Promise<{ runs: any[]; counters: any[]; events: any[] }> {
    const runs = (await pool.query(`SELECT run_id, identity_digest, owner, repo, pr_number, head_sha, base_sha,
      snapshot_digest, config_digest, effective_policy_digest, effective_config_digest, index_epoch, identity,
      publication_mode, status, stage, attempt, lease_owner, lease_expires_at, publication_fence, result_digest,
      artifacts, error_text, failure_diagnostics, created_at::text AS created_at, updated_at::text AS updated_at
      FROM review_runs ORDER BY run_id`)).rows;
    const counters = (await pool.query(`SELECT run_id, next_sequence, updated_at::text AS updated_at
      FROM review_event_sequence_counters ORDER BY run_id`)).rows;
    const events = (await pool.query(`SELECT event_id, run_id, attempt_id, repository_id, pr_number, base_sha, head_sha,
      sequence, schema, event_kind, occurred_at::text AS occurred_at, correlation_id, trace_id, visibility,
      payload, encode(convert_to(payload::text, 'UTF8'), 'hex') AS payload_bytes,
      state, attempt_count, lease_owner, lease_expires_at::text AS lease_expires_at,
      next_attempt_at::text AS next_attempt_at, publish_acknowledged_at::text AS publish_acknowledged_at,
      publish_ack, created_at::text AS created_at, updated_at::text AS updated_at
      FROM review_event_outbox ORDER BY event_id`)).rows;
    return { runs, counters, events };
  }

  async function initializeWithFreshStore(): Promise<void> {
    const store = new PostgresStore();
    try {
      await store.initialize();
    } finally {
      await store.close();
    }
  }

  async function initializeConcurrentlyUnderAdvisoryLock(): Promise<void> {
    const blocker = await pool.connect();
    const first = new PostgresStore();
    const second = new PostgresStore();
    let firstInitialization: Promise<void> | undefined;
    let secondInitialization: Promise<void> | undefined;
    let lockAcquired = false;
    let probeError: unknown;

    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
      lockAcquired = true;
      firstInitialization = first.initialize();
      secondInitialization = second.initialize();
      try {
        await vi.waitFor(async () => {
          const probe = await pool.query(`SELECT COUNT(*)::int AS count
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE '%pg_advisory_xact_lock%'`);
          expect(Number(probe.rows[0]?.count ?? 0)).toBeGreaterThanOrEqual(2);
        }, { interval: 10, timeout: 3000 });
      } catch (error) {
        probeError = error;
      }
    } finally {
      if (lockAcquired) {
        await blocker.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => undefined);
      }
      const outcomes = await Promise.allSettled([
        firstInitialization ?? Promise.resolve(),
        secondInitialization ?? Promise.resolve(),
      ]);
      await Promise.all([first.close(), second.close()]);
      blocker.release();
      if (probeError) throw probeError;
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('fulfilled');
      }
    }
  }

  it('runs actual PostgresStore.initialize concurrently and repeatedly without touching pre-v2 history or allocating v2 state', async () => {
    const before = await legacySnapshot();
    expect((await pool.query(`SELECT to_regclass(current_schema() || '.review_event_v2_outbox') AS table_name`)).rows[0].table_name)
      .toBeNull();

    await initializeConcurrentlyUnderAdvisoryLock();
    await initializeWithFreshStore();

    const after = await legacySnapshot();
    expect(after).toEqual(before);
    expect((await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'review_event_v2_%'
      ORDER BY table_name`)).rows.map((row) => row.table_name)).toEqual([
      'review_event_v2_outbox',
      'review_event_v2_sequence_counters',
    ]);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_outbox')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_sequence_counters')).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE '%readiness%'`)).rows).toEqual([]);

    await pool.query(`INSERT INTO review_event_v2_sequence_counters (repository_id, pr_number, next_sequence)
      VALUES (123, 42, 7)`);
    await initializeWithFreshStore();
    expect((await pool.query(`SELECT repository_id, pr_number, next_sequence
      FROM review_event_v2_sequence_counters`)).rows).toEqual([{
      repository_id: '123', pr_number: '42', next_sequence: '7',
    }]);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_outbox')).rows[0].count).toBe(0);
  });

  it('keeps the dormant storage path brokerless and does not allocate v2 rows or readiness state', async () => {
    expect(process.env.NATS_URL).toBeUndefined();
    await initializeWithFreshStore();
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_outbox')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_sequence_counters')).rows[0].count).toBe(0);
    expect((await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE '%readiness%'`)).rows).toEqual([]);
  });

  it('restores exact present and absent fixture environment states without exposing values', () => {
    const baseline = snapshotEnvironment();
    try {
      for (const present of [true, false]) {
        if (present) {
          process.env.DATABASE_URL = 'fixture-present-database';
          process.env.POSTGRES_URL = 'fixture-present-postgres';
          process.env.NATS_URL = 'fixture-present-nats';
        } else {
          for (const key of storageEnvironmentKeys) delete process.env[key];
        }
        const expected = snapshotEnvironment();
        try {
          configureFixtureEnvironment(scopedDatabaseUrl);
        } finally {
          restoreEnvironment(expected);
        }
        expectEnvironmentState(expected);
      }
    } finally {
      restoreEnvironment(baseline);
    }
  });

  it('rejects raw payload shape drift, mismatched JSON types, and invalid lifecycle data', async () => {
    await initializeWithFreshStore();

    await expectConstraintFailure(
      () => insertV2Row({ eventId: eventId(10), repositoryId: 124, prNumber: 50, sequence: 1, payload: {} }),
      /review_event_v2_payload_(?:shape|identity)_check/iu,
    );

    const numericCases = [
      { index: 11, repositoryId: 125, prNumber: 51, field: 'repository_id', value: '125' },
      { index: 12, repositoryId: 126, prNumber: 52, field: 'pr_number', value: '52' },
      { index: 13, repositoryId: 127, prNumber: 53, field: 'sequence', value: '1' },
    ] as const;
    for (const numericCase of numericCases) {
      await expectConstraintFailure(
        () => insertV2Row({
          eventId: eventId(numericCase.index),
          repositoryId: numericCase.repositoryId,
          prNumber: numericCase.prNumber,
          sequence: 1,
          payloadPatch: { [numericCase.field]: numericCase.value },
        }),
        /review_event_v2_payload_identity_check/iu,
      );
    }

    await expectConstraintFailure(
      () => insertV2Row({
        eventId: eventId(14),
        repositoryId: 128,
        prNumber: 54,
        sequence: 1,
        payloadPatch: { occurred_at: '2026-09-11T12:00:01.000Z' },
      }),
      /review_event_v2_payload_identity_check/iu,
    );
    await expectConstraintFailure(
      () => insertV2Row({
        eventId: eventId(15),
        repositoryId: 129,
        prNumber: 55,
        sequence: 1,
        payloadPatch: { unexpected: 'nope' },
      }),
      /review_event_v2_payload_shape_check/iu,
    );

    const invalidDataCases = [
      { index: 16, repositoryId: 130, prNumber: 56, data: { stage: 'terminal', progress: 'in_progress' } },
      { index: 17, repositoryId: 131, prNumber: 57, data: { stage: 'terminal', authorization: 'redacted-test-value' } },
      { index: 18, repositoryId: 132, prNumber: 58, data: { stage: 'terminal', unexpected_field: true } },
      { index: 19, repositoryId: 133, prNumber: 59, data: {
        stage: 'terminal',
        timing: { queued: '2026-09-11T12:00:00.000Z', unexpected_field: 'nope' },
      } },
    ] as const;
    for (const invalidDataCase of invalidDataCases) {
      await expectConstraintFailure(
        () => insertV2Row({
          eventId: eventId(invalidDataCase.index),
          repositoryId: invalidDataCase.repositoryId,
          prNumber: invalidDataCase.prNumber,
          sequence: 1,
          data: invalidDataCase.data,
        }),
        /review_event_v2_payload_shape_check/iu,
      );
    }
  });

  it('enforces independent PR counter keys, valid lease acknowledgements, unique positions, and bounded retry state', async () => {
    await initializeWithFreshStore();
    await pool.query(`INSERT INTO review_event_v2_sequence_counters (repository_id, pr_number, next_sequence)
      VALUES (123, 42, 7), (123, 43, 0)`);
    expect((await pool.query(`SELECT repository_id, pr_number, next_sequence
      FROM review_event_v2_sequence_counters ORDER BY pr_number`)).rows).toEqual([
      { repository_id: '123', pr_number: '42', next_sequence: '7' },
      { repository_id: '123', pr_number: '43', next_sequence: '0' },
    ]);

    await insertV2Row({ eventId: eventId(10), sequence: 8 }, runIds[0], 10);
    await insertV2Row({
      eventId: eventId(20),
      repositoryId: 123,
      prNumber: 43,
      sequence: 1,
      state: 'claimed',
      leaseOwner: 'v2-worker',
      leaseExpiresAt: '2026-09-11T13:00:00.000Z',
    }, runIds[1], 20);
    await insertV2Row({
      eventId: eventId(21),
      repositoryId: 123,
      prNumber: 44,
      sequence: 1,
      state: 'published',
      publishAcknowledgedAt: '2026-09-11T12:10:00.000Z',
      publishAck: 'v2-ack-21',
    }, runIds[2], 21);

    const invalidAcknowledgements = [
      { index: 22, state: 'pending' as const, publishAck: 'pending-ack' },
      { index: 23, state: 'pending' as const, publishAcknowledgedAt: '2026-09-11T12:10:00.000Z' },
      { index: 24, state: 'claimed' as const, leaseOwner: 'v2-worker', leaseExpiresAt: '2026-09-11T13:00:00.000Z', publishAcknowledgedAt: '2026-09-11T12:10:00.000Z' },
      { index: 25, state: 'claimed' as const, leaseOwner: 'v2-worker', leaseExpiresAt: '2026-09-11T13:00:00.000Z', publishAck: 'claimed-ack' },
      { index: 26, state: 'published' as const, publishAcknowledgedAt: '2026-09-11T12:10:00.000Z' },
      { index: 27, state: 'published' as const, publishAck: 'published-ack' },
    ];
    for (const [offset, invalidAcknowledgement] of invalidAcknowledgements.entries()) {
      await expectConstraintFailure(
        () => insertV2Row({
          eventId: eventId(invalidAcknowledgement.index),
          repositoryId: 140 + offset,
          prNumber: 60 + offset,
          sequence: 1,
          state: invalidAcknowledgement.state,
          leaseOwner: invalidAcknowledgement.leaseOwner,
          leaseExpiresAt: invalidAcknowledgement.leaseExpiresAt,
          publishAcknowledgedAt: invalidAcknowledgement.publishAcknowledgedAt,
          publishAck: invalidAcknowledgement.publishAck,
        }),
        /review_event_v2_ack_state_check/iu,
      );
    }

    await expectConstraintFailure(
      () => insertV2Row({ eventId: eventId(28), repositoryId: 123, prNumber: 42, sequence: 8 }, runIds[0], 28),
      /repository_id.*pr_number.*sequence/iu,
    );
    await expectConstraintFailure(
      () => insertV2Row({ eventId: eventId(10), repositoryId: 160, prNumber: 70, sequence: 1 }, runIds[0], 10),
      /review_event_v2_outbox_pkey/iu,
    );
    await expectConstraintFailure(
      () => pool.query(`INSERT INTO review_event_v2_sequence_counters (repository_id, pr_number, next_sequence)
        VALUES (123, 42, 1)`),
      /review_event_v2_sequence_counters_pkey/iu,
    );
    await expectConstraintFailure(
      () => pool.query(`INSERT INTO review_event_v2_sequence_counters (repository_id, pr_number, next_sequence)
        VALUES (123, 44, 9007199254740992)`),
      /review_event_v2_sequence_counters_next_sequence_check/iu,
    );

    const constraints = (await pool.query(`SELECT table_class.relname AS table_name,
      pg_get_constraintdef(constraint_row.oid) AS definition
      FROM pg_constraint AS constraint_row
      JOIN pg_class AS table_class ON table_class.oid = constraint_row.conrelid
      JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_class.relnamespace
      WHERE namespace_row.nspname = current_schema()
        AND table_class.relname IN ('review_event_v2_sequence_counters', 'review_event_v2_outbox')
        AND constraint_row.contype IN ('p', 'u', 'c')`)).rows;
    expect(constraints).toEqual(expect.arrayContaining([
      { table_name: 'review_event_v2_sequence_counters', definition: 'PRIMARY KEY (repository_id, pr_number)' },
      { table_name: 'review_event_v2_outbox', definition: 'UNIQUE (repository_id, pr_number, sequence)' },
    ]));
    expect(constraints.some((row) => row.table_name === 'review_event_v2_outbox'
      && /schema.*review-yeti-event\.v2/iu.test(row.definition))).toBe(true);
    expect(constraints.some((row) => row.table_name === 'review_event_v2_outbox'
      && /sequence_domain.*pr_lifecycle_v2/iu.test(row.definition))).toBe(true);
    expect(constraints.some((row) => row.table_name === 'review_event_v2_outbox'
      && /visibility.*internal/iu.test(row.definition))).toBe(true);
    expect(constraints.some((row) => row.table_name === 'review_event_v2_outbox'
      && /state.*pending.*claimed.*published/iu.test(row.definition))).toBe(true);
    const indexes = (await pool.query(`SELECT indexname FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'review_event_v2_outbox'`)).rows;
    expect(indexes.map((row) => row.indexname)).not.toContain('review_event_v2_aggregate_idx');
  });

  it('rolls back v2 DDL after a controlled post-hook seed failure and recovers on the next initialization', async () => {
    const before = await legacySnapshot();
    delete process.env.NATS_URL;
    const failingSeedData = {
      reviewLogs: [{
        id: null,
        prRun: 'post-hook-failure',
        repo: 'legacy-repo',
        prNumber: 42,
        headSha,
        personas: [],
        quorum: 'majority',
        arbiterVerdict: 'NACK',
        timestamp: '2026-09-11T12:00:00.000Z',
      }],
    } as unknown as DashboardData;
    const failingStore = new PostgresStore();
    let failure: { message?: string } | undefined;
    try {
      await failingStore.initialize(failingSeedData);
    } catch (error) {
      failure = error as { message?: string };
    } finally {
      await failingStore.close();
    }
    expect(failure?.message).toMatch(/null|not-null/iu);
    expect((await pool.query(`SELECT to_regclass(current_schema() || '.review_event_v2_outbox') AS table_name`)).rows[0].table_name)
      .toBeNull();
    expect((await pool.query(`SELECT to_regclass(current_schema() || '.review_event_v2_sequence_counters') AS table_name`)).rows[0].table_name)
      .toBeNull();
    expect(await legacySnapshot()).toEqual(before);

    await initializeWithFreshStore();
    expect((await pool.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name LIKE 'review_event_v2_%'
      ORDER BY table_name`)).rows.map((row) => row.table_name)).toEqual([
      'review_event_v2_outbox',
      'review_event_v2_sequence_counters',
    ]);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_outbox')).rows[0].count).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM review_event_v2_sequence_counters')).rows[0].count).toBe(0);
  });
});
