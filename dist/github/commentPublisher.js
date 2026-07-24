"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommentPublisher = void 0;
exports.formatInlineCommentBody = formatInlineCommentBody;
const logger_1 = require("../utils/logger");
/**
 * Formats a PersonaFinding into a rich GitHub inline comment body with optional suggestion block.
 */
function formatInlineCommentBody(finding) {
    const personaEmoji = {
        security: '🛡️',
        architecture: '📐',
        performance: '⚡',
        quality: '🔍',
    };
    const emoji = personaEmoji[finding.persona.toLowerCase()] || '🤖';
    const severityFormatted = finding.severity.toUpperCase();
    let body = `### ${emoji} [${finding.persona.toUpperCase()}] Severity: ${severityFormatted}\n\n`;
    body += `${finding.comment}\n`;
    const code = finding.suggestion || finding.codeSnippet;
    if (code && code.trim() !== '') {
        body += `\n\`\`\`suggestion\n${code}\n\`\`\`\n`;
    }
    return body;
}
class CommentPublisher {
    baseUrl;
    token;
    maxRetries;
    initialRetryDelayMs;
    maxDelayMs;
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl || process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/$/, '');
        this.token = options.githubToken || process.env.GITHUB_TOKEN;
        this.maxRetries = options.maxRetries ?? 3;
        this.initialRetryDelayMs = options.initialRetryDelayMs ?? 100;
        this.maxDelayMs = options.maxDelayMs ?? 2000;
    }
    /**
     * Helper to perform HTTP requests with rate limit retry & exponential backoff
     */
    async fetchWithRetry(url, init) {
        let delay = this.initialRetryDelayMs;
        const headers = new Headers(init.headers || {});
        headers.set('Content-Type', 'application/json');
        if (this.token) {
            headers.set('Authorization', `token ${this.token}`);
        }
        headers.set('User-Agent', 'ct-review-bot');
        const requestInit = { ...init, headers };
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const response = await fetch(url, requestInit);
                if (response.status === 429 || response.status === 403) {
                    const retryAfter = response.headers.get('retry-after');
                    const rateLimitReset = response.headers.get('x-ratelimit-reset');
                    let waitMs = delay;
                    if (retryAfter) {
                        waitMs = parseInt(retryAfter, 10) * 1000;
                    }
                    else if (rateLimitReset) {
                        const resetTimeMs = parseInt(rateLimitReset, 10) * 1000;
                        waitMs = Math.max(0, resetTimeMs - Date.now());
                    }
                    waitMs = Math.min(waitMs, this.maxDelayMs);
                    const jitter = Math.floor(Math.random() * 50);
                    if (attempt < this.maxRetries) {
                        logger_1.logger.warn(`Rate limited by GitHub API (${response.status}). Retrying in ${waitMs + jitter}ms... (attempt ${attempt + 1})`);
                        await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));
                        delay *= 2;
                        continue;
                    }
                }
                return response;
            }
            catch (err) {
                if (attempt === this.maxRetries)
                    throw err;
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay *= 2;
            }
        }
        throw new Error('Max retries reached during GitHub API request');
    }
    /**
     * Retrieves existing inline comments on a Pull Request for thread deduplication.
     */
    async getExistingComments(owner, repo, prNumber) {
        try {
            const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
            const res = await this.fetchWithRetry(url, { method: 'GET' });
            if (res.ok) {
                return (await res.json());
            }
            return [];
        }
        catch (err) {
            logger_1.logger.warn('Failed to fetch existing comments for deduplication', { owner, repo, prNumber, err });
            return [];
        }
    }
    /**
     * Publishes an individual inline code review comment on a Pull Request.
     */
    async publishInlineComment(req) {
        const { owner, repo, prNumber, commitSha, path, line, side = 'RIGHT', finding } = req;
        const body = formatInlineCommentBody(finding);
        try {
            // Check existing comments for deduplication
            const existing = await this.getExistingComments(owner, repo, prNumber);
            const isDuplicate = existing.some((c) => c.path === path &&
                (c.line === line || c.position === line) &&
                c.body &&
                c.body.includes(`[${finding.persona.toUpperCase()}]`));
            if (isDuplicate) {
                logger_1.logger.info(`Skipping duplicate inline comment for ${finding.persona} at ${path}:${line}`);
                return { success: true, commentsCreated: 0 };
            }
            const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
            const res = await this.fetchWithRetry(url, {
                method: 'POST',
                body: JSON.stringify({
                    body,
                    commit_id: commitSha,
                    path,
                    line,
                    side,
                }),
            });
            if (!res.ok) {
                const errorText = await res.text();
                return { success: false, commentsCreated: 0, errors: [`HTTP ${res.status}: ${errorText}`] };
            }
            const rateLimitHeader = res.headers.get('x-ratelimit-remaining');
            const rateLimitRemaining = rateLimitHeader ? parseInt(rateLimitHeader, 10) : undefined;
            return { success: true, commentsCreated: 1, rateLimitRemaining };
        }
        catch (err) {
            logger_1.logger.error('Failed to publish inline comment', { err: err?.message || err });
            return { success: false, commentsCreated: 0, errors: [err?.message || 'Network error'] };
        }
    }
    /**
     * Publishes a top-level review summary and optional inline comments on a Pull Request.
     */
    async publishReview(req) {
        const { owner, repo, prNumber, commitSha, event, body, inlineComments = [] } = req;
        let commentsCreated = 0;
        const errors = [];
        // Publish inline comments first
        for (const inlineReq of inlineComments) {
            const inlineRes = await this.publishInlineComment(inlineReq);
            if (inlineRes.success) {
                commentsCreated += inlineRes.commentsCreated;
            }
            else if (inlineRes.errors) {
                errors.push(...inlineRes.errors);
            }
        }
        try {
            const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
            const res = await this.fetchWithRetry(url, {
                method: 'POST',
                body: JSON.stringify({
                    body,
                    event,
                    commit_id: commitSha,
                }),
            });
            if (!res.ok) {
                const errorText = await res.text();
                errors.push(`HTTP ${res.status}: ${errorText}`);
                return { success: false, commentsCreated, errors };
            }
            const resData = await res.json();
            const rateLimitHeader = res.headers.get('x-ratelimit-remaining');
            const rateLimitRemaining = rateLimitHeader ? parseInt(rateLimitHeader, 10) : undefined;
            return {
                success: true,
                reviewId: resData.id,
                commentsCreated,
                rateLimitRemaining,
                errors: errors.length > 0 ? errors : undefined,
            };
        }
        catch (err) {
            logger_1.logger.error('Failed to publish top-level review', { err: err?.message || err });
            errors.push(err?.message || 'Network error');
            return { success: false, commentsCreated, errors };
        }
    }
    /**
     * Helper to format and publish a Quorum review result.
     */
    async publishQuorumReview(options) {
        const { owner, repo, prNumber, commitSha, quorumResult, ticketResult, constitutionResult } = options;
        let body = `## 🤖 ct-review-bot Automated Review\n\n`;
        body += `**Decision**: \`${quorumResult.decision}\`\n\n`;
        if (ticketResult) {
            body += `- **Ticket Linkage**: ${ticketResult.valid ? '✅ Valid' : '❌ Missing/Invalid'}\n`;
        }
        if (constitutionResult) {
            body += `- **Constitution Compliance**: ${constitutionResult.compliant ? '✅ Compliant' : '❌ Non-compliant'}\n`;
        }
        body += `- **Approving Personas**: ${quorumResult.approvingPersonas.join(', ') || 'None'}\n`;
        if (quorumResult.requestingChangesPersonas.length > 0) {
            body += `- **Requesting Changes Personas**: ${quorumResult.requestingChangesPersonas.join(', ')}\n`;
        }
        body += `- **Active Findings**: ${quorumResult.activeFindings.length}\n`;
        const inlineComments = quorumResult.activeFindings.map((finding) => ({
            owner,
            repo,
            prNumber,
            commitSha,
            path: finding.filePath || 'src/index.ts',
            line: finding.lineNumber || 1,
            finding,
        }));
        return this.publishReview({
            owner,
            repo,
            prNumber,
            commitSha,
            event: quorumResult.decision,
            body,
            inlineComments,
        });
    }
}
exports.CommentPublisher = CommentPublisher;
//# sourceMappingURL=commentPublisher.js.map