import { timeBudgetMs } from '../support/timeBudget';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { CommandDispatcher, parseCommand, ChatContext } from '../../src/chat/commandDispatcher';
import { GitHubEventHandler } from '../../src/github/eventHandler';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { createWebhookServer, handleWebhookChatEvent } from '../../src/github/webhookServer';
import { getGitHubAppInstallationToken, mintEphemeralChatToken } from '../../src/github/appAuth';
import { computeGitHubSignature } from '../../src/github/signature';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';

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

  describe('3. @review-yeti Mention & Subcommand Boundary Conditions & Edge Cases', () => {
    it('parses @review-yeti commands with excessive leading, trailing, and inter-token whitespace', () => {
      const inputs = [
        { text: '   @review-yeti    explain    why is this slow?   ', cmd: 'explain', args: 'why is this slow?' },
        { text: '\t\t@review-yeti\t\tfix\t\tuse const instead of let\t\t', cmd: 'fix', args: 'use const instead of let' },
        { text: '   @review-yeti    ignore   no-eval - legacy code   ', cmd: 'ignore', args: 'no-eval - legacy code' },
        { text: '   @review-yeti    mute     rule/security-check     ', cmd: 'mute', args: 'rule/security-check' },
        { text: '   @review-yeti-bot    ask   How is latency measured?  ', cmd: 'ask', args: 'How is latency measured?' },
      ];

      for (const item of inputs) {
        const parsed = parseCommand(item.text);
        expect(parsed, `Failed to parse: "${item.text}"`).not.toBeNull();
        expect(parsed?.command).toBe(item.cmd);
        expect(parsed?.args).toBe(item.args);
      }
    });

    it('parses @review-yeti mentions separated by single or multiple newlines and CRLF', () => {
      const inputs = [
        { text: '@review-yeti\nexplain why is this slow?', cmd: 'explain', args: 'why is this slow?' },
        { text: '@review-yeti\r\nfix\r\nreplace with map()', cmd: 'fix', args: 'replace with map()' },
        { text: '@review-yeti\n\nignore\n\nno-console: debug statement', cmd: 'ignore', args: 'no-console: debug statement' },
        { text: '@review-yeti\r\n\r\nmute\r\n\r\nperf/no-sync', cmd: 'mute', args: 'perf/no-sync' },
      ];

      for (const item of inputs) {
        const parsed = parseCommand(item.text);
        expect(parsed, `Failed to parse CRLF/newlines: "${item.text}"`).not.toBeNull();
        expect(parsed?.command).toBe(item.cmd);
        expect(parsed?.args).toBe(item.args);
      }
    });

    it('parses case-insensitive @review-yeti mentions and commands (UPPERCASE, lowercase, MixedCase)', () => {
      expect(parseCommand('@REVIEW-YETI EXPLAIN this vulnerability')?.command).toBe('explain');
      expect(parseCommand('@Review-Yeti FIX replace md5')?.command).toBe('fix');
      expect(parseCommand('@review-yeti-bot IGNORE test-nit')?.command).toBe('ignore');
      expect(parseCommand('@REVIEW-YETI-BOT MUTE rule-1')?.command).toBe('mute');
      expect(parseCommand('@REVIEW-YETI[BOT] EXPLAIN architecture')?.command).toBe('explain');
    });

    it('handles missing arguments across all @review-yeti subcommands without throwing or crashing', async () => {
      // 1. @review-yeti explain (missing args)
      const resExplain = await dispatcher.dispatchCommand('@review-yeti explain', context);
      expect(resExplain.command).toBe('explain');
      expect(resExplain.success).toBe(true);
      expect(resExplain.output).toContain('### Code Explanation');
      expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
        'calltelemetry',
        'ct-review-bot',
        42,
        expect.stringContaining('### Code Explanation')
      );

      // 2. @review-yeti fix (missing args)
      const resFix = await dispatcher.dispatchCommand('@review-yeti fix', context);
      expect(resFix.command).toBe('fix');
      expect(resFix.success).toBe(true);
      expect(resFix.output).toContain('```suggestion');
      expect(resFix.output).toContain('### Code Fix Suggestion');

      // 3. @review-yeti ignore (missing args)
      const resIgnore = await dispatcher.dispatchCommand('@review-yeti ignore', context);
      expect(resIgnore.command).toBe('ignore');
      expect(resIgnore.success).toBe(true);
      expect(resIgnore.output).toContain('### Finding Suppressed');
      expect(resIgnore.output).toContain('Suppressed Nit');

      // 4. @review-yeti mute (missing args)
      const resMute = await dispatcher.dispatchCommand('@review-yeti mute', context);
      expect(resMute.command).toBe('mute');
      expect(resMute.success).toBe(true);
      expect(resMute.output).toContain('### Finding Suppressed');

      // 5. @review-yeti ask (missing args) -> returns success: false with informative message without throwing
      const resAsk = await dispatcher.dispatchCommand('@review-yeti ask', context);
      expect(resAsk.command).toBe('ask');
      expect(resAsk.success).toBe(false);
      expect(resAsk.output).toContain('Please provide a question');
    });
  });

  describe('4. Unknown & Malformed Commands Resilience (@review-yeti unknownCommand)', () => {
    it('parseCommand returns null for unknown commands and bare mentions', () => {
      expect(parseCommand('@review-yeti unknownCommand')).toBeNull();
      expect(parseCommand('@review-yeti fooBar')).toBeNull();
      expect(parseCommand('@review-yeti 12345')).toBeNull();
      expect(parseCommand('@review-yeti')).toBeNull();
      expect(parseCommand('@review-yeti-bot')).toBeNull();
    });

    it('dispatchCommand throws informative error for unknown command instead of silent corruption', async () => {
      await expect(
        dispatcher.dispatchCommand('@review-yeti unknownCommand', context)
      ).rejects.toThrow('Unrecognized command format: "@review-yeti unknownCommand"');
    });

    it('EMPIRICAL MISMATCH: handleWebhookChatEvent propagates unrecognized command error when dispatcher rejects', async () => {
      const payloadUnknown = {
        triggerSource: 'comment_command' as const,
        triggerAction: 'created',
        deliveryId: 'deliv-unknown',
        commandText: '@review-yeti unknownCommand',
        owner: 'calltelemetry',
        repo: 'ct-review-bot',
        prNumber: 42,
        sender: 'developer1',
        title: 'PR',
        body: 'body',
        headSha: 'h',
        baseSha: 'b',
        labels: [],
        installationId: 'inst-1',
      };

      // When passed to handleWebhookChatEvent with pre-authenticated github client,
      // it rejects with the commandDispatcher error rather than silently swallowing
      await expect(
        handleWebhookChatEvent(payloadUnknown, {
          commandDispatcher: dispatcher,
          github: mockGithub,
        })
      ).rejects.toThrow('Unrecognized command format: "@review-yeti unknownCommand"');
    });

    it('handleWebhookChatEvent returns null safely when payload is not a comment_command or missing commandText', async () => {
      const payloadNonCommand = {
        triggerSource: 'pr_event' as const,
        triggerAction: 'opened',
        commandText: '@review-yeti explain',
        installationId: 'inst-1',
        owner: 'org',
        repo: 'repo',
        prNumber: 1,
        deliveryId: 'd1',
        sender: 'dev',
        headSha: 'h',
        baseSha: 'b',
        title: 't',
        body: 'b',
        labels: [],
      };
      const result = await handleWebhookChatEvent(payloadNonCommand);
      expect(result).toBeNull();
    });
  });

  describe('5. Bot Self-Loop Suppression Stress Tests', () => {
    let eventHandler: GitHubEventHandler;

    beforeEach(() => {
      eventHandler = new GitHubEventHandler();
    });

    it('suppresses events from review-yeti-bot, review-yeti, ct-review-bot, and [bot] accounts', () => {
      const botSenders = [
        'review-yeti-bot',
        'review-yeti',
        'review-yeti[bot]',
        'review-yeti-bot[bot]',
        'ct-review-bot',
        'ct-review-bot[bot]',
        'github-actions[bot]',
      ];

      for (const senderLogin of botSenders) {
        const payload = {
          action: 'created',
          issue: { number: 42, pull_request: {} },
          comment: { id: 100, body: '@review-yeti explain' },
          repository: { name: 'ct-review-bot', owner: { login: 'calltelemetry' } },
          sender: { login: senderLogin },
        };

        const result = eventHandler.evaluateTrigger('issue_comment', payload);
        expect(result.shouldTrigger, `Sender ${senderLogin} should be suppressed`).toBe(false);
        expect(result.reason).toContain(`Ignored bot action from sender: ${senderLogin}`);
      }
    });

    it('EMPIRICAL EDGE CASE: detects case sensitivity vulnerability in bot self-loop suppression', () => {
      // In eventHandler.ts line 92:
      // sender === 'review-yeti-bot' || sender === 'review-yeti' || sender === 'ct-review-bot' || sender.endsWith('[bot]')
      // Notice: sender is NOT lowercased!
      const mixedCaseSender = 'Review-Yeti';
      const payload = {
        action: 'created',
        issue: { number: 42, pull_request: {} },
        comment: { id: 101, body: '@review-yeti explain' },
        repository: { name: 'ct-review-bot', owner: { login: 'calltelemetry' } },
        sender: { login: mixedCaseSender },
      };

      const result = eventHandler.evaluateTrigger('issue_comment', payload);
      // Demonstrates that 'Review-Yeti' is NOT suppressed because sender comparison is case-sensitive!
      expect(result.shouldTrigger).toBe(true);
    });
  });

  describe('6. Mocked GitHub API Error Propagation (401 / 403 / 422)', () => {
    let failingGithub: any;
    let failingContext: ChatContext;
    const { privateKey: testPrivateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    beforeEach(() => {
      failingGithub = {
        getReviewCommentThread: vi.fn().mockResolvedValue([{ id: 101, body: 'Nit' }]),
        getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/file.ts', patch: '@@ ... @@' }]),
        replyToReviewComment: vi.fn(),
        postIssueComment: vi.fn(),
      };

      failingContext = {
        owner: 'calltelemetry',
        repo: 'ct-review-bot',
        prNumber: 42,
        commentId: 101,
        github: failingGithub,
      };
    });

    it('propagates HTTP 401 Unauthorized error when GitHub API credentials/token are invalid', async () => {
      failingGithub.replyToReviewComment.mockRejectedValue(
        new Error('GitHub API 401 /repos/calltelemetry/ct-review-bot/pulls/42/comments/101/replies: {"message":"Bad credentials"}')
      );

      await expect(
        dispatcher.dispatchCommand('@review-yeti explain', failingContext)
      ).rejects.toThrow('GitHub API 401');
    });

    it('propagates HTTP 403 Forbidden error when GitHub App lacks review comment permissions or hits rate limits', async () => {
      failingGithub.replyToReviewComment.mockRejectedValue(
        new Error('GitHub API 403 /repos/calltelemetry/ct-review-bot/pulls/42/comments/101/replies: {"message":"Resource not accessible by integration"}')
      );

      await expect(
        dispatcher.dispatchCommand('@review-yeti fix', failingContext)
      ).rejects.toThrow('GitHub API 403');
    });

    it('propagates HTTP 422 Unprocessable Entity error when comment thread is locked or line is invalid', async () => {
      failingGithub.replyToReviewComment.mockRejectedValue(
        new Error('GitHub API 422 /repos/calltelemetry/ct-review-bot/pulls/42/comments/101/replies: {"message":"Validation Failed"}')
      );

      await expect(
        dispatcher.dispatchCommand('@review-yeti ignore', failingContext)
      ).rejects.toThrow('GitHub API 422');
    });

    it('propagates HTTP 401/403/422 on postIssueComment when commentId is omitted', async () => {
      const topLevelContext = { ...failingContext, commentId: undefined };
      failingGithub.postIssueComment.mockRejectedValue(
        new Error('GitHub API 403 /repos/calltelemetry/ct-review-bot/issues/42/comments: {"message":"Resource not accessible by integration"}')
      );

      await expect(
        dispatcher.dispatchCommand('@review-yeti explain', topLevelContext)
      ).rejects.toThrow('GitHub API 403');
    });

    it('mintEphemeralChatToken throws informative error when installation token exchange fails with 401/403/422', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401, statusText: 'Unauthorized' })
      );

      await expect(
        mintEphemeralChatToken('12345', {
          appId: 'test-app',
          privateKey: testPrivateKey,
        }, mockFetch as any)
      ).rejects.toThrow(/GitHub App installation token exchange failed HTTP 401/);
    });

    it('handleWebhookChatEvent gracefully returns null when ephemeral token minting fails', async () => {
      const payload = {
        triggerSource: 'comment_command' as const,
        triggerAction: 'created',
        deliveryId: 'deliv-fail-token',
        commandText: '@review-yeti explain',
        owner: 'calltelemetry',
        repo: 'ct-review-bot',
        prNumber: 42,
        sender: 'developer1',
        title: 'PR',
        body: 'body',
        headSha: 'h',
        baseSha: 'b',
        labels: [],
        installationId: 'inst-fail',
      };

      // App auth with an invalid appId/privateKey that throws
      const result = await handleWebhookChatEvent(payload, {
        commandDispatcher: dispatcher,
        appAuthConfig: {
          appId: '', // triggers error: GITHUB_APP_ID is required
          privateKey: '',
        },
      });

      // handleWebhookChatEvent catches token error and safely returns null without unhandled crash
      expect(result).toBeNull();
    });
  });
});

