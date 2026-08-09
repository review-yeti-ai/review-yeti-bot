import { describe, it, expect, vi } from 'vitest';
import { mcpFleetManager, McpFleetManager } from '../../src/mcp/mcpFleetManager';

describe('McpFleetManager Unit Tests', () => {
  it('instantiates McpFleetManager as a singleton', () => {
    const instance1 = McpFleetManager.getInstance();
    const instance2 = McpFleetManager.getInstance();
    expect(instance1).toBe(instance2);
    expect(instance1).toBe(mcpFleetManager);
  });

  it('supports dependency-injected instances for Action/server boundary tests', () => {
    const injected = McpFleetManager.create({ dopplerManager: { getSecret: async () => null } as any });
    expect(injected).not.toBe(mcpFleetManager);
    expect(injected.getServers().some((server) => server.id === 'builtin-context7')).toBe(true);
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

  it('executes linear_close_issue tool when LINEAR_API_KEY present', async () => {
    const origKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_api_test_key_for_fleet';
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          issue: {
            id: 'uuid-1',
            team: { states: { nodes: [{ id: 'state-done', name: 'Done', type: 'completed' }] } },
          },
          issueUpdate: { success: true, issue: { id: 'uuid-1', identifier: 'CT-101' } },
        },
      }),
    });
    vi.stubGlobal('fetch', mockFetch);
    try {
      const result = await mcpFleetManager.executeTool('linear_close_issue', {
        issueId: 'CT-101',
        targetStatus: 'Done',
      });

      expect(result.success).toBe(true);
      expect(result.output.issueId).toBe('CT-101');
      expect(result.output.status).toBe('Done');
    } finally {
      vi.unstubAllGlobals();
      if (origKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = origKey;
    }
  });

  it('fails linear_close_issue when LINEAR_API_KEY missing (no OAuth fallback)', async () => {
    const origKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    // Doppler caches successful lookups; force miss so we assert API-key-only gate.
    const { DopplerSecretManager } = await import('../../src/mcp/dopplerSecretManager');
    const spy = vi.spyOn(DopplerSecretManager.prototype, 'getSecret').mockResolvedValue(null);
    try {
      const result = await mcpFleetManager.executeTool('linear_close_issue', {
        issueId: 'CT-101',
        targetStatus: 'Done',
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/LINEAR_API_KEY missing/i);
    } finally {
      spy.mockRestore();
      if (origKey !== undefined) process.env.LINEAR_API_KEY = origKey;
    }
  });

  it('rejects registering OAuth remote Linear MCP', async () => {
    await expect(
      mcpFleetManager.registerServer({
        id: `oauth-linear-${Date.now()}`,
        name: 'Official Linear OAuth MCP',
        transport: 'http',
        url: 'https://mcp.linear.app/sse',
        enabled: true,
        status: 'untested',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    ).rejects.toThrow(/OAuth|LINEAR_API_KEY/i);
  });

  it('handles execution of unregistered tool gracefully', async () => {
    const result = await mcpFleetManager.executeTool('non_existent_tool_99', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found in registered MCP fleet');
  });
});
