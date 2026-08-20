// API-2902: the streamed-completion smoke. The pre-existing chat preflight sent `stream: false`
// and only checked HTTP 200 -- invisible to an SSE stream-termination regression. This is the
// exact bug class that shipped 2026-08-19: persona lanes streamed tokens from Fireworks (billed),
// never saw the [DONE] marker, and hung to the lane deadline while the old preflight kept
// reporting "healthy http=200". `runStreamedChatPreflight` performs one real streamed completion
// through the SAME `callOpenRouterChat` path the persona lanes use and requires it to actually
// terminate within budget.
import { describe, expect, it } from 'vitest';
import path from 'path';
import fs from 'fs';

const rootRepoDir = fs.existsSync(path.join(path.resolve(__dirname, '../..'), '.github/workflows/pipelines/review-pipeline.js'))
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '../../..');
const pipeline = require(path.join(rootRepoDir, '.github/workflows/pipelines/review-pipeline.js'));
const { runStreamedChatPreflight } = pipeline;

const preflightTarget = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  model: 'test/model',
  label: 'llm-api-key',
};

function completedStreamResponse() {
  let readCount = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          readCount += 1;
          if (readCount === 1) {
            return {
              done: false,
              value: Buffer.from(`data: ${JSON.stringify({
                id: 'gen-ok',
                model: 'test/model',
                provider: 'ExampleCloud',
                choices: [{ delta: { content: 'ok' } }],
              })}\n\n`),
            };
          }
          if (readCount === 2) return { done: false, value: Buffer.from('data: [DONE]\n\n') };
          return { done: true, value: undefined };
        },
        cancel: async () => {},
      }),
    },
  };
}

// The exact incident shape: the provider streams a real token (billed) and then never sends
// [DONE] and never closes the socket -- the stream just hangs until something else gives up.
function chunkThenHangsForeverStreamResponse() {
  let sentChunk = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (!sentChunk) {
            sentChunk = true;
            return {
              done: false,
              value: Buffer.from(`data: ${JSON.stringify({
                id: 'gen-partial',
                model: 'test/model',
                provider: 'fireworks',
                choices: [{ delta: { content: 'o' } }],
              })}\n\n`),
            };
          }
          return new Promise(() => {}); // never resolves -- no [DONE], no close.
        },
        cancel: async () => {},
      }),
    },
  };
}

function neverChunkingStreamResponse() {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: async () => {},
      }),
    },
  };
}

describe('runStreamedChatPreflight (API-2902 streamed-completion smoke)', () => {
  it('reports ok when the stream actually reaches the [DONE] marker within budget', async () => {
    const outcome = await runStreamedChatPreflight(
      async () => completedStreamResponse(),
      preflightTarget,
      { timeoutMs: 5_000 },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.result.streamed).toBe(true);
  });

  it('reports stream_incomplete -- not a generic pass -- when the provider streams a token and then never sends the done marker (today\'s incident shape)', async () => {
    const outcome = await runStreamedChatPreflight(
      async () => chunkThenHangsForeverStreamResponse(),
      preflightTarget,
      { timeoutMs: 100 },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('stream_incomplete');
    expect(outcome.result.streamed).toBe(true);
    expect(outcome.result.partial).toBe(true);
  });

  it('reports a distinct non-stream_incomplete reason when no chunk ever arrives (a connect-shaped failure, not a mid-stream hang)', async () => {
    // `stream_incomplete` means chunks were received (tokens billed) but the completion never
    // terminated -- the exact incident shape. A provider that never answers at all is a
    // different, already-well-understood failure mode (connect/TTFT); it must not be folded into
    // the same reason, or on-call loses the distinction the whole hardening item exists for.
    const outcome = await runStreamedChatPreflight(
      async () => neverChunkingStreamResponse(),
      preflightTarget,
      { timeoutMs: 100 },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).not.toBe('stream_incomplete');
    expect(outcome.result.partial).not.toBe(true);
  });

  it('reports a distinct reason for a bare HTTP error on the streamed attempt', async () => {
    const outcome = await runStreamedChatPreflight(
      async () => ({ ok: false, status: 401, text: async () => '{"error":"unauthorized"}' }),
      preflightTarget,
      { timeoutMs: 5_000 },
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).not.toBe('stream_incomplete');
  });
});
