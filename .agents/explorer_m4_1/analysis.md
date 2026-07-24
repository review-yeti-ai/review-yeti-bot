# Milestone 4 Technical Analysis & Implementation Design
## GitHub App & Webhook Receiver Event Loop — Signature Verification & Webhook Server

**Agent**: Explorer 1 (`explorer_m4_1`)  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/explorer_m4_1`  
**Target Project Root**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`  
**Date**: 2026-07-24  

---

## 1. Executive Summary

This report provides the full technical analysis and design specification for the first two core deliverables of **Milestone 4 (GitHub App & Webhook Receiver Event Loop)** of `ct-review-bot`:
1. `src/github/signature.ts`: HMAC SHA-256 webhook signature verification module utilizing constant-time comparisons (`crypto.timingSafeEqual`) with comprehensive error and edge-case handling.
2. `src/github/webhookServer.ts`: Express web server and router component for receiving POST requests at `/webhook` and `/api/webhook/github`, preserving raw body bytes for HMAC computation, managing secrets (`WEBHOOK_SECRET` / `GITHUB_WEBHOOK_SECRET`), and returning standard HTTP status codes (200, 401, 400, 500).
3. Dependency Audit: Complete verification of existing Node.js modules and NPM package dependencies in `package.json`.

---

## 2. Package Dependency Audit (`package.json`)

An audit of `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/package.json` confirms the following available dependencies:

| Package | Version | Purpose & Usage in Milestone 4 |
|---|---|---|
| `express` | `^4.19.2` | Web server framework for receiving HTTP POST requests on `/webhook`. Natively supports raw body retention via `express.json({ verify })`. |
| `@types/express` | `^4.17.21` | TypeScript declarations for Express requests, responses, routers, and custom middleware interfaces (`RequestWithRawBody`). |
| `@octokit/core` | `^6.1.2` | Official GitHub API core REST/GraphQL client for authenticated operations. |
| `zod` | `^3.23.8` | Schema validation for config parser and webhook payload structures. |
| `js-yaml` | `^4.1.0` | Parsing YAML configurations (`.ct-review.yaml`). |
| `better-sqlite3` | `^11.0.0` | SQLite database driver for state persistence (with JSON atomic file fallback). |
| `vitest` | `^1.6.0` | Fast unit & integration test runner. |
| `supertest` | `^7.0.0` | HTTP assertion library for testing Express endpoints without opening network sockets. |
| `node:crypto` | Native Node.js Module | Built-in crypto module providing `createHmac` and `timingSafeEqual`. |

**Findings & Recommendations**:
- No additional external NPM packages are required for signature verification or webhook server construction.
- Node.js built-in `crypto` module provides all necessary HMAC SHA-256 hashing and timing-safe comparison mechanisms.
- Express 4.x natively handles JSON parsing with raw body retention via the `verify` callback option.

---

## 3. Implementation Spec: `src/github/signature.ts`

### 3.1 Architecture & HMAC Mechanics
GitHub signs webhook payloads using HMAC SHA-256.
- Header name: `X-Hub-Signature-256` (case-insensitive in HTTP headers).
- Format: `sha256=<64_hex_chars>` (e.g. `sha256=a1b2c3d4...`).
- Secret: Shared secret configured in repository webhook settings or environment (`WEBHOOK_SECRET`).

### 3.2 Security: Constant-Time Comparison & Node.js Edge Cases
1. **Timing Attack Vulnerability**: Comparing strings using `===` or `==` short-circuits on the first mismatch, allowing timing attacks to recover signature bytes.
2. **`crypto.timingSafeEqual` Safety Rule**: Node.js `crypto.timingSafeEqual(bufA, bufB)` requires `bufA.length === bufB.length`. If lengths differ, Node.js throws a `TypeError: Input buffers must have the same byte length`.
3. **Mitigation Strategy**:
   - Verify string length of calculated signature vs received signature before executing `crypto.timingSafeEqual`.
   - Wrap comparison in a try/catch block to prevent uncaught crypto exceptions from taking down the process.

### 3.3 Input Types & Edge Case Handling
- **`signatureHeader`**: Supports `string`, `string[]` (takes first array element), `undefined`, or `null`. Returns `false` or detailed error if header is missing, empty, or does not start with `sha256=`.
- **`rawBody`**: Supports `Buffer` (primary wire payload), `string` (UTF-8 encoded string), or `object` (JSON fallback if raw body buffer was detached).
- **`secret`**: Returns `false` or detailed error if secret is missing or empty.

### 3.4 Proposed Implementation Code (`src/github/signature.ts`)

```typescript
import crypto from 'crypto';

export interface VerifySignatureOptions {
  /** The value of the X-Hub-Signature-256 header */
  signatureHeader?: string | string[];
  /** The exact raw payload body as a Buffer, string, or object fallback */
  rawBody?: Buffer | string | object;
  /** The secret key used for HMAC SHA-256 hashing */
  secret?: string;
}

export type SignatureVerificationReason =
  | 'valid'
  | 'missing_header'
  | 'malformed_header'
  | 'missing_secret'
  | 'mismatch'
  | 'internal_error';

export interface SignatureVerificationResult {
  isValid: boolean;
  reason: SignatureVerificationReason;
  error?: string;
}

/**
 * Computes expected GitHub HMAC SHA-256 signature for a payload.
 *
 * @param rawBody - The raw payload as a Buffer, UTF-8 string, or JSON object fallback
 * @param secret - The webhook secret string
 * @returns Signature string formatted as "sha256=<hex_digest>"
 */
export function computeGitHubSignature(
  rawBody: Buffer | string | object,
  secret: string
): string {
  if (!secret || secret.trim() === '') {
    throw new Error('Webhook secret is required to compute signature');
  }

  let bodyBuffer: Buffer;
  if (Buffer.isBuffer(rawBody)) {
    bodyBuffer = rawBody;
  } else if (typeof rawBody === 'string') {
    bodyBuffer = Buffer.from(rawBody, 'utf-8');
  } else if (typeof rawBody === 'object' && rawBody !== null) {
    bodyBuffer = Buffer.from(JSON.stringify(rawBody), 'utf-8');
  } else {
    bodyBuffer = Buffer.from('', 'utf-8');
  }

  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(bodyBuffer).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Detailed verification of GitHub webhook signature returning reason and error message.
 *
 * @param options - Verification parameters (signatureHeader, rawBody, secret)
 * @returns Detailed SignatureVerificationResult object
 */
export function verifyGitHubSignatureDetailed(
  options: VerifySignatureOptions
): SignatureVerificationResult {
  const { signatureHeader, rawBody, secret } = options;

  if (!secret || secret.trim() === '') {
    return {
      isValid: false,
      reason: 'missing_secret',
      error: 'Webhook secret is not configured',
    };
  }

  let sigHeaderStr: string | undefined;
  if (Array.isArray(signatureHeader)) {
    sigHeaderStr = signatureHeader[0];
  } else if (typeof signatureHeader === 'string') {
    sigHeaderStr = signatureHeader;
  }

  if (!sigHeaderStr || sigHeaderStr.trim() === '') {
    return {
      isValid: false,
      reason: 'missing_header',
      error: 'X-Hub-Signature-256 header is missing or empty',
    };
  }

  if (!sigHeaderStr.startsWith('sha256=')) {
    return {
      isValid: false,
      reason: 'malformed_header',
      error: 'X-Hub-Signature-256 header must start with "sha256="',
    };
  }

  if (rawBody === undefined || rawBody === null) {
    return {
      isValid: false,
      reason: 'internal_error',
      error: 'Raw request body is missing',
    };
  }

  try {
    const expectedSig = computeGitHubSignature(rawBody, secret);

    const sigBuf = Buffer.from(sigHeaderStr, 'utf-8');
    const calcBuf = Buffer.from(expectedSig, 'utf-8');

    // Node.js crypto.timingSafeEqual throws if buffer lengths do not match exactly.
    if (sigBuf.length !== calcBuf.length) {
      return {
        isValid: false,
        reason: 'mismatch',
        error: 'Signature length mismatch',
      };
    }

    const isValid = crypto.timingSafeEqual(sigBuf, calcBuf);
    return isValid
      ? { isValid: true, reason: 'valid' }
      : { isValid: false, reason: 'mismatch', error: 'Signature hash does not match' };
  } catch (err: any) {
    return {
      isValid: false,
      reason: 'internal_error',
      error: `Crypto verification failed: ${err?.message || 'unknown error'}`,
    };
  }
}

/**
 * Verifies GitHub HMAC SHA-256 signature in constant time.
 *
 * @param signatureHeader - X-Hub-Signature-256 header string or array
 * @param rawBody - Request raw body buffer, string, or object
 * @param secret - Webhook secret string
 * @returns boolean true if valid, false otherwise
 */
export function verifyGitHubSignature(
  signatureHeader: string | string[] | undefined,
  rawBody: Buffer | string | object | undefined,
  secret: string
): boolean {
  return verifyGitHubSignatureDetailed({ signatureHeader, rawBody, secret }).isValid;
}
```

---

## 4. Implementation Spec: `src/github/webhookServer.ts`

### 4.1 Raw Body Preservation Architecture
For HMAC verification to succeed, Express must retain the exact raw byte stream of incoming HTTP requests before any JSON transformation occurs.
`express.json` is configured with a custom `verify` callback function:

```typescript
export interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

const rawBodyMiddleware = express.json({
  verify: (req: RequestWithRawBody, _res: Response, buf: Buffer) => {
    req.rawBody = buf;
  },
});
```

### 4.2 Webhook Secret Resolution Priority
Secret management checks sources in the following precedence:
1. Programmatically provided `options.secret`
2. `process.env.WEBHOOK_SECRET`
3. `process.env.GITHUB_WEBHOOK_SECRET`
4. Default development secret: `'development-webhook-secret-key-12345'`

### 4.3 HTTP Status Code Mapping

| Status Code | Condition | Response Body JSON Format |
|---|---|---|
| **200 OK** | Signature valid, event processed/received/ponged. | `{ "status": "pong" }` (for ping) or `{ "status": "processed", ... }` |
| **401 Unauthorized** | Missing, empty, malformed, or mismatched HMAC signature. | `{ "error": "Invalid or missing signature" }` |
| **400 Bad Request** | Malformed JSON payload or invalid body structure. | `{ "error": "Bad Request", "message": "Invalid JSON body or malformed payload" }` |
| **500 Internal Server Error** | Unexpected internal exception or processing error. | `{ "error": "Internal Server Error", "message": "<error_message>" }` |

### 4.4 Proposed Implementation Code (`src/github/webhookServer.ts`)

```typescript
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
  return 'development-webhook-secret-key-12345';
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

  // Middleware 2: JSON Body Parsing Error Handler (HTTP 400 Bad Request)
  router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err && (err instanceof SyntaxError || err.type === 'entity.parse.failed' || err.status === 400)) {
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
        return res.status(200).json(handlerResult);
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

  // Mount at primary path and standard API alias path
  router.post(primaryPath, webhookHandler);
  if (primaryPath !== '/api/webhook/github') {
    router.post('/api/webhook/github', webhookHandler);
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
```

---

## 5. Integration Plan with `src/app.ts` and Milestone 4

The modular `verifyGitHubSignature` and `createWebhookRouter` functions replace the inline handler currently in `src/app.ts`.

In `src/app.ts`:
```typescript
import { createWebhookRouter } from './github/webhookServer';
import { handleWebhookEvent } from './github/eventHandler';

// Inside createApp():
const webhookRouter = createWebhookRouter({
  onEvent: handleWebhookEvent,
});
app.use(webhookRouter);
```

This guarantees:
1. Strict separation of concerns (Crypto / Auth -> HTTP Server / Router -> Event Dispatcher -> Quorum / Persistence -> Comment Publisher).
2. Clean unit test isolation for signature validation, webhook server status responses, and event handlers.
3. 100% backward compatibility with all Milestone 1, 2, and 3 test suites.
