import { createHash } from 'node:crypto';
import { logger } from '../utils/logger';
import { GraphLearningEngine } from '../memory/graphLearningEngine';
import { PanelFinding, FixOption } from '../panel/panelEngine';

// REL-583: FixOption now lives with PanelFinding in the panel module (github -> panel is the
// established direction). Re-exported so existing `from '../github/commentPublisher'` importers
// keep resolving.
export type { FixOption };
import { NitSuppressionEngine } from '../reflection/nitSuppressionEngine';

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
  replacementCode?: string;
  codeSnippet?: string;
  fixOptions?: FixOption[];
  isRedTeam?: boolean;
  crossExaminedModel?: string;
  attackVector?: string;
  failureMode?: string;
  mitigation?: string;
  startLine?: number;
  isArchitectural?: boolean;
}

export interface CommentPublisherOptions {
  githubToken?: string;
  /** Bot login resolved from the authenticated App JWT identity endpoint. */
  publisherLogin?: string;
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
  subjectType?: 'file';
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  startLine?: number;
  finding: PersonaFinding;
  owner?: string;
  repo?: string;
  prNumber?: number;
  commitSha?: string;
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
  /** Keep the verdict in one PR issue comment; reviews contain inline findings only. */
  stickyOverview?: boolean;
  /** Stable marker used to make reruns and ambiguous POST outcomes idempotent. */
  idempotencyKey?: string;
}

export interface PublishResult {
  success: boolean;
  reviewId?: number;
  summaryCommentId?: number;
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
 * Wraps code into a clean GitHub 1-click suggestion block, avoiding markdown fence conflicts
 * and cleaning line trimming.
 */
export function formatSuggestionBlock(code: string): string {
  let clean = code;
  const trimmed = clean.trim();
  if (trimmed.startsWith('```')) {
    clean = trimmed
      .replace(/^```[^\r\n]*\r?\n?/, '')
      .replace(/\r?\n?```$/, '')
      .trim();
  }
  if (clean.trim() === '') {
    return '```suggestion\n\n```\n';
  }
  const trimmedLines = clean.replace(/^\r?\n+/, '').replace(/\r?\n+$/, '');
  return `\`\`\`suggestion\n${trimmedLines}\n\`\`\`\n`;
}

/**
 * Renders a structured fallback markdown table for a single finding when no code suggestion is present,
 * or when architectural / multi-file guidance is being rendered.
 */
export function formatFindingFallbackTable(finding: PersonaFinding): string {
  const severityFormatted = (finding.severity || 'P2').toUpperCase();
  const effectiveStart = finding.startLine;
  const location = effectiveStart && effectiveStart > 0 && effectiveStart < finding.lineNumber
    ? `\`${finding.filePath}:${effectiveStart}-${finding.lineNumber}\``
    : `\`${finding.filePath}:${finding.lineNumber}\``;
  const action = finding.recommendation || finding.suggestion || finding.comment;
  const sanitizedAction = action.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
  const sanitizedFinding = (finding.title || finding.comment.split('\n')[0]).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

  return [
    '| Severity | Location | Finding | Recommended Action |',
    '|---|---|---|---|',
    `| **${severityFormatted}** | ${location} | ${sanitizedFinding} | ${sanitizedAction} |`,
  ].join('\n');
}

/**
 * Formats a list of inline comments into a structured fallback markdown table
 * for top-level review summaries when HTTP 422 or unmappable lines occur.
 */
export function formatInlineFindingsFallbackTable(
  inlineComments: PublishInlineCommentRequest[]
): string {
  if (!inlineComments || inlineComments.length === 0) return '';

  const rows: string[] = [
    '### 📝 Actionable Findings (Diff Line Resolution Fallback)',
    '',
    '| Severity | Location | Finding | Recommended Action |',
    '|---|---|---|---|',
  ];

  for (const ic of inlineComments) {
    const f = ic.finding;
    const severity = (f.severity || 'P2').toUpperCase();
    const effectiveStartLine = ic.startLine ?? f.startLine;
    const location = effectiveStartLine && effectiveStartLine > 0 && effectiveStartLine < ic.line
      ? `\`${ic.path}:${effectiveStartLine}-${ic.line}\``
      : `\`${ic.path}:${ic.line}\``;

    const rawFinding = f.title || f.comment.split('\n')[0] || 'Issue detected';
    const cleanFinding = rawFinding.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();

    let action = '';
    if (f.fixOptions && f.fixOptions.length > 0) {
      const sorted = [...f.fixOptions].sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1));
      if (sorted[0].suggestionCode) {
        action = sorted[0].suggestionCode;
      }
    }
    if (!action) {
      if (f.suggestion) {
        action = f.suggestion;
      } else if (f.codeSnippet) {
        action = f.codeSnippet;
      } else if (f.recommendation) {
        action = f.recommendation;
      } else {
        action = f.comment;
      }
    }

    const cleanAction = action
      .replace(/\|/g, '\\|')
      .replace(/\r?\n/g, '<br/>')
      .trim();

    rows.push(`| **${severity}** | ${location} | ${cleanFinding} | ${cleanAction} |`);
  }

  return rows.join('\n');
}

/**
 * Formats a PersonaFinding into a rich GitHub inline comment body with optional suggestion block.
 */
export function formatInlineCommentBody(
  finding: PersonaFinding,
  options?: { mascot?: boolean; fallbackTable?: boolean }
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

  if (!finding.isArchitectural && finding.fixOptions && finding.fixOptions.length > 0) {
    body += '\n';
    const ranks = finding.fixOptions.map(f => f.rank).filter((r): r is number => typeof r === 'number');
    const isDistinctRanks = ranks.length === finding.fixOptions.length && new Set(ranks).size === ranks.length;
    const sorted = isDistinctRanks
      ? [...finding.fixOptions].sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1))
      : finding.fixOptions;
    const optionsToFormat = sorted.slice(0, 2);
    optionsToFormat.forEach((fix, i) => {
      const displayNum = i + 1;
      const rankNum = isDistinctRanks ? (fix.rank ?? displayNum) : displayNum;
      const defaultTitle = displayNum === 1 ? 'Recommended Fix' : 'Alternative Approach';
      const optionTitle = fix.title || defaultTitle;
      body += `#### Option ${displayNum}: ${optionTitle} (Rank #${rankNum})\n`;
      if (fix.explanation) {
        body += `${fix.explanation}\n`;
      }
      if (fix.suggestionCode) {
        body += formatSuggestionBlock(fix.suggestionCode);
      }
    });
  } else if (!finding.isArchitectural && typeof finding.replacementCode === 'string') {
    const fence = '`'.repeat(Math.max(3, ...(finding.replacementCode.match(/`+/g) || []).map(run => run.length + 1)));
    body += `\n${fence}suggestion\n${finding.replacementCode}\n${fence}\n`;
  } else if (!finding.isArchitectural && finding.codeSnippet) {
    body += `\n${formatSuggestionBlock(finding.codeSnippet)}`;
  } else if (finding.isArchitectural || options?.fallbackTable || finding.recommendation) {
    body += '\n' + formatFindingFallbackTable(finding) + '\n';
  }

  if (finding.suggestion && !finding.isArchitectural) {
    body += `\n**Suggested fix**\n\n${finding.suggestion}\n`;
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
  private publisherLogin?: string;

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
    this.publisherLogin = options.publisherLogin;
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

  private async authenticatedPublisherLogin(): Promise<string> {
    if (!this.publisherLogin?.endsWith('[bot]')) throw new Error('Authenticated GitHub App publisher identity is required');
    return this.publisherLogin;
  }

  private async upsertOverview(req: PublishReviewRequest): Promise<number> {
    const login = await this.authenticatedPublisherLogin();
    const marker = '<!-- ct-review-bot:overview:v1 -->';
    const endpoint = `${this.baseUrl}/repos/${req.owner}/${req.repo}/issues/${req.prNumber}/comments`;
    const findOverview = async (): Promise<number | undefined> => {
      for (let page = 1; page <= 100; page++) {
        const response = await this.fetchWithRetry(`${endpoint}?per_page=100&page=${page}`, { method: 'GET' });
        if (!response.ok) throw new Error(`GitHub overview lookup returned HTTP ${response.status}`);
        const comments = await response.json();
        if (!Array.isArray(comments)) throw new Error('GitHub overview lookup response was not an array');
        const existing = comments.find((comment: any) => comment.user?.type === 'Bot' && comment.user?.login === login
          && typeof comment.body === 'string' && comment.body.includes(marker));
        if (existing && Number.isFinite(Number(existing.id))) return Number(existing.id);
        if (comments.length < 100) return undefined;
      }
      throw new Error('GitHub overview lookup exceeded pagination limit');
    };
    const write = async (id?: number) => {
      await this.assertCurrentHead(req.commitSha);
      return this.fetchWithRetry(id === undefined ? endpoint : `${this.baseUrl}/repos/${req.owner}/${req.repo}/issues/comments/${id}`, {
        method: id === undefined ? 'POST' : 'PATCH',
        body: JSON.stringify({ body: `${marker}\n${req.body}` }),
      });
    };
    const existingId = await findOverview();
    let response: Response;
    try {
      response = await write(existingId);
    } catch (error) {
      // A disconnected POST may have succeeded. Reconcile before another write.
      if (existingId !== undefined) throw error;
      const recoveredId = await findOverview();
      if (recoveredId === undefined) throw error;
      response = await write(recoveredId);
    }
    if (!response.ok) throw new Error(`GitHub overview publication returned HTTP ${response.status}`);
    const written: unknown = await response.json();
    if (!written || typeof written !== 'object' || !('id' in written)
      || typeof written.id !== 'number' || !Number.isSafeInteger(written.id) || written.id <= 0) {
      throw new Error('GitHub overview write returned no comment ID');
    }
    const id = written.id;
    const verified = await this.fetchWithRetry(`${this.baseUrl}/repos/${req.owner}/${req.repo}/issues/comments/${id}`, { method: 'GET' });
    if (!verified.ok) throw new Error(`GitHub overview verification returned HTTP ${verified.status}`);
    const saved: unknown = await verified.json();
    await this.assertCurrentHead(req.commitSha);
    if (!saved || typeof saved !== 'object' || !('user' in saved) || !saved.user
      || typeof saved.user !== 'object' || !('login' in saved.user) || saved.user.login !== login
      || !('body' in saved) || saved.body !== `${marker}\n${req.body}`) {
      throw new Error('GitHub overview verification did not match the published body and author');
    }
    return id;
  }

  private async publishStickyReview(req: PublishReviewRequest): Promise<PublishResult> {
    const login = await this.authenticatedPublisherLogin();
    const endpoint = `${this.baseUrl}/repos/${req.owner}/${req.repo}/pulls/${req.prNumber}/comments`;
    const listComments = async (): Promise<any[]> => {
      const result: any[] = [];
      for (let page = 1; page <= 100; page++) {
        const response = await this.fetchWithRetry(`${endpoint}?per_page=100&page=${page}`, { method: 'GET' });
        if (!response.ok) throw new Error(`GitHub inline lookup returned HTTP ${response.status}`);
        const comments = await response.json();
        if (!Array.isArray(comments)) throw new Error('GitHub inline lookup response was not an array');
        result.push(...comments);
        if (comments.length < 100) return result;
      }
      throw new Error('GitHub inline lookup exceeded pagination limit');
    };
    let created = 0;
    const inline = req.inlineComments || [];
    const existing = inline.length ? await listComments() : [];
    for (const comment of inline) {
      const finding = { ...comment.finding };
      if (comment.subjectType === 'file') {
        delete finding.replacementCode;
        delete finding.codeSnippet;
        delete finding.fixOptions;
        delete finding.startLine;
      }
      const formatted = formatInlineCommentBody(finding, { mascot: req.mascot });
      const digest = createHash('sha256').update(JSON.stringify([
        req.commitSha, comment.path, comment.subjectType || 'line', comment.line,
        comment.side || 'RIGHT', comment.startLine, formatted,
      ])).digest('hex');
      const marker = `<!-- ct-review-bot:inline:v1:${digest} -->`;
      const hasMarker = (comments: any[]) => comments.some(c => c.user?.type === 'Bot' && c.user?.login === login && typeof c.body === 'string' && c.body.includes(marker));
      if (hasMarker(existing)) continue;
      const startLine = comment.startLine ?? finding.startLine;
      const side = comment.side || 'RIGHT';
      const payload = {
        commit_id: req.commitSha,
        path: comment.path,
        body: `${formatted}\n${marker}`,
        ...(comment.subjectType === 'file' ? { subject_type: 'file' } : {
          line: comment.line, side,
          ...(Number.isInteger(startLine) && startLine! > 0 && startLine! < comment.line
            ? { start_line: startLine, start_side: side } : {}),
        }),
      };
      await this.assertCurrentHead(req.commitSha);
      let response: Response;
      try {
        response = await this.fetchWithRetry(endpoint, { method: 'POST', body: JSON.stringify(payload) });
      } catch (error) {
        const recovered = await listComments();
        if (!hasMarker(recovered)) throw error;
        existing.push(...recovered);
        continue;
      }
      if (!response.ok) throw new Error(`GitHub inline publication returned HTTP ${response.status}: ${await response.text()}`);
      existing.push(await response.json());
      created += 1;
    }
    const overviewId = await this.upsertOverview(req);
    return { success: true, summaryCommentId: overviewId, commentsCreated: created };
  }

  public async publishReview(req: PublishReviewRequest): Promise<PublishResult> {
    const { owner, repo, prNumber, commitSha, event, body, inlineComments = [] } = req;
    let commentsCreated = 0;
    const errors: string[] = [];

    try {
      if (req.stickyOverview) return await this.publishStickyReview(req);
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
        comments: inlineComments.map(({ path, line, side = 'RIGHT', startLine, finding }) => {
          const effectiveStartLine = startLine ?? finding.startLine;
          const hasRange = Number.isInteger(effectiveStartLine) && effectiveStartLine! > 0 && effectiveStartLine! < line;
          return {
            path,
            line,
            side,
            ...(hasRange ? { start_line: effectiveStartLine, start_side: side } : {}),
            body: formatInlineCommentBody(finding, { mascot: req.mascot }),
          };
        }),
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
        if ((res.status === 422 || errorText.includes('Line could not be resolved') || errorText.includes('Unprocessable Entity')) && inlineComments.length > 0 && !req.stickyOverview) {
          logger.info(`Retrying review publication without inline comments due to line resolution error`);
          retriedWithoutInline = true;
          const fallbackTable = formatInlineFindingsFallbackTable(inlineComments);
          const fallbackBody = `${finalBody}\n\n${fallbackTable}`;

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
          const fallbackTable = formatInlineFindingsFallbackTable(inlineComments);
          const fallbackBody = (inlineComments.length > 0 && retriedWithoutInline)
            ? `${finalBody}\n\n${fallbackTable}`
            : finalBody;

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
