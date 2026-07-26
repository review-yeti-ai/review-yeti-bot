import { Router, Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { scanRepositoryStack } from '../onboarding/stackScanner';
import { generateCtReviewConfig } from '../onboarding/configGenerator';
import { logger } from '../utils/logger';

export function createOnboardingRouter(): Router {
  const router = Router();

  // POST /api/onboarding/wizard or POST /api/onboarding/wizard/scan
  const handleWizard = async (req: Request, res: Response) => {
    try {
      let resolvedPath: string;
      if (req.body.repoPath) {
        resolvedPath = path.isAbsolute(req.body.repoPath)
          ? req.body.repoPath
          : path.resolve(process.cwd(), req.body.repoPath);

        if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory()) {
          return res.status(400).json({
            success: false,
            error: 'Invalid repository path',
          });
        }
      } else {
        resolvedPath = process.cwd();
      }

      let scanResult;
      try {
        scanResult = await scanRepositoryStack(resolvedPath);
      } catch (err: any) {
        return res.status(400).json({
          success: false,
          error: 'Invalid repository path',
        });
      }

      const generated = generateCtReviewConfig({ scanResult });

      logger.info('Onboarding wizard completed', {
        repoPath: resolvedPath,
        scanDurationMs: scanResult.detection.scanDurationMs,
      });

      return res.status(200).json({
        success: true,
        scanResult,
        generatedConfig: generated.yamlText,
        config: generated.config,
        yamlText: generated.yamlText,
      });
    } catch (err: any) {
      logger.error('Onboarding wizard failed', { error: err?.message });
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to complete onboarding wizard',
      });
    }
  };

  router.post('/wizard', handleWizard);
  router.post('/wizard/scan', handleWizard);

  // POST /api/onboarding/wizard/generate
  router.post('/wizard/generate', async (req: Request, res: Response) => {
    try {
      const { scanResult, profile, ticketEnforcement, selectedPersonaIds, customPathFilters } = req.body;

      const generated = generateCtReviewConfig({
        scanResult,
        profile,
        ticketEnforcement,
        selectedPersonaIds,
        customPathFilters,
      });

      return res.status(200).json({
        success: true,
        yamlText: generated.yamlText,
        config: generated.config,
        generatedConfig: generated.yamlText,
      });
    } catch (err: any) {
      logger.error('Onboarding config generation failed', { error: err?.message });
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to generate config',
      });
    }
  });

  return router;
}
