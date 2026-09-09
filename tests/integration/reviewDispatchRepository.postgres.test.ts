import { afterEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();

const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres('PostgresReviewDispatchRepository real SQL lifecycle', () => {
  let pool: Pool | undefined;
  let client: PoolClient | undefined;

  afterEach(async () => {
    if (client) {
      await client.query('DROP TABLE IF EXISTS pg_temp.review_dispatch_outbox, pg_temp.review_runs, pg_temp.github_deliveries');
      client.release();
      client = undefined;
    }
    await pool?.end();
    pool = undefined;
  });

  it('keeps active claims single-owner and advances identity only after durable same-head re-admission', async () => {
    pool = new Pool({ connectionString: databaseUrl });
    client = await pool.connect();
    await client.query(`
      CREATE TEMP TABLE pg_temp.github_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        repository_id BIGINT NOT NULL,
        installation_id BIGINT NOT NULL,
        payload_digest CHAR(64) NOT NULL,
        run_id TEXT,
        received_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TEMP TABLE pg_temp.review_runs (
        run_id TEXT PRIMARY KEY,
        identity_digest VARCHAR(64) UNIQUE NOT NULL,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        snapshot_digest VARCHAR(64) NOT NULL,
        config_digest VARCHAR(64) NOT NULL,
        effective_policy_digest VARCHAR(64) NOT NULL,
        effective_config_digest VARCHAR(64) NOT NULL,
        index_epoch BIGINT NOT NULL DEFAULT 0,
        identity JSONB NOT NULL,
        publication_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        repository_id BIGINT,
        installation_id BIGINT,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        publication_fence TEXT,
        result_digest TEXT,
        artifacts JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_text TEXT,
        delivery_id TEXT,
        received_at TIMESTAMPTZ,
        terminal_deadline TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TEMP TABLE pg_temp.review_dispatch_outbox (
        run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id),
        delivery_id TEXT UNIQUE NOT NULL REFERENCES github_deliveries(delivery_id),
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        projection_name TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        execution_attempt INTEGER NOT NULL DEFAULT 0,
        worker_token_digest VARCHAR(64),
        available_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const transactionClient = {
      query: client.query.bind(client),
      release: () => undefined,
    };
    const repository = new PostgresReviewDispatchRepository(
      { connect: async () => transactionClient },
      client,
    );
    const identity = {
      owner: 'calltelemetry',
      repo: 'cisco-cdr',
      prNumber: 42,
      headSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      snapshotDigest: 'c'.repeat(64),
      configDigest: 'd'.repeat(64),
    };
    const admission = (deliveryId: string, receivedAt: number) => ({
      deliveryId,
      eventName: 'pull_request',
      repositoryId: 123,
      installationId: 456,
      receivedAt,
      terminalDeadline: receivedAt + 900_000,
      payloadDigest: 'f'.repeat(64),
      publicationMode: 'app-gate' as const,
      identity,
    });

    const first = await repository.admit(admission('delivery-1', 1_000));
    expect(first.status).toBe('accepted');
    const firstClaim = await repository.claimNext('dispatcher-a', 1_000, 30_000);
    expect(firstClaim?.executionAttempt).toBe(1);

    // The lease prevents a second dispatcher from creating a duplicate active
    // projection while the first worker is still starting.
    await expect(repository.claimNext('dispatcher-b', 2_000, 30_000)).resolves.toBeNull();

    // A failed projection releases the same execution identity for retry.
    await expect(repository.releaseForRetry(first.run.runId, 'dispatcher-a', 2_000, 2_000)).resolves.toBe(true);
    const projectionRetry = await repository.claimNext('dispatcher-a', 3_000, 30_000);
    expect(projectionRetry?.executionAttempt).toBe(1);
    await expect(repository.markProjected(
      first.run.runId,
      'dispatcher-a',
      'ct-review-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      3_000,
      'a'.repeat(64),
    )).resolves.toBe(true);

    // A new delivery while the worker is still admitted must not re-arm a
    // projected execution, even if its run remains queued. Otherwise a second
    // dispatcher could mint a duplicate Kubernetes identity before the first
    // worker reports a durable failure.
    const queuedReAdmission = await repository.admit(admission('delivery-queued', 3_500));
    expect(queuedReAdmission.status).toBe('accepted');
    const queuedProjectedRow = await client.query(
      'SELECT status, delivery_id, execution_attempt, projection_name FROM pg_temp.review_dispatch_outbox WHERE run_id = $1',
      [first.run.runId],
    );
    expect(queuedProjectedRow.rows[0]).toMatchObject({
      status: 'projected',
      delivery_id: 'delivery-1',
      execution_attempt: 0,
      projection_name: 'ct-review-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    await expect(repository.claimNext('dispatcher-b', 3_600, 30_000)).resolves.toBeNull();

    // The same protection applies after the run enters its active worker state.
    await client.query("UPDATE review_runs SET status = 'running' WHERE run_id = $1", [first.run.runId]);
    const runningReAdmission = await repository.admit(admission('delivery-running', 3_700));
    expect(runningReAdmission.status).toBe('accepted');
    const runningProjectedRow = await client.query(
      'SELECT status, delivery_id, execution_attempt, projection_name FROM pg_temp.review_dispatch_outbox WHERE run_id = $1',
      [first.run.runId],
    );
    expect(runningProjectedRow.rows[0]).toMatchObject({
      status: 'projected',
      delivery_id: 'delivery-1',
      execution_attempt: 0,
      projection_name: 'ct-review-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    await expect(repository.claimNext('dispatcher-b', 3_800, 30_000)).resolves.toBeNull();

    // Only a durable worker failure followed by same-head re-admission creates
    // a fresh execution identity. The callback is idempotent and leaves the
    // projected outbox untouched until admission explicitly re-arms it.
    const failure = {
      version: 'WorkerTerminalFailure.v1' as const,
      runId: first.run.runId,
      owner: identity.owner,
      repo: identity.repo,
      prNumber: identity.prNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      repositoryId: 123,
      policyDigest: identity.configDigest,
      configDigest: identity.configDigest,
      executionAttempt: 1,
      checkId: 4242,
      failureClass: 'provider_error' as const,
    };
    await expect(repository.markWorkerFailure(failure, { workerTokenDigest: 'a'.repeat(64) }, 3_900)).resolves.toEqual({
      runId: first.run.runId,
      status: 'failed',
    });
    const failedRow = await client.query(
      'SELECT status, error_text FROM pg_temp.review_runs WHERE run_id = $1',
      [first.run.runId],
    );
    expect(failedRow.rows[0]).toMatchObject({
      status: 'failed',
      error_text: 'worker terminal failure: provider_error',
    });
    const failedOutbox = await client.query(
      'SELECT status, execution_attempt, projection_name FROM pg_temp.review_dispatch_outbox WHERE run_id = $1',
      [first.run.runId],
    );
    expect(failedOutbox.rows[0]).toMatchObject({
      status: 'projected',
      execution_attempt: 0,
      projection_name: 'ct-review-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    });
    await expect(repository.markWorkerFailure(failure, { workerTokenDigest: 'a'.repeat(64) }, 3_950)).resolves.toEqual({
      runId: first.run.runId,
      status: 'already_failed',
    });
    const projectedReAdmission = await repository.admit(admission('delivery-2', 4_000));
    expect(projectedReAdmission.status).toBe('accepted');
    expect(projectedReAdmission.run.runId).toBe(first.run.runId);
    const projectedRow = await client.query(
      'SELECT worker_token_digest FROM review_dispatch_outbox WHERE run_id = $1',
      [first.run.runId],
    );
    expect(projectedRow.rows[0].worker_token_digest).toBeNull();
    const secondClaim = await repository.claimNext('dispatcher-a', 5_000, 30_000);
    expect(secondClaim?.executionAttempt).toBe(2);

    // A dispatcher-terminal row has no prior worker object to replace, so its
    // same-head re-admission keeps the stored execution counter stable.
    await expect(repository.markTerminal(secondClaim!.runId, 'dispatcher-a', 5_000, 'projection rejected')).resolves.toBe(true);
    const terminalReAdmission = await repository.admit(admission('delivery-3', 6_000));
    expect(terminalReAdmission.status).toBe('accepted');
    const terminalRow = await client.query(
      'SELECT received_at, terminal_deadline FROM review_runs WHERE run_id = $1',
      [first.run.runId],
    );
    expect(terminalRow.rows[0].received_at.getTime()).toBe(6_000);
    expect(terminalRow.rows[0].terminal_deadline.getTime()).toBe(906_000);
    const terminalRetry = await repository.claimNext('dispatcher-a', 7_000, 30_000);
    expect(terminalRetry?.executionAttempt).toBe(2);

    // The Kubernetes write may succeed before markProjected acknowledges it.
    // An authenticated failure from that worker must close the execution and
    // fence both the original dispatch lease and a subsequent projection retry.
    await expect(repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-a', 'b'.repeat(64), 7_010)).resolves.toBe(true);
    const earlyFailure = { ...failure, executionAttempt: 2, failureClass: 'transport' as const };
    await expect(repository.markWorkerFailure(earlyFailure, { workerTokenDigest: 'b'.repeat(64) }, 7_020)).resolves.toMatchObject({ status: 'failed' });
    await expect(repository.markProjected(first.run.runId, 'dispatcher-a', 'late-projection', 7_030, 'b'.repeat(64))).resolves.toBe(false);
    await expect(repository.releaseForRetry(first.run.runId, 'dispatcher-a', 7_030, 7_040)).resolves.toBe(false);
    await repository.admit(admission('delivery-4', 8_000));
    const thirdClaim = await repository.claimNext('dispatcher-b', 8_010, 30_000);
    expect(thirdClaim?.executionAttempt).toBe(3);
    await expect(repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-b', 'c'.repeat(64), 8_020)).resolves.toBe(true);
    await expect(repository.markWorkerFailure(earlyFailure, { workerTokenDigest: 'b'.repeat(64) }, 8_030)).resolves.toMatchObject({ status: 'unauthorized' });

    // An uncertain ensure failure can return the claimed outbox to pending
    // while the already-created worker is reporting its failure.
    await repository.releaseForRetry(first.run.runId, 'dispatcher-b', 8_040, 8_050);
    await expect(repository.markWorkerFailure({ ...failure, executionAttempt: 3 }, { workerTokenDigest: 'c'.repeat(64) }, 8_060)).resolves.toMatchObject({ status: 'failed' });
    await repository.admit(admission('delivery-5', 9_000));
    expect((await repository.claimNext('dispatcher-c', 9_010, 30_000))?.executionAttempt).toBe(4);
    await repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-c', 'd'.repeat(64), 9_020);
    const failingRepository = new PostgresReviewDispatchRepository({ connect: async () => ({
      release: () => undefined,
      query: async (sql: string, values?: unknown[]) => {
        if (/UPDATE review_runs AS runs/u.test(sql)) throw new Error('injected run-write failure');
        return client!.query(sql, values);
      },
    }) });
    await expect(failingRepository.markWorkerFailure({ ...failure, executionAttempt: 4 }, { workerTokenDigest: 'd'.repeat(64) }, 9_030))
      .rejects.toThrow('injected run-write failure');
    // The outbox write preceded the injected fault but must not survive it.
    const rolledBack = await client.query(`SELECT runs.status, outbox.status AS outbox_status, outbox.lease_owner
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id) WHERE run_id = $1`, [first.run.runId]);
    expect(rolledBack.rows[0]).toMatchObject({ status: 'queued', outbox_status: 'claimed', lease_owner: 'dispatcher-c' });
  });
});
