import express, { type Express, type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import { createActionDispatchRouter, type ActionDispatchRouterOptions } from './api/actionDispatchApi';
import { MAX_COMPLETION_BYTES } from './review/workerReviewCompletion';
import { createRateLimiter } from './security/rateLimiter';

export interface ActionDispatchAppOptions extends ActionDispatchRouterOptions {
  databaseReady(): Promise<boolean>;
  rateLimiter?: RequestHandler;
}

export function createActionDispatchApp(options: ActionDispatchAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
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

  const limiter = options.rateLimiter !== undefined
    ? options.rateLimiter
    : createRateLimiter({ windowMs: 60_000, max: 60, trustProxy: true });

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
