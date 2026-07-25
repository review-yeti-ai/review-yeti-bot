import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandDispatcher, parseCommand, ChatContext } from '../../src/chat/commandDispatcher';
import { GitHubInstallationClient } from '../../src/github/installationClient';

describe('commandDispatcher.ts — PR Interactive Chat & Command Dispatcher', () => {
  let dispatcher: CommandDispatcher;
  let mockGithub: any;
  let mockOmniRoute: any;
  let mockOnRunReviewPipeline: any;
  let context: ChatContext;

  beforeEach(() => {
    dispatcher = new CommandDispatcher('openai/gpt-4o');

    mockGithub = {
      getPullRequest: vi.fn().mockResolvedValue({
        headSha: 'head-sha-123',
        baseSha: 'base-sha-123',
        title: 'feat: new feature',
        body: 'PR body description',
      }),
      getChangedFiles: vi.fn().mockResolvedValue([
        { path: 'src/app.ts', patch: '@@ -1,3 +1,5 @@\n+import express from "express";\n+const app = express();' },
        { path: 'src/config.ts', patch: '@@ -10,2 +10,3 @@\n+export const port = 3000;' },
      ]),
      getReviewCommentThread: vi.fn().mockResolvedValue([
        {
          id: 101,
          body: 'Original inline comment: Potential bug here',
          user: { login: 'reviewer' },
          path: 'src/app.ts',
          diff_hunk: '@@ -1,3 +1,5 @@\n+import express from "express";',
        },
        {
          id: 102,
          body: '@ct-review explain',
          user: { login: 'developer' },
          in_reply_to_id: 101,
        },
      ]),
      replyToReviewComment: vi.fn().mockResolvedValue({ id: 103 }),
      postIssueComment: vi.fn().mockResolvedValue({ id: 201 }),
    };

    mockOmniRoute = {
      complete: vi.fn().mockResolvedValue({
        model: 'openai/gpt-4o',
        content: 'LLM generated response content',
        usage: { prompt: 100, completion: 50, total: 150 },
        costUSD: 0.002,
      }),
    };

    mockOnRunReviewPipeline = vi.fn().mockResolvedValue({ status: 'processed' });

    context = {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 42,
      headSha: 'head-sha-123',
      baseSha: 'base-sha-123',
      github: mockGithub as unknown as GitHubInstallationClient,
      omniRoute: mockOmniRoute,
      onRunReviewPipeline: mockOnRunReviewPipeline,
      payload: { prNumber: 42, owner: 'calltelemetry', repo: 'ct-review-bot' },
    };
  });

  describe('parseCommand()', () => {
    it('parses "@ct-review review" correctly', () => {
      const result = parseCommand('@ct-review review');
      expect(result).not.toBeNull();
      expect(result?.command).toBe('review');
      expect(result?.args).toBe('');
    });

    it('parses "@ct-review explain" correctly', () => {
      const result = parseCommand('@ct-review explain');
      expect(result).not.toBeNull();
      expect(result?.command).toBe('explain');
    });

    it('parses "@ct-review refactor" correctly', () => {
      const result = parseCommand('@ct-review refactor');
      expect(result).not.toBeNull();
      expect(result?.command).toBe('refactor');
    });

    it('parses "@ct-review summarize" correctly', () => {
      const result = parseCommand('@ct-review summarize');
      expect(result).not.toBeNull();
      expect(result?.command).toBe('summarize');
    });

    it('parses "@ct-review ask <question>" with arguments', () => {
      const result = parseCommand('@ct-review ask How does error handling work in this PR?');
      expect(result).not.toBeNull();
      expect(result?.command).toBe('ask');
      expect(result?.args).toBe('How does error handling work in this PR?');
    });

    it('parses alternate mentions like "@ct-review-bot" or "@bot"', () => {
      const res1 = parseCommand('@ct-review-bot explain');
      expect(res1?.command).toBe('explain');

      const res2 = parseCommand('@bot refactor');
      expect(res2?.command).toBe('refactor');
    });

    it('returns null for unrecognized command strings', () => {
      expect(parseCommand('hello world')).toBeNull();
      expect(parseCommand('@ct-review invalidCommand')).toBeNull();
      expect(parseCommand('')).toBeNull();
    });
  });

  describe('CommandDispatcher.dispatchCommand()', () => {
    it('dispatches "@ct-review review" and triggers review pipeline callback', async () => {
      const res = await dispatcher.dispatchCommand('@ct-review review', context);
      expect(res.command).toBe('review');
      expect(res.success).toBe(true);
      expect(mockOnRunReviewPipeline).toHaveBeenCalledWith(context.payload);
    });

    it('dispatches "@ct-review explain" and posts explanation comment', async () => {
      const res = await dispatcher.dispatchCommand('@ct-review explain', context);
      expect(res.command).toBe('explain');
      expect(res.success).toBe(true);
      expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
        'calltelemetry',
        'ct-review-bot',
        42,
        expect.stringContaining('### Code Explanation')
      );
    });

    it('dispatches "@ct-review explain" in inline comment thread using replyToReviewComment', async () => {
      const inlineContext = { ...context, commentId: 102 };
      const res = await dispatcher.dispatchCommand('@ct-review explain', inlineContext);
      expect(res.command).toBe('explain');
      expect(res.success).toBe(true);
      expect(mockGithub.getReviewCommentThread).toHaveBeenCalledWith('calltelemetry', 'ct-review-bot', 42, 102);
      expect(mockGithub.replyToReviewComment).toHaveBeenCalledWith(
        'calltelemetry',
        'ct-review-bot',
        42,
        102,
        expect.stringContaining('### Code Explanation')
      );
    });

    it('dispatches "@ct-review refactor" and includes suggestion code block', async () => {
      const inlineContext = { ...context, commentId: 102 };
      const res = await dispatcher.dispatchCommand('@ct-review refactor', inlineContext);
      expect(res.command).toBe('refactor');
      expect(res.success).toBe(true);
      expect(mockGithub.replyToReviewComment).toHaveBeenCalledWith(
        'calltelemetry',
        'ct-review-bot',
        42,
        102,
        expect.stringContaining('```suggestion')
      );
    });

    it('dispatches "@ct-review summarize" and posts updated PR summary', async () => {
      const res = await dispatcher.dispatchCommand('@ct-review summarize', context);
      expect(res.command).toBe('summarize');
      expect(res.success).toBe(true);
      expect(mockGithub.getChangedFiles).toHaveBeenCalledWith('calltelemetry', 'ct-review-bot', 42);
      expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
        'calltelemetry',
        'ct-review-bot',
        42,
        expect.stringContaining('## Updated PR Summary')
      );
    });

    it('dispatches "@ct-review ask <question>" and answers user question', async () => {
      const inlineContext = { ...context, commentId: 102 };
      const res = await dispatcher.dispatchCommand(
        '@ct-review ask Does this change affect database migrations?',
        inlineContext
      );
      expect(res.command).toBe('ask');
      expect(res.success).toBe(true);
      expect(mockGithub.replyToReviewComment).toHaveBeenCalled();
    });

    it('returns usage message when "@ct-review ask" has no question provided', async () => {
      const res = await dispatcher.dispatchCommand('@ct-review ask', context);
      expect(res.command).toBe('ask');
      expect(res.success).toBe(false);
      expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
        'calltelemetry',
        'ct-review-bot',
        42,
        expect.stringContaining('Please provide a question after `@ct-review ask`')
      );
    });

    it('throws an error when command string cannot be parsed', async () => {
      await expect(dispatcher.dispatchCommand('invalid text', context)).rejects.toThrow(
        'Unrecognized command format'
      );
    });
  });
});
