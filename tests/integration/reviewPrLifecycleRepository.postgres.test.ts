import { randomBytes, randomInt } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_PR_LIFECYCLE_SCHEMA_SQL } from '../../src/persistence/reviewPrLifecycleSchema';
import {
  readPrLifecycleHistory,
  recordIndependentFindingVerification,
  recordPrFindingRecheckRequest,
  recordTrustedPrReviewCompletion,
  reservePrReview,
  transitionPrReviewReservation,
} from '../../src/persistence/reviewPrLifecycleRepository';
import { affectedContextDigest } from '../../src/review/semanticContext';
import { findingFingerprint } from '../../src/review/findingConvergence';
import { describeWithPostgres, postgresDatabaseUrl, requireDatabaseUrlInCi } from '../support/postgresSuite';

requireDatabaseUrlInCi();
const databaseUrl = postgresDatabaseUrl();
const REPOSITORY_ID = 1_000_000_000 + randomInt(1_000_000_000);
const DIGEST = 'a'.repeat(64);
const HEAD = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

let pool: Pool;
let schema: string;

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function reservation(runId: string, overrides: Partial<Parameters<typeof reservePrReview>[1]> = {}) {
  return {
    repositoryId: REPOSITORY_ID,
    owner: 'example-org',
    repo: 'sample-project',
    prNumber: 23,
    runId,
    executionAttempt: 1,
    deliveryId: `delivery-${runId}`,
    headSha: HEAD,
    baseSha: BASE,
    policyDigest: DIGEST,
    configDigest: 'd'.repeat(64),
    contextDigest: 'e'.repeat(64),
    at: 1_000,
    ...overrides,
  };
}

describeWithPostgres('durable semantic PR lifecycle', () => {
  beforeAll(async () => {
    schema = `review_pr_lifecycle_${randomBytes(8).toString('hex')}`;
    if (!/^review_pr_lifecycle_[a-f0-9]{16}$/u.test(schema)) throw new Error('Generated schema is not owned by this test');
    pool = new Pool({ connectionString: databaseUrl, max: 12, options: `-c search_path=${schema},public` });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`CREATE TABLE review_runs (
      run_id TEXT PRIMARY KEY, owner TEXT, repo TEXT, pr_number INTEGER, repository_id BIGINT,
      head_sha VARCHAR(40), base_sha VARCHAR(40), effective_policy_digest VARCHAR(64),
      effective_config_digest VARCHAR(64), snapshot_digest VARCHAR(64), status TEXT, attempt INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    await pool.query(`CREATE TABLE review_worker_completions (
      run_id TEXT NOT NULL, execution_attempt INTEGER NOT NULL, content_digest VARCHAR(64) NOT NULL,
      payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (run_id, execution_attempt))`);
    await pool.query(REVIEW_PR_LIFECYCLE_SCHEMA_SQL);
    // Additive migration remains safe when initialization is repeated.
    await pool.query(REVIEW_PR_LIFECYCLE_SCHEMA_SQL);
  });

  afterAll(async () => {
    if (pool) {
      await pool.end();
      await new Pool({ connectionString: databaseUrl }).query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
  });

  it('serializes concurrent webhook reservations and retains exact-head semantic history', async () => {
    await pool.query(`INSERT INTO review_runs (run_id) VALUES ('run-a'), ('run-b')`);
    const request = reservation('run-a');
    const [first, duplicate] = await Promise.all([
      inTransaction((client) => reservePrReview(client, request)),
      inTransaction((client) => reservePrReview(client, { ...request, deliveryId: 'second-delivery' })),
    ]);
    expect(first.lifecycleId).toBe(duplicate.lifecycleId);
    expect(first.reservationId).toBe(duplicate.reservationId);
    expect([first.created, duplicate.created].filter(Boolean)).toHaveLength(1);

    const finding = {
      fingerprint: findingFingerprint({ severity: 'P1', path: 'src/example.ts', line: 11,
        title: 'Validate untrusted input', body: 'The parser accepts a malformed value.' }),
      path: 'src/example.ts',
      line: 11,
      severity: 'P1',
      disposition: 'carried',
      blocking: true,
      affectedContextDigest: 'f'.repeat(64),
      sourceEvidence: { title: 'Validate untrusted input', body: 'The parser accepts a malformed value.' },
      provenance: { reviewer: 'lane-alpha', verificationStatus: 'insufficient' },
    };
    const completion = {
      runId: 'run-a', executionAttempt: 1, status: 'failed' as const,
      completionDigest: '1'.repeat(64),
      decisionReceipt: { schema: 'review-yeti-decision.v2', policyDigest: DIGEST, decision: 'FIX_FIRST' },
      findings: [finding], at: 2_000,
    };
    await inTransaction((client) => recordTrustedPrReviewCompletion(client, completion));
    await inTransaction((client) => recordTrustedPrReviewCompletion(client, completion));

    const requestDigest = '2'.repeat(64);
    await inTransaction((client) => recordPrFindingRecheckRequest(client, {
      runId: 'run-a', sourceExecutionAttempt: 1, requestId: '00000000-0000-4000-8000-000000000001',
      findingId: finding.fingerprint, actorDigest: '3'.repeat(64), sourceContentDigest: '4'.repeat(64),
      sourceContextDigest: request.contextDigest, requestDigest, at: 3_000,
    }));
    const beforeVerification = await pool.query(`SELECT finding_event_id FROM review_semantic_finding_events`);
    const findingEventId = String(beforeVerification.rows[0].finding_event_id);
    await inTransaction((client) => recordIndependentFindingVerification(client, {
      findingEventId, status: 'confirmed', verifier: 'independent-lane-beta',
      evidenceDigest: '5'.repeat(64), contextDigest: finding.affectedContextDigest,
      evidence: { source: 'reproduced against the exact changed hunk' }, at: 4_000,
    }));

    const history = await readPrLifecycleHistory(pool, {
      repositoryId: REPOSITORY_ID, owner: 'example-org', repo: 'sample-project', prNumber: 23,
    });
    expect(history).not.toBeNull();
    expect(history?.reservations).toHaveLength(1);
    expect(history?.reservations[0].status).toBe('failed');
    expect(history?.findings).toHaveLength(1);
    expect(history?.findings[0].first_seen_head).toBe(HEAD);
    expect(history?.findings[0].affected_context_digest).toBe(finding.affectedContextDigest);
    expect(history?.events.map((event) => event.event_type)).toContain('finding.recheck_requested');
    expect(history?.events.map((event) => event.event_type)).toContain('finding.independent_verification');
    expect(history?.events.filter((event) => event.event_type === 'review.completion_recorded')).toHaveLength(1);
  });

  it('keeps later commits in one PR history and records cancellation as a released reservation', async () => {
    await pool.query(`INSERT INTO review_runs (run_id) VALUES ('run-c'), ('run-d')`);
    const original = await inTransaction((client) => reservePrReview(client, reservation('run-c')));
    const laterHead = '9'.repeat(40);
    const later = await inTransaction((client) => reservePrReview(client, reservation('run-d', {
      headSha: laterHead, contextDigest: '8'.repeat(64), executionAttempt: 1,
    })));
    expect(later.lifecycleId).toBe(original.lifecycleId);
    expect(later.reservationId).not.toBe(original.reservationId);
    await inTransaction((client) => transitionPrReviewReservation(client, {
      runId: 'run-c', executionAttempt: 1, status: 'cancelled', reason: 'candidate-superseded', at: 5_000,
    }));
    const history = await readPrLifecycleHistory(pool, {
      repositoryId: REPOSITORY_ID, owner: 'example-org', repo: 'sample-project', prNumber: 23,
    });
    expect(history?.reservations).toHaveLength(3);
    expect(history?.reservations.find((item) => item.run_id === 'run-c')?.status).toBe('cancelled');
    expect(history?.reservations.find((item) => item.run_id === 'run-d')?.head_sha).toBe(laterHead);
  });

  it('exposes pre-ledger completions as unverified context without synthesizing findings', async () => {
    await pool.query(`INSERT INTO review_runs
      (run_id, owner, repo, pr_number, repository_id, head_sha, base_sha, effective_policy_digest,
       effective_config_digest, snapshot_digest, status, attempt)
      VALUES ('legacy-run', 'example-org', 'sample-project', 24, $1, $2, $3, $4, $5, $6, 'failed', 0)`,
    [REPOSITORY_ID, HEAD, BASE, DIGEST, 'd'.repeat(64), 'e'.repeat(64)]);
    await pool.query(`INSERT INTO review_worker_completions (run_id, execution_attempt, content_digest, payload)
      VALUES ('legacy-run', 1, $1, $2::jsonb)`, ['6'.repeat(64), JSON.stringify({ version: 'legacy-source' })]);
    const history = await readPrLifecycleHistory(pool, {
      repositoryId: REPOSITORY_ID, owner: 'example-org', repo: 'sample-project', prNumber: 24,
    }, { limit: 1 });
    expect(history?.lifecycle).toBeNull();
    expect(history?.legacyContext).toHaveLength(1);
    expect(history?.legacyContext[0]).toMatchObject({ run_id: 'legacy-run', historySource: 'legacy_archive',
      verificationStatus: 'insufficient', content_digest: '6'.repeat(64) });
    expect(history?.findings).toHaveLength(0);
  });
});

describe('affected finding context identity', () => {
  it('uses the reviewer fingerprint across paraphrase and line movement while separating another claim', () => {
    const source = { severity: 'P1', path: 'src/example.ts', line: 11,
      title: 'Helper name hides the retry intent', body: 'Rename this helper so callers can understand retries.' };
    const fingerprint = findingFingerprint(source);
    expect(findingFingerprint({ ...source, line: 31,
      title: 'The helper names hide the retry intent', body: 'A clearer name explains the retry behavior.' }))
      .toBe(fingerprint);
    expect(findingFingerprint({ ...source, line: 12, title: 'Reject an unbound tenant identity',
      body: 'The request can select another tenant.' })).not.toBe(fingerprint);
  });

  it('preserves a finding context digest across a pure line shift and changes it with nearby code', () => {
    const file1 = { path: 'src/example.ts', patch: '@@ -8,3 +10,3 @@\n alpha\n-buggy\n+buggy\n omega' };
    const file2 = { path: 'src/example.ts', patch: '@@ -28,3 +30,3 @@\n alpha\n-buggy\n+buggy\n omega' };
    const changed = { path: 'src/example.ts', patch: '@@ -28,3 +30,3 @@\n alpha\n-buggy\n+safe\n omega' };
    expect(affectedContextDigest({ path: 'src/example.ts', line: 11 }, [file1]))
      .toBe(affectedContextDigest({ path: 'src/example.ts', line: 31 }, [file2]));
    expect(affectedContextDigest({ path: 'src/example.ts', line: 31 }, [file2]))
      .not.toBe(affectedContextDigest({ path: 'src/example.ts', line: 31 }, [changed]));
  });
});
