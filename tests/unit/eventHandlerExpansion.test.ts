import { describe, it, expect } from 'vitest';
import { GitHubEventHandler } from '../../src/github/eventHandler';

describe('eventHandler.ts — Comprehensive Unit Expansion Tests', () => {
  const repository = { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' };

  it('initializes with default trigger labels when options omitted', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'labeled',
      pull_request: { number: 1, labels: [{ name: 'ct-review' }] },
      repository,
      sender: { login: 'user' },
    };

    const res = handler.evaluateTrigger('pull_request', payload);
    expect(res.shouldTrigger).toBe(true);
  });

  it('initializes with custom trigger labels when provided in options', () => {
    const handler = new GitHubEventHandler({ triggerLabels: ['custom-trigger'] });

    const payloadMatch = {
      action: 'labeled',
      pull_request: { number: 1, labels: ['custom-trigger'] },
      repository,
      sender: { login: 'user' },
    };
    expect(handler.evaluateTrigger('pull_request', payloadMatch).shouldTrigger).toBe(true);

    const payloadNoMatch = {
      action: 'labeled',
      pull_request: { number: 1, labels: ['ct-review'] },
      repository,
      sender: { login: 'user' },
    };
    expect(handler.evaluateTrigger('pull_request', payloadNoMatch).shouldTrigger).toBe(false);
  });

  it('filters out bot senders (e.g. ending in [bot] or ct-review-bot)', () => {
    const handler = new GitHubEventHandler();

    const p1 = { action: 'opened', pull_request: {}, sender: { login: 'dependabot[bot]' } };
    expect(handler.evaluateTrigger('pull_request', p1).shouldTrigger).toBe(false);

    const p2 = { action: 'opened', pull_request: {}, sender: { login: 'ct-review-bot' } };
    expect(handler.evaluateTrigger('pull_request', p2).shouldTrigger).toBe(false);
  });

  it('returns shouldTrigger false for closed PRs', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'synchronize',
      pull_request: { state: 'closed' },
      sender: { login: 'user' },
    };
    expect(handler.evaluateTrigger('pull_request', payload).shouldTrigger).toBe(false);
  });

  it('evaluates pull_request.opened as shouldTrigger true', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'opened',
      number: 10,
      installation: { id: 123 },
      repository: { owner: { login: 'org' }, name: 'repo' },
      pull_request: { number: 10, head: { sha: 'h' }, base: { sha: 'b' } },
      sender: { login: 'dev' },
    };
    const res = handler.evaluateTrigger('pull_request', payload, 'delivery-1');

    expect(res.shouldTrigger).toBe(true);
    expect(res.parsedPayload?.prNumber).toBe(10);
    expect(res.parsedPayload?.headSha).toBe('h');
    expect(res.parsedPayload?.deliveryId).toBe('delivery-1');
  });

  it('evaluates pull_request.synchronize as shouldTrigger true', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'synchronize',
      number: 11,
      pull_request: { number: 11, head: { sha: 'h2' }, base: { sha: 'b' } },
      repository,
      sender: { login: 'dev' },
    };
    const res = handler.evaluateTrigger('pull_request', payload);

    expect(res.shouldTrigger).toBe(true);
    expect(res.parsedPayload?.triggerAction).toBe('synchronize');
  });

  it('evaluates draft PRs with triggerSource draft_precheck', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'opened',
      number: 12,
      pull_request: { number: 12, draft: true },
      repository,
      sender: { login: 'dev' },
    };
    const res = handler.evaluateTrigger('pull_request', payload);

    expect(res.shouldTrigger).toBe(true);
    expect(res.parsedPayload?.triggerSource).toBe('draft_precheck');
    expect(res.parsedPayload?.isDraft).toBe(true);
  });

  it('evaluates issue_comment with @ct-review as comment_command trigger', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'created',
      issue: { number: 50, head: { sha: 'h' }, base: { sha: 'b' } },
      comment: { id: 700, body: '@ct-review review' },
      repository,
      sender: { login: 'reviewer' },
    };
    const res = handler.evaluateTrigger('issue_comment', payload);

    expect(res.shouldTrigger).toBe(true);
    expect(res.parsedPayload?.triggerSource).toBe('comment_command');
    expect(res.parsedPayload?.commandText).toBe('@ct-review review');
  });

  it('evaluates inline thread reply without bot mention as trigger', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'created',
      pull_request: { number: 55 },
      comment: { id: 701, in_reply_to_id: 600, body: 'Updated code per review' },
      repository,
      sender: { login: 'author' },
    };
    const res = handler.evaluateTrigger('pull_request_review_comment', payload);

    expect(res.shouldTrigger).toBe(true);
    expect(res.parsedPayload?.inReplyToId).toBe(600);
  });

  it('rejects issue_comment without bot mention or inline reply', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'created',
      issue: { number: 60 },
      comment: { id: 800, body: 'Just a regular comment' },
      sender: { login: 'anyone' },
    };
    const res = handler.evaluateTrigger('issue_comment', payload);

    expect(res.shouldTrigger).toBe(false);
    expect(res.reason).toContain('not bot review command');
  });

  it('returns shouldTrigger false for unsupported event type', () => {
    const handler = new GitHubEventHandler();
    const res = handler.evaluateTrigger('star', { action: 'created' });

    expect(res.shouldTrigger).toBe(false);
    expect(res.reason).toContain('Unsupported event type');
  });
});
