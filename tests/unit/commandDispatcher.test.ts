import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandDispatcher, parseCommand, ChatContext } from '../../src/chat/commandDispatcher';
import { GitHubInstallationClient } from '../../src/github/installationClient';

describe('commandDispatcher.ts — PR Interactive Chat & Command Dispatcher', () => {
  let dispatcher: CommandDispatcher;
  let mockGithub: any;
  let mockModelClient: any;
  let mockOnRunReviewPipeline: any;
  let context: ChatContext;

  beforeEach(() => {
    dispatcher = new CommandDispatcher('openrouter/auto');

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

    mockModelClient = {
      complete: vi.fn().mockResolvedValue({
        model: 'openrouter/auto',
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
      modelClient: mockModelClient,
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

    it('does not execute the deprecated OmniRoute alias when modelClient is absent', async () => {
      const deprecatedClient = {
        complete: vi.fn().mockResolvedValue({ content: 'deprecated model output' }),
      };
      const legacyOnlyContext = {
        ...context,
        modelClient: undefined,
        omniRoute: deprecatedClient,
      };

      const res = await dispatcher.dispatchCommand('@ct-review ask Is this safe?', legacyOnlyContext);

      expect(res.success).toBe(true);
      expect(res.output).toContain('Answer to question "Is this safe?"');
      expect(res.output).not.toContain('deprecated model output');
      expect(deprecatedClient.complete).not.toHaveBeenCalled();
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

    it('dispatches "@review-yeti fix" and generates suggestion block in thread reply', async () => {
      const inlineContext = { ...context, owner: 'test-org', repo: 'test-repo', commentId: 102 };
      mockModelClient.complete.mockResolvedValueOnce({
        content: '```suggestion\nconst hash = await bcrypt.hash(pass, 10);\n```',
      });

      const res = await dispatcher.dispatchCommand('@review-yeti fix replace with bcrypt hash', inlineContext);
      expect(res.command).toBe('fix');
      expect(res.success).toBe(true);
      expect(res.output).toContain('```suggestion');
      expect(res.output).toContain('const hash = await bcrypt.hash(pass, 10);');
      expect(mockGithub.replyToReviewComment).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        42,
        102,
        expect.stringContaining('```suggestion')
      );
    });

    it('dispatches "@review-yeti ignore" and records suppressed nit in persistent team memory', async () => {
      const memoryStore = new (await import('../../src/memory/prMemoryStore')).PRMemoryStore(':memory:');
      const inlineContext = {
        ...context,
        owner: 'test-org',
        repo: 'test-repo',
        commentId: 101,
        filePath: 'src/utils/helpers.ts',
        memoryStore,
      };

      const res = await dispatcher.dispatchCommand('@review-yeti ignore false positive in utility', inlineContext);
      expect(res.command).toBe('ignore');
      expect(res.success).toBe(true);
      expect(res.output).toContain('### Finding Suppressed');
      expect(mockGithub.replyToReviewComment).toHaveBeenCalled();

      const learnings = await memoryStore.queryLearnings('test-org/test-repo');
      expect(learnings.resolvedNits.length).toBe(1);
      expect(learnings.resolvedNits[0].pattern).toBe('Original inline comment: Potential bug here');
      expect(learnings.resolvedNits[0].reason).toBe('false positive in utility');
    });

    it('dispatches "@review-yeti mute" and records muted rule in persistent team memory', async () => {
      const memoryStore = new (await import('../../src/memory/prMemoryStore')).PRMemoryStore(':memory:');
      const inlineContext = {
        ...context,
        owner: 'test-org',
        repo: 'test-repo',
        commentId: 101,
        memoryStore,
      };

      const res = await dispatcher.dispatchCommand('@review-yeti mute no-eval', inlineContext);
      expect(res.command).toBe('mute');
      expect(res.success).toBe(true);
      expect(res.output).toContain('### Finding Suppressed');

      const learnings = await memoryStore.queryLearnings('test-org/test-repo');
      expect(learnings.resolvedNits.length).toBe(1);
      expect(learnings.resolvedNits[0].pattern).toBe('no-eval');
      expect(learnings.resolvedNits[0].reason).toBe('Muted rule via chat command');
    });

    it('mints ephemeral installation token for chat actions without storing long-lived personal tokens', async () => {
      const mockToken = 'ghs_ephemeralChatToken12345';
      const fakeFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({ token: mockToken, expires_at: new Date(Date.now() + 600000).toISOString() }),
      });

      const { generateKeyPairSync } = await import('node:crypto');
      const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const { mintEphemeralChatToken, createEphemeralChatClient } = await import('../../src/github/appAuth');
      const tokenResult = await mintEphemeralChatToken('inst-456', {
        appId: 'app-999',
        privateKey,
      }, fakeFetch as any);

      expect(tokenResult.token).toBe(mockToken);
      expect(fakeFetch).toHaveBeenCalledWith(
        expect.stringContaining('/app/installations/inst-456/access_tokens'),
        expect.objectContaining({ method: 'POST' })
      );

      const chatClient = await createEphemeralChatClient('inst-456', {
        appId: 'app-999',
        privateKey,
      }, fakeFetch as any);
      expect(chatClient).toBeDefined();
    });
  });
});
