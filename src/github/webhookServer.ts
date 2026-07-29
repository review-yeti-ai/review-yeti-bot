import express, { Express, Router, Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { verifyGitHubSignatureDetailed } from './signature';

export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

export interface WebhookServerOptions {
  /** Optional secret override */
  secret?: string;
  /** Primary webhook route path (defaults to '/webhook') */
  path?: string;
  /** Pluggable event handler callback function */
  onEvent?: (req: RequestWithRawBody) => Promise<any>;
}

/**
 * Resolves the active GitHub Webhook Secret from options or environment variables.
 */
export function resolveWebhookSecret(overrideSecret?: string): string {
  if (overrideSecret && overrideSecret.trim() !== '') {
    return overrideSecret;
  }
  if (process.env.WEBHOOK_SECRET && process.env.WEBHOOK_SECRET.trim() !== '') {
    return process.env.WEBHOOK_SECRET;
  }
  if (process.env.GITHUB_WEBHOOK_SECRET && process.env.GITHUB_WEBHOOK_SECRET.trim() !== '') {
    return process.env.GITHUB_WEBHOOK_SECRET;
  }
  return 'default_ct_review_bot_webhook_secret';
}

/**
 * Creates an Express Router configured for GitHub Webhook handling.
 */
export function createWebhookRouter(options: WebhookServerOptions = {}): Router {
  const router = Router();
  const webhookSecret = resolveWebhookSecret(options.secret);
  const primaryPath = options.path || '/webhook';

  // Middleware 1: Parse JSON and retain raw body buffer
  router.use(
    express.json({
      verify: (req: RequestWithRawBody, _res: Response, buf: Buffer) => {
        req.rawBody = buf;
      },
    })
  );

  // Middleware 2: Security & JSON Body Parsing Error Handler
  router.use((err: any, req: RequestWithRawBody, res: Response, next: NextFunction) => {
    if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed' || err.status === 400)) {
      const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;
      if (sigHeader && req.rawBody) {
        const verification = verifyGitHubSignatureDetailed({
          signatureHeader: sigHeader,
          rawBody: req.rawBody,
          secret: webhookSecret,
        });
        if (!verification.isValid) {
          logger.warn('Webhook request with malformed JSON failed signature authentication', { reason: verification.reason });
          return res.status(401).json({ error: 'Invalid or missing signature' });
        }
      }
      logger.warn('Webhook server received malformed JSON payload', { error: err.message });
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Invalid JSON body or malformed payload',
      });
    }
    next(err);
  });

  // Core Webhook Route Handler
  const webhookHandler = async (req: RequestWithRawBody, res: Response, next: NextFunction) => {
    try {
      const sigHeader = req.headers['x-hub-signature-256'] as string | string[] | undefined;

      // 1. Signature Authentication (HTTP 401)
      const verification = verifyGitHubSignatureDetailed({
        signatureHeader: sigHeader,
        rawBody: req.rawBody,
        secret: webhookSecret,
      });

      if (!verification.isValid) {
        logger.warn('Webhook request signature authentication failed', {
          reason: verification.reason,
          error: verification.error,
        });
        return res.status(401).json({ error: 'Invalid or missing signature' });
      }

      // 2. Event Extraction
      const event = (req.headers['x-github-event'] as string) || 'ping';

      if (event === 'ping') {
        return res.status(200).json({ status: 'pong' });
      }

      // 3. Delegate to event handler if provided
      if (options.onEvent) {
        const handlerResult = await options.onEvent(req);
        if (handlerResult !== undefined) {
          if (typeof handlerResult === 'object' && handlerResult !== null) {
            return res.status(200).json(handlerResult);
          }
          return res.status(200).send(handlerResult);
        }
      }

      return res.status(200).json({ status: 'received', event });
    } catch (err: any) {
      logger.error('Unhandled exception during webhook processing', { error: err?.message || err });
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Internal Server Error',
          message: err?.message || 'Webhook processing failed',
        });
      }
      next(err);
    }
  };

  // Mount at primary path, /webhook, and standard API alias paths (both singular and plural)
  router.post(primaryPath, webhookHandler);
  if (primaryPath !== '/webhook') {
    router.post('/webhook', webhookHandler);
  }
  if (primaryPath !== '/api/webhook/github') {
    router.post('/api/webhook/github', webhookHandler);
  }
  if (primaryPath !== '/api/webhooks/github') {
    router.post('/api/webhooks/github', webhookHandler);
  }

  return router;
}

/**
 * Creates a standalone Express application for GitHub Webhook handling.
 */
export function createWebhookServer(options: WebhookServerOptions = {}): Express {
  const app = express();
  const router = createWebhookRouter(options);
  app.use('/', router);
  return app;
}
