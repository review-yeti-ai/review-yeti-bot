import { Router, Request, Response } from 'express';
import { dashboardStore } from '../persistence/dashboardStore';
import { logger } from '../utils/logger';

export function createGitHubAppApiRouter(): Router {
  const router = Router();

  /**
   * GET /api/github/app-config
   * Retrieves active GitHub App configuration & onboarding status.
   */
  router.get('/app-config', (_req: Request, res: Response) => {
    const settings = dashboardStore.getSettings();
    const appConfig = (settings as any).githubAppConfig || {
      appId: process.env.GITHUB_APP_ID || '',
      installationId: process.env.GITHUB_INSTALLATION_ID || '',
      webhookSecretConfigured: Boolean(process.env.WEBHOOK_SECRET),
      privateKeyConfigured: Boolean(process.env.GITHUB_APP_PRIVATE_KEY),
      oauthClientId: process.env.GITHUB_OAUTH_CLIENT_ID || '',
      status: 'configured',
      monitoredReposCount: dashboardStore.getRepositories().filter((r) => r.automationEnabled).length,
    };

    res.status(200).json({
      success: true,
      appConfig,
    });
  });

  /**
   * POST /api/github/app-config
   * Updates GitHub App credentials, webhook secret, or private key PEM string.
   */
  router.post('/app-config', (req: Request, res: Response) => {
    const { appId, installationId, webhookSecret, privateKeyPem, oauthClientId, oauthClientSecret } = req.body || {};

    const updatedConfig = {
      appId: appId || process.env.GITHUB_APP_ID || '',
      installationId: installationId || process.env.GITHUB_INSTALLATION_ID || '',
      webhookSecretConfigured: Boolean(webhookSecret || process.env.WEBHOOK_SECRET),
      privateKeyConfigured: Boolean(privateKeyPem || process.env.GITHUB_APP_PRIVATE_KEY),
      oauthClientId: oauthClientId || process.env.GITHUB_OAUTH_CLIENT_ID || '',
      updatedAt: new Date().toISOString(),
      status: 'configured',
    };

    dashboardStore.updateSettings({
      githubAppConfig: updatedConfig,
    } as any);

    logger.info('Updated GitHub App Onboarding credentials & settings', { appId: updatedConfig.appId });

    res.status(200).json({
      success: true,
      appConfig: updatedConfig,
    });
  });

  /**
   * GET /api/github/enforcement-policy
   * Retrieves enterprise PR review enforcement rules & failure actions.
   */
  router.get('/enforcement-policy', (_req: Request, res: Response) => {
    const settings = dashboardStore.getSettings();
    const policy = (settings as any).enforcementPolicy || {
      requireAllReviews: true,
      failureAction: 'fail_closed', // 'fail_closed' | 'fail_open' | 'quarantine'
      requireTicketLink: false,
      autoReviewEvents: ['opened', 'synchronize', 'reopened'],
      ignoreDraftPRs: true,
      customApiBaseUrl: process.env.OMNIROUTE_BASE_URL || 'https://omniroute.internal.calltelemetry.com',
    };

    res.status(200).json({
      success: true,
      policy,
    });
  });

  /**
   * PUT /api/github/enforcement-policy
   * Updates enterprise PR review enforcement rules & failure actions.
   */
  router.put('/enforcement-policy', (req: Request, res: Response) => {
    const policyUpdate = req.body || {};

    const existingPolicy = (dashboardStore.getSettings() as any).enforcementPolicy || {
      requireAllReviews: true,
      failureAction: 'fail_closed',
      requireTicketLink: false,
      autoReviewEvents: ['opened', 'synchronize', 'reopened'],
      ignoreDraftPRs: true,
      customApiBaseUrl: process.env.OMNIROUTE_BASE_URL || 'https://omniroute.internal.calltelemetry.com',
    };

    const updatedPolicy = {
      ...existingPolicy,
      ...policyUpdate,
      updatedAt: new Date().toISOString(),
    };

    dashboardStore.updateSettings({
      enforcementPolicy: updatedPolicy,
    } as any);

    logger.info('Updated enterprise PR review enforcement policy', { failureAction: updatedPolicy.failureAction });

    res.status(200).json({
      success: true,
      policy: updatedPolicy,
    });
  });

  return router;
}
