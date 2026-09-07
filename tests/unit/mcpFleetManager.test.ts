import { describe, it, expect } from 'vitest';
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
});

