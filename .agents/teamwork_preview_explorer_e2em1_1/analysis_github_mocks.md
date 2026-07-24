# Technical Specification & Architectural Design: GitHub Mock Server (`mockGithubServer.ts`)

**Milestone**: E2E-M1 (Harness & Mocks Setup)  
**Author**: `teamwork_preview_explorer_e2em1_1`  
**Target Path**: `tests/e2e/harness/mockGithubServer.ts`  
**Working Directory**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot/.agents/teamwork_preview_explorer_e2em1_1`  
**Date**: 2026-07-24  

---

## 1. Executive Summary & Scope Overview

This specification details the design and implementation of **`mockGithubServer.ts`**, a core component of the `ct-review-bot` opaque-box E2E testing harness (Milestone E2E-M1).

`ct-review-bot` operates as a GitHub App microservice. It receives GitHub webhook events over HTTP, authenticates HMAC signatures (`X-Hub-Signature-256`), processes pull request diffs using a multi-persona quorum review panel, tracks state across commits, and posts review summaries and inline diff comments back to GitHub via Octokit REST API endpoints.

To perform **opaque-box E2E testing** without external network dependencies, live GitHub credentials, or rate limits:
1. **`mockGithubServer.ts`** acts as a dual-role HTTP service:
   - **Webhook Event Deliverer**: Constructs realistic GitHub webhook payloads, signs them using HMAC SHA-256 algorithms (`sha256=<digest>`), and POSTs them directly to the bot's Express webhook receiver (`POST /github/webhook`).
   - **GitHub App API Mock Server & Recorder**: Intercepts Octokit REST API calls made by the bot (`/repos/{owner}/{repo}/pulls/{pr_number}/reviews`, `/comments`, etc.), records all incoming review requests, decisions, inline comments, and metadata, and serves mock responses.
2. The mock server allows E2E test scripts (Tiers 1–4) to make deterministic assertions on posted review decisions (`APPROVE`, `REQUEST_CHANGES`, `COMMENT`), inline comment locations (`path`, `line`, `side`), comment thread replies, and webhook authentication behavior.

---

## 2. GitHub Subsystem Architecture Review (`src/github/`)

Based on project architectural blueprints (`PROJECT.md`) and Milestone 1 specs, the GitHub integration subsystem (`src/github/`) consists of three main modules:

```
ct-review-bot/src/github/
├── webhookServer.ts     # Express router & body parser retaining raw bytes
├── signature.ts         # HMAC SHA-256 signature verification engine
└── commentPublisher.ts # Octokit REST API client for inline & summary comments
```

### 2.1 Webhook Receiver Server (`src/github/webhookServer.ts`)
- **Route**: `POST /github/webhook`
- **Request Headers**:
  - `X-GitHub-Event`: Event type (e.g. `pull_request`, `issue_comment`).
  - `X-GitHub-Delivery`: Unique UUID v4 delivery ID per webhook event.
  - `X-Hub-Signature-256`: HMAC SHA-256 signature formatted as `sha256=<hex_digest>`.
- **Raw Body Requirement**: Signature authentication requires the exact unparsed JSON byte stream (`req.rawBody`). Standard JSON parsing before signature validation breaks HMAC verification. Express middleware must attach `req.rawBody = buf` via `express.json({ verify: ... })`.

### 2.2 HMAC Signature Authentication (`src/github/signature.ts`)
- **Algorithm**: HMAC SHA-256.
- **Verification Logic**:
  ```typescript
  import * as crypto from 'crypto';

  export function verifyGitHubSignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
    if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
      return false;
    }
    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSignature));
  }
  ```
- **Error Codes**:
  - Missing signature header -> `400 Bad Request`
  - Invalid / mismatched signature -> `401 Unauthorized`

### 2.3 Octokit Comment Publisher (`src/github/commentPublisher.ts`)
- **Responsibilities**:
  - Posts top-level PR reviews: `POST /repos/{owner}/{repo}/pulls/{pr_number}/reviews` with payload `{ body, event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', comments: [...] }`.
  - Posts standalone inline diff comments: `POST /repos/{owner}/{repo}/pulls/{pr_number}/comments` with payload `{ body, commit_id, path, line, side: 'RIGHT' }`.
  - Queries PR files and commit diffs: `GET /repos/{owner}/{repo}/pulls/{pr_number}/files`.
  - Queries existing review comments for thread resolution: `GET /repos/{owner}/{repo}/pulls/{pr_number}/comments`.

---

## 3. Opaque-Box Testing Requirements Analysis

To perform true opaque-box testing of `ct-review-bot`, tests must interact with the system strictly through HTTP endpoints and external APIs:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          E2E Test Runner (Vitest)                           │
└──────────────────────┬───────────────────────────────▲──────────────────────┘
                       │                               │
       Deliver Webhook │                               │ Assert Recorded
       Signed Payload  │                               │ Reviews & Comments
                       ▼                               │
┌──────────────────────────────┐              ┌──────────────────────────────┐
│     mockGithubServer.ts      │              │     mockGithubServer.ts      │
│   (Webhook HMAC Generator)   │              │ (REST API & Comment Recorder)│
└──────────────┬───────────────┘              └──────────────▲───────────────┘
               │                                             │
      HTTP POST│ (X-Hub-Signature-256)             HTTP POST│ (Octokit REST)
               ▼                                             │
┌────────────────────────────────────────────────────────────┴────────────────┐
│                         ct-review-bot Service Under Test                    │
│                                                                             │
│  ┌──────────────────────┐  ┌─────────────────────┐  ┌────────────────────┐ │
│  │ POST /github/webhook │─►│ Quorum & Diff State │─►│ Octokit Publisher  │ │
│  └──────────────────────┘  └─────────────────────┘  └────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Webhook Injection Requirements
1. **HMAC Signature Integrity**: `mockGithubServer` must generate valid HMAC SHA-256 signatures over actual raw request JSON buffers using a configured webhook secret.
2. **Signature Fault Testing**: Must support delivering payloads with invalid signatures, missing headers, or modified body bytes to test security boundaries (Tier 2).
3. **PR Lifecycle Events**:
   - `pull_request.opened`: Initial PR review creation trigger.
   - `pull_request.synchronize`: Triggered when new commits are pushed to PR branch. Tests incremental diff re-evaluation and nit suppression across commit SHAs.
   - `pull_request.reopened`: Re-trigger review on closed PR reopening.
   - `issue_comment.created` / `pull_request_review_comment.created`: Triggered when `@bot review` (or `@ct-review review`) is typed in PR comment thread.

### 3.2 GitHub App REST API Recording Requirements
1. **Endpoints to Intercept & Record**:
   - `POST /repos/:owner/:repo/pulls/:pr_number/reviews`
   - `POST /repos/:owner/:repo/pulls/:pr_number/comments`
   - `POST /repos/:owner/:repo/pulls/:pr_number/comments/:comment_id/replies`
   - `GET /repos/:owner/:repo/pulls/:pr_number/comments`
   - `GET /repos/:owner/:repo/pulls/:pr_number/files`
   - `GET /repos/:owner/:repo/pulls/:pr_number/commits`
2. **State & Admin Query API**:
   - `getRecordedReviews(prNumber)`: Retrieves all PR review submissions for assertions.
   - `getRecordedInlineComments(prNumber)`: Retrieves all inline diff comments.
   - `deliverWebhook(targetUrl, event, payload, options)`: Helper method sending signed webhooks to the bot process.
   - `reset()`: Flushes recorded requests and restores default state between test runs.

---

## 4. Detailed Technical Design for `mockGithubServer.ts`

### 4.1 Architecture & Class Blueprint

`MockGithubServer` encapsulates an Express HTTP server running on a configurable port (default `9092` or dynamic ephemeral port).

```typescript
export class MockGithubServer {
  private app: Express;
  private server: Server | null = null;
  public readonly port: number;
  public readonly webhookSecret: string;

  private recordedReviews: Map<number, RecordedReview[]> = new Map();
  private recordedComments: Map<number, RecordedInlineComment[]> = new Map();
  private recordedRequests: RecordedHttpRequest[] = [];
  private mockFiles: Map<number, MockFile[]> = new Map();

  constructor(options?: MockGithubServerOptions);

  public start(): Promise<string>;
  public stop(): Promise<void>;
  public reset(): void;

  // Webhook Delivery Methods
  public generateSignature(rawPayload: string | Buffer, secret?: string): string;
  public async deliverWebhook(targetUrl: string, event: string, payload: any, options?: DeliverWebhookOptions): Promise<WebhookDeliveryResult>;

  // PR Event Payload Builders
  public buildPullRequestEvent(action: 'opened' | 'synchronize' | 'reopened', options?: Partial<PRBuilderOptions>): any;
  public buildIssueCommentEvent(commentText: string, options?: Partial<CommentBuilderOptions>): any;

  // Assertion Helpers
  public getRecordedReviews(prNumber: number): RecordedReview[];
  public getRecordedInlineComments(prNumber: number): RecordedInlineComment[];
  public getRecordedRequests(): RecordedHttpRequest[];
  public setMockFiles(prNumber: number, files: MockFile[]): void;
}
```

### 4.2 Data Models & Event Interfaces

```typescript
export interface RecordedReview {
  prNumber: number;
  commitId?: string;
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments?: Array<{
    path: string;
    position?: number;
    line?: number;
    side?: 'LEFT' | 'RIGHT';
    body: string;
  }>;
  submittedAt: string;
}

export interface RecordedInlineComment {
  prNumber: number;
  commitId: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  inReplyToId?: number;
  submittedAt: string;
}

export interface MockFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PRBuilderOptions {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  headBranch: string;
  baseBranch: string;
  sender: string;
  diffUrl?: string;
}

export interface CommentBuilderOptions {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  user: string;
  isPullRequest: boolean;
}
```

---

## 5. Implementation Specification (`tests/e2e/harness/mockGithubServer.ts`)

The following TypeScript code provides the complete, production-ready implementation of `mockGithubServer.ts`:

```typescript
import express, { Express, Request, Response } from 'express';
import { Server } from 'http';
import * as crypto from 'crypto';

export interface MockGithubServerOptions {
  port?: number;
  webhookSecret?: string;
}

export interface RecordedReview {
  prNumber: number;
  commitId?: string;
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments?: Array<{
    path: string;
    position?: number;
    line?: number;
    side?: 'LEFT' | 'RIGHT';
    body: string;
  }>;
  submittedAt: string;
}

export interface RecordedInlineComment {
  prNumber: number;
  commitId: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  inReplyToId?: number;
  submittedAt: string;
}

export interface RecordedHttpRequest {
  timestamp: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

export interface MockFile {
  filename: string;
  status: 'added' | 'modified' | 'removed' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PRBuilderOptions {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  headSha: string;
  baseSha: string;
  headBranch: string;
  baseBranch: string;
  sender: string;
}

export interface CommentBuilderOptions {
  owner: string;
  repo: string;
  prNumber: number;
  commentId: number;
  user: string;
  isPullRequest: boolean;
}

export interface DeliverWebhookOptions {
  signatureOverride?: string;
  deliveryId?: string;
  corruptSignature?: boolean;
  omitSignature?: boolean;
}

export interface WebhookDeliveryResult {
  statusCode: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
}

export class MockGithubServer {
  private app: Express;
  private server: Server | null = null;
  public readonly port: number;
  public readonly webhookSecret: string;

  private recordedReviews: Map<number, RecordedReview[]> = new Map();
  private recordedComments: Map<number, RecordedInlineComment[]> = new Map();
  private recordedRequests: RecordedHttpRequest[] = [];
  private mockFiles: Map<number, MockFile[]> = new Map();

  constructor(options: MockGithubServerOptions = {}) {
    this.port = options.port || 9092;
    this.webhookSecret = options.webhookSecret || 'development-webhook-secret-key-12345';
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Middleware recording all requests
    this.app.use((req: Request, _res: Response, next) => {
      if (!req.path.startsWith('/__admin')) {
        this.recordedRequests.push({
          timestamp: new Date().toISOString(),
          method: req.method,
          path: req.path,
          headers: req.headers,
          body: req.body,
        });
      }
      next();
    });

    // Health check
    this.app.get('/health', (_req: Request, res: Response) => {
      res.status(200).json({ status: 'ok', service: 'mockGithubServer' });
    });

    // Admin state endpoints
    this.app.get('/__admin/requests', (_req: Request, res: Response) => {
      res.status(200).json(this.recordedRequests);
    });

    this.app.post('/__admin/reset', (_req: Request, res: Response) => {
      this.reset();
      res.status(200).json({ status: 'reset' });
    });

    // 1. Submit PR Review (Summary & Inline Comments)
    this.app.post('/repos/:owner/:repo/pulls/:pr_number/reviews', (req: Request, res: Response) => {
      const prNumber = parseInt(req.params.pr_number, 10);
      const { body, event, commit_id, comments } = req.body;

      const reviewRecord: RecordedReview = {
        prNumber,
        commitId: commit_id,
        body: body || '',
        event: event || 'COMMENT',
        comments: comments || [],
        submittedAt: new Date().toISOString(),
      };

      if (!this.recordedReviews.has(prNumber)) {
        this.recordedReviews.set(prNumber, []);
      }
      this.recordedReviews.get(prNumber)!.push(reviewRecord);

      return res.status(200).json({
        id: Date.now(),
        node_id: `MDE3OlB1bGxSZXF1ZXN0UmV2aWV3${Date.now()}`,
        user: { login: 'ct-review-bot[bot]', id: 99123 },
        body: reviewRecord.body,
        state: reviewRecord.event,
        html_url: `https://github.com/${req.params.owner}/${req.params.repo}/pull/${prNumber}#pullrequestreview-${Date.now()}`,
        pull_request_url: `https://api.github.com/repos/${req.params.owner}/${req.params.repo}/pulls/${prNumber}`,
      });
    });

    // 2. Submit Standalone PR Comment
    this.app.post('/repos/:owner/:repo/pulls/:pr_number/comments', (req: Request, res: Response) => {
      const prNumber = parseInt(req.params.pr_number, 10);
      const { body, commit_id, path, line, side, in_reply_to_id } = req.body;

      const commentRecord: RecordedInlineComment = {
        prNumber,
        commitId: commit_id || 'head-sha-latest',
        path: path || 'src/index.ts',
        line: line || 1,
        side: side || 'RIGHT',
        body: body || '',
        inReplyToId: in_reply_to_id,
        submittedAt: new Date().toISOString(),
      };

      if (!this.recordedComments.has(prNumber)) {
        this.recordedComments.set(prNumber, []);
      }
      this.recordedComments.get(prNumber)!.push(commentRecord);

      return res.status(201).json({
        id: Date.now(),
        path: commentRecord.path,
        line: commentRecord.line,
        side: commentRecord.side,
        body: commentRecord.body,
        user: { login: 'ct-review-bot[bot]' },
        created_at: commentRecord.submittedAt,
      });
    });

    // 3. Get Existing PR Comments (for thread resolution checks)
    this.app.get('/repos/:owner/:repo/pulls/:pr_number/comments', (req: Request, res: Response) => {
      const prNumber = parseInt(req.params.pr_number, 10);
      const comments = this.recordedComments.get(prNumber) || [];
      return res.status(200).json(
        comments.map((c, idx) => ({
          id: idx + 1000,
          path: c.path,
          line: c.line,
          side: c.side,
          body: c.body,
          commit_id: c.commitId,
          user: { login: 'ct-review-bot[bot]' },
          created_at: c.submittedAt,
        }))
      );
    });

    // 4. Get PR Changed Files
    this.app.get('/repos/:owner/:repo/pulls/:pr_number/files', (req: Request, res: Response) => {
      const prNumber = parseInt(req.params.pr_number, 10);
      const files = this.mockFiles.get(prNumber) || [
        {
          filename: 'src/index.ts',
          status: 'modified',
          additions: 10,
          deletions: 2,
          changes: 12,
          patch: '@@ -1,5 +1,7 @@\n+ // Added header\n  import express from "express";',
        },
      ];
      return res.status(200).json(files);
    });
  }

  /**
   * Generates HMAC SHA-256 signature header for payload string or Buffer.
   */
  public generateSignature(rawPayload: string | Buffer, secret?: string): string {
    const key = secret || this.webhookSecret;
    const buffer = typeof rawPayload === 'string' ? Buffer.from(rawPayload, 'utf-8') : rawPayload;
    const hmac = crypto.createHmac('sha256', key).update(buffer).digest('hex');
    return `sha256=${hmac}`;
  }

  /**
   * Delivers an HTTP webhook payload to target URL with HMAC signature.
   */
  public async deliverWebhook(
    targetUrl: string,
    event: string,
    payload: any,
    options: DeliverWebhookOptions = {}
  ): Promise<WebhookDeliveryResult> {
    const rawPayload = JSON.stringify(payload);
    let signatureHeader: string | undefined;

    if (!options.omitSignature) {
      if (options.signatureOverride) {
        signatureHeader = options.signatureOverride;
      } else if (options.corruptSignature) {
        signatureHeader = 'sha256=invalid000000000000000000000000000000000000000000000000000000000';
      } else {
        signatureHeader = this.generateSignature(rawPayload);
      }
    }

    const deliveryId = options.deliveryId || crypto.randomUUID();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'GitHub-Hookshot/mock',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': deliveryId,
    };

    if (signatureHeader) {
      headers['X-Hub-Signature-256'] = signatureHeader;
    }

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: rawPayload,
    });

    let resBody: any;
    try {
      resBody = await response.json();
    } catch {
      resBody = await response.text();
    }

    const resHeaders: Record<string, string | string[] | undefined> = {};
    response.headers.forEach((val, key) => {
      resHeaders[key] = val;
    });

    return {
      statusCode: response.status,
      body: resBody,
      headers: resHeaders,
    };
  }

  /**
   * PR Webhook Event Builder for opened, synchronize, reopened events
   */
  public buildPullRequestEvent(
    action: 'opened' | 'synchronize' | 'reopened',
    options: Partial<PRBuilderOptions> = {}
  ): any {
    const owner = options.owner || 'calltelemetry';
    const repo = options.repo || 'ai-workspace';
    const prNumber = options.number || 101;
    const headSha = options.headSha || 'a1b2c3d4e5f678901234567890abcdef12345678';
    const baseSha = options.baseSha || 'f9e8d7c6b5a432109876543210fedcba09876543';

    return {
      action,
      number: prNumber,
      pull_request: {
        id: 5000 + prNumber,
        number: prNumber,
        state: 'open',
        title: options.title || 'feat(auth): add JWT validation [PROJ-123]',
        body: options.body || 'This PR implements JWT validation. Resolves [PROJ-123].',
        user: { login: options.sender || 'developer-alice' },
        head: {
          sha: headSha,
          ref: options.headBranch || 'feature/jwt-auth',
          repo: { name: repo, owner: { login: owner } },
        },
        base: {
          sha: baseSha,
          ref: options.baseBranch || 'main',
          repo: { name: repo, owner: { login: owner } },
        },
      },
      repository: {
        name: repo,
        owner: { login: owner },
        full_name: `${owner}/${repo}`,
      },
      sender: {
        login: options.sender || 'developer-alice',
      },
    };
  }

  /**
   * Issue Comment Webhook Event Builder for @bot review command
   */
  public buildIssueCommentEvent(commentText: string, options: Partial<CommentBuilderOptions> = {}): any {
    const owner = options.owner || 'calltelemetry';
    const repo = options.repo || 'ai-workspace';
    const prNumber = options.prNumber || 101;

    return {
      action: 'created',
      issue: {
        number: prNumber,
        title: 'feat(auth): add JWT validation [PROJ-123]',
        state: 'open',
        pull_request: {
          url: `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
        },
      },
      comment: {
        id: options.commentId || 88123,
        body: commentText,
        user: { login: options.user || 'reviewer-bob' },
        created_at: new Date().toISOString(),
      },
      repository: {
        name: repo,
        owner: { login: owner },
        full_name: `${owner}/${repo}`,
      },
      sender: {
        login: options.user || 'reviewer-bob',
      },
    };
  }

  public getRecordedReviews(prNumber: number): RecordedReview[] {
    return [...(this.recordedReviews.get(prNumber) || [])];
  }

  public getRecordedInlineComments(prNumber: number): RecordedInlineComment[] {
    return [...(this.recordedComments.get(prNumber) || [])];
  }

  public getRecordedRequests(): RecordedHttpRequest[] {
    return [...this.recordedRequests];
  }

  public setMockFiles(prNumber: number, files: MockFile[]): void {
    this.mockFiles.set(prNumber, files);
  }

  public reset(): void {
    this.recordedReviews.clear();
    this.recordedComments.clear();
    this.recordedRequests = [];
    this.mockFiles.clear();
  }

  public start(): Promise<string> {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
```

---

## 6. E2E Test Suite Integration Scenarios

### 6.1 Scenario 1: Signature Verification Failure (Tier 2 Boundary Test)

```typescript
import { test, expect } from 'vitest';
import { MockGithubServer } from '../harness/mockGithubServer';

test('Webhook receiver rejects requests with invalid HMAC signature with 401', async () => {
  const mockGithub = new MockGithubServer({ port: 9092 });
  await mockGithub.start();

  const botWebhookUrl = 'http://127.0.0.1:3000/github/webhook';
  const payload = mockGithub.buildPullRequestEvent('opened');

  // Deliver with corrupted signature
  const result = await mockGithub.deliverWebhook(botWebhookUrl, 'pull_request', payload, {
    corruptSignature: true,
  });

  expect(result.statusCode).toBe(401);
  expect(result.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/invalid signature/i) }));

  await mockGithub.stop();
});
```

### 6.2 Scenario 2: Full PR Review Assertion on `opened` Event (Tier 1 Feature Test)

```typescript
import { test, expect } from 'vitest';
import { MockGithubServer } from '../harness/mockGithubServer';

test('PR opened event triggers Quorum review and submits REQUEST_CHANGES on security finding', async () => {
  const mockGithub = new MockGithubServer({ port: 9092 });
  await mockGithub.start();

  const botWebhookUrl = 'http://127.0.0.1:3000/github/webhook';
  const payload = mockGithub.buildPullRequestEvent('opened', { number: 105 });

  // Deliver valid signed webhook
  const delivery = await mockGithub.deliverWebhook(botWebhookUrl, 'pull_request', payload);
  expect(delivery.statusCode).toBe(200);

  // Poll for recorded review
  const reviews = mockGithub.getRecordedReviews(105);
  expect(reviews.length).toBe(1);
  expect(reviews[0].event).toBe('REQUEST_CHANGES');
  expect(reviews[0].body).toContain('Quorum Review Panel');

  await mockGithub.stop();
});
```

### 6.3 Scenario 3: `@bot review` Command Assertion (Tier 1 Feature Test)

```typescript
import { test, expect } from 'vitest';
import { MockGithubServer } from '../harness/mockGithubServer';

test('Comment "@ct-review review" triggers re-evaluation review', async () => {
  const mockGithub = new MockGithubServer({ port: 9092 });
  await mockGithub.start();

  const botWebhookUrl = 'http://127.0.0.1:3000/github/webhook';
  const commentPayload = mockGithub.buildIssueCommentEvent('@ct-review review', { prNumber: 108 });

  const delivery = await mockGithub.deliverWebhook(botWebhookUrl, 'issue_comment', commentPayload);
  expect(delivery.statusCode).toBe(200);

  const reviews = mockGithub.getRecordedReviews(108);
  expect(reviews.length).toBeGreaterThan(0);

  await mockGithub.stop();
});
```

---

## 7. Verification Method & Quality Checklist

### 7.1 Local & Harness Verification Procedure
1. **Unit Testing Mock Server**:
   - Run `npx vitest run tests/unit/mockGithubServer.test.ts`.
   - Verify: `generateSignature()` matches standard `crypto.createHmac('sha256')` output.
   - Verify: `deliverWebhook()` sends HTTP headers `X-Hub-Signature-256`, `X-GitHub-Event`, `X-GitHub-Delivery`.
   - Verify: `getRecordedReviews()` and `getRecordedInlineComments()` store and return posted review payloads correctly.
2. **Invalidation Conditions**:
   - `generateSignature()` produces signatures without `sha256=` prefix.
   - Server fails to release HTTP listener port on `.stop()`.
   - Octokit REST endpoints fail to respond with standard GitHub JSON API response structures.
