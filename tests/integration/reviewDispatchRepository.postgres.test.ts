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
      await client.query('DROP TABLE IF EXISTS review_dispatch_outbox, review_runs, github_deliveries');
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
      CREATE TEMP TABLE github_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        repository_id BIGINT NOT NULL,
        installation_id BIGINT NOT NULL,
        payload_digest CHAR(64) NOT NULL,
        run_id TEXT,
        received_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TEMP TABLE review_runs (
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
      CREATE TEMP TABLE review_dispatch_outbox (
        run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id),
        delivery_id TEXT UNIQUE NOT NULL REFERENCES github_deliveries(delivery_id),
        status TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        projection_name TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        execution_attempt INTEGER NOT NULL DEFAULT 0,
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
      publicationMode: 'disabled' as const,
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
    )).resolves.toBe(true);

    // Only a durable worker failure followed by same-head re-admission creates
    // a fresh execution identity. This also proves the DO UPDATE SQL parses.
    await client.query("UPDATE review_runs SET status = 'failed', error_text = 'provider failed' WHERE run_id = $1", [first.run.runId]);
    const projectedReAdmission = await repository.admit(admission('delivery-2', 4_000));
    expect(projectedReAdmission.status).toBe('accepted');
    expect(projectedReAdmission.run.runId).toBe(first.run.runId);
    const secondClaim = await repository.claimNext('dispatcher-a', 5_000, 30_000);
    expect(secondClaim?.executionAttempt).toBe(2);

    // A dispatcher-terminal row has no prior worker object to replace, so its
    // same-head re-admission keeps the stored execution counter stable.
    await expect(repository.markTerminal(secondClaim!.runId, 'dispatcher-a', 5_000, 'projection rejected')).resolves.toBe(true);
    const terminalReAdmission = await repository.admit(admission('delivery-3', 6_000));
    expect(terminalReAdmission.status).toBe('accepted');
    const terminalRetry = await repository.claimNext('dispatcher-a', 7_000, 30_000);
    expect(terminalRetry?.executionAttempt).toBe(2);
  });
});
