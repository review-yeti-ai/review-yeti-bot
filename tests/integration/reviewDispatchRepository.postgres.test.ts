import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { TERMINAL_DEADLINE_MS } from '../../src/config/terminalDeadline';
import {
  PostgresReviewDispatchRepository,
  PUBLISHABLE_PUBLICATION_MODES,
  type ReviewDispatchRepositoryOptions,
} from '../../src/persistence/reviewDispatchRepository';
import { actionDispatchRequestSchema } from '../../src/review/actionDispatch';
import { buildReviewRunIdentity, deriveReviewRunId } from '../../src/review/reviewAdmission';
import { sha256 } from '../../src/review/reviewCore';
import type { ReviewDispatchClaim } from '../../src/review/reviewRun';
import { REVIEW_GATE_SCHEMA_SQL } from '../../src/persistence/reviewGateSchema';
import { REVIEW_GENERATION_RECOVERY_SCHEMA_SQL } from '../../src/persistence/reviewGenerationRecoverySchema';
import { PREPARED_REVIEW_SCHEMA_SQL } from '../../src/persistence/preparedReviewRepository';
import { REVIEW_EVENT_SCHEMA_SQL } from '../../src/persistence/reviewEventRepository';
import { PostgresReviewGateRepository } from '../../src/persistence/reviewGateRepository';
import { buildAuthoritativeReviewIdentity } from '../../src/review/authoritativeReviewIdentity';
import { preparePublishingPolicy } from '../../src/review/preparedPublishingPolicy';
import { createHash, randomBytes } from 'node:crypto';
import { REVIEW_GATE_CHECK_NAME } from '../../src/github/reviewGateClient';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { buildRunSecretName } from '../../src/k8s/reviewJobProjection';
import type { WorkerReviewCompletion } from '../../src/review/workerReviewCompletion';
import { createGitHubWebhookAdmissionHandler } from '../../src/review/githubWebhookAdmission';
import { workerTerminalSuccessDigest } from '../../src/review/workerCompletion';
import { RECOVERABLE_PANEL_AUTO_RETRY_CAP, RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS } from '../../src/review/publicationFailurePolicy';
import { requeueRecoverableIncompletePanelFailure } from '../../src/review/recoverablePanelRetry';
import { logger } from '../../src/utils/logger';
import { ReviewGenerationRecoveryLedgerError } from '../../src/review/reviewGenerationRecovery';

import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

// REL-1069: fail loudly in CI if the DB URL is missing, so a lost env var cannot
// turn these suites into a silent green skip.
requireDatabaseUrlInCi();

/** Mirrors the production caller (`actionDispatchApi.ts`'s worker-completion
 * handler): invoke the recoverable-panel-retry service only after
 * `markWorkerFailure` durably commits a 'failed' transition, against the
 * exact same repository instance. The orchestration now lives in the
 * review/dispatch service layer (REL-620 finding 1), not inside
 * `PostgresReviewDispatchRepository`, so these tests exercise it the same
 * way the real handler does instead of relying on the repository to trigger
 * it implicitly. */
async function markWorkerFailureAndRequeue(
  repository: PostgresReviewDispatchRepository,
  input: Parameters<PostgresReviewDispatchRepository['markWorkerFailure']>[0],
  proof: { workerTokenDigest: string },
  now: number,
) {
  const transition = await repository.markWorkerFailure(input, proof, now);
  if (transition.status === 'failed') {
    await requeueRecoverableIncompletePanelFailure({ input, now, repository, logger });
  }
  return transition;
}

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
  baseSha?: string; configDigest?: string; policyDigest?: string; prNumber?: number;
} = {}) {
  // Mirror the authoritative identity's policy provenance without depending on
  // a network adapter. The repository must hash the entire supplied identity.
  const identity = {
    ...buildReviewRunIdentity({
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: overrides.prNumber || 42,
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

const databaseUrl = postgresDatabaseUrl();
type TestDispatchRepositoryOptions = Omit<ReviewDispatchRepositoryOptions, 'lifecycleEvents'>
  & Partial<Pick<ReviewDispatchRepositoryOptions, 'lifecycleEvents'>>;
const trustedValidation: ReviewDispatchRepositoryOptions = {
  lifecycleEvents: 'disabled', validateAuthoritativeAdmission: async () => undefined,
};
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

describe('PostgresReviewDispatchRepository central dispatch validation', () => {
  function repositoryThatStopsAtPersistence() {
    const connect = vi.fn(async () => { throw new Error('durable-admission-sentinel'); });
    const repository = new PostgresReviewDispatchRepository(
      { connect } as unknown as Pool,
      undefined,
      {
        lifecycleEvents: 'disabled',
        requireExpectedGeneration: true,
        validateAuthoritativeAdmission: async () => undefined,
      },
    );
    return { repository, connect };
  }

  it('allows an exact central workflow_dispatch retry to reach durable admission', async () => {
    const { repository, connect } = repositoryThatStopsAtPersistence();
    const input = {
      ...authoritativeAdmission('manual-central-retry'),
      eventName: 'workflow_dispatch',
      centralActionDispatch: true,
      expectedGeneration: 2,
      retryRequested: true,
      retryAfterExecutionAttempt: 1,
    };

    await expect(repository.admit(input)).rejects.toThrow('durable-admission-sentinel');
    expect(connect).toHaveBeenCalledOnce();
  });

  it('reads lost-generation evidence before opening the admission transaction', async () => {
    const order: string[] = [];
    const input = {
      ...authoritativeAdmission('manual-central-state-loss-retry'),
      eventName: 'workflow_dispatch',
      centralActionDispatch: true,
      expectedGeneration: 2,
      retryRequested: true,
      retryAfterExecutionAttempt: 1,
    };
    const pool = {
      query: vi.fn(async () => {
        order.push('probe');
        return { rows: [] };
      }),
      connect: vi.fn(async () => {
        order.push('connect');
        throw new Error('durable-admission-sentinel');
      }),
    };
    const repository = new PostgresReviewDispatchRepository(
      pool as unknown as Pool,
      undefined,
      {
        lifecycleEvents: 'disabled',
        requireExpectedGeneration: true,
        validateAuthoritativeAdmission: async () => { order.push('validate'); },
        resolveGenerationRecovery: async () => {
          order.push('resolve');
          return [{
            generation: 1,
            checkId: 10_001,
            externalId: `${deriveReviewRunId(input.identity)}:a1`,
            conclusion: 'failure',
            title: 'Review Yeti: review did not complete',
          }];
        },
      },
    );

    await expect(repository.admit(input)).rejects.toThrow('durable-admission-sentinel');
    expect(order).toEqual(['validate', 'resolve', 'connect']);
  });

  it('does not read recovery evidence when early authoritative validation fails', async () => {
    const resolveGenerationRecovery = vi.fn(async () => []);
    const connect = vi.fn();
    const repository = new PostgresReviewDispatchRepository(
      { query: async () => ({ rows: [] }), connect } as unknown as Pool,
      undefined,
      {
        lifecycleEvents: 'disabled',
        requireExpectedGeneration: true,
        validateAuthoritativeAdmission: async () => { throw new Error('untrusted central caller'); },
        resolveGenerationRecovery,
      },
    );
    const input = {
      ...authoritativeAdmission('manual-untrusted-state-loss-retry'),
      eventName: 'workflow_dispatch',
      centralActionDispatch: true,
      expectedGeneration: 2,
      retryRequested: true,
      retryAfterExecutionAttempt: 1,
    };

    await expect(repository.admit(input))
      .rejects.toThrow('Authoritative admission validation unavailable');
    expect(resolveGenerationRecovery).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it.each(['pull_request', 'pull_request_target'])(
    'rejects a central classification carried by %s before persistence',
    async (eventName) => {
      const { repository, connect } = repositoryThatStopsAtPersistence();
      await expect(repository.admit({
        ...authoritativeAdmission(`invalid-central-${eventName}`),
        eventName,
        centralActionDispatch: true,
        expectedGeneration: 1,
      })).rejects.toThrow('central Action dispatch classification is invalid');
      expect(connect).not.toHaveBeenCalled();
    },
  );
});

async function dispatchState(client: PoolClient, runId: string) {
  return {
    run: (await client.query('SELECT * FROM review_runs WHERE run_id = $1', [runId])).rows[0],
    outbox: (await client.query('SELECT * FROM review_dispatch_outbox WHERE run_id = $1', [runId])).rows[0],
  };
}

async function lifecycleEvents(client: PoolClient, runId: string): Promise<Array<{
  eventKind: string;
  sequence: number;
  data: Record<string, unknown>;
}>> {
  const result = await client.query(
    'SELECT event_kind, sequence, payload FROM review_event_outbox WHERE run_id = $1 ORDER BY sequence',
    [runId],
  );
  return result.rows.map((row) => ({
    eventKind: String(row.event_kind),
    sequence: Number(row.sequence),
    data: row.payload.data as Record<string, unknown>,
  }));
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
        await client.query('DROP TABLE IF EXISTS pg_temp.review_worker_completions, pg_temp.review_event_outbox, pg_temp.review_event_sequence_counters, pg_temp.review_generation_recoveries, pg_temp.review_gate_attempts, pg_temp.prepared_review_policies, pg_temp.review_dispatch_outbox, pg_temp.review_runs, pg_temp.github_deliveries');
      }
      client.release();
      client = undefined;
    }
    await pool?.end();
    pool = undefined;
    sharedSchema = undefined;
  });

  async function createRepository(options: TestDispatchRepositoryOptions = trustedValidation, shared = false) {
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
        burst_started_at TIMESTAMPTZ,
        cancel_requested_at TIMESTAMPTZ,
        cancel_reason TEXT,
        cancel_propagated_at TIMESTAMPTZ,
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
        cancel_requested_at TIMESTAMPTZ,
        cancel_reason TEXT,
        cancel_propagated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await client.query(sharedSchema ? fixtureSql.replaceAll('CREATE TEMP TABLE pg_temp.', 'CREATE TABLE ') : fixtureSql);
    await client.query(sharedSchema ? REVIEW_GATE_SCHEMA_SQL : REVIEW_GATE_SCHEMA_SQL.replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE IF NOT EXISTS'));
    await client.query(sharedSchema ? REVIEW_GENERATION_RECOVERY_SCHEMA_SQL : REVIEW_GENERATION_RECOVERY_SCHEMA_SQL.replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE IF NOT EXISTS'));
    await client.query(sharedSchema ? PREPARED_REVIEW_SCHEMA_SQL : PREPARED_REVIEW_SCHEMA_SQL.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE IF NOT EXISTS'));
    await client.query(sharedSchema ? REVIEW_EVENT_SCHEMA_SQL : REVIEW_EVENT_SCHEMA_SQL.replaceAll('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE IF NOT EXISTS'));

    const transactionClient = {
      query: client.query.bind(client),
      release: () => undefined,
    };
    const effectiveOptions: ReviewDispatchRepositoryOptions = {
      ...options, lifecycleEvents: options.lifecycleEvents ?? (shared ? 'enabled' : 'disabled'),
    };
    const repository = new PostgresReviewDispatchRepository(
      shared ? pool : { connect: async () => transactionClient },
      shared ? undefined : client,
      effectiveOptions,
    );
    const gateRepository = new PostgresReviewGateRepository(shared ? pool : {
      query: client.query.bind(client), connect: async () => transactionClient,
    }, { lifecycleEvents: shared ? 'enabled' : 'disabled' });
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

  it('records the dispatch lifecycle transition matrix exactly once with unchanged authority returns', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);

    const started = await repository.admit(sameHeadAdmission('matrix-started', 1_000));
    expect(started.status).toBe('accepted');
    const startedClaim = (await repository.claimNext('started-worker', 1_001, 30_000))!;
    expect(startedClaim.runId).toBe(started.run.runId);
    expect(await repository.markProjected(startedClaim.runId, startedClaim.leaseOwner, startedClaim.claimAttempt,
      'matrix-projection', 1_002)).toBe(true);

    const retrying = await repository.admit(sameHeadAdmission('matrix-retrying', 2_000,
      { baseSha: 'c'.repeat(40), prNumber: 44 }));
    expect(retrying.status).toBe('accepted');
    const retryClaim = (await repository.claimNext('retry-worker', 2_001, 30_000))!;
    expect(retryClaim.runId).toBe(retrying.run.runId);
    expect(await repository.releaseForRetry(retryClaim.runId, retryClaim.leaseOwner, retryClaim.claimAttempt,
      2_002, 3_000)).toBe(true);
    const terminalClaim = (await repository.claimNext('terminal-worker', 3_000, 30_000))!;
    expect(terminalClaim.runId).toBe(retrying.run.runId);
    expect(await repository.markTerminal(terminalClaim.runId, terminalClaim.leaseOwner, terminalClaim.claimAttempt,
      3_001, 'matrix failure')).toBe(true);

    const superseded = await repository.admit(sameHeadAdmission('matrix-superseded', 4_000,
      { baseSha: 'd'.repeat(40), prNumber: 43 }));
    const replacement = await repository.admit(sameHeadAdmission('matrix-replacement', 5_000,
      { baseSha: 'e'.repeat(40), prNumber: 43 }));
    expect(replacement.status).toBe('accepted');

    const expected = new Map<string, Array<{
      eventKind: string;
      sequence: number;
      data: Record<string, unknown>;
    }>>([
      [started.run.runId, [
        { eventKind: 'review.lifecycle.admission', sequence: 1,
          data: { policy_digest: 'e'.repeat(64), stage: 'admission' } },
        { eventKind: 'review.lifecycle.queued', sequence: 2,
          data: { policy_digest: 'e'.repeat(64), stage: 'queued' } },
        { eventKind: 'review.lifecycle.dispatched', sequence: 3,
          data: { policy_digest: 'e'.repeat(64), stage: 'dispatch' } },
        { eventKind: 'review.lifecycle.started', sequence: 4,
          data: { policy_digest: 'e'.repeat(64), stage: 'started' } },
      ]],
      [retrying.run.runId, [
        { eventKind: 'review.lifecycle.admission', sequence: 1,
          data: { policy_digest: 'e'.repeat(64), stage: 'admission' } },
        { eventKind: 'review.lifecycle.queued', sequence: 2,
          data: { policy_digest: 'e'.repeat(64), stage: 'queued' } },
        { eventKind: 'review.lifecycle.dispatched', sequence: 3,
          data: { policy_digest: 'e'.repeat(64), stage: 'dispatch' } },
        { eventKind: 'review.lifecycle.retrying', sequence: 4,
          data: { policy_digest: 'e'.repeat(64), stage: 'dispatch', retry_class: 'projection_retry' } },
        { eventKind: 'review.lifecycle.dispatched', sequence: 5,
          data: { policy_digest: 'e'.repeat(64), stage: 'dispatch' } },
        { eventKind: 'review.lifecycle.terminal', sequence: 6,
          data: { policy_digest: 'e'.repeat(64), stage: 'terminal', terminal_class: 'dispatch_failure' } },
      ]],
      [superseded.run.runId, [
        { eventKind: 'review.lifecycle.admission', sequence: 1,
          data: { policy_digest: 'e'.repeat(64), stage: 'admission' } },
        { eventKind: 'review.lifecycle.queued', sequence: 2,
          data: { policy_digest: 'e'.repeat(64), stage: 'queued' } },
        { eventKind: 'review.lifecycle.superseded', sequence: 3,
          data: { policy_digest: 'e'.repeat(64), stage: 'superseded', terminal_class: 'candidate_superseded' } },
      ]],
      [replacement.run.runId, [
        { eventKind: 'review.lifecycle.admission', sequence: 1,
          data: { policy_digest: 'e'.repeat(64), stage: 'admission' } },
        { eventKind: 'review.lifecycle.queued', sequence: 2,
          data: { policy_digest: 'e'.repeat(64), stage: 'queued' } },
      ]],
    ]);
    for (const [runId, events] of expected) expect(await lifecycleEvents(client, runId)).toEqual(events);
    const allIds = (await client.query('SELECT event_id FROM review_event_outbox ORDER BY event_id')).rows.map((row) => row.event_id);
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(allIds).toHaveLength(Array.from(expected.values()).reduce((total, events) => total + events.length, 0));
  });

  it('records worker failure, abandoned publishing, reconciliation, and same-identity redelivery exactly once', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const input = sameHeadAdmission('matrix-worker-failure', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('matrix-worker', 1_001, 30_000))!;
    const workerTokenDigest = 'a'.repeat(64);
    expect(await repository.bindWorkerTokenDigest(
      claim.runId, claim.leaseOwner, claim.claimAttempt, workerTokenDigest, 1_002,
    )).toBe(true);
    await expect(repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt: claim.executionAttempt,
      failureClass: 'provider_error',
    }, { workerTokenDigest }, 1_003)).resolves.toEqual({ runId: admitted.run.runId, status: 'failed' });

    const [abandoned] = await repository.claimAbandonedPublishingRuns('matrix-reaper', 2_000, 1);
    expect(abandoned).toMatchObject({ runId: admitted.run.runId, executionAttempt: 1 });
    await expect(repository.reconcileAbandonedPublishingRun(abandoned, 'matrix-reaper', 2_001,
      async () => 'failure-published')).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });

    const redelivery = await repository.admit(sameHeadAdmission('matrix-worker-redelivery', 3_000));
    expect(redelivery).toMatchObject({ status: 'accepted', run: {
      runId: admitted.run.runId, attempt: 1, status: 'queued',
    } });
    const redeliveryClaim = await repository.claimNext('matrix-redelivery-worker', 3_001, 30_000);
    expect(redeliveryClaim).toMatchObject({ runId: admitted.run.runId, executionAttempt: 2 });

    const expected = [
      { eventKind: 'review.lifecycle.admission', sequence: 1,
        data: { policy_digest: 'e'.repeat(64), stage: 'admission' } },
      { eventKind: 'review.lifecycle.queued', sequence: 2,
        data: { policy_digest: 'e'.repeat(64), stage: 'queued' } },
      { eventKind: 'review.lifecycle.dispatched', sequence: 3,
        data: { policy_digest: 'e'.repeat(64), stage: 'dispatch' } },
      { eventKind: 'review.lifecycle.terminal', sequence: 4,
        data: { policy_digest: 'e'.repeat(64), stage: 'terminal', terminal_class: 'provider_error' } },
      { eventKind: 'review.lifecycle.terminal', sequence: 5,
        data: { policy_digest: 'e'.repeat(64), stage: 'terminal', terminal_class: 'publishing_deadline', retry_class: 'reaper' } },
      { eventKind: 'review.lifecycle.terminal', sequence: 6,
        data: { policy_digest: 'e'.repeat(64), stage: 'terminal', terminal_class: 'failure_published' } },
      { eventKind: 'review.lifecycle.admission', sequence: 7,
        data: { policy_digest: 'e'.repeat(64), stage: 'admission' } },
      { eventKind: 'review.lifecycle.queued', sequence: 8,
        data: { policy_digest: 'e'.repeat(64), stage: 'queued' } },
      { eventKind: 'review.lifecycle.retrying', sequence: 9,
        data: { policy_digest: 'e'.repeat(64), stage: 'admission', retry_class: 'same_identity_redelivery' } },
      { eventKind: 'review.lifecycle.dispatched', sequence: 10,
        data: { policy_digest: 'e'.repeat(64), stage: 'dispatch' } },
    ];
    expect(await lifecycleEvents(client, admitted.run.runId)).toEqual(expected);
    const eventIds = (await client.query(
      'SELECT event_id FROM review_event_outbox WHERE run_id = $1 ORDER BY sequence', [admitted.run.runId],
    )).rows.map((event) => event.event_id);
    expect(new Set(eventIds).size).toBe(eventIds.length);
    expect((await client.query(
      'SELECT next_sequence FROM review_event_sequence_counters WHERE run_id = $1', [admitted.run.runId],
    )).rows[0].next_sequence).toBe('10');
  });

  it('terminalizes an exact legacy worker success and accepts only an identical retry', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const input = sameHeadAdmission('legacy-worker-success', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('legacy-success-worker', 1_001, 30_000))!;
    const workerTokenDigest = 'a'.repeat(64);
    expect(await repository.bindWorkerTokenDigest(
      claim.runId, claim.leaseOwner, claim.claimAttempt, workerTokenDigest, 1_002,
    )).toBe(true);
    expect(await repository.markProjected(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 'legacy-success-projection', 1_003, workerTokenDigest,
    )).toBe(true);
    const success = {
      version: 'WorkerTerminalSuccess.v1' as const,
      runId: admitted.run.runId,
      owner: input.identity.owner,
      repo: input.identity.repo,
      prNumber: input.identity.prNumber,
      headSha: input.identity.headSha,
      baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId,
      policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest,
      executionAttempt: claim.executionAttempt,
      checkId: 4242,
    };

    await expect(repository.markWorkerSuccess(success, { workerTokenDigest }, 1_004))
      .resolves.toEqual({ runId: admitted.run.runId, status: 'succeeded' });
    const state = await dispatchState(client, admitted.run.runId);
    expect(state.run).toMatchObject({
      status: 'succeeded',
      stage: 'complete',
      result_digest: workerTerminalSuccessDigest(success),
      error_text: null,
      failure_diagnostics: {},
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(state.outbox).toMatchObject({
      status: 'terminal',
      execution_attempt: 0,
      worker_token_digest: workerTokenDigest,
      lease_owner: null,
      lease_expires_at: null,
    });
    await expect(repository.markWorkerSuccess(success, { workerTokenDigest }, 1_005))
      .resolves.toEqual({ runId: admitted.run.runId, status: 'already_succeeded' });
    await expect(repository.markWorkerSuccess({ ...success, checkId: 4243 }, { workerTokenDigest }, 1_006))
      .resolves.toEqual({ runId: admitted.run.runId, status: 'conflict' });
    await expect(repository.claimAbandonedPublishingRuns('legacy-success-reaper', input.terminalDeadline + 1, 1))
      .resolves.toEqual([]);
    expect(await lifecycleEvents(client, admitted.run.runId)).toEqual([
      { eventKind: 'review.lifecycle.admission', sequence: 1,
        data: { policy_digest: 'e'.repeat(64), stage: 'admission' } },
      { eventKind: 'review.lifecycle.queued', sequence: 2,
        data: { policy_digest: 'e'.repeat(64), stage: 'queued' } },
      { eventKind: 'review.lifecycle.dispatched', sequence: 3,
        data: { policy_digest: 'e'.repeat(64), stage: 'dispatch' } },
      { eventKind: 'review.lifecycle.started', sequence: 4,
        data: { policy_digest: 'e'.repeat(64), stage: 'started' } },
      { eventKind: 'review.lifecycle.terminal', sequence: 5,
        data: { policy_digest: 'e'.repeat(64), result_digest: workerTerminalSuccessDigest(success),
          stage: 'terminal', terminal_class: 'success' } },
    ]);
  });

  it('rolls back outbox retirement when the legacy success run transition fails', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('legacy-worker-success-rollback', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('legacy-success-worker', 1_001, 30_000))!;
    const workerTokenDigest = 'a'.repeat(64);
    expect(await repository.bindWorkerTokenDigest(
      claim.runId, claim.leaseOwner, claim.claimAttempt, workerTokenDigest, 1_002,
    )).toBe(true);
    const success = {
      version: 'WorkerTerminalSuccess.v1' as const,
      runId: admitted.run.runId,
      owner: input.identity.owner,
      repo: input.identity.repo,
      prNumber: input.identity.prNumber,
      headSha: input.identity.headSha,
      baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId,
      policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest,
      executionAttempt: claim.executionAttempt,
      checkId: 4242,
    };
    const failingRepository = new PostgresReviewDispatchRepository({ connect: async () => ({
      release: () => undefined,
      query: async (sql: string, values?: unknown[]) => {
        if (/UPDATE review_runs AS runs/u.test(sql)) throw new Error('injected success run-write failure');
        return client.query(sql, values);
      },
    }) }, undefined, { lifecycleEvents: 'disabled' });

    await expect(failingRepository.markWorkerSuccess(success, { workerTokenDigest }, 1_003))
      .rejects.toThrow('injected success run-write failure');
    expect(await dispatchState(client, admitted.run.runId)).toMatchObject({
      run: { status: 'queued', result_digest: null },
      outbox: { status: 'claimed', worker_token_digest: workerTokenDigest },
    });
  });

  it.each([
    {
      outcome: 'authoritative-success' as const,
      expectedRun: { status: 'succeeded', stage: 'complete', error_text: null },
      expectedEvent: { eventKind: 'review.lifecycle.terminal', sequence: 4,
        data: { policy_digest: 'e'.repeat(64), stage: 'complete', terminal_class: 'authoritative_success' } },
      retryLease: false,
    },
    {
      outcome: 'failure-existing' as const,
      expectedRun: { status: 'terminal', stage: 'admission',
        error_text: 'publishing run reached its terminal deadline without a verdict; failure reconciled' },
      expectedEvent: { eventKind: 'review.lifecycle.terminal', sequence: 4,
        data: { policy_digest: 'e'.repeat(64), stage: 'terminal', terminal_class: 'failure_existing' } },
      retryLease: false,
    },
    {
      outcome: 'failure-published' as const,
      expectedRun: { status: 'terminal', stage: 'admission',
        error_text: 'publishing run reached its terminal deadline without a verdict; failure reconciled' },
      expectedEvent: { eventKind: 'review.lifecycle.terminal', sequence: 4,
        data: { policy_digest: 'e'.repeat(64), stage: 'terminal', terminal_class: 'failure_published' } },
      retryLease: false,
    },
    {
      outcome: 'creation-unconfirmed' as const,
      expectedRun: { status: 'terminal', stage: 'admission',
        error_text: 'publishing run reached its terminal deadline without a verdict; failure creation unconfirmed' },
      expectedEvent: { eventKind: 'review.lifecycle.retrying', sequence: 4,
        data: { policy_digest: 'e'.repeat(64), stage: 'gate_publication', retry_class: 'creation_unconfirmed' } },
      retryLease: true,
    },
  ])('records the exact $outcome reconciliation lifecycle intent and state', async ({
    outcome, expectedRun, expectedEvent, retryLease,
  }) => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const input = sameHeadAdmission(`reconciliation-${outcome}`, 1_000);
    const admitted = await repository.admit(input);
    const sweepAt = input.terminalDeadline + 1;
    const [sweep] = await repository.claimAbandonedPublishingRuns('outcome-reaper', sweepAt, 1);
    const reconcileAt = sweepAt + 1;

    await expect(repository.reconcileAbandonedPublishingRun(
      sweep, 'outcome-reaper', reconcileAt, async () => outcome,
    )).resolves.toEqual({ reconciled: true, outcome });

    const state = (await client.query(`SELECT runs.status, runs.stage, runs.error_text,
      runs.lease_owner, runs.lease_expires_at, outbox.status AS outbox_status,
      outbox.lease_owner AS outbox_lease_owner, outbox.lease_expires_at AS outbox_lease_expires_at
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId])).rows[0];
    expect(state).toMatchObject({
      ...expectedRun,
      lease_owner: null,
      lease_expires_at: retryLease ? new Date(reconcileAt + 60_000) : null,
      outbox_status: 'terminal',
      outbox_lease_owner: null,
      outbox_lease_expires_at: null,
    });

    const events = await lifecycleEvents(client, admitted.run.runId);
    expect(events).toEqual([
      { eventKind: 'review.lifecycle.admission', sequence: 1,
        data: { policy_digest: 'e'.repeat(64), stage: 'admission' } },
      { eventKind: 'review.lifecycle.queued', sequence: 2,
        data: { policy_digest: 'e'.repeat(64), stage: 'queued' } },
      { eventKind: 'review.lifecycle.terminal', sequence: 3,
        data: { policy_digest: 'e'.repeat(64), stage: 'terminal',
          terminal_class: 'publishing_deadline', retry_class: 'reaper' } },
      expectedEvent,
    ]);
    expect(events.some((event) => event.data.terminal_class === 'publishing_deadline_reconciled')).toBe(false);
    expect((await client.query(
      'SELECT next_sequence FROM review_event_sequence_counters WHERE run_id = $1', [admitted.run.runId],
    )).rows[0].next_sequence).toBe('4');

    if (retryLease) {
      await expect(repository.claimAbandonedPublishingRuns('too-early', reconcileAt + 59_999, 1))
        .resolves.toEqual([]);
      await expect(repository.claimAbandonedPublishingRuns('recovery-reaper', reconcileAt + 60_000, 1))
        .resolves.toMatchObject([{ runId: admitted.run.runId, executionAttempt: 1, recoveryOnly: true }]);
    } else {
      await expect(repository.claimAbandonedPublishingRuns('later-reaper', reconcileAt + 120_000, 1))
        .resolves.toEqual([]);
    }
  });

  it('rolls authoritative success state back when its lifecycle intent cannot append', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const input = sameHeadAdmission('reconciliation-atomicity', 1_000);
    const admitted = await repository.admit(input);
    const sweepAt = input.terminalDeadline + 1;
    const [sweep] = await repository.claimAbandonedPublishingRuns('atomic-reaper', sweepAt, 1);
    const beforeState = await dispatchState(client, admitted.run.runId);
    const beforeEvents = await lifecycleEvents(client, admitted.run.runId);
    await client.query(`ALTER TABLE review_event_outbox
      ADD CONSTRAINT reject_authoritative_success_lifecycle
      CHECK (COALESCE(payload->'data'->>'terminal_class', '') <> 'authoritative_success')`);

    await expect(repository.reconcileAbandonedPublishingRun(
      sweep, 'atomic-reaper', sweepAt + 1, async () => 'authoritative-success',
    )).rejects.toThrow(/reject_authoritative_success_lifecycle/u);

    expect(await dispatchState(client, admitted.run.runId)).toEqual(beforeState);
    expect(await lifecycleEvents(client, admitted.run.runId)).toEqual(beforeEvents);
    expect((await client.query(
      'SELECT next_sequence FROM review_event_sequence_counters WHERE run_id = $1', [admitted.run.runId],
    )).rows[0].next_sequence).toBe('3');
  });

  it('quarantines mismatched legacy delivery rows atomically without publishing or reclaiming them', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const input = sameHeadAdmission('mismatch-run-delivery', 1_000);
    const admitted = await repository.admit(input);
    const outboxDeliveryId = 'mismatch-outbox-delivery';
    await client.query(`INSERT INTO github_deliveries
      (delivery_id, event_name, repository_id, installation_id, payload_digest, received_at)
      VALUES ($1, 'pull_request', $2, $3, $4, to_timestamp($5 / 1000.0))`,
    [outboxDeliveryId, input.repositoryId, input.installationId, sha256(outboxDeliveryId), input.receivedAt]);
    // Reproduce the legacy split-brain row: the run retains the admission
    // delivery while its outbox points at a different durable delivery.
    await client.query(`UPDATE review_dispatch_outbox
      SET delivery_id = $2, status = 'projected' WHERE run_id = $1`, [admitted.run.runId, outboxDeliveryId]);
    await client.query("UPDATE review_runs SET status = 'running' WHERE run_id = $1", [admitted.run.runId]);

    const [abandoned] = await repository.claimAbandonedPublishingRuns(
      'mismatch-reaper', input.terminalDeadline + 1, 1,
    );
    expect(abandoned).toMatchObject({
      runId: admitted.run.runId,
      deliveryId: input.deliveryId,
      deliveryIdentityMismatch: true,
      executionAttempt: 1,
    });
    const publish = vi.fn(async () => 'failure-published' as const);
    await expect(repository.reconcileAbandonedPublishingRun(
      abandoned, 'mismatch-reaper', input.terminalDeadline + 2, publish,
    )).resolves.toEqual({ reconciled: true, outcome: 'quarantined' });
    expect(publish).not.toHaveBeenCalled();

    const state = (await client.query(`SELECT runs.status, runs.stage, runs.error_text,
      runs.result_digest, runs.delivery_id, runs.lease_owner, runs.lease_expires_at,
      runs.failure_diagnostics, outbox.status AS outbox_status, outbox.delivery_id AS outbox_delivery_id,
      outbox.lease_owner AS outbox_lease_owner, outbox.lease_expires_at AS outbox_lease_expires_at
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId])).rows[0];
    expect(state).toMatchObject({
      status: 'terminal',
      stage: 'terminal',
      error_text: 'publishing run delivery identity mismatch; quarantined by reaper',
      result_digest: null,
      delivery_id: input.deliveryId,
      lease_owner: null,
      lease_expires_at: null,
      outbox_status: 'terminal',
      outbox_delivery_id: outboxDeliveryId,
      outbox_lease_owner: null,
      outbox_lease_expires_at: null,
      failure_diagnostics: {
        failureClass: 'internal_error',
        reason: 'dispatch_delivery_identity_mismatch',
        executionAttempt: 1,
        runDeliveryDigest: sha256(input.deliveryId),
        outboxDeliveryDigest: sha256(outboxDeliveryId),
      },
    });
    expect(await lifecycleEvents(client, admitted.run.runId)).toEqual([
      { eventKind: 'review.lifecycle.admission', sequence: 1,
        data: { policy_digest: 'e'.repeat(64), stage: 'admission' } },
      { eventKind: 'review.lifecycle.queued', sequence: 2,
        data: { policy_digest: 'e'.repeat(64), stage: 'queued' } },
      { eventKind: 'review.lifecycle.terminal', sequence: 3,
        data: { policy_digest: 'e'.repeat(64), stage: 'terminal',
          terminal_class: 'publishing_deadline', retry_class: 'reaper' } },
      { eventKind: 'review.lifecycle.terminal', sequence: 4,
        data: {
          policy_digest: 'e'.repeat(64),
          stage: 'terminal',
          terminal_class: 'delivery_identity_mismatch',
          retry_class: 'reaper_quarantine',
          evidence_pointers: [
            `run_delivery_sha256:${sha256(input.deliveryId)}`,
            `outbox_delivery_sha256:${sha256(outboxDeliveryId)}`,
          ],
        } },
    ]);
    await expect(repository.claimAbandonedPublishingRuns(
      'later-reaper', input.terminalDeadline + 120_000, 1,
    )).resolves.toEqual([]);
  });

  it('reconciles a matching sub-millisecond timestamp row through the normal fenced publication path', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const input = sameHeadAdmission('matching-sub-ms', 1_000);
    const admitted = await repository.admit(input);
    // The reaper maps PostgreSQL timestamps to integer milliseconds. Keep the
    // stored values just inside those millisecond buckets to model the live
    // row that previously failed exact `=` comparisons.
    await client.query(`UPDATE review_runs
      SET received_at = received_at + interval '456 microseconds',
          terminal_deadline = terminal_deadline + interval '456 microseconds'
      WHERE run_id = $1`, [admitted.run.runId]);

    const [abandoned] = await repository.claimAbandonedPublishingRuns(
      'matching-reaper', input.terminalDeadline + 1, 1,
    );
    expect(abandoned).toMatchObject({
      runId: admitted.run.runId,
      deliveryId: input.deliveryId,
      executionAttempt: 1,
    });
    expect(abandoned.deliveryIdentityMismatch).toBeUndefined();
    const publish = vi.fn(async () => 'failure-published' as const);
    await expect(repository.reconcileAbandonedPublishingRun(
      abandoned, 'matching-reaper', input.terminalDeadline + 2, publish,
    )).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });
    expect(publish).toHaveBeenCalledOnce();
    await expect(repository.claimAbandonedPublishingRuns(
      'later-matching-reaper', input.terminalDeadline + 120_000, 1,
    )).resolves.toEqual([]);
  });

  it('quarantines a legacy NULL run delivery binding with an empty redacted digest', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const input = sameHeadAdmission('legacy-null-run-delivery', 1_000);
    const admitted = await repository.admit(input);
    await client.query(`UPDATE review_runs
      SET delivery_id = NULL, status = 'running' WHERE run_id = $1`, [admitted.run.runId]);

    const [abandoned] = await repository.claimAbandonedPublishingRuns(
      'null-mismatch-reaper', input.terminalDeadline + 1, 1,
    );
    expect(abandoned).toMatchObject({
      runId: admitted.run.runId,
      executionAttempt: 1,
      deliveryIdentityMismatch: true,
    });
    expect(abandoned.deliveryId).toBeUndefined();
    const publish = vi.fn(async () => 'failure-published' as const);
    await expect(repository.reconcileAbandonedPublishingRun(
      abandoned, 'null-mismatch-reaper', input.terminalDeadline + 2, publish,
    )).resolves.toEqual({ reconciled: true, outcome: 'quarantined' });
    expect(publish).not.toHaveBeenCalled();

    const state = (await client.query(`SELECT runs.status, runs.stage, runs.error_text,
      runs.result_digest, runs.delivery_id, runs.lease_owner, runs.lease_expires_at,
      runs.failure_diagnostics, outbox.status AS outbox_status,
      outbox.delivery_id AS outbox_delivery_id, outbox.lease_owner AS outbox_lease_owner,
      outbox.lease_expires_at AS outbox_lease_expires_at
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId])).rows[0];
    expect(state).toMatchObject({
      status: 'terminal', stage: 'terminal',
      error_text: 'publishing run delivery identity mismatch; quarantined by reaper',
      result_digest: null, delivery_id: null, lease_owner: null, lease_expires_at: null,
      outbox_status: 'terminal', outbox_delivery_id: input.deliveryId,
      outbox_lease_owner: null, outbox_lease_expires_at: null,
      failure_diagnostics: {
        failureClass: 'internal_error', reason: 'dispatch_delivery_identity_mismatch',
        executionAttempt: 1, runDeliveryDigest: sha256(''),
        outboxDeliveryDigest: sha256(input.deliveryId),
      },
    });
    expect(JSON.stringify(state.failure_diagnostics)).not.toContain(input.deliveryId);
    expect(await lifecycleEvents(client, admitted.run.runId)).toContainEqual({
      eventKind: 'review.lifecycle.terminal', sequence: 4,
      data: {
        policy_digest: 'e'.repeat(64), stage: 'terminal',
        terminal_class: 'delivery_identity_mismatch', retry_class: 'reaper_quarantine',
        evidence_pointers: [
          `run_delivery_sha256:${sha256('')}`,
          `outbox_delivery_sha256:${sha256(input.deliveryId)}`,
        ],
      },
    });
    await expect(repository.claimAbandonedPublishingRuns(
      'later-null-mismatch-reaper', input.terminalDeadline + 120_000, 1,
    )).resolves.toEqual([]);
  });

  it('rejects reconciliation at the exact one-millisecond timestamp bucket upper boundary', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const input = sameHeadAdmission('matching-one-ms-upper-boundary', 1_000);
    const admitted = await repository.admit(input);
    // PostgreSQL keeps sub-millisecond precision while the reaper's durable
    // claim contract carries integer milliseconds. The upper edge must remain
    // exclusive so a newer stored timestamp cannot pass a stale fence.
    await client.query(`UPDATE review_runs
      SET received_at = received_at + interval '1 millisecond',
          terminal_deadline = terminal_deadline + interval '1 millisecond'
      WHERE run_id = $1`, [admitted.run.runId]);

    const [abandoned] = await repository.claimAbandonedPublishingRuns(
      'upper-boundary-reaper', input.terminalDeadline + 1, 1,
    );
    expect(abandoned).toMatchObject({
      runId: admitted.run.runId,
      deliveryId: input.deliveryId,
      receivedAt: input.receivedAt + 1,
      terminalDeadline: input.terminalDeadline + 1,
      executionAttempt: 1,
    });
    const publish = vi.fn(async () => 'failure-published' as const);
    await expect(repository.reconcileAbandonedPublishingRun(
      { ...abandoned, receivedAt: input.receivedAt, terminalDeadline: input.terminalDeadline },
      'upper-boundary-reaper', input.terminalDeadline + 2, publish,
    )).resolves.toEqual({ reconciled: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a stale fence when stored timestamp precision is one and a half milliseconds newer', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const input = sameHeadAdmission('matching-fractional-beyond-bucket', 1_000);
    const admitted = await repository.admit(input);
    // Date.getTime() truncates this value to +1 ms in the claim, but the
    // durable PostgreSQL timestamp remains +1.5 ms. That value must not pass
    // a stale +0 ms fence or get mistaken for the claimed attempt.
    await client.query(`UPDATE review_runs
      SET received_at = received_at + interval '1.5 milliseconds',
          terminal_deadline = terminal_deadline + interval '1.5 milliseconds'
      WHERE run_id = $1`, [admitted.run.runId]);

    const [abandoned] = await repository.claimAbandonedPublishingRuns(
      'fractional-beyond-bucket-reaper', input.terminalDeadline + 2, 1,
    );
    expect(abandoned).toMatchObject({
      runId: admitted.run.runId,
      deliveryId: input.deliveryId,
      receivedAt: input.receivedAt + 1,
      terminalDeadline: input.terminalDeadline + 1,
      executionAttempt: 1,
    });
    const publish = vi.fn(async () => 'failure-published' as const);
    await expect(repository.reconcileAbandonedPublishingRun(
      { ...abandoned, receivedAt: input.receivedAt, terminalDeadline: input.terminalDeadline },
      'fractional-beyond-bucket-reaper', input.terminalDeadline + 3, publish,
    )).resolves.toEqual({ reconciled: false });
    expect(publish).not.toHaveBeenCalled();
  });

  it('lets only one concurrent reaper claim a mismatched delivery before quarantine', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const peerRepository = new PostgresReviewDispatchRepository(pool!, undefined, { lifecycleEvents: 'enabled' });
    const input = sameHeadAdmission('concurrent-mismatch-run', 1_000);
    const admitted = await repository.admit(input);
    const outboxDeliveryId = 'concurrent-mismatch-outbox';
    await client.query(`INSERT INTO github_deliveries
      (delivery_id, event_name, repository_id, installation_id, payload_digest, received_at)
      VALUES ($1, 'pull_request', $2, $3, $4, to_timestamp($5 / 1000.0))`,
    [outboxDeliveryId, input.repositoryId, input.installationId, sha256(outboxDeliveryId), input.receivedAt]);
    await client.query(`UPDATE review_dispatch_outbox
      SET delivery_id = $2, status = 'projected' WHERE run_id = $1`, [admitted.run.runId, outboxDeliveryId]);
    await client.query("UPDATE review_runs SET status = 'running' WHERE run_id = $1", [admitted.run.runId]);

    const sweepAt = input.terminalDeadline + 1;
    const claims = await Promise.all([
      repository.claimAbandonedPublishingRuns('concurrent-mismatch-reaper-a', sweepAt, 1),
      peerRepository.claimAbandonedPublishingRuns('concurrent-mismatch-reaper-b', sweepAt, 1),
    ]);
    expect(claims.filter((value) => value.length === 1)).toHaveLength(1);
    expect(claims.filter((value) => value.length === 0)).toHaveLength(1);
    const winnerIndex = claims[0].length === 1 ? 0 : 1;
    const winner = winnerIndex === 0 ? repository : peerRepository;
    const claimed = claims[winnerIndex][0];
    expect(claimed).toMatchObject({
      runId: admitted.run.runId,
      deliveryIdentityMismatch: true,
      executionAttempt: 1,
    });
    const publish = vi.fn(async () => 'failure-published' as const);
    await expect(winner.reconcileAbandonedPublishingRun(
      claimed, `concurrent-mismatch-reaper-${winnerIndex === 0 ? 'a' : 'b'}`, sweepAt + 1, publish,
    )).resolves.toEqual({ reconciled: true, outcome: 'quarantined' });
    expect(publish).not.toHaveBeenCalled();
    await expect(repository.claimAbandonedPublishingRuns('concurrent-mismatch-later', sweepAt + 120_000, 1))
      .resolves.toEqual([]);
    expect((await client.query(`SELECT status, stage, error_text, result_digest,
      lease_owner, lease_expires_at FROM review_runs WHERE run_id = $1`, [admitted.run.runId])).rows[0])
      .toMatchObject({
        status: 'terminal', stage: 'terminal',
        error_text: 'publishing run delivery identity mismatch; quarantined by reaper',
        result_digest: null, lease_owner: null, lease_expires_at: null,
      });
  });

  it('lets one reaper atomically retire a superseded projected attempt and prevents every later reclaim', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
    const peerRepository = new PostgresReviewDispatchRepository(pool!, undefined, { lifecycleEvents: 'enabled' });
    const input = sameHeadAdmission('superseded-projected-run', 1_000);
    const admitted = await repository.admit(input);
    await client.query(`UPDATE review_dispatch_outbox
      SET status = 'projected', execution_attempt = 0, attempt = 9
      WHERE run_id = $1`, [admitted.run.runId]);

    const sweepAt = input.terminalDeadline + 1;
    const claims = await Promise.all([
      repository.claimAbandonedPublishingRuns('superseded-reaper-a', sweepAt, 1),
      peerRepository.claimAbandonedPublishingRuns('superseded-reaper-b', sweepAt, 1),
    ]);
    expect(claims.filter((value) => value.length === 1)).toHaveLength(1);
    expect(claims.filter((value) => value.length === 0)).toHaveLength(1);
    const winnerIndex = claims[0].length === 1 ? 0 : 1;
    const winner = winnerIndex === 0 ? repository : peerRepository;
    const workerId = `superseded-reaper-${winnerIndex === 0 ? 'a' : 'b'}`;
    const claimed = claims[winnerIndex][0];
    expect(claimed).toMatchObject({
      runId: admitted.run.runId,
      deliveryId: input.deliveryId,
      executionAttempt: 1,
    });

    await expect(winner.reconcileAbandonedPublishingRun(
      claimed, workerId, sweepAt + 1, async () => 'superseded',
    )).resolves.toEqual({ reconciled: true, outcome: 'superseded' });

    const state = (await client.query(`SELECT runs.status, runs.stage, runs.error_text,
      runs.result_digest, runs.lease_owner, runs.lease_expires_at, runs.failure_diagnostics,
      outbox.status AS outbox_status, outbox.execution_attempt,
      outbox.lease_owner AS outbox_lease_owner, outbox.lease_expires_at AS outbox_lease_expires_at
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId])).rows[0];
    expect(state).toMatchObject({
      status: 'terminal',
      stage: 'terminal',
      error_text: 'publishing run superseded by a newer publisher-owned same-head check; retired by reaper',
      result_digest: null,
      lease_owner: null,
      lease_expires_at: null,
      outbox_status: 'terminal',
      execution_attempt: 0,
      outbox_lease_owner: null,
      outbox_lease_expires_at: null,
      failure_diagnostics: {
        failureClass: 'internal_error',
        reason: 'superseded_publisher_owned_check',
        executionAttempt: 1,
      },
    });
    expect(await lifecycleEvents(client, admitted.run.runId)).toContainEqual({
      eventKind: 'review.lifecycle.terminal',
      sequence: 4,
      data: {
        policy_digest: 'e'.repeat(64),
        stage: 'terminal',
        terminal_class: 'superseded_by_newer_check',
        retry_class: 'reaper_retired',
      },
    });
    await expect(repository.claimAbandonedPublishingRuns(
      'superseded-reaper-later', sweepAt + 120_000, 1,
    )).resolves.toEqual([]);
  });

  it('appends no lifecycle rows across dispatch and recovery mutations when explicitly disabled', async () => {
    const { repository, client } = await createRepository({ lifecycleEvents: 'disabled' }, true);
    const input = sameHeadAdmission('disabled-lifecycle-mutations', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('disabled-worker', 1_001, 30_000))!;
    const workerTokenDigest = '9'.repeat(64);
    expect(await repository.markProjected(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 'disabled-projection', 1_002, workerTokenDigest,
    )).toBe(true);
    await expect(repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt: claim.executionAttempt,
      failureClass: 'provider_error',
    }, { workerTokenDigest }, 1_003)).resolves.toMatchObject({ status: 'failed' });
    const [abandoned] = await repository.claimAbandonedPublishingRuns('disabled-reaper', 2_000, 1);
    await expect(repository.reconcileAbandonedPublishingRun(
      abandoned, 'disabled-reaper', 2_001, async () => 'failure-existing',
    )).resolves.toEqual({ reconciled: true, outcome: 'failure-existing' });

    expect((await client.query('SELECT count(*)::int AS count FROM review_event_outbox')).rows[0].count).toBe(0);
    expect((await client.query('SELECT count(*)::int AS count FROM review_event_sequence_counters')).rows[0].count).toBe(0);
  });

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
    const publish = vi.fn(async () => 'failure-existing' as const);
    const reconciled = await repository.reconcileAbandonedPublishingRun({
      runId: admitted.run.runId, deliveryId: input.deliveryId, owner: input.identity.owner,
      repo: input.identity.repo, prNumber: input.identity.prNumber, headSha: input.identity.headSha,
      executionAttempt: 1, receivedAt: input.receivedAt, terminalDeadline: input.terminalDeadline,
    }, 'legacy-reaper', now + 1, publish);
    expect(reconciled).toEqual(authoritative
      ? { reconciled: false }
      : { reconciled: true, outcome: 'failure-existing' });
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
      return 'failure-published';
    })).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });
    expect(published).toBe(1);
    const reconciled = await client.query(`SELECT runs.status, runs.error_text,
      outbox.status AS outbox_status FROM review_runs runs
      JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`, [admitted.run.runId]);
    expect(reconciled.rows[0]).toMatchObject({ status: 'terminal', error_text: 'worker terminal failure: provider_error', outbox_status: 'terminal' });
    await expect(repository.claimAbandonedPublishingRuns('reaper-b', 2_002, 1)).resolves.toEqual([]);
  });

  it('admits a valid future availableAt and persists it on the outbox row', async () => {
    const { repository, client } = await createRepository();
    const receivedAt = 1_000;
    const availableAt = receivedAt + 5_000;
    const input = { ...sameHeadAdmission('future-available-at', receivedAt), availableAt };
    const admitted = await repository.admit(input);
    expect(admitted.status).toBe('accepted');

    const outboxRow = (await client.query(
      'SELECT available_at FROM review_dispatch_outbox WHERE run_id = $1', [admitted.run.runId],
    )).rows[0];
    expect(new Date(outboxRow.available_at).getTime()).toBe(availableAt);

    // The delayed row is not claimable until its availableAt elapses.
    await expect(repository.claimNext('too-early', availableAt - 1, 30_000)).resolves.toBeNull();
    await expect(repository.claimNext('on-time', availableAt, 30_000))
      .resolves.toMatchObject({ runId: admitted.run.runId, executionAttempt: 1 });
  });

  it.each(['failure-existing', 'failure-published'] as const)(
    'acknowledges %s reconciliation at a modern epoch without integer overflow',
    async (outcome) => {
      const { repository, client } = await createRepository();
      const now = 1_789_173_058_456;
      const input = sameHeadAdmission(`modern-epoch-${outcome}`, now - 10_000);
      const admitted = await repository.admit(input);
      const claim = (await repository.claimNext('dispatcher', now - 9_000, 30_000))!;
      const workerTokenDigest = '9'.repeat(64);
      await expect(repository.markProjected(
        claim.runId,
        claim.leaseOwner,
        claim.claimAttempt,
        'worker-a1',
        now - 8_000,
        workerTokenDigest,
      )).resolves.toBe(true);
      await expect(repository.markWorkerFailure({
        version: 'WorkerTerminalFailure.v1',
        runId: admitted.run.runId,
        owner: input.identity.owner,
        repo: input.identity.repo,
        prNumber: input.identity.prNumber,
        headSha: input.identity.headSha,
        baseSha: input.identity.baseSha,
        repositoryId: input.repositoryId,
        policyDigest: input.effectivePolicyDigest!,
        configDigest: input.identity.configDigest,
        executionAttempt: claim.executionAttempt,
        failureClass: 'internal_error',
      }, { workerTokenDigest }, now - 7_000)).resolves.toMatchObject({ status: 'failed' });

      const [failed] = await repository.claimAbandonedPublishingRuns('reaper-a', now - 6_000, 1);
      expect(failed).toMatchObject({ runId: admitted.run.runId, executionAttempt: 1 });
      await expect(repository.reconcileAbandonedPublishingRun(
        failed,
        'reaper-a',
        now,
        async () => outcome,
      )).resolves.toEqual({ reconciled: true, outcome });

      expect(await dispatchState(client, admitted.run.runId)).toMatchObject({
        run: {
          status: 'terminal',
          error_text: 'worker terminal failure: internal_error',
          lease_owner: null,
          lease_expires_at: null,
        },
        outbox: {
          status: 'terminal',
          lease_owner: null,
          lease_expires_at: null,
        },
      });
    },
  );

  it('retains lost-create recovery with a bounded lease at a modern epoch', async () => {
    const { repository, client } = await createRepository();
    const now = 1_789_173_058_456;
    const input = sameHeadAdmission('modern-epoch-creation-unconfirmed', now - 10_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('dispatcher', now - 9_000, 30_000))!;
    const workerTokenDigest = '9'.repeat(64);
    await repository.markProjected(
      claim.runId,
      claim.leaseOwner,
      claim.claimAttempt,
      'worker-a1',
      now - 8_000,
      workerTokenDigest,
    );
    await repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1',
      runId: admitted.run.runId,
      owner: input.identity.owner,
      repo: input.identity.repo,
      prNumber: input.identity.prNumber,
      headSha: input.identity.headSha,
      baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId,
      policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest,
      executionAttempt: claim.executionAttempt,
      failureClass: 'internal_error',
    }, { workerTokenDigest }, now - 7_000);

    const [failed] = await repository.claimAbandonedPublishingRuns('reaper-a', now - 6_000, 1);
    await expect(repository.reconcileAbandonedPublishingRun(
      failed,
      'reaper-a',
      now,
      async () => 'creation-unconfirmed',
    )).resolves.toEqual({ reconciled: true, outcome: 'creation-unconfirmed' });

    expect(await dispatchState(client, admitted.run.runId)).toMatchObject({
      run: {
        status: 'terminal',
        error_text: 'publishing run reached its terminal deadline without a verdict; failure creation unconfirmed',
        lease_owner: null,
        lease_expires_at: new Date(now + 60_000),
      },
      outbox: {
        status: 'projected',
        lease_owner: null,
        lease_expires_at: null,
      },
    });
  });

  it('reconciles a durable internal failure with a visible orphan check before the deadline', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('live-orphan-check', 1_000);
    const admitted = await repository.admit(input);
    const dispatch = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'e'.repeat(64);
    await repository.markProjected(
      admitted.run.runId, 'dispatcher', dispatch.claimAttempt, 'worker-a1', 1_002, workerTokenDigest,
    );
    await expect(repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt: dispatch.executionAttempt,
      failureClass: 'internal_error',
    }, { workerTokenDigest }, 1_003)).resolves.toMatchObject({ status: 'failed' });

    const orphan = {
      id: 103443976468,
      name: 'Review Yeti',
      head_sha: input.identity.headSha,
      app: { id: 4385771, slug: 'ct-review-bot' },
      status: 'in_progress',
      conclusion: null,
      started_at: '2026-09-11T22:25:00Z',
      external_id: `${admitted.run.runId}:a1`,
    };
    const fetchImplementation = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Response('{}');
      if (String(url).includes('/commits/')) return new Response(JSON.stringify({ check_runs: [orphan] }));
      return new Response(JSON.stringify(orphan));
    });
    const publisher = new GitHubInstallationClient({
      token: 'ghs_offline', fetchImplementation, sleep: async () => undefined,
    });
    const [sweep] = await repository.claimAbandonedPublishingRuns('reaper-a', 2_000, 1);
    expect(sweep).toMatchObject({
      runId: admitted.run.runId, executionAttempt: 1, recoveryOnly: false,
    });
    await expect(repository.reconcileAbandonedPublishingRun(sweep, 'reaper-a', 2_001,
      () => publisher.failAbandonedCheck(sweep, 4385771, AbortSignal.timeout(20_000)),
    )).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });

    const writes = fetchImplementation.mock.calls.filter(([, request]) => request?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(fetchImplementation.mock.calls.filter(([, request]) => request?.method === 'POST')).toHaveLength(0);
    expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect((await client.query(`SELECT runs.status, runs.error_text, runs.lease_owner,
      outbox.status AS outbox_status, outbox.lease_owner AS outbox_lease_owner
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId])).rows[0]).toMatchObject({
      status: 'terminal', error_text: 'worker terminal failure: internal_error',
      lease_owner: null, outbox_status: 'terminal', outbox_lease_owner: null,
    });
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
      failed, 'reaper-a', 2_001, async () => 'failure-published',
    )).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });
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

  it('re-arms a pre-worker reaper failure through its exact requested action and dispatches a2', async () => {
    const { repository, client } = await createRepository();
    const identity = buildReviewRunIdentity({
      owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
      headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    });
    const input = {
      ...sameHeadAdmission('pre-worker-expiry', 1_000),
      identity,
      payloadDigest: sha256(identity),
      effectivePolicyDigest: identity.configDigest,
    };
    const admitted = await repository.admit(input);
    const sweepAt = input.terminalDeadline + 1;
    const [sweep] = await repository.claimAbandonedPublishingRuns('pre-worker-reaper', sweepAt, 1);
    expect(sweep).toMatchObject({ runId: admitted.run.runId, executionAttempt: 1 });
    await expect(repository.reconcileAbandonedPublishingRun(
      sweep, 'pre-worker-reaper', sweepAt + 1, async () => 'failure-published',
    )).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });
    expect((await client.query(`SELECT runs.status, runs.error_text, outbox.status AS outbox_status,
      outbox.execution_attempt, outbox.worker_token_digest, outbox.projection_name
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId])).rows[0]).toMatchObject({
      status: 'terminal',
      error_text: 'publishing run reached its terminal deadline without a verdict; failure reconciled',
      outbox_status: 'terminal',
      execution_attempt: 0,
      worker_token_digest: null,
      projection_name: null,
    });

    const refreshAt = sweepAt + 2;
    const fullName = 'calltelemetry/cisco-cdr';
    const body = {
      action: 'requested_action',
      installation: { id: input.installationId },
      repository: {
        id: input.repositoryId, name: 'cisco-cdr', full_name: fullName,
        owner: { id: 57884877, login: 'calltelemetry' },
      },
      requested_action: { identifier: 'review-yeti/refresh' },
      check_run: {
        id: 4242, name: 'Review Yeti', head_sha: identity.headSha,
        status: 'completed', conclusion: 'failure', external_id: `${deriveReviewRunId(identity)}:a1`,
        app: { id: 4385771, slug: 'ct-review-bot' },
        output: { title: 'Review Yeti: review did not complete' },
        pull_requests: [{
          number: identity.prNumber,
          head: { sha: identity.headSha, repo: { full_name: fullName } },
          base: { sha: identity.baseSha, repo: { full_name: fullName } },
        }],
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const onEvent = createGitHubWebhookAdmissionHandler({
      config: {
        secret: 'test-webhook-secret', admissionEnabled: true,
        repositoryIds: new Set([String(input.repositoryId)]), ownerIds: new Set(['57884877']),
      },
      admission: repository,
      now: () => refreshAt,
    });
    await expect(onEvent({ eventName: 'check_run', deliveryId: 'pre-worker-refresh', rawBody, body }))
      .resolves.toMatchObject({ status: 'accepted', reason: 'refresh_requested' });

    const rearmed = await client.query(`SELECT runs.status, runs.attempt, runs.delivery_id,
      outbox.status AS outbox_status, outbox.execution_attempt
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId]);
    expect(rearmed.rows[0]).toMatchObject({
      status: 'queued', attempt: 1, delivery_id: 'github-webhook:pre-worker-refresh',
      outbox_status: 'pending', execution_attempt: 1,
    });
    await expect(repository.claimNext('retry-dispatcher', refreshAt + 1, 30_000)).resolves.toMatchObject({
      runId: admitted.run.runId,
      deliveryId: 'github-webhook:pre-worker-refresh',
      executionAttempt: 2,
    });
  });

  it('does not re-arm an unbound terminal failure from an explicit retry flag alone', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('unbound-terminal', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    await expect(repository.markTerminal(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 1_002, 'projection rejected',
    )).resolves.toBe(true);
    const before = await dispatchState(client, admitted.run.runId);

    const refresh = await repository.admit({
      ...sameHeadAdmission('unbound-terminal-refresh', 2_000),
      retryRequested: true,
      retryAfterExecutionAttempt: 1,
    });

    expect(refresh.run).toMatchObject({
      runId: admitted.run.runId,
      status: 'failed',
      deliveryId: 'unbound-terminal',
    });
    expect(await dispatchState(client, admitted.run.runId)).toEqual(before);
    await expect(repository.claimNext('retry-dispatcher', 2_001, 30_000)).resolves.toBeNull();
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
    await expect(repository.reconcileAbandonedPublishingRun(retry, 'reaper-b', 62_003,
      async () => 'failure-published')).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });
    const reconciled = await client.query(`SELECT runs.status, runs.error_text,
      outbox.status AS outbox_status FROM review_runs runs
      JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`, [admitted.run.runId]);
    expect(reconciled.rows[0]).toMatchObject({ status: 'terminal', error_text: 'worker terminal failure: budget_exhausted', outbox_status: 'terminal' });
    await expect(repository.claimAbandonedPublishingRuns('reaper-c', 62_004, 1)).resolves.toEqual([]);
  });

  // REL-620: an optional lane dying with no findings and no quorum is not a
  // code verdict. The dispatcher re-queues the exact same head for a fresh
  // execution attempt through the identical admission path the manual
  // exact-head refresh uses, bounded by RECOVERABLE_PANEL_AUTO_RETRY_CAP.
  function recoverablePanelFailure(input: ReturnType<typeof sameHeadAdmission>, runId: string,
    executionAttempt: number): Parameters<PostgresReviewDispatchRepository['markWorkerFailure']>[0] {
    return {
      version: 'WorkerTerminalFailure.v1', runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt,
      failureClass: 'malformed_output',
      diagnostics: { reason: 'provider_structured_output_invalid',
        logTail: 'optional reviewer did not complete', recoverableIncompletePanel: true },
    };
  }

  it('automatically re-queues a recoverable-incomplete-panel failure for a fresh execution attempt', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('recoverable-panel-auto-retry', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'a'.repeat(64);
    await repository.markProjected(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 'worker-a1', 1_002, workerTokenDigest,
    );

    await expect(markWorkerFailureAndRequeue(repository,
      recoverablePanelFailure(input, admitted.run.runId, claim.executionAttempt), { workerTokenDigest }, 1_003,
    )).resolves.toEqual({ runId: admitted.run.runId, status: 'failed' });

    const requeued = await client.query(`SELECT runs.status, runs.attempt, runs.error_text,
      outbox.status AS outbox_status, outbox.execution_attempt, outbox.available_at
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId]);
    expect(requeued.rows[0]).toMatchObject({ status: 'queued', attempt: 1, outbox_status: 'pending', execution_attempt: 1 });
    // A run the dispatcher is about to retry is not a durable failure record.
    expect(requeued.rows[0].error_text).toBeNull();
    expect(new Date(requeued.rows[0].available_at).getTime()).toBe(1_003 + RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS);

    // The short delay is real, not cosmetic: a claim attempt one millisecond
    // before it elapses sees nothing.
    await expect(repository.claimNext('too-early', 1_003 + RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS - 1, 30_000))
      .resolves.toBeNull();
    await expect(repository.claimNext('retry-dispatcher', 1_003 + RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS, 30_000))
      .resolves.toMatchObject({ runId: admitted.run.runId, executionAttempt: 2 });
  });

  it('durably records the failure and swallows a failed recoverable-panel re-admission', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('recoverable-panel-requeue-admission-fails', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'c'.repeat(64);
    await repository.markProjected(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 'worker-a1', 1_002, workerTokenDigest,
    );

    // Poison the exact delivery id the follow-up requeue will use for its own
    // `admit` call, with no run_id attached. When `requeueRecoverableIncompletePanelFailure`
    // tries to admit that identical delivery id, its INSERT ... ON CONFLICT DO
    // NOTHING finds this row already present (0 rows returned), falls through
    // to the "existing delivery" lookup, and that lookup INNER JOINs on
    // `run_id` -- which is NULL here, so it finds nothing and `admit` throws
    // a real "delivery identity conflict" error. This is the same admission
    // code path a genuine conflict would hit; nothing about `admit` itself is
    // stubbed.
    const retryDeliveryId = `internal-recoverable-panel-retry:${admitted.run.runId}:a${claim.executionAttempt}`;
    await client.query(
      `INSERT INTO github_deliveries (delivery_id, event_name, repository_id, installation_id, payload_digest, received_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))`,
      [retryDeliveryId, 'poisoned', input.repositoryId, input.installationId, 'f'.repeat(64), 1_002],
    );

    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    // The durable failure transition must still resolve normally: a broken
    // re-admission attempt is never allowed to surface as a completion-callback
    // error, since the worker's terminal failure was already committed before
    // the requeue was even attempted.
    await expect(markWorkerFailureAndRequeue(repository,
      recoverablePanelFailure(input, admitted.run.runId, claim.executionAttempt), { workerTokenDigest }, 1_003,
    )).resolves.toEqual({ runId: admitted.run.runId, status: 'failed' });

    const failed = await client.query(`SELECT runs.status, runs.error_text,
      outbox.status AS outbox_status, outbox.execution_attempt
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId]);
    expect(failed.rows[0]).toMatchObject({
      // The durable failure transition (persistWorkerFailure) already
      // committed in its own transaction before the requeue was even
      // attempted, so it is untouched by the requeue's rolled-back admit:
      // outbox stays 'projected' at the pre-retry execution_attempt (0),
      // exactly as it would if `requeueRecoverableIncompletePanelFailure`
      // were never called at all.
      status: 'failed', error_text: 'worker terminal failure: malformed_output',
      outbox_status: 'projected', execution_attempt: 0,
    });

    // The swallowed re-admission error is logged, not thrown or dropped silently.
    expect(errorLog).toHaveBeenCalledWith('Automatic recoverable-panel retry admission failed', expect.objectContaining({
      runId: admitted.run.runId,
      executionAttempt: claim.executionAttempt,
      reason: expect.stringContaining('delivery identity conflict'),
    }));

    errorLog.mockRestore();
  });

  it('never automatically retries a non-app-gate run even when its diagnostics claim recoverable', async () => {
    const { repository, client } = await createRepository();
    const base = sameHeadAdmission('non-app-gate-no-auto-retry', 1_000);
    const input = { ...base, publicationMode: 'disabled' as const };
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'e'.repeat(64);
    await repository.markProjected(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 'worker-a1', 1_002, workerTokenDigest,
    );
    const failure = recoverablePanelFailure(base, admitted.run.runId, claim.executionAttempt);

    // `persistWorkerFailure`'s own authorization fence (identical in shape to
    // the authoritative-gate case above) hard-requires `publication_mode =
    // 'app-gate'` before it will ever transition a run to 'failed', so a
    // disabled-mode run can never reach that status through the public
    // callback at all -- this is the same outer proof the authoritative-gate
    // test above makes for its own exclusion.
    await expect(repository.markWorkerFailure(failure, { workerTokenDigest }, 1_003))
      .resolves.toEqual({ runId: admitted.run.runId, status: 'unauthorized' });
    const unchanged = await client.query(`SELECT runs.status, outbox.status AS outbox_status, outbox.execution_attempt
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`,
      [admitted.run.runId]);
    expect(unchanged.rows[0]).toMatchObject({ status: 'queued', outbox_status: 'projected', execution_attempt: 0 });

    // That outer fence is what protects production today, but it is a
    // separate code path from the service's own `readRunRetryContext`-derived
    // `publicationMode !== 'app-gate'` exit. Exercise the service directly,
    // against the real repository, so a future change that lets
    // `markWorkerFailure` transition a non-app-gate run to 'failed' cannot
    // silently start auto-retrying it: reusing this exact runId and failure
    // event proves the guard alone -- independent of the outer fence --
    // refuses to admit a fresh execution attempt.
    await requeueRecoverableIncompletePanelFailure({ input: failure, now: 2_000, repository, logger });

    const retryDeliveryId = `internal-recoverable-panel-retry:${admitted.run.runId}:a${claim.executionAttempt}`;
    await expect(client.query('SELECT 1 FROM github_deliveries WHERE delivery_id = $1', [retryDeliveryId]))
      .resolves.toMatchObject({ rows: [] });
    const stillUnchanged = await client.query(`SELECT runs.status, runs.attempt,
      outbox.status AS outbox_status, outbox.execution_attempt
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`,
      [admitted.run.runId]);
    expect(stillUnchanged.rows[0]).toMatchObject({
      status: 'queued', attempt: 0, outbox_status: 'projected', execution_attempt: 0,
    });
    // No fresh execution attempt was ever admitted for this head: the same
    // claim window that was already projected remains the only one that ever
    // existed, and no new claimable outbox row exists for it.
    await expect(repository.claimNext('dispatcher-2', 2_000 + RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS, 30_000))
      .resolves.toBeNull();
  });

  it('never automatically retries an authoritative-gate run even when its diagnostics claim recoverable', async () => {
    const { repository, client, gateRepository } = await createRepository();
    const input = authoritativeAdmission('authoritative-no-auto-retry', 1_000);
    const admitted = await repository.admit(input);
    // An authoritative-gate run is only claimable once its check-run gate is
    // durably bound (dispatchClaimPredicate); mirror the other authoritative
    // tests in this file that reserve and publish that gate before claiming.
    await bindPendingGate(gateRepository);
    const claim = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'd'.repeat(64);
    await repository.markProjected(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 'worker-a1', 1_002, workerTokenDigest,
    );
    const failure = recoverablePanelFailure(input, admitted.run.runId, claim.executionAttempt);

    // `persistWorkerFailure`'s own authorization fence hard-requires
    // `authoritative_gate_app_id IS NULL` before it will ever transition a
    // run to 'failed' (metadataMatches), so an authoritative-gate run can
    // never reach `result.status === 'failed'` through the public
    // `markWorkerFailure` callback at all -- there is no way to observe the
    // service's own `authoritativeGateAppId != null` exit through that public
    // path. Exercise the service directly, against the real repository,
    // exactly as the non-app-gate test above does, so a future change that
    // let `markWorkerFailure` transition an authoritative-gate run to
    // 'failed' cannot silently start auto-retrying it too.
    await requeueRecoverableIncompletePanelFailure({ input: failure, now: 2_000, repository, logger });

    const retryDeliveryId = `internal-recoverable-panel-retry:${admitted.run.runId}:a${claim.executionAttempt}`;
    await expect(client.query('SELECT 1 FROM github_deliveries WHERE delivery_id = $1', [retryDeliveryId]))
      .resolves.toMatchObject({ rows: [] });
    const stillUnchanged = await client.query(`SELECT runs.status, runs.attempt,
      outbox.status AS outbox_status, outbox.execution_attempt
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`,
      [admitted.run.runId]);
    expect(stillUnchanged.rows[0]).toMatchObject({
      status: 'queued', attempt: 0, outbox_status: 'projected', execution_attempt: 0,
    });
    // No fresh execution attempt was ever admitted for this head: the same
    // claim window that was already projected remains the only one that ever
    // existed, and no new claimable outbox row exists for it.
    await expect(repository.claimNext('dispatcher-2', 2_000 + RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS, 30_000))
      .resolves.toBeNull();
  });

  it('reads the exact run retry context the recoverable-panel-retry service needs', async () => {
    const { repository, gateRepository } = await createRepository();

    await expect(repository.readRunRetryContext(`run_${'0'.repeat(32)}`)).resolves.toBeNull();

    const appGateInput = sameHeadAdmission('retry-context-app-gate', 1_000);
    const appGateAdmitted = await repository.admit(appGateInput);
    await expect(repository.readRunRetryContext(appGateAdmitted.run.runId)).resolves.toEqual({
      publicationMode: 'app-gate',
      authoritativeGateAppId: null,
      repositoryId: appGateInput.repositoryId,
      installationId: appGateInput.installationId,
      identity: appGateInput.identity,
    });

    const disabledInput = { ...sameHeadAdmission('retry-context-disabled', 1_000, { prNumber: 43 }), publicationMode: 'disabled' as const };
    const disabledAdmitted = await repository.admit(disabledInput);
    await expect(repository.readRunRetryContext(disabledAdmitted.run.runId)).resolves.toMatchObject({
      publicationMode: 'disabled', authoritativeGateAppId: null,
    });

    const authoritativeInput = authoritativeAdmission('retry-context-authoritative', 1_000);
    const authoritativeAdmitted = await repository.admit(authoritativeInput);
    await bindPendingGate(gateRepository);
    await expect(repository.readRunRetryContext(authoritativeAdmitted.run.runId)).resolves.toMatchObject({
      publicationMode: 'app-gate', authoritativeGateAppId: 4385771,
    });
  });

  it('stops the automatic retry once the recoverable-panel attempt cap is exhausted', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('recoverable-panel-cap', 1_000);
    const admitted = await repository.admit(input);
    const tokens = ['a', 'b', 'c', 'd', 'e'].map((c) => c.repeat(64));

    let claimNow = 1_001;
    for (let attempt = 1; attempt <= RECOVERABLE_PANEL_AUTO_RETRY_CAP + 1; attempt += 1) {
      const claim = (await repository.claimNext(`dispatcher-${attempt}`, claimNow, 30_000))!;
      expect(claim).toMatchObject({ runId: admitted.run.runId, executionAttempt: attempt });
      const workerTokenDigest = tokens[attempt - 1];
      await repository.markProjected(
        claim.runId, claim.leaseOwner, claim.claimAttempt, `worker-a${attempt}`, claimNow + 1, workerTokenDigest,
      );
      const failedAt = claimNow + 2;
      await expect(markWorkerFailureAndRequeue(repository,
        recoverablePanelFailure(input, admitted.run.runId, attempt), { workerTokenDigest }, failedAt,
      )).resolves.toEqual({ runId: admitted.run.runId, status: 'failed' });
      claimNow = failedAt + RECOVERABLE_PANEL_AUTO_RETRY_DELAY_MS + 1;
    }

    // Attempt CAP+1 failed the same recoverable way, but the cap is spent: the
    // existing terminal behaviour applies exactly as it did before REL-620.
    const final = await client.query(`SELECT runs.status, runs.error_text,
      outbox.status AS outbox_status, outbox.execution_attempt
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id)
      WHERE runs.run_id = $1`, [admitted.run.runId]);
    expect(final.rows[0]).toMatchObject({
      status: 'failed', outbox_status: 'projected', execution_attempt: RECOVERABLE_PANEL_AUTO_RETRY_CAP,
      error_text: 'worker terminal failure: malformed_output',
    });
    await expect(repository.claimNext('dispatcher-final', claimNow + 1_000_000, 30_000)).resolves.toBeNull();
  });

  it('does not automatically retry a terminal failure whose diagnostics do not mark it recoverable', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('non-recoverable-same-class', 1_000);
    const admitted = await repository.admit(input);
    const claim = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'd'.repeat(64);
    await repository.markProjected(
      claim.runId, claim.leaseOwner, claim.claimAttempt, 'worker-a1', 1_002, workerTokenDigest,
    );

    await expect(repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt: claim.executionAttempt,
      // Same failure class the recoverable test above uses; only the missing
      // `recoverableIncompletePanel` marker distinguishes this one, and that
      // must be enough to keep it out of the automatic retry.
      failureClass: 'malformed_output',
      diagnostics: { reason: 'provider_structured_output_invalid', logTail: 'a persona returned invalid JSON' },
    }, { workerTokenDigest }, 1_003)).resolves.toEqual({ runId: admitted.run.runId, status: 'failed' });

    const state = await client.query(`SELECT runs.status, outbox.status AS outbox_status, outbox.execution_attempt
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`,
      [admitted.run.runId]);
    expect(state.rows[0]).toMatchObject({ status: 'failed', outbox_status: 'projected', execution_attempt: 0 });
    await expect(repository.claimNext('dispatcher-2', 10_000_000, 30_000)).resolves.toBeNull();
  });

  it('markWorkerFailure refuses to transition an authoritative-gate run to failed, so no auto-retry can occur', async () => {
    const { repository, client } = await createRepository();
    const input = authoritativeAdmission('authoritative-no-auto-retry', 1_000);
    const admitted = await repository.admit(input);
    const workerTokenDigest = 'f'.repeat(64);
    // Simulate a bound worker without the gate-reservation machinery a real
    // authoritative dispatch requires: markWorkerFailure's own authorization
    // fence is what this test proves, independent of how the row got claimed.
    await client.query(`UPDATE review_dispatch_outbox SET status = 'claimed', worker_token_digest = $2,
      lease_owner = 'gate-worker', lease_expires_at = now() + interval '1 hour' WHERE run_id = $1`,
      [admitted.run.runId, workerTokenDigest]);

    await expect(repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt: 1,
      failureClass: 'malformed_output',
      diagnostics: { reason: 'provider_structured_output_invalid', logTail: 'x', recoverableIncompletePanel: true },
    }, { workerTokenDigest }, 2_000)).resolves.toEqual({ runId: admitted.run.runId, status: 'unauthorized' });

    const unchanged = await client.query(`SELECT runs.status, outbox.status AS outbox_status, outbox.execution_attempt
      FROM review_runs runs JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`,
      [admitted.run.runId]);
    expect(unchanged.rows[0]).toMatchObject({ status: 'queued', outbox_status: 'claimed', execution_attempt: 0 });
  });

  it('keeps lost-create recovery lookup-only and lease-driven before the original deadline', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('lost-create', 1_000);
    const admitted = await repository.admit(input);
    const dispatch = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    const workerTokenDigest = 'd'.repeat(64);
    await repository.markProjected(
      admitted.run.runId, 'dispatcher', dispatch.claimAttempt, 'worker-a1', 1_002, workerTokenDigest,
    );

    // Model a durable worker failure while the original admission window is
    // still open. A lost check-create response must be recoverable on its
    // short lease cadence; waiting for the terminal deadline would strand the
    // required check unnecessarily.
    await expect(repository.markWorkerFailure({
      version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
      owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
      headSha: input.identity.headSha, baseSha: input.identity.baseSha,
      repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
      configDigest: input.identity.configDigest, executionAttempt: dispatch.executionAttempt,
      failureClass: 'provider_error',
    }, { workerTokenDigest }, 1_003)).resolves.toMatchObject({ status: 'failed' });
    const firstSweepAt = 2_000;
    expect(firstSweepAt).toBeLessThan(input.terminalDeadline);
    const [first] = await repository.claimAbandonedPublishingRuns('reaper-a', firstSweepAt, 1);
    expect(first).toMatchObject({ runId: admitted.run.runId, executionAttempt: 1, recoveryOnly: false });
    await expect(repository.reconcileAbandonedPublishingRun(first, 'reaper-a', firstSweepAt + 1,
      async () => 'creation-unconfirmed')).resolves.toEqual({ reconciled: true, outcome: 'creation-unconfirmed' });

    const pending = (await client.query(`SELECT runs.error_text, runs.lease_owner, runs.lease_expires_at,
      outbox.status AS outbox_status FROM review_runs runs
      JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`,
      [admitted.run.runId])).rows[0];
    expect(pending).toMatchObject({
      error_text: 'publishing run reached its terminal deadline without a verdict; failure creation unconfirmed',
      lease_owner: null,
      outbox_status: 'projected',
    });
    await expect(repository.claimAbandonedPublishingRuns('too-early', firstSweepAt + 60_000, 1)).resolves.toEqual([]);

    const recoveryAt = firstSweepAt + 60_002;
    expect(recoveryAt).toBeLessThan(input.terminalDeadline);
    const [recovery] = await repository.claimAbandonedPublishingRuns('reaper-b', recoveryAt, 1);
    expect(recovery).toMatchObject({ runId: admitted.run.runId, executionAttempt: 1, recoveryOnly: true });
    await expect(repository.reconcileAbandonedPublishingRun(recovery, 'reaper-b', recoveryAt + 1,
      async () => 'creation-unconfirmed')).resolves.toEqual({ reconciled: true, outcome: 'creation-unconfirmed' });

    // A second lost response keeps the same attempt and re-extends only the
    // recovery lease. It must not retire the outbox or allocate a2.
    const repeated = (await client.query(`SELECT runs.error_text, runs.lease_owner, runs.lease_expires_at,
      outbox.status AS outbox_status, outbox.execution_attempt FROM review_runs runs
      JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`,
      [admitted.run.runId])).rows[0];
    expect(repeated).toMatchObject({
      error_text: 'publishing run reached its terminal deadline without a verdict; failure creation unconfirmed',
      lease_owner: null,
      lease_expires_at: new Date(recoveryAt + 60_001),
      outbox_status: 'projected',
      execution_attempt: 0,
    });
    await expect(repository.claimAbandonedPublishingRuns('reaper-c', recoveryAt + 60_000, 1)).resolves.toEqual([]);
    await expect(repository.claimAbandonedPublishingRuns('reaper-d', recoveryAt + 60_002, 1))
      .resolves.toMatchObject([{ runId: admitted.run.runId, executionAttempt: 1, recoveryOnly: true }]);
  });

  it('re-extends lookup-only recovery when an already recovery-only create remains unconfirmed', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('repeated-lost-create', 1_000);
    const admitted = await repository.admit(input);
    const dispatch = (await repository.claimNext('dispatcher', 1_001, 30_000))!;
    await repository.markProjected(admitted.run.runId, 'dispatcher', dispatch.claimAttempt, 'worker-a1', 1_002);

    const firstSweepAt = input.terminalDeadline + 1;
    const [first] = await repository.claimAbandonedPublishingRuns('reaper-a', firstSweepAt, 1);
    await repository.reconcileAbandonedPublishingRun(first, 'reaper-a', firstSweepAt + 1,
      async () => 'creation-unconfirmed');

    const recoverySweepAt = firstSweepAt + 60_002;
    const [recovery] = await repository.claimAbandonedPublishingRuns('reaper-b', recoverySweepAt, 1);
    expect(recovery).toMatchObject({ runId: admitted.run.runId, executionAttempt: 1, recoveryOnly: true });
    const secondReconcileAt = recoverySweepAt + 1;
    await expect(repository.reconcileAbandonedPublishingRun(recovery, 'reaper-b', secondReconcileAt,
      async () => 'creation-unconfirmed')).resolves.toEqual({ reconciled: true, outcome: 'creation-unconfirmed' });

    const pending = (await client.query(`SELECT runs.error_text, runs.lease_owner, runs.lease_expires_at,
      outbox.status AS outbox_status FROM review_runs runs
      JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`, [admitted.run.runId])).rows[0];
    expect(pending).toMatchObject({
      error_text: 'publishing run reached its terminal deadline without a verdict; failure creation unconfirmed',
      lease_owner: null,
      lease_expires_at: new Date(secondReconcileAt + 60_000),
      outbox_status: 'projected',
    });
    await expect(repository.claimAbandonedPublishingRuns('too-early', secondReconcileAt + 59_999, 1))
      .resolves.toEqual([]);
    await expect(repository.claimAbandonedPublishingRuns('reaper-c', secondReconcileAt + 60_000, 1))
      .resolves.toMatchObject([{ runId: admitted.run.runId, executionAttempt: 1, recoveryOnly: true }]);
  });

  it('retires only an explicitly reported authoritative success without re-sweeping it', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('authoritative-success', 1_000);
    const admitted = await repository.admit(input);
    const [sweep] = await repository.claimAbandonedPublishingRuns('reaper-a', input.terminalDeadline + 1, 1);
    await expect(repository.reconcileAbandonedPublishingRun(sweep, 'reaper-a', input.terminalDeadline + 2,
      async () => 'authoritative-success')).resolves.toEqual({ reconciled: true, outcome: 'authoritative-success' });
    expect((await client.query(`SELECT runs.status, runs.stage, runs.error_text, runs.lease_owner, runs.lease_expires_at,
      outbox.status AS outbox_status, outbox.lease_owner AS outbox_lease_owner,
      outbox.lease_expires_at AS outbox_lease_expires_at FROM review_runs runs
      JOIN review_dispatch_outbox outbox USING (run_id) WHERE runs.run_id = $1`,
      [admitted.run.runId])).rows[0]).toMatchObject({
      status: 'succeeded',
      stage: 'complete',
      error_text: null,
      lease_owner: null,
      lease_expires_at: null,
      outbox_status: 'terminal',
      outbox_lease_owner: null,
      outbox_lease_expires_at: null,
    });
    await expect(repository.claimAbandonedPublishingRuns('reaper-b', input.terminalDeadline + 120_000, 1))
      .resolves.toEqual([]);
  });

  it('rolls back an invalid recovery outcome without clearing its exact-attempt lease', async () => {
    const { repository, client } = await createRepository();
    const input = sameHeadAdmission('invalid-recovery-outcome', 1_000);
    const admitted = await repository.admit(input);
    const sweepAt = input.terminalDeadline + 1;
    const [sweep] = await repository.claimAbandonedPublishingRuns('reaper-a', sweepAt, 1);
    await expect(repository.reconcileAbandonedPublishingRun(sweep, 'reaper-a', sweepAt + 1,
      async () => 'unexpected' as never)).rejects.toThrow(/invalid abandoned check recovery outcome/u);
    expect((await client.query('SELECT error_text, lease_owner, lease_expires_at FROM review_runs WHERE run_id = $1',
      [admitted.run.runId])).rows[0]).toMatchObject({
      error_text: 'publishing run reached its terminal deadline without a verdict; reaped by reaper-a',
      lease_owner: 'reaper-a',
      lease_expires_at: new Date(sweepAt + 60_000),
    });
    await expect(repository.claimAbandonedPublishingRuns('reaper-b', sweepAt + 2, 1)).resolves.toEqual([]);
  });

  describe('atomic authoritative admission', () => {
    it('commits prepared policy, run, outbox and gate together; dispatch waits for durable check binding', async () => {
      const { repository, client, gateRepository } = await createRepository({
        lifecycleEvents: 'enabled', validateAuthoritativeAdmission: async () => undefined,
      }, true);
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
      expect(await lifecycleEvents(client, admission.run.runId)).toEqual([
        { eventKind: 'review.lifecycle.admission', sequence: 1,
          data: { policy_digest: input.effectivePolicyDigest, stage: 'admission' } },
        { eventKind: 'review.lifecycle.queued', sequence: 2,
          data: { policy_digest: input.effectivePolicyDigest, stage: 'queued' } },
        { eventKind: 'review.lifecycle.gate_publication', sequence: 3,
          data: { policy_digest: input.effectivePolicyDigest, stage: 'gate_publication', terminal_class: 'claimed' } },
        { eventKind: 'review.lifecycle.gate_publication', sequence: 4,
          data: { policy_digest: input.effectivePolicyDigest, stage: 'gate_publication', terminal_class: 'published' } },
        { eventKind: 'review.lifecycle.dispatched', sequence: 5,
          data: { policy_digest: input.effectivePolicyDigest, stage: 'dispatch' } },
      ]);
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

    it('rolls gate reservation and the first lifecycle intent back when queued intent persistence fails', async () => {
      const { repository, client } = await createRepository({
        lifecycleEvents: 'enabled', validateAuthoritativeAdmission: async () => undefined,
      }, true);
      await client.query(`ALTER TABLE review_event_outbox
        ADD CONSTRAINT reject_queued_lifecycle_intent
        CHECK (event_kind <> 'review.lifecycle.queued')`);

      await expect(repository.admit(authoritativeAdmission('lifecycle-rollback')))
        .rejects.toThrow(/reject_queued_lifecycle_intent/u);

      for (const table of ['github_deliveries', 'prepared_review_policies', 'review_runs',
        'review_dispatch_outbox', 'review_gate_attempts', 'review_event_outbox',
        'review_event_sequence_counters']) {
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
        ...authoritativeAdmission('central-a2', 2_000), eventName: 'workflow_dispatch', centralActionDispatch: true, expectedGeneration: 2,
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

    it('reconstructs a missing durable generation only from trusted exact-head recovery evidence', async () => {
      const recovery = [{
        generation: 1,
        checkId: 10_001,
        externalId: `${deriveReviewRunId(authoritativeAdmission().identity)}:a1`,
        conclusion: 'failure' as const,
        title: 'Review Yeti: review did not complete',
      }];
      const resolveGenerationRecovery = vi.fn(async () => recovery);
      const { repository, client } = await createRepository({
        lifecycleEvents: 'enabled',
        validateAuthoritativeAdmission: async () => undefined,
        resolveGenerationRecovery,
      }, true);
      const input = {
        ...authoritativeAdmission('central-a2-after-state-loss'),
        eventName: 'workflow_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 2,
        retryRequested: true,
        retryAfterExecutionAttempt: 1,
      };

      const admitted = await repository.admit(input);

      expect(admitted.run.attempt).toBe(1);
      expect(resolveGenerationRecovery).toHaveBeenCalledOnce();
      expect((await dispatchState(client, admitted.run.runId)).outbox.execution_attempt).toBe(1);
      expect((await client.query(`SELECT recovered_generation, worker_check_id, external_id, conclusion, title
        FROM review_generation_recoveries WHERE run_id = $1`, [admitted.run.runId])).rows).toEqual([{
        recovered_generation: 1,
        worker_check_id: '10001',
        external_id: `${admitted.run.runId}:a1`,
        conclusion: 'failure',
        title: 'Review Yeti: review did not complete',
      }]);
      expect((await client.query('SELECT review_generation, execution_attempt FROM review_gate_attempts')).rows)
        .toEqual([{ review_generation: 1, execution_attempt: 2 }]);
      expect(await lifecycleEvents(client, admitted.run.runId)).toEqual([
        { eventKind: 'review.lifecycle.admission', sequence: 1,
          data: { policy_digest: input.effectivePolicyDigest, stage: 'admission' } },
        { eventKind: 'review.lifecycle.generation_reconciled', sequence: 2,
          data: { evidence_pointers: ['github-check-run:10001:a1'],
            policy_digest: input.effectivePolicyDigest,
            retry_class: 'service_state_loss_reconciled', stage: 'admission' } },
        { eventKind: 'review.lifecycle.queued', sequence: 3,
          data: { policy_digest: input.effectivePolicyDigest, stage: 'queued' } },
        { eventKind: 'review.lifecycle.retrying', sequence: 4,
          data: { policy_digest: input.effectivePolicyDigest,
            retry_class: 'same_identity_redelivery', stage: 'admission' } },
      ]);
    });

    it.each([0, 1])('reconciles a partially persisted durable generation from the exact worker check ledger at persisted attempt %i', async (persistedAttempt) => {
      const recovery = [{
        generation: 1,
        checkId: 10_001,
        externalId: `${deriveReviewRunId(authoritativeAdmission().identity)}:a1`,
        conclusion: 'failure' as const,
        title: 'Review Yeti: review did not complete',
      }, {
        generation: 2,
        checkId: 10_002,
        externalId: `${deriveReviewRunId(authoritativeAdmission().identity)}:a2`,
        conclusion: 'failure' as const,
        title: 'Review Yeti: review did not complete',
      }];
      const resolveGenerationRecovery = vi.fn(async () => recovery);
      const { repository, client, gateRepository } = await createRepository({
        lifecycleEvents: 'enabled',
        validateAuthoritativeAdmission: async () => undefined,
        resolveGenerationRecovery,
      }, true);
      const firstInput = {
        ...authoritativeAdmission('central-partial-a1'),
        eventName: 'repository_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 1,
      };
      const first = await repository.admit(firstInput);
      await bindPendingGate(gateRepository);
      await client.query("UPDATE review_runs SET status = 'failed', error_text = 'review gate: review-deadline-exceeded' WHERE run_id = $1", [first.run.runId]);
      // Model partial service-state loss: the run/gate survived, but the
      // projection evidence needed by the ordinary retry allocator did not.
      // Attempt 0 distinguishes the recovery-ledger floor from a plain +1.
      await client.query('UPDATE review_runs SET attempt = $2 WHERE run_id = $1', [first.run.runId, persistedAttempt]);
      await client.query("UPDATE review_dispatch_outbox SET status = 'pending', worker_token_digest = NULL, projection_name = NULL WHERE run_id = $1", [first.run.runId]);
      const retryInput = {
        ...authoritativeAdmission('central-partial-a3', 2_000),
        eventName: 'workflow_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 3,
        retryRequested: true,
        retryAfterExecutionAttempt: 2,
      };

      const retried = await repository.admit(retryInput);

      expect(resolveGenerationRecovery).toHaveBeenCalledOnce();
      expect(retried.run.attempt).toBe(2);
      expect((await dispatchState(client, retried.run.runId)).outbox.execution_attempt).toBe(2);
      expect((await client.query(`SELECT recovered_generation, worker_check_id
        FROM review_generation_recoveries WHERE run_id = $1 ORDER BY recovered_generation`, [retried.run.runId])).rows).toEqual([
        { recovered_generation: 1, worker_check_id: '10001' },
        { recovered_generation: 2, worker_check_id: '10002' },
      ]);
    });

    it('does not retry when the durable attempt has reached the recovery ledger length', async () => {
      const runId = deriveReviewRunId(authoritativeAdmission().identity);
      const resolveGenerationRecovery = vi.fn(async () => [{
        generation: 1,
        checkId: 10_001,
        externalId: `${runId}:a1`,
        conclusion: 'failure' as const,
        title: 'Review Yeti: review did not complete',
      }, {
        generation: 2,
        checkId: 10_002,
        externalId: `${runId}:a2`,
        conclusion: 'failure' as const,
        title: 'Review Yeti: review did not complete',
      }]);
      const { repository, client, gateRepository } = await createRepository({
        lifecycleEvents: 'enabled',
        validateAuthoritativeAdmission: async () => undefined,
        resolveGenerationRecovery,
      }, true);
      const first = await repository.admit({
        ...authoritativeAdmission('central-exhausted-a1'),
        eventName: 'repository_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 1,
      });
      await bindPendingGate(gateRepository);
      await client.query("UPDATE review_runs SET status = 'failed', attempt = 2, error_text = 'review gate: review-deadline-exceeded' WHERE run_id = $1", [first.run.runId]);
      await client.query("UPDATE review_dispatch_outbox SET status = 'pending', worker_token_digest = NULL, projection_name = NULL WHERE run_id = $1", [first.run.runId]);
      const before = await dispatchState(client, first.run.runId);

      const admitted = await repository.admit({
        ...authoritativeAdmission('central-exhausted-a3', 2_000),
        eventName: 'workflow_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 3,
        retryRequested: true,
        retryAfterExecutionAttempt: 2,
      });

      expect(resolveGenerationRecovery).toHaveBeenCalledOnce();
      expect(admitted.run.status).toBe('failed');
      expect(admitted.run.attempt).toBe(2);
      expect((await dispatchState(client, first.run.runId)).outbox).toEqual(before.outbox);
      expect((await client.query('SELECT status, attempt FROM review_runs WHERE run_id = $1', [first.run.runId])).rows)
        .toEqual([{ status: 'failed', attempt: 2 }]);
    });

    it('confirms an existing durable generation against external recovery evidence', async () => {
      const recovery = [{
        generation: 1,
        checkId: 10_001,
        externalId: `${deriveReviewRunId(authoritativeAdmission().identity)}:a1`,
        conclusion: 'failure' as const,
        title: 'Review Yeti: review did not complete',
      }];
      const resolveGenerationRecovery = vi.fn(async () => recovery);
      const { repository, client, gateRepository } = await createRepository({
        lifecycleEvents: 'disabled',
        validateAuthoritativeAdmission: async () => undefined,
        resolveGenerationRecovery,
      });
      const firstInput = {
        ...authoritativeAdmission('central-existing-a1'),
        eventName: 'repository_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 1,
      };
      const first = await repository.admit(firstInput);
      await bindPendingGate(gateRepository);
      await client.query("UPDATE review_runs SET status = 'failed' WHERE run_id = $1", [first.run.runId]);
      await client.query("UPDATE review_dispatch_outbox SET status = 'projected' WHERE run_id = $1", [first.run.runId]);
      const retryInput = {
        ...authoritativeAdmission('central-existing-a2', 2_000),
        eventName: 'workflow_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 2,
        retryRequested: true,
        retryAfterExecutionAttempt: 1,
      };

      const retried = await repository.admit(retryInput);

      expect(retried.run.attempt).toBe(1);
      expect(resolveGenerationRecovery).toHaveBeenCalledOnce();
      expect((await dispatchState(client, retried.run.runId)).outbox.execution_attempt).toBe(1);
      expect((await client.query('SELECT count(*)::int AS count FROM review_generation_recoveries')).rows[0].count)
        .toBe(1);
    });

    it('fails closed when the external recovery ledger is empty despite an existing durable run', async () => {
      const resolveGenerationRecovery = vi.fn(async () => []);
      const { repository, client, gateRepository } = await createRepository({
        lifecycleEvents: 'disabled',
        validateAuthoritativeAdmission: async () => undefined,
        resolveGenerationRecovery,
      });
      const first = await repository.admit({
        ...authoritativeAdmission('central-empty-ledger-a1'),
        eventName: 'repository_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 1,
      });
      await bindPendingGate(gateRepository);
      await client.query("UPDATE review_runs SET status = 'failed' WHERE run_id = $1", [first.run.runId]);
      await client.query("UPDATE review_dispatch_outbox SET status = 'projected' WHERE run_id = $1", [first.run.runId]);
      const before = await dispatchState(client, first.run.runId);
      const retryInput = {
        ...authoritativeAdmission('central-empty-ledger-a2', 2_000),
        eventName: 'workflow_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 2,
        retryRequested: true,
        retryAfterExecutionAttempt: 1,
      };

      await expect(repository.admit(retryInput))
        .rejects.toThrow(/expected generation 2.*next durable generation is 1/i);
      expect(resolveGenerationRecovery).toHaveBeenCalledOnce();
      expect(await dispatchState(client, first.run.runId)).toEqual(before);
      expect((await client.query('SELECT count(*)::int AS count FROM github_deliveries WHERE delivery_id = $1', [retryInput.deliveryId])).rows[0].count)
        .toBe(0);
      expect((await client.query('SELECT count(*)::int AS count FROM review_generation_recoveries')).rows[0].count)
        .toBe(0);
    });

    it.each([
      ['mismatched retry metadata', { retryRequested: true, retryAfterExecutionAttempt: 7 }],
      ['a non-retry central admission', { retryRequested: false }],
    ])('rejects %s before external recovery can be applied', async (_label, retry) => {
      const resolveGenerationRecovery = vi.fn(async () => { throw new Error('resolver must not run'); });
      const { repository, client } = await createRepository({
        lifecycleEvents: 'disabled',
        validateAuthoritativeAdmission: async () => undefined,
        resolveGenerationRecovery,
      });
      const input = {
        ...authoritativeAdmission(`central-invalid-recovery-${'retryAfterExecutionAttempt' in retry
          ? retry.retryAfterExecutionAttempt : 'not-retry'}`),
        eventName: 'workflow_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 2,
        ...retry,
      };

      await expect(repository.admit(input))
        .rejects.toThrow(/expected generation 2.*next durable generation is 1/i);
      expect(resolveGenerationRecovery).not.toHaveBeenCalled();
      for (const table of ['github_deliveries', 'prepared_review_policies', 'review_runs',
        'review_dispatch_outbox', 'review_gate_attempts', 'review_generation_recoveries']) {
        expect((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
      }
    });

    it('keeps an invalid external recovery ledger as a generation conflict with no durable writes', async () => {
      const { repository, client } = await createRepository({
        lifecycleEvents: 'disabled',
        validateAuthoritativeAdmission: async () => undefined,
        resolveGenerationRecovery: async () => { throw new ReviewGenerationRecoveryLedgerError(); },
      });
      const input = {
        ...authoritativeAdmission('central-a2-invalid-ledger'),
        eventName: 'workflow_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 2,
        retryRequested: true,
        retryAfterExecutionAttempt: 1,
      };

      await expect(repository.admit(input))
        .rejects.toThrow(/expected generation 2.*next durable generation is 1/i);
      for (const table of ['github_deliveries', 'prepared_review_policies', 'review_runs',
        'review_dispatch_outbox', 'review_gate_attempts', 'review_generation_recoveries']) {
        expect((await client.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
      }
    });

    it('rejects recovery evidence that violates the domain contract with no durable writes', async () => {
      const input = {
        ...authoritativeAdmission('central-a2-invalid-evidence'),
        eventName: 'workflow_dispatch',
        centralActionDispatch: true,
        expectedGeneration: 2,
        retryRequested: true,
        retryAfterExecutionAttempt: 1,
      };
      const { repository, client } = await createRepository({
        lifecycleEvents: 'disabled',
        validateAuthoritativeAdmission: async () => undefined,
        resolveGenerationRecovery: async () => [{
          generation: 1,
          checkId: 10_001,
          externalId: `${deriveReviewRunId(input.identity)}:a2`,
          conclusion: 'failure',
          title: 'Review Yeti: review did not complete',
        }],
      });

      await expect(repository.admit(input))
        .rejects.toThrow(/expected generation 2.*next durable generation is 1/i);
      for (const table of ['github_deliveries', 'prepared_review_policies', 'review_runs',
        'review_dispatch_outbox', 'review_gate_attempts', 'review_generation_recoveries']) {
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
        undefined, { lifecycleEvents: 'disabled', admissionValidationTimeoutMs })).toThrow('validation configuration');
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
    }) }, undefined, { lifecycleEvents: 'disabled' });
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
      return 'failure-existing';
    })).resolves.toEqual({ reconciled: false });
    expect(misboundPublished).toBe(false);
    await expect(repository.reconcileAbandonedPublishingRun(expired[0], 'reaper-a', fourthDeadline + 3, async () => {
      throw new Error('offline publish failure');
    })).rejects.toThrow('offline publish failure');
    const reclaimAt = fourthDeadline + 61_000;
    const readmitAt = fourthDeadline + 131_001;
    const reclaim = await repository.claimAbandonedPublishingRuns('reaper-b', reclaimAt, 20);
    expect(reclaim).toHaveLength(1);
    await expect(repository.reconcileAbandonedPublishingRun(reclaim[0], 'reaper-b', reclaimAt + 1,
      async () => 'failure-existing')).resolves.toEqual({ reconciled: true, outcome: 'failure-existing' });
    await expect(repository.claimAbandonedPublishingRuns('reaper-c', readmitAt - 1, 20)).resolves.toEqual([]);
    const reaped = (await client.query('SELECT status, result_digest FROM review_runs WHERE run_id = $1', [first.run.runId])).rows[0];
    expect(reaped).toMatchObject({ status: 'terminal', result_digest: null });
    await repository.admit(admission('delivery-6', readmitAt));
    const afterExpiry = await repository.claimNext('dispatcher-d', readmitAt + 1, 30_000);
    expect(afterExpiry).toMatchObject({ executionAttempt: 5, receivedAt: readmitAt, terminalDeadline: readmitAt + TERMINAL_DEADLINE_MS });
    let stalePublished = false;
    await expect(repository.reconcileAbandonedPublishingRun(reclaim[0], 'reaper-b', readmitAt + 2, async () => {
      stalePublished = true;
      return 'failure-existing';
    })).resolves.toEqual({ reconciled: false });
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
    let publishing: ReturnType<typeof repository.reconcileAbandonedPublishingRun> | undefined;
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
      }) }, peer, { lifecycleEvents: 'disabled' });
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
        return 'failure-existing';
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
      await expect(publishing).resolves.toEqual({ reconciled: true, outcome: 'failure-existing' });
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

  it('admits one native rerequest delivery as exactly the next governed execution and deduplicates its replay', async () => {
    const { repository, client, gateRepository } = await createRepository();
    const input = authoritativeAdmission('native-rerequest-source', 1_000);
    const first = await repository.admit(input);
    await bindPendingGate(gateRepository);
    const firstClaim = (await repository.claimNext('dispatcher-a', 1_001, 30_000))!;
    await repository.bindWorkerTokenDigest(
      first.run.runId, firstClaim.leaseOwner, firstClaim.claimAttempt, 'a'.repeat(64), 1_002,
    );
    await repository.markProjected(
      first.run.runId, firstClaim.leaseOwner, firstClaim.claimAttempt,
      'review-worker-a1', 1_003, 'a'.repeat(64),
    );

    const fullName = `${input.identity.owner}/${input.identity.repo}`;
    const body = {
      action: 'rerequested',
      installation: { id: input.installationId },
      repository: {
        id: input.repositoryId, name: input.identity.repo, full_name: fullName,
        owner: { id: 57884877, login: input.identity.owner },
      },
      check_run: {
        id: 103522087645, name: 'Review Yeti', head_sha: input.identity.headSha,
        status: 'completed', conclusion: 'failure', external_id: `${first.run.runId}:a1`,
        app: { id: 4385771, slug: 'ct-review-bot' },
        output: { title: 'Review Yeti: review did not complete' },
        pull_requests: [{
          number: input.identity.prNumber,
          head: { sha: input.identity.headSha, repo: { full_name: fullName } },
          base: { sha: input.identity.baseSha, repo: { full_name: fullName } },
        }],
      },
    };
    const rawBody = Buffer.from(JSON.stringify(body));
    const resolve = vi.fn(async () => ({
      current: {
        repositoryId: input.repositoryId, owner: input.identity.owner, repo: input.identity.repo,
        prNumber: input.identity.prNumber, headSha: input.identity.headSha, baseSha: input.identity.baseSha,
        open: true, draft: false,
      },
      identity: input.identity,
      prepared: input.authoritativeGate.prepared,
    }));
    const onEvent = createGitHubWebhookAdmissionHandler({
      config: {
        secret: 'test-webhook-secret', admissionEnabled: true,
        repositoryIds: new Set([String(input.repositoryId)]), ownerIds: new Set(['57884877']),
      },
      admission: repository,
      authoritativePublishing: {
        expectedAppId: 4385771, acceptNewRequests: true,
        repositoryIds: [input.repositoryId], resolver: { resolve },
      },
      now: () => 2_000,
    });
    const event = { eventName: 'check_run', deliveryId: 'native-rerequest', rawBody, body };

    await expect(onEvent(event)).resolves.toMatchObject({
      status: 'accepted', reason: 'refresh_requested', prNumber: input.identity.prNumber,
      headSha: input.identity.headSha,
    });
    const once = await dispatchState(client, first.run.runId);
    expect(once.run).toMatchObject({
      run_id: first.run.runId, status: 'queued', attempt: 1,
      delivery_id: 'github-webhook:native-rerequest',
    });
    expect(once.outbox).toMatchObject({
      status: 'pending', execution_attempt: 1,
      delivery_id: 'github-webhook:native-rerequest',
      projection_name: null, worker_token_digest: null,
    });

    await expect(onEvent(event)).resolves.toMatchObject({ status: 'duplicate', reason: 'refresh_requested' });
    expect(await dispatchState(client, first.run.runId)).toEqual(once);
    expect((await client.query(
      "SELECT count(*)::integer AS count FROM github_deliveries WHERE delivery_id = 'github-webhook:native-rerequest'",
    )).rows[0]?.count).toBe(1);
    expect((await client.query(`SELECT review_generation, execution_attempt, current_attempt, check_id
      FROM review_gate_attempts ORDER BY review_generation`)).rows).toEqual([
      { review_generation: 0, execution_attempt: 1, current_attempt: false, check_id: '1001' },
      { review_generation: 1, execution_attempt: 2, current_attempt: true, check_id: null },
    ]);
    await expect(repository.claimNext('dispatcher-b', 2_001, 30_000)).resolves.toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
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

  describe('retireExpiredNonPublishableRuns', () => {
    function disabledAdmission(deliveryId: string, receivedAt: number, overrides: Parameters<typeof sameHeadAdmission>[2] = {}) {
      return { ...sameHeadAdmission(deliveryId, receivedAt, overrides), publicationMode: 'disabled' as const };
    }

    // Mirrors the production defect: a run admitted, claimed, and projected
    // (a worker was dispatched and reported back) but never reached a
    // terminal state before its deadline. review_runs.lease_owner is NULL
    // throughout this path -- only the outbox side is ever leased here --
    // which is exactly the "free lease" state the reaper must retire.
    async function queueProjected(
      repository: PostgresReviewDispatchRepository, deliveryId: string, receivedAt: number, workerId: string,
      overrides: Parameters<typeof sameHeadAdmission>[2] = {}, disabled = true,
    ) {
      const admission = disabled ? disabledAdmission(deliveryId, receivedAt, overrides) : sameHeadAdmission(deliveryId, receivedAt, overrides);
      const admitted = await repository.admit(admission);
      const claim = (await repository.claimNext(workerId, receivedAt + 1, 30_000))!;
      await repository.markProjected(claim.runId, workerId, claim.claimAttempt, `${workerId}-projection`, receivedAt + 2);
      return { admitted, terminalDeadline: admission.terminalDeadline };
    }

    it('rejects a non-positive or non-integer limit before touching any row', async () => {
      const { repository, client } = await createRepository();
      const disabled = await queueProjected(repository, 'non-pub-limit', 1_000, 'worker-limit', {}, true);
      for (const bad of [0, -1, Number.NaN, 2.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(repository.retireExpiredNonPublishableRuns(disabled.terminalDeadline + 1, bad)).rejects.toThrow('reaper limit must be a positive integer');
      }
      const run = (await client.query('SELECT status FROM review_runs WHERE run_id = $1', [disabled.admitted.run.runId])).rows[0];
      expect(run.status).toBe('queued');
    });

    it('retires a disabled-mode queued run past its deadline with a projected outbox row, leaving an app-gate row untouched', async () => {
      const { repository, client } = await createRepository();
      const disabled = await queueProjected(repository, 'non-pub-disabled', 1_000, 'worker-disabled', {}, true);
      const gated = await queueProjected(repository, 'non-pub-app-gate', 1_000, 'worker-gate', { prNumber: 43 }, false);

      const retired = await repository.retireExpiredNonPublishableRuns(disabled.terminalDeadline + 1, 20);
      expect(retired).toBe(1);

      const disabledState = await dispatchState(client, disabled.admitted.run.runId);
      expect(disabledState.run).toMatchObject({
        status: 'terminal',
        stage: 'terminal',
        error_text: 'publication mode disabled: never claimed before its terminal deadline; retired by reaper',
        lease_owner: null,
      });
      expect(disabledState.outbox).toMatchObject({ status: 'terminal', lease_owner: null, lease_expires_at: null });

      // The app-gate row sits in the identical shape (queued, projected,
      // deadline passed) but must be left for claimAbandonedPublishingRuns.
      const gatedState = await dispatchState(client, gated.admitted.run.runId);
      expect(gatedState.run.status).toBe('queued');
      expect(gatedState.outbox.status).toBe('projected');
    });

    // Guards the exact defect the reviewer flagged: the two reapers must
    // stay each other's exact complement, by construction, for every mode
    // the action-dispatch contract can actually admit -- not a second
    // hardcoded list re-typed in this test that could itself drift from
    // PUBLISHABLE_PUBLICATION_MODES.
    it('routes every publication mode admitted by the action-dispatch schema to exactly one reaper', async () => {
      const { repository, client } = await createRepository();
      // actionDispatchRequestSchema is wrapped in a superRefine (ZodEffects);
      // unwrap to the underlying object shape to read the enum without
      // re-typing its literal values here.
      const modes = actionDispatchRequestSchema.innerType().shape.publishMode.options;
      expect(modes.length).toBeGreaterThan(0);

      for (const [index, mode] of modes.entries()) {
        const receivedAt = 1_000 + index * 1_000_000;
        const admission = {
          ...sameHeadAdmission(`partition-${mode}`, receivedAt, { prNumber: 9_000 + index }),
          publicationMode: mode,
        };
        const admitted = await repository.admit(admission);
        const workerId = `worker-partition-${mode}`;
        const claim = (await repository.claimNext(workerId, receivedAt + 1, 30_000))!;
        await repository.markProjected(claim.runId, workerId, claim.claimAttempt, `${workerId}-projection`, receivedAt + 2);
        const now = admission.terminalDeadline + 1;
        const isPublishable = (PUBLISHABLE_PUBLICATION_MODES as readonly string[]).includes(mode);

        const retiredCount = await repository.retireExpiredNonPublishableRuns(now, 20);
        const claimed = await repository.claimAbandonedPublishingRuns(`reaper-partition-${mode}`, now, 20);
        const claimedRunIds = claimed.map((run) => run.runId);

        if (isPublishable) {
          expect(retiredCount).toBe(0);
          expect(claimedRunIds).toContain(admitted.run.runId);
        } else {
          expect(retiredCount).toBe(1);
          expect(claimedRunIds).not.toContain(admitted.run.runId);
          expect((await dispatchState(client, admitted.run.runId)).run.status).toBe('terminal');
        }
      }
    });

    it('leaves a disabled-mode run alone before its terminal deadline', async () => {
      const { repository, client } = await createRepository();
      const disabled = await queueProjected(repository, 'non-pub-early', 1_000, 'worker-early');

      await expect(repository.retireExpiredNonPublishableRuns(disabled.terminalDeadline - 1, 20)).resolves.toBe(0);
      expect((await dispatchState(client, disabled.admitted.run.runId)).run.status).toBe('queued');
    });

    it('leaves a leased disabled-mode run alone', async () => {
      const { repository, client } = await createRepository();
      const disabled = await queueProjected(repository, 'non-pub-leased', 1_000, 'worker-leased');
      await client.query(
        "UPDATE review_runs SET lease_owner = 'concurrent-owner', lease_expires_at = to_timestamp(($2 + 60000) / 1000.0) WHERE run_id = $1",
        [disabled.admitted.run.runId, disabled.terminalDeadline],
      );

      await expect(repository.retireExpiredNonPublishableRuns(disabled.terminalDeadline + 1, 20)).resolves.toBe(0);
      expect((await dispatchState(client, disabled.admitted.run.runId)).run.status).toBe('queued');
    });

    // Mirrors claimAbandonedPublishingRuns's own expired-lease-is-unowned
    // treatment (runs.lease_expires_at <= now) and dispatchClaimPredicate's
    // identical treatment of the outbox lease: a claimant that died without
    // releasing its lease must not strand the row past its deadline forever.
    it('retires a disabled-mode run whose lease already expired (claimant died without releasing it)', async () => {
      const { repository, client } = await createRepository();
      const disabled = await queueProjected(repository, 'non-pub-expired-lease', 1_000, 'worker-expired-lease');
      await client.query(
        "UPDATE review_runs SET lease_owner = 'dead-worker', lease_expires_at = to_timestamp(($2 - 60000) / 1000.0) WHERE run_id = $1",
        [disabled.admitted.run.runId, disabled.terminalDeadline],
      );

      await expect(repository.retireExpiredNonPublishableRuns(disabled.terminalDeadline + 1, 20)).resolves.toBe(1);
      const state = await dispatchState(client, disabled.admitted.run.runId);
      expect(state.run).toMatchObject({
        status: 'terminal',
        stage: 'terminal',
        error_text: 'publication mode disabled: never claimed before its terminal deadline; retired by reaper',
        lease_owner: null,
        lease_expires_at: null,
      });
      expect(state.outbox).toMatchObject({ status: 'terminal', lease_owner: null, lease_expires_at: null });
    });

    it('leaves a non-app-gate expired queued run alone when it already carries a result digest', async () => {
      const { repository, client } = await createRepository();
      const disabled = await queueProjected(repository, 'non-pub-result-digest', 1_000, 'worker-result-digest');
      // A disabled-mode row should never legitimately reach this state while
      // queued, but the guard must hold defensively: a result already exists,
      // so this sweep must not overwrite it with a deadline retirement.
      await client.query(
        'UPDATE review_runs SET result_digest = $2 WHERE run_id = $1',
        [disabled.admitted.run.runId, 'f'.repeat(64)],
      );

      await expect(repository.retireExpiredNonPublishableRuns(disabled.terminalDeadline + 1, 20)).resolves.toBe(0);
      const state = await dispatchState(client, disabled.admitted.run.runId);
      expect(state.run.status).toBe('queued');
      expect(state.run.result_digest).toBe('f'.repeat(64));
      expect(state.outbox.status).toBe('projected');
    });

    it('leaves a non-app-gate expired queued run alone when it already carries an authoritative gate app id', async () => {
      const { repository, client } = await createRepository();
      const disabled = await queueProjected(repository, 'non-pub-authoritative-app-id', 1_000, 'worker-authoritative-app-id');
      // Same defensive shape: an authoritative gate reservation implies this
      // row belongs to the app-gate publishing path, not this sweep.
      await client.query(
        'UPDATE review_runs SET authoritative_gate_app_id = $2 WHERE run_id = $1',
        [disabled.admitted.run.runId, 4385771],
      );

      await expect(repository.retireExpiredNonPublishableRuns(disabled.terminalDeadline + 1, 20)).resolves.toBe(0);
      const state = await dispatchState(client, disabled.admitted.run.runId);
      expect(state.run.status).toBe('queued');
      expect(Number(state.run.authoritative_gate_app_id)).toBe(4385771);
      expect(state.outbox.status).toBe('projected');
    });

    it('retires a running non-app-gate run past its deadline with a free lease', async () => {
      const { repository, client } = await createRepository();
      const disabled = await queueProjected(repository, 'non-pub-running', 1_000, 'worker-running');
      await client.query("UPDATE review_runs SET status = 'running' WHERE run_id = $1", [disabled.admitted.run.runId]);

      await expect(repository.retireExpiredNonPublishableRuns(disabled.terminalDeadline + 1, 20)).resolves.toBe(1);
      const state = await dispatchState(client, disabled.admitted.run.runId);
      expect(state.run).toMatchObject({
        status: 'terminal',
        stage: 'terminal',
        error_text: 'publication mode disabled: never claimed before its terminal deadline; retired by reaper',
      });
      expect(state.outbox.status).toBe('terminal');
    });

    it('honours the limit', async () => {
      const { repository, client } = await createRepository();
      const first = await queueProjected(repository, 'non-pub-limit-1', 1_000, 'worker-limit-1', { prNumber: 51 });
      const second = await queueProjected(repository, 'non-pub-limit-2', 1_000, 'worker-limit-2', { prNumber: 52 });
      const third = await queueProjected(repository, 'non-pub-limit-3', 1_000, 'worker-limit-3', { prNumber: 53 });
      const now = first.terminalDeadline + 1;

      const retired = await repository.retireExpiredNonPublishableRuns(now, 2);
      expect(retired).toBe(2);
      const statuses = await Promise.all([first, second, third].map(async (entry) =>
        (await dispatchState(client, entry.admitted.run.runId)).run.status));
      expect(statuses.filter((status) => status === 'terminal')).toHaveLength(2);
      expect(statuses.filter((status) => status === 'queued')).toHaveLength(1);

      await expect(repository.retireExpiredNonPublishableRuns(now, 2)).resolves.toBe(1);
    });

    it('appends a terminal lifecycle event when lifecycle events are enabled', async () => {
      const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
      const disabled = await queueProjected(repository, 'non-pub-lifecycle', 1_000, 'worker-lifecycle');

      await repository.retireExpiredNonPublishableRuns(disabled.terminalDeadline + 1, 20);

      const events = await lifecycleEvents(client, disabled.admitted.run.runId);
      const terminalEvent = events.find((event) => event.eventKind === 'review.lifecycle.terminal');
      expect(terminalEvent?.data).toEqual({
        policy_digest: 'e'.repeat(64),
        stage: 'terminal', terminal_class: 'non_publishable_deadline', retry_class: 'reaper',
      });
    });
  });

  // REL-896: the Go operator's PRReviewJob controller observes a publishing
  // worker Job fail, get killed, disappear, or outlive its deadline and
  // delegates fail-closed publication to this reaper (see
  // k8s-operator/controllers/prreviewjob_v1alpha2_controller.go
  // reconcileFailurePublication). These tests exercise the exact-attempt
  // eligibility claimAbandonedPublishingRuns grants a matching candidate
  // BEFORE terminal_deadline, and prove every existing predicate (lease,
  // authoritative gate, exact attempt) still applies unchanged.
  describe('claimAbandonedPublishingRuns delegated-failure candidates (REL-896)', () => {
    async function admitClaimedAndProjected(
      repository: PostgresReviewDispatchRepository, deliveryId: string, receivedAt: number, workerId: string,
      overrides: Parameters<typeof sameHeadAdmission>[2] = {},
    ) {
      const admission = sameHeadAdmission(deliveryId, receivedAt, overrides);
      const admitted = await repository.admit(admission);
      const claim = (await repository.claimNext(workerId, receivedAt + 1, 30_000))!;
      await repository.markProjected(claim.runId, workerId, claim.claimAttempt, `${workerId}-projection`, receivedAt + 2);
      return { admitted, claim, terminalDeadline: admission.terminalDeadline };
    }

    it('claims a delegated candidate well before its terminal deadline', async () => {
      const { repository, client } = await createRepository();
      const run = await admitClaimedAndProjected(repository, 'delegated-early', 1_000, 'worker-delegated-early');
      const beforeDeadline = run.terminalDeadline - 1;

      const [claimed] = await repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 20, [
        { runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt, reason: 'worker_failed' },
      ]);
      expect(claimed).toMatchObject({
        runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt, delegatedReason: 'worker_failed',
      });
      const state = await dispatchState(client, run.admitted.run.runId);
      expect(state.run.status).toBe('terminal');
      expect(state.outbox.status).toBe('projected');
    });

    it('never claims a non-publishable (disabled-mode) run through the delegated branch', async () => {
      // The publication-mode gate sits after the whole OR group, so it must
      // cover the delegated branch too: a disabled-mode run has no App check to
      // fail closed and belongs to retireExpiredNonPublishableRuns, not here.
      const { repository, client } = await createRepository();
      const admission = { ...sameHeadAdmission('delegated-disabled-mode', 1_000), publicationMode: 'disabled' as const };
      const admitted = await repository.admit(admission);
      const claim = (await repository.claimNext('worker-delegated-disabled', 1_001, 30_000))!;
      await repository.markProjected(claim.runId, 'worker-delegated-disabled', claim.claimAttempt, 'worker-delegated-disabled-projection', 1_002);
      // Drop the projection lease so only the mode gate can be what refuses it.
      await client.query('UPDATE review_runs SET lease_owner = NULL, lease_expires_at = NULL WHERE run_id = $1', [admitted.run.runId]);

      const claimed = await repository.claimAbandonedPublishingRuns('reaper-delegated', admission.terminalDeadline - 1, 20, [
        { runId: admitted.run.runId, executionAttempt: claim.executionAttempt, reason: 'worker_failed' },
      ]);
      expect(claimed).toEqual([]);
      const state = await dispatchState(client, admitted.run.runId);
      expect(state.run.status).not.toBe('terminal');
      expect(state.run.failure_diagnostics ?? {}).not.toMatchObject({ reason: 'worker_failed' });
    });

    it('does not claim a stale candidate whose executionAttempt no longer matches the outbox', async () => {
      const { repository, client } = await createRepository();
      const run = await admitClaimedAndProjected(repository, 'delegated-stale-attempt', 1_000, 'worker-delegated-stale');
      const beforeDeadline = run.terminalDeadline - 1;

      // The candidate claims attempt 2 happened; the outbox is still on
      // attempt 1. A stale resource from a superseded attempt must never
      // kill the current one.
      await expect(repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 20, [
        { runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt + 1, reason: 'worker_failed' },
      ])).resolves.toEqual([]);
      expect((await dispatchState(client, run.admitted.run.runId)).run.status).toBe('queued');
    });

    it('does not claim a delegated candidate whose lease is still live', async () => {
      const { repository, client } = await createRepository();
      const run = await admitClaimedAndProjected(repository, 'delegated-leased', 1_000, 'worker-delegated-leased');
      const beforeDeadline = run.terminalDeadline - 1;
      await client.query(
        "UPDATE review_runs SET lease_owner = 'concurrent-owner', lease_expires_at = to_timestamp(($2 + 60000) / 1000.0) WHERE run_id = $1",
        [run.admitted.run.runId, beforeDeadline],
      );

      await expect(repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 20, [
        { runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt, reason: 'worker_failed' },
      ])).resolves.toEqual([]);
      expect((await dispatchState(client, run.admitted.run.runId)).run.status).toBe('queued');
    });

    it('does not claim a delegated candidate reserved by an authoritative gate', async () => {
      const { repository, client } = await createRepository();
      const run = await admitClaimedAndProjected(repository, 'delegated-authoritative', 1_000, 'worker-delegated-authoritative');
      const beforeDeadline = run.terminalDeadline - 1;
      await client.query(
        'UPDATE review_runs SET authoritative_gate_app_id = $2 WHERE run_id = $1',
        [run.admitted.run.runId, 4385771],
      );

      await expect(repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 20, [
        { runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt, reason: 'worker_failed' },
      ])).resolves.toEqual([]);
      expect((await dispatchState(client, run.admitted.run.runId)).run.status).toBe('queued');
    });

    it('leaves a non-delegated run alone before its deadline, exactly as the pre-REL-896 reaper did', async () => {
      const { repository, client } = await createRepository();
      const run = await admitClaimedAndProjected(repository, 'non-delegated-early', 1_000, 'worker-non-delegated', { prNumber: 61 });
      const beforeDeadline = run.terminalDeadline - 1;

      // An unrelated candidate in the same call must never widen eligibility
      // for a run it does not name.
      await expect(repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 20, [
        { runId: `run_${'9'.repeat(32)}`, executionAttempt: 1, reason: 'worker_failed' },
      ])).resolves.toEqual([]);
      expect((await dispatchState(client, run.admitted.run.runId)).run.status).toBe('queued');
    });

    it('claims several delegated candidates in one call, bounded by limit', async () => {
      const { repository, client } = await createRepository();
      const first = await admitClaimedAndProjected(repository, 'delegated-limit-1', 1_000, 'worker-delegated-limit-1', { prNumber: 71 });
      const second = await admitClaimedAndProjected(repository, 'delegated-limit-2', 1_000, 'worker-delegated-limit-2', { prNumber: 72 });
      const third = await admitClaimedAndProjected(repository, 'delegated-limit-3', 1_000, 'worker-delegated-limit-3', { prNumber: 73 });
      const beforeDeadline = first.terminalDeadline - 1;
      const candidates = [first, second, third].map((run) => ({
        runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt, reason: 'worker_deadline_exceeded' as const,
      }));

      const claimed = await repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 2, candidates);
      expect(claimed).toHaveLength(2);
      const statuses = await Promise.all([first, second, third].map(async (run) =>
        (await dispatchState(client, run.admitted.run.runId)).run.status));
      expect(statuses.filter((status) => status === 'terminal')).toHaveLength(2);
      expect(statuses.filter((status) => status === 'queued')).toHaveLength(1);

      const remainder = await repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 2, candidates);
      expect(remainder).toHaveLength(1);
    });

    it('persists the operator reason as structured failure diagnostics once reconciled', async () => {
      const { repository, client } = await createRepository();
      const run = await admitClaimedAndProjected(repository, 'delegated-diagnostics', 1_000, 'worker-delegated-diagnostics');
      const beforeDeadline = run.terminalDeadline - 1;

      const [claimed] = await repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 20, [
        { runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt, reason: 'worker_job_missing' },
      ]);
      await expect(repository.reconcileAbandonedPublishingRun(claimed, 'reaper-delegated', beforeDeadline + 1,
        async () => 'failure-published')).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });

      const state = await dispatchState(client, run.admitted.run.runId);
      expect(state.run.status).toBe('terminal');
      expect(state.run.failure_diagnostics).toMatchObject({
        reason: 'worker_job_missing',
        failureClass: 'internal_error',
      });
    });

    it('collapses a duplicate (runId, executionAttempt) candidate pair to exactly one claim, deterministically, with no duplicated persisted state', async () => {
      const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
      const run = await admitClaimedAndProjected(
        repository, 'delegated-duplicate-candidate', 1_000, 'worker-delegated-duplicate',
      );
      const beforeDeadline = run.terminalDeadline - 1;
      const identity = { runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt };

      // The same (runId, executionAttempt) pair listed twice with two
      // different reasons -- e.g. two DelegatedFailureReader poll pages
      // observing the same resource in different transient states. Postgres's
      // UPDATE ... FROM semantics already guarantee exactly one claimed row
      // here even without the CTE's DISTINCT ON (only one, unspecified,
      // matching FROM row is ever applied per target row) -- so the row-count
      // assertion below is defense in depth, not the primary risk. What
      // DISTINCT ON (+ WITH ORDINALITY's deterministic ORDER BY) actually
      // fixes is *which* reason survives: without it, the surviving
      // delegated_reason on this one claimed row is an arbitrary, unpredictable
      // pick between the two candidates rather than the earliest-supplied one.
      const claimed = await repository.claimAbandonedPublishingRuns('reaper-duplicate-candidate', beforeDeadline, 20, [
        { ...identity, reason: 'worker_failed' },
        { ...identity, reason: 'worker_deadline_exceeded' },
      ]);

      expect(claimed).toHaveLength(1);
      // Deterministic winner: the CTE orders by `WITH ORDINALITY` position in
      // the caller-supplied array, so the first-listed reason ('worker_failed')
      // wins over the later duplicate ('worker_deadline_exceeded').
      expect(claimed[0]).toMatchObject({ runId: run.admitted.run.runId, delegatedReason: 'worker_failed' });

      // Not duplicated at claim time: the run/outbox pair was touched by
      // exactly one row from the CTE, not fanned out into two updates, so
      // there is exactly one 'publishing_deadline' terminal lifecycle event
      // (claimAbandonedPublishingRuns appends one per RETURNING row).
      const claimState = await dispatchState(client, run.admitted.run.runId);
      expect(claimState.run.status).toBe('terminal');
      expect(claimState.outbox.status).toBe('projected');
      const claimEvents = (await lifecycleEvents(client, run.admitted.run.runId))
        .filter((event) => event.eventKind === 'review.lifecycle.terminal' && event.data.terminal_class === 'publishing_deadline');
      expect(claimEvents).toHaveLength(1);

      await expect(repository.reconcileAbandonedPublishingRun(claimed[0], 'reaper-duplicate-candidate', beforeDeadline + 1,
        async () => 'failure-published')).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });

      // Not duplicated at reconcile time either: a single failure_diagnostics
      // object bound to the winning reason, not two conflicting writes.
      const state = await dispatchState(client, run.admitted.run.runId);
      expect(state.run.status).toBe('terminal');
      expect(state.outbox.status).toBe('terminal');
      expect(state.run.failure_diagnostics).toMatchObject({ reason: 'worker_failed', failureClass: 'internal_error' });
    });

    // REL-896 follow-up: a `WorkerContractRejected` review never gets past
    // BuildWorkerJob, so the outbox never advances beyond its first
    // dispatch attempt (execution_attempt stays 0, the returned claim
    // attempt is 1, and the run itself never leaves 'queued'). This is
    // exactly the "first-attempt contract rejection" shape -- projected
    // dispatch, queued run, no worker completion row, no active lease --
    // that the delegated branch at claimAbandonedPublishingRuns must accept;
    // admitClaimedAndProjected already reproduces it unmodified.
    it('claims a first-attempt worker_contract_rejected candidate before its terminal deadline', async () => {
      const { repository, client } = await createRepository();
      const run = await admitClaimedAndProjected(
        repository, 'delegated-contract-rejected', 1_000, 'worker-delegated-contract-rejected',
      );
      const beforeDeadline = run.terminalDeadline - 1;
      expect(run.claim.executionAttempt).toBe(1);

      const [claimed] = await repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 20, [
        { runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt, reason: 'worker_contract_rejected' },
      ]);
      expect(claimed).toMatchObject({
        runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt,
        delegatedReason: 'worker_contract_rejected',
      });
      const state = await dispatchState(client, run.admitted.run.runId);
      expect(state.run.status).toBe('terminal');
      expect(state.outbox.status).toBe('projected');

      await expect(repository.reconcileAbandonedPublishingRun(claimed, 'reaper-delegated', beforeDeadline + 1,
        async () => 'failure-published')).resolves.toEqual({ reconciled: true, outcome: 'failure-published' });
      const reconciled = await dispatchState(client, run.admitted.run.runId);
      expect(reconciled.run.failure_diagnostics).toMatchObject({
        reason: 'worker_contract_rejected',
        failureClass: 'internal_error',
      });
    });

    it('does not claim a worker_contract_rejected candidate whose executionAttempt no longer matches the outbox', async () => {
      const { repository, client } = await createRepository();
      const run = await admitClaimedAndProjected(
        repository, 'delegated-contract-rejected-stale', 1_000, 'worker-delegated-contract-rejected-stale',
      );
      const beforeDeadline = run.terminalDeadline - 1;

      await expect(repository.claimAbandonedPublishingRuns('reaper-delegated', beforeDeadline, 20, [
        { runId: run.admitted.run.runId, executionAttempt: run.claim.executionAttempt + 1, reason: 'worker_contract_rejected' },
      ])).resolves.toEqual([]);
      expect((await dispatchState(client, run.admitted.run.runId)).run.status).toBe('queued');
    });
  });

  describe('terminalizeRunsForClosedPullRequest (REL-896)', () => {
    const closedInput = (input: Parameters<PostgresReviewDispatchRepository['admit']>[0], merged: boolean, now: number) => ({
      repositoryId: input.repositoryId,
      owner: input.identity.owner,
      repo: input.identity.repo,
      prNumber: input.identity.prNumber,
      merged,
      now,
      deliveryId: 'github-webhook:close-delivery',
    });

    it('terminalizes a queued run and its outbox row when the PR is closed without merging', async () => {
      const { repository, client } = await createRepository();
      const input = sameHeadAdmission('closed-queued', 1_000);
      const admitted = await repository.admit(input);

      const result = await repository.terminalizeRunsForClosedPullRequest(closedInput(input, false, 2_000));

      expect(result.terminalizedRunIds).toEqual([admitted.run.runId]);
      const state = await dispatchState(client, admitted.run.runId);
      expect(state.run).toMatchObject({
        status: 'terminal', stage: 'terminal',
        error_text: 'pull request closed before the review completed',
        lease_owner: null, lease_expires_at: null,
      });
      expect(state.outbox).toMatchObject({ status: 'terminal', lease_owner: null, lease_expires_at: null });
    });

    it('terminalizes a claimed (leased) run and its outbox row when the PR is merged', async () => {
      const { repository, client } = await createRepository();
      const input = sameHeadAdmission('closed-merged', 1_000);
      const admitted = await repository.admit(input);
      const claim = (await repository.claimNext('worker-merged', 1_001, 30_000))!;
      expect(claim).not.toBeNull();

      const result = await repository.terminalizeRunsForClosedPullRequest(closedInput(input, true, 2_000));

      expect(result.terminalizedRunIds).toEqual([admitted.run.runId]);
      const state = await dispatchState(client, admitted.run.runId);
      expect(state.run).toMatchObject({
        status: 'terminal', stage: 'terminal',
        error_text: 'pull request merged before the review completed',
        lease_owner: null, lease_expires_at: null,
      });
      // The outbox held a live claim lease from claimNext; closing the PR
      // clears it unconditionally, exactly like admit()'s own supersede CTE
      // does for a superseded run's outbox row.
      expect(state.outbox).toMatchObject({ status: 'terminal', lease_owner: null, lease_expires_at: null });
    });

    it('leaves an authoritative-gate run untouched', async () => {
      const { repository, client } = await createRepository();
      const input = authoritativeAdmission('closed-authoritative', 1_000);
      const admitted = await repository.admit(input);
      expect(Number((await dispatchState(client, admitted.run.runId)).run.authoritative_gate_app_id)).toBe(4385771);

      const result = await repository.terminalizeRunsForClosedPullRequest({
        repositoryId: 123, owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
        merged: false, now: 2_000, deliveryId: 'github-webhook:close-authoritative',
      });

      expect(result.terminalizedRunIds).toEqual([]);
      const state = await dispatchState(client, admitted.run.runId);
      expect(state.run.status).toBe('queued');
      expect(state.run.error_text).toBeNull();
    });

    it("leaves another PR's run untouched", async () => {
      const { repository, client } = await createRepository();
      const closing = await repository.admit(sameHeadAdmission('closed-this-pr', 1_000, { prNumber: 42 }));
      const other = await repository.admit(sameHeadAdmission('closed-other-pr', 1_000, { prNumber: 43 }));

      const result = await repository.terminalizeRunsForClosedPullRequest({
        repositoryId: 123, owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 42,
        merged: false, now: 2_000, deliveryId: 'github-webhook:close-this-pr',
      });

      expect(result.terminalizedRunIds).toEqual([closing.run.runId]);
      expect((await dispatchState(client, other.run.runId)).run.status).toBe('queued');
    });

    it('is invisible to the abandoned-publishing reaper after its original deadline passes: no check is ever minted', async () => {
      const { repository, client } = await createRepository();
      const input = sameHeadAdmission('closed-reaper-immune', 1_000);
      const admitted = await repository.admit(input);

      await repository.terminalizeRunsForClosedPullRequest(closedInput(input, false, 1_500));

      const claimed = await repository.claimAbandonedPublishingRuns('reaper-after-close', input.terminalDeadline + 1, 20);
      expect(claimed.map((run) => run.runId)).not.toContain(admitted.run.runId);
      const retired = await repository.retireExpiredNonPublishableRuns(input.terminalDeadline + 1, 20);
      expect(retired).toBe(0);
      const state = await dispatchState(client, admitted.run.runId);
      expect(state.run).toMatchObject({
        status: 'terminal',
        error_text: 'pull request closed before the review completed',
      });
    });

    it('ignores a late worker failure callback for the closed run without crashing or resurrecting it', async () => {
      const { repository, client } = await createRepository();
      const input = sameHeadAdmission('closed-late-failure', 1_000);
      const admitted = await repository.admit(input);
      const claim = (await repository.claimNext('worker-late-failure', 1_001, 30_000))!;
      const workerTokenDigest = 'a'.repeat(64);
      expect(await repository.bindWorkerTokenDigest(
        claim.runId, claim.leaseOwner, claim.claimAttempt, workerTokenDigest, 1_002,
      )).toBe(true);

      await repository.terminalizeRunsForClosedPullRequest(closedInput(input, false, 1_500));

      await expect(repository.markWorkerFailure({
        version: 'WorkerTerminalFailure.v1', runId: admitted.run.runId,
        owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
        headSha: input.identity.headSha, baseSha: input.identity.baseSha,
        repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
        configDigest: input.identity.configDigest, executionAttempt: claim.executionAttempt,
        failureClass: 'provider_error',
      }, { workerTokenDigest }, 2_000)).resolves.toEqual({ runId: admitted.run.runId, status: 'already_failed' });

      const state = await dispatchState(client, admitted.run.runId);
      expect(state.run).toMatchObject({
        status: 'terminal',
        error_text: 'pull request closed before the review completed',
      });
    });

    it('ignores a late worker success callback for the closed run without crashing or resurrecting it', async () => {
      const { repository, client } = await createRepository();
      const input = sameHeadAdmission('closed-late-success', 1_000);
      const admitted = await repository.admit(input);
      const claim = (await repository.claimNext('worker-late-success', 1_001, 30_000))!;
      const workerTokenDigest = 'a'.repeat(64);
      expect(await repository.bindWorkerTokenDigest(
        claim.runId, claim.leaseOwner, claim.claimAttempt, workerTokenDigest, 1_002,
      )).toBe(true);

      await repository.terminalizeRunsForClosedPullRequest(closedInput(input, true, 1_500));

      await expect(repository.markWorkerSuccess({
        version: 'WorkerTerminalSuccess.v1', runId: admitted.run.runId,
        owner: input.identity.owner, repo: input.identity.repo, prNumber: input.identity.prNumber,
        headSha: input.identity.headSha, baseSha: input.identity.baseSha,
        repositoryId: input.repositoryId, policyDigest: input.effectivePolicyDigest!,
        configDigest: input.identity.configDigest, executionAttempt: claim.executionAttempt,
        checkId: 999,
      }, { workerTokenDigest }, 2_000)).resolves.toEqual({ runId: admitted.run.runId, status: 'conflict' });

      const state = await dispatchState(client, admitted.run.runId);
      expect(state.run).toMatchObject({
        status: 'terminal',
        error_text: 'pull request merged before the review completed',
      });
    });

    it('is a no-op that returns an empty list for a redelivered close (idempotent)', async () => {
      const { repository, client } = await createRepository();
      const input = sameHeadAdmission('closed-redelivered', 1_000);
      const admitted = await repository.admit(input);

      const first = await repository.terminalizeRunsForClosedPullRequest(closedInput(input, false, 1_500));
      expect(first.terminalizedRunIds).toEqual([admitted.run.runId]);
      const afterFirst = await dispatchState(client, admitted.run.runId);

      const second = await repository.terminalizeRunsForClosedPullRequest(closedInput(input, false, 1_600));
      expect(second.terminalizedRunIds).toEqual([]);
      expect(await dispatchState(client, admitted.run.runId)).toEqual(afterFirst);
    });

    it('is a no-op that returns an empty list for a PR with no in-flight runs', async () => {
      const { repository } = await createRepository();
      const result = await repository.terminalizeRunsForClosedPullRequest({
        repositoryId: 123, owner: 'calltelemetry', repo: 'cisco-cdr', prNumber: 999,
        merged: false, now: 1_000, deliveryId: 'github-webhook:close-nothing',
      });
      expect(result.terminalizedRunIds).toEqual([]);
    });

    it('reopens with a fresh claimable run on the same head after a close', async () => {
      const { repository } = await createRepository();
      const input = sameHeadAdmission('closed-reopen-original', 1_000);
      const admitted = await repository.admit(input);
      await repository.terminalizeRunsForClosedPullRequest(closedInput(input, false, 1_500));

      // The GitHub 'reopened' action goes through the ordinary pull_request
      // admission path (createGitHubWebhookAdmissionHandler), which calls
      // admit() with no retryRequested flag -- exactly sameHeadAdmission here.
      // Because the identity (owner/repo/prNumber/headSha/baseSha/configDigest)
      // is unchanged, this resolves to the SAME identity_digest/run_id, and
      // admit()'s retry_eligibility CTE already treats any 'terminal' row as
      // retry-eligible when retryRequested is not set.
      const reopened = await repository.admit(sameHeadAdmission('closed-reopen-redelivery', 2_000));

      expect(reopened.run).toMatchObject({ runId: admitted.run.runId, status: 'queued', attempt: 1 });
      const claim = await repository.claimNext('worker-reopen', 2_001, 30_000);
      expect(claim).toMatchObject({ runId: admitted.run.runId });
    });

    it('appends a terminal lifecycle event distinguishing merged from closed', async () => {
      const { repository, client } = await createRepository({ lifecycleEvents: 'enabled' }, true);
      const mergedInput = sameHeadAdmission('closed-lifecycle-merged', 1_000);
      const merged = await repository.admit(mergedInput);
      const unmergedInput = sameHeadAdmission('closed-lifecycle-unmerged', 1_000, { prNumber: 51 });
      const closed = await repository.admit(unmergedInput);

      await repository.terminalizeRunsForClosedPullRequest(closedInput(mergedInput, true, 2_000));
      await repository.terminalizeRunsForClosedPullRequest(closedInput(unmergedInput, false, 2_000));

      const mergedEvents = await lifecycleEvents(client, merged.run.runId);
      expect(mergedEvents.find((event) => event.eventKind === 'review.lifecycle.terminal')?.data).toEqual({
        policy_digest: 'e'.repeat(64),
        stage: 'terminal', terminal_class: 'pull_request_merged', retry_class: 'pull_request_closed',
      });
      const closedEvents = await lifecycleEvents(client, closed.run.runId);
      expect(closedEvents.find((event) => event.eventKind === 'review.lifecycle.terminal')?.data).toEqual({
        policy_digest: 'e'.repeat(64),
        stage: 'terminal', terminal_class: 'pull_request_closed', retry_class: 'pull_request_closed',
      });
    });
  });

  describe('claimed-run cancellation race (REL-1073)', () => {
    const projectionName = 'ct-review-orphaned';

    async function outboxRow(client: PoolClient, runId: string) {
      return (await client.query(
        `SELECT status, projection_name, cancel_requested_at, cancel_propagated_at, cancel_reason
           FROM review_dispatch_outbox WHERE run_id = $1`, [runId])).rows[0];
    }

    it('reopens a supersede that landed mid-claim so the sweep owns the created PRReviewJob', async () => {
      const { repository, client } = await createRepository();
      const prior = await repository.admit(sameHeadAdmission('race-prior', 1_000));
      const claim = (await repository.claimNext('dispatcher-a', 1_100, 30_000))!;
      expect(claim.runId).toBe(prior.run.runId);

      // Admission supersedes while the dispatcher still holds the claim.
      await repository.admit(sameHeadAdmission('race-current', 1_200, { baseSha: '1'.repeat(40) }));
      const retired = await outboxRow(client, claim.runId);
      expect(retired).toMatchObject({ status: 'terminal', projection_name: null, cancel_reason: 'superseded_by_new_head' });
      // The bug's precondition: already marked propagated, invisible to the sweep.
      expect(retired.cancel_propagated_at).not.toBeNull();
      expect(await repository.findPendingCancellations(10)).toEqual([]);

      // The dispatcher's ensure() created the PRReviewJob; markProjected loses.
      await expect(repository.markProjected(claim.runId, 'dispatcher-a', claim.claimAttempt, projectionName, 1_300))
        .resolves.toBe(false);

      await expect(repository.reopenOrphanedProjectionCancellation(
        claim.runId, claim.claimAttempt, projectionName, 1_400,
      )).resolves.toEqual({
        runId: claim.runId, executionAttempt: claim.executionAttempt, projectionName,
        cancelReason: 'superseded_by_new_head',
      });
      expect(await outboxRow(client, claim.runId)).toMatchObject({
        status: 'terminal', projection_name: projectionName, cancel_propagated_at: null,
      });
      expect((await client.query('SELECT cancel_propagated_at FROM review_runs WHERE run_id = $1', [claim.runId]))
        .rows[0].cancel_propagated_at).toBeNull();
      expect(await repository.findPendingCancellations(10)).toEqual([{
        runId: claim.runId, executionAttempt: claim.executionAttempt, projectionName,
        cancelReason: 'superseded_by_new_head',
      }]);

      // Once: a row that now carries a projection name belongs to the sweep.
      await expect(repository.reopenOrphanedProjectionCancellation(
        claim.runId, claim.claimAttempt, projectionName, 1_500,
      )).resolves.toBeNull();
      await expect(repository.markCancelPropagated(claim.runId, claim.executionAttempt, 1_600)).resolves.toBe(true);
      expect(await repository.findPendingCancellations(10)).toEqual([]);
      expect((await client.query('SELECT cancel_propagated_at FROM review_runs WHERE run_id = $1', [claim.runId]))
        .rows[0].cancel_propagated_at).not.toBeNull();
    });

    it('reopens a pull-request-closed cancel that landed mid-claim', async () => {
      const { repository, client } = await createRepository();
      await repository.admit(sameHeadAdmission('race-closed', 1_000));
      const claim = (await repository.claimNext('dispatcher-a', 1_100, 30_000))!;
      await repository.cancelRunsForPullRequest(claim.repositoryId, claim.prNumber, 'pull_request_closed', 1_200);
      expect((await outboxRow(client, claim.runId)).cancel_propagated_at).not.toBeNull();
      await expect(repository.reopenOrphanedProjectionCancellation(
        claim.runId, claim.claimAttempt, projectionName, 1_300,
      )).resolves.toMatchObject({ runId: claim.runId, cancelReason: 'pull_request_closed' });
    });

    it('refuses a foreign claim attempt, a live claim, and a terminal row no cancel retired', async () => {
      const { repository, client } = await createRepository();
      await repository.admit(sameHeadAdmission('race-guards', 1_000));
      const claim = (await repository.claimNext('dispatcher-a', 1_100, 30_000))!;
      // Still claimed, not cancelled: nothing to reopen.
      await expect(repository.reopenOrphanedProjectionCancellation(
        claim.runId, claim.claimAttempt, projectionName, 1_150,
      )).resolves.toBeNull();
      // Retired by the dispatcher itself (not a cancel).
      await expect(repository.markTerminal(claim.runId, 'dispatcher-a', claim.claimAttempt, 1_200,
        'review job projection rejected', { reason: 'review_job_projection_rejected', logTail: 'x' })).resolves.toBe(true);
      await expect(repository.reopenOrphanedProjectionCancellation(
        claim.runId, claim.claimAttempt, projectionName, 1_300,
      )).resolves.toBeNull();
      // A cancel on a different claim attempt is not this dispatcher's projection.
      await client.query(`UPDATE review_dispatch_outbox SET cancel_requested_at = to_timestamp(1.2),
        cancel_propagated_at = to_timestamp(1.2) WHERE run_id = $1`, [claim.runId]);
      await expect(repository.reopenOrphanedProjectionCancellation(
        claim.runId, claim.claimAttempt + 1, projectionName, 1_400,
      )).resolves.toBeNull();
      await expect(repository.reopenOrphanedProjectionCancellation(
        claim.runId, claim.claimAttempt, '  ', 1_400,
      )).rejects.toThrow('projection name is required');
    });

    it('cancels the PRReviewJob the dispatcher created when admission supersedes during ensure()', async () => {
      const { repository, client } = await createRepository();
      await repository.admit(sameHeadAdmission('race-engine-prior', 1_000));
      let clock = 1_100;
      const created: string[] = [];
      const patched: Array<{ name: string; reason?: string }> = [];
      const projector = {
        ensure: vi.fn(async (projection: { metadata: { name: string } }) => {
          // The race: admission commits between claim and markProjected.
          await repository.admit(sameHeadAdmission('race-engine-current', 1_150, { baseSha: '1'.repeat(40) }));
          created.push(projection.metadata.name);
        }),
        patchCancellation: vi.fn(async (name: string, _namespace: string, reason?: string) => {
          patched.push({ name, reason });
          return { status: 'patched' as const, cancelRequested: true };
        }),
      };
      const { ReviewJobDispatchEngine } = await import('../../src/k8s/reviewJobDispatchEngine');
      const engine = new ReviewJobDispatchEngine({
        repository,
        projector,
        runSecretProvisioner: { provision: async () => ({ workerTokenDigest: 'f'.repeat(64) }) },
        workerId: 'dispatcher-a',
        workerImage: `ghcr.io/review-yeti-ai/review-yeti-worker@sha256:${'e'.repeat(64)}`,
        namespace: 'ct-review',
        now: () => clock++,
      });

      const outcome = await engine.runOnce();
      expect(outcome).toMatchObject({ status: 'lease-lost', orphanedCancellation: 'propagated' });
      expect(created).toHaveLength(1);
      expect(patched).toEqual([{ name: created[0], reason: 'superseded_by_new_head' }]);
      const row = await outboxRow(client, (outcome as { runId: string }).runId);
      expect(row).toMatchObject({ status: 'terminal', projection_name: created[0] });
      expect(row.cancel_propagated_at).not.toBeNull();
      // Nothing left for the sweep: the cancel is verified and recorded.
      expect(await repository.findPendingCancellations(10)).toEqual([]);
    });
  });
});
