# Detailed Analysis & Design Specification: Webhook Event Dispatcher & Async Queue Engine (`src/github/eventHandler.ts`)

**Author**: Explorer 2 (Milestone 4)  
**Target Path**: `src/github/eventHandler.ts`  
**Project Root**: `/Users/jasonbarbee/.gemini/antigravity/worktrees/ai-workspace/build-github-review-bot/ct-review-bot`  
**Date**: 2026-07-24  

---

## 1. Executive Summary & Architectural Role

In the `ct-review-bot` service architecture, `src/github/eventHandler.ts` forms the central routing nexus between raw incoming HTTP webhooks (verified by `src/github/signature.ts` and received by `src/github/webhookServer.ts`) and the core multi-agent evaluation engines (Config Loader, Ticket Linkage, Constitution Engine, Diff State Manager, Quorum Panel, and Octokit Comment Publisher).

### Key Architectural Requirements:
1. **Immediate Webhook Response (< 100ms)**: GitHub webhooks enforce a strict HTTP response timeout (~10s). LLM multi-persona reviews require anywhere from 2s to 30s. The event handler MUST enqueue incoming valid review triggers into an asynchronous background queue and immediately acknowledge receipt with HTTP `200 OK` (or `202 Accepted`) containing a tracking `jobId`.
2. **Multi-Event Trigger Recognition**:
   - **PR Lifecycle Events**: `pull_request` (`opened`, `synchronize`, `reopened`).
   - **Comment Command Triggers**: `issue_comment` and `pull_request_review_comment` matching commands such as `@ct-review review`, `@bot review`, `@ct-review-bot review`.
   - **Label & Tag Triggers**: `pull_request` (`labeled`) or PR payloads containing target trigger labels (`ct-review`, `ai-review`, `needs-review`).
3. **Loop Prevention & Noise Filtering**: Automatic suppression of self-generated bot comments (`sender.login.includes('[bot]')` or matching `ct-review-bot[bot]`), closed PR events, and irrelevant comment text.
4. **Normalized Internal Representation**: Decouples heterogeneous GitHub payload structures (issue comments vs. PR payloads vs. inline review comments) into a single, strongly-typed `ParsedPRPayload` structure consumed by downstream engines.

---

## 2. Interface Definitions & Data Structures

To ensure strict type safety across TypeScript modules, `src/github/eventHandler.ts` defines the following core contracts:

```typescript
/**
 * Raw GitHub Webhook delivery structure passed from webhookServer
 */
export interface WebhookEvent<T = any> {
  deliveryId: string;
  eventName: string;
  payload: T;
  receivedAt: string;
}

/**
 * Normalized PR metadata extracted from any supported webhook trigger type
 */
export interface ParsedPRPayload {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  sender: string;
  labels: string[];
  changedFiles?: Array<{ path: string; content?: string; patch?: string }>;
  triggerSource: 'pr_event' | 'comment_command' | 'label_trigger';
  triggerAction: string;
  commandText?: string;
  commentId?: number;
  deliveryId: string;
}

/**
 * Trigger Evaluation Result indicating if the webhook should enqueue a review
 */
export interface TriggerResult {
  shouldTrigger: boolean;
  reason: string;
  parsedPayload?: ParsedPRPayload;
}

/**
 * Job status enumeration for background async review processing
 */
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'ignored';

/**
 * In-memory background job item stored in the queue
 */
export interface ReviewJob {
  jobId: string;
  deliveryId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  status: JobStatus;
  payload: ParsedPRPayload;
  attempt: number;
  maxRetries: number;
  error?: string;
  reviewResult?: any;
}

/**
 * Review runner function signature passed to EventHandler to execute pipeline
 */
export type ReviewRunnerCallback = (payload: ParsedPRPayload) => Promise<any>;
```

---

## 3. Trigger Logic Specifications

### 3.1 PR Event Triggers (`pull_request`)
- **Actions**: `opened`, `synchronize`, `reopened`.
- **Condition**: Triggers an automated initial or updated code review run.
- **Handling**: Extracts `head.sha`, `base.sha`, title, body, and labels directly from `payload.pull_request`.

### 3.2 Comment Command Triggers (`issue_comment` / `pull_request_review_comment`)
- **Action**: `created`
- **Regex Match**: `/@(ct-review|bot|ct-review-bot)\s+review/i`
- **PR Check**: Verifies the comment belongs to a Pull Request (`payload.issue.pull_request` exists or `payload.pull_request` exists).
- **Handling**: Normalizes metadata. If `head.sha` is missing from comment payload, marks it for API resolution or fallback extraction.

### 3.3 Label Triggers (`pull_request`: `labeled` / PR labels)
- **Action**: `labeled`
- **Configured Target Labels**: `['ct-review', 'ai-review', 'needs-review', 'bot-review']`
- **Condition**: Triggers if `payload.label.name` matches one of the target labels OR if a PR event payload contains any of the target labels in `payload.pull_request.labels`.

### 3.4 Self-Loop Guard & Suppression Rules
- **Bot Sender Guard**: Any event where `sender.login` ends with `[bot]` or equals `ct-review-bot` is ignored unless explicitly configured otherwise.
- **Draft PR Guard**: Skip draft PRs if configured (`pull_request.draft === true`).
- **Closed PR Guard**: Ignore actions on closed PRs (`pull_request.state === 'closed'`).

---

## 4. Background Async Queueing Architecture

### 4.1 Dispatch Workflow Diagram
```
  [Incoming Webhook]
          │
          ▼
┌───────────────────┐
│ WebhookServer     │ Signature Verified (X-Hub-Signature-256)
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ eventHandler      │
│  .dispatch(...)   │
└─────────┬─────────┘
          │
          ├── Evaluates Trigger (PR event / Comment / Label)
          │   └─ [No match / Bot loop] ──> Returns { status: 'ignored' } (HTTP 200)
          │
          ▼ [Trigger Valid]
┌───────────────────┐
│ AsyncJobQueue     │ Enqueues job with unique UUID
└─────────┬─────────┘
          │
          ├── Returns { status: 'queued', jobId: 'job-123' } (HTTP 200 OK immediately)
          │
          ▼ (Asynchronously in background worker)
┌───────────────────┐
│ ReviewJobWorker   │ Pops job -> Executes pipeline callback -> Updates status
└───────────────────┘
```

### 4.2 Queue & Worker Mechanics
1. **Concurrency Control**: Defaults to `maxConcurrency = 3` concurrent review tasks.
2. **Retry Mechanism**: If transient network or rate-limit errors occur during LLM evaluation, jobs retry up to `maxRetries = 2` times with backoff.
3. **Ring Buffer Storage**: Retains recent 500 completed/failed jobs in `jobStore` for status inspection (`getJobStatus(jobId)`).
4. **Shutdown Management**: Provides `drainAndStop()` for graceful teardown during container termination (SIGTERM).

---

## 5. Design Blueprint: `src/github/eventHandler.ts`

Below is the complete implementation spec for `src/github/eventHandler.ts`:

```typescript
import crypto from 'crypto';
import { logger } from '../utils/logger';

export interface WebhookEvent<T = any> {
  deliveryId: string;
  eventName: string;
  payload: T;
  receivedAt: string;
}

export interface ParsedPRPayload {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  title: string;
  body: string;
  sender: string;
  labels: string[];
  changedFiles?: Array<{ path: string; content?: string; patch?: string }>;
  triggerSource: 'pr_event' | 'comment_command' | 'label_trigger';
  triggerAction: string;
  commandText?: string;
  commentId?: number;
  deliveryId: string;
}

export interface TriggerResult {
  shouldTrigger: boolean;
  reason: string;
  parsedPayload?: ParsedPRPayload;
}

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'ignored';

export interface ReviewJob {
  jobId: string;
  deliveryId: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  status: JobStatus;
  payload: ParsedPRPayload;
  attempt: number;
  maxRetries: number;
  error?: string;
  reviewResult?: any;
}

export type ReviewRunnerCallback = (payload: ParsedPRPayload) => Promise<any>;

export interface EventHandlerOptions {
  triggerLabels?: string[];
  maxConcurrency?: number;
  reviewRunner?: ReviewRunnerCallback;
}

export class GitHubEventHandler {
  private triggerLabels: Set<string>;
  private maxConcurrency: number;
  private reviewRunner?: ReviewRunnerCallback;
  private queue: ReviewJob[] = [];
  private activeJobsCount = 0;
  private jobStore: Map<string, ReviewJob> = new Map();
  private maxStoreSize = 500;

  constructor(options: EventHandlerOptions = {}) {
    this.triggerLabels = new Set(options.triggerLabels || ['ct-review', 'ai-review', 'needs-review', 'bot-review']);
    this.maxConcurrency = options.maxConcurrency || 3;
    this.reviewRunner = options.reviewRunner;
  }

  public setReviewRunner(runner: ReviewRunnerCallback): void {
    this.reviewRunner = runner;
  }

  /**
   * Evaluates an incoming raw webhook event to determine if it should trigger a review.
   */
  public evaluateTrigger(eventName: string, payload: any, deliveryId: string): TriggerResult {
    const sender = payload.sender?.login || '';
    if (sender.includes('[bot]') || sender === 'ct-review-bot') {
      return { shouldTrigger: false, reason: `Ignored bot action from sender: ${sender}` };
    }

    if (eventName === 'pull_request') {
      const action = payload.action;
      const pr = payload.pull_request || {};
      const repo = payload.repository || {};
      const owner = repo.owner?.login || 'calltelemetry';
      const repoName = repo.name || 'ai-workspace';
      const prNumber = pr.number || payload.number || 0;

      if (pr.state === 'closed') {
        return { shouldTrigger: false, reason: 'PR is closed' };
      }

      const labels = Array.isArray(pr.labels) ? pr.labels.map((l: any) => typeof l === 'string' ? l : l.name) : [];
      const hasTriggerLabel = labels.some((lbl) => this.triggerLabels.has(lbl));

      if (['opened', 'synchronize', 'reopened'].includes(action) || (action === 'labeled' && hasTriggerLabel)) {
        const parsed: ParsedPRPayload = {
          owner,
          repo: repoName,
          prNumber,
          headSha: pr.head?.sha || 'head-sha-latest',
          baseSha: pr.base?.sha || 'base-sha-latest',
          title: pr.title || '',
          body: pr.body || '',
          sender,
          labels,
          changedFiles: pr.changed_files || pr.files,
          triggerSource: action === 'labeled' ? 'label_trigger' : 'pr_event',
          triggerAction: action,
          deliveryId,
        };
        return { shouldTrigger: true, reason: `PR ${action} event triggered review`, parsedPayload: parsed };
      }

      return { shouldTrigger: false, reason: `PR action '${action}' is not configured for automatic review` };
    }

    if (eventName === 'issue_comment' || eventName === 'pull_request_review_comment') {
      const commentBody = payload.comment?.body || '';
      const isBotCommand = /@(ct-review|bot|ct-review-bot)\s+review/i.test(commentBody);

      if (!isBotCommand) {
        return { shouldTrigger: false, reason: 'Comment body does not contain bot review command' };
      }

      const issue = payload.issue || payload.pull_request || {};
      const isPR = !!payload.issue?.pull_request || eventName === 'pull_request_review_comment' || !!payload.pull_request;

      if (!isPR) {
        return { shouldTrigger: false, reason: 'Comment command received on a standard issue, not a Pull Request' };
      }

      const repo = payload.repository || {};
      const owner = repo.owner?.login || 'calltelemetry';
      const repoName = repo.name || 'ai-workspace';
      const prNumber = issue.number || payload.number || 0;

      const parsed: ParsedPRPayload = {
        owner,
        repo: repoName,
        prNumber,
        headSha: issue.head?.sha || payload.pull_request?.head?.sha || 'head-sha-latest',
        baseSha: issue.base?.sha || payload.pull_request?.base?.sha || 'base-sha-latest',
        title: issue.title || '',
        body: issue.body || '',
        sender,
        labels: Array.isArray(issue.labels) ? issue.labels.map((l: any) => typeof l === 'string' ? l : l.name) : [],
        triggerSource: 'comment_command',
        triggerAction: payload.action || 'created',
        commandText: commentBody,
        commentId: payload.comment?.id,
        deliveryId,
      };

      return { shouldTrigger: true, reason: 'Comment review command detected', parsedPayload: parsed };
    }

    return { shouldTrigger: false, reason: `Unsupported event type '${eventName}'` };
  }

  /**
   * Main dispatch entry point called by HTTP webhook handler.
   */
  public async handleWebhook(eventName: string, payload: any, deliveryId: string): Promise<{ status: JobStatus; jobId?: string; reason?: string; prNumber?: number }> {
    const triggerEval = this.evaluateTrigger(eventName, payload, deliveryId);

    if (!triggerEval.shouldTrigger || !triggerEval.parsedPayload) {
      return { status: 'ignored', reason: triggerEval.reason };
    }

    const jobId = `job-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const job: ReviewJob = {
      jobId,
      deliveryId,
      createdAt: new Date().toISOString(),
      status: 'queued',
      payload: triggerEval.parsedPayload,
      attempt: 0,
      maxRetries: 2,
    };

    this.enqueueJob(job);

    return {
      status: 'queued',
      jobId,
      reason: triggerEval.reason,
      prNumber: triggerEval.parsedPayload.prNumber,
    };
  }

  private enqueueJob(job: ReviewJob): void {
    this.queue.push(job);
    this.jobStore.set(job.jobId, job);
    if (this.jobStore.size > this.maxStoreSize) {
      const oldestKey = this.jobStore.keys().next().value;
      if (oldestKey) this.jobStore.delete(oldestKey);
    }
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.activeJobsCount >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const job = this.queue.shift();
    if (!job) return;

    this.activeJobsCount++;
    job.status = 'processing';
    job.startedAt = new Date().toISOString();
    job.attempt++;

    logger.info(`Starting async review job ${job.jobId} for PR #${job.payload.prNumber}`);

    try {
      if (this.reviewRunner) {
        job.reviewResult = await this.reviewRunner(job.payload);
      }
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      logger.info(`Async review job ${job.jobId} completed successfully`);
    } catch (err: any) {
      logger.error(`Async review job ${job.jobId} failed (attempt ${job.attempt})`, { err: err?.message || err });
      if (job.attempt < job.maxRetries) {
        job.status = 'queued';
        this.queue.push(job);
      } else {
        job.status = 'failed';
        job.error = err?.message || 'Review execution failed';
        job.completedAt = new Date().toISOString();
      }
    } finally {
      this.activeJobsCount--;
      setImmediate(() => this.processQueue());
    }
  }

  public getJob(jobId: string): ReviewJob | undefined {
    return this.jobStore.get(jobId);
  }

  public getQueueMetrics(): { queueLength: number; activeJobs: number; totalTracked: number } {
    return {
      queueLength: this.queue.length,
      activeJobs: this.activeJobsCount,
      totalTracked: this.jobStore.size,
    };
  }
}
```

---

## 6. Integration Specifications

1. **Wiring into `src/github/webhookServer.ts`**:
   The HTTP server uses `signature.ts` to authenticate HMAC header, extracts `X-GitHub-Event` and `X-GitHub-Delivery`, and invokes `eventHandler.handleWebhook(eventName, body, deliveryId)`. If enqueued, returns `200 OK` with `{ status: 'queued', jobId }`.
2. **Wiring into `src/app.ts`**:
   `src/app.ts` initializes `GitHubEventHandler` and supplies the `ReviewRunnerCallback` that encapsulates the full M1-M4 pipeline (Config Loader -> Ticket Validator -> Constitution Engine -> Diff State Manager -> Quorum Engine -> Comment Publisher).

---

## 7. Verification Method

- **Unit Tests (`tests/unit/webhook.test.ts`)**:
  - Test `evaluateTrigger` across `opened`, `synchronize`, `reopened`, `labeled`, comment triggers (`@ct-review review`), and bot self-loop suppression.
  - Test `AsyncJobQueue` enqueuing, concurrency control, and job status tracking.
- **Integration Tests (`tests/integration/m4_webhook.test.ts`)**:
  - Send POST webhooks via `supertest` to Express server and verify non-blocking `200 OK` responses with valid `jobId`.
