import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  deriveReviewGateExternalId,
  REVIEW_GATE_CHECK_NAME,
  type ReviewGateCheck,
  type ReviewGateCoordinates,
  type ReviewGateCreateRequest,
  type ReviewGateUpdateRequest,
} from '../../src/github/reviewGateClient';
import {
  gateAttemptId,
  PostgresReviewGateRepository,
  type GatePublicationClaim,
  type StoredReviewGate,
  type TrustedGateCompletionContext,
} from '../../src/persistence/reviewGateRepository';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';
import { ReviewGatePublisher, type ReviewGatePublisherOptions } from '../../src/review/reviewGatePublisher';
import {
  workerReviewCompletionDigest,
  type WorkerReviewCompletion,
} from '../../src/review/workerReviewCompletion';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const OWNED_SCHEMA = /^review_gate_test_[0-9a-f]{16}$/u;
const APP_ID = 7001;
const CONFIG_DIGEST = 'e'.repeat(64);
const WORKER_PROOF = { workerTokenDigest: 'd'.repeat(64) };
const RECEIVED_AT = Date.parse('2026-09-09T12:00:00.000Z');
const COMPLETED_AT = RECEIVED_AT + 60_000;

describeWithPostgres('PostgresReviewGateRepository real SQL lifecycle', () => {
  let pool: Pool | undefined;
  let schemaName: string | undefined;

  function runId(number: number): string {
    return `run_${number.toString(16).padStart(32, '0')}`;
  }

  function coordinatesFor(
    id: string,
    generation: number,
    executionAttempt: number,
  ): ReviewGateCoordinates {
    return {
      owner: 'calltelemetry',
      repo: 'ct-review-actions',
      repositoryId: 3210,
      prNumber: 42,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      policyDigest: 'c'.repeat(64),
      runId: id,
      executionAttempt,
      attemptId: gateAttemptId(id, generation, executionAttempt),
    };
  }

  async function insertRun(
    id: string,
    generation = 0,
    executionAttempt = 0,
    repositoryId = 3210,
    prNumber = 42,
  ): Promise<void> {
    await pool!.query(`
      INSERT INTO review_runs (
        run_id, owner, repo, pr_number, head_sha, base_sha,
        effective_policy_digest, publication_mode, status, attempt, repository_id,
        effective_config_digest, received_at, terminal_deadline, authoritative_gate_app_id
      ) VALUES ($1, 'calltelemetry', 'ct-review-actions', $2, $3, $4,
        $5, 'app-gate', 'queued', $6, $7, $8, to_timestamp($9/1000.0), to_timestamp(($9+900000)/1000.0), $10)
    `, [id, prNumber, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64), generation, repositoryId, CONFIG_DIGEST, RECEIVED_AT, APP_ID]);
    await pool!.query(`
      INSERT INTO review_dispatch_outbox (run_id, status, execution_attempt)
      VALUES ($1, 'pending', $2)
    `, [id, executionAttempt]);
  }

  async function insertExistingGate(
    id: string,
    expectedAppId: number,
    currentAttempt: boolean,
    now: number,
  ): Promise<void> {
    const coordinates = coordinatesFor(id, 0, 1);
    await pool!.query(`
      INSERT INTO review_gate_attempts (
        attempt_id, run_id, review_generation, execution_attempt,
        repository_id, pr_number, expected_app_id, coordinates, external_id,
        desired_state, desired_version, published_version, current_attempt, available_at
      ) VALUES ($1, $2, 0, 1, 3210, 42, $3, $4, $5,
        'cancelled', 1, -1, $6, to_timestamp($7 / 1000.0))
    `, [
      coordinates.attemptId,
      id,
      expectedAppId,
      JSON.stringify(coordinates),
      deriveReviewGateExternalId(coordinates),
      currentAttempt,
      now,
    ]);
  }

  beforeAll(async () => {
    schemaName = `review_gate_test_${randomBytes(8).toString('hex')}`;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error('Generated schema is not owned by this test');

    pool = new Pool({
      connectionString: databaseUrl,
      max: 4,
      options: `-c search_path=${schemaName}`,
    });
    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA "${schemaName}"`);
      await client.query(`
        CREATE TABLE review_runs (
          run_id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          repo TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          head_sha TEXT NOT NULL,
          base_sha TEXT NOT NULL,
          effective_policy_digest TEXT NOT NULL,
          publication_mode TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          repository_id BIGINT NOT NULL,
          effective_config_digest VARCHAR(64) NOT NULL,
          received_at TIMESTAMPTZ NOT NULL,
          terminal_deadline TIMESTAMPTZ,
          stage TEXT NOT NULL DEFAULT 'admission',
          result_digest VARCHAR(64),
          error_text TEXT,
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE review_dispatch_outbox (
          run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          execution_attempt INTEGER NOT NULL DEFAULT 0,
          worker_token_digest VARCHAR(64),
          lease_owner TEXT,
          lease_expires_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await client.query(REVIEW_GATE_SCHEMA_SQL);
    } finally {
      client.release();
    }
  });

  afterEach(async () => {
    await pool?.query('TRUNCATE review_gate_attempts, review_dispatch_outbox, review_runs CASCADE');
  });

  afterAll(async () => {
    if (!schemaName) return;
    if (!OWNED_SCHEMA.test(schemaName)) throw new Error(`Refusing to drop unowned schema: ${schemaName}`);
    try {
      await pool?.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await pool?.end();
      pool = undefined;
    }
  });

  it('makes same-generation reserve idempotent', async () => {
    const id = runId(1);
    await insertRun(id);
    const repository = new PostgresReviewGateRepository(pool!);

    const first = await repository.reserve(id, APP_ID, 1_000);
    const retry = await repository.reserve(id, APP_ID, 2_000);

    expect(retry).toMatchObject({
      coordinates: first!.coordinates,
      reviewGeneration: 0,
      expectedAppId: APP_ID,
      externalId: first!.externalId,
      current: true,
    });
    const rows = await pool!.query(
      'SELECT attempt_id, expected_app_id, current_attempt FROM review_gate_attempts',
    );
    expect(rows.rows).toEqual([{
      attempt_id: first!.coordinates.attemptId,
      expected_app_id: String(APP_ID),
      current_attempt: true,
    }]);
  });

  it('rolls back supersession when a different App identity conflicts', async () => {
    const currentRun = runId(2);
    const conflictingRun = runId(3);
    await insertRun(currentRun);
    await insertRun(conflictingRun);
    const repository = new PostgresReviewGateRepository(pool!);
    const current = await repository.reserve(currentRun, APP_ID, 1_000);

    // The conflicting generation is already persisted but stale. The attempted
    // reservation must not cancel the current row before its identity conflict
    // aborts the transaction.
    await insertExistingGate(conflictingRun, APP_ID + 1, false, 1_000);
    await expect(repository.reserve(conflictingRun, APP_ID + 2, 2_000))
      .rejects.toThrow('Gate reservation conflicts with persisted identity');

    const rows = await pool!.query(`
      SELECT run_id, current_attempt, desired_state, desired_version, expected_app_id
        FROM review_gate_attempts
       ORDER BY run_id
    `);
    expect(rows.rows).toEqual([
      {
        run_id: currentRun,
        current_attempt: true,
        desired_state: 'queued',
        desired_version: '0',
        expected_app_id: String(APP_ID),
      },
      {
        run_id: conflictingRun,
        current_attempt: false,
        desired_state: 'cancelled',
        desired_version: '1',
        expected_app_id: String(APP_ID + 1),
      },
    ]);
    expect(current!.current).toBe(true);
  });

  it('keeps independent gate history for one run across generations with unchanged execution attempt', async () => {
    const id = runId(4);
    await insertRun(id, 0, 0);
    const repository = new PostgresReviewGateRepository(pool!);

    const first = await repository.reserve(id, APP_ID, 1_000);
    await pool!.query('UPDATE review_runs SET attempt = 1 WHERE run_id = $1', [id]);
    const sourceState = await pool!.query(`
      SELECT runs.attempt, outbox.execution_attempt
        FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
       WHERE runs.run_id = $1
    `, [id]);
    expect(sourceState.rows[0]).toEqual({ attempt: 1, execution_attempt: 0 });
    const second = await repository.reserve(id, APP_ID, 2_000);

    expect(first!.coordinates.runId).toBe(second!.coordinates.runId);
    expect(first!.coordinates.executionAttempt).toBe(second!.coordinates.executionAttempt);
    expect(first!.reviewGeneration).toBe(0);
    expect(second!.reviewGeneration).toBe(1);
    expect(first!.coordinates.attemptId).toBe(`${id}-g0-e1`);
    expect(second!.coordinates.attemptId).toBe(`${id}-g1-e1`);
    expect(second!.externalId).not.toBe(first!.externalId);

    const historyRows = await pool!.query(`
      SELECT run_id, review_generation, execution_attempt, attempt_id, external_id, current_attempt
        FROM review_gate_attempts
       ORDER BY review_generation
    `);
    expect(historyRows.rows).toEqual([
      {
        run_id: id,
        review_generation: 0,
        execution_attempt: 1,
        attempt_id: first!.coordinates.attemptId,
        external_id: first!.externalId,
        current_attempt: false,
      },
      {
        run_id: id,
        review_generation: 1,
        execution_attempt: 1,
        attempt_id: second!.coordinates.attemptId,
        external_id: second!.externalId,
        current_attempt: true,
      },
    ]);
  });

  it('does not claim superseded reserved gates after two same-PR supersessions', async () => {
    const firstRun = runId(12);
    const secondRun = runId(13);
    const currentRun = runId(14);
    await insertRun(firstRun);
    await insertRun(secondRun);
    await insertRun(currentRun);
    const repository = new PostgresReviewGateRepository(pool!);

    await repository.reserve(firstRun, APP_ID, 1_000);
    await repository.reserve(secondRun, APP_ID, 2_000);
    await repository.reserve(currentRun, APP_ID, 3_000);

    const currentClaim = await repository.claimPublication('current-worker', 4_000, 5_000);
    expect(currentClaim).toMatchObject({
      current: true,
      mayCreate: true,
      creationState: 'creating',
      coordinates: { runId: currentRun },
    });
    // The current row is leased, so a second claim can only come from one of
    // the two superseded reserved rows if tombstoning failed.
    await expect(repository.claimPublication('other-worker', 4_000, 5_000)).resolves.toBeNull();

    const history = await pool!.query(`
      SELECT run_id, current_attempt, creation_state, desired_state
        FROM review_gate_attempts ORDER BY run_id
    `);
    expect(history.rows).toEqual([
      { run_id: firstRun, current_attempt: false, creation_state: 'reserved', desired_state: 'cancelled' },
      { run_id: secondRun, current_attempt: false, creation_state: 'reserved', desired_state: 'cancelled' },
      { run_id: currentRun, current_attempt: true, creation_state: 'creating', desired_state: 'queued' },
    ]);
  });

  it('rejects a publication claim after its gate is superseded', async () => {
    const staleRun = runId(5);
    const currentRun = runId(6);
    await insertRun(staleRun);
    await insertRun(currentRun);
    const repository = new PostgresReviewGateRepository(pool!);
    await repository.reserve(staleRun, APP_ID, 1_000);
    const staleClaim = (await repository.claimPublication('worker-a', 1_000, 5_000))!;
    await repository.reserve(currentRun, APP_ID, 2_000);

    let publisherCalled = false;
    await expect(repository.publishLocked(staleClaim, async () => {
      publisherCalled = true;
      throw new Error('superseded claim reached publisher');
    }, () => 3_000)).resolves.toBe('stale-claim');
    expect(publisherCalled).toBe(false);

    const staleRow = await pool!.query(`
      SELECT current_attempt, desired_state, check_id, lease_owner
        FROM review_gate_attempts WHERE attempt_id = $1
    `, [staleClaim.coordinates.attemptId]);
    expect(staleRow.rows[0]).toEqual({
      current_attempt: false,
      desired_state: 'cancelled',
      check_id: null,
      lease_owner: 'worker-a',
    });
  });

  it('leases one publication under real concurrency and never grants create again after expiry or retry', async () => {
    const id = runId(6);
    await insertRun(id);
    const repository = new PostgresReviewGateRepository(pool!);
    await repository.reserve(id, APP_ID, 1_000);

    const claims = await Promise.all([
      repository.claimPublication('worker-a', 1_000, 5_000),
      repository.claimPublication('worker-b', 1_000, 5_000),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    const firstClaim = claims.find((claim) => claim !== null)!;
    expect(firstClaim).toMatchObject({
      creationState: 'creating',
      mayCreate: true,
    });

    const expiredClaim = await repository.claimPublication('worker-c', 7_000, 5_000);
    expect(expiredClaim).toMatchObject({
      creationState: 'creating',
      mayCreate: false,
      leaseOwner: 'worker-c',
    });
    await expect(repository.retryPublication(firstClaim, 7_000, 1_000, 'transport')).resolves.toBe(false);
    await expect(repository.retryPublication(expiredClaim!, 7_000, 1_000, 'unknown-create')).resolves.toBe(true);

    const retriedClaim = await repository.claimPublication('worker-d', 8_001, 5_000);
    expect(retriedClaim).toMatchObject({
      creationState: 'creating',
      mayCreate: false,
      leaseOwner: 'worker-d',
    });
    const state = await pool!.query(
      'SELECT creation_state, lease_owner FROM review_gate_attempts WHERE attempt_id = $1',
      [firstClaim.coordinates.attemptId],
    );
    expect(state.rows[0]).toEqual({ creation_state: 'creating', lease_owner: 'worker-d' });
  });

  it('retains committed creation intent when the publisher throws after external acceptance', async () => {
    const id = runId(8);
    await insertRun(id);
    const repository = new PostgresReviewGateRepository(pool!);
    await repository.reserve(id, APP_ID, 1_000);
    const claim = (await repository.claimPublication('worker-a', 1_000, 5_000))!;
    let externallyAccepted = false;

    await expect(repository.publishLocked(claim, async () => {
      externallyAccepted = true;
      throw new Error('accepted by external provider before acknowledgement');
    }, () => 2_000)).rejects.toThrow('accepted by external provider');
    expect(externallyAccepted).toBe(true);

    const retained = await pool!.query(`
      SELECT creation_state, check_id, published_version, lease_owner
        FROM review_gate_attempts WHERE attempt_id = $1
    `, [claim.coordinates.attemptId]);
    expect(retained.rows[0]).toEqual({
      creation_state: 'creating',
      check_id: null,
      published_version: '-1',
      lease_owner: 'worker-a',
    });
    const retryClaim = await repository.claimPublication('worker-b', 7_000, 5_000);
    expect(retryClaim).toMatchObject({ creationState: 'creating', mayCreate: false });
  });

  it('binds an exact queued check and marks the desired version published', async () => {
    const id = runId(9);
    await insertRun(id);
    const repository = new PostgresReviewGateRepository(pool!);
    await repository.reserve(id, APP_ID, 1_000);
    const claim = (await repository.claimPublication('worker-a', 1_000, 5_000))!;
    const checkId = 8080;

    await expect(repository.publishLocked(claim, async (gate, mayCreate) => {
      expect(mayCreate).toBe(true);
      expect(gate).toMatchObject({
        expectedAppId: APP_ID,
        externalId: claim.externalId,
        checkId: null,
        desiredState: 'queued',
      });
      return {
        id: checkId,
        name: REVIEW_GATE_CHECK_NAME,
        appId: APP_ID,
        headSha: claim.coordinates.headSha,
        externalId: claim.externalId,
        status: 'queued',
        conclusion: null,
      };
    }, () => 2_000)).resolves.toBe('published');

    const bound = await pool!.query(`
      SELECT creation_state, check_id, published_version, lease_owner, lease_expires_at
        FROM review_gate_attempts WHERE attempt_id = $1
    `, [claim.coordinates.attemptId]);
    expect(bound.rows[0]).toEqual({
      creation_state: 'bound',
      check_id: String(checkId),
      published_version: '0',
      lease_owner: null,
      lease_expires_at: null,
    });
  });

  it('rolls back locked publication when the callback returns a mismatched check identity', async () => {
    const id = runId(10);
    await insertRun(id);
    const repository = new PostgresReviewGateRepository(pool!);
    await repository.reserve(id, APP_ID, 1_000);
    const claim = (await repository.claimPublication('worker-a', 1_000, 5_000))!;

    await expect(repository.publishLocked(claim, async () => ({
      id: 10_010,
      name: REVIEW_GATE_CHECK_NAME,
      appId: APP_ID,
      headSha: claim.coordinates.headSha,
      externalId: `${claim.externalId}-wrong-identity`,
      status: 'queued',
      conclusion: null,
    }), () => 2_000)).rejects.toThrow('Published gate did not match the locked attempt');

    const retained = await pool!.query(`
      SELECT creation_state, check_id, published_version, lease_owner
        FROM review_gate_attempts WHERE attempt_id = $1
    `, [claim.coordinates.attemptId]);
    expect(retained.rows[0]).toEqual({
      creation_state: 'creating',
      check_id: null,
      published_version: '-1',
      lease_owner: 'worker-a',
    });
    const retryClaim = await repository.claimPublication('worker-b', 7_000, 5_000);
    expect(retryClaim).toMatchObject({ creationState: 'creating', mayCreate: false });
  });

  it('fences same-worker ABA claims with the lease token', async () => {
    const id = runId(11);
    await insertRun(id);
    const repository = new PostgresReviewGateRepository(pool!);
    await repository.reserve(id, APP_ID, 1_000);

    const originalClaim = (await repository.claimPublication('same-worker', 1_000, 5_000))!;
    const reclaimedClaim = (await repository.claimPublication('same-worker', 7_000, 5_000))!;
    expect(originalClaim.leaseOwner).toBe(reclaimedClaim.leaseOwner);
    expect(originalClaim.leaseToken).not.toBe(reclaimedClaim.leaseToken);
    expect(originalClaim.mayCreate).toBe(true);
    expect(reclaimedClaim).toMatchObject({ creationState: 'creating', mayCreate: false });

    let publisherCalled = false;
    await expect(repository.publishLocked(originalClaim, async () => {
      publisherCalled = true;
      throw new Error('ABA claim reached publisher');
    }, () => 7_001)).resolves.toBe('stale-claim');
    expect(publisherCalled).toBe(false);
    await expect(repository.retryPublication(originalClaim, 7_000, 1_000, 'stale-claim')).resolves.toBe(false);

    const currentRow = await pool!.query(`
      SELECT creation_state, lease_owner, lease_token
        FROM review_gate_attempts WHERE attempt_id = $1
    `, [reclaimedClaim.coordinates.attemptId]);
    expect(currentRow.rows[0]).toEqual({
      creation_state: 'creating',
      lease_owner: 'same-worker',
      lease_token: reclaimedClaim.leaseToken,
    });
  });

  describe('known-not-started publication recovery', () => {
    async function publishingFixture() {
      const id = runId(200);
      let now = RECEIVED_AT + 1_000;
      await insertRun(id);
      const repository = new PostgresReviewGateRepository(pool!);
      const gate = (await repository.reserve(id, APP_ID, now))!;
      const external = new Map<string, ReviewGateCheck>();
      const client = {
        createPending: vi.fn(async (request: ReviewGateCoordinates | ReviewGateCreateRequest): Promise<ReviewGateCheck> => {
          const coordinates = 'coordinates' in request ? request.coordinates : request;
          const check: ReviewGateCheck = { id: 20_001, name: REVIEW_GATE_CHECK_NAME, appId: APP_ID,
            headSha: coordinates.headSha, externalId: deriveReviewGateExternalId(coordinates), status: 'queued', conclusion: null };
          external.set(check.externalId, check);
          return check;
        }),
        reconcile: vi.fn(async (coordinates: ReviewGateCoordinates) => external.get(deriveReviewGateExternalId(coordinates)) ?? null),
        updateExisting: vi.fn(async (request: ReviewGateUpdateRequest | ReviewGateCoordinates): Promise<ReviewGateCheck> => {
          if (!('coordinates' in request)) throw new Error('Expected publisher request form');
          const { coordinates, checkId, update } = request;
          return {
            id: checkId, name: REVIEW_GATE_CHECK_NAME, appId: APP_ID,
            headSha: coordinates.headSha, externalId: deriveReviewGateExternalId(coordinates),
            status: 'status' in update && update.status ? update.status : 'completed',
            conclusion: 'conclusion' in update && update.conclusion ? update.conclusion : null,
          };
        }),
      };
      const clientFor = vi.fn<ReviewGatePublisherOptions['clientFor']>().mockResolvedValue(client);
      const publisher = new ReviewGatePublisher({ repository, clientFor, workerId: 'preparation-worker',
        retryDelayMs: 1_000, clientFactoryTimeoutMs: 250, now: () => now });
      const state = async () => (await pool!.query(`SELECT to_jsonb(gate) AS gate FROM review_gate_attempts gate
        WHERE attempt_id = $1`, [gate.coordinates.attemptId])).rows[0].gate;
      return { id, repository, gate, client, clientFor, publisher, external, state,
        clock: () => now, advance: (milliseconds: number) => { now += milliseconds; } };
    }

    it('commits factory-failure recovery and eventually creates exactly once under concurrent retry', async () => {
      const f = await publishingFixture();
      const claims = vi.spyOn(f.repository, 'claimPublication');
      f.clientFor.mockRejectedValueOnce(new Error('ghs_private_preparation_detail'));
      expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
      const firstClaim = (await claims.mock.results[0].value)!;
      expect(firstClaim.mayCreate).toBe(true);
      const recovered = await f.state();
      expect(recovered).toMatchObject({ creation_state: 'reserved', check_id: null,
        desired_version: 0, published_version: -1, lease_owner: null, lease_token: null, lease_expires_at: null,
        last_error_class: 'client-preparation' });
      expect(Date.parse(recovered.available_at)).toBe(f.clock() + 1_000);
      expect(f.client.createPending).not.toHaveBeenCalled();
      f.advance(999);
      expect(await f.publisher.runOnce()).toEqual({ status: 'idle' });
      f.advance(1);
      const retries = await Promise.all([f.publisher.runOnce(), f.publisher.runOnce()]);
      expect(retries.map((result) => result.status).sort()).toEqual(['idle', 'published']);
      const newClaim = (await Promise.all(claims.mock.results.map((result) => result.value)))
        .find((claim) => claim && claim.leaseToken !== firstClaim.leaseToken)!;
      expect(newClaim).toMatchObject({ mayCreate: true, coordinates: firstClaim.coordinates });
      expect(f.client.createPending).toHaveBeenCalledExactlyOnceWith(firstClaim.coordinates);
      expect(f.client.updateExisting).toHaveBeenCalledTimes(1);
      expect(await f.state()).toMatchObject({ creation_state: 'bound', check_id: 20_001,
        desired_version: 0, published_version: 0, lease_owner: null, lease_token: null, last_error_class: null });
      expect(await f.publisher.runOnce()).toEqual({ status: 'idle' });
    });

    it('recovers a factory timeout but a late factory resolution cannot create after the recovered retry', async () => {
      const f = await publishingFixture();
      const late = Promise.withResolvers<typeof f.client>();
      f.clientFor.mockReturnValueOnce(late.promise);
      expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
      expect(await f.state()).toMatchObject({ creation_state: 'reserved', last_error_class: 'client-preparation' });
      f.advance(1_000);
      expect(await f.publisher.runOnce()).toMatchObject({ status: 'published' });
      late.resolve(f.client);
      await pool!.query('SELECT 1'); // Let the original factory continuation drain.
      expect(f.client.createPending).toHaveBeenCalledTimes(1);
      expect(f.client.updateExisting).toHaveBeenCalledTimes(1);
      expect(await f.state()).toMatchObject({ creation_state: 'bound', check_id: 20_001 });
    });

    it.each(['create lost ACK', 'update timeout'] as const)('never rearms after %s, even through empty reconciliation and later factory failure', async (failure) => {
      const f = await publishingFixture();
      if (failure === 'create lost ACK') {
        const accept = f.client.createPending.getMockImplementation()!;
        f.client.createPending.mockImplementationOnce(async (coordinates) => {
          await accept(coordinates);
          throw new Error('POST accepted but acknowledgement lost');
        });
      } else f.client.updateExisting.mockRejectedValueOnce(new Error('PATCH timed out after accepted POST'));
      expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
      expect(f.external.size).toBe(1);
      expect(await f.state()).toMatchObject({ creation_state: 'creating', check_id: null, last_error_class: 'unknown-create' });
      f.advance(1_000);
      f.client.reconcile.mockResolvedValueOnce(null);
      expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
      f.advance(1_000);
      f.clientFor.mockRejectedValueOnce(new Error('transient factory outage on an uncertain intent'));
      expect(await f.publisher.runOnce()).toMatchObject({ status: 'retry' });
      expect(await f.state()).toMatchObject({ creation_state: 'creating', check_id: null });
      f.advance(1_000);
      expect(await f.publisher.runOnce()).toMatchObject({ status: 'published' });
      expect(f.client.reconcile).toHaveBeenCalledTimes(2);
      expect(f.client.createPending).toHaveBeenCalledTimes(1);
      expect(await f.state()).toMatchObject({ creation_state: 'bound', check_id: 20_001, published_version: 0 });
    });

    it('does not reset an expired original lease or let its same-worker ABA claim release the new lease', async () => {
      const f = await publishingFixture();
      const original = (await f.repository.claimPublication('same-worker', f.clock(), 1_000))!;
      expect(await f.repository.publishLocked(original, async () => {
        f.advance(1_000);
        return { kind: 'not-started', retryDelayMs: 1_000 };
      }, f.clock)).toBe('stale-claim');
      expect(await f.state()).toMatchObject({ creation_state: 'creating', lease_token: original.leaseToken });
      const current = (await f.repository.claimPublication('same-worker', f.clock(), 5_000))!;
      expect(current).toMatchObject({ mayCreate: false, creationState: 'creating' });
      expect(current.leaseToken).not.toBe(original.leaseToken);
      const staleCallback = vi.fn(async () => ({ kind: 'not-started' as const, retryDelayMs: 1_000 }));
      expect(await f.repository.publishLocked(original, staleCallback, f.clock)).toBe('stale-claim');
      expect(staleCallback).not.toHaveBeenCalled();
      expect(await f.repository.retryPublication(original, f.clock(), 1_000, 'transport')).toBe(false);
      // Even the now-valid lease cannot manufacture known-not-started evidence.
      await expect(f.repository.publishLocked(current, staleCallback, f.clock)).rejects.toThrow('Invalid gate preparation recovery');
      expect(await f.state()).toMatchObject({ creation_state: 'creating', lease_token: current.leaseToken });
    });

    it.each(['attempt', 'owner', 'token', 'version', 'App', 'external ID'] as const)('fences a mismatched %s before accepting not-started recovery', async (mismatch) => {
      const f = await publishingFixture();
      const original = (await f.repository.claimPublication('same-worker', f.clock(), 5_000))!;
      const invalid: GatePublicationClaim = { ...original, coordinates: { ...original.coordinates } };
      switch (mismatch) {
        case 'attempt': invalid.coordinates.attemptId += '-wrong'; break;
        case 'owner': invalid.leaseOwner += '-wrong'; break;
        case 'token': invalid.leaseToken = '00000000-0000-4000-8000-000000000001'; break;
        case 'version': invalid.desiredVersion += 1; break;
        case 'App': invalid.expectedAppId += 1; break;
        case 'external ID': invalid.externalId += '-wrong'; break;
      }
      const before = await f.state();
      const callback = vi.fn(async () => ({ kind: 'not-started' as const, retryDelayMs: 1_000 }));
      expect(await f.repository.publishLocked(invalid, callback, f.clock)).toBe('stale-claim');
      expect(callback).not.toHaveBeenCalled();
      expect(await f.state()).toEqual(before);
    });

    it('cannot reset a bound check even if a caller supplies mayCreate true', async () => {
      const f = await publishingFixture();
      await f.publisher.runOnce();
      await pool!.query(`UPDATE review_gate_attempts SET desired_state = 'failure', desired_version = desired_version + 1
        WHERE attempt_id = $1`, [f.gate.coordinates.attemptId]);
      const bound = (await f.repository.claimPublication('same-worker', f.clock(), 5_000))!;
      const before = await f.state();
      await expect(f.repository.publishLocked({ ...bound, mayCreate: true }, async () => ({
        kind: 'not-started', retryDelayMs: 1_000,
      }), f.clock)).rejects.toThrow('Invalid gate preparation recovery');
      expect(await f.state()).toEqual(before);
    });

    it.each([999, 300_001, 1_000.5, Infinity, NaN])('rejects unbounded preparation backoff %s without resetting the intent', async (retryDelayMs) => {
      const f = await publishingFixture();
      const claim = (await f.repository.claimPublication('same-worker', f.clock(), 5_000))!;
      const before = await f.state();
      await expect(f.repository.publishLocked(claim, async () => ({ kind: 'not-started', retryDelayMs }), f.clock))
        .rejects.toThrow('Invalid gate preparation recovery');
      expect(await f.state()).toEqual(before);
    });

    it('rolls back every reset field together when the recovery UPDATE fails', async () => {
      const f = await publishingFixture();
      const claim = (await f.repository.claimPublication('same-worker', f.clock(), 5_000))!;
      const before = await f.state();
      await pool!.query(`ALTER TABLE review_gate_attempts ADD CONSTRAINT test_reject_preparation_reset
        CHECK (NOT (creation_state = 'reserved' AND last_error_class = 'client-preparation'))`);
      try {
        await expect(f.repository.publishLocked(claim, async () => ({ kind: 'not-started', retryDelayMs: 1_000 }), f.clock))
          .rejects.toMatchObject({ code: '23514', constraint: 'test_reject_preparation_reset' });
        expect(await f.state()).toEqual(before);
        f.advance(5_000);
        expect(await f.repository.claimPublication('new-worker', f.clock(), 5_000))
          .toMatchObject({ mayCreate: false, creationState: 'creating' });
      } finally {
        await pool!.query('ALTER TABLE review_gate_attempts DROP CONSTRAINT test_reject_preparation_reset');
      }
    });

    it('serializes same-head supersession behind preparation recovery and tombstones the old reserved intent', async () => {
      const f = await publishingFixture();
      const newerRun = runId(201);
      await insertRun(newerRun);
      const entered = Promise.withResolvers<void>();
      const factory = Promise.withResolvers<typeof f.client>();
      f.clientFor.mockImplementationOnce(() => { entered.resolve(); return factory.promise; });
      const publishing = f.publisher.runOnce();
      await entered.promise;
      const probe = await pool!.connect();
      let superseding: Promise<StoredReviewGate | null> | undefined;
      try {
        await probe.query('BEGIN');
        const lock = await probe.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired', ['review-dispatch:3210:42']);
        expect(lock.rows[0].acquired).toBe(false);
        await probe.query('COMMIT');
        superseding = f.repository.reserve(newerRun, APP_ID, f.clock());
        factory.reject(new Error('factory unavailable before POST'));
        expect(await publishing).toMatchObject({ status: 'retry' });
        expect(await superseding).toMatchObject({ current: true, coordinates: { runId: newerRun } });
      } finally {
        factory.reject(new Error('test cleanup'));
        await publishing;
        await superseding;
        await probe.query('ROLLBACK');
        probe.release();
      }
      expect(await f.state()).toMatchObject({ creation_state: 'reserved', current_attempt: false,
        desired_state: 'cancelled', desired_version: 1, published_version: 1 });
      f.advance(1_000);
      expect(await f.publisher.runOnce()).toMatchObject({ status: 'published' });
      expect(f.client.createPending).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: newerRun }));
      expect(await f.publisher.runOnce()).toEqual({ status: 'idle' });
    });

    it.each(['failure', 'timeout', 'cancellation'] as const)('retains reaper %s semantics after recovering a never-started intent', async (terminal) => {
      const f = await publishingFixture();
      f.clientFor.mockRejectedValueOnce(new Error('preparation unavailable'));
      await f.publisher.runOnce();
      if (terminal === 'timeout') f.advance(900_000);
      else await pool!.query('UPDATE review_runs SET status = $2 WHERE run_id = $1',
        [f.id, terminal === 'cancellation' ? 'superseded' : 'failed']);
      expect(await f.repository.reapTerminalAttempts(f.clock())).toBe(1);
      const desired = terminal === 'timeout' ? 'timed_out' : terminal === 'cancellation' ? 'cancelled' : 'failure';
      expect(await f.state()).toMatchObject({ creation_state: 'reserved', desired_state: desired,
        desired_version: 1, published_version: terminal === 'cancellation' ? 1 : -1 });
      expect(await f.publisher.runOnce()).toMatchObject({ status: terminal === 'cancellation' ? 'idle' : 'published' });
      expect(f.client.createPending).toHaveBeenCalledTimes(terminal === 'cancellation' ? 0 : 1);
      if (terminal !== 'cancellation') {
        expect(f.client.updateExisting).toHaveBeenCalledWith({ coordinates: f.gate.coordinates,
          checkId: 20_001, update: { conclusion: desired } });
      }
      expect(await f.repository.reapTerminalAttempts(f.clock())).toBe(0);
    });

    it.each(['failed', 'superseded'] as const)('a reaper transition to %s before publication invalidates the original creation claim', async (status) => {
      const f = await publishingFixture();
      const original = (await f.repository.claimPublication('same-worker', f.clock(), 5_000))!;
      await pool!.query('UPDATE review_runs SET status = $2 WHERE run_id = $1', [f.id, status]);
      expect(await f.repository.reapTerminalAttempts(f.clock())).toBe(1);
      const before = await f.state();
      const callback = vi.fn(async () => ({ kind: 'not-started' as const, retryDelayMs: 1_000 }));
      expect(await f.repository.publishLocked(original, callback, f.clock)).toBe('stale-claim');
      expect(callback).not.toHaveBeenCalled();
      expect(await f.state()).toEqual(before);
      const next = (await f.repository.claimPublication('same-worker', f.clock(), 5_000))!;
      expect(next).toMatchObject({ mayCreate: false, creationState: 'creating',
        desiredState: status === 'superseded' ? 'cancelled' : 'failure' });
    });

    it('lets the reaper skip an in-flight factory and cancel the recovered intent once its PR lock is released', async () => {
      const f = await publishingFixture();
      const entered = Promise.withResolvers<void>();
      const factory = Promise.withResolvers<typeof f.client>();
      f.clientFor.mockImplementationOnce(() => { entered.resolve(); return factory.promise; });
      const publishing = f.publisher.runOnce();
      await entered.promise;
      try {
        await pool!.query("UPDATE review_runs SET status = 'superseded' WHERE run_id = $1", [f.id]);
        expect(await f.repository.reapTerminalAttempts(f.clock())).toBe(0);
      } finally {
        factory.reject(new Error('factory unavailable before POST'));
        await publishing;
      }
      expect(await f.repository.reapTerminalAttempts(f.clock())).toBe(1);
      expect(await f.state()).toMatchObject({ creation_state: 'reserved', current_attempt: false,
        desired_state: 'cancelled', published_version: 1, lease_owner: null });
      f.advance(1_000);
      expect(await f.publisher.runOnce()).toEqual({ status: 'idle' });
      expect(f.client.createPending).not.toHaveBeenCalled();
    });
  });

  describe('authenticated worker result transaction', () => {
    async function snapshot(id: string, database: Pick<PoolClient, 'query'> = pool!) {
      const result = await database.query(`
        SELECT to_jsonb(runs) AS run, to_jsonb(outbox) AS outbox,
          (SELECT COALESCE(jsonb_agg(to_jsonb(gate) ORDER BY gate.attempt_id), '[]'::jsonb)
             FROM review_gate_attempts gate WHERE gate.run_id = runs.run_id) AS gates
          FROM review_runs runs LEFT JOIN review_dispatch_outbox outbox USING (run_id)
         WHERE runs.run_id = $1
      `, [id]);
      return result.rows[0];
    }

    async function completionFixture(outboxStatus: 'pending' | 'claimed' | 'projected' = 'projected') {
      const id = runId(100);
      await insertRun(id, 2, 4);
      const repository = new PostgresReviewGateRepository(pool!);
      const gate = (await repository.reserve(id, APP_ID, RECEIVED_AT + 1_000))!;
      const claim = (await repository.claimPublication('test-publisher', RECEIVED_AT + 2_000, 5_000))!;
      // Simulate the trusted App's response locally; there is no GitHub client.
      await repository.publishLocked(claim, async () => ({
        id: 8080, name: REVIEW_GATE_CHECK_NAME, appId: APP_ID,
        headSha: gate.coordinates.headSha, externalId: gate.externalId,
        status: 'queued', conclusion: null,
      }), () => RECEIVED_AT + 3_000);
      await pool!.query(`UPDATE review_runs SET status = $2, stage = 'personas',
        lease_owner = 'review-worker', lease_expires_at = to_timestamp($3/1000.0)
        WHERE run_id = $1`, [id, outboxStatus === 'projected' ? 'running' : 'queued', COMPLETED_AT + 60_000]);
      await pool!.query(`UPDATE review_dispatch_outbox SET status = $2,
        worker_token_digest = $3, lease_owner = 'dispatcher',
        lease_expires_at = to_timestamp($4/1000.0) WHERE run_id = $1`,
      [id, outboxStatus, WORKER_PROOF.workerTokenDigest, COMPLETED_AT + 60_000]);

      const event: WorkerReviewCompletion = {
        version: 'WorkerReviewCompletion.v1', runId: id,
        repositoryId: 3210, owner: 'calltelemetry', repo: 'ct-review-actions', prNumber: 42,
        headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
        policyDigest: 'c'.repeat(64), configDigest: CONFIG_DIGEST, executionAttempt: 5,
        result: {
          version: 'WorkerReviewResult.v1',
          completedAt: new Date(COMPLETED_AT - 10_000).toISOString(),
          personas: [
            { id: 'sec-lane', decision: 'APPROVE', findings: [] },
            { id: 'arch-lane', decision: 'APPROVE', findings: [] },
          ],
          coverageComplete: true, quorumSatisfied: true,
        },
      };
      const trusted: TrustedGateCompletionContext = {
        current: {
          repositoryId: event.repositoryId, prNumber: event.prNumber,
          headSha: event.headSha, baseSha: event.baseSha, policyDigest: event.policyDigest,
          open: true, draft: false,
        },
        coverage: {
          expectedPersonaIds: ['sec-lane', 'arch-lane'],
          changedFiles: [{ path: 'src/example.ts', patch: '@@ -0,0 +1 @@\n+const first = 1;\n' }],
          coverageComplete: true, quorumSatisfied: true,
        },
      };
      const resolve = vi.fn(async (_gate: StoredReviewGate) => trusted);
      return { id, repository, gate, event, trusted, resolve };
    }

    function expectTerminalState(
      state: Awaited<ReturnType<typeof snapshot>>,
      event: WorkerReviewCompletion,
      status: 'success' | 'failure' | 'cancelled' | 'timed_out',
      reason: string,
    ): void {
      const digest = workerReviewCompletionDigest(event);
      expect(state.run).toMatchObject({
        status: status === 'success' ? 'succeeded' : status === 'cancelled' ? 'superseded' : 'failed',
        stage: 'publish', result_digest: digest,
        error_text: status === 'success' ? null : `review gate: ${reason}`,
        lease_owner: null, lease_expires_at: null,
      });
      expect(state.outbox).toMatchObject({
        status: 'projected', execution_attempt: 4, worker_token_digest: WORKER_PROOF.workerTokenDigest,
        lease_owner: null, lease_expires_at: null,
      });
      expect(state.gates).toHaveLength(1);
      expect(state.gates[0]).toMatchObject({
        creation_state: 'bound', check_id: 8080, current_attempt: status !== 'cancelled',
        desired_state: status, desired_version: 1, published_version: 0,
        worker_result_digest: digest, decision: { status, eligible: status === 'success', reason },
        lease_owner: null, lease_token: null, lease_expires_at: null,
      });
    }

    it.each([null, APP_ID + 1])('rejects completion without the exact enrolled App marker (%s)', async (appId) => {
      const { id, repository, event, resolve } = await completionFixture();
      await pool!.query('UPDATE review_runs SET authoritative_gate_app_id = $2 WHERE run_id = $1', [id, appId]);
      const before = await snapshot(id);
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('unauthorized');
      expect(resolve).not.toHaveBeenCalled();
      expect(await snapshot(id)).toEqual(before);
    });

    it.each(['pending', 'claimed', 'projected'] as const)('reaps expired %s work without losing the possible worker execution', async (outboxStatus) => {
      const { id, repository, gate, event, resolve } = await completionFixture(outboxStatus);
      const deadline = RECEIVED_AT + 900_000;
      expect(await repository.reapTerminalAttempts(deadline - 1)).toBe(0);
      expect(await repository.reapTerminalAttempts(deadline)).toBe(1);
      const state = await snapshot(id);
      expect(state.run).toMatchObject({ status: 'failed', stage: 'publish', error_text: 'review gate: review-deadline-exceeded' });
      expect(state.outbox).toMatchObject({ status: 'projected', execution_attempt: 4,
        worker_token_digest: WORKER_PROOF.workerTokenDigest, lease_owner: null, lease_expires_at: null });
      expect(state.gates[0]).toMatchObject({ attempt_id: gate.coordinates.attemptId, check_id: 8080,
        desired_state: 'timed_out', desired_version: 1, published_version: 0, current_attempt: true,
        decision: { status: 'timed_out', eligible: false, reason: 'review-deadline-exceeded' } });
      expect(await repository.reapTerminalAttempts(deadline + 1)).toBe(0);
      expect(await repository.recordWorkerResult(event, WORKER_PROOF, resolve, deadline + 1)).toBe('ignored');
      expect(resolve).not.toHaveBeenCalled();
    });

    it('reaps a pre-worker dispatch failure into the same gate without a fabricated worker result', async () => {
      const { id, repository } = await completionFixture('claimed');
      await pool!.query("UPDATE review_runs SET status = 'failed' WHERE run_id = $1", [id]);
      await pool!.query("UPDATE review_dispatch_outbox SET status = 'terminal', worker_token_digest = NULL WHERE run_id = $1", [id]);
      expect(await repository.reapTerminalAttempts(COMPLETED_AT)).toBe(1);
      const state = await snapshot(id);
      expect(state.gates[0]).toMatchObject({ check_id: 8080, desired_state: 'failure', worker_result_digest: null,
        decision: { status: 'failure', eligible: false, reason: 'infrastructure-failure' } });
      expect(state.outbox).toMatchObject({ status: 'terminal', worker_token_digest: null, execution_attempt: 4 });
    });

    it('never reaps a completed result, a foreign App marker or a new generation', async () => {
      const { id, repository, event, resolve } = await completionFixture();
      await repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT);
      const terminal = await snapshot(id);
      expect(await repository.reapTerminalAttempts(RECEIVED_AT + 900_000)).toBe(0);
      expect(await snapshot(id)).toEqual(terminal);
      await pool!.query("UPDATE review_gate_attempts SET desired_state = 'queued' WHERE run_id = $1", [id]);
      await pool!.query("UPDATE review_runs SET status = 'queued', authoritative_gate_app_id = $2 WHERE run_id = $1", [id, APP_ID + 1]);
      expect(await repository.reapTerminalAttempts(RECEIVED_AT + 900_000)).toBe(0);
      await pool!.query('UPDATE review_runs SET authoritative_gate_app_id = $2, attempt = attempt + 1 WHERE run_id = $1', [id, APP_ID]);
      expect(await repository.reapTerminalAttempts(RECEIVED_AT + 900_000)).toBe(0);
    });

    it('skips a PR locked by admission rather than waiting or racing it', async () => {
      const { repository } = await completionFixture();
      const client = await pool!.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['review-dispatch:3210:42']);
        expect(await repository.reapTerminalAttempts(RECEIVED_AT + 900_000)).toBe(0);
      } finally { await client.query('ROLLBACK'); client.release(); }
      expect(await repository.reapTerminalAttempts(RECEIVED_AT + 900_000)).toBe(1);
    });

    it.each([0, 101, 1.5, Infinity])('rejects unbounded reaper limit %s', async (limit) => {
      await expect(new PostgresReviewGateRepository(pool!).reapTerminalAttempts(COMPLETED_AT, limit)).rejects.toThrow('bounds');
    });

    it('advances the same bound gate on projection exactly once and never over a terminal result', async () => {
      const { id, repository, event, resolve } = await completionFixture('projected');
      expect(await repository.advanceProjectedAttempts(COMPLETED_AT - 1)).toBe(1);
      expect((await snapshot(id)).gates[0]).toMatchObject({ check_id: 8080, desired_state: 'in_progress', desired_version: 1 });
      expect(await repository.advanceProjectedAttempts(COMPLETED_AT)).toBe(0);
      await repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT);
      const terminal = await snapshot(id);
      expect(await repository.advanceProjectedAttempts(COMPLETED_AT + 1)).toBe(0);
      expect(await snapshot(id)).toEqual(terminal);
    });

    it.each(['pending', 'claimed'] as const)('does not treat %s dispatch as started work', async (status) => {
      const { repository } = await completionFixture(status);
      expect(await repository.advanceProjectedAttempts(COMPLETED_AT)).toBe(0);
    });

    it('does not advance expired or mismatched execution progress', async () => {
      const { id, repository } = await completionFixture('projected');
      expect(await repository.advanceProjectedAttempts(RECEIVED_AT + 900_000)).toBe(0);
      await pool!.query('UPDATE review_dispatch_outbox SET execution_attempt = execution_attempt + 1 WHERE run_id = $1', [id]);
      expect(await repository.advanceProjectedAttempts(COMPLETED_AT)).toBe(0);
    });

    it('cancels a closed candidate without requiring unavailable diff coverage', async () => {
      const { id, repository, event, resolve, trusted } = await completionFixture();
      trusted.current.open = false;
      trusted.coverage.changedFiles = [];
      trusted.coverage.coverageComplete = false;
      expect(await repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).toBe('recorded');
      expectTerminalState(await snapshot(id), event, 'cancelled', 'pull-request-closed');
    });

    it('atomically commits authenticated success, run completion, dispatch retirement and unpublished gate intent', async () => {
      const { id, event, resolve } = await completionFixture('claimed');
      const before = await snapshot(id);
      const observedUpdates: string[] = [];
      // All SQL still executes in Postgres. A second connection observes each
      // intermediate write, while the transaction connection sees all three.
      const repository = new PostgresReviewGateRepository({
        query: (sql, values) => pool!.query(sql, values),
        connect: async () => {
          const client = await pool!.connect();
          return {
            query: async (sql, values) => {
              if (sql === 'COMMIT') {
                expectTerminalState(await snapshot(id, client), event, 'success', 'clean-review');
                expect(await snapshot(id)).toEqual(before);
              }
              const result = await client.query(sql, values);
              const table = sql.match(/^UPDATE (review_gate_attempts|review_dispatch_outbox|review_runs) /u)?.[1];
              if (table) {
                observedUpdates.push(table);
                expect(await snapshot(id)).toEqual(before);
              }
              return result;
            },
            release: () => client.release(),
          };
        },
      });
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('recorded');
      expect(observedUpdates).toEqual(['review_gate_attempts', 'review_dispatch_outbox', 'review_runs']);
      expectTerminalState(await snapshot(id), event, 'success', 'clean-review');
      expect(resolve).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        checkId: 8080, creationState: 'bound', reviewGeneration: 2,
        coordinates: expect.objectContaining({ runId: id, executionAttempt: 5 }),
      }));
    });

    it.each(['pending', 'claimed', 'projected'] as const)(
      'accepts authenticated completion with outbox %s, including before projection ACK', async (status) => {
        const { id, repository, event, resolve } = await completionFixture(status);
        await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('recorded');
        expectTerminalState(await snapshot(id), event, 'success', 'clean-review');
      },
    );

    it.each(['missing', 'reserved', 'creating', 'superseded'] as const)(
      'requires a current bound gate and ignores a %s gate', async (state) => {
        const { id, repository, event, resolve } = await completionFixture();
        if (state === 'missing') await pool!.query('DELETE FROM review_gate_attempts WHERE run_id = $1', [id]);
        else if (state === 'superseded') {
          await pool!.query('UPDATE review_gate_attempts SET current_attempt = false WHERE run_id = $1', [id]);
        } else {
          await pool!.query('UPDATE review_gate_attempts SET creation_state = $2, check_id = NULL WHERE run_id = $1', [id, state]);
        }
        const before = await snapshot(id);
        await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('ignored');
        expect(resolve).not.toHaveBeenCalled();
        expect(await snapshot(id)).toEqual(before);
      },
    );

    it.each(['f'.repeat(64), 'malformed', ''])(
      'rejects an incorrect or malformed worker token digest %s', async (workerTokenDigest) => {
        const { id, repository, event, resolve } = await completionFixture();
        const before = await snapshot(id);
        await expect(repository.recordWorkerResult(event, { workerTokenDigest }, resolve, COMPLETED_AT)).resolves.toBe('unauthorized');
        expect(resolve).not.toHaveBeenCalled();
        expect(await snapshot(id)).toEqual(before);
      },
    );

    it.each([null, 'malformed'])('rejects missing or malformed persisted token digest %s', async (digest) => {
      const { id, repository, event, resolve } = await completionFixture();
      await pool!.query('UPDATE review_dispatch_outbox SET worker_token_digest = $2 WHERE run_id = $1', [id, digest]);
      const before = await snapshot(id);
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('unauthorized');
      expect(resolve).not.toHaveBeenCalled();
      expect(await snapshot(id)).toEqual(before);
    });

    it.each([
      ['repositoryId', 3211], ['owner', 'other-owner'], ['repo', 'other-repo'], ['prNumber', 43],
      ['headSha', 'f'.repeat(40)], ['baseSha', 'f'.repeat(40)],
      ['policyDigest', 'f'.repeat(64)], ['configDigest', 'f'.repeat(64)], ['executionAttempt', 6],
    ] as const)('rejects mismatched worker %s before resolving evidence', async (field, value) => {
      const { id, repository, event, resolve } = await completionFixture();
      const before = await snapshot(id);
      await expect(repository.recordWorkerResult({ ...event, [field]: value }, WORKER_PROOF, resolve, COMPLETED_AT))
        .resolves.toBe('unauthorized');
      expect(resolve).not.toHaveBeenCalled();
      expect(await snapshot(id)).toEqual(before);
    });

    it('ignores an unknown run without resolving or changing another run', async () => {
      const { id, repository, event, resolve } = await completionFixture();
      const before = await snapshot(id);
      await expect(repository.recordWorkerResult({ ...event, runId: runId(101) }, WORKER_PROOF, resolve, COMPLETED_AT))
        .resolves.toBe('ignored');
      expect(resolve).not.toHaveBeenCalled();
      expect(await snapshot(id)).toEqual(before);
    });

    it.each(['generation', 'execution'] as const)('rejects a persisted %s advance behind the bound gate', async (field) => {
      const { id, repository, event, resolve } = await completionFixture();
      if (field === 'generation') await pool!.query('UPDATE review_runs SET attempt = attempt + 1 WHERE run_id = $1', [id]);
      else await pool!.query('UPDATE review_dispatch_outbox SET execution_attempt = execution_attempt + 1 WHERE run_id = $1', [id]);
      const before = await snapshot(id);
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('unauthorized');
      expect(resolve).not.toHaveBeenCalled();
      expect(await snapshot(id)).toEqual(before);
    });

    it.each(['headSha', 'baseSha', 'policyDigest', 'closed'] as const)(
      'cancels against current trusted %s changes without reviving the candidate', async (field) => {
        const { id, repository, event, resolve, trusted } = await completionFixture();
        if (field === 'closed') trusted.current.open = false;
        else trusted.current[field] = 'f'.repeat(field === 'policyDigest' ? 64 : 40);
        await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('recorded');
        expectTerminalState(await snapshot(id), event, 'cancelled', field === 'closed' ? 'pull-request-closed' : 'candidate-superseded');
        const cancelled = await snapshot(id);
        await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT + 1_000)).resolves.toBe('ignored');
        expect(await snapshot(id)).toEqual(cancelled);
      },
    );

    it.each([
      ['provider-error', 'infrastructure-failure'], ['missing-lane', 'incomplete-review'],
      ['worker-coverage', 'incomplete-review'], ['worker-quorum', 'incomplete-review'],
      ['trusted-coverage', 'incomplete-review'], ['trusted-quorum', 'incomplete-review'],
      ['blocking-finding', 'blocking-findings'], ['invalid-finding', 'invalid-evidence'],
      ['false-worker-verdict', 'invalid-evidence'], ['false-worker-count', 'invalid-evidence'],
      ['duplicate-lane', 'invalid-evidence'], ['unknown-lane', 'invalid-evidence'],
    ] as const)('fails closed for %s with atomic non-success intent', async (scenario, reason) => {
      const { id, repository, event, resolve, trusted } = await completionFixture();
      const lane = event.result.personas[0];
      switch (scenario) {
        case 'provider-error': lane.decision = 'ERROR'; lane.errorClass = 'timeout'; break;
        case 'missing-lane': event.result.personas.pop(); break;
        case 'worker-coverage': event.result.coverageComplete = false; break;
        case 'worker-quorum': event.result.quorumSatisfied = false; break;
        case 'trusted-coverage': trusted.coverage.coverageComplete = false; break;
        case 'trusted-quorum': trusted.coverage.quorumSatisfied = false; break;
        case 'duplicate-lane': event.result.personas[1].id = lane.id; break;
        case 'unknown-lane': lane.id = 'unknown-lane'; break;
        case 'false-worker-count': event.result.findingCount = 99; break;
        default:
          lane.decision = 'FINDINGS';
          lane.findings = [{
            severity: 'P1', path: scenario === 'invalid-finding' ? 'src/unreviewed.ts' : 'src/example.ts',
            line: 1, title: 'Unsafe change', body: 'The changed code exposes private data.',
          }];
          if (scenario === 'false-worker-verdict') event.result.verdict = 'SHIP';
      }
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('recorded');
      const state = await snapshot(id);
      expectTerminalState(state, event, 'failure', reason);
      if (reason === 'invalid-evidence') expect(state.gates[0].evidence).toBeNull();
      else expect(state.gates[0].evidence).not.toBeNull();
    });

    it('uses the service receipt time for evidence and stores eligibility independently of draft readiness', async () => {
      const { id, repository, event, resolve, trusted } = await completionFixture();
      trusted.current.draft = true;
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('recorded');
      const state = await snapshot(id);
      expectTerminalState(state, event, 'success', 'clean-review');
      expect(state.gates[0].evidence.completedAt).toBe(new Date(COMPLETED_AT).toISOString());
      expect(state.gates[0].evidence.completedAt).not.toBe(event.result.completedAt);
      expect(trusted.current.draft).toBe(true);
    });

    it.each([RECEIVED_AT - 1, COMPLETED_AT + 5_001])('fails closed on implausible worker timestamp %s', async (time) => {
      const { id, repository, event, resolve } = await completionFixture();
      event.result.completedAt = new Date(time).toISOString();
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('recorded');
      const state = await snapshot(id);
      expectTerminalState(state, event, 'failure', 'invalid-evidence');
      expect(state.gates[0].evidence).toBeNull();
    });

    it('serializes concurrent exact duplicates and rejects a conflicting second body without another intent', async () => {
      const { id, repository, event, resolve } = await completionFixture();
      const results = await Promise.all([
        repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT),
        repository.recordWorkerResult(structuredClone(event), WORKER_PROOF, resolve, COMPLETED_AT),
      ]);
      expect(results.sort()).toEqual(['duplicate', 'recorded']);
      expect(resolve).toHaveBeenCalledTimes(1);
      const recorded = await snapshot(id);
      expectTerminalState(recorded, event, 'success', 'clean-review');
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT + 1_000)).resolves.toBe('duplicate');
      const conflicting = structuredClone(event);
      conflicting.result.completedAt = new Date(COMPLETED_AT - 9_000).toISOString();
      await expect(repository.recordWorkerResult(conflicting, WORKER_PROOF, resolve, COMPLETED_AT + 2_000)).resolves.toBe('conflict');
      await expect(repository.recordWorkerResult(event, { workerTokenDigest: 'f'.repeat(64) }, resolve, COMPLETED_AT + 3_000))
        .resolves.toBe('unauthorized');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(await snapshot(id)).toEqual(recorded);
    });

    it('bounds an unresponsive completion resolver and leaves no terminal mutation behind', async () => {
      const { id, event } = await completionFixture('claimed');
      const repository = new PostgresReviewGateRepository(pool!, { completionResolutionTimeoutMs: 250 });
      const before = await snapshot(id);
      await expect(repository.recordWorkerResult(event, WORKER_PROOF,
        () => new Promise(() => undefined), COMPLETED_AT)).rejects.toThrow('resolution deadline exceeded');
      expect(await snapshot(id)).toEqual(before);
      // The transaction released its per-PR lock despite the unresolved reader.
      expect(await repository.reserve(id, APP_ID, COMPLETED_AT + 1)).not.toBeNull();
    });

    it.each([RECEIVED_AT + 900_000, RECEIVED_AT + 900_001])('never accepts late worker success at %s', async (now) => {
      const { id, repository, event, resolve } = await completionFixture();
      expect(await repository.recordWorkerResult(event, WORKER_PROOF, resolve, now)).toBe('recorded');
      expect(resolve).not.toHaveBeenCalled();
      expectTerminalState(await snapshot(id), event, 'timed_out', 'review-deadline-exceeded');
    });

    it('rolls back a resolver failure and permits retry against unchanged state', async () => {
      const { id, repository, event, resolve } = await completionFixture('claimed');
      const before = await snapshot(id);
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, async () => {
        throw new Error('synthetic trusted resolver failure');
      }, COMPLETED_AT)).rejects.toThrow('synthetic trusted resolver failure');
      expect(await snapshot(id)).toEqual(before);
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('recorded');
      expectTerminalState(await snapshot(id), event, 'success', 'clean-review');
    });

    it('rolls back gate and outbox writes when the terminal run UPDATE violates an owned DB constraint', async () => {
      const { id, repository, event, resolve } = await completionFixture('claimed');
      const before = await snapshot(id);
      // Only the suite-owned schema is affected, and the constraint is removed
      // even when an assertion fails. This triggers a real SQL error after the
      // gate intent and dispatch retirement UPDATEs have executed.
      await pool!.query("ALTER TABLE review_runs ADD CONSTRAINT test_reject_worker_success CHECK (status <> 'succeeded')");
      try {
        await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT))
          .rejects.toMatchObject({ code: '23514', constraint: 'test_reject_worker_success' });
        expect(await snapshot(id)).toEqual(before);
      } finally {
        await pool!.query('ALTER TABLE review_runs DROP CONSTRAINT test_reject_worker_success');
      }
      await expect(repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT)).resolves.toBe('recorded');
      expectTerminalState(await snapshot(id), event, 'success', 'clean-review');
    });

    it('publishes exact completed/success after a recorded result while retaining the bound check ID', async () => {
      const { id, repository, event, resolve } = await completionFixture();
      await repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT);
      const claim = (await repository.claimPublication('terminal-publisher', COMPLETED_AT, 5_000))!;
      expect(claim).toMatchObject({ checkId: 8080, desiredState: 'success', mayCreate: false, desiredVersion: 1 });
      await expect(repository.publishLocked(claim, async (gate, mayCreate) => {
        expect(mayCreate).toBe(false);
        expect(gate.checkId).toBe(8080);
        return {
          id: 8080, name: REVIEW_GATE_CHECK_NAME, appId: APP_ID,
          headSha: gate.coordinates.headSha, externalId: gate.externalId,
          status: 'completed', conclusion: 'success',
        };
      }, () => COMPLETED_AT + 1_000)).resolves.toBe('published');
      const state = await snapshot(id);
      expect(state.gates[0]).toMatchObject({
        check_id: 8080, creation_state: 'bound', desired_state: 'success',
        desired_version: 1, published_version: 1, lease_owner: null, lease_token: null,
      });
      expect(state.run.result_digest).toBe(workerReviewCompletionDigest(event));
      await expect(repository.claimPublication('unnecessary-retry', COMPLETED_AT + 2_000, 5_000)).resolves.toBeNull();
    });

    it.each([
      { status: 'in_progress', conclusion: null, id: 8080 },
      { status: 'completed', conclusion: 'failure', id: 8080 },
      { status: 'completed', conclusion: 'success', id: 8081 },
    ] as const)('rolls back terminal publication with mismatched returned state or check ID %j', async (returned) => {
      const { id, repository, event, resolve } = await completionFixture();
      await repository.recordWorkerResult(event, WORKER_PROOF, resolve, COMPLETED_AT);
      const claim = (await repository.claimPublication('terminal-publisher', COMPLETED_AT, 5_000))!;
      const before = await snapshot(id);
      await expect(repository.publishLocked(claim, async (gate, mayCreate) => {
        expect(mayCreate).toBe(false);
        expect(gate.checkId).toBe(8080);
        return {
          ...returned, name: REVIEW_GATE_CHECK_NAME, appId: APP_ID,
          headSha: gate.coordinates.headSha, externalId: gate.externalId,
        };
      }, () => COMPLETED_AT + 1_000)).rejects.toThrow('Published gate did not match the locked attempt');
      expect(await snapshot(id)).toEqual(before);
      expect(before.gates[0]).toMatchObject({ check_id: 8080, published_version: 0, desired_version: 1 });
    });
  });
});
