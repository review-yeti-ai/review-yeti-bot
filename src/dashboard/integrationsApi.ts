import { Router, Request, Response } from 'express';
import { dashboardStore, IntegrationConfig } from '../persistence/dashboardStore';
import { mcpFleetManager } from '../mcp/mcpFleetManager';
import { logger } from '../utils/logger';

const VALID_PLATFORMS = ['linear', 'github', 'context7', 'productlane', 'posthog'];

export function createIntegrationsRouter(): Router {
  const router = Router();

  // 1. GET /api/dashboard/integrations
  const handleGetIntegrations = (_req: Request, res: Response) => {
    const integrations = dashboardStore.getIntegrations();
    return res.status(200).json({
      success: true,
      integrations,
    });
  };

  router.get('/integrations', handleGetIntegrations);
  router.get('/', (req: Request, res: Response, next) => {
    if (req.baseUrl.endsWith('/integrations')) {
      return handleGetIntegrations(req, res);
    }
    next();
  });

  // 2. POST / PUT /api/dashboard/integrations
  const handleUpdateIntegration = (req: Request, res: Response) => {
    const { platform, id, apiKey, oauthClientId, oauthClientSecret, webhookUrl, settings } = req.body || {};
    const platformId = (platform || id || '').toLowerCase();

    if (!platformId || !VALID_PLATFORMS.includes(platformId)) {
      return res.status(400).json({
        success: false,
        error: `Invalid or missing platform. Must be one of: ${VALID_PLATFORMS.join(', ')}`,
      });
    }

    try {
      const updated = dashboardStore.updateIntegration(platformId, {
        apiKey,
        oauthClientId,
        oauthClientSecret,
        webhookUrl,
        settings,
      });

      logger.info(`Updated integration credentials for ${platformId}`);

      return res.status(200).json({
        success: true,
        integration: updated,
        integrations: dashboardStore.getIntegrations(),
      });
    } catch (err: any) {
      logger.error(`Failed updating integration ${platformId}`, { error: err.message });
      return res.status(500).json({
        success: false,
        error: err.message || 'Failed to update integration',
      });
    }
  };

  router.post('/integrations', handleUpdateIntegration);
  router.put('/integrations', handleUpdateIntegration);

  // 3. GET /api/dashboard/mcp/servers
  const handleGetMcpServers = (_req: Request, res: Response) => {
    const servers = mcpFleetManager.getServers();
    return res.status(200).json({
      success: true,
      servers,
    });
  };

  router.get('/mcp/servers', handleGetMcpServers);
  router.get('/mcp/fleet', handleGetMcpServers);
  router.get('/servers', handleGetMcpServers);
  router.get('/fleet', handleGetMcpServers);

  // 4. POST /api/dashboard/mcp/servers
  const handleAddMcpServer = async (req: Request, res: Response) => {
    const { name, transport, url, command, args, env, enabled } = req.body || {};

    if (!name || !transport) {
      return res.status(400).json({
        success: false,
        error: 'name and transport are required parameters',
      });
    }

    if (transport === 'http' && !url) {
      return res.status(400).json({
        success: false,
        error: 'HTTP transport requires endpoint URL',
      });
    }

    if (transport === 'stdio' && !command) {
      return res.status(400).json({
        success: false,
        error: 'Stdio transport requires command',
      });
    }

    try {
      const newServer = dashboardStore.addMcpServer({
        name,
        transport,
        url,
        command,
        args,
        env,
        enabled: enabled ?? true,
        status: 'untested',
      });

      await mcpFleetManager.registerServer(newServer);

      return res.status(201).json({
        success: true,
        server: newServer,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message || 'Failed to add MCP server',
      });
    }
  };

  router.post('/mcp/servers', handleAddMcpServer);
  router.post('/servers', handleAddMcpServer);

  // 5. PATCH /api/dashboard/mcp/servers/:id
  const handlePatchMcpServer = async (req: Request, res: Response) => {
    const { id } = req.params;
    const patch = req.body || {};

    try {
      const updated = await mcpFleetManager.updateServer(id, patch);
      if (!updated) {
        return res.status(404).json({
          success: false,
          error: `MCP server with ID ${id} not found`,
        });
      }

      return res.status(200).json({
        success: true,
        server: updated,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message || 'Failed to update MCP server',
      });
    }
  };

  router.patch('/mcp/servers/:id', handlePatchMcpServer);
  router.patch('/servers/:id', handlePatchMcpServer);

  // 6. DELETE /api/dashboard/mcp/servers/:id
  const handleDeleteMcpServer = async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
      const deleted = await mcpFleetManager.unregisterServer(id);
      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: `MCP server with ID ${id} not found`,
        });
      }

      return res.status(200).json({
        success: true,
        message: `MCP server ${id} deleted successfully`,
      });
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message || 'Failed to delete MCP server',
      });
    }
  };

  router.delete('/mcp/servers/:id', handleDeleteMcpServer);
  router.delete('/mcp/:id', handleDeleteMcpServer);
  router.delete('/servers/:id', handleDeleteMcpServer);

  // 7. POST /api/dashboard/mcp/test
  const handleTestMcpServer = async (req: Request, res: Response) => {
    const payload = req.body || {};

    try {
      const testResult = await mcpFleetManager.testConnection(payload);
      const statusCode = testResult.success ? 200 : 400;

      return res.status(statusCode).json({
        success: testResult.success,
        latencyMs: testResult.latencyMs,
        status: testResult.status,
        toolsDiscovered: testResult.toolsDiscovered,
        message: testResult.message,
        error: testResult.error,
      });
    } catch (err: any) {
      return res.status(502).json({
        success: false,
        latencyMs: 0,
        status: 'offline',
        toolsDiscovered: [],
        error: err.message || 'MCP connectivity test failed',
      });
    }
  };

  router.post('/mcp/test', handleTestMcpServer);
  router.post('/test', handleTestMcpServer);

  return router;
}
