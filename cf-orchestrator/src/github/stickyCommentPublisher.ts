/**
 * stickyCommentPublisher.ts
 *
 * Edge-native publisher for the authoritative Review Yeti sticky PR summary comment.
 * Reconciles and upserts a single pinned comment per Pull Request using the canonical
 * overview marker, eliminating duplicate comment clutter across subsequent commits.
 */

import { type RunnerCostDetails, formatRunnerCostMarkdown } from '../runners/runnerCost.js';

export const STICKY_OVERVIEW_MARKER = '<!-- ct-review-bot:overview:v1 -->';
export const ALT_STICKY_OVERVIEW_MARKER = '<!-- review-yeti:overview:v1 -->';

export interface StickyCommentFinding {
  path: string;
  line: number;
  startLine?: number;
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'info' | 'critical' | 'major' | 'minor' | 'nit';
  title: string;
  description: string;
  suggestedFix?: string;
}

export interface StickyCommentMetrics {
  rawDiffTokens?: number;
  compactedTokens?: number;
  compactionRatio?: number;
  totalTokens?: number;
  costUSD?: number;
  durationMs?: number;
}

export interface StickyCommentOptions {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  token: string;
  verdict: 'success' | 'action_required' | 'neutral' | 'failure' | 'cancelled' | 'timed_out';
  findings?: StickyCommentFinding[];
  metrics?: StickyCommentMetrics;
  runnerCost?: RunnerCostDetails;
  dashboardOrigin?: string;
  jobId?: string;
  fetchFn?: typeof fetch;
}

export interface StickyCommentResult {
  success: boolean;
  commentId?: number;
  action: 'created' | 'updated' | 'noop';
  error?: string;
}

/**
 * Formats the rich markdown body for the sticky pull request overview comment.
 */
export function formatStickyCommentMarkdown(options: {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  verdict: 'success' | 'action_required' | 'neutral' | 'failure' | 'cancelled' | 'timed_out';
  findings?: StickyCommentFinding[];
  metrics?: StickyCommentMetrics;
  runnerCost?: RunnerCostDetails;
  dashboardOrigin?: string;
  jobId?: string;
}): string {
  const {
    owner,
    repo,
    prNumber,
    headSha,
    verdict,
    findings = [],
    metrics,
    runnerCost,
    dashboardOrigin = 'https://review-bot.example.com',
    jobId = `job_${owner}_${repo}_pr${prNumber}_${headSha.slice(0, 7)}`,
  } = options;

  const isSuccess = verdict === 'success';
  const isNeutral = verdict === 'neutral';

  const verdictBadge = isSuccess
    ? '### 🚦 Review Yeti Verdict: **SHIP** (Passed)'
    : isNeutral
      ? '### ⚠️ Review Yeti Verdict: **NEUTRAL** (Advisory)'
      : '### 🛑 Review Yeti Verdict: **BLOCK** (Changes Requested)';

  const shortSha = headSha.slice(0, 8);
  const sections: string[] = [
    verdictBadge,
    `Evaluated pull request commit [\`${shortSha}\`](https://github.com/${owner}/${repo}/commit/${headSha}).`,
  ];

  // Findings Breakdown Table
  if (findings.length > 0) {
    const rows: string[] = [
      '### 📝 Findings & Recommendations',
      '',
      '| Severity | Location | Finding | Recommended Action |',
      '|---|---|---|---|',
    ];

    for (const f of findings) {
      const sev = f.severity.toUpperCase();
      const loc = f.startLine && f.startLine < f.line
        ? `\`${f.path}:${f.startLine}-${f.line}\``
        : `\`${f.path}:${f.line}\``;
      const cleanTitle = (f.title || 'Advisory').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
      const action = (f.suggestedFix || f.description || '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br/>').trim();

      rows.push(`| **${sev}** | ${loc} | ${cleanTitle} | ${action} |`);
    }

    sections.push(rows.join('\n'));
  } else {
    sections.push('✅ **No blocking or critical findings detected.** All policy guardrails satisfied.');
  }

  // Runtime & Compaction Metrics
  if (metrics) {
    const metricLines: string[] = ['### ⚡ Execution & Compaction Metrics', ''];
    if (metrics.compactionRatio && metrics.compactionRatio > 1) {
      metricLines.push(`* **Diff Compaction**: ${metrics.compactionRatio}x reduction (${metrics.rawDiffTokens ?? 0} → ${metrics.compactedTokens ?? 0} tokens)`);
    }
    if (metrics.totalTokens) {
      metricLines.push(`* **Tokens Burned**: ${metrics.totalTokens.toLocaleString()}`);
    }
    if (metrics.durationMs) {
      metricLines.push(`* **Latency**: ${(metrics.durationMs / 1000).toFixed(1)}s`);
    }
    if (metricLines.length > 2) {
      sections.push(metricLines.join('\n'));
    }
  }

  // Runner Cost Details (if managed cloud runners used)
  if (runnerCost) {
    sections.push(formatRunnerCostMarkdown(runnerCost));
  }

  // Footer Navigation Links
  const cleanOrigin = dashboardOrigin.replace(/\/+$/, '');
  const liveUrl = `${cleanOrigin}/dashboard/live?jobId=${jobId}`;
  const orgUrl = `${cleanOrigin}/dashboard/organization`;
  sections.push(`---\n[📊 Live Terminal Dashboard](${liveUrl}) | [🏢 Org Settings](${orgUrl})`);

  return sections.join('\n\n');
}

/**
 * Searches for an existing Review Yeti sticky comment on a pull request.
 */
export async function findExistingStickyComment(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  fetchFn: typeof fetch = fetch
): Promise<number | null> {
  try {
    for (let page = 1; page <= 5; page++) {
      const res = await fetchFn(
        `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'ReviewYeti-Edge-Publisher/2.4',
          },
        }
      );

      if (!res.ok) {
        return null;
      }

      const comments = (await res.json()) as any[];
      if (!Array.isArray(comments) || comments.length === 0) {
        return null;
      }

      const match = comments.find((c: any) => {
        const body = typeof c?.body === 'string' ? c.body : '';
        return body.includes(STICKY_OVERVIEW_MARKER) || body.includes(ALT_STICKY_OVERVIEW_MARKER);
      });

      if (match && Number.isSafeInteger(match.id)) {
        return match.id;
      }

      if (comments.length < 100) {
        break;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Publishes or updates the sticky overview comment on a pull request.
 */
export async function publishStickyComment(options: StickyCommentOptions): Promise<StickyCommentResult> {
  const {
    owner,
    repo,
    prNumber,
    token,
    fetchFn = fetch,
  } = options;

  const content = formatStickyCommentMarkdown(options);
  const fullBody = `${STICKY_OVERVIEW_MARKER}\n\n${content}`;

  try {
    const existingId = await findExistingStickyComment(owner, repo, prNumber, token, fetchFn);

    if (existingId) {
      // Update existing comment
      const patchRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/issues/comments/${existingId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'ReviewYeti-Edge-Publisher/2.4',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body: fullBody }),
      });

      if (!patchRes.ok) {
        return {
          success: false,
          commentId: existingId,
          action: 'noop',
          error: `Failed to update comment (${patchRes.status}): ${await patchRes.text()}`,
        };
      }

      const data = (await patchRes.json()) as any;
      return {
        success: true,
        commentId: data?.id || existingId,
        action: 'updated',
      };
    }

    // Create new comment
    const postRes = await fetchFn(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'ReviewYeti-Edge-Publisher/2.4',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: fullBody }),
    });

    if (!postRes.ok) {
      return {
        success: false,
        action: 'noop',
        error: `Failed to create comment (${postRes.status}): ${await postRes.text()}`,
      };
    }

    const data = (await postRes.json()) as any;
    return {
      success: true,
      commentId: data?.id,
      action: 'created',
    };
  } catch (err: any) {
    return {
      success: false,
      action: 'noop',
      error: err?.message || String(err),
    };
  }
}
