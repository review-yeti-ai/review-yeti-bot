import { randomBytes, randomInt } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_PR_LIFECYCLE_SCHEMA_SQL, REVIEW_PR_LIFECYCLE_SNAPSHOT_SCHEMA_SQL } from '../../src/persistence/reviewPrLifecycleSchema';
import {
  createPrLifecycleHistorySnapshot,
  readPrLifecycleHistorySnapshotPage,
  recordCurrentPrFindingVerification,
  reservePrReview,
  recordTrustedPrReviewCompletion,
  transitionPrReviewReservation,
} from '../../src/persistence/reviewPrLifecycleRepository';
import { sha256 } from '../../src/review/reviewCore';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

requireDatabaseUrlInCi();
const databaseUrl = postgresDatabaseUrl();
const repositoryId = 1_000_000_000 + randomInt(1_000_000_000);
const digest = 'a'.repeat(64);
const head = 'b'.repeat(40);
const base = 'c'.repeat(40);
const token = 'ghs_snapshot-test-token';
let pool: Pool;
let schema: string;

describeWithPostgres('fixed PR lifecycle history snapshots', () => {
  beforeAll(async () => {
    schema = `review_pr_snapshot_${randomBytes(8).toString('hex')}`;
    pool = new Pool({ connectionString: databaseUrl, max: 8, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE review_runs (
      run_id TEXT PRIMARY KEY, owner TEXT, repo TEXT, pr_number INTEGER, repository_id BIGINT,
      head_sha VARCHAR(40), base_sha VARCHAR(40), effective_policy_digest VARCHAR(64),
      effective_config_digest VARCHAR(64), snapshot_digest VARCHAR(64), status TEXT, attempt INTEGER,
      cancel_requested_at TIMESTAMPTZ, cancel_propagated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE review_dispatch_outbox (
      run_id TEXT NOT NULL, execution_attempt INTEGER NOT NULL, worker_token_digest VARCHAR(64) NOT NULL,
      status TEXT NOT NULL DEFAULT 'projected', cancel_requested_at TIMESTAMPTZ, cancel_propagated_at TIMESTAMPTZ)`);
    await pool.query(`CREATE TABLE review_worker_completions (
      run_id TEXT NOT NULL, execution_attempt INTEGER NOT NULL, content_digest VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (run_id, execution_attempt))`);
    await pool.query(REVIEW_PR_LIFECYCLE_SCHEMA_SQL);
    await pool.query(REVIEW_PR_LIFECYCLE_SNAPSHOT_SCHEMA_SQL);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
      await new Pool({ connectionString: databaseUrl }).query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('binds snapshots to the admitted PR and freezes paginated IDs across concurrent appends', async () => {
    const runId = `run_${'1'.repeat(32)}`;
    const reservationId = `delivery-${runId}`;
    const sourceRunId = `run_${'3'.repeat(32)}`;
    await pool.query(`INSERT INTO review_runs
      (run_id, owner, repo, pr_number, repository_id, head_sha, base_sha, effective_policy_digest,
       effective_config_digest, snapshot_digest, status, attempt)
      VALUES ($1, 'example-org', 'sample-project', 23, $2, $3, $4, $5, $6, $7, 'running', 1)`,
    [sourceRunId, repositoryId, 'a'.repeat(40), base, digest, 'd'.repeat(64), '8'.repeat(64)]);
    await reservePrReview(pool, {
      repositoryId, owner: 'example-org', repo: 'sample-project', prNumber: 23, runId: sourceRunId,
      executionAttempt: 1, deliveryId: `delivery-${sourceRunId}`, headSha: 'a'.repeat(40), baseSha: base,
      policyDigest: digest, configDigest: 'd'.repeat(64), contextDigest: '8'.repeat(64), at: 500,
    });
    await recordTrustedPrReviewCompletion(pool, {
      runId: sourceRunId, executionAttempt: 1, status: 'failed', completionDigest: 'f'.repeat(64),
      decisionReceipt: { decision: 'FIX_FIRST' }, findings: [{ fingerprint: 'semantic-finding-a', path: 'src/a.ts',
        line: 4, severity: 'P1', disposition: 'current', blocking: true, affectedContextDigest: '9'.repeat(64),
        sourceEvidence: { title: 'Untrusted historical prose' }, independentVerification: {
          status: 'confirmed', verifier: 'independent_grounded_verifier', evidenceDigest: '7'.repeat(64),
          evidence: { citations: ['head:src/a.ts', 'diff:src/a.ts'] },
        } }], at: 2000,
    });
    await pool.query(`INSERT INTO review_runs
      (run_id, owner, repo, pr_number, repository_id, head_sha, base_sha, effective_policy_digest,
       effective_config_digest, snapshot_digest, status, attempt)
      VALUES ($1, 'example-org', 'sample-project', 23, $2, $3, $4, $5, $6, $7, 'running', 1)`,
    [runId, repositoryId, head, base, digest, 'd'.repeat(64), 'e'.repeat(64)]);
    await pool.query(`INSERT INTO review_dispatch_outbox (run_id, execution_attempt, worker_token_digest)
      VALUES ($1, 0, $2)`, [runId, sha256(token)]);
    await reservePrReview(pool, {
      repositoryId, owner: 'example-org', repo: 'sample-project', prNumber: 23, runId,
      executionAttempt: 1, deliveryId: reservationId, headSha: head, baseSha: base,
      policyDigest: digest, configDigest: 'd'.repeat(64), contextDigest: 'e'.repeat(64), at: 1000,
    });

    const denied = await createPrLifecycleHistorySnapshot(pool, {
      runId, executionAttempt: 1, workerTokenDigest: sha256('ghs-wrong-token'),
    });
    expect(denied.status).toBe('unauthorized');

    const created = await createPrLifecycleHistorySnapshot(pool, {
      runId, executionAttempt: 1, workerTokenDigest: sha256(token),
    });
    expect(created.status).toBe('ok');
    if (created.status !== 'ok') return;
    expect(created.snapshot.repositoryId).toBe(repositoryId);
    expect(created.snapshot.prNumber).toBe(23);
    expect(created.snapshot.findingCount).toBe(1);
    expect(created.snapshot.eventCount).toBeGreaterThan(0);
    const verificationEvents = await readPrLifecycleHistorySnapshotPage(pool, {
      runId, executionAttempt: 1, workerTokenDigest: sha256(token), snapshotId: created.snapshot.snapshotId,
      collection: 'events', offset: 0, limit: 250,
    });
    expect(verificationEvents.status).toBe('ok');
    if (verificationEvents.status !== 'ok') return;
    expect(verificationEvents.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_type: 'finding.independent_verification', verification_status: 'confirmed' }),
    ]));

    const first = await readPrLifecycleHistorySnapshotPage(pool, {
      runId, executionAttempt: 1, workerTokenDigest: sha256(token), snapshotId: created.snapshot.snapshotId,
      collection: 'events', offset: 0, limit: 1,
    });
    expect(first.status).toBe('ok');
    if (first.status !== 'ok') return;
    await pool.query(`INSERT INTO review_pr_lifecycle_events
      (event_id, lifecycle_id, idempotency_key, event_type, repository_id, pr_number, payload)
      SELECT gen_random_uuid(), lifecycle_id, 'late-event-' || $1, 'review.late', repository_id, pr_number, '{}'::jsonb
        FROM review_pr_lifecycles WHERE repository_id = $2 AND pr_number = 23`, [runId, repositoryId]);
    const next = await readPrLifecycleHistorySnapshotPage(pool, {
      runId, executionAttempt: 1, workerTokenDigest: sha256(token), snapshotId: created.snapshot.snapshotId,
      collection: 'events', offset: 1, limit: 1,
    });
    expect(next.status).toBe('ok');
    if (next.status !== 'ok') return;
    expect(next.rows.map((event: { event_type: string }) => event.event_type)).not.toContain('review.late');
    expect(next.totalCount).toBe(created.snapshot.eventCount);

    const findings = await readPrLifecycleHistorySnapshotPage(pool, {
      runId, executionAttempt: 1, workerTokenDigest: sha256(token), snapshotId: created.snapshot.snapshotId,
      collection: 'findings', offset: 0, limit: 10,
    });
    expect(findings.status).toBe('ok');
    if (findings.status !== 'ok') return;
    const sourceFinding = findings.rows[0];
    const verificationInput = {
      findingEventId: String(sourceFinding.finding_event_id), snapshotId: created.snapshot.snapshotId,
      runId, executionAttempt: 1, workerTokenDigest: sha256(token), status: 'confirmed' as const,
      currentContextDigest: 'e'.repeat(64), currentAffectedContextDigest: '9'.repeat(64),
      evidenceDigest: '7'.repeat(64), evidence: { citations: ['head:src/a.ts', 'diff:src/a.ts'] },
    };
    expect(await recordCurrentPrFindingVerification(pool, { ...verificationInput,
      currentContextDigest: '1'.repeat(64) })).toBe('stale_context');
    expect(await recordCurrentPrFindingVerification(pool, verificationInput)).toBe('recorded');

    const otherRun = `run_${'2'.repeat(32)}`;
    await pool.query(`INSERT INTO review_runs
      (run_id, owner, repo, pr_number, repository_id, head_sha, base_sha, effective_policy_digest,
       effective_config_digest, snapshot_digest, status, attempt)
      VALUES ($1, 'example-org', 'sample-project', 24, $2, $3, $4, $5, $6, $7, 'running', 1)`,
    [otherRun, repositoryId, head, base, digest, 'd'.repeat(64), 'e'.repeat(64)]);
    await pool.query(`INSERT INTO review_dispatch_outbox (run_id, execution_attempt, worker_token_digest)
      VALUES ($1, 0, $2)`, [otherRun, sha256(token)]);
    const crossRun = await readPrLifecycleHistorySnapshotPage(pool, {
      runId: otherRun, executionAttempt: 1, workerTokenDigest: sha256(token), snapshotId: created.snapshot.snapshotId,
      collection: 'findings', offset: 0, limit: 10,
    });
    expect(crossRun.status).toBe('unauthorized');

    const supersededRun = `run_${'4'.repeat(32)}`;
    const supersededContext = '9'.repeat(64);
    await pool.query(`INSERT INTO review_runs
      (run_id, owner, repo, pr_number, repository_id, head_sha, base_sha, effective_policy_digest,
       effective_config_digest, snapshot_digest, status, attempt)
      VALUES ($1, 'example-org', 'sample-project', 23, $2, $3, $4, $5, $6, $7, 'running', 1)`,
    [supersededRun, repositoryId, 'd'.repeat(40), base, digest, 'd'.repeat(64), supersededContext]);
    await pool.query(`INSERT INTO review_dispatch_outbox (run_id, execution_attempt, worker_token_digest)
      VALUES ($1, 0, $2)`, [supersededRun, sha256(token)]);
    await reservePrReview(pool, { repositoryId, owner: 'example-org', repo: 'sample-project', prNumber: 23,
      runId: supersededRun, executionAttempt: 1, deliveryId: `delivery-${supersededRun}`,
      headSha: 'd'.repeat(40), baseSha: base, policyDigest: digest, configDigest: 'd'.repeat(64),
      contextDigest: supersededContext, at: 3000 });
    const supersededSnapshot = await createPrLifecycleHistorySnapshot(pool, {
      runId: supersededRun, executionAttempt: 1, workerTokenDigest: sha256(token),
    });
    expect(supersededSnapshot.status).toBe('ok');
    if (supersededSnapshot.status !== 'ok') return;
    await transitionPrReviewReservation(pool, { runId: supersededRun, executionAttempt: 1, status: 'superseded', at: 4000 });
    const supersededPage = await readPrLifecycleHistorySnapshotPage(pool, {
      runId: supersededRun, executionAttempt: 1, workerTokenDigest: sha256(token),
      snapshotId: supersededSnapshot.snapshot.snapshotId, collection: 'findings', offset: 0, limit: 10,
    });
    expect(supersededPage.status).toBe('unauthorized');
    expect(await recordCurrentPrFindingVerification(pool, { ...verificationInput,
      runId: supersededRun, snapshotId: supersededSnapshot.snapshot.snapshotId,
      currentContextDigest: supersededContext, currentAffectedContextDigest: 'a'.repeat(64) })).toBe('unauthorized');

    await pool.query('UPDATE review_dispatch_outbox SET cancel_requested_at = CURRENT_TIMESTAMP WHERE run_id = $1', [runId]);
    const cancelledPage = await readPrLifecycleHistorySnapshotPage(pool, {
      runId, executionAttempt: 1, workerTokenDigest: sha256(token), snapshotId: created.snapshot.snapshotId,
      collection: 'findings', offset: 0, limit: 10,
    });
    expect(cancelledPage.status).toBe('unauthorized');
    expect(await recordCurrentPrFindingVerification(pool, verificationInput)).toBe('unauthorized');
  });
});
