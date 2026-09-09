import { afterEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { PostgresReviewDispatchRepository } from '../../src/persistence/reviewDispatchRepository';
import { buildReviewRunIdentity } from '../../src/review/reviewAdmission';
import { sha256 } from '../../src/review/reviewCore';
import type { ReviewDispatchClaim } from '../../src/review/reviewRun';

function sameHeadAdmission(deliveryId: string, receivedAt: number, overrides: {
  baseSha?: string; configDigest?: string; policyDigest?: string;
} = {}) {
  // Mirror the authoritative identity's policy provenance without depending on
  // a network adapter. The repository must hash the entire supplied identity.
  const identity = {
    ...buildReviewRunIdentity({
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
      headSha: 'a'.repeat(40), baseSha: overrides.baseSha || 'b'.repeat(40),
      configDigest: overrides.configDigest || 'd'.repeat(64),
    }),
    reviewPolicy: {
      version: 'ReviewPolicyIdentity.v1' as const, repositoryId: 123,
      effectivePolicyDigest: overrides.policyDigest || 'e'.repeat(64),
      sources: [{
        repositoryId: 789, repository: 'calltelemetry/ct-review-actions',
        sha: 'c'.repeat(40), path: 'review-policy.json', contentDigest: 'f'.repeat(64),
      }],
    },
  };
  return {
    deliveryId, eventName: 'pull_request', repositoryId: 123, installationId: 456,
    receivedAt, terminalDeadline: receivedAt + 900_000,
    payloadDigest: sha256(identity), publicationMode: 'app-gate' as const,
    identity, effectivePolicyDigest: identity.reviewPolicy.effectivePolicyDigest,
  };
}

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();

const describeWithPostgres = databaseUrl ? describe : describe.skip;

const claimMutations = ['heartbeat', 'bindWorkerTokenDigest', 'markProjected', 'releaseForRetry', 'markTerminal'] as const;
function mutateClaim(repository: PostgresReviewDispatchRepository, mutation: typeof claimMutations[number], claim: ReviewDispatchClaim, now: number) {
  const fence = [claim.runId, claim.leaseOwner, claim.claimAttempt] as const;
  switch (mutation) {
    case 'heartbeat': return repository.heartbeat(...fence, now, 30_000);
    case 'bindWorkerTokenDigest': return repository.bindWorkerTokenDigest(...fence, 'b'.repeat(64), now);
    case 'markProjected': return repository.markProjected(...fence, 'projection', now, 'b'.repeat(64));
    case 'releaseForRetry': return repository.releaseForRetry(...fence, now, now + 5_000);
    case 'markTerminal': return repository.markTerminal(...fence, now, 'projection rejected');
  }
}

async function dispatchState(client: PoolClient, runId: string) {
  return {
    run: (await client.query('SELECT * FROM review_runs WHERE run_id = $1', [runId])).rows[0],
    outbox: (await client.query('SELECT * FROM review_dispatch_outbox WHERE run_id = $1', [runId])).rows[0],
  };
}

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

  async function createRepository() {
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
    return { repository, client };
  }

  describe.each(claimMutations)('%s claim fencing', (mutation) => {
    it('rejects an old same-worker claim after reclaiming the same execution', async () => {
      const { repository, client } = await createRepository();
      await repository.admit(sameHeadAdmission('initial', 1_000));
      const oldClaim = (await repository.claimNext('dispatcher-a', 1_000, 30_000))!;
      const freshClaim = (await repository.claimNext('dispatcher-a', 31_000, 30_000))!;
      expect(oldClaim.claimAttempt).toBe(1);
      expect(freshClaim.claimAttempt).toBe(2);
      expect(freshClaim.executionAttempt).toBe(oldClaim.executionAttempt);
      const before = await dispatchState(client, freshClaim.runId);
      await expect(mutateClaim(repository, mutation, oldClaim, 31_001)).resolves.toBe(false);
      expect(await dispatchState(client, freshClaim.runId)).toEqual(before);
      await expect(mutateClaim(repository, mutation, freshClaim, 31_002)).resolves.toBe(true);
    });

    it('rejects a delayed same-worker claim across failed-worker re-admission', async () => {
      const { repository, client } = await createRepository();
      const input = sameHeadAdmission('initial', 1_000);
      await repository.admit(input);
      const oldClaim = (await repository.claimNext('dispatcher-a', 1_000, 30_000))!;
      await expect(repository.markProjected(oldClaim.runId, oldClaim.leaseOwner, oldClaim.claimAttempt,
        'prior-projection', 1_100, 'a'.repeat(64))).resolves.toBe(true);
      // Worker callbacks remain execution-bound, not dispatcher-claim-bound.
      await expect(repository.markWorkerFailure({
        version: 'WorkerTerminalFailure.v1', runId: oldClaim.runId,
        owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
        headSha: input.identity.headSha, baseSha: input.identity.baseSha,
        repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest,
        configDigest: input.identity.configDigest, executionAttempt: oldClaim.executionAttempt,
        checkId: 4242, failureClass: 'provider_error',
      }, { workerTokenDigest: 'a'.repeat(64) }, 1_200)).resolves.toMatchObject({ status: 'failed' });
      await repository.admit(sameHeadAdmission('retry', 1_300));
      const freshClaim = (await repository.claimNext('dispatcher-a', 1_400, 30_000))!;
      expect(freshClaim.claimAttempt).toBe(oldClaim.claimAttempt + 1);
      expect(freshClaim.executionAttempt).toBe(oldClaim.executionAttempt + 1);
      const before = await dispatchState(client, freshClaim.runId);
      await expect(mutateClaim(repository, mutation, oldClaim, 1_500)).resolves.toBe(false);
      expect(await dispatchState(client, freshClaim.runId)).toEqual(before);
      await expect(mutateClaim(repository, mutation, freshClaim, 1_600)).resolves.toBe(true);
    });

    it('cannot mutate at or after lease expiry even without a reclaim', async () => {
      const { repository, client } = await createRepository();
      await repository.admit(sameHeadAdmission('initial', 1_000));
      const claim = (await repository.claimNext('dispatcher-a', 1_000, 30_000))!;
      const before = await dispatchState(client, claim.runId);
      for (const now of [claim.leaseExpiresAt, claim.leaseExpiresAt + 1]) {
        await expect(mutateClaim(repository, mutation, claim, now)).resolves.toBe(false);
        expect(await dispatchState(client, claim.runId)).toEqual(before);
      }
    });

    it('cannot mutate at or after the run deadline even with an unexpired lease', async () => {
      const { repository, client } = await createRepository();
      await repository.admit(sameHeadAdmission('initial', 1_000));
      const claim = (await repository.claimNext('dispatcher-a', 890_000, 30_000))!;
      expect(claim.leaseExpiresAt).toBeGreaterThan(claim.terminalDeadline + 1);
      const before = await dispatchState(client, claim.runId);
      for (const now of [claim.terminalDeadline, claim.terminalDeadline + 1]) {
        await expect(mutateClaim(repository, mutation, claim, now)).resolves.toBe(false);
        expect(await dispatchState(client, claim.runId)).toEqual(before);
      }
    });
  });

  it('keeps active claims single-owner and advances identity only after durable same-head re-admission', async () => {
    const { repository, client } = await createRepository();
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
    await expect(repository.releaseForRetry(first.run.runId, 'dispatcher-a', firstClaim!.claimAttempt, 2_000, 2_000)).resolves.toBe(true);
    const projectionRetry = await repository.claimNext('dispatcher-a', 3_000, 30_000);
    expect(projectionRetry?.executionAttempt).toBe(1);
    // Exercise digest fencing while every status/lease predicate is valid.
    // A mismatched token must not publish or mutate the still-claimed row.
    await expect(repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-a', projectionRetry!.claimAttempt, 'a'.repeat(64), 3_000))
      .resolves.toBe(true);
    await expect(repository.markProjected(
      first.run.runId, 'dispatcher-a', projectionRetry!.claimAttempt, 'wrong-token-projection', 3_000, 'b'.repeat(64),
    )).resolves.toBe(false);
    expect((await client.query(
      'SELECT status, lease_owner, projection_name, worker_token_digest FROM pg_temp.review_dispatch_outbox WHERE run_id = $1',
      [first.run.runId],
    )).rows[0]).toMatchObject({
      status: 'claimed', lease_owner: 'dispatcher-a', projection_name: null, worker_token_digest: 'a'.repeat(64),
    });
    await expect(repository.markProjected(
      first.run.runId,
      'dispatcher-a',
      projectionRetry!.claimAttempt,
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
    await expect(repository.markTerminal(secondClaim!.runId, 'dispatcher-a', secondClaim!.claimAttempt, 5_000, 'projection rejected')).resolves.toBe(true);
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
    await expect(repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-a', terminalRetry!.claimAttempt, 'b'.repeat(64), 7_010)).resolves.toBe(true);
    const earlyFailure = { ...failure, executionAttempt: 2, failureClass: 'transport' as const };
    await expect(repository.markWorkerFailure(earlyFailure, { workerTokenDigest: 'b'.repeat(64) }, 7_020)).resolves.toMatchObject({ status: 'failed' });
    await expect(repository.markProjected(first.run.runId, 'dispatcher-a', terminalRetry!.claimAttempt, 'late-projection', 7_030, 'b'.repeat(64))).resolves.toBe(false);
    await expect(repository.releaseForRetry(first.run.runId, 'dispatcher-a', terminalRetry!.claimAttempt, 7_030, 7_040)).resolves.toBe(false);
    await repository.admit(admission('delivery-4', 8_000));
    const thirdClaim = await repository.claimNext('dispatcher-b', 8_010, 30_000);
    expect(thirdClaim?.executionAttempt).toBe(3);
    await expect(repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-b', thirdClaim!.claimAttempt, 'c'.repeat(64), 8_020)).resolves.toBe(true);
    await expect(repository.markWorkerFailure(earlyFailure, { workerTokenDigest: 'b'.repeat(64) }, 8_030)).resolves.toMatchObject({ status: 'unauthorized' });

    // An uncertain ensure failure can return the claimed outbox to pending
    // while the already-created worker is reporting its failure.
    await repository.releaseForRetry(first.run.runId, 'dispatcher-b', thirdClaim!.claimAttempt, 8_040, 8_050);
    await expect(repository.markWorkerFailure({ ...failure, executionAttempt: 3 }, { workerTokenDigest: 'c'.repeat(64) }, 8_060)).resolves.toMatchObject({ status: 'failed' });
    await repository.admit(admission('delivery-5', 9_000));
    const fourthClaim = await repository.claimNext('dispatcher-c', 9_010, 30_000);
    expect(fourthClaim?.executionAttempt).toBe(4);
    await repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-c', fourthClaim!.claimAttempt, 'd'.repeat(64), 9_020);
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

  it.each([
    { change: 'base', overrides: { baseSha: '1'.repeat(40) } },
    { change: 'config', overrides: { configDigest: '2'.repeat(64) } },
    { change: 'policy only', overrides: { policyDigest: '3'.repeat(64) } },
  ])('supersedes a same-head $change identity and keeps exact duplicates unchanged', async ({ change, overrides }) => {
    const { repository, client } = await createRepository();
    const priorInput = sameHeadAdmission('prior', 1_000);
    const prior = await repository.admit(priorInput);
    await repository.claimNext('dispatcher-prior', 1_100, 30_000);
    await client.query(`UPDATE review_runs SET status = 'running', lease_owner = 'worker-prior',
      lease_expires_at = to_timestamp(31) WHERE run_id = $1`, [prior.run.runId]);
    const currentInput = sameHeadAdmission('current', 2_000, overrides);
    const current = await repository.admit(currentInput);
    expect(current.run.identity.headSha).toBe(prior.run.identity.headSha);
    expect(current.run.identityDigest).toBe(sha256(currentInput.identity));
    expect(current.run.runId).toBe(`run_${sha256(currentInput.identity).slice(0, 32)}`);
    expect(current.run.runId).not.toBe(prior.run.runId);
    if (change === 'policy only') {
      expect(current.run.identity.baseSha).toBe(prior.run.identity.baseSha);
      expect(current.run.identity.snapshotDigest).toBe(prior.run.identity.snapshotDigest);
      expect(current.run.identity.configDigest).toBe(prior.run.identity.configDigest);
      expect(current.run.effectivePolicyDigest).not.toBe(prior.run.effectivePolicyDigest);
    }
    const priorRun = (await client.query('SELECT * FROM review_runs WHERE run_id = $1', [prior.run.runId])).rows[0];
    expect(priorRun).toMatchObject({
      status: 'superseded', error_text: 'superseded by a newer review identity',
      lease_owner: null, lease_expires_at: null,
    });
    expect((await client.query('SELECT * FROM review_dispatch_outbox WHERE run_id = $1', [prior.run.runId])).rows[0])
      .toMatchObject({ status: 'terminal', lease_owner: null, lease_expires_at: null });
    expect((await repository.claimNext('dispatcher-current', 2_100, 30_000))?.runId).toBe(current.run.runId);

    const state = async () => ({
      runs: (await client.query('SELECT * FROM review_runs ORDER BY run_id')).rows,
      outboxes: (await client.query('SELECT * FROM review_dispatch_outbox ORDER BY run_id')).rows,
    });
    const before = await state();
    expect((await repository.admit(currentInput)).status).toBe('duplicate');
    expect(await state()).toEqual(before);
    const newDelivery = await repository.admit(sameHeadAdmission('current-redelivery', 3_000, overrides));
    expect(newDelivery.run.runId).toBe(current.run.runId);
    expect(await state()).toEqual(before);

    // Neither a stale delivery replay nor a new delivery for a superseded
    // identity can replace/re-arm current work. The adapter must not reserve a
    // gate from the historical run returned by a read-only delivery duplicate.
    const priorDuplicate = await repository.admit(priorInput);
    expect(priorDuplicate.status).toBe('duplicate');
    expect(priorDuplicate.run.status).toBe('superseded');
    await expect(repository.admit(sameHeadAdmission('stale-new-delivery', 4_000)))
      .rejects.toThrow('review run identity conflict: identity is no longer current or publication mode differs');
    expect(await state()).toEqual(before);
    expect((await client.query("SELECT * FROM github_deliveries WHERE delivery_id = 'stale-new-delivery'")).rows).toEqual([]);
    await expect(repository.claimNext('dispatcher-other', 4_100, 30_000)).resolves.toBeNull();
  });

  it.each(['publishing', 'failed', 'terminal'])('retires a prior %s identity so it cannot be retried after identity drift', async (status) => {
    const { repository, client } = await createRepository();
    const prior = await repository.admit(sameHeadAdmission('prior', 1_000));
    await client.query('UPDATE review_runs SET status = $2 WHERE run_id = $1', [prior.run.runId, status]);
    await client.query('UPDATE review_dispatch_outbox SET status = $2 WHERE run_id = $1', [prior.run.runId, status === 'terminal' ? 'terminal' : 'projected']);
    const current = await repository.admit(sameHeadAdmission('current', 2_000, { policyDigest: '1'.repeat(64) }));
    expect((await client.query('SELECT status FROM review_runs WHERE run_id = $1', [prior.run.runId])).rows[0].status).toBe('superseded');
    await expect(repository.admit(sameHeadAdmission('stale-retry', 3_000))).rejects.toThrow(/review run identity conflict/u);
    expect((await repository.claimNext('dispatcher-current', 3_100, 30_000))?.runId).toBe(current.run.runId);
  });

  it.each([
    { status: 'queued', currentReceivedAt: 2_000 },
    { status: 'failed', currentReceivedAt: 2_000 },
    { status: 'terminal', currentReceivedAt: 2_000 },
    { status: 'succeeded', currentReceivedAt: 2_000 },
    { status: 'queued', currentReceivedAt: 1_000 },
  ])('fences legacy $status history behind a different identity admitted at $currentReceivedAt', async ({ status, currentReceivedAt }) => {
    const { repository, client } = await createRepository();
    const prior = await repository.admit(sameHeadAdmission('prior', 1_000));
    const current = await repository.admit(sameHeadAdmission('current', currentReceivedAt, { baseSha: '1'.repeat(40) }));
    // Model the pre-fix head-only admission bug: the old row remained active or
    // retryable instead of being tombstoned when the same-head identity changed.
    await client.query("UPDATE review_runs SET status = $2, error_text = NULL WHERE run_id = $1", [prior.run.runId, status]);
    await client.query("UPDATE review_dispatch_outbox SET status = 'pending' WHERE run_id = $1", [prior.run.runId]);
    const state = async () => ({
      runs: (await client.query('SELECT * FROM review_runs ORDER BY run_id')).rows,
      outboxes: (await client.query('SELECT * FROM review_dispatch_outbox ORDER BY run_id')).rows,
    });
    const before = await state();
    await expect(repository.admit(sameHeadAdmission('stale-legacy', 3_000))).rejects.toThrow(/review run identity conflict/u);
    expect(await state()).toEqual(before);
    expect((await client.query("SELECT * FROM github_deliveries WHERE delivery_id = 'stale-legacy'")).rows).toEqual([]);
    expect(before.runs.find((run) => run.run_id === current.run.runId).status).toBe('queued');
  });
});
