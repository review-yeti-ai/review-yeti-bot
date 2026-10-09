import type { McpToolHandler, McpExecutionContext, ToolResult } from '../types.js';
import { getInstallationToken } from '../../github/index.js';

export interface ReplyReviewThreadOutput {
  comment_id: number;
  thread_id: number;
  reply_url: string;
  posted_at: string;
}

export const replyReviewThreadTool: McpToolHandler = {
  definition: {
    name: 'review_yeti_reply_review_thread',
    description: 'Post an in-thread reply to a GitHub PR review comment authenticated as Review Yeti.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          default: 'exampleorg',
          description: 'GitHub repository owner or organization.',
        },
        repo: {
          type: 'string',
          description: 'GitHub repository name.',
        },
        pr_number: {
          type: 'number',
          description: 'Pull request number.',
        },
        comment_id: {
          type: 'number',
          description: 'ID of the review comment to reply to.',
        },
        body: {
          type: 'string',
          description: 'Markdown body of the reply comment.',
        },
      },
      required: ['repo', 'pr_number', 'comment_id', 'body'],
    },
  },

  async execute(args: Record<string, any>, context: McpExecutionContext): Promise<ToolResult> {
    const owner = (args.owner || 'exampleorg').trim();
    const repo = (args.repo || '').trim();
    const prNumber = Number(args.pr_number ?? args.prNumber);
    const commentId = Number(args.comment_id ?? args.commentId);
    const body = String(args.body || '').trim();
    const env = context.env || {};

    if (!repo || isNaN(prNumber) || isNaN(commentId) || !body) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: "repo", "pr_number", "comment_id", and "body" are required parameters.',
          },
        ],
      };
    }

    // Resolve GitHub App installation token or PAT
    let token: string | null = null;
    try {
      token = await getInstallationToken(env, owner, repo);
    } catch {
      token = null;
    }
    if (!token) {
      token = env.GITHUB_TOKEN || env.REVIEW_YETI_GITHUB_TOKEN || null;
    }

    // Direct mock injection for testing / sandbox environments
    if (args._mockResponse) {
      return {
        content: [
          {
            type: 'text',
            text: `Replied to comment #${commentId} in PR #${prNumber}`,
          },
          {
            type: 'text',
            text: JSON.stringify(args._mockResponse, null, 2),
          },
        ],
      };
    }

    if (!token) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Error: GitHub authentication token unavailable to post reply.',
          },
        ],
      };
    }

    const replyUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`;
    try {
      const res = await fetch(replyUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'User-Agent': 'ReviewYeti-Edge-Orchestrator',
        },
        body: JSON.stringify({ body }),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error: GitHub API rejected review comment reply: HTTP ${res.status} - ${errorText}`,
            },
          ],
        };
      }

      const data = (await res.json()) as any;
      const output: ReplyReviewThreadOutput = {
        comment_id: data.id || commentId,
        thread_id: data.in_reply_to_id || commentId,
        reply_url: data.html_url || '',
        posted_at: data.created_at || new Date().toISOString(),
      };

      return {
        content: [
          {
            type: 'text',
            text: `Successfully posted reply to review comment #${commentId} on PR #${prNumber}.`,
          },
          {
            type: 'text',
            text: JSON.stringify(output, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: Exception while posting review comment reply: ${err?.message || String(err)}`,
          },
        ],
      };
    }
  },
};
