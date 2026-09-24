import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GATEWAY_MCP_INCLUDE_TOOLS_HEADER,
  OpenRouterClient,
} from '../../src/gateway/openRouterClient';

// REL-1115: Review Yeti opts out of gateway-injected MCP tools on every model call. An empty
// x-bf-mcp-include-tools narrows the virtual key's MCP grant to no tool. Without it, Bifrost
// injected up to 880 tool definitions (~200k prompt tokens) into each review completion.

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

/** Every value the request carries for the header, matched case-insensitively. */
function mcpValues(init: RequestInit | undefined): string[] {
  const raw = init?.headers;
  if (raw instanceof Headers) {
    const v = raw.get(GATEWAY_MCP_INCLUDE_TOOLS_HEADER);
    return v === null ? [] : [v];
  }
  return Object.entries((raw || {}) as Record<string, string>)
    .filter(([k]) => k.toLowerCase() === GATEWAY_MCP_INCLUDE_TOOLS_HEADER)
    .map(([, v]) => v);
}

describe('Review Yeti opts out of gateway MCP tool injection (REL-1115)', () => {
  it('names the Bifrost per-request tool allowlist header', () => {
    expect(GATEWAY_MCP_INCLUDE_TOOLS_HEADER).toBe('x-bf-mcp-include-tools');
  });

  it('sends an empty tool allowlist on streaming completions', async () => {
    const fetchImplementation = vi.fn(async () => sse());
    const client = new OpenRouterClient({ apiKey: 'test-key', baseUrl: 'https://gw.test/v1', fetchImplementation });
    await expect(client.complete({ ...base, stream: true })).resolves.toMatchObject({ content: 'SHIP' });
    expect(mcpValues(fetchImplementation.mock.calls[0][1] as RequestInit)).toEqual(['']);
  });

  it('caller metadata cannot re-open injection on the streaming path', async () => {
    const fetchImplementation = vi.fn(async () => sse());
    const client = new OpenRouterClient({ apiKey: 'test-key', baseUrl: 'https://gw.test/v1', fetchImplementation });
    await client.complete({ ...base, stream: true, metadata: { 'X-BF-MCP-Include-Tools': '*', 'x-ct-test': 'kept' } } as any);
    const init = fetchImplementation.mock.calls[0][1] as RequestInit;
    expect(mcpValues(init)).toEqual(['']);
    expect((init.headers as Record<string, string>)['x-ct-test']).toBe('kept');
  });

  it('sends an empty tool allowlist on non-streaming (SDK) completions', async () => {
    const fetchImplementation = vi.fn(async () => chatJson());
    const client = new OpenRouterClient({ apiKey: 'test-key', baseUrl: 'https://gw.test/v1', fetchImplementation });
    await expect(client.complete({ ...base, stream: false })).resolves.toMatchObject({ content: 'SHIP' });
    const init = fetchImplementation.mock.calls[0][1] as RequestInit;
    expect(mcpValues(init)).toEqual(['']);
    // The SDK's own headers survive alongside it.
    expect(new Headers(init.headers).get('x-openrouter-metadata')).toBe('enabled');
  });

  describe('on the wire', () => {
    let server: http.Server | undefined;
    afterEach(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    });

    // An empty header value is easy to lose (a client that skips falsy values). Prove the real
    // fetch stack puts it on the socket, for both transports.
    it.each([true, false])('real fetch transmits the empty header (stream=%s)', async (stream) => {
      const seen: Array<string | undefined> = [];
      server = http.createServer((req, res) => {
        const raw = req.rawHeaders;
        const idx = raw.findIndex((h, i) => i % 2 === 0 && h.toLowerCase() === GATEWAY_MCP_INCLUDE_TOOLS_HEADER);
        seen.push(idx === -1 ? undefined : raw[idx + 1]);
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
      expect(seen).toEqual(['']);
    });
  });
});
