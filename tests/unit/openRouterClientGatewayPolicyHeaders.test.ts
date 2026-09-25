import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GATEWAY_MCP_INCLUDE_TOOLS_HEADER,
  GATEWAY_POLICY_HEADERS,
  OpenRouterClient,
} from '../../src/gateway/openRouterClient';

// Gateway request-policy headers pinned on every model call.
// - x-bf-mcp-include-tools: '' is pinned on both paths and caller metadata cannot override it.
// - REL-1134 (operator decision 2026-09-25, final): Review Yeti does NOT opt out of Bifrost's
//   response cache. No x-bf-cache-* header is sent. #1076 added that opt-out and was reverted.

const base = {
  model: 'pr-reviewer',
  messages: [{ role: 'user' as const, content: 'review this diff' }],
  timeoutMs: 5_000,
};

const CACHE_OPT_OUT_HEADERS = ['x-bf-cache-key', 'x-bf-cache-no-store'];

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

describe('gateway policy headers (REL-1134)', () => {
  it('pins only the MCP include-tools header, with no cache opt-out', () => {
    expect(Object.isFrozen(GATEWAY_POLICY_HEADERS)).toBe(true);
    expect(GATEWAY_POLICY_HEADERS).toEqual({ [GATEWAY_MCP_INCLUDE_TOOLS_HEADER]: '' });
    for (const name of Object.keys(GATEWAY_POLICY_HEADERS)) {
      expect(name.toLowerCase().startsWith('x-bf-cache')).toBe(false);
    }
  });

  it.each([true, false])('sends x-bf-mcp-include-tools exactly once and no cache opt-out (stream=%s)', async (stream) => {
    const fetchImplementation = vi.fn(async () => (stream ? sse() : chatJson()));
    const client = new OpenRouterClient({ apiKey: 'test-key', baseUrl: 'https://gw.test/v1', fetchImplementation });
    await expect(client.complete({ ...base, stream })).resolves.toMatchObject({ content: 'SHIP' });
    const init = (fetchImplementation.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(values(init, GATEWAY_MCP_INCLUDE_TOOLS_HEADER)).toEqual(['']);
    for (const name of CACHE_OPT_OUT_HEADERS) expect(values(init, name)).toEqual([]);
  });

  it.each([true, false])('caller metadata cannot override the MCP pin (stream=%s)', async (stream) => {
    const fetchImplementation = vi.fn(async () => (stream ? sse() : chatJson()));
    const client = new OpenRouterClient({ apiKey: 'test-key', baseUrl: 'https://gw.test/v1', fetchImplementation });
    await client.complete({
      ...base,
      stream,
      metadata: { 'X-Bf-Mcp-Include-Tools': 'all', 'x-ct-test': 'kept' },
    } as any);
    const init = (fetchImplementation.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(values(init, GATEWAY_MCP_INCLUDE_TOOLS_HEADER)).toEqual(['']);
    if (stream) {
      const record = init.headers as Record<string, string>;
      expect(record['X-Bf-Mcp-Include-Tools']).toBeUndefined();
      expect(record['x-ct-test']).toBe('kept');
    }
  });

  describe('on the wire', () => {
    let server: http.Server | undefined;
    afterEach(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    });

    it.each([true, false])('real fetch transmits the MCP pin and no cache opt-out (stream=%s)', async (stream) => {
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
      expect(seen[0][GATEWAY_MCP_INCLUDE_TOOLS_HEADER]).toEqual(['']);
      for (const name of CACHE_OPT_OUT_HEADERS) expect(seen[0][name]).toBeUndefined();
    });
  });
});
