import express, { type Express, type NextFunction, type Request, type Response, type RequestHandler, type Router } from 'express';
import { createActionDispatchRouter, type ActionDispatchRouterOptions } from './api/actionDispatchApi';
import { MAX_COMPLETION_BYTES } from './review/workerReviewCompletion';
import { createRateLimiter } from './security/rateLimiter';
import { createWebhookRouter, type RequestWithRawBody } from './github/webhookServer';
import type { GitHubWebhookAdmissionEvent } from './review/githubWebhookAdmission';
import { createReviewCiRouter, type ReviewCiRouterOptions } from './api/reviewCiApi';
import { getPrometheusMetrics } from './telemetry/metrics';
import type { McpServerConfig } from './config/actionDispatchConfig';
import { McpAuthenticator } from './mcp/server/mcpAuthenticator';
import { SlidingWindowRateLimiter } from './mcp/server/mcpRateLimiter';
import { createRemoteMcpRouter } from './mcp/server/remoteMcpRouter';

export interface ActionDispatchAppOptions extends ActionDispatchRouterOptions {
  databaseReady(): Promise<boolean>;
  rateLimiter?: RequestHandler;
  metricsAuthToken?: string;
  ci?: ReviewCiRouterOptions;
  githubWebhook?: {
    secret: string;
    onEvent(event: GitHubWebhookAdmissionEvent): Promise<Record<string, unknown>>;
  };
  mcpConfig?: McpServerConfig;
  mcpRouter?: Router;
  mcpAuthenticator?: McpAuthenticator;
  mcpRateLimiter?: SlidingWindowRateLimiter;
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
  // MCP Route Mounting (if enabled)
  if (options.mcpConfig?.enabled) {
    const mcpPath = options.mcpConfig.path || '/api/mcp';

    // 1. Sliding-window rate limiter
    if (options.mcpRateLimiter) {
      app.use(mcpPath, options.mcpRateLimiter.middleware());
    } else {
      const rateLimiter = new SlidingWindowRateLimiter({
        windowMs: options.mcpConfig.rateLimit?.windowMs ?? options.mcpConfig.rateLimitWindowMs ?? 60_000,
        maxRequests: options.mcpConfig.rateLimit?.max ?? options.mcpConfig.rateLimitMax ?? 60,
      });
      app.use(mcpPath, rateLimiter.middleware());
    }

    // 2. 512KB body parser for MCP routes (accommodates preflight_diff_review)
    app.use(mcpPath, express.json({ limit: '512kb', strict: true }));

    // 3. Tiered payload bound enforcement: 64KB standard, 512KB for preflight_diff_review
    app.use(mcpPath, (req: Request, _res: Response, next: NextFunction) => {
      const contentLength = Number(req.header('content-length') || 0);
      if (contentLength > 64 * 1024 || (req.body && JSON.stringify(req.body).length > 64 * 1024)) {
        const isDiffReview = req.body?.method === 'tools/call' && req.body?.params?.name === 'preflight_diff_review';
        if (!isDiffReview) {
          const error: any = new Error('request entity too large');
          error.type = 'entity.too.large';
          error.status = 413;
          error.statusCode = 413;
          return next(error);
        }
      }
      return next();
    });

    // 4. Remote MCP Router mounting
    const mcpRouter = options.mcpRouter || createRemoteMcpRouter({
      authenticator: options.mcpAuthenticator || new McpAuthenticator({
        staticAuthToken: options.mcpConfig.authToken,
        oidcVerifier: options.verifier,
      }),
      sessionTtlMs: options.mcpConfig.sessionTtlMs,
      maxSessions: options.mcpConfig.maxSessions,
    });
    app.use(mcpPath, mcpRouter);
  }

  // Only the typed completion endpoint accepts bounded full persona evidence.
  // Action admission retains its smaller limit and strict request schema.
  app.use('/api/dispatch/completion', express.json({ limit: MAX_COMPLETION_BYTES, strict: true }));
  app.use(express.json({ limit: '64kb', strict: true }));

  app.get('/', (request: Request, response: Response) => {
    const payload = {
      status: 'ok',
      service: 'review-yeti-action-dispatch',
      timestamp: new Date().toISOString(),
      health: '/health',
      ready: '/ready',
      landing: 'https://review-bot.calltelemetry.com',
    };
    const acceptsHtml = request.headers.accept?.includes('text/html');
    const prefersJson = request.headers.accept?.includes('application/json');
    if (acceptsHtml && !prefersJson) {
      return response.status(200).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Review Yeti Action Dispatch</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 2rem; max-width: 600px; margin: auto; background: #0f172a; color: #f8fafc; }
    h1 { color: #38bdf8; }
    .status { padding: 0.5rem 1rem; background: #064e3b; color: #34d399; border-radius: 4px; display: inline-block; font-weight: bold; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
    ul { list-style: none; padding: 0; }
    li { margin: 0.5rem 0; }
  </style>
</head>
<body>
  <h1>Review Yeti Action Dispatch</h1>
  <p><span class="status">Operational (200 OK)</span></p>
  <p>Service: <code>${payload.service}</code></p>
  <ul>
    <li>Health Check: <a href="${payload.health}">${payload.health}</a></li>
    <li>Readiness Check: <a href="${payload.ready}">${payload.ready}</a></li>
  </ul>
</body>
</html>`);
    }
    return response.status(200).json(payload);
  });

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
    const err = error as { type?: string; status?: number; statusCode?: number };
    if (err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413) {
      return response.status(413).json({ error: 'Request body exceeds its permitted size' });
    }
    if (error instanceof SyntaxError && ('body' in error || (error as any).message?.includes('JSON'))) {
      return response.status(400).json({ error: 'Invalid JSON body' });
    }
    return next(error);
  });
  return app;
}
