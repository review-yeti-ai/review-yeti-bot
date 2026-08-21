import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubInstallationClient } from '../../src/github/installationClient';
import { GitHubEventHandler } from '../../src/github/eventHandler';
import { CommandDispatcher, parseCommand } from '../../src/chat/commandDispatcher';

describe('Conversational Threading & Inline Reply Empirical Stress Tests', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  describe('GitHubInstallationClient.getReviewCommentThread()', () => {
    it('STRESS TEST 1: fails to reconstruct multi-level nested threads when in_reply_to_id points to parent reply', async () => {
      // Scenario: Comment 100 (root). Comment 101 (reply to 100). Comment 102 (reply to 101).
      const mockComments = [
        { id: 100, body: 'Root comment on line 10', diff_hunk: '@@ -10,5 +10,5 @@', user: { login: 'reviewer' } },
        { id: 101, in_reply_to_id: 100, body: 'First reply', user: { login: 'developer' } },
        { id: 102, in_reply_to_id: 101, body: 'Second reply to first reply', user: { login: 'reviewer' } },
      ];

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/pulls/42/comments')) {
          return new Response(JSON.stringify(mockComments), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });

      const client = new GitHubInstallationClient({ token: 'ghs_test123456' });
      const thread = await client.getReviewCommentThread('owner', 'repo', 42, 102);

      // EMPIRICAL OBSERVATION:
      // Expectation for a complete thread: should include Root (100), Reply 1 (101), Reply 2 (102).
      // Actual implementation result: rootId set to 101, so Comment 100 (containing diff_hunk) is lost!
      const commentIds = thread.map((c) => c.id);
      expect(commentIds).toBeDefined();
      // Record whether root comment 100 is missing
      const includesRoot = commentIds.includes(100);
      expect(includesRoot).toBe(false); // Demonstrates the multi-level nesting bug in getReviewCommentThread
    });

    it('STRESS TEST 2: loses thread context on PRs with >30 review comments due to missing pagination', async () => {
      // Scenario: 35 comments on PR. Target comment is #35, which replies to comment #1.
      // GitHub API returns first 30 comments on page 1 by default.
      const page1Comments = Array.from({ length: 30 }, (_, i) => ({
        id: i + 1,
        body: `Comment ${i + 1}`,
        user: { login: 'user' },
        ...(i > 0 ? { in_reply_to_id: 1 } : {}),
      }));

      const singleComment35 = {
        id: 35,
        in_reply_to_id: 1,
        body: 'Comment 35 reply to root',
        user: { login: 'developer' },
      };

      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/pulls/42/comments')) {
          // Returns page 1 (30 comments)
          return new Response(JSON.stringify(page1Comments), { status: 200 });
        }
        if (url.includes('/pulls/comments/35')) {
          return new Response(JSON.stringify(singleComment35), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });

      const client = new GitHubInstallationClient({ token: 'ghs_test123456' });
      const thread = await client.getReviewCommentThread('owner', 'repo', 42, 35);

      // EMPIRICAL OBSERVATION:
      // Target 35 is not in page 1 comments (1..30).
      // Fallback fetches single comment 35, returning [Comment 35] instead of the full thread [1..30, 35].
      expect(thread.length).toBe(1);
      expect(thread[0].id).toBe(35);
      // Thread context (comment 1 root) was lost!
    });

    it('STRESS TEST 3: returns empty array when API returns non-array error object instead of falling back', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (url.includes('/pulls/42/comments')) {
          // Suppose endpoint returns JSON error object with 200 or 404 text data
          return new Response(JSON.stringify({ message: 'Not Found' }), { status: 200 });
        }
        if (url.includes('/pulls/comments/101')) {
          return new Response(JSON.stringify({ id: 101, body: 'Single comment' }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 404 });
      });

      const client = new GitHubInstallationClient({ token: 'ghs_test123456' });
      const thread = await client.getReviewCommentThread('owner', 'repo', 42, 101);

      // Line 136 check `if (!Array.isArray(allComments)) return [];` immediately returns empty array
      // without attempting single comment fallback!
      expect(thread).toEqual([]);
    });
  });

  describe('GitHubEventHandler & CommandDispatcher Inline Reply Interaction', () => {
    it('STRESS TEST 4: evaluateTrigger triggers on any inline reply without @mention, causing parseCommand to fail', () => {
      const handler = new GitHubEventHandler();
      const payload = {
        action: 'created',
        repository: { owner: { login: 'calltelemetry' }, name: 'ct-bot' },
        pull_request: { number: 10, head: { sha: 'h' }, base: { sha: 'b' } },
        comment: {
          id: 501,
          in_reply_to_id: 100,
          body: 'I have updated the code according to review feedback.',
        },
        sender: { login: 'developer' },
      };

      const result = handler.evaluateTrigger('pull_request_review_comment', payload);

      // eventHandler evaluateTrigger returns shouldTrigger: true because in_reply_to_id exists!
      expect(result.shouldTrigger).toBe(true);
      expect(result.parsedPayload?.commandText).toBe('I have updated the code according to review feedback.');

      // BUT parseCommand fails to parse non-command text!
      const parsedCmd = parseCommand(result.parsedPayload!.commandText!);
      expect(parsedCmd).toBeNull();
    });

    it('STRESS TEST 5: CommandDispatcher throws unhandled error when replyToReviewComment fails (404/403/422)', async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/comments/501/replies')) {
          return new Response(JSON.stringify({ message: 'Comment not found', documentation_url: 'https://docs.github.com' }), {
            status: 404,
            statusText: 'Not Found',
          });
        }
        if (url.includes('/pulls/42/comments')) {
          return new Response(JSON.stringify([{ id: 501, body: 'Root comment', diff_hunk: 'diff' }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = new GitHubInstallationClient({ token: 'ghs_test123456' });
      const dispatcher = new CommandDispatcher();

      const context = {
        owner: 'owner',
        repo: 'repo',
        prNumber: 42,
        commentId: 501,
        github: client,
      };

      // Dispatching @ct-review explain when replyToReviewComment returns 404 error
      await expect(
        dispatcher.dispatchCommand('@ct-review explain please explain this line', context)
      ).rejects.toThrow('GitHub API 404 /repos/owner/repo/pulls/42/comments/501/replies: {"message":"Comment not found","documentation_url":"https://docs.github.com"}');
    });

    it('STRESS TEST 6: Inline reply formatting for @ct-review refactor correctly appends suggestion block when missing', async () => {
      let postedBody = '';
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.includes('/comments/501/replies')) {
          const body = JSON.parse(init?.body as string || '{}');
          postedBody = body.body;
          return new Response(JSON.stringify({ id: 999 }), { status: 201 });
        }
        if (url.includes('/pulls/42/comments')) {
          return new Response(JSON.stringify([{ id: 501, body: 'Root comment', diff_hunk: 'diff' }]), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      });

      const client = new GitHubInstallationClient({ token: 'ghs_test123456' });
      const dispatcher = new CommandDispatcher();

      const res = await dispatcher.dispatchCommand('@ct-review refactor rewrite this loop', {
        owner: 'owner',
        repo: 'repo',
        prNumber: 42,
        commentId: 501,
        github: client,
      });

      expect(res.success).toBe(true);
      expect(postedBody).toContain('### Refactoring Suggestion');
      expect(postedBody).toContain('```suggestion');
    });
  });
});
