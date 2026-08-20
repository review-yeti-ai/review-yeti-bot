'use strict';

/**
 * streamTiming.js
 *
 * Read-only SSE timing tap for the testing-charter eval harness (REL: operator ask, 2026-08-19
 * "make the latency/accuracy tradeoff measurable"). Production's stream reader
 * (.github/workflows/pipelines/review-pipeline.js's `callOpenRouterChat`) already measures
 * TTFT -- time to the FIRST parsed SSE chunk, of any kind -- and classifies that one chunk as
 * `firstChunkKind: 'reasoning' | 'content' | 'other'` (added #127). What it does not measure,
 * and what this module exists for, is time-to-FIRST-CONTENT: on a reasoning-heavy call the first
 * chunk is very often a `reasoning`/`reasoning_content`/`thinking` delta, and the model can spend
 * many seconds to tens of seconds reasoning before the first `delta.content` byte arrives. TTFB
 * alone cannot see that gap; it is where nearly all wall-clock time goes on a high-effort call.
 *
 * `callOpenRouterChat`'s own `onStreamProgress` hook only fires once, on the first chunk -- it
 * has no callback for "content started". Adding one would mean editing that file's SSE loop,
 * which is the transport layer and is out of scope for this harness (see task boundaries). This
 * module gets the same measurement a different way: it wraps the `fetchImplementation` the eval
 * harness already injects, tees the response body with `ReadableStream.tee()`, and reads its own
 * branch independently. The pipeline's branch is returned completely untouched -- same bytes,
 * same timing, same everything -- so a bug or slow consumer in this tap can never change what
 * production code sees or how fast it sees it. That is the whole design constraint: observe,
 * never participate.
 *
 * The SSE line-parsing and reasoning-field detection below intentionally mirrors
 * `REASONING_DELTA_FIELDS`/`reasoningDeltaField` in review-pipeline.js (not exported, so this is
 * a deliberate small duplication of a already-public wire-format check, not a second
 * implementation of parsing/timeout/retry behavior that could drift and matter).
 */

// Mirrors review-pipeline.js's REASONING_DELTA_FIELDS. Empirically verified against live
// providers (2026-08-19 reasoning-stall investigation): Fireworks/DeepSeek-native stream
// `reasoning_content`, OpenRouter streams `reasoning` (+ `reasoning_details[]`), Ollama-compatible
// APIs use `thinking` by convention.
const REASONING_DELTA_FIELDS = ['reasoning_content', 'reasoning', 'thinking'];

function reasoningDeltaField(delta) {
  if (!delta || typeof delta !== 'object') return null;
  for (const field of REASONING_DELTA_FIELDS) {
    const value = delta[field];
    if (typeof value === 'string' && value.length > 0) return field;
  }
  return null;
}

/** 'reasoning' | 'content' | 'other', matching production's firstChunkKind classification exactly. */
function classifyChunkKind(chunk) {
  const delta = chunk?.choices?.[0]?.delta || {};
  if (reasoningDeltaField(delta)) return 'reasoning';
  if (typeof delta.content === 'string' && delta.content.length > 0) return 'content';
  return 'other';
}

/**
 * Wraps a fetch implementation so every call it makes is timed for TTFT (`firstChunk`) and
 * time-to-first-content (`firstContent`). Non-streaming or non-ok responses pass through
 * unmodified (nothing to tap). `onTiming` is called at most once per event type per HTTP call,
 * with `{ type: 'firstChunk', elapsedMs, kind }` or
 * `{ type: 'firstContent', elapsedMs, reasoningChars, reasoningChunks }`.
 *
 * `reasoningChars`/`reasoningChunks` (added for the cap/reasoning-budget ablations, REL: operator
 * ask 2026-08-20 "reasoning-token count is not measurable") accumulate the character length and
 * chunk count of every `reasoning`-kind delta seen strictly BEFORE the first `content` chunk --
 * i.e. the up-front reasoning phase this module's own doc comment already describes ("the model
 * can spend many seconds to tens of seconds reasoning before the first delta.content byte
 * arrives"). This is a character-length proxy, not a provider-reported token count: no transport
 * in this codebase surfaces `completion_tokens_details.reasoning_tokens` or equivalent (checked
 * review-pipeline.js's usage accounting -- promptTokens/completionTokens/totalTokens/costUSD
 * only), so an operator reading `reasoningChars` must apply their own chars-per-token estimate
 * and treat it as approximate. Reasoning that continues interleaved AFTER content starts (rare on
 * observed providers, which front-load reasoning) is not counted -- the tap still stops at
 * first-content, unchanged from before this addition.
 *
 * Never throws on tap failure -- a parse error or unexpected chunk shape in the observer branch
 * must never surface as a request failure the pipeline (or its retry/failover logic) can see.
 */
function withStreamTiming(fetchImpl, { onTiming } = {}) {
  return async function timedFetch(input, init) {
    const startedAt = Date.now();
    const response = await fetchImpl(input, init);
    if (!response || !response.ok || !response.body || typeof response.body.tee !== 'function') {
      return response;
    }
    let passthrough;
    let tap;
    try {
      [passthrough, tap] = response.body.tee();
    } catch (_error) {
      // tee() can only fail if the body is already locked/disturbed -- nothing to tap.
      return response;
    }
    (async () => {
      const reader = tap.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawFirstChunk = false;
      let sawFirstContent = false;
      let reasoningChars = 0;
      let reasoningChunks = 0;
      try {
        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const lineEnd = buffer.indexOf('\n');
            if (lineEnd === -1) break;
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);
            if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
            const data = line.startsWith('data: ') ? line.slice(6).trim() : line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let chunk;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            const elapsedMs = Math.max(0, Date.now() - startedAt);
            const kind = classifyChunkKind(chunk);
            if (kind === 'reasoning') {
              const delta = chunk?.choices?.[0]?.delta || {};
              const field = reasoningDeltaField(delta);
              const rawValue = field ? delta[field] : '';
              const text = typeof rawValue === 'string'
                ? rawValue
                : (rawValue && typeof rawValue.text === 'string' ? rawValue.text : '');
              reasoningChars += text.length;
              reasoningChunks += 1;
            }
            if (!sawFirstChunk) {
              sawFirstChunk = true;
              onTiming?.({ type: 'firstChunk', elapsedMs, kind });
            }
            if (!sawFirstContent && kind === 'content') {
              sawFirstContent = true;
              onTiming?.({ type: 'firstContent', elapsedMs, reasoningChars, reasoningChunks });
            }
            if (sawFirstChunk && sawFirstContent) break readLoop;
          }
        }
      } catch (_error) {
        // Tap-only failure (aborted read, decode error). Never rethrow -- see doc comment.
      } finally {
        try { reader.releaseLock(); } catch (_) { /* already released */ }
        try { await tap.cancel(); } catch (_) { /* already cancelled/closed */ }
      }
    })();
    return new Response(passthrough, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

module.exports = { withStreamTiming, classifyChunkKind, reasoningDeltaField, REASONING_DELTA_FIELDS };
