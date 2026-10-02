import { Router, Request, Response } from 'express';
import { dashboardStore } from '../persistence/dashboardStore';
import { AnalyticsTimeRange } from '../types/analytics';

function parseAndValidateWindow(req: Request): {
  valid: boolean;
  range: AnalyticsTimeRange;
  repo?: string;
  interval: string;
  error?: string;
} {
  const rawRange = req.query.range || req.query.window;
  let range: AnalyticsTimeRange = '7d';

  if (rawRange !== undefined && rawRange !== null && String(rawRange).trim().length > 0) {
    const rangeStr = String(rawRange).trim();
    if (!['24h', '7d', '30d'].includes(rangeStr)) {
      return {
        valid: false,
        range: '7d',
        interval: 'day',
        error: `Unsupported range: ${rangeStr}. Must be one of: 24h, 7d, 30d`,
      };
    }
    range = rangeStr as AnalyticsTimeRange;
  }

  const repo = typeof req.query.repo === 'string' && req.query.repo.trim().length > 0
    ? req.query.repo.trim()
    : undefined;

  const rawInterval = typeof req.query.interval === 'string' && req.query.interval.trim().length > 0
    ? req.query.interval.trim()
    : 'day';
  const interval = ['hour', 'day', 'week', 'month'].includes(rawInterval) ? rawInterval : 'day';

  return { valid: true, range, repo, interval };
}

export function createAnalyticsRouter(): Router {
  const router = Router();

  // GET /api/analytics/summary
  router.get('/summary', (req: Request, res: Response) => {
    const parsed = parseAndValidateWindow(req);
    if (!parsed.valid) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    const summary = dashboardStore.getAnalyticsSummary(parsed.range, parsed.repo);
    return res.status(200).json({
      success: true,
      summary,
    });
  });

  // GET /api/analytics/latency
  router.get('/latency', (req: Request, res: Response) => {
    const parsed = parseAndValidateWindow(req);
    if (!parsed.valid) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    const latencyData = dashboardStore.getLatencyAnalytics(parsed.range, parsed.repo);
    return res.status(200).json({
      success: true,
      ...latencyData,
    });
  });

  // GET /api/analytics/costs
  router.get('/costs', (req: Request, res: Response) => {
    const parsed = parseAndValidateWindow(req);
    if (!parsed.valid) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    const costs = dashboardStore.getCostBreakdown(parsed.range, parsed.repo);
    return res.status(200).json({
      success: true,
      ...costs,
    });
  });

  // GET /api/analytics/tokens
  router.get('/tokens', (req: Request, res: Response) => {
    const parsed = parseAndValidateWindow(req);
    if (!parsed.valid) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    const tokenData = dashboardStore.getTokenTimeSeries(parsed.range, parsed.repo, parsed.interval);
    const dataPoints = Array.isArray(tokenData.data)
      ? tokenData.data
      : Array.isArray(tokenData)
      ? [...tokenData]
      : [];
    return res.status(200).json({
      success: true,
      range: tokenData.range || parsed.range,
      window: tokenData.window || parsed.range,
      interval: tokenData.interval || parsed.interval,
      totalTokens: tokenData.totalTokens,
      promptTokens: tokenData.promptTokens,
      completionTokens: tokenData.completionTokens,
      data: dataPoints,
    });
  });

  // GET /api/analytics/findings
  router.get('/findings', (req: Request, res: Response) => {
    const parsed = parseAndValidateWindow(req);
    if (!parsed.valid) {
      return res.status(400).json({ success: false, error: parsed.error });
    }
    const findingsData = dashboardStore.getFindingsQualityMetrics(parsed.range, parsed.repo);
    return res.status(200).json({
      success: true,
      ...findingsData,
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
