import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';
import { PostgresReviewDispatchRepository, type ReviewDispatchRepositoryOptions } from '../../src/persistence/reviewDispatchRepository';
import { buildReviewRunIdentity } from '../../src/review/reviewAdmission';
import { sha256 } from '../../src/review/reviewCore';
import type { ReviewDispatchClaim } from '../../src/review/reviewRun';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';
import { PREPARED_REVIEW_SCHEMA_SQL } from '../../src/persistence/preparedReviewRepository';
import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { createHash, randomBytes } from 'node:crypto';
import { REVIEW_GATE_CHECK_NAME } from '../../src/github/reviewGateClient';
import { buildRunSecretName } from '../../src/k8s/reviewJobProjection';
import type { WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';

function authoritativeAdmission(deliveryId = 'authoritative', receivedAt = 1_000) {
  const content = JSON.stringify({ schema: 'calltelemetry.review-policy.v1',
    review_yeti: { personas: 'security,testing', budget: { max_investigation_turns: 2 } } });
  const prepared = preparePublishingPolicy({ content, source: {
    repositoryId: 789, repository: 'calltelemetry/ct-review-actions', sha: 'c'.repeat(40),
    path: 'review-policy.json', contentDigest: createHash('sha256').update(content).digest('hex'),
  } }, { baseUrl: 'https://gateway.example/v1', model: 'review-model' });
  const candidate = { repositoryId: 123, owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40) };
  const identity = buildAuthoritativeReviewIdentity({ requested: candidate,
    current: { ...candidate, open: true, draft: true }, policy: prepared.policy });
  return { ...sameHeadAdmission(deliveryId, receivedAt), identity,
    effectivePolicyDigest: prepared.policy.effectivePolicyDigest,
    authoritativeGate: { expectedAppId: 4385771, prepared } };
}

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
    centralActionDispatch: false,
    identity, effectivePolicyDigest: identity.reviewPolicy.effectivePolicyDigest,
  };
}

const databaseUrl = process.env.REVIEW_YETI_TEST_DATABASE_URL?.trim();

const describeWithPostgres = databaseUrl ? describe : describe.skip;
const trustedValidation: ReviewDispatchRepositoryOptions = { validateAuthoritativeAdmission: async () => undefined };
const ownedSharedSchema = /^review_dispatch_test_[a-f0-9]{16}$/u;

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
  let sharedSchema: string | undefined;

  afterEach(async () => {
    if (client) {
      if (sharedSchema) {
        if (!ownedSharedSchema.test(sharedSchema)) throw new Error('Refusing to remove an unowned test schema');
        await client.query(`DROP SCHEMA ${sharedSchema} CASCADE`);
      } else {
        await client.query('DROP TABLE IF EXISTS pg_temp.review_gate_attempts, pg_temp.prepared_review_policies, pg_temp.review_dispatch_outbox, pg_temp.review_runs, pg_temp.github_deliveries');
      }
      client.release();
      client = undefined;
    }
    await pool?.end();
    pool = undefined;
    sharedSchema = undefined;
  });

  async function createRepository(options: ReviewDispatchRepositoryOptions = trustedValidation, shared = false) {
    if (shared) sharedSchema = `review_dispatch_test_${randomBytes(8).toString('hex')}`;
    pool = new Pool({ connectionString: databaseUrl,
      ...(sharedSchema ? { options: `-c search_path=${sharedSchema},public`, application_name: sharedSchema } : {}) });
    client = await pool.connect();
    if (sharedSchema) await client.query(`CREATE SCHEMA ${sharedSchema}`);
    const fixtureSql = `
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
        failure_diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
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
    `;
    await client.query(sharedSchema ? fixtureSql.replaceAll('CREATE TEMP TABLE pg_temp.', 'CREATE TABLE ') : fixtureSql);
    await client.query(sharedSchema ? REVIEW_GATE_SCHEMA_SQL : REVIEW_GATE_SCHEMA_SQL.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE IF NOT EXISTS'));
    await client.query(sharedSchema ? PREPARED_REVIEW_SCHEMA_SQL : PREPARED_REVIEW_SCHEMA_SQL.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE IF NOT EXISTS'));

    const transactionClient = {
      query: client.query.bind(client),
      release: () => undefined,
    };
    const repository = new PostgresReviewDispatchRepository(
      shared ? pool : { connect: async () => transactionClient },
      shared ? undefined : client,
      options,
    );
    const gateRepository = new PostgresReviewGateRepository(shared ? pool : {
      query: client.query.bind(client), connect: async () => transactionClient,
    });
    return { repository, client, gateRepository };
  }

  async function bindPendingGate(gates: PostgresReviewGateRepository, now = 1_001) {
    const claim = (await gates.claimPublication('gate-publisher', now))!;
    expect(claim).not.toBeNull();
    expect(await gates.publishLocked(claim, async (gate) => ({
      id: now, name: REVIEW_GATE_CHECK_NAME, appId: gate.expectedAppId,
      headSha: gate.coordinates.headSha, externalId: gate.externalId,
      status: 'queued', conclusion: null,
    }), () => now + 1)).toBe('published');
    return claim;
  }

  it.each([false, true])('isolates legacy reconciliation from authoritative enrollment=%s', async (authoritative) => {
    const { repository, client, gateRepository } = await createRepository();
    const input = authoritative ? authoritativeAdmission() : sameHeadAdmission('legacy', 1_000);
    const admitted = await repository.admit(input);
    const now = input.terminalDeadline + 1;
    const claims = await repository.claimAbandonedPublishingRuns('legacy-reaper', now, 1);
    expect(claims).toHaveLength(authoritative ? 0 : 1);
    if (authoritative) {
      // Only the enrolled gate's controller may retire this expired execution.
      expect(await gateRepository.reapTerminalAttempts(now)).toBe(1);
    }
    // Exercise the publication boundary itself with an exact, live reconciliation
    // lease, not just claim selection. An enrolled row must never publish through
    // the legacy adapter even if presented with otherwise matching coordinates.
    await client.query(`UPDATE review_runs SET status = 'terminal', lease_owner = 'legacy-reaper',
      lease_expires_at = to_timestamp(($2+60000)/1000.0) WHERE run_id = $1`, [admitted.run.runId, now]);
    const before = await dispatchState(client, admitted.run.runId);
    const gateBefore = (await client.query('SELECT * FROM review_gate_attempts')).rows;
    const publish = vi.fn(async () => undefined);
    const reconciled = await repository.reconcileAbandonedPublishingRun({
      runId: admitted.run.runId, deliveryId: input.deliveryId, owner: input.identity.owner,
      repo: input.identity.repo, prNumber: input.identity.prNumber, headSha: input.identity.headSha,
      executionAttempt: 1, receivedAt: input.receivedAt, terminalDeadline: input.terminalDeadline,
    }, 'legacy-reaper', now + 1, publish);
    expect(reconciled).toBe(!authoritative);
    expect(publish).toHaveBeenCalledTimes(authoritative ? 0 : 1);
    if (authoritative) expect(await dispatchState(client, admitted.run.runId)).toEqual(before);
    expect((await client.query('SELECT * FROM review_gate_attempts')).rows).toEqual(gateBefore);
  });

  it('claims an expired active run before an older terminal publication retry', async () => {
    const { repository, client } = await createRepository();
    const historicalInput = sameHeadAdmission('historical', 1_000);
    const historical = await repository.admit(historicalInput);
    await client.query(`UPDATE review_runs SET status = 'terminal',
      error_text = 'publishing run reached its terminal deadline without a verdict; reaped by old-reaper'
      WHERE run_id = $1`, [historical.run.runId]);
    await client.query("UPDATE review_dispatch_outbox SET status = 'projected' WHERE run_id = $1", [historical.run.runId]);

    const activeIdentity = { ...sameHeadAdmission('active', 2_000).identity, prNumber: 43 };
    const activeInput = { ...sameHeadAdmission('active', 2_000), identity: activeIdentity,
      payloadDigest: sha256(activeIdentity) };
    const active = await repository.admit(activeInput);

    const [claimed] = await repository.claimAbandonedPublishingRuns(
      'reaper-a', activeInput.terminalDeadline + 1, 1,
    );
    expect(claimed.runId).toBe(active.run.runId);
  });

  it('claims a durable worker failure before the original terminal deadline and retires it once', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('worker-failed-before-deadline', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'a'.repeat(64);
    await expect(repository.markProjected(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 'worker', 1_002, workerTokenDigest,
    )).resolves.toBe(true);
    await expect(repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt: claim.executionAttempt,
      failureClass: 'provider_error',
    }, { workerTokenDigest }, 1_003)).resolves.toMatchObject({ status: 'failed' });

    // The worker has failed durably, but the 15-minute admission window is still
    // open. Reconciliation must publish the exact one-based a1 identity now.
    const [failed] = await repository.claimAbandonedPublishingRuns('reaper-a', 2_000, 1);
    expect(failed).toMatchObject({
      runId: admitted.run.runId, executionAttempt: 1, receivedAt: 1_000,
      terminalDeadline: input.terminalDeadline,
    });
    let published = 0;
    await expect(repository.reconcileAbandonedPublishingRun(failed, 'reaper-a', 2_001, async () => {
      published += 1;
    })).resolves.toBe(true);
    expect(published).toBe(1);
    const reconciled = await client.query('SELECT status, error_text FROM review_runs WHERE run_id = $1', [admitted.run.runId]);
    expect(reconciled.rows[0]).toMatchObject({ status: 'terminal', error_text: 'worker terminal failure: provider_error' });
    await expect(repository.claimAbandonedPublishingRuns('reaper-b', 2_002, 1)).resolves.toEqual([]);
  });

  it('claims a token-bound worker failure when its outbox advanced past projected', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('worker-token-bound-failure', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'c'.repeat(64);
    await expect(repository.bindWorkerTokenDigest(
      claim.runId, claim.leaseOwner, claim.claimAttempt, workerTokenDigest, 1_002,
    )).resolves.toBe(true);
    await expect(repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt: claim.executionAttempt,
      failureClass: 'provider_error',
    }, { workerTokenDigest }, 1_003)).resolves.toMatchObject({ status: 'failed' });

    // A dispatcher can persist its token binding and terminalize its outbox
    // before the worker-failure callback arrives. The token is still durable
    // ownership evidence even though the outbox is no longer 'projected'.
    await client.query(`UPDATE review_dispatch_outbox SET status = 'terminal'
      WHERE run_id = $1 AND worker_token_digest = $2`, [admitted.run.runId, workerTokenDigest]);
    const [failed] = await repository.claimAbandonedPublishingRuns('reaper-a', 2_000, 1);
    expect(failed).toMatchObject({ runId: admitted.run.runId, executionAttempt: 1 });
    await expect(repository.reconcileAbandonedPublishingRun(
      failed, 'reaper-a', 2_001, async () => {},
    )).resolves.toBe(true);
    const reconciled = await client.query('SELECT status, error_text FROM review_runs WHERE run_id = $1', [admitted.run.runId]);
    expect(reconciled.rows[0]).toMatchObject({ status: 'terminal', error_text: 'worker terminal failure: provider_error' });
    await expect(repository.claimAbandonedPublishingRuns('reaper-b', 2_002, 1)).resolves.toEqual([]);
  });

  it('waits for the deadline before sweeping an unowned failed row', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('unowned-failure', 1_000);
    const admitted = await repository.admit(input);
    await client.query(`UPDATE review_runs SET status = 'failed', error_text = 'projection rejected'
      WHERE run_id = $1`, [admitted.run.runId]);
    await client.query(`UPDATE review_dispatch_outbox SET status = 'terminal', projection_name = NULL,
      worker_token_digest = NULL WHERE run_id = $1`, [admitted.run.runId]);

    await expect(repository.claimAbandonedPublishingRuns('reaper-a', 2_000, 1)).resolves.toEqual([]);
    const [expired] = await repository.claimAbandonedPublishingRuns(
      'reaper-b', input.terminalDeadline + 1, 1,
    );
    expect(expired).toMatchObject({ runId: admitted.run.runId, executionAttempt: 1 });
  });

  it('retries a failed worker publication after its claim lease without changing a1 or its classification', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('worker-failed-retry', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'b'.repeat(64);
    await repository.markProjected(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 'worker', 1_002, workerTokenDigest,
    );
    await repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt: claim.executionAttempt,
      failureClass: 'budget_exhausted',
    }, { workerTokenDigest }, 1_003);

    const [first] = await repository.claimAbandonedPublishingRuns('reaper-a', 2_000, 1);
    await expect(repository.reconcileAbandonedPublishingRun(first, 'reaper-a', 2_001, async () => {
      throw new Error('synthetic publisher outage');
    })).rejects.toThrow('synthetic publisher outage');
    await expect(repository.claimAbandonedPublishingRuns('reaper-b', 2_002, 1)).resolves.toEqual([]);

    const [retry] = await repository.claimAbandonedPublishingRuns('reaper-b', 62_002, 1);
    expect(retry).toMatchObject({ runId: admitted.run.runId, executionAttempt: 1 });
    const pending = await client.query('SELECT status, error_text FROM review_runs WHERE run_id = $1', [admitted.run.runId]);
    expect(pending.rows[0]).toMatchObject({ status: 'terminal', error_text: 'worker terminal failure: budget_exhausted' });
    await expect(repository.reconcileAbandonedPublishingRun(retry, 'reaper-b', 62_003, async () => {})).resolves.toBe(true);
    const reconciled = await client.query('SELECT status, error_text FROM review_runs WHERE run_id = $1', [admitted.run.runId]);
    expect(reconciled.rows[0]).toMatchObject({ status: 'terminal', error_text: 'worker terminal failure: budget_exhausted' });
    await expect(repository.claimAbandonedPublishingRuns('reaper-c', 62_004, 1)).resolves.toEqual([]);
  });

  describe('atomic authoritative admission', () => {
    it('commits prepared policy, run, outbox and gate together; dispatch waits for durable check binding', async () => {
      const { repository, client, gateRepository } = await createRepository();
      const input = authoritativeAdmission();
      const admission = await repository.admit(input);
      expect(admission.run.authoritativeGateAppId).toBe(4385771);
      for (const table of ['prepared_review_policies', 'review_runs', 'review_dispatch_outbox', 'review_gate_attempts']) {
        expect((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(1);
      }
      expect(await repository.claimNext('dispatcher', 1_000, 30_000)).toBeNull();
      const gate = await bindPendingGate(gateRepository);
      const claimed = await repository.claimNext('dispatcher', 1_003, 30_000);
      expect(claimed).toMatchObject({ runId: admission.run.runId, authoritativeGateAppId: 4385771,
        configDigest: input.authoritativeGate.prepared.policy.effectiveConfigDigest,
        policyDigest: input.authoritativeGate.prepared.policy.effectivePolicyDigest, executionAttempt: 1 });
      expect(gate.coordinates.runId).toBe(admission.run.runId);
    });

    it('rolls every admission write back when gate reservation fails', async () => {
      const { client } = await createRepository();
      const failing = new PostgresReviewDispatchRepository({ connect: async () => ({
        query: async (sql, values) => {
          if (sql.includes('INSERT INTO review_gate_attempts')) throw new Error('injected reservation failure');
          return client.query(sql, values);
        }, release: () => undefined,
      }) }, undefined, trustedValidation);
      await expect(failing.admit(authoritativeAdmission())).rejects.toThrow('injected reservation failure');
      for (const table of ['github_deliveries', 'prepared_review_policies', 'review_runs', 'review_dispatch_outbox', 'review_gate_attempts']) {
        expect((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
      }
    });

    it('reuses the exact gate for duplicate deliveries and active new deliveries', async () => {
      const { repository, client, gateRepository } = await createRepository();
      const original = authoritativeAdmission();
      await repository.admit(original);
      await bindPendingGate(gateRepository);
      expect((await repository.admit(original)).status).toBe('duplicate');
      const active = await repository.admit(authoritativeAdmission('next-delivery', 2_000));
      expect(active.run.attempt).toBe(0);
      expect((await client.query('SELECT check_id, current_attempt FROM review_gate_attempts')).rows)
        .toEqual([{ check_id: '1001', current_attempt: true }]);
    });

    it('rejects a duplicate delivery that resolves to a different candidate or App', async () => {
      const { repository, client } = await createRepository();
      const original = authoritativeAdmission();
      await repository.admit(original);
      const changed = authoritativeAdmission();
      changed.identity.baseSha = 'f'.repeat(40);
      // Rebuild the entire identity, not just a caller-supplied head/base field.
      const candidate = { repositoryId: 123, owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
        headSha: 'a'.repeat(40), baseSha: 'f'.repeat(40) };
      changed.identity = buildAuthoritativeReviewIdentity({ requested: candidate,
        current: { ...candidate, open: true, draft: false }, policy: changed.authoritativeGate.prepared.policy });
      await expect(repository.admit(changed)).rejects.toThrow('Duplicate delivery no longer matches');
      const changedApp = authoritativeAdmission(); changedApp.authoritativeGate.expectedAppId = 15368;
      await expect(repository.admit(changedApp)).rejects.toThrow('Duplicate delivery no longer matches');
      expect((await client.query('SELECT count(*)::int AS count FROM review_gate_attempts')).rows[0].count).toBe(1);
    });

    it('requires a fresh bound gate for an explicit retry after worker failure', async () => {
      const { repository, client, gateRepository } = await createRepository();
      const run = (await repository.admit(authoritativeAdmission())).run;
      await bindPendingGate(gateRepository);
      await client.query("UPDATE review_runs SET status = 'failed' WHERE run_id = $1", [run.runId]);
      await client.query("UPDATE review_dispatch_outbox SET status = 'projected' WHERE run_id = $1", [run.runId]);
      const retry = await repository.admit(authoritativeAdmission('explicit-retry', 2_000));
      expect(retry.run.attempt).toBe(1);
      expect(await repository.claimNext('dispatcher', 2_001, 30_000)).toBeNull();
      const rows = (await client.query('SELECT review_generation, execution_attempt, current_attempt, check_id FROM review_gate_attempts ORDER BY review_generation')).rows;
      expect(rows).toEqual([
        { review_generation: 0, execution_attempt: 1, current_attempt: false, check_id: '1001' },
        { review_generation: 1, execution_attempt: 2, current_attempt: true, check_id: null },
      ]);
    });

    it('atomically binds central admission to the exact one-based durable generation', async () => {
      const { repository, client, gateRepository } = await createRepository();
      const firstInput = {
        ...authoritativeAdmission('central-a1'), eventName: 'repository_dispatch', centralActionDispatch: true, expectedGeneration: 1,
      };
      const first = await repository.admit(firstInput);
      await bindPendingGate(gateRepository);
      await client.query("UPDATE review_runs SET status = 'failed' WHERE run_id = $1", [first.run.runId]);
      await client.query("UPDATE review_dispatch_outbox SET status = 'projected' WHERE run_id = $1", [first.run.runId]);

      const before = await dispatchState(client, first.run.runId);
      const mismatched = {
        ...authoritativeAdmission('central-a3', 2_000), eventName: 'repository_dispatch', centralActionDispatch: true, expectedGeneration: 3,
      };
      await expect(repository.admit(mismatched))
        .rejects.toThrow(/expected generation 3.*next durable generation is 2/i);
      expect(await dispatchState(client, first.run.runId)).toEqual(before);
      expect((await client.query('SELECT count(*)::int AS count FROM github_deliveries WHERE delivery_id = $1', [mismatched.deliveryId])).rows[0].count).toBe(0);

      const exact = {
        ...authoritativeAdmission('central-a2', 2_000), eventName: 'repository_dispatch', centralActionDispatch: true, expectedGeneration: 2,
      };
      const retried = await repository.admit(exact);
      expect(retried.run.attempt).toBe(1);
      expect((await dispatchState(client, retried.run.runId)).outbox.execution_attempt).toBe(1);
    });

    it('does not allocate a fresh a1 when central admission already expects a later generation', async () => {
      const { repository, client } = await createRepository();
      const input = {
        ...authoritativeAdmission('central-a2-without-durable-a1'),
        eventName: 'repository_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 2,
      };

      await expect(repository.admit(input))
        .rejects.toThrow(/expected generation 2.*next durable generation is 1/i);
      for (const table of ['github_deliveries', 'prepared_review_policies', 'review_runs', 'review_dispatch_outbox', 'review_gate_attempts']) {
        expect((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
      }
    });

    it('does not let the legacy abandoned-run check creator own authoritative runs', async () => {
      const { repository } = await createRepository();
      await repository.admit(authoritativeAdmission());
      expect(await repository.claimAbandonedPublishingRuns('legacy-reaper', 1_000_000, 10)).toEqual([]);
    });

    it('rejects a mismatched prepared identity before writing', async () => {
      const { repository, client } = await createRepository();
      const input = authoritativeAdmission(); input.effectivePolicyDigest = 'f'.repeat(64);
      await expect(repository.admit(input)).rejects.toThrow('does not match its prepared identity');
      expect((await client.query('SELECT count(*)::int AS count FROM review_runs')).rows[0].count).toBe(0);
    });
  });

  describe('under-lock authoritative admission validation', () => {
    async function expectNoAdmissionWrites(connection: PoolClient) {
      for (const table of ['github_deliveries', 'prepared_review_policies', 'review_runs', 'review_dispatch_outbox', 'review_gate_attempts']) {
        expect((await connection.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
      }
    }

    it('requires an explicit trusted validator for authoritative admission', async () => {
      const { repository, client } = await createRepository({});
      await expect(repository.admit(authoritativeAdmission())).rejects.toThrow('validator is required');
      await expectNoAdmissionWrites(client);
    });

    it('redacts validator failure and rolls back before any admission writes', async () => {
      const { repository, client } = await createRepository({ validateAuthoritativeAdmission: async () => {
        throw new Error('private provider response and fixture credential');
      } });
      await expect(repository.admit(authoritativeAdmission())).rejects.toThrow(/^Authoritative admission validation unavailable$/u);
      await expectNoAdmissionWrites(client);
    });

    it('hard-bounds an uncooperative validator and cannot write after it resolves late', async () => {
      let finish!: () => void;
      const { repository, client } = await createRepository({ admissionValidationTimeoutMs: 1,
        validateAuthoritativeAdmission: () => new Promise<void>((resolve) => { finish = resolve; }) });
      const started = performance.now();
      await expect(repository.admit(authoritativeAdmission())).rejects.toThrow(/^Authoritative admission validation unavailable$/u);
      expect(performance.now() - started).toBeGreaterThanOrEqual(250);
      await expectNoAdmissionWrites(client);
      finish();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expectNoAdmissionWrites(client);
      // ROLLBACK completed and the same connection is usable, not held by the late validator.
      expect((await client.query('SELECT 1 AS ready')).rows[0].ready).toBe(1);
    });

    it.each(['disabled', 'app-gate'] as const)('never invokes authoritative validation for unmarked %s admissions', async (publicationMode) => {
      let calls = 0;
      const { repository } = await createRepository({ validateAuthoritativeAdmission: async () => { calls++; throw new Error('must not run'); } });
      expect((await repository.admit({ ...sameHeadAdmission('legacy', 1_000), publicationMode })).status).toBe('accepted');
      expect(calls).toBe(0);
    });

    it.each([NaN, Infinity, 250.5])('rejects invalid validation timeout %s before connecting', (admissionValidationTimeoutMs) => {
      let connected = false;
      expect(() => new PostgresReviewDispatchRepository({ connect: async () => { connected = true; throw new Error(); } },
        undefined, { admissionValidationTimeoutMs })).toThrow('validation configuration');
      expect(connected).toBe(false);
    });

    it('validates stale A only after concurrently admitted newer B releases the real PR lock', async () => {
      const stale = authoritativeAdmission('stale-a', 1_000);
      const newer = authoritativeAdmission('new-b', 2_000);
      const current = { repositoryId: 123, owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
        headSha: 'f'.repeat(40), baseSha: 'b'.repeat(40), open: true, draft: true };
      newer.identity = buildAuthoritativeReviewIdentity({ requested: current, current, policy: newer.authoritativeGate.prepared.policy });
      let entered!: () => void;
      let release!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      const validationOrder: string[] = [];
      const { repository, client } = await createRepository({ validateAuthoritativeAdmission: async (input) => {
        validationOrder.push(input.deliveryId);
        if (input.deliveryId === 'new-b') { entered(); await barrier; }
        if (input.identity.headSha !== current.headSha) throw new Error('stale candidate');
      } }, true);
      const accepted = repository.admit(newer);
      let rejected: Promise<unknown> | undefined;
      try {
        await inside;
        await expectNoAdmissionWrites(client);
        expect((await client.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
          ['review-dispatch:123:42'])).rows[0].acquired).toBe(false);
        // A's old snapshot exists already, but its validation must wait for B's
        // transaction rather than overwriting B after validation outside the lock.
        rejected = expect(repository.admit(stale)).rejects.toThrow('Authoritative admission validation unavailable');
        const waitDeadline = performance.now() + 1_000;
        let waiting = 0;
        while (performance.now() < waitDeadline && waiting === 0) {
          waiting = (await client.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE application_name = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'`, [sharedSchema])).rows[0].waiting;
          if (waiting === 0) await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(1);
        expect(validationOrder).toEqual(['new-b']);
        release();
        const admitted = await accepted;
        await rejected;
        expect(validationOrder).toEqual(['new-b', 'stale-a']);
        expect((await client.query('SELECT delivery_id FROM github_deliveries')).rows).toEqual([{ delivery_id: 'new-b' }]);
        expect((await client.query('SELECT run_id, status FROM review_runs')).rows).toEqual([{ run_id: admitted.run.runId, status: 'queued' }]);
        expect((await client.query('SELECT run_id, current_attempt FROM review_gate_attempts')).rows)
          .toEqual([{ run_id: admitted.run.runId, current_attempt: true }]);
      } finally {
        release();
        await Promise.allSettled([accepted, ...(rejected ? [rejected] : [])]);
      }
    });
  });

  describe('authoritative isolation and execution recovery', () => {
    it.each(['disabled', 'app-gate'] as const)('keeps authoritative work intact across unmarked %s admission and redelivery', async (publicationMode) => {
      const { repository, client, gateRepository } = await createRepository();
      const first = await repository.admit(authoritativeAdmission());
      await bindPendingGate(gateRepository);
      const claim = (await repository.claimNext('dispatcher', 1_003, 30_000))!;
      await repository.bindWorkerTokenDigest(claim.runId, claim.leaseOwner, claim.claimAttempt, 'a'.repeat(64), 1_004);
      const before = await dispatchState(client, first.run.runId);
      const gateBefore = (await client.query('SELECT * FROM review_gate_attempts')).rows;
      const legacy = await repository.admit({ ...sameHeadAdmission('shadow', 2_000), publicationMode });
      expect(await dispatchState(client, first.run.runId)).toEqual(before);
      expect(await gateRepository.reapTerminalAttempts(2_001)).toBe(0);
      expect((await client.query('SELECT * FROM review_gate_attempts')).rows).toEqual(gateBefore);
      const legacyBefore = await dispatchState(client, legacy.run.runId);
      expect((await repository.admit(authoritativeAdmission('active-redelivery', 3_000))).run.runId).toBe(first.run.runId);
      expect(await dispatchState(client, first.run.runId)).toEqual(before);
      expect(await dispatchState(client, legacy.run.runId)).toEqual(legacyBefore);
    });

    it.each(['disabled', 'app-gate'] as const)('keeps unmarked %s work intact across authoritative admission and redelivery', async (publicationMode) => {
      const { repository, client } = await createRepository();
      const first = await repository.admit({ ...sameHeadAdmission('legacy', 1_000), publicationMode });
      await repository.claimNext('legacy-dispatcher', 1_001, 30_000);
      const before = await dispatchState(client, first.run.runId);
      const authoritative = await repository.admit(authoritativeAdmission('authoritative', 2_000));
      expect(await dispatchState(client, first.run.runId)).toEqual(before);
      const authoritativeBefore = await dispatchState(client, authoritative.run.runId);
      const gateBefore = (await client.query('SELECT * FROM review_gate_attempts')).rows;
      expect((await repository.admit({ ...sameHeadAdmission('legacy-redelivery', 3_000), publicationMode })).run.runId).toBe(first.run.runId);
      expect(await dispatchState(client, first.run.runId)).toEqual(before);
      expect(await dispatchState(client, authoritative.run.runId)).toEqual(authoritativeBefore);
      expect((await client.query('SELECT * FROM review_gate_attempts')).rows).toEqual(gateBefore);
    });

    describe.each(['disabled', 'app-gate'] as const)('unmarked %s history', (publicationMode) => {
      it.each([true, false])('does not block retry in the other authority class (authoritative retry: %s)', async (authoritative) => {
        const { repository, client, gateRepository } = await createRepository();
        const admission = (id: string, now: number, enrolled: boolean) => enrolled
          ? authoritativeAdmission(id, now) : { ...sameHeadAdmission(id, now), publicationMode };
        const first = await repository.admit(admission('first', 1_000, authoritative));
        if (authoritative) await bindPendingGate(gateRepository);
        const claim = (await repository.claimNext('dispatcher', 1_003, 30_000))!;
        expect(await repository.markTerminal(claim.runId, claim.leaseOwner, claim.claimAttempt, 1_004, 'before-worker failure')).toBe(true);
        const failed = await dispatchState(client, first.run.runId);
        const other = await repository.admit(admission('other', 2_000, !authoritative));
        expect(await dispatchState(client, first.run.runId)).toEqual(failed);
        const otherBefore = await dispatchState(client, other.run.runId);
        const retry = await repository.admit(admission('retry', 3_000, authoritative));
        expect(retry.run).toMatchObject({ runId: first.run.runId, attempt: 1, status: 'queued' });
        // No token was ever bound, so this true pre-worker failure does not
        // allocate a replacement execution/Secret, even for an enrolled run.
        expect((await dispatchState(client, first.run.runId)).outbox).toMatchObject({ execution_attempt: 0, worker_token_digest: null });
        expect(await dispatchState(client, other.run.runId)).toEqual(otherBefore);
      });
    });

    it.each(['disabled', 'app-gate'] as const)('preserves supersession and historical rejection within legacy modes starting with %s', async (publicationMode) => {
      const { repository, client } = await createRepository();
      const first = await repository.admit({ ...sameHeadAdmission('first', 1_000), publicationMode });
      const nextMode = publicationMode === 'disabled' ? 'app-gate' : 'disabled';
      const next = await repository.admit({ ...sameHeadAdmission('next', 2_000, { baseSha: 'f'.repeat(40) }), publicationMode: nextMode });
      expect((await dispatchState(client, first.run.runId)).run.status).toBe('superseded');
      await expect(repository.admit({ ...sameHeadAdmission('stale', 3_000), publicationMode })).rejects.toThrow('identity conflict');
      expect((await dispatchState(client, next.run.runId)).run.status).toBe('queued');
      expect((await client.query('SELECT * FROM review_gate_attempts')).rows).toEqual([]);
    });

    it('preserves supersession and historical rejection within authoritative admissions', async () => {
      const { repository, client } = await createRepository();
      const first = await repository.admit(authoritativeAdmission());
      const nextInput = authoritativeAdmission('next', 2_000);
      const candidate = { repositoryId: 123, owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
        headSha: 'a'.repeat(40), baseSha: 'f'.repeat(40) };
      nextInput.identity = buildAuthoritativeReviewIdentity({ requested: candidate,
        current: { ...candidate, open: true, draft: false }, policy: nextInput.authoritativeGate.prepared.policy });
      const next = await repository.admit(nextInput);
      expect((await dispatchState(client, first.run.runId)).run.status).toBe('superseded');
      // Model pre-fix retained history to exercise the historical conflict guard,
      // rather than only the explicit superseded-status rejection.
      await client.query("UPDATE review_runs SET status = 'failed' WHERE run_id = $1", [first.run.runId]);
      await expect(repository.admit(authoritativeAdmission('stale', 3_000))).rejects.toThrow('identity conflict');
      expect((await dispatchState(client, next.run.runId)).run.status).toBe('queued');
      expect((await client.query('SELECT run_id FROM review_gate_attempts WHERE current_attempt')).rows).toEqual([{ run_id: next.run.runId }]);
    });

    it.each([true, false])('rotates a token-bound execution after a lost ACK and reclaimed dispatcher failure (authoritative: %s)', async (authoritative) => {
      const { repository, client, gateRepository } = await createRepository();
      const authInput = authoritativeAdmission();
      const input = authoritative ? authInput : sameHeadAdmission('legacy', 1_000);
      const first = await repository.admit(input);
      if (authoritative) await bindPendingGate(gateRepository);
      const original = (await repository.claimNext('dispatcher', 1_003, 1_000))!;
      const oldProof = { workerTokenDigest: 'a'.repeat(64) };
      const newProof = { workerTokenDigest: 'b'.repeat(64) };
      expect(await repository.bindWorkerTokenDigest(original.runId, original.leaseOwner, original.claimAttempt, oldProof.workerTokenDigest, 1_004)).toBe(true);
      // Kubernetes may have started this worker. Only its projection ACK is lost.
      const reclaimed = (await repository.claimNext('dispatcher', 2_003, 1_000))!;
      expect(reclaimed).toMatchObject({ executionAttempt: 1, claimAttempt: 2, workerTokenDigest: oldProof.workerTokenDigest });
      expect(await repository.markTerminal(reclaimed.runId, reclaimed.leaseOwner, reclaimed.claimAttempt, 2_004, 'prepared read unavailable')).toBe(true);
      const failed = await dispatchState(client, first.run.runId);
      expect(failed.run.status).toBe('failed');
      expect(failed.outbox).toMatchObject({ status: 'projected', execution_attempt: 0,
        worker_token_digest: oldProof.workerTokenDigest, lease_owner: null, lease_expires_at: null });
      expect(await repository.markProjected(original.runId, original.leaseOwner, original.claimAttempt, 'late-ack', 2_005, oldProof.workerTokenDigest)).toBe(false);
      expect(await repository.releaseForRetry(reclaimed.runId, reclaimed.leaseOwner, reclaimed.claimAttempt, 2_005, 2_006)).toBe(false);
      expect(await dispatchState(client, first.run.runId)).toEqual(failed);

      const retry = await repository.admit(authoritative ? authoritativeAdmission('retry', 3_000) : sameHeadAdmission('retry', 3_000));
      expect(retry.run).toMatchObject({ runId: first.run.runId, attempt: 1, status: 'queued' });
      expect((await dispatchState(client, first.run.runId)).outbox).toMatchObject({ execution_attempt: 1, worker_token_digest: null });
      if (authoritative) {
        expect(await repository.claimNext('dispatcher', 3_001, 30_000)).toBeNull();
        const cancelled = (await gateRepository.claimPublication('publisher', 3_002))!;
        expect(cancelled.desiredState).toBe('cancelled');
        await gateRepository.publishLocked(cancelled, async (gate) => ({ id: gate.checkId!, name: REVIEW_GATE_CHECK_NAME,
          appId: gate.expectedAppId, headSha: gate.coordinates.headSha, externalId: gate.externalId,
          status: 'completed', conclusion: 'cancelled' }), () => 3_003);
        await bindPendingGate(gateRepository, 3_004);
      }
      const fresh = (await repository.claimNext('dispatcher', 3_006, 30_000))!;
      expect(fresh.executionAttempt).toBe(2);
      expect(buildRunSecretName(fresh.runId, fresh.executionAttempt)).not.toBe(buildRunSecretName(original.runId, original.executionAttempt));
      expect(await repository.bindWorkerTokenDigest(fresh.runId, fresh.leaseOwner, fresh.claimAttempt, newProof.workerTokenDigest, 3_007)).toBe(true);
      const completion = (executionAttempt: number): WorkerReviewCompletion => ({
        version: 'WorkerReviewCompletion.v1', runId: first.run.runId, repositoryId: input.repositoryId,
        owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
        headSha: input.identity.headSha, baseSha: input.identity.baseSha, policyDigest: input.effectivePolicyDigest,
        configDigest: input.identity.configDigest, executionAttempt,
        result: { version: 'WorkerReviewResult.v1', completedAt: new Date(3_020).toISOString(),
          personas: authInput.authoritativeGate.prepared.expectedPersonaIds.map((id) => ({ id, decision: 'APPROVE', status: 'COMPLETE', findings: [] })),
          coverageComplete: true, quorumSatisfied: true },
      });
      const report = async (execution: number, proof: typeof oldProof) => {
        const event = completion(execution);
        if (authoritative) return gateRepository.recordWorkerResult(event, proof, async () => ({
          current: { ...event, open: true, draft: true },
          coverage: { expectedPersonaIds: authInput.authoritativeGate.prepared.expectedPersonaIds,
            changedFiles: [{ path: 'src/a.ts', patch: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n' }],
            coverageComplete: true, quorumSatisfied: true },
        }), 3_020);
        const { version: _version, result: _result, ...coordinates } = event;
        return (await repository.markWorkerFailure({ version: 'WorkerTerminalFailure.v1', ...coordinates, failureClass: 'provider_error' }, proof, 3_020)).status;
      };
      const beforeCallback = await dispatchState(client, fresh.runId);
      const gateBefore = (await client.query('SELECT * FROM review_gate_attempts ORDER BY attempt_id')).rows;
      // Even a late old completion stamped AFTER the fresh admission is fenced.
      expect(await report(1, oldProof)).toBe('unauthorized');
      expect(await report(1, newProof)).toBe('unauthorized');
      expect(await dispatchState(client, fresh.runId)).toEqual(beforeCallback);
      expect((await client.query('SELECT * FROM review_gate_attempts ORDER BY attempt_id')).rows).toEqual(gateBefore);
      expect(await report(2, newProof)).toBe(authoritative ? 'recorded' : 'failed');
      expect((await dispatchState(client, fresh.runId)).run.status).toBe(authoritative ? 'succeeded' : 'failed');
    });
  });

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
      terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
      payloadDigest: 'f'.repeat(64),
      publicationMode: 'app-gate' as const,
      centralActionDispatch: false,
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
    expect(terminalRow.rows[0].terminal_deadline.getTime()).toBe(6_000 + TERMINAL_DEADLINE_MS);
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

    // A worker that expires without a callback leaves a projected outbox and a
    // terminal Kubernetes object. Reconciliation must not consume its failure
    // publication on an HTTP error, and explicit re-admission needs attempt 5.
    await repository.markProjected(first.run.runId, 'dispatcher-c', fourthClaim!.claimAttempt, 'fourth-projection', 9_040, 'd'.repeat(64));
    await client.query("UPDATE review_runs SET status = 'running' WHERE run_id = $1", [first.run.runId]);
    // REL-733 changes the admission window, not eligibility or the reaper's
    // 60-second lease. Keep the lifecycle clock relative to the admitted input.
    const fourthDeadline = 9_000 + TERMINAL_DEADLINE_MS;
    await expect(repository.claimAbandonedPublishingRuns('too-early', fourthDeadline - 1, 20)).resolves.toEqual([]);
    const expired = await repository.claimAbandonedPublishingRuns('reaper-a', fourthDeadline + 1, 20);
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ runId: first.run.runId, deliveryId: 'delivery-5', executionAttempt: 4,
      receivedAt: 9_000, terminalDeadline: fourthDeadline });
    await expect(repository.claimAbandonedPublishingRuns('reaper-b', fourthDeadline + 2, 20)).resolves.toEqual([]);
    await expect(repository.markProjected(first.run.runId, 'dispatcher-c', fourthClaim!.claimAttempt, 'late-fourth-projection', fourthDeadline + 2, 'd'.repeat(64))).resolves.toBe(false);
    let misboundPublished = false;
    await expect(repository.reconcileAbandonedPublishingRun({ ...expired[0], headSha: 'f'.repeat(40) }, 'reaper-a', fourthDeadline + 3, async () => {
      misboundPublished = true;
    })).resolves.toBe(false);
    expect(misboundPublished).toBe(false);
    await expect(repository.reconcileAbandonedPublishingRun(expired[0], 'reaper-a', fourthDeadline + 3, async () => {
      throw new Error('offline publish failure');
    })).rejects.toThrow('offline publish failure');
    const reclaimAt = fourthDeadline + 61_000;
    const readmitAt = fourthDeadline + 131_001;
    const reclaim = await repository.claimAbandonedPublishingRuns('reaper-b', reclaimAt, 20);
    expect(reclaim).toHaveLength(1);
    await expect(repository.reconcileAbandonedPublishingRun(reclaim[0], 'reaper-b', reclaimAt + 1, async () => {})).resolves.toBe(true);
    await expect(repository.claimAbandonedPublishingRuns('reaper-c', readmitAt - 1, 20)).resolves.toEqual([]);
    const reaped = (await client.query('SELECT status, result_digest FROM review_runs WHERE run_id = $1', [first.run.runId])).rows[0];
    expect(reaped).toMatchObject({ status: 'terminal', result_digest: null });
    await repository.admit(admission('delivery-6', readmitAt));
    const afterExpiry = await repository.claimNext('dispatcher-d', readmitAt + 1, 30_000);
    expect(afterExpiry).toMatchObject({ executionAttempt: 5, receivedAt: readmitAt, terminalDeadline: readmitAt + TERMINAL_DEADLINE_MS });
    let stalePublished = false;
    await expect(repository.reconcileAbandonedPublishingRun(reclaim[0], 'reaper-b', readmitAt + 2, async () => {
      stalePublished = true;
    })).resolves.toBe(false);
    expect(stalePublished).toBe(false);

    // A successful Kubernetes create can lose its acknowledgement. Even if the
    // dispatcher eventually marks that attempt terminal, a bound worker token
    // proves that its Secret/CR identity may already exist and must not be reused.
    await expect(repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-d', afterExpiry!.claimAttempt, 'e'.repeat(64), readmitAt + 3)).resolves.toBe(true);
    await expect(repository.markTerminal(first.run.runId, 'dispatcher-d', afterExpiry!.claimAttempt, readmitAt + 4, 'projection acknowledgement lost')).resolves.toBe(true);
    await expect(repository.markWorkerFailure({ ...failure, executionAttempt: 5 }, { workerTokenDigest: 'e'.repeat(64) }, readmitAt + 5))
      .resolves.toMatchObject({ status: 'already_failed' });
    const nextReadmitAt = readmitAt + 60_000;
    await repository.admit(admission('delivery-7', nextReadmitAt));
    expect((await repository.claimNext('dispatcher-e', nextReadmitAt + 1, 30_000))?.executionAttempt).toBe(6);
    await expect(repository.markWorkerFailure({ ...failure, executionAttempt: 5 }, { workerTokenDigest: 'e'.repeat(64) }, nextReadmitAt + 2))
      .resolves.toMatchObject({ status: 'unauthorized' });

    const excludedSweepAt = nextReadmitAt + 99_999;
    const excluded = [
      { status: 'queued', receivedAt: excludedSweepAt - 100_000, mode: 'app-gate' },
      { status: 'queued', receivedAt: 1_000, mode: 'disabled' },
      { status: 'succeeded', receivedAt: 1_000, mode: 'app-gate' },
      { status: 'cancelled', receivedAt: 1_000, mode: 'app-gate' },
      { status: 'superseded', receivedAt: 1_000, mode: 'app-gate' },
      { status: 'running', receivedAt: 1_000, mode: 'app-gate', result: 'a'.repeat(64) },
      { status: 'running', receivedAt: 1_000, mode: 'app-gate', leaseUntil: new Date(excludedSweepAt + 100_000) },
    ] as const;
    for (const [index, example] of excluded.entries()) {
      const excludedAdmission = { ...admission(`excluded-${index}`, example.receivedAt),
        publicationMode: example.mode, identity: { ...identity, prNumber: 100 + index } };
      // All but the first row must actually be expired: otherwise the status,
      // publication/result and active-lease exclusions would pass vacuously.
      expect(excludedAdmission.terminalDeadline <= excludedSweepAt).toBe(index !== 0);
      const value = await repository.admit(excludedAdmission);
      await client.query('UPDATE review_runs SET status = $2, result_digest = $3, lease_expires_at = $4 WHERE run_id = $1',
        [value.run.runId, example.status, 'result' in example ? example.result : null,
          'leaseUntil' in example ? example.leaseUntil : null]);
    }
    await expect(repository.claimAbandonedPublishingRuns('excluded-reaper', excludedSweepAt, 20)).resolves.toEqual([]);

    // Exercise real concurrent transactions (not SQL-shaped mocks). Shared
    // tables live only in this test's newly created schema; ordinary coverage
    // above stays in connection-local pg_temp tables.
    const schema = `rel721_test_${randomUUID().replaceAll('-', '')}`;
    const peer = await pool!.connect();
    let unlock = () => {};
    let publishing: Promise<boolean> | undefined;
    let readmission: ReturnType<typeof repository.admit> | undefined;
    await client.query(`CREATE SCHEMA "${schema}"`);
    try {
      for (const table of ['github_deliveries', 'review_runs', 'review_dispatch_outbox', 'review_gate_attempts']) {
        await client.query(`CREATE TABLE "${schema}".${table} (LIKE pg_temp.${table} INCLUDING ALL)`);
      }
      await client.query(`SET search_path TO "${schema}", pg_temp`);
      await peer.query(`SET search_path TO "${schema}", pg_temp`);
      const peerRepository = new PostgresReviewDispatchRepository({ connect: async () => ({
        query: peer.query.bind(peer), release: () => {},
      }) }, peer);
      const admitted = await repository.admit(admission('concurrent-1', 1_000));
      const concurrentClaim = await repository.claimNext('concurrent-dispatch', 1_001, 30_000);
      await repository.markProjected(admitted.run.runId, 'concurrent-dispatch', concurrentClaim!.claimAttempt, 'old-terminal-cr', 1_002, 'a'.repeat(64));
      const concurrentDeadline = 1_000 + TERMINAL_DEADLINE_MS;
      const [claimed] = await repository.claimAbandonedPublishingRuns('concurrent-reaper', concurrentDeadline + 1, 1);
      expect(claimed).toMatchObject({ receivedAt: 1_000, terminalDeadline: concurrentDeadline, executionAttempt: 1 });
      let entered = () => {};
      const enteredPublication = new Promise<void>((resolve) => { entered = resolve; });
      const publicationGate = new Promise<void>((resolve) => { unlock = resolve; });
      publishing = repository.reconcileAbandonedPublishingRun(claimed, 'concurrent-reaper', concurrentDeadline + 2, async () => {
        entered();
        await publicationGate;
      });
      await enteredPublication;
      const peerPid = (await peer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      let advanced = false;
      readmission = peerRepository.admit(admission('concurrent-2', concurrentDeadline + 1_000)).then((result) => {
        advanced = true; return result;
      });
      await vi.waitFor(async () => {
        const wait = await pool!.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [peerPid]);
        expect(wait.rows[0].wait_event_type).toBe('Lock');
      });
      expect(advanced).toBe(false);
      unlock();
      await expect(publishing).resolves.toBe(true);
      await expect(readmission).resolves.toMatchObject({ status: 'accepted', run: { deliveryId: 'concurrent-2' } });
      expect((await peerRepository.claimNext('new-dispatch', concurrentDeadline + 1_001, 30_000))?.executionAttempt).toBe(2);
    } finally {
      unlock();
      await publishing?.catch(() => {});
      await readmission?.catch(() => {});
      await client.query('SET search_path TO pg_temp, public');
      await peer.query('SET search_path TO public');
      peer.release();
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
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

  it('re-arms an active projected execution only for an explicit persisted retry', async () => {
    const { repository, client } = await createRepository();
    const identity = {
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      snapshotDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
    };
    const input = (deliveryId: string, receivedAt: number, retryRequested = false, retryAfterExecutionAttempt?: number) => ({
      deliveryId, eventName: 'check_run', repositoryId: 123, installationId: 456,
      receivedAt, terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
      payloadDigest: 'f'.repeat(64), publicationMode: 'app-gate' as const, centralActionDispatch: false, identity,
      ...(retryRequested ? { retryRequested: true } : {}),
      ...(retryAfterExecutionAttempt === undefined ? {} : { retryAfterExecutionAttempt }),
    });

    const first = await repository.admit(input('delivery-1', 1_000));
    const claim = (await repository.claimNext('dispatcher-a', 1_000, 30_000))!;
    await repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-a', claim.claimAttempt, 'a'.repeat(64), 1_001);
    await repository.markProjected(first.run.runId, 'dispatcher-a', claim.claimAttempt, 'projection', 1_002, 'a'.repeat(64));

    const refresh = await repository.admit(input('delivery-refresh', 2_000, true, 1));
    expect(refresh).toMatchObject({ status: 'accepted', run: {
      runId: first.run.runId, status: 'queued', attempt: 1, deliveryId: 'delivery-refresh',
    } });
    expect((await client.query('SELECT status, delivery_id, execution_attempt, projection_name, worker_token_digest FROM review_dispatch_outbox WHERE run_id = $1', [first.run.runId])).rows[0])
      .toMatchObject({ status: 'pending', delivery_id: 'delivery-refresh', execution_attempt: 1,
        projection_name: null, worker_token_digest: null });
    expect((await repository.claimNext('dispatcher-b', 3_000, 30_000))?.executionAttempt).toBe(2);
  });

  it('leaves an active claimed execution untouched when refresh has no projected-worker evidence', async () => {
    const { repository, client } = await createRepository();
    const identity = {
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 43,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      snapshotDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
    };
    const input = (deliveryId: string, receivedAt: number, retryRequested = false, retryAfterExecutionAttempt?: number) => ({
      deliveryId, eventName: 'check_run', repositoryId: 123, installationId: 456,
      receivedAt, terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
      payloadDigest: 'f'.repeat(64), publicationMode: 'app-gate' as const, centralActionDispatch: false, identity,
      ...(retryRequested ? { retryRequested: true } : {}),
      ...(retryAfterExecutionAttempt === undefined ? {} : { retryAfterExecutionAttempt }),
    });

    const first = await repository.admit(input('delivery-claimed', 1_000));
    const claim = (await repository.claimNext('dispatcher-a', 1_000, 30_000))!;
    const before = await dispatchState(client, first.run.runId);
    const refresh = await repository.admit(input('delivery-without-evidence', 2_000, true, 1));

    // The new delivery is acknowledged for idempotency, but the durable run
    // and leased outbox stay bound to the original execution. A refresh may
    // not invent worker existence merely because its flag is true.
    expect(refresh).toMatchObject({ status: 'accepted', run: {
      runId: first.run.runId, status: 'queued', attempt: 0, deliveryId: 'delivery-claimed',
    } });
    const after = await dispatchState(client, first.run.runId);
    expect(after.run).toEqual(before.run);
    expect(after.outbox).toEqual(before.outbox);
    expect(after.run).toMatchObject({ status: 'queued', attempt: 0, delivery_id: 'delivery-claimed',
      terminal_deadline: before.run.terminal_deadline });
    expect(after.outbox).toMatchObject({ status: 'claimed', delivery_id: 'delivery-claimed', execution_attempt: 0,
      projection_name: null, worker_token_digest: null });
    expect((await repository.claimNext('dispatcher-b', 3_000, 30_000))?.runId).toBeUndefined();
    expect(claim.executionAttempt).toBe(1);
  });

  it('persists markTerminal diagnostics and preserves them when a later terminal mark omits diagnostics', async () => {
    const { repository, client } = await createRepository();
    const first = await repository.admit(sameHeadAdmission('diagnostic-first', 1_000));
    const firstClaim = (await repository.claimNext('dispatcher-a', 1_000, 30_000))!;
    const diagnostics = { reason: 'projection_rejected', logTail: 'projection rejected' };
    await expect(repository.markTerminal(firstClaim.runId, firstClaim.leaseOwner, firstClaim.claimAttempt,
      1_001, 'projection rejected', diagnostics)).resolves.toBe(true);
    const firstState = await dispatchState(client, first.run.runId);
    expect(firstState.run.failure_diagnostics).toMatchObject({
      failureClass: 'internal_error', reason: diagnostics.reason, logTail: diagnostics.logTail,
    });

    const retry = await repository.admit(sameHeadAdmission('diagnostic-retry', 2_000));
    expect(retry.run).toMatchObject({ runId: first.run.runId, status: 'queued', attempt: 1 });
    const retryClaim = (await repository.claimNext('dispatcher-b', 2_001, 30_000))!;
    await expect(repository.markTerminal(retryClaim.runId, retryClaim.leaseOwner, retryClaim.claimAttempt,
      2_002, 'second projection rejected')).resolves.toBe(true);
    const finalState = await dispatchState(client, first.run.runId);
    expect(finalState.run.failure_diagnostics).toEqual(firstState.run.failure_diagnostics);
  });

  it('does not rearm a replayed a1 refresh after the replacement a2 is projected', async () => {
    const { repository, client } = await createRepository();
    const identity = {
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 44,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      snapshotDigest: 'c'.repeat(64), configDigest: 'd'.repeat(64),
    };
    const input = (deliveryId: string, receivedAt: number, retryAfterExecutionAttempt?: number) => ({
      deliveryId, eventName: 'check_run', repositoryId: 123, installationId: 456,
      receivedAt, terminalDeadline: receivedAt + TERMINAL_DEADLINE_MS,
      payloadDigest: 'f'.repeat(64), publicationMode: 'app-gate' as const, centralActionDispatch: false, identity,
      ...(retryAfterExecutionAttempt === undefined ? {} : {
        retryRequested: true,
        retryAfterExecutionAttempt,
      }),
    });

    const first = await repository.admit(input('delivery-a1', 1_000));
    const firstClaim = (await repository.claimNext('dispatcher-a', 1_000, 30_000))!;
    await repository.bindWorkerTokenDigest(first.run.runId, 'dispatcher-a', firstClaim.claimAttempt, 'a'.repeat(64), 1_001);
    await repository.markProjected(first.run.runId, 'dispatcher-a', firstClaim.claimAttempt, 'projection-a1', 1_002, 'a'.repeat(64));

    const refresh = await repository.admit(input('delivery-refresh-a1', 2_000, 1));
    expect(refresh.run).toMatchObject({ runId: first.run.runId, status: 'queued', attempt: 1, deliveryId: 'delivery-refresh-a1' });
    const secondClaim = (await repository.claimNext('dispatcher-b', 3_000, 30_000))!;
    expect(secondClaim.executionAttempt).toBe(2);
    await repository.bindWorkerTokenDigest(secondClaim.runId, 'dispatcher-b', secondClaim.claimAttempt, 'b'.repeat(64), 3_001);
    await repository.markProjected(secondClaim.runId, 'dispatcher-b', secondClaim.claimAttempt, 'projection-a2', 3_002, 'b'.repeat(64));

    const beforeReplay = await dispatchState(client, first.run.runId);
    const replay = await repository.admit(input('delivery-replay-old-a1', 4_000, 1));
    expect(replay).toMatchObject({ status: 'accepted', run: {
      runId: first.run.runId, status: 'queued', attempt: 1, deliveryId: 'delivery-refresh-a1',
    } });
    expect(await dispatchState(client, first.run.runId)).toEqual(beforeReplay);
    expect(await repository.claimNext('dispatcher-c', 4_001, 30_000)).toBeNull();
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
