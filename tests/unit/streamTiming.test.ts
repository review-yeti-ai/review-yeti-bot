import { describe, expect, it } from 'vitest';

const { withStreamTiming, classifyChunkKind } = require('../../src/evaluation/streamTiming.js');

function sseChunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

/** A fetch stub that emits `parts` as separate stream writes, each after its own `delayMs`. */
function fakeStreamingFetch(parts: Array<{ text: string; delayMs: number }>, { ok = true, status = 200 } = {}) {
  return async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const part of parts) {
          if (part.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, part.delayMs));
          controller.enqueue(encoder.encode(part.text));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
  };
}

async function drain(response: Response): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe('classifyChunkKind', () => {
  it('classifies a reasoning delta, a content delta, and an empty/other delta', () => {
    expect(classifyChunkKind({ choices: [{ delta: { reasoning: 'thinking...' } }] })).toBe('reasoning');
    expect(classifyChunkKind({ choices: [{ delta: { reasoning_content: 'thinking...' } }] })).toBe('reasoning');
    expect(classifyChunkKind({ choices: [{ delta: { content: 'hello' } }] })).toBe('content');
    expect(classifyChunkKind({ choices: [{ delta: {} }] })).toBe('other');
    expect(classifyChunkKind({ choices: [{ delta: { role: 'assistant' } }] })).toBe('other');
  });
});

describe('withStreamTiming', () => {
  it('records firstChunkMs/firstChunkKind on the very first SSE chunk when it already carries content', async () => {
    const events: Array<{ type: string; elapsedMs: number; kind?: string }> = [];
    const fetchImpl = withStreamTiming(
      fakeStreamingFetch([{ text: sseChunk({ content: 'hi' }), delayMs: 5 }]),
      { onTiming: (event: any) => events.push(event) },
    );
    const response = await fetchImpl('https://openrouter.test/v1/chat/completions', { method: 'POST' });
    await drain(response);
    // Yield a tick so the fire-and-forget tap loop finishes classifying.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstChunk = events.find((event) => event.type === 'firstChunk');
    const firstContent = events.find((event) => event.type === 'firstContent');
    expect(firstChunk).toMatchObject({ kind: 'content' });
    expect(firstContent).toBeTruthy();
    // Same wire chunk carried both events -- content arrived with the first byte.
    expect(firstContent!.elapsedMs).toBeCloseTo(firstChunk!.elapsedMs, -1);
  });

  it('separates TTFB from first-content when reasoning deltas precede content -- the whole point of this module', async () => {
    const events: Array<{ type: string; elapsedMs: number; kind?: string }> = [];
    const fetchImpl = withStreamTiming(
      fakeStreamingFetch([
        { text: sseChunk({ reasoning: 'thinking part 1' }), delayMs: 5 },
        { text: sseChunk({ reasoning: 'thinking part 2' }), delayMs: 20 },
        { text: sseChunk({ content: 'the answer' }), delayMs: 20 },
      ]),
      { onTiming: (event: any) => events.push(event) },
    );
    const response = await fetchImpl('https://openrouter.test/v1/chat/completions', { method: 'POST' });
    await drain(response);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const firstChunk = events.find((event) => event.type === 'firstChunk');
    const firstContent = events.find((event) => event.type === 'firstContent');
    expect(firstChunk).toMatchObject({ kind: 'reasoning' });
    expect(firstContent).toBeTruthy();
    // Content arrived strictly after the reasoning-only first chunk -- this gap is the reasoning
    // phase the operator asked to make visible.
    expect(firstContent!.elapsedMs).toBeGreaterThan(firstChunk!.elapsedMs);
  });

  it('never alters what the caller receives -- same bytes, same status, tap is read-only', async () => {
    const events: unknown[] = [];
    const parts = [
      { text: sseChunk({ reasoning: 'r' }), delayMs: 0 },
      { text: sseChunk({ content: 'hello world' }), delayMs: 0 },
    ];
    const fetchImpl = withStreamTiming(fakeStreamingFetch(parts), { onTiming: (event: unknown) => events.push(event) });
    const response = await fetchImpl('https://openrouter.test/v1/chat/completions', {});
    const body = await drain(response);
    expect(response.status).toBe(200);
    expect(body).toContain('hello world');
    expect(body).toContain('[DONE]');
  });

  it('passes non-ok responses through untouched without attempting to tap them', async () => {
    const fetchImpl = withStreamTiming(fakeStreamingFetch([], { ok: false, status: 500 }), { onTiming: () => { throw new Error('must not fire'); } });
    const response = await fetchImpl('https://openrouter.test/v1/chat/completions', {});
    expect(response.status).toBe(500);
  });

  it('a tap-side parse failure never surfaces to the caller or blocks the response', async () => {
    const fetchImpl = withStreamTiming(
      fakeStreamingFetch([{ text: 'data: {not json\n\n', delayMs: 0 }, { text: sseChunk({ content: 'ok' }), delayMs: 0 }]),
      { onTiming: () => { throw new Error('onTiming handler explodes'); } },
    );
    const response = await fetchImpl('https://openrouter.test/v1/chat/completions', {});
    await expect(drain(response)).resolves.toContain('ok');
  });
});
