import { Router, Request, Response } from 'express';
import { dashboardStore } from '../persistence/dashboardStore';

export function createAnalyticsRouter(): Router {
  const router = Router();

  // GET /api/analytics/summary
  router.get('/summary', (_req: Request, res: Response) => {
    const summary = dashboardStore.getAnalyticsSummary();
    return res.status(200).json({
      success: true,
      summary,
    });
  });

  // GET /api/analytics/tokens
  router.get('/tokens', (req: Request, res: Response) => {
    const range = (req.query.range as string) || '7d';
    const interval = (req.query.interval as string) || 'day';
    const data = dashboardStore.getTokenTimeSeries(range, interval);
    return res.status(200).json({
      success: true,
      range,
      interval,
      data,
    });
  });

  // GET /api/analytics/costs
  router.get('/costs', (_req: Request, res: Response) => {
    const costs = dashboardStore.getCostBreakdown();
    return res.status(200).json({
      success: true,
      ...costs,
    });
  });

  // GET /api/analytics/personas
  router.get('/personas', (_req: Request, res: Response) => {
    const personas = dashboardStore.getPersonaAnalytics();
    return res.status(200).json({
      success: true,
      personas,
    });
  });

  // GET /api/analytics/indexer
  router.get('/indexer', (_req: Request, res: Response) => {
    const rawIndexer = dashboardStore.getIndexerAnalytics();
    const indexer = (rawIndexer as any).indexer ? (rawIndexer as any).indexer : rawIndexer;
    return res.status(200).json({
      success: true,
      indexer,
    });
  });

  return router;
}
