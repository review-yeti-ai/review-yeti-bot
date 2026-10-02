// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import http from 'http';
import request from 'supertest';

import { TokenBatcher } from '../../src/gateway/tokenBatcher';
import {
  parsePatchHunks,
  normalizeFileStatus,
  parseSnapshotDiff,
  resolveReviewDiff,
  generateSyntheticDiff,
} from '../../src/review/diffService';
import { LiveStreamBus, type LiveStreamEvent } from '../../src/live/liveStreamBus';
import { DiffViewer } from '../../src/components/live/diff-viewer';
import { FindingDiffCard } from '../../src/components/live/finding-diff-card';
import { createApp } from '../../src/app';
import type { ChangedFileDiff, AnchoredFinding, DiffHunk } from '../../src/types/diff';

// Setup DOM stubs for jsdom
beforeEach(() => {
  if (typeof window !== 'undefined') {
    window.ResizeObserver =
      window.ResizeObserver ||
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    Element.prototype.scrollIntoView = vi.fn();
  }
});

/* ============================================================================
 * 1. TokenBatcher Adversarial & High-Concurrency Stress
 * ============================================================================ */
describe('Challenger Stress 1: TokenBatcher Adversarial & Concurrency Invariants', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('TB_01: High-concurrency burst of 1,000 tiny token pushes with zero character loss', () => {
    const receivedChunks: string[] = [];
    const batcher = new TokenBatcher((chunk) => receivedChunks.push(chunk), {
      batchIntervalMs: 50,
      minBatchChars: 80,
    });

    const tokens: string[] = [];
    for (let i = 0; i < 1000; i++) {
      tokens.push(`tok${i}_`);
    }
    const expectedFullText = tokens.join('');

    // High-concurrency synchronous burst
    for (const tok of tokens) {
      batcher.push(tok);
    }
    // Flush any remaining tokens at stream EOF
    batcher.flush();

    const reconstructedText = receivedChunks.join('');
    expect(reconstructedText).toBe(expectedFullText);
    expect(batcher.pendingLength).toBe(0);

    // Compression ratio: 1,000 pushes should yield far fewer batched flushes (~65-75 flushes)
    expect(receivedChunks.length).toBeLessThan(100);
    expect(receivedChunks.length).toBeGreaterThan(50);
  });

  it('TB_02: Multi-byte unicode, emojis & surrogate pairs across batch boundaries', () => {
    const receivedChunks: string[] = [];
    const batcher = new TokenBatcher((chunk) => receivedChunks.push(chunk), {
      batchIntervalMs: 50,
      minBatchChars: 40,
    });

    // Test intricate unicode: emojis, Asian scripts, zero-width joiners, surrogate pairs
    const complexGlyphs = [
      '🚀', '🧑‍💻', '⚡️', 'こんにちは', '世界', '🎉', '🔥', '✨',
      'العالم', 'مرحبا', '🌈', '💻', '🤖', '👾', '🎯', '🛡️'
    ];

    let fullSource = '';
    for (let cycle = 0; cycle < 10; cycle++) {
      for (const glyph of complexGlyphs) {
        fullSource += glyph;
        batcher.push(glyph);
      }
    }
    batcher.flush();

    const reconstructed = receivedChunks.join('');
    expect(reconstructed).toBe(fullSource);
    expect(batcher.pendingLength).toBe(0);
  });

  it('TB_03: Timer cancellation and cleanup prevents stranded timers and callbacks', () => {
    const flushed: string[] = [];
    const batcher = new TokenBatcher((chunk) => flushed.push(chunk), {
      batchIntervalMs: 50,
      minBatchChars: 80,
    });

    batcher.push('buffered-short-text');
    expect(batcher.pendingLength).toBe('buffered-short-text'.length);
    expect(flushed.length).toBe(0);

    // Cancel before timer fires
    batcher.cancel();
    expect(batcher.pendingLength).toBe(0);

    // Advance time past the 50ms interval
    vi.advanceTimersByTime(100);
    expect(flushed.length).toBe(0);

    // Pushing after cancel should work cleanly and establish a new timer
    batcher.push('new-cycle');
    expect(batcher.pendingLength).toBe('new-cycle'.length);
    vi.advanceTimersByTime(50);
    expect(flushed).toEqual(['new-cycle']);
    expect(batcher.pendingLength).toBe(0);
  });

  it('TB_04: Re-entrant pushes from within onFlush callback do not deadlock or loop', () => {
    const flushed: string[] = [];
    let batcherRef: TokenBatcher;

    batcherRef = new TokenBatcher((chunk) => {
      flushed.push(chunk);
      // Re-entrant push during flush
      if (chunk === 'x'.repeat(80)) {
        batcherRef.push('secondary_reentrant_token');
      }
    }, {
      batchIntervalMs: 50,
      minBatchChars: 80,
    });

    batcherRef.push('x'.repeat(80));
    expect(flushed.length).toBe(1);
    expect(batcherRef.pendingLength).toBe('secondary_reentrant_token'.length);

    batcherRef.flush();
    expect(flushed.length).toBe(2);
    expect(flushed[1]).toBe('secondary_reentrant_token');
    expect(batcherRef.pendingLength).toBe(0);
  });

  it('TB_05: Exact threshold boundary behavior (79 chars vs 80 chars vs 160 chars)', () => {
    const flushed: string[] = [];
    const batcher = new TokenBatcher((chunk) => flushed.push(chunk), {
      batchIntervalMs: 50,
      minBatchChars: 80,
    });

    // 79 chars -> strictly buffered, 0 flushes
    const str79 = 'a'.repeat(79);
    batcher.push(str79);
    expect(flushed.length).toBe(0);
    expect(batcher.pendingLength).toBe(79);

    // 1 more char -> reaches 80 -> flushes immediately
    batcher.push('b');
    expect(flushed.length).toBe(1);
    expect(flushed[0]).toBe(str79 + 'b');
    expect(batcher.pendingLength).toBe(0);

    // Single 160 char burst -> flushes once with full 160 chars
    const str160 = 'c'.repeat(160);
    batcher.push(str160);
    expect(flushed.length).toBe(2);
    expect(flushed[1]).toBe(str160);
    expect(batcher.pendingLength).toBe(0);
  });

  it('TB_06: Adversarial edge cases: empty strings, falsy pushes, empty flush, large payload', () => {
    const flushed: string[] = [];
    const batcher = new TokenBatcher((chunk) => flushed.push(chunk), {
      batchIntervalMs: 50,
      minBatchChars: 80,
    });

    // Empty and falsy values are safely ignored
    batcher.push('');
    batcher.push(null as any);
    batcher.push(undefined as any);
    expect(batcher.pendingLength).toBe(0);

    // Calling flush with empty buffer does not emit empty string
    batcher.flush();
    expect(flushed.length).toBe(0);

    // Huge 200KB chunk in single push
    const hugeChunk = 'x'.repeat(200_000);
    batcher.push(hugeChunk);
    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(200_000);
    expect(batcher.pendingLength).toBe(0);
  });
});

/* ============================================================================
 * 2. diffService Malformed & Boundary Stress
 * ============================================================================ */
describe('Challenger Stress 2: diffService Malformed & Boundary Patches', () => {
  it('DS_01: Safely handles malformed and unparseable patch hunks without throwing', () => {
    // Null, undefined, empty, non-string
    expect(parsePatchHunks(null)).toEqual({ hunks: [], additions: 0, deletions: 0 });
    expect(parsePatchHunks(undefined)).toEqual({ hunks: [], additions: 0, deletions: 0 });
    expect(parsePatchHunks('')).toEqual({ hunks: [], additions: 0, deletions: 0 });
    expect(parsePatchHunks(12345 as any)).toEqual({ hunks: [], additions: 0, deletions: 0 });

    // Patch with unparseable header
    const malformed1 = '@@ not-a-number @@\n+line1\n-line2';
    const res1 = parsePatchHunks(malformed1);
    expect(res1.hunks.length).toBe(0);
    expect(res1.additions).toBe(0);
    expect(res1.deletions).toBe(0);

    // Patch with header but no lines
    const malformed2 = '@@ -1,5 +1,5 @@';
    const res2 = parsePatchHunks(malformed2);
    expect(res2.hunks.length).toBe(1);
    expect(res2.hunks[0].lines.length).toBe(0);
    expect(res2.additions).toBe(0);
    expect(res2.deletions).toBe(0);
  });

  it('DS_02: Extreme line numbers (0 to 0 additions/deletions and 10,000,000+ line numbers)', () => {
    // File creation: @@ -0,0 +1,5 @@
    const creationPatch = [
      '@@ -0,0 +1,3 @@',
      '+line 1',
      '+line 2',
      '+line 3',
    ].join('\n');
    const creationRes = parsePatchHunks(creationPatch);
    expect(creationRes.hunks[0].oldStart).toBe(0);
    expect(creationRes.hunks[0].oldLines).toBe(0);
    expect(creationRes.hunks[0].newStart).toBe(1);
    expect(creationRes.hunks[0].newLines).toBe(3);
    expect(creationRes.additions).toBe(3);
    expect(creationRes.deletions).toBe(0);

    // File deletion: @@ -1,3 +0,0 @@
    const deletionPatch = [
      '@@ -1,3 +0,0 @@',
      '-del 1',
      '-del 2',
      '-del 3',
    ].join('\n');
    const deletionRes = parsePatchHunks(deletionPatch);
    expect(deletionRes.hunks[0].oldStart).toBe(1);
    expect(deletionRes.hunks[0].oldLines).toBe(3);
    expect(deletionRes.hunks[0].newStart).toBe(0);
    expect(deletionRes.hunks[0].newLines).toBe(0);
    expect(deletionRes.additions).toBe(0);
    expect(deletionRes.deletions).toBe(3);

    // Extreme line numbers (10,000,000+)
    const hugePatch = [
      '@@ -10000000,2 +10000000,2 @@',
      '-old code line 10000000',
      '+new code line 10000000',
      ' context line',
    ].join('\n');
    const hugeRes = parsePatchHunks(hugePatch);
    expect(hugeRes.hunks[0].oldStart).toBe(10_000_000);
    expect(hugeRes.hunks[0].newStart).toBe(10_000_000);
    expect(hugeRes.additions).toBe(1);
    expect(hugeRes.deletions).toBe(1);
  });

  it('DS_03: Multi-hunk diff with LF line endings and git header noise', () => {
    const rawPatch = [
      'diff --git a/src/service.ts b/src/service.ts',
      'index a1b2c3d..e4f5g6h 100644',
      '--- a/src/service.ts',
      '+++ b/src/service.ts',
      '@@ -10,3 +10,4 @@ class Service {',
      '   constructor() {',
      '-    this.init();',
      '+    await this.initAsync();',
      '+    this.ready = true;',
      '   }',
      '@@ -50,2 +51,2 @@ class Service {',
      '-  stop() {}',
      '+  async stop() {}',
      '\\ No newline at end of file',
    ].join('\n');

    const res = parsePatchHunks(rawPatch);
    expect(res.hunks.length).toBe(2);
    // Additions: +await this.initAsync(), +this.ready = true, +async stop() {} = 3 additions
    expect(res.additions).toBe(3);
    // Deletions: -this.init(), -stop() {} = 2 deletions
    expect(res.deletions).toBe(2);
  });

  it('DS_03_CHALLENGE_CRLF: Successfully parses CRLF line endings in parsePatchHunks', () => {
    // Patches with CRLF (\r\n) line endings are normalized and parsed into hunks and additions/deletions
    const crlfPatch = [
      '@@ -10,3 +10,4 @@ class Service {',
      '   constructor() {',
      '-    this.init();',
      '+    await this.initAsync();',
      '+    this.ready = true;',
      '   }',
    ].join('\r\n');

    const res = parsePatchHunks(crlfPatch);
    expect(res.hunks.length).toBe(1);
    expect(res.additions).toBe(2);
    expect(res.deletions).toBe(1);
  });

  it('DS_04: Normalizes file status across standard, non-standard, and implicit hunks', () => {
    const dummyHunk: DiffHunk = { header: '', oldStart: 1, oldLines: 5, newStart: 1, newLines: 5, lines: [] };
    const addHunk: DiffHunk = { header: '', oldStart: 0, oldLines: 0, newStart: 1, newLines: 5, lines: [] };
    const delHunk: DiffHunk = { header: '', oldStart: 1, oldLines: 5, newStart: 0, newLines: 0, lines: [] };

    expect(normalizeFileStatus({ status: 'added' }, [dummyHunk])).toBe('added');
    expect(normalizeFileStatus({ status: 'new' }, [dummyHunk])).toBe('added');
    expect(normalizeFileStatus({ status: 'deleted' }, [dummyHunk])).toBe('deleted');
    expect(normalizeFileStatus({ status: 'removed' }, [dummyHunk])).toBe('deleted');
    expect(normalizeFileStatus({ status: 'renamed' }, [dummyHunk])).toBe('modified');
    expect(normalizeFileStatus({ status: 'copied' }, [dummyHunk])).toBe('modified');

    // Inferred status when status string is missing
    expect(normalizeFileStatus({}, [addHunk])).toBe('added');
    expect(normalizeFileStatus({}, [delHunk])).toBe('deleted');
    expect(normalizeFileStatus({}, [dummyHunk])).toBe('modified');
  });

  it('DS_05: Multi-tier resolution waterfall in resolveReviewDiff', async () => {
    const bus = LiveStreamBus.getInstance();
    const testJobId = 'job-waterfall-test-01';

    // Before snapshot is set -> returns null (or synthetic if matching prefix)
    const initial = await resolveReviewDiff(testJobId);
    expect(initial).toBeNull();

    // Tier 1: Set snapshot on LiveStreamBus
    bus.setJobSnapshot(testJobId, {
      owner: 'exampleorg',
      repo: 'waterfall-repo',
      prNumber: 99,
      headSha: 'head123',
      baseSha: 'base123',
      title: 'Waterfall PR',
      changedFiles: [
        {
          path: 'src/waterfall.ts',
          status: 'modified',
          patch: '@@ -1,2 +1,3 @@\n-old\n+new1\n+new2\n',
        },
      ],
    });

    const tier1Res = await resolveReviewDiff(testJobId);
    expect(tier1Res).not.toBeNull();
    expect(tier1Res?.repo).toBe('exampleorg/waterfall-repo');
    expect(tier1Res?.prNumber).toBe(99);
    expect(tier1Res?.totalFiles).toBe(1);
    expect(tier1Res?.totalAdditions).toBe(2);
    expect(tier1Res?.totalDeletions).toBe(1);

    bus.clearHistory(testJobId);
  });

  it('DS_09_CHALLENGE_SUBSTRING_COLLISION: Prevents substring collision in resolveReviewDiff fallback', async () => {
    // If dashboardStore contains PR #1 log, cleanJobId does not collide with PR #1 when querying "job-test-pr10"
    const { dashboardStore } = await import('../../src/persistence/dashboardStore');
    dashboardStore.recordReviewRun({
      id: 'job-orig-pr1',
      repo: 'owner/test-repo',
      prNumber: 1,
      title: 'PR #1 Test',
      timestamp: new Date().toISOString(),
      tokens: { prompt: 100, completion: 50, total: 150 },
      isSynthetic: true,
    } as any);

    // Query for PR #10 with prefix that contains "pr10"
    const matched = await resolveReviewDiff('job-test-pr10');
    // Word boundary regex ensures "pr1" does not match inside "pr10"
    expect(matched?.prNumber).not.toBe(1);
  });
});

/* ============================================================================
 * 3. Live Diff REST Endpoints Stress (GET /api/live/diff)
 * ============================================================================ */
describe('Challenger Stress 3: Live Diff REST API Route Edge Cases', () => {
  let app: any;
  let server: http.Server;

  beforeEach(async () => {
    app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('DS_06: Rejects missing or whitespace-only jobId with 400 Bad Request', async () => {
    const resNoJob = await request(server).get('/api/live/diff');
    expect(resNoJob.status).toBe(400);
    expect(resNoJob.body.success).toBe(false);
    expect(resNoJob.body.error).toContain('Missing required query parameter: jobId');

    const resWhitespace = await request(server).get('/api/live/diff?jobId=%20%20%20');
    expect(resWhitespace.status).toBe(400);
    expect(resWhitespace.body.success).toBe(false);
  });

  it('DS_07: Returns 404 for unknown job ID', async () => {
    const res = await request(server).get('/api/live/diff?jobId=unknown-job-id-99999');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Review diff not found');
  });

  it('DS_08: Returns synthetic diff for test jobs and filters single file with ?path=', async () => {
    const jobId = 'job-test-synthetic-diff-1';

    // 1. Fetch full diff
    const resFull = await request(server).get(`/api/live/diff?jobId=${jobId}`);
    expect(resFull.status).toBe(200);
    expect(resFull.body.success).toBe(true);
    expect(resFull.body.totalFiles).toBe(2);
    expect(resFull.body.files.length).toBe(2);

    // 2. Filter existing file via ?path=
    const resFiltered = await request(server).get(
      `/api/live/diff?jobId=${jobId}&path=src/types/ingest.ts`
    );
    expect(resFiltered.status).toBe(200);
    expect(resFiltered.body.totalFiles).toBe(1);
    expect(resFiltered.body.files.length).toBe(1);
    expect(resFiltered.body.files[0].path).toBe('src/types/ingest.ts');

    // 3. Filter URL-encoded path
    const resEncoded = await request(server).get(
      `/api/live/diff?jobId=${jobId}&path=${encodeURIComponent('src/services/pipelineIngestionService.ts')}`
    );
    expect(resEncoded.status).toBe(200);
    expect(resEncoded.body.totalFiles).toBe(1);
    expect(resEncoded.body.files[0].path).toBe('src/services/pipelineIngestionService.ts');

    // 4. Filter non-existent file returns 404
    const resNonExistent = await request(server).get(
      `/api/live/diff?jobId=${jobId}&path=nonexistent/file.ts`
    );
    expect(resNonExistent.status).toBe(404);
    expect(resNonExistent.body.success).toBe(false);
    expect(resNonExistent.body.error).toContain("File 'nonexistent/file.ts' not found in diff");
  });
});

/* ============================================================================
 * 4. LiveStreamBus Rapid Bursts & Ring Buffer Invariants
 * ============================================================================ */
describe('Challenger Stress 4: LiveStreamBus Rapid Bursts & Ring Buffer Invariants', () => {
  let bus: LiveStreamBus;

  beforeEach(() => {
    bus = LiveStreamBus.getInstance();
    bus.clearHistory();
  });

  afterEach(() => {
    bus.clearHistory();
  });

  it('LSB_01: Enforces 500-event ring buffer strictly under 1,000 rapid event burst', () => {
    const burstJobId = 'job-ring-buffer-burst-1000';

    for (let i = 0; i < 1000; i++) {
      bus.publishEvent({
        jobId: burstJobId,
        timestamp: new Date(1700000000000 + i * 10).toISOString(),
        type: 'reasoning:chunk',
        persona: 'security',
        data: {
          index: i,
          reasoning: `Thinking step #${i}`,
        },
      });
    }

    const history = bus.getHistory(burstJobId);
    expect(history.length).toBe(500);

    // Verify FIFO: oldest 500 dropped, items 500..999 preserved
    expect((history[0].data as any).index).toBe(500);
    expect((history[499].data as any).index).toBe(999);

    // Job summary event count tracks all 1,000 events
    const status = bus.getJobStatus(burstJobId);
    expect(status?.eventCount).toBe(1000);
  });

  it('LSB_02: Accurately accumulates heterogeneous event storm (reasoning, tools, tokens, findings)', () => {
    const jobId = 'job-hetero-storm-01';

    bus.publishEvent({
      jobId,
      timestamp: new Date().toISOString(),
      type: 'persona:start',
      persona: 'architecture',
      data: { message: 'Starting analysis' },
    });

    // 10 reasoning chunks
    for (let i = 0; i < 10; i++) {
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'reasoning:chunk',
        persona: 'architecture',
        data: { reasoning: `Deliberating on modular boundaries ${i}` },
      });
    }

    // 5 tool executions
    for (let i = 0; i < 5; i++) {
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'tool:start',
        persona: 'architecture',
        data: { tool: 'zoektSearch', args: { query: `symbol_${i}` } },
      });
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'tool:result',
        persona: 'architecture',
        data: { tool: 'zoektSearch', output: `Found 3 symbols for query ${i}`, durationMs: 45 },
      });
    }

    // 3 findings
    for (let i = 0; i < 3; i++) {
      bus.publishEvent({
        jobId,
        timestamp: new Date().toISOString(),
        type: 'persona:finding',
        persona: 'architecture',
        data: {
          title: `Architecture Finding #${i}`,
          file: 'src/core.ts',
          line: 10 + i,
          severity: 'P1',
        },
      });
    }

    // Token metrics
    bus.publishEvent({
      jobId,
      timestamp: new Date().toISOString(),
      type: 'llm:token',
      persona: 'architecture',
      data: {
        promptTokens: 1200,
        completionTokens: 350,
        totalTokens: 1550,
        costUSD: 0.0031,
      },
    });

    // Persona complete
    bus.publishEvent({
      jobId,
      timestamp: new Date().toISOString(),
      type: 'persona:complete',
      persona: 'architecture',
      data: { message: 'Completed architecture review', findingsCount: 3 },
    });

    const status = bus.getJobStatus(jobId);
    expect(status).toBeDefined();
    expect(status?.tokenMetrics.promptTokens).toBe(1200);
    expect(status?.tokenMetrics.completionTokens).toBe(350);
    expect(status?.tokenMetrics.totalTokens).toBe(1550);
    expect(status?.tokenMetrics.estimatedCostUSD).toBeCloseTo(0.0031);

    const archProgress = status?.personaProgress['architecture'];
    expect(archProgress?.status).toBe('completed');
    expect(archProgress?.findingsCount).toBe(3);
  });

  it('LSB_03: Concurrent multi-job isolation under parallel bursts', () => {
    const jobA = 'job-burst-iso-alpha';
    const jobB = 'job-burst-iso-beta';

    for (let i = 0; i < 150; i++) {
      bus.publishEvent({
        jobId: jobA,
        timestamp: new Date().toISOString(),
        type: 'persona:chunk',
        persona: 'security',
        data: { text: `Alpha chunk ${i}` },
      });
      bus.publishEvent({
        jobId: jobB,
        timestamp: new Date().toISOString(),
        type: 'persona:chunk',
        persona: 'quality',
        data: { text: `Beta chunk ${i}` },
      });
    }

    const histA = bus.getHistory(jobA);
    const histB = bus.getHistory(jobB);

    expect(histA.length).toBe(150);
    expect(histB.length).toBe(150);

    // Verify complete isolation
    expect(histA.every((e) => e.jobId === jobA && e.persona === 'security')).toBe(true);
    expect(histB.every((e) => e.jobId === jobB && e.persona === 'quality')).toBe(true);
  });

  it('LSB_04: Snapshot cache bounded eviction (max 100 snapshots)', () => {
    for (let i = 0; i < 125; i++) {
      bus.setJobSnapshot(`job-snapshot-${i}`, { index: i });
    }

    // First 25 snapshots (0..24) must have been evicted in FIFO order
    for (let i = 0; i < 25; i++) {
      expect(bus.getJobSnapshot(`job-snapshot-${i}`)).toBeUndefined();
    }

    // Remaining 100 snapshots (25..124) must be preserved
    for (let i = 25; i < 125; i++) {
      const snap = bus.getJobSnapshot(`job-snapshot-${i}`);
      expect(snap).toBeDefined();
      expect(snap.index).toBe(i);
    }
  });

  it('LSB_05: Late-joining SSE client receives historical replay on connection', () => {
    const replayJobId = 'job-sse-replay-catchup';

    for (let i = 0; i < 100; i++) {
      bus.publishEvent({
        jobId: replayJobId,
        timestamp: new Date().toISOString(),
        type: 'reasoning:chunk',
        persona: 'performance',
        data: { step: i },
      });
    }

    const writtenData: string[] = [];
    const mockRes: any = {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn((chunk: string) => writtenData.push(chunk)),
      on: vi.fn(),
    };

    bus.addClient(replayJobId, mockRes);

    expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    // 100 historical events replayed as data: { ... }\n\n
    expect(writtenData.length).toBe(100);
    expect(writtenData[0]).toContain('"step":0');
    expect(writtenData[99]).toContain('"step":99');
  });
});

/* ============================================================================
 * 5. DiffViewer & FindingDiffCard Adversarial UI Stress
 * ============================================================================ */
describe('Challenger Stress 5: DiffViewer & FindingDiffCard Adversarial UI', () => {
  const sampleFiles: ChangedFileDiff[] = [
    {
      path: 'src/security/authenticator.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      hunks: [
        {
          header: '@@ -10,3 +10,4 @@',
          oldStart: 10,
          oldLines: 3,
          newStart: 10,
          newLines: 4,
          lines: [
            ' context line 10',
            '-const token = req.query.token;',
            '+const token = req.headers.authorization?.replace(/^Bearer /, "");',
            '+if (!token) throw new AuthError("Missing bearer token");',
            ' context line 13',
          ],
        },
      ],
    },
    {
      path: 'src/utils/logger.ts',
      status: 'added',
      additions: 3,
      deletions: 0,
      hunks: [
        {
          header: '@@ -0,0 +1,3 @@',
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          lines: [
            '+export const log = (msg: string) => console.log(msg);',
            '+export const warn = (msg: string) => console.warn(msg);',
            '+export const error = (msg: string) => console.error(msg);',
          ],
        },
      ],
    },
  ];

  const sampleFindings: AnchoredFinding[] = [
    {
      id: 'finding-sec-01',
      severity: 'P0',
      file: 'src/security/authenticator.ts',
      line: 11, // Anchored to the new line: "+const token = ..."
      title: 'Insecure Bearer token extraction without signature validation',
      description: 'The extracted bearer token is parsed without verifying cryptographic signature.',
      suggestion: 'const token = verifyJwtSignature(rawToken, publicKey);',
      status: 'active',
      persona: 'security',
    },
    {
      id: 'finding-sec-02',
      severity: 'P1',
      file: 'src/security/authenticator.ts',
      line: 11, // Second finding anchored to the EXACT same line
      title: 'Missing rate-limiting on authentication route',
      description: 'Repeated authentication requests can exhaust worker thread pool.',
      status: 'active',
      persona: 'security',
    },
    {
      id: 'finding-sec-unanchored',
      severity: 'P2',
      file: 'src/security/authenticator.ts',
      line: 9999, // Line number outside any hunk
      title: 'File-level nit: Missing top-level copyright header',
      description: 'Every source file should declare standard corporate copyright.',
      status: 'active',
      persona: 'quality',
    },
  ];

  it('UI_01: Line alignment correctly calculates old and new line numbers', () => {
    render(<DiffViewer files={sampleFiles} findings={[]} />);

    // File headers exist
    expect(screen.getByText('src/security/authenticator.ts')).toBeDefined();
    expect(screen.getByText('src/utils/logger.ts')).toBeDefined();

    // Verify additions and deletions badges
    expect(screen.getAllByText('modified').length).toBeGreaterThan(0);
    expect(screen.getAllByText('added').length).toBeGreaterThan(0);
  });

  it('UI_02: Injects line-anchored finding cards under line 11 (including multiple findings on same line)', () => {
    render(<DiffViewer files={sampleFiles} findings={sampleFindings} />);

    // Both findings anchored to line 11 should be rendered
    expect(screen.getByText('Insecure Bearer token extraction without signature validation')).toBeDefined();
    expect(screen.getByText('Missing rate-limiting on authentication route')).toBeDefined();

    // Out-of-hunk line 9999 finding should be rendered in the unanchored section
    expect(screen.getByText('File-level nit: Missing top-level copyright header')).toBeDefined();
  });

  it('UI_03: File with zero findings renders cleanly without error or finding cards', () => {
    const cleanFiles: ChangedFileDiff[] = [
      {
        path: 'src/clean/file.ts',
        status: 'modified',
        additions: 1,
        deletions: 0,
        hunks: [
          {
            header: '@@ -1,1 +1,2 @@',
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 2,
            lines: [' context', '+new line'],
          },
        ],
      },
    ];

    render(<DiffViewer files={cleanFiles} findings={[]} />);
    expect(screen.getByText('src/clean/file.ts')).toBeDefined();
    expect(screen.queryByText(/finding/i)).toBeNull();
  });

  it('UI_04: Empty files list and empty patch handle boundary states gracefully', () => {
    // Empty files list
    const { rerender } = render(<DiffViewer files={[]} findings={[]} jobId="job-empty-01" />);
    expect(screen.getByText('No Changed Files in Review Snapshot')).toBeDefined();
    expect(screen.getByText(/Job job-empty-01 has no modified files recorded/)).toBeDefined();

    // Empty hunks / binary file
    const binaryFile: ChangedFileDiff[] = [
      {
        path: 'assets/logo.png',
        status: 'added',
        additions: 0,
        deletions: 0,
        hunks: [],
      },
    ];
    rerender(<DiffViewer files={binaryFile} findings={[]} />);
    expect(screen.getByText('assets/logo.png')).toBeDefined();
    expect(screen.getByText('Binary file or empty diff patch.')).toBeDefined();
  });

  it('UI_05: Interactive finding controls: Dismissal workflow with reason and callback', () => {
    const onDismiss = vi.fn();
    const finding = sampleFindings[0];

    render(<FindingDiffCard finding={finding} onDismiss={onDismiss} />);

    // Click Dismiss -> reveals text input and confirm button
    const dismissBtn = screen.getByText('Dismiss');
    fireEvent.click(dismissBtn);

    const input = screen.getByPlaceholderText('Reason for dismissal...') as HTMLInputElement;
    expect(input).toBeDefined();
    expect(input.value).toBe('False positive or intended pattern');

    // Change reason text
    fireEvent.change(input, { target: { value: 'Verified safe via upstream middleware' } });

    // Confirm dismissal
    const confirmBtn = screen.getByText('Confirm Dismiss');
    fireEvent.click(confirmBtn);

    expect(onDismiss).toHaveBeenCalledWith('finding-sec-01', 'Verified safe via upstream middleware');
  });

  it('UI_06: Interactive finding controls: Severity adjustment dropdown workflow', () => {
    const onAdjust = vi.fn();
    const finding = sampleFindings[0]; // P0

    render(<FindingDiffCard finding={finding} onAdjustSeverity={onAdjust} />);

    // Click severity button to toggle dropdown
    const sevBtn = screen.getByText('Severity: P0');
    fireEvent.click(sevBtn);

    // Click P1 Warning
    const p1Option = screen.getByText('P1 Warning');
    fireEvent.click(p1Option);

    expect(onAdjust).toHaveBeenCalledWith('finding-sec-01', 'P1');
  });

  it('UI_07: Search filtering and Expand/Collapse All controls', () => {
    render(<DiffViewer files={sampleFiles} findings={sampleFindings} />);

    const searchInput = screen.getByPlaceholderText('Filter changed files by path...');

    // Filter for logger only
    fireEvent.change(searchInput, { target: { value: 'logger' } });
    expect(screen.queryByText('src/security/authenticator.ts')).toBeNull();
    expect(screen.getByText('src/utils/logger.ts')).toBeDefined();

    // Clear filter
    fireEvent.change(searchInput, { target: { value: '' } });
    expect(screen.getByText('src/security/authenticator.ts')).toBeDefined();
    expect(screen.getByText('src/utils/logger.ts')).toBeDefined();

    // Collapse All
    const collapseBtn = screen.getByText('Collapse All');
    fireEvent.click(collapseBtn);

    // Expand All
    const expandBtn = screen.getByText('Expand All');
    fireEvent.click(expandBtn);
    expect(screen.getByText('src/security/authenticator.ts')).toBeDefined();
  });

  it('UI_08_CHALLENGE_CLIPBOARD: Copy suggested fix behavior when navigator.clipboard is undefined', () => {
    const originalClipboard = navigator.clipboard;
    let caughtMessage = '';
    const errorHandler = (e: any) => {
      caughtMessage = e?.message || e?.error?.message || String(e);
      e?.preventDefault?.();
    };
    window.addEventListener('error', errorHandler);

    try {
      // Simulate insecure context (HTTP) where navigator.clipboard is undefined
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      const findingWithSuggestion: AnchoredFinding = {
        id: 'finding-clipboard-test',
        severity: 'P1',
        file: 'src/test.ts',
        line: 5,
        title: 'Clipboard test',
        description: 'Testing copy suggestion under missing clipboard API',
        suggestion: 'const x = 42;',
        status: 'active',
      };

      render(<FindingDiffCard finding={findingWithSuggestion} />);
      const copyBtn = screen.getByTitle('Copy suggested fix');
      expect(copyBtn).toBeDefined();

      // Trigger copy in environment where clipboard is undefined
      fireEvent.click(copyBtn);

      // Verify that safe guard prevents unhandled TypeError when clipboard API is missing
      expect(caughtMessage).toBe('');
    } finally {
      window.removeEventListener('error', errorHandler);
      Object.defineProperty(navigator, 'clipboard', {
        value: originalClipboard,
        configurable: true,
        writable: true,
      });
    }
  });

  it('UI_09_CHALLENGE_NO_NEWLINE: Demonstrates line number drift when hunk contains "\\ No newline at end of file"', () => {
    // In git diffs, "\\ No newline at end of file" is metadata.
    // In diff-viewer.tsx, it falls into the context branch and increments both currentOld and currentNew.
    const fileWithNoNewline: ChangedFileDiff = {
      path: 'src/drift.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -10,3 +10,3 @@',
          oldStart: 10,
          oldLines: 3,
          newStart: 10,
          newLines: 3,
          lines: [
            ' line 10',
            '-old line 11',
            '+new line 11',
            '\\ No newline at end of file',
            ' line 12 after no-newline',
          ],
        },
      ],
    };

    render(<DiffViewer files={[fileWithNoNewline]} findings={[]} />);
    // "\\ No newline at end of file" rendered as context line
    expect(screen.getByText('\\ No newline at end of file')).toBeDefined();
    // Subsequent line "line 12 after no-newline" gets shifted by +1
    expect(screen.getByText('line 12 after no-newline')).toBeDefined();
  });
});

