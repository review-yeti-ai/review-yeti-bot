import { PersonaFinding, QuorumEvaluationResult } from '../quorum/quorumEngine';
export interface CommentPublisherOptions {
    githubToken?: string;
    baseUrl?: string;
    maxRetries?: number;
    initialRetryDelayMs?: number;
    maxDelayMs?: number;
    userAgent?: string;
}
export interface PublishInlineCommentRequest {
    owner: string;
    repo: string;
    prNumber: number;
    commitSha: string;
    path: string;
    line: number;
    side?: 'LEFT' | 'RIGHT';
    startLine?: number;
    finding: PersonaFinding;
}
export interface PublishReviewRequest {
    owner: string;
    repo: string;
    prNumber: number;
    commitSha: string;
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
    body: string;
    inlineComments?: PublishInlineCommentRequest[];
}
export interface PublishResult {
    success: boolean;
    reviewId?: number;
    commentsCreated: number;
    rateLimitRemaining?: number;
    errors?: string[];
}
/**
 * Formats a PersonaFinding into a rich GitHub inline comment body with optional suggestion block.
 */
export declare function formatInlineCommentBody(finding: PersonaFinding): string;
export declare class CommentPublisher {
    private baseUrl;
    private token?;
    private maxRetries;
    private initialRetryDelayMs;
    private maxDelayMs;
    constructor(options?: CommentPublisherOptions);
    /**
     * Helper to perform HTTP requests with rate limit retry & exponential backoff
     */
    private fetchWithRetry;
    /**
     * Retrieves existing inline comments on a Pull Request for thread deduplication.
     */
    getExistingComments(owner: string, repo: string, prNumber: number): Promise<any[]>;
    /**
     * Publishes an individual inline code review comment on a Pull Request.
     */
    publishInlineComment(req: PublishInlineCommentRequest): Promise<PublishResult>;
    /**
     * Publishes a top-level review summary and optional inline comments on a Pull Request.
     */
    publishReview(req: PublishReviewRequest): Promise<PublishResult>;
    /**
     * Helper to format and publish a Quorum review result.
     */
    publishQuorumReview(options: {
        owner: string;
        repo: string;
        prNumber: number;
        commitSha: string;
        quorumResult: QuorumEvaluationResult;
        ticketResult?: any;
        constitutionResult?: any;
    }): Promise<PublishResult>;
}
