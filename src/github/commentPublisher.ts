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
  severity: 'critical' | 'major' | 'minor' | 'nit' | 'P0' | 'P1' | 'P2';
  filePath: string;
  lineNumber: number;
  comment: string;
  title?: string;
  confidence?: number;
  recommendation?: string;
  suggestion?: string;
  codeSnippet?: string;
  fixOptions?: FixOption[];
  isRedTeam?: boolean;
  crossExaminedModel?: string;
  attackVector?: string;
  failureMode?: string;
  mitigation?: string;
}

export interface CommentPublisherOptions {
  githubToken?: string;
  baseUrl?: string;
  /** Canonical injectable HTTP boundary used by replay tests. */
  fetchImplementation?: FetchImplementation;
  /** @deprecated Use fetchImplementation. */
  fetchImpl?: FetchImplementation;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  initialRetryDelayMs?: number;
  maxDelayMs?: number;
  userAgent?: string;
  allowUserToken?: boolean;
  /** Optional authoritative head lookup used immediately before every write. */
  currentHeadSha?: () => Promise<string>;
}

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface BoundaryOptions {
  fetchImplementation?: FetchImplementation;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

export interface PublishInlineCommentRequest {
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
  /** Stable marker used to make reruns and ambiguous POST outcomes idempotent. */
  idempotencyKey?: string;
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
  private readonly fetchImplementation: FetchImplementation;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly currentHeadSha?: () => Promise<string>;

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
    this.fetchImplementation = options.fetchImplementation || options.fetchImpl || ((input, init) => globalThis.fetch(input, init));
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random || Math.random;
    this.currentHeadSha = options.currentHeadSha;
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
        const response = await this.fetchImplementation(url, requestInit);

        if (response.status === 429 || response.status === 403) {
          const retryAfter = response.headers.get('retry-after');
          const rateLimitReset = response.headers.get('x-ratelimit-reset');

          let waitMs = delay;
          if (retryAfter) {
            waitMs = parseInt(retryAfter, 10) * 1000;
          } else if (rateLimitReset) {
            const resetTimeMs = parseInt(rateLimitReset, 10) * 1000;
            waitMs = Math.max(0, resetTimeMs - this.now());
          }

          waitMs = Math.min(waitMs, this.maxDelayMs);
          const jitter = Math.floor(this.random() * 50);

          if (attempt < this.maxRetries) {
            logger.warn(`Rate limited by GitHub API (${response.status}). Retrying in ${waitMs + jitter}ms... (attempt ${attempt + 1})`);
            await this.sleep(waitMs + jitter);
            delay *= 2;
            continue;
          }
        }

        return response;
      } catch (err) {
        if (String(init.method || 'GET').toUpperCase() === 'POST') throw err;
        if (attempt === this.maxRetries) throw err;
        await this.sleep(delay);
        delay *= 2;
      }
    }
    throw new Error('Max retries reached during GitHub API request');
  }

  private async findExistingReview(marker: string, owner: string, repo: string, prNumber: number): Promise<number | undefined> {
    const endpointBases = [
      `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
      `${this.baseUrl}/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    ];
    for (const endpointBase of endpointBases) {
      for (let page = 1; page <= 20; page++) {
        const response = await this.fetchWithRetry(`${endpointBase}?per_page=100&page=${page}`, { method: 'GET' });
        if (!response.ok) {
          // GitHub can return 404 for an endpoint that has no visible review/comment
          // collection in restricted test/app installations. Treat that as an empty
          // collection; authentication and transport failures remain fail-closed.
          if (response.status === 404) {
            break;
          }
          throw new Error(`GitHub marker lookup returned HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data)) {
          throw new Error('GitHub marker lookup response was not an array');
        }
        const existing = data.find((entry: any) => typeof entry?.body === 'string' && entry.body.includes(marker));
        if (existing && Number.isFinite(Number(existing.id))) return Number(existing.id);
        if (data.length < 100) break;
      }
    }
    return undefined;
  }

  private async assertCurrentHead(expected: string): Promise<void> {
    if (!this.currentHeadSha) return;
    const actual = await this.currentHeadSha();
    if (actual !== expected) throw new Error(`pull request head changed before publication: expected ${expected}, found ${actual}`);
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
      const marker = req.idempotencyKey
        ? `<!-- ct-review-bot:v1:${owner}/${repo}#${prNumber}:${commitSha}:${req.idempotencyKey} -->`
        : '';
      const bodyWithMarker = marker && !body.includes(marker) ? `${body}\n\n${marker}` : body;
      const finalBody = bodyWithMarker.includes(liveStreamUrl) || bodyWithMarker.includes('Live Terminal Dashboard') || bodyWithMarker.includes(dashboardFooter)
        ? bodyWithMarker
        : bodyWithMarker + dashboardFooter;

      if (marker) {
        const existingReviewId = await this.findExistingReview(marker, owner, repo, prNumber);
        if (existingReviewId !== undefined) {
          return { success: true, reviewId: existingReviewId, commentsCreated: 0 };
        }
      }

      const payload = {
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
      };

      await this.assertCurrentHead(commitSha);
      let res = await this.fetchWithRetry(url, {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      let retriedWithoutInline = false;
      let errorText = '';
      if (!res.ok) {
        errorText = await res.text();
        logger.warn(`Failed to publish review with inline comments. Status: ${res.status}, Error: ${errorText}`);

        // If it's a 422 / line could not be resolved error, retry by appending inline comments to the review body.
        if ((res.status === 422 || errorText.includes('Line could not be resolved') || errorText.includes('Unprocessable Entity')) && inlineComments.length > 0) {
          logger.info(`Retrying review publication without inline comments due to line resolution error`);
          retriedWithoutInline = true;
          const fallbackBody = finalBody + '\n\n### 📝 Inline Findings (Fallback)\n\n' + inlineComments.map(ic => {
            return `#### 📄 File: \`${ic.path}\` (Line ${ic.line})\n${formatInlineCommentBody(ic.finding, { mascot: false })}`
          }).join('\n\n---\n\n');

          await this.assertCurrentHead(commitSha);
          res = await this.fetchWithRetry(url, {
            method: 'POST',
            body: JSON.stringify({
              body: fallbackBody,
              event,
              commit_id: commitSha,
            }),
          });
        }
      }

      if (!res.ok) {
        if (retriedWithoutInline) {
          errorText = await res.text();
        }
        if (errorText.includes('Can not approve your own pull request')) {
          // Fallback to issue comment API
          const issueUrl = `${this.baseUrl}/repos/${owner}/${repo}/issues/${prNumber}/comments`;
          const fallbackBody = (inlineComments.length > 0 && retriedWithoutInline) ?
            finalBody + '\n\n### 📝 Inline Findings (Fallback)\n\n' + inlineComments.map(ic => {
              return `#### 📄 File: \`${ic.path}\` (Line ${ic.line})\n${formatInlineCommentBody(ic.finding, { mascot: false })}`
            }).join('\n\n---\n\n') : finalBody;

          await this.assertCurrentHead(commitSha);
          const issueRes = await this.fetchWithRetry(issueUrl, {
            method: 'POST',
            body: JSON.stringify({ body: fallbackBody }),
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
      commentsCreated = retriedWithoutInline ? 0 : inlineComments.length;
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
