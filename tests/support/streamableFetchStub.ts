// Streaming is unconditional on the real review path (operator directive: "streaming MUST be
// true. It is not a tunable, not a fallback, not a per-transport preference"). Every fetch mock
// handed to reviewWithModel/callOpenRouterChat must therefore answer the STREAM request, or the
// code fails closed with a streamed transport error for any test whose mock only implements
// `.json()`/`.text()`.
//
// `sseBody` wraps a single JSON chat-completion payload into a one-chunk SSE body so existing
// Put the JSON payload you would have returned from `.json()` into a `message.content` (or
// `choices[0].message`) shape and hand the result to `getReader`.

/** A ReadableStream-shaped single-chunk SSE body carrying one JSON chat-completion payload. */
export function sseBody(payload: Record<string, unknown>): { getReader: () => any } {
  const data = `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
  let sent = false;
  return {
    getReader: () => ({
      read: async () => {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: Buffer.from(data, 'utf-8') };
      },
      cancel: async () => {},
    }),
  };
}

/**
 * Builds a fetch stub that answers the streaming request directly (no fallback), returning a
 * single-chunk SSE body equivalent to the given JSON chat-completion payload. `text`/`json` are
 * still provided so HTTP-error branches and compatibility fixtures can inspect the payload.
 */
export function streamableChatFetch(payload: Record<string, unknown>, opts: { ok?: boolean; status?: number } = {}) {
  return {
    ok: opts.ok !== false,
    status: opts.status || 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
    body: opts.ok === false ? undefined : sseBody(payload),
  };
}
