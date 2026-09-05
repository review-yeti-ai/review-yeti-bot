import express, { Express, Router, Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { verifyGitHubSignatureDetailed } from './signature';
import { dashboardStore } from '../persistence/dashboardStore';
import { GitHubEventHandler, ParsedPRPayload } from './eventHandler';
import { CommandDispatcher, defaultDispatcher, ChatContext, DispatchResult } from '../chat/commandDispatcher';
import { createEphemeralChatClient } from './appAuth';
import { ReviewModelClient } from '../gateway/openRouterClient';

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
  /** Optional GitHubEventHandler instance */
  eventHandler?: GitHubEventHandler;
  /** Optional CommandDispatcher instance */
  commandDispatcher?: CommandDispatcher;
  /** Optional model client for chat completions */
  modelClient?: ReviewModelClient;
  /** Optional GitHub App configuration for minting ephemeral tokens */
  appAuthConfig?: {
    appId?: string;
    privateKey?: string;
    baseUrl?: string;
  };
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
  try {
    const storeSecret = dashboardStore.getGitHubAppConfig().webhookSecret;
    if (storeSecret && storeSecret.trim() !== '') {
      return storeSecret;
    }
  } catch (_) {}
  throw new Error('GitHub webhook secret is not configured; refusing to accept unsigned or unverifiable events');
}

/**
 * Creates an Express Router configured for GitHub Webhook handling.
 */
export function createWebhookRouter(options: WebhookServerOptions = {}): Router {
  const router = Router();
  const primaryPath = options.path || '/webhook';

  // Middleware 1: Parse JSON and retain raw body buffer
  router.use((req: RequestWithRawBody, res: Response, next: NextFunction) => {
    if (req.body !== undefined && req.rawBody !== undefined) {
      return next();
    }
    express.json({
      verify: (r: RequestWithRawBody, _res: Response, buf: Buffer) => {
        r.rawBody = buf;
      },
    })(req, res, next);
  });

  // Middleware 2: Security & JSON Body Parsing Error Handler
  router.use((err: any, req: RequestWithRawBody, res: Response, next: NextFunction) => {
    const p = req.path || '';
    const orig = req.originalUrl || '';
    const isWebhookPath = p === primaryPath || p === '/webhook' || p === '/api/webhook/github' || p === '/api/webhooks/github' || p.includes('/webhook') || orig.includes('/webhook');
    if (!isWebhookPath) {
      return next(err);
    }
    if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed' || err.status === 400)) {
      const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;
      if (sigHeader) {
        const verification = verifyGitHubSignatureDetailed({
          signatureHeader: sigHeader,
          rawBody: req.rawBody || '',
          secret: resolveWebhookSecret(options.secret),
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
      const activeSecret = resolveWebhookSecret(options.secret);
      const verification = verifyGitHubSignatureDetailed({
        signatureHeader: sigHeader,
        rawBody: req.rawBody,
        secret: activeSecret,
      });

      if (!verification.isValid) {
        logger.warn('Webhook request signature authentication failed', {
          reason: verification.reason,
          error: verification.error,
          resolvedSecretLength: activeSecret.length,
          resolvedSecretMasked: activeSecret.substring(0, 4) + '...' + activeSecret.substring(activeSecret.length - 4),
          sigHeader: sigHeader ? String(sigHeader).substring(0, 15) + '...' : 'missing',
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

      // 4. Handle chat command webhook routing if eventHandler is provided
      if (options.eventHandler) {
        const deliveryId = (req.headers['x-github-delivery'] as string) || '';
        const trigger = options.eventHandler.evaluateTrigger(event, req.body, deliveryId);

        if (trigger.shouldTrigger && trigger.parsedPayload) {
          const payload = trigger.parsedPayload;

          if (payload.triggerSource === 'comment_command' && payload.commandText) {
            const result = await handleWebhookChatEvent(payload, {
              commandDispatcher: options.commandDispatcher,
              modelClient: options.modelClient,
              appAuthConfig: options.appAuthConfig,
            });

            if (result) {
              return res.status(200).json({ status: 'dispatched', trigger, result });
            }
          }

          return res.status(200).json({ status: 'triggered', trigger });
        }

        return res.status(200).json({ status: 'ignored', reason: trigger.reason });
      }

      return res.status(200).json({ status: 'received', event });
    } catch (err: any) {
      logger.error('Unhandled exception during webhook processing', { error: err?.message || err });
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Internal Server Error',
          message: 'Webhook processing failed',
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
 * Processes a parsed comment command payload, minting an ephemeral token if needed,
 * and dispatching the chat mentoring command.
 */
export async function handleWebhookChatEvent(
  payload: ParsedPRPayload,
  options: {
    commandDispatcher?: CommandDispatcher;
    modelClient?: ReviewModelClient;
    github?: any;
    appAuthConfig?: { appId?: string; privateKey?: string; baseUrl?: string };
  } = {}
): Promise<DispatchResult | null> {
  if (payload.triggerSource !== 'comment_command' || !payload.commandText) {
    return null;
  }

  let githubClient = options.github;
  if (!githubClient && payload.installationId && (options.appAuthConfig?.appId || process.env.GITHUB_APP_ID)) {
    try {
      githubClient = await createEphemeralChatClient(payload.installationId, {
        appId: options.appAuthConfig?.appId,
        privateKey: options.appAuthConfig?.privateKey,
        baseUrl: options.appAuthConfig?.baseUrl,
      });
    } catch (err: any) {
      logger.warn('Failed to mint ephemeral token for chat event', { error: err?.message });
    }
  }

  if (!githubClient) {
    return null;
  }

  const dispatcher = options.commandDispatcher || defaultDispatcher;
  const chatContext: ChatContext = {
    owner: payload.owner,
    repo: payload.repo,
    prNumber: payload.prNumber,
    commentId: payload.commentId,
    inReplyToId: payload.inReplyToId,
    diffHunk: payload.diffHunk,
    filePath: payload.filePath,
    headSha: payload.headSha,
    baseSha: payload.baseSha,
    sender: payload.sender,
    github: githubClient,
    modelClient: options.modelClient,
    payload,
  };

  return dispatcher.dispatchCommand(payload.commandText, chatContext);
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
