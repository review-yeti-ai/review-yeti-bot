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
  syncExecution?: boolean; // If true, awaits review runner before returning
}

export class GitHubEventHandler {
  private triggerLabels: Set<string>;
  private maxConcurrency: number;
  private reviewRunner?: ReviewRunnerCallback;
  private syncExecution: boolean;
  private queue: ReviewJob[] = [];
  private activeJobsCount = 0;
  private jobStore: Map<string, ReviewJob> = new Map();
  private maxStoreSize = 500;

  constructor(options: EventHandlerOptions = {}) {
    this.triggerLabels = new Set(options.triggerLabels || ['ct-review', 'ai-review', 'needs-review', 'bot-review']);
    this.maxConcurrency = options.maxConcurrency || 3;
    this.reviewRunner = options.reviewRunner;
    this.syncExecution = options.syncExecution ?? false;
  }

  public setReviewRunner(runner: ReviewRunnerCallback): void {
    this.reviewRunner = runner;
  }

  /**
   * Evaluates an incoming raw webhook event to determine if it should trigger a review.
   */
  public evaluateTrigger(eventName: string, payload: any, deliveryId: string = ''): TriggerResult {
    const sender = payload.sender?.login || '';
    if (sender.endsWith('[bot]') || sender === 'ct-review-bot') {
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

      if (pr.draft === true) {
        return { shouldTrigger: false, reason: 'PR is a draft' };
      }

      const labels = Array.isArray(pr.labels)
        ? pr.labels.map((l: any) => (typeof l === 'string' ? l : l.name))
        : [];
      const hasTriggerLabel = labels.some((lbl: string) => this.triggerLabels.has(lbl));

      if (['opened', 'synchronize', 'reopened'].includes(action) || (action === 'labeled' && hasTriggerLabel)) {
        let changedFiles: Array<{ path: string; content?: string; patch?: string }> | undefined = undefined;
        if (Array.isArray(payload.changed_files)) {
          changedFiles = payload.changed_files;
        } else if (Array.isArray(pr.changed_files)) {
          changedFiles = pr.changed_files;
        } else if (Array.isArray(pr.files)) {
          changedFiles = pr.files.map((f: any) => ({
            path: f.filename || f.path,
            content: f.content,
            patch: f.patch,
          }));
        }

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
          changedFiles,
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
        return { shouldTrigger: false, reason: 'not bot review command' };
      }

      const issue = payload.issue || payload.pull_request || {};
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
        labels: Array.isArray(issue.labels) ? issue.labels.map((l: any) => (typeof l === 'string' ? l : l.name)) : [],
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
  public async handleWebhook(
    eventName: string,
    payload: any,
    deliveryId: string = ''
  ): Promise<any> {
    const triggerEval = this.evaluateTrigger(eventName, payload, deliveryId);

    if (!triggerEval.shouldTrigger || !triggerEval.parsedPayload) {
      return { status: 'ignored', reason: triggerEval.reason, action: payload.action };
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

    this.jobStore.set(job.jobId, job);
    if (this.jobStore.size > this.maxStoreSize) {
      const oldestKey = this.jobStore.keys().next().value;
      if (oldestKey) this.jobStore.delete(oldestKey);
    }

    if (this.syncExecution && this.reviewRunner) {
      job.status = 'processing';
      job.startedAt = new Date().toISOString();
      job.attempt++;
      try {
        const result = await this.reviewRunner(job.payload);
        job.status = 'completed';
        job.reviewResult = result;
        job.completedAt = new Date().toISOString();
        return result;
      } catch (err: any) {
        job.status = 'failed';
        job.error = err?.message || 'Review execution failed';
        job.completedAt = new Date().toISOString();
        throw err;
      }
    } else {
      this.enqueueJob(job);
      return {
        status: triggerEval.parsedPayload.triggerSource === 'comment_command' ? 'triggered' : 'queued',
        jobId,
        event: eventName,
        action: payload.action,
        reason: triggerEval.reason,
        prNumber: triggerEval.parsedPayload.prNumber,
      };
    }
  }

  private enqueueJob(job: ReviewJob): void {
    this.queue.push(job);
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

  public async drainAndStop(): Promise<void> {
    while (this.activeJobsCount > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
