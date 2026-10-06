import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { GitHubReviewGateClient } from '../../src/github/reviewGateClient';
import {
  PostgresOperatorPassthroughRepository,
} from '../../src/persistence/operatorPassthroughRepository';
import { OPERATOR_PASSTHROUGH_SCHEMA_SQL } from '../../src/persistence/operatorPassthroughSchema';
import { reviewDispatchPrLockKey } from '../../src/persistence/reviewCiPersistence';
import { OperatorPassthroughPublisher } from '../../src/review/operatorPassthroughPublisher';
import type {
  OperatorPassthroughCandidate,
  OperatorPassthroughPublicationClaim,
  OperatorPassthroughReconcileCursor,
  OperatorPassthroughRecordInput,
} from '../../src/review/operatorPassthrough';
import type { ReviewGateCheck } from '../../src/review/reviewCheckIdentity';
import {
  describeWithPostgres as describeWithPostgresShared,
  postgresDatabaseUrl,
  requireDatabaseUrlInCi,
} from '../support/postgresSuite';

requireDatabaseUrlInCi();

const databaseUrl = postgresDatabaseUrl();
const describeWithPostgres = describeWithPostgresShared;
const OWNED_SCHEMA = /^operator_passthrough_[0-9a-f]{16}$/u;
const EXPECTED_APP_ID = 15368;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');

describeWithPostgres('PostgresOperatorPassthroughRepository durable publication lifecycle', () => {
  let adminPool: Pool | undefined;
  let pool: Pool | undefined;
  let schemaName = '';
  let repository: PostgresOperatorPassthroughRepository;

  function inputFor(
    overrides: Partial<OperatorPassthroughCandidate> = {},
    deliveryId = randomUUID(),
    deliveryDigest = 'd'.repeat(64),
  ): OperatorPassthroughRecordInput {
    return {
      candidate: {
        owner: 'review-yeti-ai',
        repo: 'review-yeti-bot',
        repositoryId: randomInt(1_100_000_000, 2_000_000_000),
        prNumber: 42,
        headSha: 'a'.repeat(40),
        baseSha: 'b'.repeat(40),
        policyDigest: 'c'.repeat(64),
        ...overrides,
      },
      expectedAppId: EXPECTED_APP_ID,
      event: {
        transport: 'github-app',
        eventName: 'pull_request_target',
        deliveryId,
        deliveryDigest,
      },
    };
  }

  function checkForClaim(claim: OperatorPassthroughPublicationClaim, id: number,
    conclusion: 'success' | 'failure' = 'success'): ReviewGateCheck {
    return {
      id,
      name: claim.stage === 'review' ? 'Review Yeti' : 'Review Yeti Gate',
      appId: claim.expectedAppId,
      headSha: claim.coordinates.headSha,
      externalId: claim.stage === 'review' ? claim.reviewExternalId : claim.gateExternalId,
      status: 'completed',
      conclusion,
    };
  }

  beforeAll(async () => {
    schemaName = `operator_passthrough_${randomBytes(8).toString('hex')}`;
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({
      connectionString: databaseUrl,
      max: 6,
      options: `-c search_path=${schemaName},public`,
      application_name: schemaName,
    });
    await pool.query(`CREATE TABLE review_runs (
      run_id TEXT NOT NULL,
      repository_id BIGINT NOT NULL,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      effective_policy_digest TEXT NOT NULL,
      authoritative_gate_app_id BIGINT NOT NULL,
      publication_mode TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )`);
    repository = new PostgresOperatorPassthroughRepository(pool);
  });

  beforeEach(async () => {
    await pool!.query(OPERATOR_PASSTHROUGH_SCHEMA_SQL);
  });

  afterEach(async () => {
    await pool!.query('TRUNCATE TABLE review_operator_passthrough_events, review_operator_passthrough_publications');
    await pool!.query('TRUNCATE TABLE review_runs');
  });

  afterAll(async () => {
    try {
      await pool?.end();
    } finally {
      try {
        if (adminPool && OWNED_SCHEMA.test(schemaName)) {
          await adminPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
        }
      } finally {
        await adminPool?.end();
      }
    }
  });

  it('reapplies its schema without losing either durable table', async () => {
    await pool!.query(OPERATOR_PASSTHROUGH_SCHEMA_SQL);

    const result = await pool!.query(`SELECT
      to_regclass('review_operator_passthrough_publications') IS NOT NULL AS publications,
      to_regclass('review_operator_passthrough_events') IS NOT NULL AS events`);

    expect(result.rows[0]).toEqual({ publications: true, events: true });

    const statusIndex = await pool!.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname=$1 AND indexname='review_operator_passthrough_status_idx'`, [schemaName]);
    expect(statusIndex.rows).toHaveLength(1);
    expect(statusIndex.rows[0].indexdef)
      .toMatch(/USING btree \(owner, repo, pr_number, publication_sequence DESC, created_at DESC\)/u);
    expect(statusIndex.rows[0].indexdef).toContain('retirement_requested_at IS NULL');
    expect(statusIndex.rows[0].indexdef).toContain('retired_at IS NULL');
  });

  it('claims the next due publication when the optional publication ID filter is omitted', async () => {
    const recorded = await repository.record(inputFor(), NOW);

    await expect(repository.claimPublication('publisher-unfiltered-claim', NOW, 10_000))
      .resolves.toMatchObject({
        publicationId: recorded.publicationId,
        stage: 'review',
        mayCreate: true,
        retiring: false,
      });
  });

  it('lists only configured app-gate admissions and advances by repository/PR keyset', async () => {
    const repositoryId = 1_345_678_901;
    const otherRepositoryId = repositoryId + 1;
    const appId = EXPECTED_APP_ID;
    const policyDigest = 'c'.repeat(64);
    const baseSha = 'b'.repeat(40);
    const headFor = (prNumber: number) => prNumber.toString(16).padStart(40, '0');
    const addRun = async (runId: string, prNumber: number, options: {
      repositoryId?: number; appId?: number; publicationMode?: string; headSha?: string;
      policyDigest?: string; createdAt?: string;
    } = {}) => pool!.query(`INSERT INTO review_runs(
      run_id,repository_id,owner,repo,pr_number,head_sha,base_sha,effective_policy_digest,
      authoritative_gate_app_id,publication_mode,created_at)
      VALUES($1,$2,'review-yeti-ai','review-yeti-bot',$3,$4,$5,$6,$7,$8,$9)`, [
      runId, options.repositoryId ?? repositoryId, prNumber, options.headSha ?? headFor(prNumber), baseSha,
      options.policyDigest ?? policyDigest, options.appId ?? appId, options.publicationMode ?? 'app-gate',
      options.createdAt ?? `2026-10-05T12:${String(prNumber).padStart(2, '0')}:00.000Z`,
    ]);

    await addRun('run-old', 1, { createdAt: '2026-10-05T12:01:00.000Z' });
    await addRun('run-new', 1, { headSha: 'f'.repeat(40), createdAt: '2026-10-05T12:02:00.000Z' });
    await addRun('run-active', 2);
    await addRun('run-wrong-app', 3, { appId: EXPECTED_APP_ID + 1 });
    await addRun('run-wrong-mode', 4, { publicationMode: 'legacy' });
    await addRun('run-wrong-repository', 5, { repositoryId: otherRepositoryId });

    const active = inputFor({ repositoryId, prNumber: 2, headSha: headFor(2), baseSha, policyDigest });
    await repository.record(active, NOW);

    const firstPage = await repository.listPausedAdmissions([repositoryId], [appId], 10);
    expect(firstPage).toEqual([{
      runId: 'run-new', repositoryId, owner: 'review-yeti-ai', repo: 'review-yeti-bot', prNumber: 1,
      headSha: 'f'.repeat(40), baseSha, admittedPolicyDigest: policyDigest,
    }]);

    const after: OperatorPassthroughReconcileCursor = { repositoryId, prNumber: 2 };
    await addRun('run-after-cursor', 6);
    await expect(repository.listPausedAdmissions([repositoryId], [appId], 10, after)).resolves.toEqual([{
      runId: 'run-after-cursor', repositoryId, owner: 'review-yeti-ai', repo: 'review-yeti-bot', prNumber: 6,
      headSha: headFor(6), baseSha, admittedPolicyDigest: policyDigest,
    }]);
  });

  it('keeps canonical candidate coordinates and rejects persisted identity tampering', async () => {
    const input = inputFor();
    const recorded = await repository.record(input, NOW);
    const expectedCoordinates = {
      ...input.candidate,
      kind: 'operator-passthrough',
      publicationId: recorded.publicationId,
      publicationSequence: 1,
      auditDigest: recorded.auditDigest,
    };

    await expect(repository.getPublication(recorded.publicationId)).resolves.toMatchObject({
      coordinates: expectedCoordinates,
      expectedAppId: EXPECTED_APP_ID,
      reviewExternalId: expect.any(String),
      gateExternalId: expect.any(String),
      readyForShip: false,
    });

    const changedCandidate = { ...input.candidate, headSha: 'f'.repeat(40) };
    await expect(repository.record({ ...input, candidate: changedCandidate }, NOW + 1)).rejects.toThrow();

    await expect(pool!.query(`UPDATE review_operator_passthrough_publications
      SET head_sha=$2 WHERE publication_id=$1`, [recorded.publicationId, 'f'.repeat(40)]))
      .rejects.toMatchObject({ code: 'P0001' });
    await expect(pool!.query(`UPDATE review_operator_passthrough_publications
      SET coordinates=jsonb_set(coordinates, '{repo}', to_jsonb($2::text)) WHERE publication_id=$1`,
    [recorded.publicationId, 'tampered-repo']))
      .rejects.toMatchObject({ code: 'P0001' });
    await expect(pool!.query(`UPDATE review_operator_passthrough_publications
      SET review_external_id=review_external_id || '-tampered' WHERE publication_id=$1`, [recorded.publicationId]))
      .rejects.toMatchObject({ code: 'P0001' });

    await expect(repository.getPublication(recorded.publicationId)).resolves.toMatchObject({
      coordinates: expectedCoordinates,
      readyForShip: false,
    });
  });

  it('keeps source events append-only after recording a publication', async () => {
    const input = inputFor();
    const recorded = await repository.record(input, NOW);

    await expect(pool!.query(`UPDATE review_operator_passthrough_events
      SET event_name='edited-event' WHERE delivery_id=$1`, [input.event.deliveryId]))
      .rejects.toMatchObject({ code: 'P0001' });
    await expect(pool!.query('DELETE FROM review_operator_passthrough_events WHERE delivery_id=$1',
      [input.event.deliveryId]))
      .rejects.toMatchObject({ code: 'P0001' });

    const stored = await pool!.query(`SELECT delivery_id, publication_id, transport, event_name,
      delivery_digest, event_audit_digest FROM review_operator_passthrough_events`);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      delivery_id: input.event.deliveryId,
      publication_id: recorded.publicationId,
      transport: 'github-app',
      event_name: 'pull_request_target',
      delivery_digest: 'd'.repeat(64),
    });
    expect(stored.rows[0].event_audit_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('replays duplicate deliveries idempotently while appending a distinct delivery once', async () => {
    const input = inputFor();
    const first = await repository.record(input, NOW);
    const replay = await repository.record(input, NOW + 1);

    expect(first.status).toBe('accepted');
    expect(replay).toMatchObject({
      status: 'duplicate',
      publicationId: first.publicationId,
      auditDigest: first.auditDigest,
      verdict: 'SHIP',
      expectedLanes: 0,
      completedLanes: 0,
    });

    const separateDelivery = {
      ...input,
      event: { ...input.event, deliveryId: randomUUID(), deliveryDigest: 'e'.repeat(64) },
    };
    const secondEvent = await repository.record(separateDelivery, NOW + 2);
    expect(secondEvent).toMatchObject({ status: 'duplicate', publicationId: first.publicationId });

    const conflictingReplay = {
      ...input,
      event: { ...input.event, deliveryDigest: 'f'.repeat(64) },
    };
    await expect(repository.record(conflictingReplay, NOW + 3)).rejects.toThrow();

    const counts = await pool!.query(`SELECT
      (SELECT count(*)::int FROM review_operator_passthrough_publications) AS publications,
      (SELECT count(*)::int FROM review_operator_passthrough_events) AS events`);
    expect(counts.rows[0]).toEqual({ publications: 1, events: 2 });
  });

  it('commits one create reservation and makes an unknown acknowledgement reconcile-only', async () => {
    const recorded = await repository.record(inputFor(), NOW);
    const firstClaim = await repository.claimPublication('publisher-create', NOW, 10_000, recorded.publicationId);
    expect(firstClaim).toMatchObject({ stage: 'review', mayCreate: true, reviewCreationState: 'creating' });
    expect(firstClaim!.reviewCheckId).toBeNull();

    const observed: Array<{ stage: string; mayCreate: boolean; externalId: string }> = [];
    const lostAcknowledgement = async (claim: OperatorPassthroughPublicationClaim) => {
      observed.push({ stage: claim.stage, mayCreate: claim.mayCreate, externalId: claim.reviewExternalId });
      return { kind: 'reconcile-pending' as const, retryDelayMs: 1_000 };
    };

    await expect(repository.publishLocked(firstClaim!, lostAcknowledgement, () => NOW + 1)).resolves.toBe('retry');
    await expect(repository.getPublication(recorded.publicationId)).resolves.toMatchObject({
      reviewCreationState: 'creating',
      reviewCheckId: null,
      gateCreationState: 'reserved',
      readyForShip: false,
    });
    const stateAfterUnknownAck = await pool!.query(`SELECT last_error_class FROM review_operator_passthrough_publications
      WHERE publication_id=$1`, [recorded.publicationId]);
    expect(stateAfterUnknownAck.rows[0]).toEqual({ last_error_class: 'unknown-create' });

    const retryClaim = await repository.claimPublication('publisher-reconcile', NOW + 1_002, 10_000, recorded.publicationId);
    expect(retryClaim).toMatchObject({ stage: 'review', mayCreate: false, reviewCreationState: 'creating' });
    await expect(repository.publishLocked(retryClaim!, lostAcknowledgement, () => NOW + 1_003)).resolves.toBe('retry');

    expect(observed).toEqual([
      { stage: 'review', mayCreate: true, externalId: firstClaim!.reviewExternalId },
      { stage: 'review', mayCreate: false, externalId: firstClaim!.reviewExternalId },
    ]);
  });

  it('releases a failed preflight read for one safe create retry and binds its terminal check once', async () => {
    const candidateInput = inputFor();
    const recorded = await repository.record(candidateInput, NOW);
    let now = NOW;
    let failPreflightRead = true;
    let currentCheck: Record<string, unknown> | undefined;
    const id = 7_901;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';

      if (method === 'GET' && url.pathname.endsWith(`/commits/${candidateInput.candidate.headSha}/check-runs`)) {
        if (failPreflightRead) {
          failPreflightRead = false;
          throw new Error('preflight read failed');
        }
        const checks = currentCheck ? [currentCheck] : [];
        return new Response(JSON.stringify({ total_count: checks.length, check_runs: checks }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (method === 'POST' && url.pathname.endsWith('/check-runs')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        currentCheck = {
          id,
          name: body.name,
          app: { id: EXPECTED_APP_ID },
          head_sha: body.head_sha,
          external_id: body.external_id,
          status: body.status,
          conclusion: null,
        };
        return new Response(JSON.stringify(currentCheck), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.pathname.endsWith(`/check-runs/${id}`) && method === 'GET' && currentCheck) {
        return new Response(JSON.stringify(currentCheck), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.pathname.endsWith(`/check-runs/${id}`) && method === 'PATCH' && currentCheck) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        currentCheck = { ...currentCheck, status: body.status, conclusion: body.conclusion };
        return new Response(JSON.stringify(currentCheck), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`unexpected GitHub request ${method} ${url.pathname}`);
    });
    const client = new GitHubReviewGateClient({
      token: 'github-test-token',
      expectedAppId: EXPECTED_APP_ID,
      checkName: 'Review Yeti',
      baseUrl: 'https://github.test/api/v3',
      fetchImplementation,
      timeoutMs: 1_000,
      reconcileTimeoutMs: 1_000,
    });
    const publisher = new OperatorPassthroughPublisher({
      repository,
      clientFor: async () => client,
      workerId: 'postgres-preflight-recovery',
      now: () => now,
      retryDelayMs: 5_000,
    });

    await expect(publisher.runOnce(recorded.publicationId)).resolves.toMatchObject({ status: 'retry' });
    await expect(repository.getPublication(recorded.publicationId)).resolves.toMatchObject({
      reviewCreationState: 'reserved',
      reviewCheckId: null,
      gateCreationState: 'reserved',
      readyForShip: false,
    });
    const afterPreflightFailure = await pool!.query(`SELECT review_creation_state,review_check_id,lease_owner,
      last_error_class,(extract(epoch FROM available_at)*1000)::bigint AS available_at_ms
      FROM review_operator_passthrough_publications WHERE publication_id=$1`, [recorded.publicationId]);
    expect(afterPreflightFailure.rows[0]).toMatchObject({
      review_creation_state: 'reserved',
      review_check_id: null,
      lease_owner: null,
      last_error_class: 'client-preparation',
      available_at_ms: String(NOW + 5_000),
    });

    now += 5_001;
    await expect(publisher.runOnce(recorded.publicationId)).resolves.toMatchObject({ status: 'published' });
    await expect(repository.getPublication(recorded.publicationId)).resolves.toMatchObject({
      reviewCreationState: 'bound',
      reviewCheckId: id,
      gateCreationState: 'reserved',
      readyForShip: false,
    });
    expect(fetchImplementation.mock.calls.map(([, init]) => init?.method ?? 'GET'))
      .toEqual(['GET', 'GET', 'POST', 'GET', 'PATCH']);
    expect(fetchImplementation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(currentCheck).toMatchObject({ status: 'completed', conclusion: 'success' });
  });

  it('reclaims only a proven not-started create and rejects that result after an uncertain create', async () => {
    const knownNotStarted = await repository.record(inputFor(), NOW);
    const knownClaim = await repository.claimPublication('publisher-not-started', NOW, 10_000,
      knownNotStarted.publicationId);
    expect(knownClaim).toMatchObject({ stage: 'review', mayCreate: true, reviewCreationState: 'creating' });
    await expect(repository.publishLocked(knownClaim!, async () => ({ kind: 'not-started', retryDelayMs: 5_000 }),
      () => NOW + 1)).resolves.toBe('retry');
    await expect(repository.getPublication(knownNotStarted.publicationId)).resolves.toMatchObject({
      reviewCreationState: 'reserved', reviewCheckId: null, readyForShip: false,
    });
    await expect(repository.claimPublication('publisher-too-early', NOW + 4_999, 10_000,
      knownNotStarted.publicationId)).resolves.toBeNull();
    const reclaimed = await repository.claimPublication('publisher-reclaimed', NOW + 5_001, 10_000,
      knownNotStarted.publicationId);
    expect(reclaimed).toMatchObject({ stage: 'review', mayCreate: true, reviewCreationState: 'creating' });

    const uncertain = await repository.record(inputFor({ repositoryId: 1_876_543_210 }), NOW);
    const uncertainClaim = await repository.claimPublication('publisher-uncertain', NOW, 10_000,
      uncertain.publicationId);
    await expect(repository.publishLocked(uncertainClaim!, async () => ({ kind: 'reconcile-pending', retryDelayMs: 1_000 }),
      () => NOW + 1)).resolves.toBe('retry');
    const reconcileOnly = await repository.claimPublication('publisher-uncertain-reconcile', NOW + 1_002, 10_000,
      uncertain.publicationId);
    expect(reconcileOnly).toMatchObject({ stage: 'review', mayCreate: false, reviewCreationState: 'creating' });
    await expect(repository.publishLocked(reconcileOnly!, async () => ({ kind: 'not-started', retryDelayMs: 5_000 }),
      () => NOW + 1_003)).rejects.toThrow('Operator passthrough check publication failed');
    await expect(repository.getPublication(uncertain.publicationId)).resolves.toMatchObject({
      reviewCreationState: 'creating', reviewCheckId: null, readyForShip: false,
    });
    const errorClass = await pool!.query(`SELECT last_error_class FROM review_operator_passthrough_publications
      WHERE publication_id=$1`, [uncertain.publicationId]);
    expect(errorClass.rows[0].last_error_class).toBe('unknown-create');
  });

  it('fences retryPublication by the active lease and makes the requested delay observable', async () => {
    const recorded = await repository.record(inputFor(), NOW);
    const original = await repository.claimPublication('publisher-retry-old', NOW, 10_000, recorded.publicationId);
    expect(original).not.toBeNull();

    const current = await repository.claimPublication('publisher-retry-current', NOW + 10_001, 10_000,
      recorded.publicationId);
    expect(current).toMatchObject({ publicationId: recorded.publicationId, mayCreate: false });

    await expect(repository.retryPublication(original!, NOW + 10_002, 1_000)).resolves.toBe(false);
    await expect(repository.retryPublication(current!, NOW + 10_002, 999)).rejects.toThrow();
    await expect(repository.retryPublication(current!, NOW + 10_002, 1_000)).resolves.toBe(true);

    const row = await pool!.query(`SELECT lease_owner,lease_token,last_error_class,
      (extract(epoch FROM available_at)*1000)::bigint AS available_at_ms
      FROM review_operator_passthrough_publications WHERE publication_id=$1`, [recorded.publicationId]);
    expect(row.rows[0]).toMatchObject({
      lease_owner: null,
      lease_token: null,
      last_error_class: 'transport',
      available_at_ms: String(NOW + 11_002),
    });
    await expect(repository.claimPublication('publisher-retry-too-early', NOW + 11_001, 10_000,
      recorded.publicationId)).resolves.toBeNull();
    await expect(repository.claimPublication('publisher-retry-due', NOW + 11_002, 10_000,
      recorded.publicationId)).resolves.toMatchObject({ publicationId: recorded.publicationId, mayCreate: false });
  });

  it('respects the shared PR advisory lock for competing same-head policy publications', async () => {
    const repositoryId = 1_765_432_109;
    const first = await repository.record(inputFor({ repositoryId, prNumber: 88 }), NOW);
    const second = await repository.record(inputFor({ repositoryId, prNumber: 88,
      policyDigest: 'f'.repeat(64) }, randomUUID(), 'e'.repeat(64)), NOW + 1);
    const owner = await pool!.connect();
    try {
      await owner.query('BEGIN');
      await owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [reviewDispatchPrLockKey(repositoryId, 88)]);
      await expect(repository.claimPublication('publisher-contended-one', NOW + 2, 10_000, first.publicationId))
        .resolves.toBeNull();
      await expect(repository.claimPublication('publisher-contended-two', NOW + 2, 10_000, second.publicationId))
        .resolves.toBeNull();
      await owner.query('COMMIT');
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
      owner.release();
    }

    const firstClaim = await repository.claimPublication('publisher-after-release-one', NOW + 3, 10_000,
      first.publicationId);
    const secondClaim = await repository.claimPublication('publisher-after-release-two', NOW + 3, 10_000,
      second.publicationId);
    expect(firstClaim).toMatchObject({ publicationId: first.publicationId, mayCreate: true });
    expect(secondClaim).toMatchObject({ publicationId: second.publicationId, mayCreate: true });
  });

  it('becomes SHIP-ready only after both exact official checks bind successfully', async () => {
    const recorded = await repository.record(inputFor(), NOW);
    await expect(repository.getPublication(recorded.publicationId)).resolves.toMatchObject({
      reviewCheckId: null,
      gateCheckId: null,
      readyForShip: false,
    });

    const reviewClaim = await repository.claimPublication('publisher-review', NOW, 10_000, recorded.publicationId);
    expect(reviewClaim).toMatchObject({ stage: 'review', mayCreate: true });
    await expect(repository.publishLocked(reviewClaim!, async (claim) => checkForClaim(claim, 7101),
      () => NOW + 1)).resolves.toBe('published');

    await expect(repository.getPublication(recorded.publicationId)).resolves.toMatchObject({
      reviewCheckId: 7101,
      reviewCreationState: 'bound',
      gateCheckId: null,
      gateCreationState: 'reserved',
      readyForShip: false,
    });

    const gateClaim = await repository.claimPublication('publisher-gate', NOW + 2, 10_000, recorded.publicationId);
    expect(gateClaim).toMatchObject({ stage: 'gate', mayCreate: true });
    await expect(repository.publishLocked(gateClaim!, async (claim) => checkForClaim(claim, 7102),
      () => NOW + 3)).resolves.toBe('published');

    await expect(repository.getPublication(recorded.publicationId)).resolves.toMatchObject({
      reviewCheckId: 7101,
      reviewCreationState: 'bound',
      gateCheckId: 7102,
      gateCreationState: 'bound',
      readyForShip: true,
    });
  });

  it.each([
    ['App', { appId: EXPECTED_APP_ID + 1 }],
    ['head', { headSha: 'e'.repeat(40) }],
    ['external ID', { externalId: 'review-yeti-operator-passthrough:v1:wrong' }],
  ] as Array<[string, Partial<ReviewGateCheck>]>)('does not bind a %s-mismatched official check', async (_label, mismatch) => {
    const recorded = await repository.record(inputFor(), NOW);
    const claim = await repository.claimPublication('publisher-wrong-check', NOW, 10_000, recorded.publicationId);
    expect(claim).not.toBeNull();
    const wrongCheck = { ...checkForClaim(claim!, 7111), ...mismatch };

    await expect(repository.publishLocked(claim!, async () => wrongCheck, () => NOW + 1))
      .rejects.toThrow('Operator passthrough check publication failed');
    await expect(repository.getPublication(recorded.publicationId)).resolves.toMatchObject({
      reviewCheckId: null,
      gateCheckId: null,
      readyForShip: false,
    });
  });

  it('rejects a stale publication claim before invoking the GitHub publisher', async () => {
    const recorded = await repository.record(inputFor(), NOW);
    const claim = await repository.claimPublication('publisher-stale-claim', NOW, 10_000, recorded.publicationId);
    expect(claim).not.toBeNull();
    const before = await repository.getPublication(recorded.publicationId);
    const publish = vi.fn(async (current: OperatorPassthroughPublicationClaim) => checkForClaim(current, 7112));

    await expect(repository.publishLocked({ ...claim!, leaseToken: randomUUID() }, publish, () => NOW + 1))
      .resolves.toBe('stale-claim');
    expect(publish).not.toHaveBeenCalled();
    await expect(repository.getPublication(recorded.publicationId)).resolves.toEqual(before);
  });

  it('retires both published checks before a fresh re-admission publication cycle', async () => {
    const input = inputFor();
    const first = await repository.record(input, NOW);

    const firstReviewClaim = await repository.claimPublication('publisher-cycle-one-review', NOW, 10_000,
      first.publicationId);
    await expect(repository.publishLocked(firstReviewClaim!, async (claim) => checkForClaim(claim, 7301),
      () => NOW + 1)).resolves.toBe('published');
    const firstGateClaim = await repository.claimPublication('publisher-cycle-one-gate', NOW + 2, 10_000,
      first.publicationId);
    await expect(repository.publishLocked(firstGateClaim!, async (claim) => checkForClaim(claim, 7302),
      () => NOW + 3)).resolves.toBe('published');
    await expect(repository.getPublication(first.publicationId)).resolves.toMatchObject({
      reviewCheckId: 7301,
      gateCheckId: 7302,
      readyForShip: true,
    });

    await expect(repository.requestRetirement({
      repositoryId: input.candidate.repositoryId,
      prNumber: input.candidate.prNumber,
      headSha: input.candidate.headSha,
    }, 'pause-disabled', NOW + 4)).resolves.toBe(1);
    await expect(repository.getPublication(first.publicationId)).resolves.toMatchObject({
      retirementRequestedAt: NOW + 4,
      retirementReason: 'pause-disabled',
      reviewCreationState: 'bound',
      reviewRetiredAt: null,
      gateCreationState: 'bound',
      gateRetiredAt: null,
      retiredAt: null,
      readyForShip: false,
    });

    const retireReviewClaim = await repository.claimPublication('publisher-retire-review', NOW + 5, 10_000,
      first.publicationId);
    expect(retireReviewClaim).toMatchObject({ stage: 'review', mayCreate: false, retiring: true });
    await expect(repository.publishLocked(retireReviewClaim!, async (claim) => checkForClaim(claim, 7301, 'failure'),
      () => NOW + 6)).resolves.toBe('published');
    await expect(repository.getPublication(first.publicationId)).resolves.toMatchObject({
      reviewRetiredAt: NOW + 6,
      gateRetiredAt: null,
      retiredAt: null,
      readyForShip: false,
    });

    const retireGateClaim = await repository.claimPublication('publisher-retire-gate', NOW + 7, 10_000,
      first.publicationId);
    expect(retireGateClaim).toMatchObject({ stage: 'gate', mayCreate: false, retiring: true });
    await expect(repository.publishLocked(retireGateClaim!, async (claim) => checkForClaim(claim, 7302, 'failure'),
      () => NOW + 8)).resolves.toBe('published');
    await expect(repository.getPublication(first.publicationId)).resolves.toMatchObject({
      reviewRetiredAt: NOW + 6,
      gateRetiredAt: NOW + 8,
      retiredAt: NOW + 8,
      readyForShip: false,
    });

    const originalReplay = await repository.record(input, NOW + 9);
    expect(originalReplay).toMatchObject({ status: 'duplicate', publicationId: first.publicationId });

    const resumed = await repository.record({
      ...input,
      event: { ...input.event, deliveryId: randomUUID(), deliveryDigest: 'e'.repeat(64) },
    }, NOW + 10);
    expect(resumed.status).toBe('accepted');
    expect(resumed.publicationId).not.toBe(first.publicationId);
    await expect(repository.getPublication(resumed.publicationId)).resolves.toMatchObject({
      coordinates: { publicationSequence: 2 },
      retirementRequestedAt: null,
      retirementReason: null,
      readyForShip: false,
    });

    const secondReviewClaim = await repository.claimPublication('publisher-cycle-two-review', NOW + 10, 10_000,
      resumed.publicationId);
    expect(secondReviewClaim).toMatchObject({ stage: 'review', mayCreate: true, retiring: false });
    await expect(repository.publishLocked(secondReviewClaim!, async (claim) => checkForClaim(claim, 7311),
      () => NOW + 11)).resolves.toBe('published');
    const secondGateClaim = await repository.claimPublication('publisher-cycle-two-gate', NOW + 12, 10_000,
      resumed.publicationId);
    expect(secondGateClaim).toMatchObject({ stage: 'gate', mayCreate: true, retiring: false });
    await expect(repository.publishLocked(secondGateClaim!, async (claim) => checkForClaim(claim, 7312),
      () => NOW + 13)).resolves.toBe('published');
    await expect(repository.getPublication(resumed.publicationId)).resolves.toMatchObject({
      coordinates: { publicationSequence: 2 },
      reviewCheckId: 7311,
      gateCheckId: 7312,
      readyForShip: true,
    });
  });

  it('keeps retirement completion aligned for unstarted and partially published stages', async () => {
    const unstartedInput = inputFor({ repositoryId: 1_623_456_781, prNumber: 81 });
    const unstarted = await repository.record(unstartedInput, NOW);
    await expect(repository.requestRetirement({
      repositoryId: unstartedInput.candidate.repositoryId,
      prNumber: unstartedInput.candidate.prNumber,
      headSha: unstartedInput.candidate.headSha,
    }, 'pause-disabled', NOW + 1)).resolves.toBe(1);
    await expect(repository.getPublication(unstarted.publicationId)).resolves.toMatchObject({
      reviewCreationState: 'not-created',
      reviewRetiredAt: NOW + 1,
      gateCreationState: 'not-created',
      gateRetiredAt: NOW + 1,
      retiredAt: NOW + 1,
      readyForShip: false,
    });

    const partialInput = inputFor({ repositoryId: 1_623_456_782, prNumber: 82 });
    const partial = await repository.record(partialInput, NOW);
    const reviewClaim = await repository.claimPublication('publisher-partial-review', NOW, 10_000,
      partial.publicationId);
    await expect(repository.publishLocked(reviewClaim!, async (claim) => checkForClaim(claim, 7321),
      () => NOW + 1)).resolves.toBe('published');
    await expect(repository.requestRetirement({
      repositoryId: partialInput.candidate.repositoryId,
      prNumber: partialInput.candidate.prNumber,
      headSha: partialInput.candidate.headSha,
    }, 'normal-review-admitted', NOW + 2)).resolves.toBe(1);
    await expect(repository.getPublication(partial.publicationId)).resolves.toMatchObject({
      reviewCreationState: 'bound',
      reviewCheckId: 7321,
      reviewRetiredAt: null,
      gateCreationState: 'not-created',
      gateCheckId: null,
      gateRetiredAt: NOW + 2,
      retiredAt: null,
      readyForShip: false,
    });

    const retireReviewClaim = await repository.claimPublication('publisher-partial-retire-review', NOW + 3, 10_000,
      partial.publicationId);
    expect(retireReviewClaim).toMatchObject({ stage: 'review', mayCreate: false, retiring: true });
    await expect(repository.publishLocked(retireReviewClaim!, async (claim) => checkForClaim(claim, 7321, 'failure'),
      () => NOW + 4)).resolves.toBe('published');
    await expect(repository.getPublication(partial.publicationId)).resolves.toMatchObject({
      reviewRetiredAt: NOW + 4,
      gateRetiredAt: NOW + 2,
      retiredAt: NOW + 4,
      readyForShip: false,
    });
  });

  it('retires all 501 pending candidates through bounded pages without repeating or starving the tail', async () => {
    const repositoryId = 1_234_567_890;
    const total = 501;
    for (let index = 1; index <= total; index += 1) {
      await repository.record(inputFor({ repositoryId, prNumber: index,
        headSha: index.toString(16).padStart(40, '0') }, randomUUID(), 'd'.repeat(64)), NOW);
    }
    // Keep the operator checks in-flight so the first sweep cannot hide its
    // progress by immediately completing each retirement.
    await pool!.query(`UPDATE review_operator_passthrough_publications SET
      review_creation_state='creating',gate_creation_state='creating'
      WHERE repository_id=$1`, [repositoryId]);

    let requestedTotal = 0;
    while (requestedTotal < total) {
      const expectedPageSize = Math.min(25, total - requestedTotal);
      const requested = await repository.requestAllRetirements('pause-disabled', NOW + requestedTotal);
      expect(requested).toBe(expectedPageSize);
      requestedTotal += requested;
      const pageProgress = await pool!.query(`SELECT COUNT(*)::integer AS requested
        FROM review_operator_passthrough_publications
        WHERE repository_id=$1 AND retirement_requested_at IS NOT NULL`, [repositoryId]);
      expect(pageProgress.rows[0].requested).toBe(requestedTotal);
    }
    await expect(repository.requestAllRetirements('pause-disabled', NOW + total + 1)).resolves.toBe(0);
    const completed = await pool!.query(`SELECT COUNT(*)::integer AS requested, COUNT(DISTINCT pr_number)::integer AS distinct_prs,
      MIN(pr_number)::integer AS first, MAX(pr_number)::integer AS last,
      COUNT(*) FILTER (WHERE retired_at IS NOT NULL)::integer AS prematurely_retired
      FROM review_operator_passthrough_publications WHERE repository_id=$1`, [repositoryId]);
    expect(completed.rows[0]).toEqual({ requested: 501, distinct_prs: 501, first: 1, last: 501, prematurely_retired: 0 });
  }, 30_000);

  it('starts one new cycle for the same retired service-reconciler delivery', async () => {
    const input = inputFor();
    input.event = {
      ...input.event,
      transport: 'service-reconciler',
      eventName: 'existing-admission',
      deliveryId: `service-reconcile:${input.event.deliveryDigest}`,
    };
    const first = await repository.record(input, NOW);
    const replayBeforeRetirement = await repository.record(input, NOW + 1);
    expect(replayBeforeRetirement).toMatchObject({ status: 'duplicate', publicationId: first.publicationId });

    await expect(repository.requestRetirement({
      repositoryId: input.candidate.repositoryId,
      prNumber: input.candidate.prNumber,
      headSha: input.candidate.headSha,
    }, 'pause-disabled', NOW + 2)).resolves.toBe(1);
    await expect(repository.getPublication(first.publicationId)).resolves.toMatchObject({
      coordinates: { publicationSequence: 1 },
      retiredAt: NOW + 2,
    });

    const resumed = await repository.record(input, NOW + 3);
    expect(resumed.status).toBe('accepted');
    expect(resumed.publicationId).not.toBe(first.publicationId);
    await expect(repository.getPublication(resumed.publicationId)).resolves.toMatchObject({
      coordinates: { publicationSequence: 2 },
      retirementRequestedAt: null,
      readyForShip: false,
    });

    const replayAfterReAdmission = await repository.record(input, NOW + 4);
    expect(replayAfterReAdmission).toMatchObject({ status: 'duplicate', publicationId: resumed.publicationId });

    const storedEvents = await pool!.query(`SELECT delivery_id, publication_id
      FROM review_operator_passthrough_events ORDER BY created_at, delivery_id`);
    expect(storedEvents.rows).toEqual([
      { delivery_id: input.event.deliveryId, publication_id: first.publicationId },
      { delivery_id: `${input.event.deliveryId}:cycle:2`, publication_id: resumed.publicationId },
    ]);
    const publicationCount = await pool!.query('SELECT count(*)::int AS count FROM review_operator_passthrough_publications');
    expect(publicationCount.rows[0]).toEqual({ count: 2 });
  });

  it('fences a claimed old head when the current PR candidate has changed', async () => {
    const originalInput = inputFor();
    const original = await repository.record(originalInput, NOW);
    const oldHeadClaim = await repository.claimPublication('publisher-old-head', NOW, 10_000, original.publicationId);
    expect(oldHeadClaim).toMatchObject({ mayCreate: true, coordinates: { headSha: originalInput.candidate.headSha } });

    const currentInput = {
      ...originalInput,
      candidate: { ...originalInput.candidate, headSha: 'f'.repeat(40) },
      event: { ...originalInput.event, deliveryId: randomUUID(), deliveryDigest: 'e'.repeat(64) },
    };
    const current = await repository.record(currentInput, NOW + 1);
    expect(current.publicationId).not.toBe(original.publicationId);

    const effects: string[] = [];
    await expect(repository.publishLocked(oldHeadClaim!, async (claim) => {
      if (claim.coordinates.headSha !== currentInput.candidate.headSha) {
        return { kind: 'retire-required', reason: 'candidate-changed', retryDelayMs: 1_000 };
      }
      effects.push('created-check');
      return checkForClaim(claim, 7201);
    }, () => NOW + 2)).resolves.toBe('retry');

    expect(effects).toEqual([]);
    await expect(repository.getPublication(original.publicationId)).resolves.toMatchObject({
      retirementReason: 'candidate-changed',
      retirementRequestedAt: NOW + 2,
      reviewCreationState: 'not-created',
      reviewCheckId: null,
      gateCreationState: 'not-created',
      gateCheckId: null,
      retiredAt: NOW + 2,
      readyForShip: false,
    });
    await expect(repository.claimPublication('publisher-reconcile-old-head', NOW + 1_003,
      10_000, original.publicationId)).resolves.toBeNull();
  });
});
