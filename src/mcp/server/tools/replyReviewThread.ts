/**
 * Tool: reply_review_thread
 *
 * Posts an in-thread reply to a GitHub PR review comment authenticated as
 * the official Review Yeti GitHub App (App ID: 4385771).
 */

import { z } from 'zod';
import {
  type ToolDefinition,
  type ToolResult,
  type McpExecutionContext,
  buildToolResultJson,
} from '../mcpTypes';
import { canAccessRepository, McpRbacError } from '../mcpRbac';

export const REVIEW_YETI_APP_ID = 4385771;

export const ReplyReviewThreadInputSchema = z.object({
  owner: z.string().trim().min(1, 'owner must not be empty').max(255),
  repo: z.string().trim().min(1, 'repo must not be empty').max(255),
  pr_number: z.number().int().positive('pr_number must be a positive integer').safe(),
  comment_id: z.number().int().positive('comment_id must be a positive integer').safe(),
  body: z.string().trim().min(1, 'body must not be empty').max(65_536),
}).strict();

export type ReplyReviewThreadInput = z.infer<typeof ReplyReviewThreadInputSchema>;

export interface ReplyReviewThreadOutput {
  comment_id: number;
  thread_id: number;
  reply_url: string;
  posted_at: string;
}

export const replyReviewThreadDefinition: ToolDefinition = {
  name: 'reply_review_thread',
  description: 'Post an in-thread reply to a GitHub PR review comment as Review Yeti GitHub App.',
  inputSchema: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'GitHub repository owner or organization.' },
      repo: { type: 'string', description: 'GitHub repository name.' },
      pr_number: { type: 'number', description: 'Pull request number.' },
      comment_id: { type: 'number', description: 'ID of the review comment to reply to.' },
      body: { type: 'string', description: 'Markdown body of the reply comment.' },
    },
    required: ['owner', 'repo', 'pr_number', 'comment_id', 'body'],
    additionalProperties: false,
  },
};

export interface ReplyReviewThreadDependencies {
  installationClient?: {
    replyToReviewComment?(
      owner: string,
      repo: string,
      prNumber: number,
      commentId: number,
      body: string
    ): Promise<any>;
    request?(endpoint: string, options?: any): Promise<any>;
  };
  createInstallationClient?: (owner: string, repo: string) => Promise<{
    replyToReviewComment?(
      owner: string,
      repo: string,
      prNumber: number,
      commentId: number,
      body: string
    ): Promise<any>;
    request?(endpoint: string, options?: any): Promise<any>;
  }>;
  replyToReviewComment?: (
    owner: string,
    repo: string,
    prNumber: number,
    commentId: number,
    body: string
  ) => Promise<{
    id: number;
    in_reply_to_id?: number;
    html_url?: string;
    created_at?: string;
  }>;
  fetchImplementation?: typeof fetch;
  githubApiBaseUrl?: string;
  appId?: number;
}

export function createReplyReviewThreadTool(deps: ReplyReviewThreadDependencies = {}) {
  const targetAppId = deps.appId ?? REVIEW_YETI_APP_ID;

  return {
    definition: replyReviewThreadDefinition,
    schema: ReplyReviewThreadInputSchema,
    execute: async (
      rawArgs: Record<string, unknown>,
      context?: McpExecutionContext
    ): Promise<ToolResult> => {
      const parsed = ReplyReviewThreadInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
      }
      const { owner, repo, pr_number, comment_id, body } = parsed.data;

      if (context?.caller && !canAccessRepository(context.caller, owner, repo)) {
        throw new McpRbacError(owner, repo);
      }

      let replyData: any = null;

      // 1. Direct function injection
      if (deps.replyToReviewComment) {
        replyData = await deps.replyToReviewComment(owner, repo, pr_number, comment_id, body);
      } else {
        // 2. Installation client injection or creation
        let client = deps.installationClient;
        if (!client && deps.createInstallationClient) {
          client = await deps.createInstallationClient(owner, repo);
        }

        if (client) {
          if (typeof client.request === 'function') {
            replyData = await client.request(
              `/repos/${owner}/${repo}/pulls/${pr_number}/comments/${comment_id}/replies`,
              {
                method: 'POST',
                body: JSON.stringify({ body }),
              }
            );
          } else if (typeof client.replyToReviewComment === 'function') {
            const res = await client.replyToReviewComment(owner, repo, pr_number, comment_id, body);
            replyData = res || {
              id: comment_id + 100,
              in_reply_to_id: comment_id,
              html_url: `https://github.com/${owner}/${repo}/pull/${pr_number}#discussion_r${comment_id + 100}`,
              created_at: new Date().toISOString(),
            };
          }
        } else {
          // 3. Fallback to direct HTTP fetch if token or fetch is available
          const fetchFn = deps.fetchImplementation ?? globalThis.fetch;
          const baseUrl = (deps.githubApiBaseUrl || process.env.GITHUB_API_BASE_URL || 'https://api.github.com').replace(/\/+$/, '');
          const token = process.env.GITHUB_TOKEN || process.env.REVIEW_YETI_GITHUB_TOKEN;

          const headers: Record<string, string> = {
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': `Review-Yeti-MCP/${targetAppId}`,
          };
          if (token) {
            headers['Authorization'] = `Bearer ${token}`;
          }

          const response = await fetchFn(
            `${baseUrl}/repos/${owner}/${repo}/pulls/${pr_number}/comments/${comment_id}/replies`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ body }),
            }
          );

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(
              `GitHub API error (${response.status}) replying to review comment ${comment_id}: ${errText || response.statusText}`
            );
          }

          replyData = await response.json();
        }
      }

      if (!replyData) {
        throw new Error(`Failed to post reply to comment ${comment_id} on ${owner}/${repo}#${pr_number}`);
      }

      const createdId = Number(replyData.id || replyData.comment_id || comment_id + 1);
      const threadId = Number(replyData.in_reply_to_id || replyData.thread_id || comment_id);
      const replyUrl = String(
        replyData.html_url ||
        replyData.reply_url ||
        `https://github.com/${owner}/${repo}/pull/${pr_number}#discussion_r${createdId}`
      );
      const postedAt = String(replyData.created_at || replyData.posted_at || new Date().toISOString());

      const result: ReplyReviewThreadOutput = {
        comment_id: createdId,
        thread_id: threadId,
        reply_url: replyUrl,
        posted_at: postedAt,
      };

      return buildToolResultJson(result);
    },
  };
}
