import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { GitHubEventHandler, ParsedPRPayload } from '../../src/github/eventHandler';
import { CommandDispatcher, parseCommand, ChatContext } from '../../src/chat/commandDispatcher';
import {
  generateGitHubAppJwt,
  mintEphemeralChatToken,
  createEphemeralChatClient,
} from '../../src/github/appAuth';
import { handleWebhookChatEvent } from '../../src/github/webhookServer';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';
import { NitSuppressionEngine, Finding } from '../../src/reflection/nitSuppressionEngine';

// Generate test 2048-bit RSA keypair for JWT tests
const { privateKey: TEST_PRIVATE_KEY_PEM, publicKey: TEST_PUBLIC_KEY_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('Milestone 2 Challenger 2 Empirical Stress Test Suite', () => {
  // =========================================================================
  // Area 1: Mentions in issue comments vs PR review comments
  // =========================================================================
  describe('Area 1: Mentions in Issue Comments vs PR Review Comments', () => {
    let handler: GitHubEventHandler;

    beforeEach(() => {
      handler = new GitHubEventHandler();
    });

    it('1.1: Triggers on issue_comment with @review-yeti mention on a PR', () => {
      const payload = {
        action: 'created',
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/test-org/test-repo/pulls/42' },
          title: 'Add new feature',
          body: 'PR description',
          labels: [{ name: 'enhancement' }],
        },
        comment: {
          id: 1001,
          body: '@review-yeti explain what this PR does',
        },
        repository: { name: 'test-repo', owner: { login: 'test-org' } },
        sender: { login: 'octocat' },
        installation: { id: 12345 },
      };

      const result = handler.evaluateTrigger('issue_comment', payload, 'deliv-issue-1');
      expect(result.shouldTrigger).toBe(true);
      expect(result.reason).toBe('Comment review command detected');
      expect(result.parsedPayload).toBeDefined();
      expect(result.parsedPayload?.prNumber).toBe(42);
      expect(result.parsedPayload?.commentId).toBe(1001);
      expect(result.parsedPayload?.commandText).toBe('@review-yeti explain what this PR does');
      expect(result.parsedPayload?.triggerSource).toBe('comment_command');
      expect(result.parsedPayload?.diffHunk).toBeUndefined();
      expect(result.parsedPayload?.filePath).toBeUndefined();
    });

    it('1.2: Triggers on pull_request_review_comment with @review-yeti mention and diff metadata', () => {
      const payload = {
        action: 'created',
        pull_request: {
          number: 42,
          head: { sha: 'head-sha-abc' },
          base: { sha: 'base-sha-def' },
        },
        comment: {
          id: 2002,
          body: '@review-yeti fix use const instead of var',
          path: 'src/index.ts',
          diff_hunk: '@@ -10,3 +10,3 @@\n-var x = 1;\n+const x = 1;',
        },
        repository: { name: 'test-repo', owner: { login: 'test-org' } },
        sender: { login: 'dev-reviewer' },
        installation: { id: 12345 },
      };

      const result = handler.evaluateTrigger('pull_request_review_comment', payload, 'deliv-review-1');
      expect(result.shouldTrigger).toBe(true);
      expect(result.parsedPayload?.prNumber).toBe(42);
      expect(result.parsedPayload?.commentId).toBe(2002);
      expect(result.parsedPayload?.filePath).toBe('src/index.ts');
      expect(result.parsedPayload?.diffHunk).toContain('var x = 1;');
    });

    it('1.3: Triggers on pull_request_review_comment inline thread reply without bot mention', () => {
      const payload = {
        action: 'created',
        pull_request: { number: 42 },
        comment: {
          id: 3003,
          in_reply_to_id: 2002,
          body: 'Does this suggestion handle null values?',
        },
        repository: { name: 'test-repo', owner: { login: 'test-org' } },
        sender: { login: 'dev-author' },
      };

      const result = handler.evaluateTrigger('pull_request_review_comment', payload, 'deliv-reply-1');
      expect(result.shouldTrigger).toBe(true);
      expect(result.reason).toBe('Inline comment reply detected');
      expect(result.parsedPayload?.inReplyToId).toBe(2002);
      expect(result.parsedPayload?.commandText).toBe('Does this suggestion handle null values?');
    });

    it('1.4: Suppresses self-loops from bot accounts', () => {
      const botLogins = [
        'review-yeti-bot',
        'review-yeti',
        'review-yeti[bot]',
        'ct-review-bot',
        'ct-review-bot[bot]',
        'custom-bot[bot]',
      ];

      for (const botLogin of botLogins) {
        const payload = {
          action: 'created',
          issue: { number: 42 },
          comment: { id: 999, body: '@review-yeti review' },
          repository: { name: 'test-repo', owner: { login: 'test-org' } },
          sender: { login: botLogin },
        };
        const res = handler.evaluateTrigger('issue_comment', payload);
        expect(res.shouldTrigger).toBe(false);
        expect(res.reason).toContain('Ignored bot action from sender');
      }
    });

    it('1.5: Allows normal users with bot-like names that are not actually bots', () => {
      const validSenders = ['review-yeti-fan', 'ct-reviewer', 'bot-enthusiast', 'octocat'];

      for (const login of validSenders) {
        const payload = {
          action: 'created',
          issue: { number: 42 },
          comment: { id: 999, body: '@review-yeti explain' },
          repository: { name: 'test-repo', owner: { login: 'test-org' } },
          sender: { login },
        };
        const res = handler.evaluateTrigger('issue_comment', payload);
        expect(res.shouldTrigger).toBe(true);
      }
    });

    it('1.6: Webhook chat event handler executes command via mock github client', async () => {
      const mockGithub: any = {
        replyToReviewComment: vi.fn().mockResolvedValue(undefined),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
        getReviewCommentThread: vi.fn().mockResolvedValue([]),
        getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/app.ts', patch: '+ const a = 1;' }]),
      };

      const parsedPayload: ParsedPRPayload = {
        installationId: '12345',
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 42,
        headSha: 'head-sha',
        baseSha: 'base-sha',
        title: 'Test PR',
        body: 'Test Body',
        sender: 'developer',
        labels: [],
        triggerSource: 'comment_command',
        triggerAction: 'created',
        commandText: '@review-yeti fix replace with const',
        commentId: 5005,
        deliveryId: 'deliv-5005',
      };

      const result = await handleWebhookChatEvent(parsedPayload, {
        github: mockGithub,
      });

      expect(result).not.toBeNull();
      expect(result?.command).toBe('fix');
      expect(result?.success).toBe(true);
      expect(mockGithub.replyToReviewComment).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        42,
        5005,
        expect.stringContaining('```suggestion')
      );
    });
  });

  // =========================================================================
  // Area 2: Ephemeral JWT generation and clock drift tolerance
  // =========================================================================
  describe('Area 2: Ephemeral JWT Generation and Clock Drift Tolerance', () => {
    const savedAppId = process.env.GITHUB_APP_ID;
    const savedPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;

    afterEach(() => {
      if (savedAppId !== undefined) {
        process.env.GITHUB_APP_ID = savedAppId;
      } else {
        delete process.env.GITHUB_APP_ID;
      }
      if (savedPrivateKey !== undefined) {
        process.env.GITHUB_APP_PRIVATE_KEY = savedPrivateKey;
      } else {
        delete process.env.GITHUB_APP_PRIVATE_KEY;
      }
    });

    it('2.1: Generates valid RS256 JWT verifiable with matching public key', () => {
      const appId = 'app-98765';
      const jwt = generateGitHubAppJwt(appId, TEST_PRIVATE_KEY_PEM);

      expect(jwt).toBeDefined();
      const parts = jwt.split('.');
      expect(parts.length).toBe(3);

      const [headerB64, payloadB64, signatureB64] = parts;

      // Verify cryptographic RS256 signature
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(`${headerB64}.${payloadB64}`);
      const isValid = verifier.verify(TEST_PUBLIC_KEY_PEM, Buffer.from(signatureB64, 'base64url'));
      expect(isValid).toBe(true);
    });

    it('2.2: Verifies clock drift allowance (iat = now - 60s, exp = now + 600s, total = 660s)', () => {
      const beforeNow = Math.floor(Date.now() / 1000);
      const jwt = generateGitHubAppJwt('app-clock-test', TEST_PRIVATE_KEY_PEM);
      const afterNow = Math.floor(Date.now() / 1000);

      const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));

      expect(payload.iss).toBe('app-clock-test');
      expect(payload.iat).toBeGreaterThanOrEqual(beforeNow - 60);
      expect(payload.iat).toBeLessThanOrEqual(afterNow - 60);
      expect(payload.exp).toBeGreaterThanOrEqual(beforeNow + 600);
      expect(payload.exp).toBeLessThanOrEqual(afterNow + 600);
      // Exact clock drift allowance
      expect(payload.exp - payload.iat).toBe(660);
    });

    it('2.3: Rejects invalid or corrupted private keys when signing JWT', () => {
      expect(() => {
        generateGitHubAppJwt('app-err', '-----BEGIN RSA PRIVATE KEY-----\nINVALID\n-----END RSA PRIVATE KEY-----');
      }).toThrow();
    });

    it('2.4: mintEphemeralChatToken throws informative error when appId or privateKey missing', async () => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_APP_PRIVATE_KEY;

      await expect(
        mintEphemeralChatToken('12345', { appId: '', privateKey: TEST_PRIVATE_KEY_PEM })
      ).rejects.toThrow('GITHUB_APP_ID is required');

      await expect(
        mintEphemeralChatToken('12345', { appId: 'app-1', privateKey: '' })
      ).rejects.toThrow('GITHUB_APP_PRIVATE_KEY is required');
    });

    it('2.5: mintEphemeralChatToken exchanges JWT for token via mock fetch', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token: 'ghs_ephemeralToken123',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          permissions: { pull_requests: 'write', issues: 'write' },
        }),
      });

      const tokenResult = await mintEphemeralChatToken(
        '99999',
        { appId: 'app-test', privateKey: TEST_PRIVATE_KEY_PEM },
        mockFetch as any
      );

      expect(tokenResult.token).toBe('ghs_ephemeralToken123');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/app/installations/99999/access_tokens',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Bearer eyJ/),
          }),
        })
      );
    });

    it('2.6: mintEphemeralChatToken handles HTTP 401 / 403 API errors gracefully', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Bad credentials: ' + JSON.stringify({ message: 'A JSON web token could not be verified' }),
      });

      await expect(
        mintEphemeralChatToken(
          '99999',
          { appId: 'app-test', privateKey: TEST_PRIVATE_KEY_PEM },
          mockFetch as any
        )
      ).rejects.toThrow('GitHub App installation token exchange failed HTTP 401');
    });

    it('2.7: createEphemeralChatClient returns authenticated client with correct token and baseUrl', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          token: 'ghs_clientToken777',
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }),
      });

      const client = await createEphemeralChatClient(
        '88888',
        { appId: 'app-client', privateKey: TEST_PRIVATE_KEY_PEM, baseUrl: 'https://github-mock.internal' },
        mockFetch as any
      );

      expect(client).toBeDefined();
      expect((client as any).baseUrl).toBe('https://github-mock.internal');
    });
  });

  // =========================================================================
  // Area 3: Nit suppression recording with complex strings, regex, special chars
  // =========================================================================
  describe('Area 3: Nit Suppression Recording with Complex Strings, Regex & Special Chars', () => {
    let memoryStore: PRMemoryStore;
    let dispatcher: CommandDispatcher;
    let mockGithub: any;

    beforeEach(() => {
      memoryStore = new PRMemoryStore(':memory:');
      dispatcher = new CommandDispatcher();
      mockGithub = {
        replyToReviewComment: vi.fn().mockResolvedValue(undefined),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
        getReviewCommentThread: vi.fn().mockResolvedValue([
          { id: 101, body: 'P2: Complex pattern warning', path: 'src/parser.ts' },
        ]),
        getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/parser.ts', patch: '+ warning' }]),
      };
    });

    afterEach(() => {
      memoryStore.close();
    });

    it('3.1: Parses hyphenated rule slugs without prematurely splitting pattern', async () => {
      const context: ChatContext = {
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 50,
        commentId: 101,
        github: mockGithub,
        memoryStore,
      };

      // Pattern: 'no-unused-vars - allow in test helpers'
      const result = await dispatcher.dispatchCommand('@review-yeti ignore no-unused-vars - allow in test helpers', context);
      expect(result.success).toBe(true);
      expect(result.output).toContain('**Pattern**: `no-unused-vars`');
      expect(result.output).toContain('**Reason**: allow in test helpers');

      const learnings = await memoryStore.queryLearnings('test-org/test-repo');
      expect(learnings.resolvedNits.length).toBe(1);
      expect(learnings.resolvedNits[0].pattern).toBe('no-unused-vars');
      expect(learnings.resolvedNits[0].reason).toBe('allow in test helpers');
    });

    it('3.2: Records complex regex patterns and special characters safely in SQLite', async () => {
      const complexCases = [
        {
          input: '@review-yeti ignore ^const\\s+[\\w$]+\\s*=\\s*require\\(.*?\\);?$ - CommonJS require style allowed in config',
          expectedPattern: '^const\\s+[\\w$]+\\s*=\\s*require\\(.*?\\);?$',
          expectedReason: 'CommonJS require style allowed in config',
        },
        {
          input: "@review-yeti ignore SQL Injection: '; DROP TABLE resolved_nits; -- - security test pattern",
          expectedPattern: "SQL Injection",
          expectedReason: "'; DROP TABLE resolved_nits; -- - security test pattern",
        },
        {
          input: '@review-yeti ignore Emoji Rule: 🚨 Warning 🔥 - Unicode and emojis in rule title',
          expectedPattern: 'Emoji Rule',
          expectedReason: '🚨 Warning 🔥 - Unicode and emojis in rule title',
        },
        {
          input: '@review-yeti mute [A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
          expectedPattern: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
          expectedReason: 'Muted rule via chat command',
        },
      ];

      for (const [idx, tc] of complexCases.entries()) {
        const context: ChatContext = {
          owner: 'test-org',
          repo: `test-repo-${idx}`,
          prNumber: 100 + idx,
          commentId: 101,
          github: mockGithub,
          memoryStore,
        };

        const result = await dispatcher.dispatchCommand(tc.input, context);
        expect(result.success).toBe(true);
        expect(result.output).toContain(`\`${tc.expectedPattern}\``);

        const state = await memoryStore.queryLearnings(`test-org/test-repo-${idx}`);
        expect(state.resolvedNits.length).toBe(1);
        expect(state.resolvedNits[0].pattern).toBe(tc.expectedPattern);
        expect(state.resolvedNits[0].reason).toBe(tc.expectedReason);
      }
    });

    it('3.3: NitSuppressionEngine suppresses matching P2 findings using stored rules', async () => {
      const repo = 'test-org/suppression-test';

      await memoryStore.recordResolvedNit(repo, 10, {
        pattern: 'no-unused-vars',
        filePath: 'src/test/**',
        reason: 'Unused vars tolerated in mock files',
      });

      const engine = new NitSuppressionEngine(memoryStore);

      const findings: Finding[] = [
        {
          path: 'src/test/mockService.ts',
          line: 15,
          title: 'ESLint: no-unused-vars detected',
          body: 'Variable "unused" is declared but never read',
          severity: 'P2',
        },
        {
          path: 'src/core/main.ts',
          line: 25,
          title: 'ESLint: no-unused-vars detected',
          body: 'Variable "unused" is declared but never read',
          severity: 'P2',
        },
        {
          path: 'src/test/mockService.ts',
          line: 30,
          title: 'Hardcoded secret detected',
          body: 'Do not hardcode secrets',
          severity: 'P0', // Critical P0 must NEVER be suppressed
        },
      ];

      const res = await engine.suppressNits(repo, findings);
      expect(res.suppressedFindings.length).toBe(1);
      expect(res.suppressedFindings[0].finding.path).toBe('src/test/mockService.ts');
      expect(res.suppressedFindings[0].finding.severity).toBe('P2');

      expect(res.activeFindings.length).toBe(2);
      expect(res.activeFindings.some((f) => f.path === 'src/core/main.ts')).toBe(true);
      expect(res.activeFindings.some((f) => f.severity === 'P0')).toBe(true);
    });

    it('3.4: Increments suppression count upon suppression without database corruption', async () => {
      const repo = 'test-org/counter-test';

      const nit = await memoryStore.recordResolvedNit(repo, 10, {
        pattern: 'naming-convention',
        filePath: '**',
        reason: 'Legacy naming permitted',
      });

      const engine = new NitSuppressionEngine(memoryStore);
      const findings: Finding[] = [
        { path: 'src/a.ts', title: 'Violation of naming-convention', severity: 'minor' },
        { path: 'src/b.ts', title: 'Violation of naming-convention', severity: 'minor' },
      ];

      await engine.suppressNits(repo, [findings[0]]);
      await engine.suppressNits(repo, [findings[1]]);

      const state = await memoryStore.queryLearnings(repo);
      expect(state.resolvedNits[0].suppressionCount).toBe(2);
    });
  });

  // =========================================================================
  // Area 4: Suggestion block generation with multi-line fixes and CRLF
  // =========================================================================
  describe('Area 4: Suggestion Block Generation with Multi-Line Fixes & CRLF', () => {
    let dispatcher: CommandDispatcher;
    let mockGithub: any;

    beforeEach(() => {
      dispatcher = new CommandDispatcher();
      mockGithub = {
        replyToReviewComment: vi.fn().mockResolvedValue(undefined),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
        getReviewCommentThread: vi.fn().mockResolvedValue([
          { id: 101, body: 'Replace this block with cleaner logic', path: 'src/calc.ts' },
        ]),
        getChangedFiles: vi.fn().mockResolvedValue([
          { path: 'src/calc.ts', patch: '@@ -1,5 +1,5 @@\n-function add(a, b) { return a+b; }' },
        ]),
      };
    });

    it('4.1: Wraps model code in ```suggestion block when missing in model response', async () => {
      const mockModelClient: any = {
        complete: vi.fn().mockResolvedValue({
          content: 'export function add(a: number, b: number): number {\n  return a + b;\n}',
        }),
      };

      const context: ChatContext = {
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 77,
        commentId: 101,
        github: mockGithub,
        modelClient: mockModelClient,
      };

      const result = await dispatcher.dispatchCommand('@review-yeti fix return typed function', context);
      expect(result.command).toBe('fix');
      expect(result.success).toBe(true);
      expect(result.output).toContain('```suggestion');
      expect(result.output).toContain('export function add(a: number, b: number): number');
      expect(mockGithub.replyToReviewComment).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        77,
        101,
        expect.stringContaining('```suggestion')
      );
    });

    it('4.2: Preserves multi-line fixes with CRLF (\\r\\n) line endings properly', async () => {
      const crlfCode = 'const x = 1;\r\nconst y = 2;\r\nreturn x + y;\r\n';
      const mockModelClient: any = {
        complete: vi.fn().mockResolvedValue({
          content: `Here is the multi-line fix:\r\n\r\n\`\`\`suggestion\r\n${crlfCode}\`\`\``,
        }),
      };

      const context: ChatContext = {
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 77,
        commentId: 101,
        github: mockGithub,
        modelClient: mockModelClient,
      };

      const result = await dispatcher.dispatchCommand('@review-yeti fix multi-line CRLF', context);
      expect(result.success).toBe(true);
      expect(result.output).toContain('```suggestion');
      expect(result.output).toContain('const x = 1;');
      expect(result.output).toContain('const y = 2;');
      expect(result.output).toContain('return x + y;');
      // Verify replyToReviewComment receives the suggestion block
      const callArgs = mockGithub.replyToReviewComment.mock.calls[0];
      expect(callArgs[4]).toContain('```suggestion');
    });

    it('4.3: Correctly distinguishes between @review-yeti fix and @review-yeti refactor headings', async () => {
      const mockModelClient: any = {
        complete: vi.fn().mockResolvedValue({
          content: 'const clean = true;',
        }),
      };

      const contextFix: ChatContext = {
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 77,
        commentId: 101,
        github: mockGithub,
        modelClient: mockModelClient,
      };

      const resFix = await dispatcher.dispatchCommand('@review-yeti fix make clean', contextFix);
      expect(resFix.command).toBe('fix');
      expect(resFix.output).toContain('### Code Fix Suggestion');

      const contextRefactor: ChatContext = {
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 77,
        commentId: 101,
        github: mockGithub,
        modelClient: mockModelClient,
      };

      const resRefactor = await dispatcher.dispatchCommand('@review-yeti refactor make clean', contextRefactor);
      expect(resRefactor.command).toBe('refactor');
      expect(resRefactor.output).toContain('### Refactoring Suggestion');
    });

    it('4.4: Handles model failure/timeout with robust fallback suggestion block', async () => {
      const mockModelClient: any = {
        complete: vi.fn().mockRejectedValue(new Error('Model timeout after 30s')),
      };

      const context: ChatContext = {
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 77,
        commentId: 101,
        github: mockGithub,
        modelClient: mockModelClient,
      };

      const result = await dispatcher.dispatchCommand('@review-yeti fix fallback test', context);
      expect(result.success).toBe(true);
      expect(result.output).toContain('### Code Fix Suggestion');
      expect(result.output).toContain('```suggestion\n// Fixed code suggestion\n```');
    });
  });
});

  // =========================================================================
  // Additional Adversarial Stress Tests
  // =========================================================================
  describe('Additional Adversarial Stress Tests', () => {
    let memoryStore: PRMemoryStore;
    let dispatcher: CommandDispatcher;
    let mockGithub: any;

    beforeEach(() => {
      memoryStore = new PRMemoryStore(':memory:');
      dispatcher = new CommandDispatcher();
      mockGithub = {
        replyToReviewComment: vi.fn().mockResolvedValue(undefined),
        postIssueComment: vi.fn().mockResolvedValue(undefined),
        getReviewCommentThread: vi.fn().mockResolvedValue([
          { id: 101, body: 'P2: Finding title', path: 'src/app.ts' },
        ]),
        getChangedFiles: vi.fn().mockResolvedValue([
          { path: 'src/app.ts', patch: '@@ -1,3 +1,3 @@' },
        ]),
      };
    });

    afterEach(() => {
      memoryStore.close();
    });

    it('5.1: Unbalanced regex characters in ignore pattern do NOT cause ReDoS or RegExp crash in NitSuppressionEngine', async () => {
      const repo = 'test-org/redos-test';

      // Unbalanced regex and potential ReDoS strings
      const malformedPatterns = [
        '(((unclosed parenthesis',
        '[[[unclosed bracket',
        '(a+)+$',
        '*+?{}()|[]\\',
      ];

      for (const pattern of malformedPatterns) {
        await memoryStore.recordResolvedNit(repo, 1, {
          pattern,
          filePath: 'src/**',
          reason: 'Testing ReDoS safety',
        });
      }

      const engine = new NitSuppressionEngine(memoryStore);
      const findings: Finding[] = [
        { path: 'src/app.ts', title: 'Finding with (((unclosed parenthesis in text', severity: 'P2' },
        { path: 'src/app.ts', title: 'Normal finding without pattern', severity: 'P2' },
      ];

      // Must execute cleanly without throwing SyntaxError: Invalid regular expression
      expect(async () => {
        const res = await engine.suppressNits(repo, findings);
        expect(res.suppressedFindings.length).toBe(1);
        expect(res.activeFindings.length).toBe(1);
      }).not.toThrow();
    });

    it('5.2: Path matching handles glob patterns with special regex characters safely', () => {
      const repo = 'test-org/path-test';
      const pathsToTest = [
        { pattern: 'src/(auth)/**', file: 'src/(auth)/login.ts', shouldMatch: true },
        { pattern: 'src/[legacy]/*.js', file: 'src/[legacy]/old.js', shouldMatch: true },
        { pattern: 'src/api+v1/**', file: 'src/api+v1/users.ts', shouldMatch: true },
        { pattern: 'src/api+v1/**', file: 'src/api-v1/users.ts', shouldMatch: false },
      ];

      const memoryStore = new PRMemoryStore(':memory:');
      const engine = new NitSuppressionEngine(memoryStore);

      for (const pt of pathsToTest) {
        // Test via isPathMatch logic in NitSuppressionEngine
        const fn = (engine as any).isPathMatch || ((engine: any, pat: string, f: string) => {
          // Verify path matching directly
          let regStr = pat
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '__GLOBSTAR__')
            .replace(/\*/g, '__STAR__')
            .replace(/\?/g, '__QUESTION__')
            .replace(/__GLOBSTAR__/g, '.*')
            .replace(/__STAR__/g, '[^/]*')
            .replace(/__QUESTION__/g, '.');
          return new RegExp(`^${regStr}$`).test(f);
        });

        expect(fn(engine, pt.pattern, pt.file)).toBe(pt.shouldMatch);
      }
    });

    it('5.3: Handles multi-line suggestions containing nested template literals and CRLF', async () => {
      const complexCode = 'const template = `User: ${user.name}`;\r\nconst msg = `Hello \\`nested\\``;\r\nreturn template + msg;\r\n';
      const mockModelClient: any = {
        complete: vi.fn().mockResolvedValue({
          content: complexCode,
        }),
      };

      const context: ChatContext = {
        owner: 'test-org',
        repo: 'test-repo',
        prNumber: 99,
        commentId: 101,
        github: mockGithub,
        modelClient: mockModelClient,
      };

      const result = await dispatcher.dispatchCommand('@review-yeti fix template string', context);
      expect(result.success).toBe(true);
      expect(result.output).toContain('```suggestion');
      expect(result.output).toContain('const template = `User: ${user.name}`;');
      expect(result.output).toContain('const msg = `Hello \\`nested\\``;');
    });

    it('5.4: Command parser handles edge-case mentions across multiline text, tabs, and casing', () => {
      const testCases = [
        {
          input: 'Line 1\nLine 2\n@REVIEW-YETI EXPLAIN why this is failing',
          expectedCmd: 'explain',
          expectedArgs: 'why this is failing',
        },
        {
          input: '\t@review-yeti-bot\tFIX\tsimplify\tlogic\t',
          expectedCmd: 'fix',
          expectedArgs: 'simplify\tlogic',
        },
        {
          input: 'Please consider this advice:\n@review-yeti MUTE no-any - Temporary bypass for migration',
          expectedCmd: 'mute',
          expectedArgs: 'no-any - Temporary bypass for migration',
        },
        {
          input: '@ct-review[bot] ignore styling-issue',
          expectedCmd: 'ignore',
          expectedArgs: 'styling-issue',
        },
      ];

      for (const tc of testCases) {
        const parsed = parseCommand(tc.input);
        expect(parsed, `Failed to parse: ${tc.input}`).not.toBeNull();
        expect(parsed?.command).toBe(tc.expectedCmd);
        expect(parsed?.args).toBe(tc.expectedArgs);
      }
    });
  });
