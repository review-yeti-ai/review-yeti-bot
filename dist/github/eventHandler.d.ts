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
    changedFiles?: Array<{
        path: string;
        content?: string;
        patch?: string;
    }>;
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
    syncExecution?: boolean;
}
export declare class GitHubEventHandler {
    private triggerLabels;
    private maxConcurrency;
    private reviewRunner?;
    private syncExecution;
    private queue;
    private activeJobsCount;
    private jobStore;
    private maxStoreSize;
    constructor(options?: EventHandlerOptions);
    setReviewRunner(runner: ReviewRunnerCallback): void;
    /**
     * Evaluates an incoming raw webhook event to determine if it should trigger a review.
     */
    evaluateTrigger(eventName: string, payload: any, deliveryId?: string): TriggerResult;
    /**
     * Main dispatch entry point called by HTTP webhook handler.
     */
    handleWebhook(eventName: string, payload: any, deliveryId?: string): Promise<any>;
    private enqueueJob;
    private processQueue;
    getJob(jobId: string): ReviewJob | undefined;
    getQueueMetrics(): {
        queueLength: number;
        activeJobs: number;
        totalTracked: number;
    };
    drainAndStop(): Promise<void>;
}
