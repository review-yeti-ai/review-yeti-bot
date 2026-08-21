// AttemptTrace construction inside `callOpenRouterChat` (ct-meta
// docs/plans/2026-08-20-review-yeti-telemetry.md, commit 5657f3df, PR #2096, design §4.1). Every
// attempt -- success or failure -- must return a frozen, schema-valid `attemptTrace` alongside
// the existing result. These tests drive the real streaming transport with synthetic SSE bodies
// (same mocking pattern as tests/unit/streamedChatPreflight.test.ts) rather than asserting against
// a hand-rolled trace object, so a regression in the actual stream reader is caught here.
import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const streamSummary = require(path.join(rootRepoDir, 'src/telemetry/streamSummary.js'));
const { callOpenRouterChat } = pipeline;
const { validateAttemptTrace } = streamSummary;

const url = 'https://openrouter.ai/api/v1/chat/completions';
const headers = { Authorization: 'Bearer test-key' };
const body = { model: 'test/model', messages: [{ role: 'user', content: 'hi' }] };

function sseLines(lines: string[], { hangAfter = false } = {}) {
  let index = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (index < lines.length) {
          const value = Buffer.from(lines[index], 'utf-8');
          index += 1;
          return { done: false, value };
        }
        if (hangAfter) return new Promise(() => {}); // never resolves
        return { done: true, value: undefined };
      },
      cancel: async () => {},
    }),
  };
}

function chunkLine(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe('AttemptTrace (design §4.1) on the real callOpenRouterChat streaming path', () => {
  it('a clean completed stream: done_marker, budget_exceeded=none, correct chunk_count/char splits/gap', async () => {
    let now = 1_000;
    const clockAdvances = [768, 500, 300, 200]; // headers, then 3 chunk arrivals
    const fetchImplementation = async () => ({
      ok: true,
      status: 200,
      body: sseLines([
        chunkLine({ id: 'gen-1', model: 'resolved/model', provider: 'fireworks', choices: [{ delta: { reasoning_content: 'thinking...' } }] }),
        chunkLine({ id: 'gen-1', model: 'resolved/model', provider: 'fireworks', choices: [{ delta: { content: 'answer' } }] }),
        'data: [DONE]\n\n',
      ]),
    });

    const result = await callOpenRouterChat(fetchImplementation, {
      url, headers, body, timeoutMs: 30_000, ttftMs: 30_000,
    });

    expect(result.ok).toBe(true);
    const trace = result.attemptTrace;
    expect(validateAttemptTrace(trace)).toEqual({ valid: true, errors: [] });
    expect(Object.isFrozen(trace)).toBe(true);
    expect(trace.stream_end_reason).toBe('done_marker');
    expect(trace.budget_exceeded).toBe('none');
    expect(trace.first_chunk_kind).toBe('reasoning');
    expect(trace.chunk_count).toBe(2);
    expect(trace.reasoning_chars).toBe('thinking...'.length);
    expect(trace.content_chars).toBe('answer'.length);
    expect(trace.t_first_chunk_ms).not.toBeNull();
    expect(trace.t_first_content_ms).not.toBeNull();
    expect(trace.t_first_content_ms).toBeGreaterThanOrEqual(trace.t_first_chunk_ms);
    expect(trace.reasoning_ms).toBe(trace.t_first_content_ms - trace.t_first_chunk_ms);
  });

  it('reports max_inter_chunk_gap_ms as the largest gap, not the last one', async () => {
    // Three chunks with a deliberately large synthetic delay injected via a slow reader between
    // chunk 1 and chunk 2, then fast delivery for the rest -- the max must be the FIRST gap.
    let call = 0;
    const fetchImplementation = async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            call += 1;
            if (call === 1) return { done: false, value: Buffer.from(chunkLine({ choices: [{ delta: { content: 'a' } }] })) };
            if (call === 2) {
              await new Promise((resolve) => setTimeout(resolve, 60));
              return { done: false, value: Buffer.from(chunkLine({ choices: [{ delta: { content: 'b' } }] })) };
            }
            if (call === 3) return { done: false, value: Buffer.from('data: [DONE]\n\n') };
            return { done: true, value: undefined };
          },
          cancel: async () => {},
        }),
      },
    });

    const result = await callOpenRouterChat(fetchImplementation, { url, headers, body, timeoutMs: 30_000, ttftMs: 30_000 });
    expect(result.ok).toBe(true);
    const trace = result.attemptTrace;
    expect(trace.chunk_count).toBe(2);
    expect(trace.max_inter_chunk_gap_ms).toBeGreaterThanOrEqual(50);
    expect(trace.max_gap_at_ms).not.toBeNull();
  });

  it('a TTFT timeout (headers received, zero chunks) reports budget_exceeded=ttft, first_chunk_kind=none', async () => {
    const fetchImplementation = async () => ({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
    });

    const result = await callOpenRouterChat(fetchImplementation, { url, headers, body, timeoutMs: 30_000, ttftMs: 30 });
    expect(result.ok).toBe(false);
    expect(result.failureClass).toBe('ttft_timeout');
    const trace = result.attemptTrace;
    expect(validateAttemptTrace(trace)).toEqual({ valid: true, errors: [] });
    expect(trace.budget_exceeded).toBe('ttft');
    expect(trace.first_chunk_kind).toBe('none');
    expect(trace.chunk_count).toBe(0);
    expect(trace.t_first_chunk_ms).toBeNull();
    expect(trace.stream_end_reason).not.toBe('done_marker');
  });

  it('a stall timeout (chunk arrives, then silence) reports budget_exceeded=stall, chunk_count=1', async () => {
    const fetchImplementation = async () => ({
      ok: true,
      status: 200,
      body: sseLines([chunkLine({ choices: [{ delta: { content: 'partial' } }] })], { hangAfter: true }),
    });

    const result = await callOpenRouterChat(fetchImplementation, { url, headers, body, timeoutMs: 30_000, ttftMs: 30_000, stallMs: 30 });
    expect(result.ok).toBe(false);
    expect(result.timeoutPhase).toBe('stall');
    const trace = result.attemptTrace;
    expect(validateAttemptTrace(trace)).toEqual({ valid: true, errors: [] });
    expect(trace.budget_exceeded).toBe('stall');
    expect(trace.chunk_count).toBe(1);
    expect(trace.stream_end_reason).toBe('abort');
  });

  it('an HTTP error response reports stream_end_reason=http_error, budget_exceeded=none (never a fabricated timeout)', async () => {
    const fetchImplementation = async () => ({
      ok: false,
      status: 503,
      text: async () => '{"error":"unavailable"}',
    });

    const result = await callOpenRouterChat(fetchImplementation, { url, headers, body, timeoutMs: 30_000, ttftMs: 30_000 });
    expect(result.ok).toBe(false);
    const trace = result.attemptTrace;
    expect(validateAttemptTrace(trace)).toEqual({ valid: true, errors: [] });
    expect(trace.stream_end_reason).toBe('http_error');
    expect(trace.budget_exceeded).toBe('none');
    expect(trace.t_headers_ms).not.toBeNull();
  });

  it('a mid-stream provider error reports stream_end_reason=mid_stream_error', async () => {
    const fetchImplementation = async () => ({
      ok: true,
      status: 200,
      body: sseLines([chunkLine({ choices: [{ delta: { content: 'partial' } }] }), chunkLine({ error: { message: 'upstream broke' } })]),
    });

    const result = await callOpenRouterChat(fetchImplementation, { url, headers, body, timeoutMs: 30_000, ttftMs: 30_000 });
    expect(result.ok).toBe(false);
    const trace = result.attemptTrace;
    expect(validateAttemptTrace(trace)).toEqual({ valid: true, errors: [] });
    expect(trace.stream_end_reason).toBe('mid_stream_error');
    expect(trace.budget_exceeded).toBe('none');
  });

  it('a lane-deadline abort mid-stream reports budget_exceeded=lane_deadline (not total/stall), per the laneDeadlineSignal precedence rule', async () => {
    const laneDeadline = new AbortController();
    const fetchImplementation = async () => ({
      ok: true,
      status: 200,
      body: sseLines([chunkLine({ choices: [{ delta: { content: 'partial' } }] })], { hangAfter: true }),
    });

    // `laneDeadlineSignal` is classification-only (design/doc comment on callOpenRouterChat): the
    // actual abort mechanism is the generic `signal`, which in production is already a merge of
    // laneDeadline + outer cancellation by the time it reaches here. Reuse the same controller for
    // both so this test aborts the request AND supplies unambiguous lane-deadline evidence, exactly
    // like the merged `laneSignal` production callers build.
    const resultPromise = callOpenRouterChat(fetchImplementation, {
      url, headers, body, timeoutMs: 30_000, ttftMs: 30_000, stallMs: 200, signal: laneDeadline.signal, laneDeadlineSignal: laneDeadline.signal,
    });
    // Fire the lane deadline almost immediately -- well before the 200ms stall budget -- so the
    // precedence rule (laneDeadlineSignal checked FIRST) is what's actually being exercised.
    setTimeout(() => laneDeadline.abort(), 10);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.timeoutPhase).toBe('lane_deadline');
    const trace = result.attemptTrace;
    expect(validateAttemptTrace(trace)).toEqual({ valid: true, errors: [] });
    expect(trace.budget_exceeded).toBe('lane_deadline');
    expect(trace.stream_end_reason).toBe('abort');
  });

  it('a reader that closes without an explicit [DONE] marker reports stream_end_reason=reader_done, not a fabricated done_marker', async () => {
    const fetchImplementation = async () => ({
      ok: true,
      status: 200,
      body: sseLines([chunkLine({ choices: [{ delta: { content: 'ok' } }] })]), // no [DONE] line
    });

    const result = await callOpenRouterChat(fetchImplementation, { url, headers, body, timeoutMs: 30_000, ttftMs: 30_000 });
    expect(result.ok).toBe(true);
    const trace = result.attemptTrace;
    expect(validateAttemptTrace(trace)).toEqual({ valid: true, errors: [] });
    expect(trace.stream_end_reason).toBe('reader_done');
    expect(trace.budget_exceeded).toBe('none');
  });
});
