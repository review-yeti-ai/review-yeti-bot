import { describe, it, expect, vi } from 'vitest';
import { mcpFleetManager, McpFleetManager } from '../../src/mcp/mcpFleetManager';

describe('McpFleetManager Unit Tests', () => {
  it('instantiates McpFleetManager as a singleton', () => {
    const instance1 = McpFleetManager.getInstance();
    const instance2 = McpFleetManager.getInstance();
    expect(instance1).toBe(instance2);
    expect(instance1).toBe(mcpFleetManager);
  });

  it('retrieves default registered MCP servers', () => {
    const servers = mcpFleetManager.getServers();
    expect(Array.isArray(servers)).toBe(true);
    expect(servers.length).toBeGreaterThan(0);
    const builtin = servers.find((s) => s.id === 'builtin-context7');
    expect(builtin).toBeDefined();
    expect(builtin?.transport).toBe('adapter');
  });

  it('registers and unregisters custom MCP servers dynamically', async () => {
    const testServerId = `test_mcp_${Date.now()}`;
    await mcpFleetManager.registerServer({
      id: testServerId,
      name: 'Dynamic Test Server',
      transport: 'stdio',
      command: 'node',
      args: ['-e', 'console.log("hello")'],
      enabled: true,
      status: 'online',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let servers = mcpFleetManager.getServers();
    expect(servers.some((s) => s.id === testServerId)).toBe(true);

    const unregistered = await mcpFleetManager.unregisterServer(testServerId);
    expect(unregistered).toBe(true);

    servers = mcpFleetManager.getServers();
    expect(servers.some((s) => s.id === testServerId)).toBe(false);
  });

  it('tests connection for builtin adapter transport', async () => {
    process.env.CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY || 'test-context7-key';
    const res = await mcpFleetManager.testConnection({
      id: 'builtin-context7',
      transport: 'adapter',
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe('online');
    expect(res.toolsDiscovered).toContain('fetch_docs');
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('tests connection for stdio transport', async () => {
    const res = await mcpFleetManager.testConnection({
      name: 'Stdio Test Process',
      transport: 'stdio',
      command: 'npx',
    });

    expect(res.success).toBe(true);
    expect(res.status).toBe('online');
    expect(res.toolsDiscovered).toContain('stdio_generic_tool');
  });

  it('tests connection for unreachable HTTP endpoint gracefully', async () => {
    const res = await mcpFleetManager.testConnection({
      name: 'Unreachable Server',
      transport: 'http',
      url: 'http://127.0.0.1:59999/nonexistent_mcp',
    });

    expect(res.success).toBe(false);
    expect(res.status).toBe('offline');
    expect(res.toolsDiscovered).toEqual([]);
    expect(res.error).toBeDefined();
  });

  it('executes fetch_docs tool via context7 adapter', async () => {
    const origKey = process.env.CONTEXT7_API_KEY;
    delete process.env.CONTEXT7_API_KEY;
    try {
      const result = await mcpFleetManager.executeTool('fetch_docs', {
        library: 'express',
        query: 'router routing middleware',
      });

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.output).toBeDefined();
      expect(result.output.library).toBe('express');
    } finally {
      if (origKey !== undefined) process.env.CONTEXT7_API_KEY = origKey;
    }
  }, 10000);

  it('executes linear_close_issue tool', async () => {
    const result = await mcpFleetManager.executeTool('linear_close_issue', {
      issueId: 'CT-101',
      targetStatus: 'Done',
    });

    expect(result.success).toBe(true);
    expect(result.output.issueId).toBe('CT-101');
    expect(result.output.status).toBe('Done');
  });

  it('discovers and executes tools from stdio MCP server', async () => {
    const serverId = `stdio_test_${Date.now()}`;
    const serverScript = `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      for await (const line of rl) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        if (req.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { tools: [{ name: 'custom_stdio_echo', description: 'Echo test' }] } }) + '\\n');
        } else if (req.method === 'tools/call') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify({ echoed: req.params.arguments }) }] } }) + '\\n');
        }
      }
    `;

    await mcpFleetManager.registerServer({
      id: serverId,
      name: 'Stdio Test MCP Server',
      transport: 'stdio',
      command: 'node',
      args: ['--input-type=module', '-e', serverScript],
      enabled: true,
      status: 'online',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const discovered = await mcpFleetManager.discoverTools(serverId);
    expect(discovered).toContain('custom_stdio_echo');

    const result = await mcpFleetManager.executeTool('custom_stdio_echo', { foo: 'bar' });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({ echoed: { foo: 'bar' } });

    await mcpFleetManager.unregisterServer(serverId);
  });

  it('handles execution of unregistered tool gracefully', async () => {
    const result = await mcpFleetManager.executeTool('non_existent_tool_99', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found in registered MCP fleet');
  });

  describe('Bifrost Gateway HTTP Federation & JSON-RPC 2.0 Transport', () => {
    it('registers bifrost-gateway server by default and resolves ct-mcp alias', () => {
      const servers = mcpFleetManager.getServers();
      const bifrost = servers.find((s) => s.id === 'bifrost-gateway');
      expect(bifrost).toBeDefined();
      expect(bifrost?.transport).toBe('http');
      expect(bifrost?.status).toBe('online');
      expect(bifrost?.url).toContain('/mcp');

      // Test alias resolution
      const viaAlias = mcpFleetManager.getServer('ct-mcp');
      expect(viaAlias).toBeDefined();
      expect(viaAlias?.id).toBe('bifrost-gateway');

      // Verify canonical fleet tools are pre-registered
      const registeredTools = mcpFleetManager.getRegisteredTools();
      expect(registeredTools).toContain('ct_impact');
      expect(registeredTools).toContain('ct_mesh_query');
      expect(registeredTools).toContain('ct_mesh_stats');
      expect(registeredTools).toContain('knowledge_search');
      expect(registeredTools).toContain('knowledge_get');
      expect(registeredTools).toContain('advise_blocker');
      expect(registeredTools).toContain('health');
    });

    it('discovers tools from HTTP server via JSON-RPC tools/list with auth headers', async () => {
      const mockToolsList = {
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: [
            {
              name: 'ct_impact_dynamic',
              description: 'Dynamic impact analysis',
              inputSchema: { target: 'string' },
            },
          ],
        },
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        expect(String(url)).toMatch(/\/mcp$/);
        const headers = (init?.headers || {}) as Record<string, string>;
        expect(headers['Content-Type']).toBe('application/json');
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.method).toBe('tools/list');

        return new Response(JSON.stringify(mockToolsList), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });

      try {
        const discovered = await mcpFleetManager.discoverTools('bifrost-gateway');
        expect(discovered).toContain('ct_impact_dynamic');
        expect(mcpFleetManager.hasTool('ct_impact_dynamic')).toBe(true);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('executes HTTP JSON-RPC tools/call and unwraps JSON text content', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        expect(String(url)).toMatch(/\/mcp$/);
        const body = JSON.parse(String(init?.body || '{}'));
        expect(body.method).toBe('tools/call');
        expect(body.params.name).toBe('ct_impact');
        expect(body.params.arguments).toEqual({ target: 'routes' });

        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ blast_radius: 'HIGH', affected_repos: ['cisco-cdr', 'ct-quasar'] }),
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      try {
        const result = await mcpFleetManager.executeTool('ct_impact', { target: 'routes' });
        expect(result.success).toBe(true);
        expect(result.output).toEqual({ blast_radius: 'HIGH', affected_repos: ['cisco-cdr', 'ct-quasar'] });
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('executes HTTP JSON-RPC tools/call and handles plain text content', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [{ type: 'text', text: 'Governed ADR text for ADR-0329' }],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      try {
        const result = await mcpFleetManager.executeTool('knowledge_get', { id: 'ADR-0329' });
        expect(result.success).toBe(true);
        expect(result.output).toBe('Governed ADR text for ADR-0329');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles tool execution reporting isError: true gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              isError: true,
              content: [{ type: 'text', text: JSON.stringify({ error: 'Permission denied: mutating tool' }) }],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      try {
        const result = await mcpFleetManager.executeTool('advise_blocker', { blocker_packet: {} });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Permission denied');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles JSON-RPC protocol error from gateway', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32601, message: 'Method not found' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      try {
        const result = await mcpFleetManager.executeTool('ct_mesh_query', { query: 'test' });
        expect(result.success).toBe(false);
        expect(result.error).toBe('Method not found');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles HTTP 401/403 authentication failure gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' });
      });

      try {
        const result = await mcpFleetManager.executeTool('health', {});
        expect(result.success).toBe(false);
        expect(result.error).toContain('Authentication failed');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles HTTP 502 gateway error gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        return new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
      });

      try {
        const result = await mcpFleetManager.executeTool('ct_mesh_stats', {});
        expect(result.success).toBe(false);
        expect(result.error).toContain('502');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('fails immediately when the signal is already aborted at fetch time', async () => {
      // REL-1116: a pre-aborted signal must fail fast, not be handed to `fetch`.
      //
      // CORRECTION to an earlier version of this comment, which called this a production hang:
      // real `fetch` rejects an already-aborted signal immediately (measured 15ms on Node 24).
      // The hang was confined to TEST MOCKS that add an `abort` listener without checking
      // `signal.aborted` first -- which is why `Test timed out in 5000ms` appeared locally and
      // not in CI (an env key short-circuits the 470ms Doppler lookup that consumed the budget).
      //
      // The mock below is deliberately written to model the REAL contract (reject on a
      // pre-aborted signal), not the buggy mock, so this test pins the guard without relying on
      // a mock artefact.
      //
      // Counterfactual the review named: deleting the early-throw recreates exactly that hang,
      // so this asserts settlement, not merely a rejection shape.
      const controller = new AbortController();
      controller.abort(); // aborted BEFORE entry — the pre-abort case

      let fetchCalls = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => {
        fetchCalls += 1;
        // Model the real fetch contract: an already-aborted signal rejects immediately.
        if (init?.signal?.aborted) {
          throw Object.assign(new Error('already aborted'), { name: 'AbortError' });
        }
        return new Promise(() => { /* unreachable for this test */ });
      });

      try {
        const settled = await Promise.race([
          mcpFleetManager.executeTool('ct_impact', { target: 'pre-aborted' }, { signal: controller.signal }),
          new Promise((resolve) => setTimeout(() => resolve('HUNG'), 2000)),
        ]);
        // The whole point: it must NOT hang.
        expect(settled).not.toBe('HUNG');
        expect(settled).toMatchObject({ success: false });
        expect(String((settled as { error?: string }).error)).toMatch(/abort/i);
        // ...and a pre-aborted signal must not issue a request whose abort can never arrive.
        expect(fetchCalls).toBe(0);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('a caller abort with a CUSTOM reason is still aborted, not a timeout', async () => {
      // The taxonomy lives in ONE place: the outer HTTP catch keys on `options.signal.aborted`,
      // so the reason text cannot change the verdict. The inline copy this replaced sniffed the
      // reason's name/message instead, which is the shape that mislabels a custom caller reason
      // as a timeout -- two sites for one rule, and it had already drifted (REL-1116 review).
      //
      // Scope note, verified rather than assumed: a pre-aborted caller signal is turned into a
      // controller abort at the `AbortSignal.any` polyfill, so this reaches the OUTER catch and
      // asserts the shared taxonomy. The pre-fetch guard added in this change is a backstop for
      // an abort that lands during setup; planting the old inline copy does not fail this test,
      // which is exactly why the copy was removed rather than merely re-tested.
      const controller = new AbortController();
      controller.abort(new Error('operator cancelled the run'));

      const result = await mcpFleetManager.executeTool(
        'ct_impact', { target: 'custom-reason' }, { signal: controller.signal, timeoutMs: 5000 },
      );
      expect(result).toMatchObject({ success: false });
      expect(result.error).toBe('Operation aborted');
      expect(result.error).not.toMatch(/timed out/u);
    });

    it('a caller abort in flight is reported as aborted, not as a timeout', async () => {
      // Covers the caller-abort branch end to end. Note WHICH branch: the outer HTTP catch
      // classifies `wasAbortedByCaller` first, so this asserts the observable contract
      // ('aborted', never 'timed out') rather than claiming to pin the inner ternary -- an
      // earlier version of this test did claim that and passed with the ternary inverted,
      // because the outer branch answered first (REL-1116 review).
      const controller = new AbortController();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          // Abort AFTER fetch is in flight: the realistic caller-abort case.
          if (signal) {
            signal.addEventListener('abort', () => {
              reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
            });
          }
          // Abort the CALLER's signal shortly after the request starts.
          setTimeout(() => controller.abort(new Error('The operation was aborted')), 30);
        });
      });

      try {
        const result = await mcpFleetManager.executeTool(
          'ct_impact', { target: 'abort-in-flight' }, { signal: controller.signal, timeoutMs: 5000 },
        );
        expect(result).toMatchObject({ success: false });
        expect(result.error).toBe('Operation aborted');
        expect(result.error).not.toMatch(/timed out/u);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('charges a short budget to the request, not to setup (timer placement)', async () => {
      // Discriminates the timer placement ALONE, deterministically.
      //
      // The earlier version of this test relied on the REAL `getHttpHeaders()` latency (~470ms
      // of Doppler lookup) outrunning a 50ms budget, which made its power contingent on the
      // environment: mock, cache or remove that lookup and the test silently stops
      // discriminating (REL-1116 review). Here the slow setup is SUPPLIED, not hoped for.
      //
      // `resolveBifrostApiKey()` is skipped whenever an env key is present, and otherwise awaits
      // `dopplerManager.getSecret()`. With no env key set, stubbing that method to a 300ms
      // resolve makes setup deterministic: with the timer armed before it (pre-fix placement)
      // the budget expires during setup and the request is never dispatched; with the timer
      // armed at the request boundary it is.
      const savedKey = process.env.REVIEW_YETI_BIFROST_API_KEY;
      const savedGateway = process.env.CT_LLM_GATEWAY_API_KEY;
      const savedBifrost = process.env.BIFROST_API_KEY;
      const savedMcp = process.env.CT_MCP_KEY;
      delete process.env.REVIEW_YETI_BIFROST_API_KEY;
      delete process.env.CT_LLM_GATEWAY_API_KEY;
      delete process.env.BIFROST_API_KEY;
      delete process.env.CT_MCP_KEY;

      const manager = mcpFleetManager as unknown as {
        dopplerManager: { getSecret: (key: string) => Promise<string | null> };
      };
      const originalGetSecret = manager.dopplerManager.getSecret;
      manager.dopplerManager.getSecret = () =>
        new Promise<string | null>((resolve) => setTimeout(() => resolve(''), 300));

      let fetchCalls = 0;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => {
        fetchCalls += 1;
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(Object.assign(new Error('already aborted'), { name: 'AbortError' }));
            return;
          }
          signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted on timeout'), { name: 'AbortError' }));
          });
        });
      });

      try {
        const result = await mcpFleetManager.executeTool(
          'ct_impact', { target: 'short-budget' }, { timeoutMs: 50 },
        );
        expect(result).toMatchObject({ success: false });
        expect(String(result.error)).toMatch(/timed out/iu);
        // The request was ISSUED: the 50ms budget was charged to the request, not to the 300ms
        // of setup that preceded it.
        expect(fetchCalls).toBe(1);
      } finally {
        fetchSpy.mockRestore();
        manager.dopplerManager.getSecret = originalGetSecret;
        if (savedKey !== undefined) process.env.REVIEW_YETI_BIFROST_API_KEY = savedKey;
        if (savedGateway !== undefined) process.env.CT_LLM_GATEWAY_API_KEY = savedGateway;
        if (savedBifrost !== undefined) process.env.BIFROST_API_KEY = savedBifrost;
        if (savedMcp !== undefined) process.env.CT_MCP_KEY = savedMcp;
      }
    });

    it('bounds the BODY read, not just the response headers', async () => {
      // REL-1116 follow-up, found by an external review rather than by any test I had written.
      //
      // `clearTimeout(timer)` used to run immediately after `fetch()` resolved, leaving
      // `await res.json()` unbounded. A server that returns headers and then stalls the body
      // hung FOREVER under any budget, and with no caller signal nothing else bounded it.
      // Verified before the fix: a Response whose `json()` never resolves hung past 2.5s under
      // `timeoutMs: 50`.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u: any, init: any) => ({
        ok: true,
        status: 200,
        // Header phase completes; body phase rejects only when the abort fires, which is the
        // real fetch contract.
        json: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        }),
        text: () => new Promise(() => {}),
      }) as any);

      try {
        const settled = await Promise.race([
          mcpFleetManager.executeTool('ct_impact', { target: 'body-stall' }, { timeoutMs: 50 }),
          new Promise((resolve) => setTimeout(() => resolve('HUNG'), 2500)),
        ]);
        // The whole point: it must NOT hang.
        expect(settled).not.toBe('HUNG');
        expect(settled).toMatchObject({ success: false });
        expect(String((settled as { error?: string }).error)).toMatch(/timed out/iu);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('handles HTTP request timeout gracefully', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const signal = init?.signal;
        return new Promise((_resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('HTTP request timed out after 50ms');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      try {
        const result = await mcpFleetManager.executeTool('ct_impact', { target: 'timeout' }, { timeoutMs: 50 });
        expect(result.success).toBe(false);
        expect(result.error).toContain('timed out');
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('terminates HTTP tool request immediately when AbortSignal is aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await mcpFleetManager.executeTool(
        'ct_impact',
        { target: 'routes' },
        { signal: controller.signal }
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('Operation aborted');
    });

    it('returns error when stdio process exits without emitting JSON-RPC response', async () => {
      const serverId = `test_stdio_no_resp_${Date.now()}`;
      await mcpFleetManager.registerServer({
        id: serverId,
        name: 'Empty Stdio Server',
        transport: 'stdio',
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        enabled: true,
        status: 'online',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      (mcpFleetManager as any).toolRegistry.set('test_empty_stdio_tool', {
        serverId,
        name: 'test_empty_stdio_tool',
        description: 'Test empty stdio',
        inputSchema: {},
      });

      const result = await mcpFleetManager.executeTool('test_empty_stdio_tool', {});
      expect(result.success).toBe(false);
      expect(result.output).toBeNull();
      expect(result.error).toBe('Stdio process exited without emitting JSON-RPC response');

      await mcpFleetManager.unregisterServer(serverId);
    });
  });
});

