import { Router, Request, Response } from 'express';
import { dashboardStore } from '../persistence/dashboardStore';

export function createDashboardRouter(): Router {
  const router = Router();

  // GET /api/dashboard/overview
  router.get('/overview', (_req: Request, res: Response) => {
    const overview = dashboardStore.getOverviewStats();
    return res.status(200).json({
      success: true,
      overview,
    });
  });

  // GET /api/dashboard/logs
  router.get('/logs', (_req: Request, res: Response) => {
    const logs = dashboardStore.getReviewLogs();
    return res.status(200).json({
      success: true,
      logs,
    });
  });

  // GET /api/dashboard/repositories
  router.get('/repositories', (_req: Request, res: Response) => {
    const repositories = dashboardStore.getRepositories();
    return res.status(200).json({
      success: true,
      repositories,
    });
  });

  // GET /api/dashboard/repositories/:owner/:repo
  router.get('/repositories/:owner/:repo', (req: Request, res: Response) => {
    const { owner, repo } = req.params;
    const item = dashboardStore.getRepository(owner, repo);
    if (!item) {
      return res.status(404).json({
        success: false,
        error: `Repository ${owner}/${repo} not found`,
      });
    }
    return res.status(200).json({
      success: true,
      repository: item,
    });
  });

  // PATCH /api/dashboard/repositories (batch or generic toggle update)
  router.patch('/repositories', (req: Request, res: Response) => {
    const { owner, repo, automationEnabled, customProfile, modelOverrides } = req.body || {};
    if (!owner || !repo) {
      return res.status(400).json({
        success: false,
        error: 'owner and repo are required in body',
      });
    }
    const updated = dashboardStore.updateRepository(owner, repo, {
      ...(typeof automationEnabled === 'boolean' ? { automationEnabled } : {}),
      ...(customProfile ? { customProfile } : {}),
      ...(modelOverrides ? { modelOverrides } : {}),
    });
    return res.status(200).json({
      success: true,
      repository: updated,
    });
  });

  // PATCH /api/dashboard/repositories/:owner/:repo
  router.patch('/repositories/:owner/:repo', (req: Request, res: Response) => {
    const { owner, repo } = req.params;
    const { automationEnabled, customProfile, modelOverrides } = req.body || {};
    const updated = dashboardStore.updateRepository(owner, repo, {
      ...(typeof automationEnabled === 'boolean' ? { automationEnabled } : {}),
      ...(customProfile ? { customProfile } : {}),
      ...(modelOverrides ? { modelOverrides } : {}),
    });
    return res.status(200).json({
      success: true,
      repository: updated,
    });
  });

  // GET /api/dashboard/settings
  router.get('/settings', (_req: Request, res: Response) => {
    const settings = dashboardStore.getSettings();
    return res.status(200).json({
      success: true,
      settings,
    });
  });

  // PUT /api/dashboard/settings
  router.put('/settings', (req: Request, res: Response) => {
    const settingsUpdate = req.body || {};
    try {
      const updated = dashboardStore.updateSettings(settingsUpdate);
      return res.status(200).json({
        success: true,
        settings: updated,
      });
    } catch (err: any) {
      return res.status(400).json({
        success: false,
        error: err?.message || 'Invalid settings payload',
      });
    }
  });

  // PATCH /api/dashboard/settings/personas/:personaId
  router.patch('/settings/personas/:personaId', (req: Request, res: Response) => {
    const { personaId } = req.params;
    const patch = req.body || {};
    try {
      const updatedPersona = dashboardStore.updatePersonaSetting(personaId, patch);
      return res.status(200).json({
        success: true,
        persona: updatedPersona,
      });
    } catch (err: any) {
      const isNotFound = err.message && err.message.includes('not found');
      return res.status(isNotFound ? 404 : 400).json({
        success: false,
        error: err?.message || `Failed to update persona '${personaId}'`,
      });
    }
  });

  return router;
}
