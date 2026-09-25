import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GATEWAY_CACHE_KEY_HEADER,
  GATEWAY_CACHE_KEY_UNCACHED,
  GATEWAY_CACHE_NO_STORE_HEADER,
  GATEWAY_MCP_INCLUDE_TOOLS_HEADER,
  GATEWAY_POLICY_HEADERS,
  OpenRouterClient,
} from '../../src/gateway/openRouterClient';

// REL-1134: Review Yeti bypasses Bifrost's semantic response cache. The cache runs with a
// global default key, so without these headers a re-review could be answered from a cached
// completion. no-store means nothing is written. A dedicated bucket that is never written
// means a lookup can never hit.

const base = {
  model: 'pr-reviewer',
  messages: [{ role: 'user' as const, content: 'review this diff' }],
  timeoutMs: 5_000,
};

function sse() {
  return new Response(
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"pr-reviewer","choices":[{"index":0,"delta":{"content":"SHIP"}}]}\n\n'
      + 'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"pr-reviewer","choices":[{"index":0,"finish_reason":"stop","delta":{}}]}\n\n'
      + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function chatJson() {
  return new Response(JSON.stringify({
    id: 'c', object: 'chat.completion', created: 1, model: 'pr-reviewer', system_fingerprint: null,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'SHIP' } }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Every value the request carries for `name`, matched case-insensitively. */
function values(init: RequestInit | undefined, name: string): string[] {
  const raw = init?.headers;
  if (raw instanceof Headers) {
    const v = raw.get(name);
    return v === null ? [] : [v];
  }
  return Object.entries((raw || {}) as Record<string, string>)
    .filter(([k]) => k.toLowerCase() === name)
    .map(([, v]) => v);
}

const expected: Array<[string, string]> = [
  [GATEWAY_CACHE_KEY_HEADER, GATEWAY_CACHE_KEY_UNCACHED],
  [GATEWAY_CACHE_NO_STORE_HEADER, 'true'],
  [GATEWAY_MCP_INCLUDE_TOOLS_HEADER, ''],
];

describe('Review Yeti bypasses the gateway response cache (REL-1134)', () => {
  it('uses the documented Bifrost cache headers and a dedicated never-written bucket', () => {
    expect(GATEWAY_CACHE_KEY_HEADER).toBe('x-bf-cache-key');
    expect(GATEWAY_CACHE_NO_STORE_HEADER).toBe('x-bf-cache-no-store');
    // Must not be the gateway's default_cache_key ("default"), or lookups would hit shared entries.
    expect(GATEWAY_CACHE_KEY_UNCACHED).toBe('review-yeti-uncached');
    expect(GATEWAY_CACHE_KEY_UNCACHED).not.toBe('default');
    expect(Object.isFrozen(GATEWAY_POLICY_HEADERS)).toBe(true);
    expect(Object.entries(GATEWAY_POLICY_HEADERS).sort()).toEqual([...expected].sort());
  });

  it.each([true, false])('sends the opt-out on every completion (stream=%s)', async (stream) => {
    const fetchImplementation = vi.fn(async () => (stream ? sse() : chatJson()));
    const client = new OpenRouterClient({ apiKey: 'test-key', baseUrl: 'https://gw.test/v1', fetchImplementation });
    await expect(client.complete({ ...base, stream })).resolves.toMatchObject({ content: 'SHIP' });
    const init = (fetchImplementation.mock.calls[0] as unknown[])[1] as RequestInit;
    for (const [name, value] of expected) expect(values(init, name)).toEqual([value]);
  });

  it.each([true, false])('caller metadata cannot opt back into the cache (stream=%s)', async (stream) => {
    const fetchImplementation = vi.fn(async () => (stream ? sse() : chatJson()));
    const client = new OpenRouterClient({ apiKey: 'test-key', baseUrl: 'https://gw.test/v1', fetchImplementation });
    await client.complete({
      ...base,
      stream,
      metadata: { 'X-BF-Cache-Key': 'default', 'X-Bf-Cache-No-Store': 'false', 'x-ct-test': 'kept' },
    } as any);
    const init = (fetchImplementation.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(values(init, GATEWAY_CACHE_KEY_HEADER)).toEqual([GATEWAY_CACHE_KEY_UNCACHED]);
    expect(values(init, GATEWAY_CACHE_NO_STORE_HEADER)).toEqual(['true']);
    if (stream) expect((init.headers as Record<string, string>)['x-ct-test']).toBe('kept');
  });

  describe('on the wire', () => {
    let server: http.Server | undefined;
    afterEach(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    });

    it.each([true, false])('real fetch transmits the cache opt-out (stream=%s)', async (stream) => {
      const seen: Array<Record<string, string[]>> = [];
      server = http.createServer((req, res) => {
        const got: Record<string, string[]> = {};
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = req.rawHeaders[i].toLowerCase();
          (got[k] ||= []).push(req.rawHeaders[i + 1]);
        }
        seen.push(got);
        req.resume();
        req.on('end', async () => {
          const r = stream ? sse() : chatJson();
          res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'application/json' });
          res.end(await r.text());
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const client = new OpenRouterClient({ apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}/v1` });
      await expect(client.complete({ ...base, stream })).resolves.toMatchObject({ content: 'SHIP' });
      expect(seen).toHaveLength(1);
      for (const [name, value] of expected) expect(seen[0][name]).toEqual([value]);
    });
  });
});
