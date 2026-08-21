import { describe, it, expect, beforeEach } from 'vitest';
import { GitHubEventHandler } from '../../src/github/eventHandler';

describe('eventHandlerChat.test.ts — Webhook Event Filtering & Chat Command Parsing', () => {
  let handler: GitHubEventHandler;

  beforeEach(() => {
    handler = new GitHubEventHandler({
      triggerLabels: ['ct-review'],
    });
  });

  describe('issue_comment & pull_request_review_comment event triggers', () => {
    it('triggers on issue_comment carrying "@ct-review review"', () => {
      const payload = {
        action: 'created',
        issue: { number: 42, pull_request: {} },
        comment: { id: 101, body: '@ct-review review' },
        repository: { name: 'ct-review-bot', owner: { login: 'calltelemetry' } },
        sender: { login: 'developer1' },
      };

      const result = handler.evaluateTrigger('issue_comment', payload, 'delivery-1');
      expect(result.shouldTrigger).toBe(true);
      expect(result.parsedPayload).toBeDefined();
      expect(result.parsedPayload?.prNumber).toBe(42);
      expect(result.parsedPayload?.commentId).toBe(101);
      expect(result.parsedPayload?.commandText).toBe('@ct-review review');
      expect(result.parsedPayload?.triggerSource).toBe('comment_command');
    });

    it('triggers on pull_request_review_comment carrying "@ct-review explain"', () => {
      const payload = {
        action: 'created',
        pull_request: { number: 108, head: { sha: 'sha-abc' }, base: { sha: 'sha-base' } },
        comment: { id: 202, body: '@ct-review explain this diff hunk', path: 'src/app.ts' },
        repository: { name: 'ct-review-bot', owner: { login: 'calltelemetry' } },
        sender: { login: 'developer2' },
      };

      const result = handler.evaluateTrigger('pull_request_review_comment', payload, 'delivery-2');
      expect(result.shouldTrigger).toBe(true);
      expect(result.parsedPayload?.prNumber).toBe(108);
      expect(result.parsedPayload?.commentId).toBe(202);
      expect(result.parsedPayload?.commandText).toBe('@ct-review explain this diff hunk');
    });

    it('triggers on inline thread reply (in_reply_to_id present)', () => {
      const payload = {
        action: 'created',
        pull_request: { number: 99 },
        comment: { id: 303, in_reply_to_id: 101, body: 'Can you elaborate on this suggestion?' },
        repository: { name: 'ct-review-bot', owner: { login: 'calltelemetry' } },
        sender: { login: 'developer3' },
      };

      const result = handler.evaluateTrigger('pull_request_review_comment', payload, 'delivery-3');
      expect(result.shouldTrigger).toBe(true);
      expect(result.parsedPayload?.prNumber).toBe(99);
      expect(result.parsedPayload?.commentId).toBe(303);
      expect(result.parsedPayload?.inReplyToId).toBe(101);
    });

    it('suppresses bot self-loop comments', () => {
      const payloadBot1 = {
        action: 'created',
        issue: { number: 10, pull_request: {} },
        comment: { id: 404, body: '@ct-review review' },
        sender: { login: 'ct-review-bot[bot]' },
      };
      const res1 = handler.evaluateTrigger('issue_comment', payloadBot1);
      expect(res1.shouldTrigger).toBe(false);
      expect(res1.reason).toContain('Ignored bot action');

      const payloadBot2 = {
        action: 'created',
        issue: { number: 10, pull_request: {} },
        comment: { id: 405, body: '@ct-review review' },
        sender: { login: 'ct-review-bot' },
      };
      const res2 = handler.evaluateTrigger('issue_comment', payloadBot2);
      expect(res2.shouldTrigger).toBe(false);
      expect(res2.reason).toContain('Ignored bot action');
    });

    it('ignores unrelated user comments without bot mentions or thread replies', () => {
      const payloadUnrelated = {
        action: 'created',
        issue: { number: 15, pull_request: {} },
        comment: { id: 505, body: 'LGTM! Great work team.' },
        sender: { login: 'developer4' },
      };

      const result = handler.evaluateTrigger('issue_comment', payloadUnrelated);
      expect(result.shouldTrigger).toBe(false);
      expect(result.reason).toContain('not bot review command or inline reply');
    });
  });
});
