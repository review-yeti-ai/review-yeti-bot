import { describe, it, expect, vi } from 'vitest';
import { ProductlaneMCPAdapter } from '../../src/mcp/productlaneAdapter';
import { MCPManager } from '../../src/mcp/mcpManager';

describe('Milestone 18: Productlane Adapter & MCP Manager', () => {
  describe('ProductlaneMCPAdapter', () => {
    it('returns unresolvable health check when PRODUCTLANE_API_KEY missing', async () => {
      const mockDoppler: any = {
        getSecret: vi.fn().mockResolvedValue(null),
      };
      const adapter = new ProductlaneMCPAdapter({ dopplerManager: mockDoppler });
      const health = await adapter.healthCheck();
      expect(health.ok).toBe(false);
      expect(health.message).toContain('PRODUCTLANE_API_KEY unresolvable');
    });

    it('returns operational health check when PRODUCTLANE_API_KEY present', async () => {
      const mockDoppler: any = {
        getSecret: vi.fn().mockResolvedValue('pl_secret_key_123'),
      };
      const adapter = new ProductlaneMCPAdapter({ dopplerManager: mockDoppler });
      const health = await adapter.healthCheck();
      expect(health.ok).toBe(true);
      expect(health.message).toContain('Productlane API operational');
    });

    it('syncs changelog via Productlane API when token available', async () => {
      const mockDoppler: any = {
        getSecret: vi.fn().mockResolvedValue('pl_secret_key_123'),
      };
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'changelog-item-99' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const adapter = new ProductlaneMCPAdapter({ dopplerManager: mockDoppler });
      const result = await adapter.syncChangelog(42, 'Feature X', 'Content details');

      expect(result.success).toBe(true);
      expect(result.id).toBe('changelog-item-99');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.productlane.com/v1/changelogs',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer pl_secret_key_123',
          }),
        })
      );

      vi.unstubAllGlobals();
    });
  });

  describe('MCPManager', () => {
    it('instantiates enabled MCP adapters', () => {
      const mcps = [
        { name: 'context7', enabled: true },
        { name: 'productlane', enabled: true },
      ];

      const manager = new MCPManager(mcps);
      expect(manager.getContext7()).toBeDefined();
      expect(manager.getProductlane()).toBeDefined();
    });

    it('skips disabled MCP adapters', () => {
      const mcps = [
        { name: 'context7', enabled: false },
        { name: 'productlane', enabled: true },
      ];

      const manager = new MCPManager(mcps);
      expect(manager.getContext7()).toBeUndefined();
      expect(manager.getProductlane()).toBeDefined();
    });
  });
});
