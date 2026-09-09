import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  deriveReviewGateExternalId,
  REVIEW_GATE_CHECK_NAME,
  type ReviewGateCoordinates,
} from '../../src/github/reviewGateClient';
import {
  gateAttemptId,
  PostgresReviewGateRepository,
} from '../../src/persistence/reviewGateRepository';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const OWNED_SCHEMA = /^review_gate_test_[0-9a-f]{16}$/u;
const APP_ID = 7001;

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
        effective_policy_digest, publication_mode, status, attempt, repository_id
      ) VALUES ($1, 'calltelemetry', 'ct-review-actions', $2, $3, $4,
        $5, 'app-gate', 'queued', $6, $7)
    `, [id, prNumber, 'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(64), generation, repositoryId]);
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
      options: `-c search_path=${schemaName},public`,
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
          repository_id BIGINT NOT NULL
        );
        CREATE TABLE review_dispatch_outbox (
          run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
          status TEXT NOT NULL,
          execution_attempt INTEGER NOT NULL DEFAULT 0
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
});
