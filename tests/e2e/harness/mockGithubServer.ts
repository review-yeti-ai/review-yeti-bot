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
  changedFiles?: Array<{ path: string; content?: string; patch?: string }>;
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

export interface ConfigureMockGithubOptions {
  failFilesRequest?: boolean;
  filesFailStatus?: number;
}

export class MockGithubServer {
  private app: Express;
  private server: Server | null = null;
  public port: number;
  public readonly webhookSecret: string;

  private recordedReviews: Map<number, RecordedReview[]> = new Map();
  private recordedComments: Map<number, RecordedInlineComment[]> = new Map();
  private recordedRequests: RecordedHttpRequest[] = [];
  private mockFiles: Map<number, MockFile[]> = new Map();
  private failFilesRequest: boolean = false;
  private filesFailStatus: number = 429;

  constructor(options: MockGithubServerOptions = {}) {
    this.port = options.port !== undefined ? options.port : 9092;
    this.webhookSecret = options.webhookSecret || 'development-webhook-secret-key-12345';
    this.app = express();
    this.app.use(express.json());
    this.setupRoutes();
  }

  public configure(options: ConfigureMockGithubOptions): void {
    if (options.failFilesRequest !== undefined) {
      this.failFilesRequest = options.failFilesRequest;
    }
    if (options.filesFailStatus !== undefined) {
      this.filesFailStatus = options.filesFailStatus;
    }
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

    // 3. Get Existing PR Comments
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
      if (this.failFilesRequest) {
        return res.status(this.filesFailStatus).json({
          message: 'API rate limit exceeded',
          documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
        });
      }
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

    if (options.changedFiles) {
      this.setMockFiles(
        prNumber,
        options.changedFiles.map((f) => ({
          filename: f.path,
          status: 'modified',
          additions: 5,
          deletions: 1,
          changes: 6,
          patch: f.patch || f.content,
        }))
      );
    }

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
        changed_files: options.changedFiles,
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
    this.failFilesRequest = false;
    this.filesFailStatus = 429;
  }

  public start(): Promise<string> {
    return new Promise((resolve, reject) => {
      try {
        this.server = this.app.listen(this.port, '127.0.0.1', () => {
          const addr = this.server?.address();
          if (typeof addr === 'object' && addr !== null) {
            this.port = addr.port;
          }
          resolve(`http://127.0.0.1:${this.port}`);
        });
        this.server.on('error', (err) => reject(err));
      } catch (err) {
        reject(err);
      }
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
