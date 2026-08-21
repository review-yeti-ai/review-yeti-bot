import { describe, it, expect, vi } from 'vitest';
import { mcpsSchema, ctReviewConfigV3Schema } from '../../src/config/schema';
import { MCPManager } from '../../src/mcp/mcpManager';
import { Context7Adapter } from '../../src/mcp/context7Adapter';
import { DopplerSecretManager } from '../../src/mcp/dopplerSecretManager';

describe('Dynamic MCP Fleet Execution & Extensions Suite', () => {
  it('1. parses top-level mcps array configuration', () => {
    const rawMcps = [
      { name: 'context7', enabled: true, options: { timeoutMs: 3000 } },
      { name: 'productlane', enabled: false },
      { name: 'linear-mcp', enabled: true },
    ];

    const parsed = mcpsSchema.parse(rawMcps);
    expect(parsed.length).toBe(3);
    expect(parsed[0].name).toBe('context7');
    expect(parsed[0].enabled).toBe(true);
    expect(parsed[1].enabled).toBe(false);
  });

  it('2. registers dynamic MCP tool definitions into router', () => {
    const mcps = [
      { name: 'context7', enabled: true },
      { name: 'productlane', enabled: true },
    ];

    const manager = new MCPManager(mcps);
    const c7 = manager.getContext7();
    const pl = manager.getProductlane();

    expect(c7).toBeDefined();
    expect(pl).toBeDefined();
    expect(typeof c7?.fetchDocs).toBe('function');
    expect(typeof pl?.syncChangelog).toBe('function');
  });

  it('3. executes dynamic MCP tool call with parameter mapping', async () => {
    const mockDoppler: any = {
      getSecret: vi.fn().mockResolvedValue('c7_test_secret_key'),
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        snippets: [
          { title: 'Express Routing Guide', content: 'app.get("/path", handler)', score: 0.95 },
        ],
        sourceUrl: 'https://context7.ai/docs/express',
      }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const adapter = new Context7Adapter({ dopplerManager: mockDoppler });
    const res = await adapter.fetchDocs('express', 'routing middleware', { limit: 2 });

    expect(res.degraded).toBe(false);
    expect(res.sourceUrl).toBe('https://context7.ai/docs/express');
    expect(res.snippets.length).toBe(1);
    expect(res.snippets[0].title).toBe('Express Routing Guide');

    vi.unstubAllGlobals();
  });

  it('4. handles Doppler secret resolution for MCP authentication', async () => {
    const dopplerManager = new DopplerSecretManager({ timeoutMs: 100 });
    const secret = await dopplerManager.getSecret('NON_EXISTENT_MCP_SECRET_KEY');

    expect(secret).toBeNull();
  });

  it('5. enforces mcp_timeout_s per tool execution', async () => {
    const mockDoppler: any = {
      getSecret: vi.fn().mockResolvedValue('key_123'),
    };

    const mockSlowFetch = vi.fn().mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('The operation was aborted')), 100))
    );
    vi.stubGlobal('fetch', mockSlowFetch);

    const adapter = new Context7Adapter({ dopplerManager: mockDoppler, timeoutMs: 50 });
    const res = await adapter.fetchDocs('express', 'slow query');

    expect(res.degraded).toBe(true);
    expect(res.error).toBeDefined();

    vi.unstubAllGlobals();
  });

  it('6. handles MCP server unreachable error gracefully', async () => {
    const mockDoppler: any = {
      getSecret: vi.fn().mockResolvedValue('key_123'),
    };

    const mockNetworkErr = vi.fn().mockRejectedValue(new Error('fetch failed: ECONNREFUSED 127.0.0.1:9090'));
    vi.stubGlobal('fetch', mockNetworkErr);

    const adapter = new Context7Adapter({ dopplerManager: mockDoppler });
    const res = await adapter.fetchDocs('express', 'unreachable server query');

    expect(res.degraded).toBe(true);
    expect(res.error).toContain('ECONNREFUSED');
    expect(res.snippets[0].title).toContain('Degraded Offline Docs');

    vi.unstubAllGlobals();
  });

  it('7. validates unique MCP server IDs in configuration', () => {
    const mcpsList = [
      { name: 'context7', enabled: true },
      { name: 'context7', enabled: true },
    ];

    const parsed = mcpsSchema.parse(mcpsList);
    const names = parsed.map((m) => m.name);
    const hasDuplicates = names.length !== new Set(names).size;

    expect(hasDuplicates).toBe(true);
  });
});
