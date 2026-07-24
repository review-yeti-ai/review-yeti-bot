import { logger } from '../utils/logger';

export interface PersonaFinding {
  persona: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  filePath: string;
  lineNumber: number;
  comment: string;
  suggestion?: string;
  codeSnippet?: string;
}

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
export function formatInlineCommentBody(finding: PersonaFinding): string {
  const severityFormatted = finding.severity.toUpperCase();

  let body = `### [${finding.persona}] Severity: ${severityFormatted}\n\n`;
  body += `**Finding**: ${finding.comment}\n`;

  if (finding.suggestion || finding.codeSnippet) {
    const code = finding.suggestion || finding.codeSnippet;
    body += `\n\`\`\`suggestion\n${code}\n\`\`\`\n`;
  }

  return body;
}

export class CommentPublisher {
  private baseUrl: string;
  private token: string;
  private maxRetries: number;
  private initialRetryDelayMs: number;
  private maxDelayMs: number;

  constructor(options: CommentPublisherOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/$/, '');
    if (!options.githubToken || !options.githubToken.startsWith('ghs_')) {
      throw new Error('CommentPublisher requires an explicit GitHub App installation token (ghs_)');
    }
    this.token = options.githubToken;
    this.maxRetries = options.maxRetries ?? 3;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 2000;
  }

  /**
   * Helper to perform HTTP requests with rate limit retry & exponential backoff
   */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let delay = this.initialRetryDelayMs;
    const headers = new Headers(init.headers || {});
    headers.set('Content-Type', 'application/json');
    headers.set('Authorization', `Bearer ${this.token}`);
    headers.set('User-Agent', 'ct-review-bot[bot]');

    const requestInit: RequestInit = { ...init, headers };

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, requestInit);

        if (response.status === 429 || response.status === 403) {
          const retryAfter = response.headers.get('retry-after');
          const rateLimitReset = response.headers.get('x-ratelimit-reset');

          let waitMs = delay;
          if (retryAfter) {
            waitMs = parseInt(retryAfter, 10) * 1000;
          } else if (rateLimitReset) {
            const resetTimeMs = parseInt(rateLimitReset, 10) * 1000;
            waitMs = Math.max(0, resetTimeMs - Date.now());
          }

          waitMs = Math.min(waitMs, this.maxDelayMs);
          const jitter = Math.floor(Math.random() * 50);

          if (attempt < this.maxRetries) {
            logger.warn(`Rate limited by GitHub API (${response.status}). Retrying in ${waitMs + jitter}ms... (attempt ${attempt + 1})`);
            await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));
            delay *= 2;
            continue;
          }
        }

        return response;
      } catch (err) {
        if (attempt === this.maxRetries) throw err;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
    throw new Error('Max retries reached during GitHub API request');
  }

  /**
   * Publishes a top-level review summary and optional inline comments on a Pull Request.
   */
  public async publishReview(req: PublishReviewRequest): Promise<PublishResult> {
    const { owner, repo, prNumber, commitSha, event, body, inlineComments = [] } = req;
    let commentsCreated = 0;
    const errors: string[] = [];

    try {
      const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
      const res = await this.fetchWithRetry(url, {
        method: 'POST',
        body: JSON.stringify({
          body,
          event,
          commit_id: commitSha,
          comments: inlineComments.map(({ path, line, side = 'RIGHT', startLine, finding }) => ({
            path,
            line,
            side,
            ...(startLine ? { start_line: startLine, start_side: side } : {}),
            body: formatInlineCommentBody(finding),
          })),
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        errors.push(`HTTP ${res.status}: ${errorText}`);
        return { success: false, commentsCreated, errors };
      }

      const resData: any = await res.json();
      commentsCreated = inlineComments.length;
      const rateLimitHeader = res.headers.get('x-ratelimit-remaining');
      const rateLimitRemaining = rateLimitHeader ? parseInt(rateLimitHeader, 10) : undefined;

      return {
        success: true,
        reviewId: resData.id,
        commentsCreated,
        rateLimitRemaining,
        errors: errors.length > 0 ? errors : undefined,
      };
    } catch (err: any) {
      logger.error('Failed to publish top-level review', { err: err?.message || err });
      errors.push(err?.message || 'Network error');
      return { success: false, commentsCreated, errors };
    }
  }

}
