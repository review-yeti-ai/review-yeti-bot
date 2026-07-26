import { logger } from '../utils/logger';
import { GraphLearningEngine } from '../memory/graphLearningEngine';
import { PanelFinding } from '../panel/panelEngine';
import { NitSuppressionEngine } from '../reflection/nitSuppressionEngine';

export interface FixOption {
  rank?: number;
  title?: string;
  explanation?: string;
  suggestionCode?: string;
}

export interface PersonaFinding {
  persona: string;
  severity: 'critical' | 'major' | 'minor' | 'nit';
  filePath: string;
  lineNumber: number;
  comment: string;
  title?: string;
  confidence?: number;
  recommendation?: string;
  suggestion?: string;
  codeSnippet?: string;
  fixOptions?: FixOption[];
}

export interface CommentPublisherOptions {
  githubToken?: string;
  baseUrl?: string;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxDelayMs?: number;
  userAgent?: string;
  allowUserToken?: boolean;
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
  mascot?: boolean;
}

export interface PublishResult {
  success: boolean;
  reviewId?: number;
  commentsCreated: number;
  rateLimitRemaining?: number;
  errors?: string[];
}

export const ASCII_MASCOT = `\`\`\`
  /\\_/\\   CallTelemetry AI Reviewer
 ( o.o )  Code Telemetry & Security Engine
  > ^ <
\`\`\``;

export const PUBLISHER_MASCOT = ASCII_MASCOT;

export function getJobId(owner: string, repo: string, prNumber: number, commitSha: string): string {
  return `job_${owner}_${repo}_pr${prNumber}_${commitSha.slice(0, 7)}`;
}

export function getLiveStreamUrl(domain: string, jobId: string): string {
  const cleanDomain = domain.replace(/\/$/, '');
  return `${cleanDomain}/dashboard/live?jobId=${jobId}`;
}

export function getOrgDashboardUrl(domain: string): string {
  const cleanDomain = domain.replace(/\/$/, '');
  return `${cleanDomain}/dashboard/organization`;
}

export function formatDashboardFooter(liveStreamUrl: string, orgDashboardUrl: string, _verdict: string = 'APPROVE'): string {
  return `\n\n---\n[📊 Live Terminal Dashboard](${liveStreamUrl}) | [🏢 Org Settings](${orgDashboardUrl})`;
}

/**
 * Formats a PersonaFinding into a rich GitHub inline comment body with optional suggestion block.
 */
export function formatInlineCommentBody(
  finding: PersonaFinding,
  options?: { mascot?: boolean }
): string {
  let body = '';

  if (options?.mascot) {
    body += `${ASCII_MASCOT}\n\n`;
  }

  const severityFormatted = finding.severity.toUpperCase();
  if (finding.title) {
    body += `### [${finding.persona}] ${finding.title} — Severity: ${severityFormatted}\n\n`;
  } else {
    body += `### [${finding.persona}] Severity: ${severityFormatted}\n\n`;
  }

  if (finding.confidence !== undefined) {
    body += `**Confidence**: ${finding.confidence}%\n`;
  }

  body += `**Finding**: ${finding.comment}\n`;

  if (finding.recommendation) {
    if (finding.recommendation.startsWith('[RECOMMENDATION]')) {
      body += `${finding.recommendation}\n`;
    } else {
      body += `[RECOMMENDATION] ${finding.recommendation}\n`;
    }
  }

  if (finding.fixOptions && finding.fixOptions.length > 0) {
    body += '\n';
    const optionsToFormat = finding.fixOptions.slice(0, 2);
    optionsToFormat.forEach((fix, i) => {
      const rankNum = fix.rank ?? i + 1;
      const defaultTitle = rankNum === 1 ? 'Recommended Fix' : 'Alternative Approach';
      const optionTitle = fix.title || defaultTitle;
      body += `#### Option ${rankNum}: ${optionTitle} (Rank #${rankNum})\n`;
      if (fix.explanation) {
        body += `${fix.explanation}\n`;
      }
      if (fix.suggestionCode) {
        body += `\`\`\`suggestion\n${fix.suggestionCode}\n\`\`\`\n`;
      }
    });
  } else if (finding.suggestion || finding.codeSnippet) {
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
    const tokenToValidate = options.githubToken !== undefined
      ? options.githubToken
      : process.env.GITHUB_TOKEN !== undefined
        ? process.env.GITHUB_TOKEN
        : (process.env.GITHUB_APP_INSTALLATION_TOKEN || '');

    if (!options.allowUserToken && (!tokenToValidate || !tokenToValidate.startsWith('ghs_'))) {
      throw new Error('CommentPublisher requires an explicit GitHub App installation token (ghs_)');
    }
    this.token = options.githubToken || process.env.GITHUB_APP_INSTALLATION_TOKEN || process.env.GITHUB_TOKEN || 'ghs_fallback_token_dev';
    this.maxRetries = options.maxRetries ?? 3;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 100;
    this.maxDelayMs = options.maxDelayMs ?? 2000;
  }

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

  public async publishReview(req: PublishReviewRequest): Promise<PublishResult> {
    const { owner, repo, prNumber, commitSha, event, body, inlineComments = [] } = req;
    let commentsCreated = 0;
    const errors: string[] = [];

    try {
      const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
      const dashboardDomain = process.env.DASHBOARD_URL || 'https://ct-review-bot.calltelemetry.com';
      const jobId = getJobId(owner, repo, prNumber, commitSha);
      const liveStreamUrl = getLiveStreamUrl(dashboardDomain, jobId);
      const orgDashboardUrl = getOrgDashboardUrl(dashboardDomain);

      const dashboardFooter = formatDashboardFooter(liveStreamUrl, orgDashboardUrl);
      const finalBody = body.includes(liveStreamUrl) || body.includes('Live Terminal Dashboard') || body.includes(dashboardFooter) ? body : body + dashboardFooter;

      const res = await this.fetchWithRetry(url, {
        method: 'POST',
        body: JSON.stringify({
          body: finalBody,
          event,
          commit_id: commitSha,
          comments: inlineComments.map(({ path, line, side = 'RIGHT', startLine, finding }) => ({
            path,
            line,
            side,
            ...(startLine ? { start_line: startLine, start_side: side } : {}),
            body: formatInlineCommentBody(finding, { mascot: req.mascot }),
          })),
        }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        if (errorText.includes('Can not approve your own pull request')) {
          // Fallback to issue comment API
          const issueUrl = `${this.baseUrl}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
          const issueRes = await this.fetchWithRetry(issueUrl, {
            method: 'POST',
            body: JSON.stringify({ body: finalBody }),
          });
          if (issueRes.ok) {
            const issueData: any = await issueRes.json();
            return { success: true, reviewId: issueData.id, commentsCreated: 1 };
          }
        }
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

  public async publishReviewWithNitSuppression(
    req: PublishReviewRequest,
    learningEngine?: GraphLearningEngine | NitSuppressionEngine
  ): Promise<PublishResult> {
    if (learningEngine && req.inlineComments && req.inlineComments.length > 0) {
      const repo = `${req.owner}/${req.repo}`;
      const findings: PanelFinding[] = req.inlineComments.map((ic) => ({
        severity: ic.finding.severity === 'critical' ? 'P0' : ic.finding.severity === 'major' ? 'P1' : 'P2',
        path: ic.path,
        line: ic.line,
        title: ic.finding.title || ic.finding.comment.split('\n')[0],
        body: ic.finding.comment,
        suggestion: ic.finding.suggestion,
      }));

      if (learningEngine instanceof NitSuppressionEngine) {
        const { activeFindings } = await (learningEngine as NitSuppressionEngine).suppressNits(repo, findings);
        const activeKeys = new Set(activeFindings.map((f: any) => `${f.path}:${f.line}:${f.title}`));
        req.inlineComments = req.inlineComments.filter((ic) => {
          const title = ic.finding.title || ic.finding.comment.split('\n')[0];
          return activeKeys.has(`${ic.path}:${ic.line}:${title}`);
        });
      } else if (learningEngine && typeof (learningEngine as any).analyzeAndFilterFindings === 'function') {
        const { filteredFindings } = await (learningEngine as GraphLearningEngine).analyzeAndFilterFindings(repo, findings);
        const filteredKeys = new Set(filteredFindings.map((f: any) => `${f.path}:${f.line}:${f.title}`));
        req.inlineComments = req.inlineComments.filter((ic) =>
          filteredKeys.has(`${ic.path}:${ic.line}:${ic.finding.title || ic.finding.comment.split('\n')[0]}`)
        );
      }
    }
    return this.publishReview(req);
  }
}
