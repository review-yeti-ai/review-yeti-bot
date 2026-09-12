import express, { type Express, type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import { createActionDispatchRouter, type ActionDispatchRouterOptions } from './api/actionDispatchApi';
import { MAX_COMPLETION_BYTES } from './review/workerReviewCompletion';
import { createRateLimiter } from './security/rateLimiter';
import { createWebhookRouter, type RequestWithRawBody } from './github/webhookServer';
import type { GitHubWebhookAdmissionEvent } from './review/githubWebhookAdmission';
import { createReviewCiRouter, type ReviewCiRouterOptions } from './api/reviewCiApi';
import { getPrometheusMetrics } from './telemetry/metrics';

export interface ActionDispatchAppOptions extends ActionDispatchRouterOptions {
  databaseReady(): Promise<boolean>;
  rateLimiter?: RequestHandler;
  metricsAuthToken?: string;
  ci?: ReviewCiRouterOptions;
  githubWebhook?: {
    secret: string;
    onEvent(event: GitHubWebhookAdmissionEvent): Promise<Record<string, unknown>>;
  };
}

export function createActionDispatchApp(options: ActionDispatchAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const limiter = options.rateLimiter !== undefined
    ? options.rateLimiter
    : createRateLimiter({ windowMs: 60_000, max: 60, trustProxy: true });
  // Mount before the generic JSON parser so signature verification receives
  // GitHub's exact raw bytes. The production Ingress exposes only the exact
  // /api/webhooks/github path even though the shared router keeps compatibility
  // aliases for standalone installations.
  if (options.githubWebhook) {
    app.use(createWebhookRouter({
      path: '/api/webhooks/github',
      secret: options.githubWebhook.secret,
      onEvent: (request: RequestWithRawBody) => options.githubWebhook!.onEvent({
        eventName: String(request.headers['x-github-event'] || ''),
        deliveryId: String(request.headers['x-github-delivery'] || ''),
        rawBody: request.rawBody || Buffer.alloc(0),
        body: request.body,
      }),
      rateLimiter: limiter,
    }));
  }
  // Only the typed completion endpoint accepts bounded full persona evidence.
  // Action admission retains its smaller limit and strict request schema.
  app.use('/api/dispatch/completion', express.json({ limit: MAX_COMPLETION_BYTES, strict: true }));
  app.use(express.json({ limit: '64kb', strict: true }));

  app.get('/health', (_request: Request, response: Response) => response.status(200).json({
    status: 'ok',
    service: 'review-yeti-action-dispatch',
    timestamp: new Date().toISOString(),
  }));

  app.get('/ready', async (_request: Request, response: Response) => {
    try {
      const ready = await options.databaseReady();
      return response.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        databaseReady: ready,
      });
    } catch {
      return response.status(503).json({ status: 'not_ready', databaseReady: false });
    }
  });

  const metricsAuth: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
    if (!options.metricsAuthToken) return next();
    const auth = request.headers.authorization;
    if (!auth || auth !== `Bearer ${options.metricsAuthToken}`) {
      return response.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  };

  app.get('/metrics', limiter, metricsAuth, async (_request: Request, response: Response) => {
    try {
      const text = await getPrometheusMetrics();
      response.setHeader('Content-Type', 'text/plain; charset=utf-8; version=0.0.4');
      return response.status(200).send(text);
    } catch {
      return response.status(500).send('# Error generating metrics\n');
    }
  });

  if (options.ci) app.use('/api/dispatch/ci', limiter, createReviewCiRouter(options.ci));
  app.use('/api/dispatch', limiter, createActionDispatchRouter(options));
  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error && typeof error === 'object' && 'status' in error && error.status === 413) {
      return response.status(413).json({ error: 'Request body exceeds its permitted size' });
    }
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Invalid JSON body' });
    return next(error);
  });
  return app;
}
