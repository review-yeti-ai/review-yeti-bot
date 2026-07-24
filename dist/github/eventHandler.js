"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubEventHandler = void 0;
const crypto_1 = __importDefault(require("crypto"));
const logger_1 = require("../utils/logger");
class GitHubEventHandler {
    triggerLabels;
    maxConcurrency;
    reviewRunner;
    syncExecution;
    queue = [];
    activeJobsCount = 0;
    jobStore = new Map();
    maxStoreSize = 500;
    constructor(options = {}) {
        this.triggerLabels = new Set(options.triggerLabels || ['ct-review', 'ai-review', 'needs-review', 'bot-review']);
        this.maxConcurrency = options.maxConcurrency || 3;
        this.reviewRunner = options.reviewRunner;
        this.syncExecution = options.syncExecution ?? false;
    }
    setReviewRunner(runner) {
        this.reviewRunner = runner;
    }
    /**
     * Evaluates an incoming raw webhook event to determine if it should trigger a review.
     */
    evaluateTrigger(eventName, payload, deliveryId = '') {
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
            const labels = Array.isArray(pr.labels)
                ? pr.labels.map((l) => (typeof l === 'string' ? l : l.name))
                : [];
            const hasTriggerLabel = labels.some((lbl) => this.triggerLabels.has(lbl));
            if (['opened', 'synchronize', 'reopened'].includes(action) || (action === 'labeled' && hasTriggerLabel)) {
                let changedFiles = undefined;
                if (Array.isArray(payload.changed_files)) {
                    changedFiles = payload.changed_files;
                }
                else if (Array.isArray(pr.changed_files)) {
                    changedFiles = pr.changed_files;
                }
                else if (Array.isArray(pr.files)) {
                    changedFiles = pr.files.map((f) => ({
                        path: f.filename || f.path,
                        content: f.content,
                        patch: f.patch,
                    }));
                }
                const parsed = {
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
            const parsed = {
                owner,
                repo: repoName,
                prNumber,
                headSha: issue.head?.sha || payload.pull_request?.head?.sha || 'head-sha-latest',
                baseSha: issue.base?.sha || payload.pull_request?.base?.sha || 'base-sha-latest',
                title: issue.title || '',
                body: issue.body || '',
                sender,
                labels: Array.isArray(issue.labels) ? issue.labels.map((l) => (typeof l === 'string' ? l : l.name)) : [],
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
    async handleWebhook(eventName, payload, deliveryId = '') {
        const triggerEval = this.evaluateTrigger(eventName, payload, deliveryId);
        if (!triggerEval.shouldTrigger || !triggerEval.parsedPayload) {
            return { status: 'ignored', reason: triggerEval.reason, action: payload.action };
        }
        const jobId = `job-${Date.now()}-${crypto_1.default.randomBytes(4).toString('hex')}`;
        const job = {
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
            if (oldestKey)
                this.jobStore.delete(oldestKey);
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
            }
            catch (err) {
                job.status = 'failed';
                job.error = err?.message || 'Review execution failed';
                job.completedAt = new Date().toISOString();
                throw err;
            }
        }
        else {
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
    enqueueJob(job) {
        this.queue.push(job);
        this.processQueue();
    }
    async processQueue() {
        if (this.activeJobsCount >= this.maxConcurrency || this.queue.length === 0) {
            return;
        }
        const job = this.queue.shift();
        if (!job)
            return;
        this.activeJobsCount++;
        job.status = 'processing';
        job.startedAt = new Date().toISOString();
        job.attempt++;
        logger_1.logger.info(`Starting async review job ${job.jobId} for PR #${job.payload.prNumber}`);
        try {
            if (this.reviewRunner) {
                job.reviewResult = await this.reviewRunner(job.payload);
            }
            job.status = 'completed';
            job.completedAt = new Date().toISOString();
            logger_1.logger.info(`Async review job ${job.jobId} completed successfully`);
        }
        catch (err) {
            logger_1.logger.error(`Async review job ${job.jobId} failed (attempt ${job.attempt})`, { err: err?.message || err });
            if (job.attempt < job.maxRetries) {
                job.status = 'queued';
                this.queue.push(job);
            }
            else {
                job.status = 'failed';
                job.error = err?.message || 'Review execution failed';
                job.completedAt = new Date().toISOString();
            }
        }
        finally {
            this.activeJobsCount--;
            setImmediate(() => this.processQueue());
        }
    }
    getJob(jobId) {
        return this.jobStore.get(jobId);
    }
    getQueueMetrics() {
        return {
            queueLength: this.queue.length,
            activeJobs: this.activeJobsCount,
            totalTracked: this.jobStore.size,
        };
    }
    async drainAndStop() {
        while (this.activeJobsCount > 0 || this.queue.length > 0) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }
}
exports.GitHubEventHandler = GitHubEventHandler;
//# sourceMappingURL=eventHandler.js.map