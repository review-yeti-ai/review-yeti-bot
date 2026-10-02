import { describe, expect, it, vi } from 'vitest';
import {
  StreamingMultiplexer,
  extractFindings,
  sanitizeJsonString,
  type DatabaseQueryable,
  type JetStreamPublisherLike,
  type StreamSessionState,
} from '../../src/gateway/streamingMultiplexer';
import {
  createResumptionPayload,
  validateResumptionPayload,
  isReviewResumptionEvent,
  reviewResumptionEventSchema,
} from '../../src/events/reviewResumptionEvent';
import {
  RESUME_SUBJECT_PREFIX,
  isReviewEventSubject,
} from '../../src/events/reviewEventSubjects';
import type { PrepPayload } from '../../src/review/prepPhase';

function createMockPrepPayload(overrides: Partial<PrepPayload> = {}): PrepPayload {
  return {
    runId: 'run_' + 'a'.repeat(32),
    headSha: '1111222233334444555566667777888899990000',
    baseSha: '0000111122223333444455556666777788889999',
    repository: 'exampleorg/review-yeti-bot',
    prNumber: 42,
    triageSummary: {
      filesCount: 1,
      hunksCount: 1,
      astSymbols: ['authCheck'],
      truncated: false,
    },
    promptMessages: [
      { role: 'system', content: 'You are Review Yeti.' },
      { role: 'user', content: 'Review this commit diff.' },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createDelayedSseResponse(chunks: Array<{ delayMs: number; text: string }>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const item of chunks) {
        if (item.delayMs > 0) {
          await new Promise((r) => setTimeout(r, item.delayMs));
        }
        controller.enqueue(encoder.encode(item.text));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('Milestone 3: Async Streaming Connection Multiplexer (Requirement R4)', () => {
  // =========================================================================
  // SUITE 1: Resumption Event Schema & Subject Validation Contracts
  // =========================================================================
  describe('Suite 1: Resumption Event Schema & Subject Validation', () => {
    it('M3-SCHEMA-01: validates and creates well-formed ReviewResumptionEvent', () => {
      const payload = createResumptionPayload({
        runId: 'run_1234567890abcdef1234567890abcdef',
        headSha: 'a'.repeat(40),
        status: 'completed',
        artifactsDigest: 'b'.repeat(64),
        findingsCount: 3,
      });

      expect(payload.runId).toBe('run_1234567890abcdef1234567890abcdef');
      expect(payload.headSha).toBe('a'.repeat(40));
      expect(payload.status).toBe('completed');
      expect(payload.artifactsDigest).toBe('b'.repeat(64));
      expect(payload.findingsCount).toBe(3);
      expect(payload.completedAt).toBeDefined();

      const validated = validateResumptionPayload(payload);
      expect(validated).toEqual(payload);
      expect(isReviewResumptionEvent(payload)).toBe(true);
    });

    it('M3-SCHEMA-02: rejects invalid resumption event fields via Zod schema', () => {
      // Invalid status
      expect(() =>
        validateResumptionPayload({
          runId: 'run_123',
          headSha: 'a'.repeat(40),
          status: 'in_progress', // invalid
          completedAt: new Date().toISOString(),
          artifactsDigest: 'b'.repeat(64),
        }),
      ).toThrow();

      // Invalid headSha length
      expect(() =>
        validateResumptionPayload({
          runId: 'run_123',
          headSha: 'too_short',
          status: 'completed',
          completedAt: new Date().toISOString(),
          artifactsDigest: 'b'.repeat(64),
        }),
      ).toThrow();

      // Invalid artifactsDigest length
      expect(() =>
        validateResumptionPayload({
          runId: 'run_123',
          headSha: 'a'.repeat(40),
          status: 'completed',
          completedAt: new Date().toISOString(),
          artifactsDigest: 'invalid_digest',
        }),
      ).toThrow();
    });

    it('M3-SCHEMA-03: validates ct.review.v1.resume.<run_id> subject conformance and bounds', () => {
      expect(RESUME_SUBJECT_PREFIX).toBe('ct.review.v1.resume');

      // Valid subjects
      expect(isReviewEventSubject('ct.review.v1.resume.run_12345')).toBe(true);
      expect(isReviewEventSubject('ct.review.v1.resume.run-abc_123-XYZ')).toBe(true);
      expect(isReviewEventSubject('ct.review.v1.resume.' + 'a'.repeat(64))).toBe(true);

      // Invalid subjects
      expect(isReviewEventSubject('ct.review.v1.resume.')).toBe(false); // empty suffix
      expect(isReviewEventSubject('ct.review.v1.resume.' + 'a'.repeat(65))).toBe(false); // >64 chars
      expect(isReviewEventSubject('ct.review.v1.resume.invalid..subject')).toBe(false); // double dot
      expect(isReviewEventSubject('ct.review.v1.resume.has space')).toBe(false); // spaces
      expect(isReviewEventSubject('ct.review.v1.resume.bad$char!')).toBe(false); // special chars
      expect(isReviewEventSubject('ct.other.prefix.run_123')).toBe(false); // wrong prefix
    });
  });

  // =========================================================================
  // SUITE 2: SSE Stream Chunking, Token Accumulation & Reasoning Parsing
  // =========================================================================
  describe('Suite 2: SSE Stream Chunking, Token Accumulation & Findings Parsing', () => {
    it('M3-CHUNK-01: ingests SSE stream, accumulates content & reasoning, and extracts structured findings', async () => {
      const chunks = [
        ': keep-alive\n\n',
        'data: {"choices":[{"delta":{"reasoning":"Inspecting authentication token logic..."}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":" Found potential token leak."}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"```json\\n{\\"findings\\":[{\\"severity\\":\\"P0\\",\\"file\\":\\"src/auth.ts\\",\\"line\\":42,\\"title\\":\\"Token Leak\\",\\"description\\":\\"Bearer token logged to console\\",\\"suggestedPatch\\":\\"logger.info(mask(token))\\"}]}\\n```"}}]}\n\n',
        'data: {"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}\n\n',
        'data: [DONE]\n\n',
      ];

      const mockFetch = vi.fn().mockResolvedValue(createSseResponse(chunks));
      const multiplexer = new StreamingMultiplexer({ fetch: mockFetch });
      const payload = createMockPrepPayload();

      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('completed');
      expect(result.runId).toBe(payload.runId);
      expect(result.reasoningOutput).toContain('Inspecting authentication token logic... Found potential token leak.');
      expect(result.rawOutput).toContain('findings');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toEqual({
        severity: 'P0',
        file: 'src/auth.ts',
        line: 42,
        title: 'Token Leak',
        description: 'Bearer token logged to console',
        suggestedPatch: 'logger.info(mask(token))',
      });
      expect(result.artifactsDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.findingsCount).toBe(1);
    });

    it('M3-CHUNK-02: buffers and reassembles TCP-fragmented SSE chunks across packet boundaries', async () => {
      const fragment1 = 'data: {"choices":[{"delta":{"reason';
      const fragment2 = 'ing":"Analyzing AST split"}}]}\n\n';
      const fragment3 = 'data: {"choices":[{"delta":{"content":"No defects found."}}]}\n\n';
      const fragment4 = 'data: [DONE]\n\n';

      const mockFetch = vi.fn().mockResolvedValue(createSseResponse([fragment1, fragment2, fragment3, fragment4]));
      const multiplexer = new StreamingMultiplexer({ fetch: mockFetch });
      const payload = createMockPrepPayload();

      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('completed');
      expect(result.reasoningOutput).toBe('Analyzing AST split');
      expect(result.rawOutput).toBe('No defects found.');
      expect(result.findings).toHaveLength(0);
    });

    it('M3-CHUNK-03: extracts findings from raw JSON and text fallback regex', () => {
      // Raw JSON
      const rawJson = '{"findings": [{"severity": "P1", "file": "index.ts", "line": 10, "title": "Unused var", "description": "foo is unused"}]}';
      const findings1 = extractFindings(rawJson);
      expect(findings1).toHaveLength(1);
      expect(findings1[0].severity).toBe('P1');
      expect(findings1[0].file).toBe('index.ts');

      // Markdown fenced JSON
      const markdownJson = 'Here is the review:\n```json\n{"findings": [{"severity": "P0", "file": "security.ts", "line": 99, "title": "SQL Injection", "description": "Raw string concatenation"}]}\n```';
      const findings2 = extractFindings(markdownJson);
      expect(findings2).toHaveLength(1);
      expect(findings2[0].severity).toBe('P0');

      // Fallback text format
      const textFinding = 'Analysis complete.\nFinding [P2]: in styles.css:5 Missing semicolon in css rule';
      const findings3 = extractFindings(textFinding);
      expect(findings3).toHaveLength(1);
      expect(findings3[0].severity).toBe('P2');
      expect(findings3[0].file).toBe('styles.css');
      expect(findings3[0].line).toBe(5);
    });

    it('M3-CHUNK-04: enforces 1MB token accumulation ceiling to prevent runaway memory leaks', () => {
      const multiplexer = new StreamingMultiplexer({ maxAccumulationBytes: 1024 }); // 1KB ceiling for testing
      const session = multiplexer.openStream('run_overflow', 'Test prompt');

      // Feed 2KB of chunks
      const largeChunk = 'A'.repeat(500);
      multiplexer.feedChunk('run_overflow', largeChunk);
      multiplexer.feedChunk('run_overflow', largeChunk);
      multiplexer.feedChunk('run_overflow', largeChunk);
      multiplexer.feedChunk('run_overflow', largeChunk);

      expect(Buffer.byteLength(session.tokensAccumulated, 'utf8')).toBeLessThanOrEqual(1024);
    });

    it('M3-CHUNK-05: handles malformed chunks and special characters without crash', async () => {
      const chunks = [
        'data: not valid json at all\n\n',
        ': comment with strange chars \u0000 \t \r\n\n',
        'data: {"choices":[{"delta":{"content":"Clean token with escaped characters: \\n\\r\\t" sailing: false}}]}\n\n', // malformed json
        'data: {"choices":[{"delta":{"content":"Valid content."}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      const mockFetch = vi.fn().mockResolvedValue(createSseResponse(chunks));
      const multiplexer = new StreamingMultiplexer({ fetch: mockFetch });
      const payload = createMockPrepPayload();

      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('completed');
      expect(result.rawOutput).toBe('Valid content.');
    });
  });

  // =========================================================================
  // SUITE 3: Mid-Stream Network Disconnects & Retry Logic
  // =========================================================================
  describe('Suite 3: Mid-Stream Disconnects & Exponential Retry', () => {
    it('M3-RETRY-01: retries on transient HTTP 503 error with exponential backoff and succeeds', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(new Response('Service Unavailable', { status: 503 }));
        }
        return Promise.resolve(
          createSseResponse([
            'data: {"choices":[{"delta":{"content":"Recovered from 503."}}]}\n\n',
            'data: [DONE]\n\n',
          ]),
        );
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        maxRetries: 2,
        retryInitialDelayMs: 10,
      });

      const payload = createMockPrepPayload();
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('completed');
      expect(result.rawOutput).toBe('Recovered from 503.');
      expect(callCount).toBe(2);
    });

    it('M3-RETRY-02: retries on transient network disconnect (ECONNRESET) and succeeds', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const err: any = new Error('read ECONNRESET');
          err.code = 'ECONNRESET';
          return Promise.reject(err);
        }
        return Promise.resolve(
          createSseResponse([
            'data: {"choices":[{"delta":{"content":"Recovered after socket reset."}}]}\n\n',
            'data: [DONE]\n\n',
          ]),
        );
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        maxRetries: 2,
        retryInitialDelayMs: 10,
      });

      const payload = createMockPrepPayload();
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('completed');
      expect(result.rawOutput).toBe('Recovered after socket reset.');
      expect(callCount).toBe(2);
    });

    it('M3-RETRY-03: fails gracefully and marks status failed when retries are exhausted', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        maxRetries: 2,
        retryInitialDelayMs: 5,
        throwOnError: false,
      });

      const payload = createMockPrepPayload();
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('502');
      expect(mockFetch).toHaveBeenCalledTimes(3); // attempt 1 + 2 retries
      expect(multiplexer.activeSessions.size).toBe(0); // cleaned up
    });

    it('M3-RETRY-04: aborts immediately on non-transient HTTP 401 Unauthorized without retry', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('Unauthorized: Invalid API Key', { status: 401 }));

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        maxRetries: 3,
        throwOnError: false,
      });

      const payload = createMockPrepPayload();
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('401');
      expect(mockFetch).toHaveBeenCalledTimes(1); // zero retries
    });
  });

  // =========================================================================
  // SUITE 4: Reasoning Watchdogs & Timeouts (TTFT, Inactivity, Total Deadline)
  // =========================================================================
  describe('Suite 4: Reasoning Watchdogs & Timeouts', () => {
    it('M3-TIMEOUT-01: fires TTFT watchdog if no tokens arrive within ttftTimeoutMs', async () => {
      // Stream that produces no chunks for 100ms
      const mockFetch = vi.fn().mockResolvedValue(
        createDelayedSseResponse([{ delayMs: 100, text: 'data: {"choices":[{"delta":{"content":"late"}}]}\n\n' }]),
      );

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 30, // 30ms TTFT timeout
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = createMockPrepPayload();
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('TTFT timeout');
      expect(multiplexer.activeSessions.size).toBe(0);
    });

    it('M3-TIMEOUT-02: fires inactivity watchdog if stream stalls after first token', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createDelayedSseResponse([
          { delayMs: 5, text: 'data: {"choices":[{"delta":{"content":"first chunk"}}]}\n\n' },
          { delayMs: 120, text: 'data: {"choices":[{"delta":{"content":"second chunk"}}]}\n\n' },
        ]),
      );

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 50,
        inactivityTimeoutMs: 30, // 30ms inactivity timeout
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = createMockPrepPayload();
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('inactivity timeout');
    });

    it('M3-TIMEOUT-03: keep-alive comments prevent socket timeout and maintain session liveness', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        createDelayedSseResponse([
          { delayMs: 10, text: ': keep-alive\n\n' },
          { delayMs: 10, text: 'data: {"choices":[{"delta":{"content":"Token after keep-alive"}}]}\n\n' },
          { delayMs: 5, text: 'data: [DONE]\n\n' },
        ]),
      );

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 50,
        inactivityTimeoutMs: 50,
        maxRetries: 0,
      });

      const payload = createMockPrepPayload();
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('completed');
      expect(result.rawOutput).toBe('Token after keep-alive');
    });

    it('M3-TIMEOUT-04: fires total watchdog deadline (180s wall clock ceiling)', async () => {
      // Continuous chunks that exceed total deadline
      const mockFetch = vi.fn().mockResolvedValue(
        createDelayedSseResponse([
          { delayMs: 10, text: 'data: {"choices":[{"delta":{"content":"chunk 1"}}]}\n\n' },
          { delayMs: 20, text: 'data: {"choices":[{"delta":{"content":"chunk 2"}}]}\n\n' },
          { delayMs: 40, text: 'data: {"choices":[{"delta":{"content":"chunk 3"}}]}\n\n' },
        ]),
      );

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 100,
        inactivityTimeoutMs: 100,
        totalDeadlineMs: 25, // 25ms total deadline
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = createMockPrepPayload();
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('total watchdog deadline');
    });
  });

  // =========================================================================
  // SUITE 5: Concurrency Scaling & Memory Footprint (<50MB across 20+ connections)
  // =========================================================================
  describe('Suite 5: 20+ Concurrent Streams & Memory Footprint Bounds', () => {
    it('M3-SCALE-01: handles 20 concurrent active streaming connections with <50MB resident memory', async () => {
      const multiplexer = new StreamingMultiplexer({ maxConcurrentStreams: 25 });

      // Open 20 concurrent streams manually
      const sessions: StreamSessionState[] = [];
      for (let i = 1; i <= 20; i++) {
        const runId = `run_concurrent_${i.toString().padStart(2, '0')}`;
        const session = multiplexer.openStream(runId, 'Review prompt', {
          headSha: 'a'.repeat(40),
        });
        sessions.push(session);
      }

      expect(multiplexer.activeSessions.size).toBe(20);
      expect(multiplexer.getActiveCount()).toBe(20);

      // Verify resident memory model: 5MB base + 2MB per connection = 45MB < 50MB
      const residentMb = multiplexer.getResidentMemoryMb();
      expect(residentMb).toBeLessThan(50);
      expect(residentMb).toBe(45);

      // Feed chunks concurrently
      for (let i = 0; i < 20; i++) {
        multiplexer.feedChunk(sessions[i].runId, `Chunk token for run ${i + 1}`);
      }

      // Complete all 20 streams
      for (let i = 0; i < 20; i++) {
        await multiplexer.completeStream(sessions[i].runId, sessions[i].headSha, []);
      }

      expect(multiplexer.activeSessions.size).toBe(0);
      expect(multiplexer.getResidentMemoryMb()).toBe(5); // returns to base memory
    });

    it('M3-SCALE-02: rejects additional streams when maxConcurrentStreams limit is reached', async () => {
      const multiplexer = new StreamingMultiplexer({ maxConcurrentStreams: 2 });
      multiplexer.openStream('run_1', 'prompt');
      multiplexer.openStream('run_2', 'prompt');

      const payload = createMockPrepPayload({ runId: 'run_3' });
      await expect(multiplexer.startInferenceSession(payload)).rejects.toThrow('Concurrency limit reached');
    });
  });

  // =========================================================================
  // SUITE 6: Transactional PostgreSQL State Persistence & Rollback
  // =========================================================================
  describe('Suite 6: Transactional PostgreSQL State Persistence & Sanitization', () => {
    it('M3-PERSIST-01: executes atomic transaction committing review_runs, artifacts, and outbox', async () => {
      const queryLog: Array<{ sql: string; params?: unknown[] }> = [];

      const mockDb: DatabaseQueryable = {
        query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
          queryLog.push({ sql, params });
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };

      const multiplexer = new StreamingMultiplexer({ db: mockDb });
      const runId = 'run_' + '1'.repeat(32);
      const headSha = 'c'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });
      multiplexer.feedChunk(runId, '{"findings": [{"severity": "P0", "file": "db.ts", "line": 15, "title": "SQLi", "description": "Unescaped param"}]}');

      const result = await multiplexer.completeStream(runId, headSha);

      expect(result.status).toBe('completed');
      expect(result.findings).toHaveLength(1);

      // Verify SQL execution order: BEGIN -> UPDATE review_runs -> INSERT review_run_artifacts -> UPDATE review_dispatch_outbox -> COMMIT
      expect(queryLog[0].sql).toBe('BEGIN');

      const updateRuns = queryLog.find((q) => q.sql.includes('UPDATE review_runs'));
      expect(updateRuns).toBeDefined();
      expect(updateRuns?.sql).toContain("status = 'inference_completed'");
      expect(updateRuns?.sql).toContain("stage = 'resumption_ready'");
      expect(updateRuns?.sql).toContain('{llm_completion}');
      expect(updateRuns?.sql).toContain('{llmCompletion}');

      const insertArtifacts = queryLog.find((q) => q.sql.includes('INSERT INTO review_run_artifacts'));
      expect(insertArtifacts).toBeDefined();
      expect(insertArtifacts?.sql).toContain("'llm_completion'");

      const updateOutbox = queryLog.find((q) => q.sql.includes('UPDATE review_dispatch_outbox'));
      expect(updateOutbox).toBeDefined();
      expect(updateOutbox?.sql).toContain("status = 'pending'");

      expect(queryLog[queryLog.length - 1].sql).toBe('COMMIT');
    });

    it('M3-PERSIST-02: executes ROLLBACK when database query encounters an error', async () => {
      const queryLog: string[] = [];

      const mockDb: DatabaseQueryable = {
        query: vi.fn().mockImplementation((sql: string) => {
          queryLog.push(sql);
          if (sql.includes('review_run_artifacts')) {
            throw new Error('Database constraint violation: check constraint exceeded');
          }
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };

      const multiplexer = new StreamingMultiplexer({ db: mockDb, throwOnError: true });
      const runId = 'run_err_rollback';
      const headSha = 'd'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });

      await expect(multiplexer.completeStream(runId, headSha)).rejects.toThrow('constraint violation');
      expect(queryLog).toContain('BEGIN');
      expect(queryLog).toContain('ROLLBACK');
    });

    it('M3-PERSIST-03: sanitizes null bytes (\\0, \\u0000) and lone surrogates for PostgreSQL JSONB safety', () => {
      const dirtyObj = {
        title: 'Dirty null \u0000 and null \\u0000 byte',
        surrogate: 'Split surrogate: \uD83D (lone high)',
      };

      const sanitized = sanitizeJsonString(dirtyObj);

      // Must not contain raw null byte or escaped null byte
      expect(sanitized).not.toContain('\u0000');
      expect(sanitized).not.toContain('\\u0000');

      // Lone surrogate replaced with \uFFFD replacement char
      expect(sanitized).toContain('\uFFFD');

      // Must parse cleanly as valid JSON
      const parsed = JSON.parse(sanitized);
      expect(parsed.title).toBe('Dirty null  and null  byte');
    });
  });

  // =========================================================================
  // SUITE 7: NATS JetStream Resumption Event & Disconnect Resilience
  // =========================================================================
  describe('Suite 7: NATS JetStream Resumption Event & Disconnect Resilience', () => {
    it('M3-NATS-01: publishes resumption trigger with msgID deduplication on ct.review.v1.resume.<run_id>', async () => {
      const publishedCalls: Array<{ subject: string; payload: any; options?: any }> = [];

      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockImplementation((subject: string, payload: any, options?: any) => {
          publishedCalls.push({ subject, payload, options });
          return Promise.resolve({ duplicate: false, seq: 1 });
        }),
      };

      const multiplexer = new StreamingMultiplexer({ jetStreamClient: mockJetStream });
      const runId = 'run_nats_success_123';
      const headSha = 'e'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });
      await multiplexer.completeStream(runId, headSha);

      expect(publishedCalls).toHaveLength(1);
      const call = publishedCalls[0];
      expect(call.subject).toBe(`ct.review.v1.resume.${runId}`);
      expect(call.options).toEqual({ messageId: `resume:${runId}` });
      expect(call.payload).toMatchObject({
        runId,
        headSha,
        status: 'completed',
        findingsCount: 0,
      });

      expect(multiplexer.outbox[0].status).toBe('published');
    });

    it('M3-NATS-02: leaves outbox entry as pending when NATS JetStream broker is disconnected', async () => {
      const mockJetStream: JetStreamPublisherLike = {
        publish: vi.fn().mockRejectedValue(new Error('NATS connection closed (ECONNREFUSED 127.0.0.1:4222)')),
      };

      const multiplexer = new StreamingMultiplexer({ jetStreamClient: mockJetStream });
      const runId = 'run_nats_disconnected';
      const headSha = 'f'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });

      // Does NOT throw; completes successfully while outbox remains 'pending'
      const result = await multiplexer.completeStream(runId, headSha);

      expect(result.status).toBe('completed');
      expect(multiplexer.outbox).toHaveLength(1);
      expect(multiplexer.outbox[0].status).toBe('pending');
      expect(multiplexer.outbox[0].channel).toBe(`ct.review.v1.resume.${runId}`);
    });
  });
});
