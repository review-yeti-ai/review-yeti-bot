/**
 * reviewPublisher.ts
 *
 * Formats and publishes Pull Request reviews and line-level 1-click suggestions
 * to GitHub via POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews.
 *
 * Implements Phase 2: PR Review Experience with ```suggestion blocks so developers
 * can 1-click apply Review Yeti recommendations directly in GitHub diffs.
 */

import { type RunnerCostDetails, formatRunnerCostMarkdown } from './runners/runnerCost.js';
export type { RunnerCostDetails };

export interface InlineFindingSuggestion {
  path: string;
  line: number;
  startLine?: number;
  side?: 'RIGHT' | 'LEFT';
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'info';
  ruleId?: string;
  title: string;
  description: string;
  suggestedFix?: string;
}

export interface GitHubReviewComment {
  path: string;
  line: number;
  start_line?: number;
  side?: 'RIGHT' | 'LEFT';
  body: string;
}

export interface GitHubReviewPayload {
  commit_id: string;
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments: GitHubReviewComment[];
}

/**
 * Formats a single finding with optional ```suggestion markdown block.
 */
export function formatSuggestionBody(finding: InlineFindingSuggestion): string {
  // ADR 0002: P0, P1 and P2 are all required before merge.
  const badge = finding.severity === 'P0' || finding.severity === 'P1'
    ? `🚨 **[${finding.severity}]**`
    : finding.severity === 'P2'
      ? `⚠️ **[${finding.severity} - Required to address]**`
      : `💡 **[${finding.severity}]**`;

  let body = `${badge} **${finding.title}**\n\n${finding.description.trim()}`;

  if (finding.ruleId) {
    body += `\n\n*Rule: \`${finding.ruleId}\`*`;
  }

  if (finding.suggestedFix !== undefined && finding.suggestedFix !== null) {
    const cleanFix = finding.suggestedFix.replace(/\r\n/g, '\n');
    body += `\n\n\`\`\`suggestion\n${cleanFix}\n\`\`\``;
  }

  return body;
}

/**
 * Builds the complete GitHub PR Review payload with all inline comments and overall verdict.
 */
export function buildGitHubReviewPayload(params: {
  commitId: string;
  verdict: 'success' | 'action_required' | 'neutral';
  summaryMarkdown: string;
  findings: InlineFindingSuggestion[];
  runnerCost?: RunnerCostDetails;
}): GitHubReviewPayload {
  const { commitId, verdict, summaryMarkdown, findings, runnerCost } = params;

  // Append runner cost item if managed runners were used
  let body = summaryMarkdown;
  if (runnerCost) {
    const costSection = formatRunnerCostMarkdown(runnerCost);
    body = `${body.trim()}\n\n---\n\n${costSection}`;
  }

  // Map verdict to GitHub PR review event. P0, P1 and P2 all block (ADR 0002). A blocking finding
  // is never approved, even if the upstream verdict and the finding list disagree.
  const hasBlockers = findings.some(f => f.severity === 'P0' || f.severity === 'P1' || f.severity === 'P2');
  let event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' = 'COMMENT';
  if (verdict === 'success') {
    event = hasBlockers ? 'REQUEST_CHANGES' : 'APPROVE';
  } else if (verdict === 'action_required') {
    event = hasBlockers ? 'REQUEST_CHANGES' : 'COMMENT';
  }

  const comments: GitHubReviewComment[] = findings
    .filter(f => Boolean(f.path && typeof f.line === 'number' && f.line > 0))
    .map(f => {
      const comment: GitHubReviewComment = {
        path: f.path,
        line: f.line,
        side: f.side || 'RIGHT',
        body: formatSuggestionBody(f),
      };
      if (f.startLine && f.startLine < f.line) {
        comment.start_line = f.startLine;
      }
      return comment;
    });

  return {
    commit_id: commitId,
    body,
    event,
    comments,
  };
}

/**
 * Publishes the review to GitHub API.
 */
export async function publishGitHubPullRequestReview(options: {
  owner: string;
  repo: string;
  prNumber: number;
  token: string;
  payload: GitHubReviewPayload;
  fetchFn?: typeof fetch;
}): Promise<{ success: boolean; reviewId?: number; htmlUrl?: string; error?: string }> {
  const { owner, repo, prNumber, token, payload, fetchFn = fetch } = options;
  const endpoint = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;

  try {
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ReviewYeti-Edge-Orchestrator',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        success: false,
        error: `GitHub API error (${response.status}): ${errText}`,
      };
    }

    const data = (await response.json()) as any;
    return {
      success: true,
      reviewId: data?.id,
      htmlUrl: data?.html_url,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err?.message || String(err),
    };
  }
}
