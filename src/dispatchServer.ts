import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createActionDispatchRouter, type ActionDispatchRouterOptions } from './api/actionDispatchApi';

export interface ActionDispatchAppOptions extends ActionDispatchRouterOptions {
  databaseReady(): Promise<boolean>;
}

export function createActionDispatchApp(options: ActionDispatchAppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
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

  app.use('/api/dispatch', createActionDispatchRouter(options));
  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof SyntaxError) return response.status(400).json({ error: 'Invalid JSON body' });
    return next(error);
  });
  return app;
}
