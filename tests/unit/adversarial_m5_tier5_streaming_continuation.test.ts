import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StreamingMultiplexer,
  extractFindings,
  sanitizeJsonString,
  MAX_ACCUMULATION_BYTES,
  MAX_ARTIFACT_BYTES,
  type DatabaseQueryable,
  type JetStreamPublisherLike,
  type StreamSessionState,
  type Finding,
} from '../../src/gateway/streamingMultiplexer';
import {
  runContinuationPhase,
  evaluateGatePolicy,
  formatContinuationSummary,
  loadContinuationState,
  isContinuationPhase,
} from '../../src/review/continuationPhase';
import { normalizeFinding } from '../../src/review/findings';
import {
  runPrepPhase,
  extractDiffAndTriage,
  assemblePrepPrompt,
  persistPrepState,
  dispatchMultiplexerTrigger,
  isPrepPhase,
  MAX_PREPARED_REVIEW_BYTES,
  type PrepPayload,
} from '../../src/review/prepPhase';
import {
  withGitHubRetry,
  classifyGitHubTransient,
  computeGitHubRetryDelay,
  DEFAULT_GITHUB_RETRY,
} from '../../src/github/githubRetry';
import { raceWithAbort } from '../../src/gateway/raceWithAbort';

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
      astSymbols: ['authCheck', 'verifyToken'],
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

describe('Milestone 5 Phase 2: White-Box Adversarial Coverage Hardening (Tier 5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. SSE Connection Resets During Token Bursts
  // =========================================================================
  describe('1. SSE Connection Resets During Token Bursts', () => {
    it('handles mid-stream connection reset during rapid token bursts with exponential retry', async () => {
      let callCount = 0;
      const burst1 = [
        'data: {"choices":[{"delta":{"content":"```json\\n{\\"findings\\": ["}}]}\n\n',
      ];
      const burst2 = [
        'data: {"choices":[{"delta":{"content":"```json\\n{\\"findings\\": [{\\"severity\\":\\"P0\\",\\"file\\":\\"src/sec.ts\\",\\"line\\":12,\\"title\\":\\"SQL Injection\\",\\"description\\":\\"Unescaped SQL query\\"}]}\\n```"}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Attempt 1 sends partial token burst, then abruptly drops connection with ECONNRESET
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(burst1[0]));
              const err: any = new Error('read ECONNRESET');
              err.code = 'ECONNRESET';
              controller.error(err);
            },
          });
          return Promise.resolve(new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }));
        }

        // Attempt 2 succeeds cleanly
        return Promise.resolve(createSseResponse(burst2));
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        maxRetries: 2,
        retryInitialDelayMs: 5,
      });

      const payload = createMockPrepPayload();
      const result = await multiplexer.startInferenceSession(payload);

      expect(callCount).toBe(2);
      expect(result.status).toBe('completed');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        severity: 'P0',
        file: 'src/sec.ts',
        line: 12,
        title: 'SQL Injection',
      });
    });

    it('enforces TTFT watchdog abort when upstream gateway accepts connection but emits no tokens', async () => {
      const mockFetch = vi.fn().mockImplementation(() => {
        // Stream that never emits any tokens
        const stream = new ReadableStream({
          start() {
            // Keep open without emitting
          },
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }));
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 35,
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = createMockPrepPayload();
      const startTime = Date.now();
      const result = await multiplexer.startInferenceSession(payload);
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Streaming TTFT timeout');
      expect(elapsed).toBeGreaterThanOrEqual(30);
      expect(multiplexer.activeSessions.size).toBe(0);
    });

    it('enforces inactivity watchdog when stream emits first token and then stalls mid-burst', async () => {
      const encoder = new TextEncoder();
      const mockFetch = vi.fn().mockImplementation(() => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"First token"}}]}\n\n'));
            // Then stalls completely without closing
          },
        });
        return Promise.resolve(new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }));
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 100,
        inactivityTimeoutMs: 35,
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = createMockPrepPayload();
      const startTime = Date.now();
      const result = await multiplexer.startInferenceSession(payload);
      const elapsed = Date.now() - startTime;

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Streaming inactivity timeout');
      expect(elapsed).toBeGreaterThanOrEqual(30);
      expect(multiplexer.activeSessions.size).toBe(0);
    });
  });

  // =========================================================================
  // 2. Payload Truncation & Boundary Conditions
  // =========================================================================
  describe('2. Payload Truncation & Boundary Conditions', () => {
    it('assemblePrepPrompt: truncates prompt context at exactly 256KB boundary without broken surrogates', () => {
      // Create diff content with 4-byte astral plane emojis at the boundary
      const largePatch = '🚀'.repeat(70_000); // 70k * 4 bytes = 280,000 bytes > 256KB
      const changedFiles = [
        {
          path: 'src/emoji.ts',
          patch: largePatch,
        },
      ];

      const { messages, truncated } = assemblePrepPrompt({
        changedFiles,
        astSymbols: ['handleRocket'],
        repo: 'exampleorg/review-yeti-bot',
        prNumber: 99,
        headSha: 'a'.repeat(40),
        maxBytes: MAX_PREPARED_REVIEW_BYTES,
      });

      expect(truncated).toBe(true);
      const userMessage = messages.find((m) => m.role === 'user');
      expect(userMessage).toBeDefined();
      expect(userMessage?.content).toContain('[TRUNCATED: MaxPreparedReviewBytes exceeded]');

      // Invariant: Sliced content must be strictly well-formed Unicode (no lone surrogates or partial bytes)
      const content = typeof userMessage?.content === 'string' ? userMessage.content : '';
      expect(typeof (content as any).isWellFormed === 'function' ? (content as any).isWellFormed() : true).toBe(true);
      expect(content).not.toContain('\uFFFD');
    });

    it('assemblePrepPrompt: does not truncate when prompt context is within 256KB limit', () => {
      const normalPatch = '@@ -1,3 +1,3 @@\n-const old = 1;\n+const current = 2;';
      const changedFiles = [
        {
          path: 'src/index.ts',
          patch: normalPatch,
        },
      ];

      const { messages, truncated } = assemblePrepPrompt({
        changedFiles,
        astSymbols: ['current'],
        repo: 'exampleorg/review-yeti-bot',
        prNumber: 100,
        headSha: 'b'.repeat(40),
        maxBytes: MAX_PREPARED_REVIEW_BYTES,
      });

      expect(truncated).toBe(false);
      const userMessage = messages.find((m) => m.role === 'user');
      expect(userMessage?.content).not.toContain('[TRUNCATED: MaxPreparedReviewBytes exceeded]');
      expect(userMessage?.content).toContain('const current = 2;');
    });

    it('StreamingMultiplexer: strictly caps token accumulation at 1MB ceiling', () => {
      const multiplexer = new StreamingMultiplexer({ maxAccumulationBytes: 1024 }); // 1KB for test
      const session = multiplexer.openStream('run_bound_test', 'prompt');

      // Feed 2KB of tokens in 4 chunks
      const chunk = 'B'.repeat(512);
      multiplexer.feedChunk('run_bound_test', chunk);
      multiplexer.feedChunk('run_bound_test', chunk);
      multiplexer.feedChunk('run_bound_test', chunk);
      multiplexer.feedChunk('run_bound_test', chunk);

      expect(Buffer.byteLength(session.tokensAccumulated, 'utf8')).toBe(1024);
      expect(session.tokensAccumulated.length).toBe(1024);
    });

    it('StreamingMultiplexer: skips review_run_artifacts insert when payload exceeds MAX_ARTIFACT_BYTES (2MB)', async () => {
      const queryLog: string[] = [];
      const mockDb: DatabaseQueryable = {
        query: vi.fn().mockImplementation((sql: string) => {
          queryLog.push(sql);
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };

      const multiplexer = new StreamingMultiplexer({ db: mockDb });
      const runId = 'run_large_payload';
      const headSha = 'c'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });

      // Create synthetic payload where byteLength exceeds 2MB
      const giantFindings: Finding[] = Array.from({ length: 4000 }, (_, i) => ({
        severity: 'P2',
        file: `src/path/to/very/long/nested/directory/structure/file_${i}.ts`,
        line: i + 1,
        title: `Finding title for iteration ${i} with additional descriptive padding`,
        description: `Detailed description containing extensive textual analysis for finding ${i} ensuring byte threshold is exceeded.`.repeat(4),
      }));

      const result = await multiplexer.completeStream(runId, headSha, giantFindings);
      expect(result.status).toBe('completed');

      // review_runs update must execute
      expect(queryLog.some((q) => q.includes('UPDATE review_runs'))).toBe(true);
      // review_run_artifacts insert must be skipped because byteLength > 2,000,000
      expect(queryLog.some((q) => q.includes('INSERT INTO review_run_artifacts'))).toBe(false);
      // review_dispatch_outbox update must execute
      expect(queryLog.some((q) => q.includes('UPDATE review_dispatch_outbox'))).toBe(true);
    });
  });

  // =========================================================================
  // 3. Unicode Astral Planes & Data Sanitization
  // =========================================================================
  describe('3. Unicode Astral Planes & Data Sanitization', () => {
    it('sanitizeJsonString: strips literal null bytes and lone surrogates while preserving valid astral planes', () => {
      const complexObject = {
        emoji: '🚀✨🎉',
        cjkAstral: '𠮷野家', // U+20BB7 (astral plane CJK)
        nullByte: 'Before\0After',
        escapedNull: 'Before\\u0000After',
        loneSurrogate: 'Split \uD800 without low surrogate',
        validSurrogate: '\uD83D\uDE00', // 😀
      };

      const sanitized = sanitizeJsonString(complexObject);

      // Must not contain any form of null byte
      expect(sanitized).not.toContain('\u0000');
      expect(sanitized).not.toContain('\\u0000');

      // Must preserve valid astral planes
      expect(sanitized).toContain('🚀✨🎉');
      expect(sanitized).toContain('𠮷野家');

      // Lone surrogate replaced with \uFFFD
      expect(sanitized).toContain('\uFFFD');

      // Must parse cleanly as valid JSON
      const parsed = JSON.parse(sanitized);
      expect(parsed.nullByte).toBe('BeforeAfter');
      expect(parsed.escapedNull).toBe('BeforeAfter');
      expect(parsed.emoji).toBe('🚀✨🎉');
    });

    it('formatContinuationSummary: escapes pipe characters and newlines in Markdown tables', () => {
      const findingsWithPipes: Finding[] = [
        {
          severity: 'P0',
          file: 'src/parser|pipe.ts',
          line: 42,
          title: 'Syntax | Error in | expression',
          description: 'Line 1 of description\nLine 2 with | pipe\nLine 3',
        },
      ];

      const markdown = formatContinuationSummary({
        repo: 'exampleorg/review-yeti-bot',
        prNumber: 77,
        headSha: '0123456789abcdef0123456789abcdef01234567',
        verdict: 'BLOCK',
        conclusion: 'failure',
        findings: findingsWithPipes,
      });

      // Verify that the table row doesn't have unescaped internal pipe columns or raw newlines
      const tableLines = markdown.split('\n').filter((l) => l.startsWith('|'));
      // Table header + separator + exactly 1 finding row
      expect(tableLines).toHaveLength(3);

      const findingRow = tableLines[2];
      expect(findingRow).toContain('Syntax \\| Error in \\| expression');
      expect(findingRow).not.toContain('\n');
    });
  });

  // =========================================================================
  // 4. Database Transaction Commits & Idempotency
  // =========================================================================
  describe('4. Database Transaction Commits & Idempotency', () => {
    it('StreamingMultiplexer: acquires client from pool and releases client in finally block', async () => {
      let clientReleased = false;
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
        release: vi.fn().mockImplementation(() => {
          clientReleased = true;
        }),
      };

      const mockDb: DatabaseQueryable = {
        query: vi.fn(),
        connect: vi.fn().mockResolvedValue(mockClient),
      };

      const multiplexer = new StreamingMultiplexer({ db: mockDb });
      const runId = 'run_pool_release_test';
      const headSha = 'd'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });
      await multiplexer.completeStream(runId, headSha, []);

      expect(mockDb.connect).toHaveBeenCalledTimes(1);
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(clientReleased).toBe(true);
    });

    it('StreamingMultiplexer: issues ROLLBACK and releases client when transaction fails', async () => {
      let clientReleased = false;
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('UPDATE review_runs')) {
            throw new Error('Deadlock detected in review_runs');
          }
          return { rows: [], rowCount: 1 };
        }),
        release: vi.fn().mockImplementation(() => {
          clientReleased = true;
        }),
      };

      const mockDb: DatabaseQueryable = {
        query: vi.fn(),
        connect: vi.fn().mockResolvedValue(mockClient),
      };

      const multiplexer = new StreamingMultiplexer({ db: mockDb, throwOnError: true });
      const runId = 'run_pool_rollback_test';
      const headSha = 'e'.repeat(40);

      multiplexer.openStream(runId, 'prompt', { headSha });

      await expect(multiplexer.completeStream(runId, headSha, [])).rejects.toThrow('Deadlock detected');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(clientReleased).toBe(true);
    });

    it('runContinuationPhase: executes idempotently when review_runs status is already completed', async () => {
      const mockDb = {
        query: async (sql: string) => {
          if (sql.includes('SELECT') && sql.includes('review_runs')) {
            return {
              rows: [
                {
                  run_id: 'run-already-completed',
                  repo: 'exampleorg/review-yeti-bot',
                  pr_number: 10,
                  head_sha: 'sha-already-completed',
                  status: 'completed', // Already completed
                  artifacts: {
                    continuation_result: { verdict: 'SHIP' },
                  },
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const mockCommentPublisher = {
        publishReview: vi.fn(),
      };
      const mockCheckClient = {
        publishGateCheck: vi.fn(),
      };

      const result = await runContinuationPhase({
        runId: 'run-already-completed',
        db: mockDb,
        commentPublisher: mockCommentPublisher,
        checkClient: mockCheckClient,
        suppressExit: true,
      });

      expect(result.ok).toBe(true);
      expect(result.alreadyCompleted).toBe(true);
      expect(result.exitCode).toBe(0);
      // Zero comments or check runs posted
      expect(mockCommentPublisher.publishReview).not.toHaveBeenCalled();
      expect(mockCheckClient.publishGateCheck).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. GitHub 429 Rate Limit Backoff Cascades
  // =========================================================================
  describe('5. GitHub 429 Rate Limit Backoff Cascades', () => {
    it('withGitHubRetry: classifies HTTP 429 as rate_limit and parses Retry-After header', () => {
      const headers = new Headers({
        'retry-after': '12',
      });
      const transient = classifyGitHubTransient(429, headers, Date.now());
      expect(transient).toBeDefined();
      expect(transient?.kind).toBe('rate_limit');
      expect(transient?.status).toBe(429);
      expect(transient?.serverWaitMs).toBe(12_000);
    });

    it('withGitHubRetry: handles 429 cascade across multiple retries using serverWaitMs', async () => {
      let attempts = 0;
      const sleepTimes: number[] = [];
      const sleepMock = vi.fn().mockImplementation(async (ms: number) => {
        sleepTimes.push(ms);
      });

      const response = await withGitHubRetry(
        {
          operation: 'PATCH /repos/exampleorg/review-yeti-bot/check-runs/1',
          method: 'PATCH',
          attempt: async (att) => {
            attempts = att;
            if (att < 3) {
              const headers = new Headers({ 'retry-after': String(att * 2) });
              return new Response('Rate limited', { status: 429, headers });
            }
            return new Response(JSON.stringify({ id: 1, status: 'completed' }), { status: 200 });
          },
        },
        {
          maxAttempts: 4,
          sleep: sleepMock,
        },
      );

      expect(attempts).toBe(3);
      expect(response.status).toBe(200);
      expect(sleepTimes).toEqual([2000, 4000]);
    });

    it('withGitHubRetry: aborts retry immediately when serverWaitMs exceeds maxServerWaitMs (60s)', async () => {
      let attempts = 0;
      const sleepMock = vi.fn();

      const response = await withGitHubRetry(
        {
          operation: 'GET /repos/exampleorg/review-yeti-bot/check-runs',
          method: 'GET',
          attempt: async (att) => {
            attempts = att;
            const headers = new Headers({ 'retry-after': '120' }); // 120s > 60s
            return new Response('Rate limit exceeded', { status: 429, headers });
          },
        },
        {
          maxAttempts: 4,
          maxServerWaitMs: 60_000,
          sleep: sleepMock,
        },
      );

      // Attempt 1 receives 120s wait, exceeds 60s cap -> finishes without retry
      expect(attempts).toBe(1);
      expect(response.status).toBe(429);
      expect(sleepMock).not.toHaveBeenCalled();
    });

    it('withGitHubRetry: aborts retry when retry delay would breach deadlineAtMs', async () => {
      let attempts = 0;
      const sleepMock = vi.fn();
      const now = 100_000;

      const response = await withGitHubRetry(
        {
          operation: 'GET /repos/exampleorg/review-yeti-bot/pulls/1',
          method: 'GET',
          attempt: async (att) => {
            attempts = att;
            const headers = new Headers({ 'retry-after': '10' }); // 10s wait
            return new Response('Rate limit', { status: 429, headers });
          },
        },
        {
          maxAttempts: 4,
          now: () => now,
          // Deadline is only 8s away (108_000), but wait is 10s + 5s reserve = 15s
          deadlineAtMs: 108_000,
          sleep: sleepMock,
        },
      );

      expect(attempts).toBe(1);
      expect(response.status).toBe(429);
      expect(sleepMock).not.toHaveBeenCalled();
    });

    it('withGitHubRetry: non-idempotent POST rejects blind 502/503 retry without reconcile callback', async () => {
      let attempts = 0;
      const sleepMock = vi.fn();

      await expect(
        withGitHubRetry(
          {
            operation: 'POST /repos/exampleorg/review-yeti-bot/check-runs',
            method: 'POST',
            // No reconcile callback supplied
            attempt: async (att) => {
              attempts = att;
              const err: any = new Error('HTTP 502 Bad Gateway');
              err.status = 502;
              throw err;
            },
          },
          {
            maxAttempts: 4,
            sleep: sleepMock,
          },
        ),
      ).rejects.toThrow('HTTP 502 Bad Gateway');

      // Fails immediately after 1 attempt because blind POST retry could duplicate writes
      expect(attempts).toBe(1);
      expect(sleepMock).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 6. 60s Timeout Enforcement & Lifecycle Cancellation
  // =========================================================================
  describe('6. 60s Timeout Enforcement & Lifecycle Cancellation', () => {
    it('runContinuationPhase: strictly enforces timeout guard when operations hang', async () => {
      const hungDb = {
        query: () => new Promise<any>(() => {
          // Permanently pending promise
        }),
      };

      const startTime = Date.now();
      const timeoutMs = 60; // 60ms timeout for test

      await expect(
        runContinuationPhase({
          runId: 'run-hung-operation',
          db: hungDb,
          timeoutMs,
          suppressExit: true,
        }),
      ).rejects.toThrow(/Continuation execution exceeded 60ms timeout guard/);

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(50);
      expect(elapsed).toBeLessThan(250);
    });

    it('raceWithAbort: unregisters event listener immediately upon resolution to prevent leaks', async () => {
      const abortController = new AbortController();
      let listenerCount = 0;

      // Mock AbortSignal addEventListener / removeEventListener
      const originalAdd = abortController.signal.addEventListener.bind(abortController.signal);
      const originalRemove = abortController.signal.removeEventListener.bind(abortController.signal);

      vi.spyOn(abortController.signal, 'addEventListener').mockImplementation((type, listener, options) => {
        if (type === 'abort') listenerCount++;
        return originalAdd(type, listener, options);
      });

      vi.spyOn(abortController.signal, 'removeEventListener').mockImplementation((type, listener, options) => {
        if (type === 'abort') listenerCount--;
        return originalRemove(type, listener, options);
      });

      const fastPromise = Promise.resolve('completed value');
      const result = await raceWithAbort(fastPromise, abortController.signal, () => new Error('aborted'));

      expect(result).toBe('completed value');
      expect(listenerCount).toBe(0);
    });

    it('isContinuationPhase and isPrepPhase: correctly identify phase flags in env and argv', () => {
      expect(isPrepPhase({ CT_PHASE: 'prep' }, [])).toBe(true);
      expect(isPrepPhase({}, ['--phase=prep'])).toBe(true);
      expect(isPrepPhase({}, ['node', 'index.js', '--phase', 'prep'])).toBe(true);
      expect(isPrepPhase({}, [])).toBe(false);

      expect(isContinuationPhase({ CT_PHASE: 'continuation' }, [])).toBe(true);
      expect(isContinuationPhase({}, ['--phase=continuation'])).toBe(true);
      expect(isContinuationPhase({}, ['node', 'index.js', '--phase', 'continuation'])).toBe(true);
      expect(isContinuationPhase({}, [])).toBe(false);
    });
  });
});
