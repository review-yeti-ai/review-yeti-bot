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
   * Gracefully falls back to public unauthenticated streaming if token is missing or invalid.
   */
  router.get('/stream', (req: Request, res: Response) => {
    const jobId = (req.query.jobId as string) || 'default-job';
    const queryToken = (req.query.token as string) || (req.query.access_token as string);

    let authenticated = false;
    if (queryToken) {
      const session = authService.validateSession(queryToken);
      const isApiKey = authService.validateApiKey(queryToken);
      if (session || isApiKey) {
        authenticated = true;
        logger.info('Authenticated live SSE client connected', { jobId });
      } else {
        logger.info('Invalid streaming token provided, proceeding with unauthenticated live SSE stream', { jobId });
      }
    } else {
      logger.info('Public unauthenticated live SSE client connected', { jobId });
    }

    logger.info('Client connected to live SSE review stream', { jobId, authenticated });
    bus.addClient(jobId, res);
  });

  /**
   * GET /api/live/active and GET /api/live/jobs
   * Returns active/recent jobs from LiveStreamBus for dashboard sidebar.
   */
  const handleGetActiveJobs = (_req: Request, res: Response) => {
    let jobs = bus.getActiveJobs();
    if (jobs.length === 0) {
      try {
        const { dashboardStore } = require('../persistence/dashboardStore');
        const logs = dashboardStore.getReviewLogs();
        if (logs && logs.length > 0) {
          jobs = logs.slice(0, 10).map((log: any) => {
            const jobId = log.id || `job_${(log.repo || 'unknown/repo').replace(/\//g, '_')}_pr${log.prNumber ?? 0}`;
            const promptTokens = log.tokens?.prompt ?? 0;
            const completionTokens = log.tokens?.completion ?? 0;
            const totalTokens = log.tokens?.total || promptTokens + completionTokens;

            return {
              jobId,
              repo: log.repo || 'unknown/repo',
              prNumber: log.prNumber ?? 0,
              status: 'completed',
              personaProgress: {},
              tokenMetrics: {
                promptTokens,
                completionTokens,
                totalTokens,
                estimatedCostUSD: log.costUSD ?? 0,
              },
              startTime: log.timestamp || new Date().toISOString(),
              endTime: log.timestamp || new Date().toISOString(),
              eventCount: log.personaLogs ? Object.keys(log.personaLogs).length * 3 : 12,
              lastEventTime: log.timestamp || new Date().toISOString(),
            };
          });
        }
      } catch {
        // Ignore fallback errors
      }
    }
    const queueMetrics = bus.getQueueMetrics();
    res.json({
      success: true,
      count: jobs.length,
      activeJobsCount: queueMetrics.activeJobsCount,
      queuedJobsCount: queueMetrics.queuedJobsCount,
      maxConcurrentJobs: queueMetrics.maxConcurrentJobs,
      queueMetrics,
      jobs,
    });
  };

  router.get('/active', handleGetActiveJobs);
  router.get('/jobs', handleGetActiveJobs);

  /**
   * GET /api/live/queue
   * Returns current queue metrics and concurrency limits.
   */
  router.get('/queue', (_req: Request, res: Response) => {
    const queueMetrics = bus.getQueueMetrics();
    res.json({
      success: true,
      activeJobsCount: queueMetrics.activeJobsCount,
      queuedJobsCount: queueMetrics.queuedJobsCount,
      maxConcurrentJobs: queueMetrics.maxConcurrentJobs,
      queueMetrics,
    });
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
