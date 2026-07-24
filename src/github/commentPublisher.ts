import { logger } from '../utils/logger';
import { PersonaFinding, QuorumEvaluationResult } from '../quorum/quorumEngine';

export interface CommentPublisherOptions {
  githubToken?: string;
  authToken?: string;
  baseUrl?: string; // Supports mock GitHub server or GitHub Enterprise Base URL
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
  const personaEmoji: Record<string, string> = {
    security: '🛡️',
    architecture: '📐',
    performance: '⚡',
    quality: '🔍',
  };

  const emoji = personaEmoji[finding.persona.toLowerCase()] || '🤖';
  const severityFormatted = finding.severity.toUpperCase();
  const confidence = finding.confidence ?? 95;

  let body = `### ${emoji} [${finding.persona.toUpperCase()}] Severity: ${severityFormatted} (🎯 Confidence: ${confidence}%)\n\n`;
  body += `**Finding**: ${finding.comment}\n`;

  if (finding.recommendation) {
    body += `\n💡 **Recommendation**: ${finding.recommendation}\n`;
  }

  if (finding.rankedFixes && finding.rankedFixes.length > 0) {
    body += `\n🛠️ **Ranked Potential Fixes (Up to 2 Options)**:\n`;
    for (const fix of finding.rankedFixes.slice(0, 2)) {
      const badge = fix.rank === 1 ? '🥇 **Option 1 (Recommended)**' : '🥈 **Option 2 (Alternative)**';
      body += `\n${badge}: ${fix.title}\n`;
      if (fix.description) {
        body += `${fix.description}\n`;
      }
      if (fix.codeSnippet) {
        body += `\`\`\`yaml\n${fix.codeSnippet}\n\`\`\`\n`;
      }
    }
  } else if (finding.suggestion || finding.codeSnippet) {
    const code = finding.suggestion || finding.codeSnippet;
    body += `\n\`\`\`suggestion\n${code}\n\`\`\`\n`;
  }

  return body;
}

export interface PersonaUsageDetail {
  persona: string;
  provider: string;
  model: string;
  effortLevel: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD: number;
  durationMs: number;
}

export interface ReviewRunReport {
  totalDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUSD: number;
  diffDeltaSavingsPercent?: number;
  personaDetails: PersonaUsageDetail[];
}

export function formatCostAndUsageReport(report: ReviewRunReport): string {
  let table = `### 📊 Review Token Usage & Cost Report\n\n`;
  table += `| Persona | Provider / Model | Effort | Prompt Tokens | Completion Tokens | Total Tokens | Cost (USD) | Latency |\n`;
  table += `|---|---|---|---|---|---|---|---|\n`;

  for (const detail of report.personaDetails) {
    const costStr = `$${detail.costUSD.toFixed(6)}`;
    const latencyStr = `${detail.durationMs}ms`;
    table += `| **${detail.persona.toUpperCase()}** | \`${detail.provider}\` (${detail.model}) | ${detail.effortLevel} | ${detail.promptTokens.toLocaleString()} | ${detail.completionTokens.toLocaleString()} | ${detail.totalTokens.toLocaleString()} | ${costStr} | ${latencyStr} |\n`;
  }

  table += `\n**Run Summary**:\n`;
  table += `- ⏱️ **Total Review Latency**: \`${(report.totalDurationMs / 1000).toFixed(2)}s\`\n`;
  table += `- 🪙 **Total Tokens Used**: \`${report.totalTokens.toLocaleString()} tokens\` (\`${report.totalPromptTokens.toLocaleString()} prompt\` / \`${report.totalCompletionTokens.toLocaleString()} completion\`)\n`;
  table += `- 💵 **Total Run Spend**: \`$${report.totalCostUSD.toFixed(6)} USD\`\n`;
  if (report.diffDeltaSavingsPercent !== undefined) {
    table += `- 📈 **Diff Delta Token Savings**: \`${report.diffDeltaSavingsPercent}% token reduction\` (evaluated new diff hunks only)\n`;
  }

  return table;
}

export class CommentPublisher {
  private baseUrl: string;
  private token?: string;
  private maxRetries: number;
  private initialRetryDelayMs: number;
  private maxDelayMs: number;

  constructor(options: CommentPublisherOptions = {}) {
    this.baseUrl = (options.baseUrl || process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/$/, '');
    this.token = options.authToken || options.githubToken || process.env.GITHUB_APP_INSTALLATION_TOKEN || process.env.GITHUB_TOKEN;
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
    if (this.token) {
      const authPrefix = this.token.startsWith('ghs_') || this.token.startsWith('ghu_') ? 'Bearer' : 'token';
      headers.set('Authorization', `${authPrefix} ${this.token}`);
    }
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
   * Retrieves existing inline comments on a Pull Request for thread deduplication.
   */
  public async getExistingComments(owner: string, repo: string, prNumber: number): Promise<any[]> {
    try {
      const url = `${this.baseUrl}/repos/${owner}/${repo}/pulls/${prNumber}/comments`;
      const res = await this.fetchWithRetry(url, { method: 'GET' });
      if (res.ok) {
        return (await res.json()) as any[];
      }
      return [];
    } catch (err) {
      logger.warn('Failed to fetch existing comments for deduplication', { owner, repo, prNumber, err });
      return [];
    }
  }

  /**
   * Publishes an individual inline code review comment on a Pull Request.
   */
  public async publishInlineComment(req: PublishInlineCommentRequest): Promise<PublishResult> {
    const { owner, repo, prNumber, commitSha, path, line, side = 'RIGHT', finding } = req;
    const body = formatInlineCommentBody(finding);

    try {
      // Check existing comments for deduplication
      const existing = await this.getExistingComments(owner, repo, prNumber);
      const isDuplicate = existing.some(
        (c: any) =>
          c.path === path &&
          (c.line === line || c.position === line) &&
          c.body &&
          c.body.includes(`[${finding.persona.toUpperCase()}]`)
      );

      if (isDuplicate) {
        logger.info(`Skipping duplicate inline comment for ${finding.persona} at ${path}:${line}`);
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
    } catch (err: any) {
      logger.error('Failed to publish inline comment', { err: err?.message || err });
      return { success: false, commentsCreated: 0, errors: [err?.message || 'Network error'] };
    }
  }

  /**
   * Publishes a top-level review summary and optional inline comments on a Pull Request.
   */
  public async publishReview(req: PublishReviewRequest): Promise<PublishResult> {
    const { owner, repo, prNumber, commitSha, event, body, inlineComments = [] } = req;
    let commentsCreated = 0;
    const errors: string[] = [];

    // Publish inline comments first
    for (const inlineReq of inlineComments) {
      const inlineRes = await this.publishInlineComment(inlineReq);
      if (inlineRes.success) {
        commentsCreated += inlineRes.commentsCreated;
      } else if (inlineRes.errors) {
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

      const resData: any = await res.json();
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

  /**
   * Helper to format and publish a Quorum review result.
   */
  public async publishQuorumReview(options: {
    owner: string;
    repo: string;
    prNumber: number;
    commitSha: string;
    quorumResult: QuorumEvaluationResult;
    ticketResult?: any;
    constitutionResult?: any;
  }): Promise<PublishResult> {
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

    const inlineComments: PublishInlineCommentRequest[] = quorumResult.activeFindings.map((finding) => ({
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

  /**
   * Posts or updates a Commit Status Check (e.g., ct-review-bot / quorum-panel)
   */
  public async setCommitStatus(options: {
    owner: string;
    repo: string;
    sha: string;
    state: 'pending' | 'success' | 'failure' | 'error';
    context?: string;
    description?: string;
    targetUrl?: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { owner, repo, sha, state, context = 'ct-review-bot / quorum-panel', description = 'Automated Quorum Code Review', targetUrl } = options;
    const url = `${this.baseUrl}/repos/${owner}/${repo}/statuses/${sha}`;

    try {
      const res = await this.fetchWithRetry(url, {
        method: 'POST',
        body: JSON.stringify({
          state,
          context,
          description,
          target_url: targetUrl || `https://github.com/${owner}/${repo}`,
        }),
      });

      if (res.ok) {
        logger.info(`Set commit status '${state}' for ${owner}/${repo}@${sha.substring(0, 7)} [${context}]`);
        return { success: true };
      }

      const errText = await res.text();
      logger.error(`Failed to set commit status`, { status: res.status, errText });
      return { success: false, error: errText };
    } catch (err: any) {
      logger.error(`Exception setting commit status`, { err: err?.message || err });
      return { success: false, error: err?.message || 'Network error' };
    }
  }

  /**
   * Creates a GitHub Check Run with granular output findings
   */
  public async createCheckRun(options: {
    owner: string;
    repo: string;
    headSha: string;
    name?: string;
    status?: 'queued' | 'in_progress' | 'completed';
    conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'action_required';
    title?: string;
    summary?: string;
  }): Promise<{ success: boolean; checkRunId?: number; error?: string }> {
    const { owner, repo, headSha, name = 'ct-review-bot / quorum-review', status = 'completed', conclusion = 'success', title = 'Quorum Code Review', summary = 'Automated review completed successfully' } = options;
    const url = `${this.baseUrl}/repos/${owner}/${repo}/check-runs`;

    try {
      const res = await this.fetchWithRetry(url, {
        method: 'POST',
        body: JSON.stringify({
          name,
          head_sha: headSha,
          status,
          conclusion,
          output: {
            title,
            summary,
          },
        }),
      });

      if (res.ok) {
        const data: any = await res.json();
        logger.info(`Created check run '${name}' for ${owner}/${repo}@${headSha.substring(0, 7)}`);
        return { success: true, checkRunId: data.id };
      }

      const errText = await res.text();
      return { success: false, error: errText };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Network error' };
    }
  }
}

