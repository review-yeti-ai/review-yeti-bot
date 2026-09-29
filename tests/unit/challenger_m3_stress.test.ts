import { describe, it, expect, vi } from 'vitest';
import {
  StreamingMultiplexer,
  extractFindings,
  sanitizeJsonString,
  MAX_ACCUMULATION_BYTES,
  MAX_ARTIFACT_BYTES,
  type DatabaseQueryable,
  type JetStreamPublisherLike,
  type StreamSessionState,
} from '../../src/gateway/streamingMultiplexer';
import {
  createResumptionPayload,
  validateResumptionPayload,
  isReviewResumptionEvent,
} from '../../src/events/reviewResumptionEvent';
import {
  RESUME_SUBJECT_PREFIX,
  isReviewEventSubject,
} from '../../src/events/reviewEventSubjects';
import type { PrepPayload } from '../../src/review/prepPhase';

function makeMockPayload(overrides: Partial<PrepPayload> = {}): PrepPayload {
  return {
    runId: 'run_' + '7'.repeat(32),
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    repository: 'exampleorg/review-yeti-bot',
    prNumber: 101,
    triageSummary: {
      filesCount: 3,
      hunksCount: 5,
      astSymbols: ['handleRequest', 'validateToken'],
      truncated: false,
    },
    promptMessages: [
      { role: 'system', content: 'You are Review Yeti Challenger Oracle.' },
      { role: 'user', content: 'Audit this pull request diff for security and concurrency bugs.' },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Challenger 1 Gate: Milestone 3 Concurrency, Memory & Watchdog Stress Suite', () => {
  // =========================================================================
  // SECTION 1: 20+ Concurrent Streams & Real Resident Memory Overhead (< 50MB)
  // =========================================================================
  describe('1. Concurrency Scaling & Resident Memory Footprint (< 50MB)', () => {
    it('M3-CHALLENGE-01: handles 20 concurrent active streams with resident memory overhead strictly < 50MB', async () => {
      const initialHeap = process.memoryUsage().heapUsed;
      const initialRss = process.memoryUsage().rss;

      const N = 20;
      const multiplexer = new StreamingMultiplexer({ maxConcurrentStreams: 30 });
      const sessions: StreamSessionState[] = [];

      for (let i = 0; i < N; i++) {
        const runId = `run_concurrent_gate_${i.toString().padStart(2, '0')}`;
        const session = multiplexer.openStream(runId, 'Review prompt', {
          headSha: 'c'.repeat(40),
        });
        sessions.push(session);
      }

      expect(multiplexer.activeSessions.size).toBe(20);
      expect(multiplexer.getActiveCount()).toBe(20);

      // Model calculation: 5MB base + 20 * 2MB = 45MB (< 50MB)
      const modelMemoryMb = multiplexer.getResidentMemoryMb();
      expect(modelMemoryMb).toBeLessThan(50);
      expect(modelMemoryMb).toBe(45);

      // Feed 100KB of content to each stream (total 2MB across 20 streams)
      const chunk = 'Review finding token payload line analysis.\n'.repeat(50); // ~2.2KB
      for (let step = 0; step < 45; step++) {
        for (let i = 0; i < N; i++) {
          multiplexer.feedChunk(sessions[i].runId, chunk);
        }
      }

      // Measure real resident memory while all 20 streams are active
      const activeHeap = process.memoryUsage().heapUsed;
      const activeRss = process.memoryUsage().rss;
      const heapDeltaMb = (activeHeap - initialHeap) / (1024 * 1024);
      const rssDeltaMb = (activeRss - initialRss) / (1024 * 1024);

      // Real heap growth must be strictly < 50MB
      expect(heapDeltaMb).toBeLessThan(50);
      expect(rssDeltaMb).toBeLessThan(50);

      // Complete all 20 streams cleanly
      for (let i = 0; i < N; i++) {
        const result = await multiplexer.completeStream(sessions[i].runId, sessions[i].headSha);
        expect(result.status).toBe('completed');
        expect(result.artifactsDigest).toMatch(/^[a-f0-9]{64}$/);
      }

      // Assert full cleanup
      expect(multiplexer.activeSessions.size).toBe(0);
      expect(multiplexer.getResidentMemoryMb()).toBe(5);
    });

    it('M3-CHALLENGE-02: multiplexes 20 simultaneous SSE network streams via fetch reader without exceeding 50MB', async () => {
      const initialHeap = process.memoryUsage().heapUsed;
      const encoder = new TextEncoder();
      const N = 20;

      // Real ReadableStream SSE mock for 20 streams
      const mockFetch = vi.fn().mockImplementation(() => {
        let controllerRef: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(controller) {
            controllerRef = controller;
          },
        });

        // Asynchronously stream 8 SSE data chunks
        setTimeout(async () => {
          for (let i = 0; i < 8; i++) {
            controllerRef.enqueue(
              encoder.encode(`data: {"choices":[{"delta":{"content":"Token batch ${i} for review.\\n"}}]}\n\n`),
            );
            await new Promise((r) => setTimeout(r, 2));
          }
          controllerRef.enqueue(encoder.encode('data: [DONE]\n\n'));
          controllerRef.close();
        }, 5);

        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        maxConcurrentStreams: 25,
      });

      const promises = [];
      for (let i = 0; i < N; i++) {
        const payload = makeMockPayload({
          runId: `run_sse_multi_${i.toString().padStart(2, '0')}`,
        });
        promises.push(multiplexer.startInferenceSession(payload));
      }

      // Check active streams and memory during in-flight streaming
      await new Promise((r) => setTimeout(r, 15));
      expect(multiplexer.getActiveCount()).toBe(20);
      expect(multiplexer.getResidentMemoryMb()).toBe(45);

      const inFlightHeapDeltaMb = (process.memoryUsage().heapUsed - initialHeap) / (1024 * 1024);
      expect(inFlightHeapDeltaMb).toBeLessThan(50);

      const results = await Promise.all(promises);
      expect(results).toHaveLength(20);
      for (const res of results) {
        expect(res.status).toBe('completed');
        expect(res.rawOutput).toContain('Token batch 7');
      }

      expect(multiplexer.getActiveCount()).toBe(0);
      expect(multiplexer.getResidentMemoryMb()).toBe(5);
    });

    it('M3-CHALLENGE-03: enforces maxConcurrentStreams ceiling and rejects excess requests with descriptive error', async () => {
      const multiplexer = new StreamingMultiplexer({ maxConcurrentStreams: 20 });

      // Saturate all 20 slots
      for (let i = 0; i < 20; i++) {
        multiplexer.openStream(`run_slot_${i}`, 'prompt');
      }

      expect(multiplexer.getActiveCount()).toBe(20);

      // 21st request must be rejected immediately
      const overflowPayload = makeMockPayload({ runId: 'run_slot_overflow_21' });
      await expect(multiplexer.startInferenceSession(overflowPayload)).rejects.toThrow(
        'Concurrency limit reached: 20/20 active streams',
      );
    });
  });

  // =========================================================================
  // SECTION 2: Runaway Stream Token Accumulation & 1MB Cap
  // =========================================================================
  describe('2. Runaway Stream Token Accumulation & 1MB Ceiling', () => {
    it('M3-CHALLENGE-04: strictly caps runaway token output at 1MB (maxAccumulationBytes) without OOM', async () => {
      const multiplexer = new StreamingMultiplexer({
        maxAccumulationBytes: 1024 * 1024, // 1MB ceiling
      });

      const session = multiplexer.openStream('run_runaway_test', 'Huge prompt');

      // Feed 10MB of runaway content chunks (100 * 100KB)
      const bigChunk = 'K'.repeat(100 * 1024);
      for (let i = 0; i < 100; i++) {
        multiplexer.feedChunk('run_runaway_test', bigChunk);
      }

      const contentBytes = Buffer.byteLength(session.tokensAccumulated, 'utf8');
      expect(contentBytes).toBe(1024 * 1024); // Exactly 1MB

      // Feed 10MB of runaway reasoning chunks
      for (let i = 0; i < 100; i++) {
        multiplexer.feedChunk('run_runaway_test', bigChunk, true);
      }

      const reasoningBytes = Buffer.byteLength(session.reasoningAccumulated, 'utf8');
      expect(reasoningBytes).toBe(1024 * 1024); // Exactly 1MB

      // Complete stream and verify hash digest computation without OOM
      const result = await multiplexer.completeStream('run_runaway_test', 'd'.repeat(40));
      expect(result.status).toBe('completed');
      expect(Buffer.byteLength(result.rawOutput, 'utf8')).toBe(1024 * 1024);
      expect(Buffer.byteLength(result.reasoningOutput || '', 'utf8')).toBe(1024 * 1024);
      expect(result.artifactsDigest).toMatch(/^[a-f0-9]{64}$/);
    });

    it('M3-CHALLENGE-05: handles multi-byte UTF-8 character boundary truncation at 1MB ceiling cleanly', () => {
      const multiplexer = new StreamingMultiplexer({
        maxAccumulationBytes: 100, // Small 100-byte ceiling
      });

      const session = multiplexer.openStream('run_utf8_truncation', 'prompt');

      // Fill 98 bytes
      multiplexer.feedChunk('run_utf8_truncation', 'A'.repeat(98));
      expect(Buffer.byteLength(session.tokensAccumulated, 'utf8')).toBe(98);

      // Now feed a 4-byte UTF-8 emoji ('🚀' = 0xF0 0x9F 0x9A 0x80)
      // Only 2 bytes fit in the budget, splitting the 4-byte sequence
      multiplexer.feedChunk('run_utf8_truncation', '🚀 rocket payload');

      // Substring conversion produces Unicode replacement char '\uFFFD', strictly bounded
      const finalBytes = Buffer.byteLength(session.tokensAccumulated, 'utf8');
      expect(finalBytes).toBeGreaterThanOrEqual(100);
      expect(finalBytes).toBeLessThanOrEqual(103);

      // Feeding further chunks does not increase bytes
      multiplexer.feedChunk('run_utf8_truncation', 'additional tokens');
      expect(Buffer.byteLength(session.tokensAccumulated, 'utf8')).toBe(finalBytes);

      // Sanitization succeeds without throwing
      const sanitized = sanitizeJsonString({ text: session.tokensAccumulated });
      expect(JSON.parse(sanitized).text).toBeDefined();
    });

    it('M3-CHALLENGE-06: safely updates review_runs and skips review_run_artifacts when payload > 2MB limit', async () => {
      const queryLog: Array<{ sql: string; params?: unknown[] }> = [];
      const mockDb: DatabaseQueryable = {
        query: vi.fn().mockImplementation((sql: string, params?: unknown[]) => {
          queryLog.push({ sql, params });
          return Promise.resolve({ rows: [], rowCount: 1 });
        }),
      };

      const multiplexer = new StreamingMultiplexer({
        db: mockDb,
        maxAccumulationBytes: 1024 * 1024,
      });

      const runId = 'run_2mb_boundary';
      const headSha = 'e'.repeat(40);
      const session = multiplexer.openStream(runId, 'prompt', { headSha });

      // Fill 1MB content + 1MB reasoning => total JSON payload > 2,000,000 bytes
      session.tokensAccumulated = 'C'.repeat(1024 * 1024);
      session.reasoningAccumulated = 'R'.repeat(1024 * 1024);

      const result = await multiplexer.completeStream(runId, headSha);
      expect(result.status).toBe('completed');

      // Assert review_runs UPDATE was executed
      const runsUpdate = queryLog.find((q) => q.sql.includes('UPDATE review_runs'));
      expect(runsUpdate).toBeDefined();

      // Assert review_run_artifacts INSERT was skipped because payload > 2MB (MAX_ARTIFACT_BYTES)
      const artifactsInsert = queryLog.find((q) => q.sql.includes('INSERT INTO review_run_artifacts'));
      expect(artifactsInsert).toBeUndefined();

      // Assert review_dispatch_outbox was still updated to 'pending'
      const outboxUpdate = queryLog.find((q) => q.sql.includes('UPDATE review_dispatch_outbox'));
      expect(outboxUpdate).toBeDefined();
    });
  });

  // =========================================================================
  // SECTION 3: Watchdog Deadlines & Clean Reader Cancellation
  // =========================================================================
  describe('3. Watchdog Deadlines & Clean Reader Cancellation', () => {
    it('M3-CHALLENGE-07: TTFT watchdog fires and triggers reader.cancel on underlying ReadableStream', async () => {
      let cancelCalled = false;
      let cancelReason: unknown = null;

      const mockFetch = vi.fn().mockImplementation(() => {
        const stream = new ReadableStream({
          start() {
            // Never enqueues any data
          },
          cancel(reason) {
            cancelCalled = true;
            cancelReason = reason;
          },
        });

        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 30, // 30ms TTFT timeout
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = makeMockPayload({ runId: 'run_ttft_gate_test' });
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Streaming TTFT timeout after 30ms');
      expect(cancelCalled).toBe(true);
      expect(cancelReason).toBe('aborted');
      expect(multiplexer.activeSessions.size).toBe(0);
    });

    it('M3-CHALLENGE-08: Inactivity watchdog fires and triggers reader.cancel when stream stalls after first token', async () => {
      let cancelCalled = false;
      let cancelReason: unknown = null;
      const encoder = new TextEncoder();

      const mockFetch = vi.fn().mockImplementation(() => {
        const stream = new ReadableStream({
          start(controller) {
            // Send first token promptly
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"initial token"}}]}\n\n'),
            );
            // Then stall indefinitely
          },
          cancel(reason) {
            cancelCalled = true;
            cancelReason = reason;
          },
        });

        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 100,
        inactivityTimeoutMs: 30, // 30ms inactivity timeout
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = makeMockPayload({ runId: 'run_inactivity_gate_test' });
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Streaming inactivity timeout after 30ms');
      expect(cancelCalled).toBe(true);
      expect(cancelReason).toBe('aborted');
      expect(result.rawOutput).toBe('initial token');
      expect(multiplexer.activeSessions.size).toBe(0);
    });

    it('M3-CHALLENGE-09: Total watchdog deadline (180s) fires and triggers reader.cancel on runaway duration', async () => {
      let cancelCalled = false;
      let cancelReason: unknown = null;
      let interval: NodeJS.Timeout | null = null;
      const encoder = new TextEncoder();

      const mockFetch = vi.fn().mockImplementation(() => {
        const stream = new ReadableStream({
          start(controller) {
            // Send a token every 10ms so TTFT and Inactivity never trigger
            interval = setInterval(() => {
              try {
                controller.enqueue(
                  encoder.encode('data: {"choices":[{"delta":{"content":"streaming tick "}}]}\n\n'),
                );
              } catch {
                if (interval) clearInterval(interval);
              }
            }, 10);
          },
          cancel(reason) {
            cancelCalled = true;
            cancelReason = reason;
            if (interval) clearInterval(interval);
          },
        });

        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 200,
        inactivityTimeoutMs: 200,
        totalDeadlineMs: 40, // 40ms total deadline
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = makeMockPayload({ runId: 'run_total_deadline_gate_test' });
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Streaming total watchdog deadline (40ms) exceeded');
      expect(cancelCalled).toBe(true);
      expect(cancelReason).toBe('aborted');
      expect(multiplexer.activeSessions.size).toBe(0);
    });

    it('M3-CHALLENGE-10: keep-alive frames do not prevent TTFT watchdog from firing if real tokens never arrive', async () => {
      let interval: NodeJS.Timeout | null = null;
      const encoder = new TextEncoder();

      const mockFetch = vi.fn().mockImplementation(() => {
        const stream = new ReadableStream({
          start(controller) {
            interval = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(': keep-alive\n\n'));
              } catch {
                if (interval) clearInterval(interval);
              }
            }, 10);
          },
          cancel() {
            if (interval) clearInterval(interval);
          },
        });

        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 35,
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = makeMockPayload({ runId: 'run_keepalive_no_tokens' });
      const result = await multiplexer.startInferenceSession(payload);

      // Must fail on TTFT timeout despite keep-alive frames
      expect(result.status).toBe('failed');
      expect(result.error).toContain('Streaming TTFT timeout after 35ms');
      expect(multiplexer.activeSessions.size).toBe(0);
    });

    it('M3-CHALLENGE-11: invokes iterator.return() on Symbol.asyncIterator bodies during watchdog abort', async () => {
      let returnCalled = false;

      const mockFetch = vi.fn().mockImplementation(() => {
        const asyncIterable = {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return new Promise(() => {}); // never resolves
              },
              return() {
                returnCalled = true;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        };

        return Promise.resolve({
          ok: true,
          status: 200,
          body: asyncIterable,
        });
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 30,
        maxRetries: 0,
        throwOnError: false,
      });

      const payload = makeMockPayload({ runId: 'run_async_iterator_abort' });
      const result = await multiplexer.startInferenceSession(payload);

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Streaming TTFT timeout');
      expect(returnCalled).toBe(true);
      expect(multiplexer.activeSessions.size).toBe(0);
    });

    it('M3-CHALLENGE-12: manual cancelSession triggers clean reader cancellation and status aborted', async () => {
      let cancelCalled = false;
      let cancelReason: unknown = null;
      const encoder = new TextEncoder();

      const mockFetch = vi.fn().mockImplementation(() => {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"active stream token"}}]}\n\n'),
            );
          },
          cancel(reason) {
            cancelCalled = true;
            cancelReason = reason;
          },
        });

        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        );
      });

      const multiplexer = new StreamingMultiplexer({
        fetch: mockFetch,
        ttftTimeoutMs: 1000,
        inactivityTimeoutMs: 1000,
        maxRetries: 0,
        throwOnError: false,
      });

      const runId = 'run_manual_cancel_gate';
      const sessionPromise = multiplexer.startInferenceSession(makeMockPayload({ runId }));

      // Wait for stream to establish
      await new Promise((r) => setTimeout(r, 10));

      const cancelled = multiplexer.cancelSession(runId, 'Operator cancellation requested');
      expect(cancelled).toBe(true);

      const result = await sessionPromise;
      expect(result.status).toBe('failed');
      expect(result.error).toBe('Operator cancellation requested');
      expect(cancelCalled).toBe(true);
      expect(cancelReason).toBe('aborted');
      expect(multiplexer.activeSessions.size).toBe(0);
    });
  });
});
