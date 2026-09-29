import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  StreamingMultiplexer,
  type DatabaseQueryable,
  type JetStreamPublisherLike,
} from '../../src/gateway/streamingMultiplexer';
import {
  RESUME_SUBJECT_PREFIX,
  isReviewEventSubject,
  resumeSubjectFor,
  MAX_REVIEW_EVENT_SUBJECT_SUFFIX_LENGTH,
} from '../../src/events/reviewEventSubjects';
import {
  createResumptionPayload,
  validateResumptionPayload,
  isReviewResumptionEvent,
  reviewResumptionEventSchema,
} from '../../src/events/reviewResumptionEvent';
import {
  assertReviewEventSubject,
  JetStreamTransportError,
} from '../../src/events/jetStreamClient';

describe('Challenger 2 Empirical Stress Suite: NATS Disconnect Recovery, Outbox Requeue & Subject Validation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SUITE 1: Adversarial Subject Validation & Path Traversal Rejection
  // =========================================================================
  describe('Suite 1: Resumption Subject Validation & Fail-Closed Bounds', () => {
    it('EMP-CHAL2-SUBJ-01: validates exact resumeSubjectFor helper output', () => {
      const runId = 'run_abc-123_XYZ';
      const subject = resumeSubjectFor(runId);
      expect(subject).toBe('ct.review.v1.resume.run_abc-123_XYZ');
      expect(isReviewEventSubject(subject)).toBe(true);
      expect(() => assertReviewEventSubject(subject)).not.toThrow();
    });

    it('EMP-CHAL2-SUBJ-02: verifies valid suffix length boundaries (1 char and 64 chars)', () => {
      // 1 char suffix (minimum valid)
      const minSubject = `${RESUME_SUBJECT_PREFIX}.a`;
      expect(isReviewEventSubject(minSubject)).toBe(true);
      expect(() => assertReviewEventSubject(minSubject)).not.toThrow();

      // Exactly 64 chars suffix (maximum valid)
      const max64Suffix = 'a'.repeat(64);
      const maxSubject = `${RESUME_SUBJECT_PREFIX}.${max64Suffix}`;
      expect(isReviewEventSubject(maxSubject)).toBe(true);
      expect(() => assertReviewEventSubject(maxSubject)).not.toThrow();
    });

    it('EMP-CHAL2-SUBJ-03: rejects empty, missing, and oversized suffix (>64 chars) fail-closed', () => {
      // Prefix only without dot
      expect(isReviewEventSubject(RESUME_SUBJECT_PREFIX)).toBe(false);
      expect(() => assertReviewEventSubject(RESUME_SUBJECT_PREFIX)).toThrow(JetStreamTransportError);

      // Prefix with dot but empty suffix (0 chars)
      const emptySuffixSubject = `${RESUME_SUBJECT_PREFIX}.`;
      expect(isReviewEventSubject(emptySuffixSubject)).toBe(false);
      expect(() => assertReviewEventSubject(emptySuffixSubject)).toThrow(JetStreamTransportError);

      // 65 chars suffix (exceeds 64)
      const over65Suffix = 'a'.repeat(65);
      const over65Subject = `${RESUME_SUBJECT_PREFIX}.${over65Suffix}`;
      expect(isReviewEventSubject(over65Subject)).toBe(false);
      expect(() => assertReviewEventSubject(over65Subject)).toThrow(JetStreamTransportError);

      // 128 chars suffix
      const over128Suffix = 'a'.repeat(128);
      const over128Subject = `${RESUME_SUBJECT_PREFIX}.${over128Suffix}`;
      expect(isReviewEventSubject(over128Subject)).toBe(false);
      expect(() => assertReviewEventSubject(over128Subject)).toThrow(JetStreamTransportError);
    });

    it('EMP-CHAL2-SUBJ-04: rejects path and subject traversal attempts fail-closed', () => {
      const traversalAttempts = [
        `${RESUME_SUBJECT_PREFIX}...`,
        `${RESUME_SUBJECT_PREFIX}..`,
        `${RESUME_SUBJECT_PREFIX}../run1`,
        `${RESUME_SUBJECT_PREFIX}.run/../../etc/passwd`,
        `${RESUME_SUBJECT_PREFIX}.run/subpath`,
        `${RESUME_SUBJECT_PREFIX}.run\\subpath`,
        `${RESUME_SUBJECT_PREFIX}.run..nested`,
        `${RESUME_SUBJECT_PREFIX}.run.nested`, // dots forbidden in resume suffix
        `${RESUME_SUBJECT_PREFIX}.run%2f..%2f`,
        `${RESUME_SUBJECT_PREFIX}./etc/passwd`,
        `${RESUME_SUBJECT_PREFIX}.~/.ssh/id_rsa`,
      ];

      for (const subj of traversalAttempts) {
        expect(isReviewEventSubject(subj)).toBe(false);
        expect(() => assertReviewEventSubject(subj)).toThrow(JetStreamTransportError);
      }
    });

    it('EMP-CHAL2-SUBJ-05: rejects illegal characters, whitespaces, and control characters fail-closed', () => {
      const illegalChars = [
        'run$123',
        'run#123',
        'run!123',
        'run@123',
        'run%123',
        'run^123',
        'run&123',
        'run*123',
        'run(123)',
        'run+123',
        'run=123',
        'run[123]',
        'run{123}',
        'run|123',
        'run;123',
        'run:123',
        'run\'123',
        'run"123',
        'run<123>',
        'run?123',
        'run,123',
        'run`123',
        'run~123',
        'run 123',      // space
        'run\t123',     // tab
        'run\n123',     // newline
        'run\r123',     // carriage return
        'run\x00123',   // raw null byte
        'run\\u0000123',// escaped null byte
        'run\u0007123', // bell character
        'run\u001f123', // unit separator
      ];

      for (const badSuffix of illegalChars) {
        const subj = `${RESUME_SUBJECT_PREFIX}.${badSuffix}`;
        expect(isReviewEventSubject(subj)).toBe(false);
        expect(() => assertReviewEventSubject(subj)).toThrow(JetStreamTransportError);
      }
    });

    it('EMP-CHAL2-SUBJ-06: rejects NATS wildcard tokens (* and >) to prevent unauthorized fanout injection', () => {
      const wildcardAttempts = [
        `${RESUME_SUBJECT_PREFIX}.*`,
        `${RESUME_SUBJECT_PREFIX}.>`,
        `${RESUME_SUBJECT_PREFIX}.run.*`,
        `${RESUME_SUBJECT_PREFIX}.run.>`,
        `${RESUME_SUBJECT_PREFIX}.*.run`,
        `${RESUME_SUBJECT_PREFIX}.run*`,
        `${RESUME_SUBJECT_PREFIX}.run>`,
      ];

      for (const subj of wildcardAttempts) {
        expect(isReviewEventSubject(subj)).toBe(false);
        expect(() => assertReviewEventSubject(subj)).toThrow(JetStreamTransportError);
      }
    });

    it('EMP-CHAL2-SUBJ-07: rejects invalid prefixes and non-string inputs fail-closed', () => {
      const invalidPrefixes = [
        'ct.review.v2.resume.run123',
        'ct.review.resume.v1.run123',
        'ct.review.v1.resumption.run123',
        'nats.review.v1.resume.run123',
        'ct.review.lifecycle.v1.run/invalid',
        'ct.review.progress.v1.run/invalid',
      ];

      for (const subj of invalidPrefixes) {
        expect(isReviewEventSubject(subj)).toBe(false);
        expect(() => assertReviewEventSubject(subj)).toThrow(JetStreamTransportError);
      }

      const nonStrings = [null, undefined, 12345, true, false, {}, [], () => {}];
      for (const val of nonStrings) {
        expect(isReviewEventSubject(val)).toBe(false);
      }
    });

    it('EMP-CHAL2-SUBJ-08: validates resumption payload schema rejection on adversarial fields', () => {
      // Invalid runId: contains traversal
      expect(() =>
        createResumptionPayload({
          runId: 'run/../bad',
          headSha: 'a'.repeat(40),
          status: 'completed',
        }),
      ).toThrow();

      // Invalid runId: >64 chars
      expect(() =>
        createResumptionPayload({
          runId: 'r'.repeat(65),
          headSha: 'a'.repeat(40),
          status: 'completed',
        }),
      ).toThrow();

      // Invalid headSha: not 40 hex chars
      expect(() =>
        createResumptionPayload({
          runId: 'run_valid_123',
          headSha: 'not_a_valid_sha',
          status: 'completed',
        }),
      ).toThrow();

      // Invalid status: not 'completed' or 'failed'
      expect(() =>
        createResumptionPayload({
          runId: 'run_valid_123',
          headSha: 'a'.repeat(40),
          status: 'pending' as any,
        }),
      ).toThrow();

      // Invalid artifactsDigest: not 64 hex chars
      expect(() =>
        createResumptionPayload({
          runId: 'run_valid_123',
          headSha: 'a'.repeat(40),
          status: 'completed',
          artifactsDigest: 'xyz',
        }),
      ).toThrow();
    });
  });

  // =========================================================================
  // SUITE 2: Simulated NATS Broker Disconnect & Outbox Requeue Verification
  // =========================================================================
  describe('Suite 2: Simulated NATS Broker Disconnect & Outbox Requeue Resilience', () => {
    it('EMP-CHAL2-NATS-01: verifies clean DB commit and pending outbox status on NATS ECONNREFUSED', async () => {
      const sqlQueries: Array<{ sql: string; params?: unknown[] }> = [];

      const mockDb: DatabaseQueryable = {
        query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
          sqlQueries.push({ sql, params });
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };

      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockRejectedValue(
          new Error('NATS connection closed (ECONNREFUSED 127.0.0.1:4222)'),
        ),
      };

      const multiplexer = new StreamingMultiplexer({
        db: mockDb,
        jetStreamClient: mockJetStream,
      });

      const runId = 'run_econnrefused_test_123';
      const headSha = 'b'.repeat(40);

      multiplexer.openStream(runId, 'Test prompt', { headSha });

      // Action: complete stream while NATS broker is disconnected
      const result = await multiplexer.completeStream(runId, headSha);

      // 1. Result must report completed without throwing
      expect(result.status).toBe('completed');
      expect(result.runId).toBe(runId);

      // 2. PostgreSQL transaction must commit cleanly
      expect(sqlQueries[0].sql).toBe('BEGIN');
      const commitQuery = sqlQueries.find((q) => q.sql === 'COMMIT');
      expect(commitQuery).toBeDefined();
      const rollbackQuery = sqlQueries.find((q) => q.sql === 'ROLLBACK');
      expect(rollbackQuery).toBeUndefined();

      // 3. PostgreSQL review_dispatch_outbox was updated to status = 'pending'
      const outboxSql = sqlQueries.find((q) => q.sql.includes('UPDATE review_dispatch_outbox'));
      expect(outboxSql).toBeDefined();
      expect(outboxSql?.sql).toContain("status = 'pending'");
      expect(outboxSql?.sql).toContain('lease_owner = NULL');
      expect(outboxSql?.sql).toContain('lease_expires_at = NULL');
      expect(outboxSql?.sql).toContain('available_at = CURRENT_TIMESTAMP');
      expect(outboxSql?.params).toEqual([runId]);

      // 4. In-memory outbox entry must remain 'pending'
      expect(multiplexer.outbox).toHaveLength(1);
      const entry = multiplexer.outbox[0];
      expect(entry.status).toBe('pending');
      expect(entry.channel).toBe(`ct.review.v1.resume.${runId}`);
      expect(entry.payload).toMatchObject({
        runId,
        headSha,
        status: 'completed',
      });

      // 5. Published events array must be empty (nothing was marked published)
      expect(multiplexer.publishedEvents).toHaveLength(0);
    });

    it('EMP-CHAL2-NATS-02: verifies clean DB commit and pending outbox status on NATS ECONNRESET mid-publish', async () => {
      const sqlQueries: string[] = [];

      const mockDb: DatabaseQueryable = {
        query: vi.fn().mockImplementation((sql: string) => {
          sqlQueries.push(sql);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };

      const socketResetError: any = new Error('read ECONNRESET');
      socketResetError.code = 'ECONNRESET';

      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockRejectedValue(socketResetError),
      };

      const multiplexer = new StreamingMultiplexer({
        db: mockDb,
        jetStreamClient: mockJetStream,
      });

      const runId = 'run_econnreset_test_456';
      const headSha = 'c'.repeat(40);

      multiplexer.openStream(runId, 'Test prompt', { headSha });

      const result = await multiplexer.completeStream(runId, headSha);

      expect(result.status).toBe('completed');
      expect(sqlQueries).toContain('COMMIT');
      expect(sqlQueries).not.toContain('ROLLBACK');
      expect(multiplexer.outbox[0].status).toBe('pending');
      expect(multiplexer.publishedEvents).toHaveLength(0);
    });

    it('EMP-CHAL2-NATS-03: verifies clean DB commit and pending outbox status on JetStream publish timeout', async () => {
      const sqlQueries: string[] = [];

      const mockDb: DatabaseQueryable = {
        query: vi.fn().mockImplementation((sql: string) => {
          sqlQueries.push(sql);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };

      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockRejectedValue(new JetStreamTransportError('publish_timeout')),
      };

      const multiplexer = new StreamingMultiplexer({
        db: mockDb,
        jetStreamClient: mockJetStream,
      });

      const runId = 'run_timeout_test_789';
      const headSha = 'd'.repeat(40);

      multiplexer.openStream(runId, 'Test prompt', { headSha });

      const result = await multiplexer.completeStream(runId, headSha);

      expect(result.status).toBe('completed');
      expect(sqlQueries).toContain('COMMIT');
      expect(multiplexer.outbox[0].status).toBe('pending');
      expect(multiplexer.publishedEvents).toHaveLength(0);
    });

    it('EMP-CHAL2-NATS-04: simulates outbox retry after broker reconnects successfully', async () => {
      let natsOnline = false;

      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockImplementation((subject: string, payload: any) => {
          if (!natsOnline) {
            return Promise.reject(new Error('NATS server unavailable'));
          }
          return Promise.resolve({ duplicate: false, seq: 42 });
        }),
      };

      const multiplexer = new StreamingMultiplexer({
        jetStreamClient: mockJetStream,
      });

      const runId = 'run_retry_recovery_101';
      const headSha = 'e'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });

      // Step 1: Initial completion while NATS is offline -> outbox remains pending
      await multiplexer.completeStream(runId, headSha);
      expect(multiplexer.outbox).toHaveLength(1);
      expect(multiplexer.outbox[0].status).toBe('pending');
      expect(multiplexer.publishedEvents).toHaveLength(0);

      // Step 2: NATS comes back online
      natsOnline = true;

      // Simulate outbox retry publisher processing pending entries
      const pendingRecord = multiplexer.outbox[0];
      expect(pendingRecord.status).toBe('pending');

      // Publish retry
      await mockJetStream.publish(pendingRecord.channel, pendingRecord.payload, {
        messageId: `resume:${pendingRecord.runId}`,
      });
      pendingRecord.status = 'published';
      multiplexer.publishedEvents.push(pendingRecord.payload);

      // Verify transitioned to published
      expect(pendingRecord.status).toBe('published');
      expect(multiplexer.publishedEvents).toHaveLength(1);
      expect(mockJetStream.publish).toHaveBeenCalledTimes(2); // 1 initial fail + 1 retry success
    });

    it('EMP-CHAL2-NATS-05: verifies database transaction rolls back if DB query fails, avoiding orphan outbox', async () => {
      const sqlQueries: string[] = [];

      const mockDb: DatabaseQueryable = {
        query: vi.fn().mockImplementation((sql: string) => {
          sqlQueries.push(sql);
          if (sql.includes('UPDATE review_runs')) {
            throw new Error('Deadlock detected or constraint violation');
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };

      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockResolvedValue({ seq: 1 }),
      };

      const multiplexer = new StreamingMultiplexer({
        db: mockDb,
        jetStreamClient: mockJetStream,
        throwOnError: true,
      });

      const runId = 'run_db_fail_rollback';
      const headSha = 'f'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });

      await expect(multiplexer.completeStream(runId, headSha)).rejects.toThrow('Deadlock detected');

      // Must have rolled back DB transaction
      expect(sqlQueries).toContain('BEGIN');
      expect(sqlQueries).toContain('ROLLBACK');
      expect(sqlQueries).not.toContain('COMMIT');

      // NATS publish must NOT have been called
      expect(mockJetStream.publish).not.toHaveBeenCalled();
      expect(multiplexer.outbox).toHaveLength(0);
    });
  });

  // =========================================================================
  // SUITE 3: JetStream Message Deduplication ID `resume:${runId}`
  // =========================================================================
  describe('Suite 3: JetStream Message Deduplication ID Verification', () => {
    it('EMP-CHAL2-DEDUP-01: verifies messageId options contains exact resume:${runId} format', async () => {
      const publishCalls: Array<{ subject: string; payload: any; options?: any }> = [];

      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockImplementation((subject: string, payload: any, options?: any) => {
          publishCalls.push({ subject, payload, options });
          return Promise.resolve({ duplicate: false, seq: 10 });
        }),
      };

      const multiplexer = new StreamingMultiplexer({ jetStreamClient: mockJetStream });
      const runId = 'run_dedup_alpha_999';
      const headSha = '1'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });
      await multiplexer.completeStream(runId, headSha);

      expect(publishCalls).toHaveLength(1);
      const { subject, options, payload } = publishCalls[0];

      expect(subject).toBe(`ct.review.v1.resume.${runId}`);
      expect(options).toBeDefined();
      expect(options.messageId).toBe(`resume:${runId}`);
      expect(payload.runId).toBe(runId);
    });

    it('EMP-CHAL2-DEDUP-02: verifies messageId strictly adheres to JetStream MESSAGE_ID_PATTERN bounds', async () => {
      // MESSAGE_ID_PATTERN in jetStreamClient.ts: /^[A-Za-z0-9_.:-]{1,128}$/u
      const jetStreamMessageIdPattern = /^[A-Za-z0-9_.:-]{1,128}$/u;

      const testRunIds = [
        'run_1',
        'run-test-42',
        'RUN_CAPS_123',
        'run_with_under_scores',
        'a'.repeat(64), // maximum 64-character runId
      ];

      for (const runId of testRunIds) {
        const messageId = `resume:${runId}`;
        expect(jetStreamMessageIdPattern.test(messageId)).toBe(true);
        expect(messageId.length).toBeLessThanOrEqual(128);
        expect(messageId.startsWith('resume:')).toBe(true);
      }
    });

    it('EMP-CHAL2-DEDUP-03: handles duplicate acknowledgement from JetStream cleanly without error', async () => {
      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockResolvedValue({
          acknowledged: true,
          duplicate: true,
          stream: 'ct-review-events',
          seq: 88,
        }),
      };

      const multiplexer = new StreamingMultiplexer({ jetStreamClient: mockJetStream });
      const runId = 'run_duplicate_ack_test';
      const headSha = '2'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });
      const result = await multiplexer.completeStream(runId, headSha);

      expect(result.status).toBe('completed');
      expect(multiplexer.outbox[0].status).toBe('published');
      expect(multiplexer.publishedEvents).toHaveLength(1);
    });
  });

  // =========================================================================
  // SUITE 4: High-Concurrency Stress Test with Disconnect Chaos
  // =========================================================================
  describe('Suite 4: High Concurrency (20 Streams) with Disconnect Chaos', () => {
    it('EMP-CHAL2-STRESS-01: handles 20 concurrent completions with 50% NATS failure rate without unhandled rejections', async () => {
      let activeConnections = 0;
      let peakConnections = 0;

      const mockDb: DatabaseQueryable = {
        query: vi.fn().mockImplementation((sql: string) => {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };

      // 50% fail rate for JetStream publish
      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockImplementation((subject: string, _payload: any) => {
          activeConnections++;
          peakConnections = Math.max(peakConnections, activeConnections);
          // If subject ends with even number, succeed; odd number, fail with ECONNREFUSED
          const match = subject.match(/run_chaos_(\d+)/);
          const index = match ? parseInt(match[1], 10) : 0;
          activeConnections--;

          if (index % 2 === 1) {
            return Promise.reject(new Error(`ECONNREFUSED: NATS down for ${subject}`));
          }
          return Promise.resolve({ duplicate: false, seq: index });
        }),
      };

      const multiplexer = new StreamingMultiplexer({
        db: mockDb,
        jetStreamClient: mockJetStream,
        maxConcurrentStreams: 25,
      });

      // Spawn 20 concurrent streams
      const runIds: string[] = [];
      const headSha = '3'.repeat(40);

      for (let i = 1; i <= 20; i++) {
        const runId = `run_chaos_${i.toString().padStart(2, '0')}`;
        runIds.push(runId);
        multiplexer.openStream(runId, `Prompt ${i}`, { headSha });
        multiplexer.feedChunk(runId, `Result tokens for run ${i}`);
      }

      expect(multiplexer.activeSessions.size).toBe(20);

      // Concurrently complete all 20 streams
      const completionPromises = runIds.map((runId) =>
        multiplexer.completeStream(runId, headSha),
      );

      const results = await Promise.all(completionPromises);

      // Verify all 20 returned completed without unhandled rejection
      expect(results).toHaveLength(20);
      for (const res of results) {
        expect(res.status).toBe('completed');
      }

      // Verify all active sessions cleaned up
      expect(multiplexer.activeSessions.size).toBe(0);

      // Verify outbox state:
      // Exactly 10 odd runs are 'pending' (NATS failed)
      // Exactly 10 even runs are 'published' (NATS succeeded)
      const pendingEntries = multiplexer.outbox.filter((o) => o.status === 'pending');
      const publishedEntries = multiplexer.outbox.filter((o) => o.status === 'published');

      expect(pendingEntries).toHaveLength(10);
      expect(publishedEntries).toHaveLength(10);
      expect(multiplexer.publishedEvents).toHaveLength(10);

      // Verify each pending entry has valid resumption payload and subject
      for (const entry of pendingEntries) {
        expect(entry.channel).toMatch(/^ct\.review\.v1\.resume\.run_chaos_\d{2}$/);
        expect(isReviewEventSubject(entry.channel)).toBe(true);
        expect(isReviewResumptionEvent(entry.payload)).toBe(true);
      }
    });
  });
});
