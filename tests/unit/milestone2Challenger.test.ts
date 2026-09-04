import { timeBudgetMs } from '../support/timeBudget';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandDispatcher, parseCommand, ChatContext } from '../../src/chat/commandDispatcher';
import { GitHubEventHandler } from '../../src/github/eventHandler';
import { GitHubInstallationClient } from '../../src/github/installationClient';

describe('Milestone 2 Empirical Stress Tests — R2 Interactive PR Chat & Command Dispatcher', () => {
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

  describe('1. Command Dispatcher Malformed & Unexpected Inputs (All 5 Commands)', () => {
    describe('Command "@ct-review ask"', () => {
      it('handles empty questions, whitespace-only, and newlines without throwing', async () => {
        const inputs = [
          '@ct-review ask',
          '@ct-review ask   ',
          '@ct-review ask \t \n ',
          '@CT-REVIEW ask',
        ];

        for (const input of inputs) {
          const res = await dispatcher.dispatchCommand(input, context);
          expect(res.command).toBe('ask');
          expect(res.success).toBe(false);
          expect(res.output).toContain('Please provide a question after `@ct-review ask`');
          expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
            'calltelemetry',
            'ct-review-bot',
            42,
            expect.stringContaining('Please provide a question')
          );
        }
      });

      it('handles massive 100,000 character questions gracefully', async () => {
        const massiveQuestion = 'A'.repeat(100_000);
        const commandStr = `@ct-review ask ${massiveQuestion}`;
        
        const res = await dispatcher.dispatchCommand(commandStr, context);
        expect(res.command).toBe('ask');
        expect(res.success).toBe(true);
        expect(mockModelClient.complete).toHaveBeenCalled();
        const callArgs = mockModelClient.complete.mock.calls[0][0];
        expect(callArgs.messages[1].content).toContain(massiveQuestion);
      });

      it('handles OpenRouter client failure during ask gracefully with fallback answer', async () => {
        mockModelClient.complete.mockRejectedValue(new Error('Gateway HTTP 503 Timeout'));
        
        const res = await dispatcher.dispatchCommand('@ct-review ask Is this safe?', context);
        expect(res.command).toBe('ask');
        expect(res.success).toBe(true);
        expect(res.output).toContain('Answer to question "Is this safe?"');
        expect(res.output).toContain('Based on PR #42 changes in calltelemetry/ct-review-bot.');
      });
    });

    describe('Command "@ct-review review"', () => {
      it('handles missing onRunReviewPipeline callback without crashing', async () => {
        const contextNoCallback = { ...context, onRunReviewPipeline: undefined };
        const res = await dispatcher.dispatchCommand('@ct-review review', contextNoCallback);
        expect(res.command).toBe('review');
        expect(res.success).toBe(true);
        expect(res.message).toBe('Review command parsed.');
      });

      it('handles missing payload object without crashing', async () => {
        const contextNoPayload = { ...context, payload: undefined };
        const res = await dispatcher.dispatchCommand('@ct-review review', contextNoPayload);
        expect(res.command).toBe('review');
        expect(res.success).toBe(true);
        expect(res.message).toBe('Review command parsed.');
      });

      it('propagates error when onRunReviewPipeline callback rejects', async () => {
        mockOnRunReviewPipeline.mockRejectedValue(new Error('Pipeline execution failed'));
        await expect(dispatcher.dispatchCommand('@ct-review review', context)).rejects.toThrow('Pipeline execution failed');
      });
    });

    describe('Command "@ct-review refactor"', () => {
      it('handles binary diffs (files with patch: undefined or empty patches) safely', async () => {
        mockGithub.getChangedFiles.mockResolvedValue([
          { path: 'assets/logo.png', patch: undefined },
          { path: 'bin/app.wasm' },
        ]);

        const res = await dispatcher.dispatchCommand('@ct-review refactor', context);
        expect(res.command).toBe('refactor');
        expect(res.success).toBe(true);
        expect(res.output).toContain('```suggestion');
        expect(mockModelClient.complete).toHaveBeenCalled();
      });

      it('appends ```suggestion block automatically if LLM response lacks it', async () => {
        mockModelClient.complete.mockResolvedValue({
          content: '### Refactoring Suggestion\nConsider using const instead of let.',
        });

        const res = await dispatcher.dispatchCommand('@ct-review refactor', context);
        expect(res.command).toBe('refactor');
        expect(res.output).toContain('```suggestion');
        expect(res.output).toContain('// Refactored code suggestion');
      });

      it('does not duplicate ```suggestion block if LLM response already contains it', async () => {
        mockModelClient.complete.mockResolvedValue({
          content: '### Refactoring Suggestion\n```suggestion\nconst x = 42;\n```',
        });

        const res = await dispatcher.dispatchCommand('@ct-review refactor', context);
        expect(res.command).toBe('refactor');
        const suggestionCount = (res.output?.match(/```suggestion/g) || []).length;
        expect(suggestionCount).toBe(1);
      });

      it('handles OpenRouter failure gracefully with default refactoring fallback', async () => {
        mockModelClient.complete.mockRejectedValue(new Error('OpenRouter Connection Refused'));
        const res = await dispatcher.dispatchCommand('@ct-review refactor', context);
        expect(res.command).toBe('refactor');
        expect(res.success).toBe(true);
        expect(res.output).toContain('### Refactoring Suggestion');
        expect(res.output).toContain('```suggestion');
      });
    });

    describe('Command "@ct-review explain"', () => {
      it('handles 5,000-line diffs without performance lag or memory crash', async () => {
        const largePatchLines = Array.from({ length: 5000 }, (_, i) => `+ const line${i} = ${i};`);
        const largePatch = `@@ -1,1 +1,5000 @@\n` + largePatchLines.join('\n');
        
        mockGithub.getChangedFiles.mockResolvedValue([
          { path: 'src/massive.ts', patch: largePatch },
        ]);

        const start = Date.now();
        const res = await dispatcher.dispatchCommand('@ct-review explain', context);
        const duration = Date.now() - start;

        expect(res.command).toBe('explain');
        expect(res.success).toBe(true);
        expect(duration).toBeLessThan(timeBudgetMs(500)); // Should execute within 500ms
        
        // Verify diff context was sliced to 4,000 chars for LLM prompt safety
        const promptSent = mockModelClient.complete.mock.calls[0][0].messages[1].content;
        expect(promptSent.length).toBeLessThan(10_000);
      });

      it('handles empty changed files array gracefully', async () => {
        mockGithub.getChangedFiles.mockResolvedValue([]);
        const res = await dispatcher.dispatchCommand('@ct-review explain', context);
        expect(res.command).toBe('explain');
        expect(res.success).toBe(true);
        expect(mockGithub.postIssueComment).toHaveBeenCalled();
      });

      it('handles getChangedFiles failure gracefully by returning fallback explanation', async () => {
        mockGithub.getChangedFiles.mockRejectedValue(new Error('GitHub Rate Limit Exceeded'));
        const res = await dispatcher.dispatchCommand('@ct-review explain', context);
        expect(res.command).toBe('explain');
        expect(res.success).toBe(true);
        expect(mockGithub.postIssueComment).toHaveBeenCalled();
      });

      it('handles OpenRouter failure gracefully with fallback overview', async () => {
        mockModelClient.complete.mockRejectedValue(new Error('API key expired'));
        const res = await dispatcher.dispatchCommand('@ct-review explain', context);
        expect(res.command).toBe('explain');
        expect(res.success).toBe(true);
        expect(res.output).toContain('### Code Explanation');
      });
    });

    describe('Command "@ct-review summarize"', () => {
      it('handles binary/patchless changed files in summary engine', async () => {
        mockGithub.getChangedFiles.mockResolvedValue([
          { path: 'docs/diagram.png' },
          { path: 'package-lock.json', patch: '' },
          { path: 'src/main.ts', patch: '@@ -1 +1 @@\n-console.log("old");\n+console.log("new");' },
        ]);

        const res = await dispatcher.dispatchCommand('@ct-review summarize', context);
        expect(res.command).toBe('summarize');
        expect(res.success).toBe(true);
        expect(res.output).toContain('## Updated PR Summary');
      });

      it('processes 5,000-line diffs through summary and mermaid engines without failing', async () => {
        const lines = Array.from({ length: 5000 }, (_, i) => `+ function fn${i}() { return ${i}; }`);
        const patch = `@@ -0,0 +1,5000 @@\n` + lines.join('\n');

        mockGithub.getChangedFiles.mockResolvedValue([
          { path: 'src/largeModule.ts', patch },
        ]);

        const start = Date.now();
        const res = await dispatcher.dispatchCommand('@ct-review summarize', context);
        const duration = Date.now() - start;

        expect(res.command).toBe('summarize');
        expect(res.success).toBe(true);
        expect(duration).toBeLessThan(timeBudgetMs(1000));
        expect(res.output).toContain('## Updated PR Summary');
      });
    });
  });

  describe('2. Mention Regex & Syntax Edge Cases', () => {
    it('parses case-insensitive mentions and commands correctly', () => {
      const r1 = parseCommand('@CT-REVIEW ASK How are errors handled?');
      expect(r1?.command).toBe('ask');
      expect(r1?.args).toBe('How are errors handled?');

      const r2 = parseCommand('@Ct-Review-Bot   REFACTOR');
      expect(r2?.command).toBe('refactor');

      const r3 = parseCommand('@BOT SUMMARIZE');
      expect(r3?.command).toBe('summarize');
    });

    it('parses multi-line mentions and multi-line arguments correctly', () => {
      // Mention separated from command by newline (\n)
      const r1 = parseCommand('@ct-review\nexplain');
      expect(r1?.command).toBe('explain');

      // Command arguments spanning multiple lines
      const r2 = parseCommand('@ct-review ask\nLine 1 of question?\nLine 2 of question?');
      expect(r2?.command).toBe('ask');
      expect(r2?.args).toBe('Line 1 of question?\nLine 2 of question?');
    });

    it('parses commands with extra whitespace or tabs between mention and command', () => {
      const r1 = parseCommand('@ct-review\t\texplain');
      expect(r1?.command).toBe('explain');

      const r2 = parseCommand('   @ct-review    refactor   ');
      expect(r2?.command).toBe('refactor');
    });

    it('EMPIRICAL MISMATCH: detects disconnects between eventHandler regex and parseCommand regex', () => {
      const eventHandler = new GitHubEventHandler();

      // Case A: @ct-review-bot-extra ask
      // eventHandler uses /@(ct-review|bot|ct-review-bot)\b/i
      // \b matches after ct-review-bot because '-' is a non-word character!
      const payloadA = {
        action: 'created',
        comment: { id: 1, body: '@ct-review-bot-extra ask how this works' },
        repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
        sender: { login: 'user1' },
      };
      const triggerA = eventHandler.evaluateTrigger('issue_comment', payloadA);
      expect(triggerA.shouldTrigger).toBe(true); // eventHandler triggers!

      // BUT parseCommand requires \s+ after bot name: /@(ct-review|ct-review-bot|bot)\s+.../
      // '@ct-review-bot-extra' has '-extra' which is NOT whitespace!
      const parsedA = parseCommand(payloadA.comment.body);
      expect(parsedA).toBeNull(); // parseCommand returns NULL!

      // Case B: user@ct-review.com explain
      const payloadB = {
        action: 'created',
        comment: { id: 2, body: 'user@ct-review.com explain' },
        repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
        sender: { login: 'user2' },
      };
      const triggerB = eventHandler.evaluateTrigger('issue_comment', payloadB);
      expect(triggerB.shouldTrigger).toBe(true); // eventHandler triggers due to @ct-review.com!

      const parsedB = parseCommand(payloadB.comment.body);
      expect(parsedB).toBeNull(); // parseCommand returns NULL!

      // Case C: @ct-review invalidCommand
      const payloadC = {
        action: 'created',
        comment: { id: 3, body: '@ct-review invalidCommand' },
        repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
        sender: { login: 'user3' },
      };
      const triggerC = eventHandler.evaluateTrigger('issue_comment', payloadC);
      expect(triggerC.shouldTrigger).toBe(true); // eventHandler triggers!

      const parsedC = parseCommand(payloadC.comment.body);
      expect(parsedC).toBeNull(); // parseCommand returns NULL!
    });
  });
});
