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

