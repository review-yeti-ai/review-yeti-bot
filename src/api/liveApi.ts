import { Router, Request, Response } from 'express';
import { LiveStreamBus } from '../live/liveStreamBus';
import { authService } from '../dashboard/authService';
import { logger } from '../utils/logger';

export function createLiveRouter(): Router {
  const router = Router();
  const bus = LiveStreamBus.getInstance();

  /**
   * GET /api/live/stream?jobId=...&token=...
   * SSE endpoint streaming real-time agent execution events and LLM turns.
   * Supports query parameter authentication token (`?token=...`).
   */
  router.get('/stream', (req: Request, res: Response) => {
    const jobId = (req.query.jobId as string) || 'default-job';
    const queryToken = (req.query.token as string) || (req.query.access_token as string);

    // If query token is provided, validate session or API key
    if (queryToken) {
      const session = authService.validateSession(queryToken);
      const isApiKey = authService.validateApiKey(queryToken);
      if (!session && !isApiKey) {
        res.status(401).json({ error: 'Unauthorized: Invalid streaming token' });
        return;
      }
    }

    logger.info('Client connected to live SSE review stream', { jobId });
    bus.addClient(jobId, res);
  });

  /**
   * GET /api/live/history?jobId=...
   * Returns recent event history for a review job.
   */
  router.get('/history', (req: Request, res: Response) => {
    const jobId = (req.query.jobId as string) || 'default-job';
    const history = bus.getHistory(jobId);
    res.json({ jobId, count: history.length, events: history });
  });

  /**
   * POST /api/live/publish
   * Test/internal route to publish simulated events to a live stream.
   */
  router.post('/publish', (req: Request, res: Response) => {
    const { jobId, type, persona, data } = req.body;
    if (!jobId || !type || !persona) {
      res.status(400).json({ error: 'Missing required parameters: jobId, type, persona' });
      return;
    }

    const event = {
      jobId,
      timestamp: new Date().toISOString(),
      type,
      persona,
      data: data || {},
    };

    bus.publishEvent(event as any);
    res.status(201).json({ status: 'published', event });
  });

  return router;
}
