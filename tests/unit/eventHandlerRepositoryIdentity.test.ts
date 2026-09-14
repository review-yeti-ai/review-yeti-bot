import { describe, expect, it } from 'vitest';
import { GitHubEventHandler } from '../../src/github/eventHandler';

const handler = new GitHubEventHandler();
function payload(id: unknown) {
  return { action: 'opened', repository: { id, owner: { login: 'example' }, name: 'service' },
    sender: { login: 'developer' }, installation: { id: 456 },
    pull_request: { number: 42, head: { sha: 'a'.repeat(40), repo: { id: 999 } },
      base: { sha: 'b'.repeat(40), repo: { id: 888 } } } };
}

describe('legacy webhook numeric repository identity', () => {
  it.each(['pull_request', 'issue_comment', 'pull_request_review_comment'])
  ('preserves the webhook target repository ID for %s, never the fork ID', (event) => {
    const input = { ...payload(123), comment: { id: 1, body: '@review-yeti review' } };
    const result = handler.evaluateTrigger(event, input, 'delivery-1');
    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload).toMatchObject({ repositoryId: 123, owner: 'example', repo: 'service' });
  });

  it('preserves repository identity for the merged-PR action', () => {
    const input = payload(123);
    const result = handler.evaluateTrigger('pull_request', { ...input, action: 'closed',
      pull_request: { ...input.pull_request, merged: true } });
    expect(result.parsedPayload).toMatchObject({ repositoryId: 123, triggerSource: 'pr_close_event' });
  });

  it.each([undefined, null, '123', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
  ('does not invent or coerce an invalid repository ID: %s', id => {
    const result = handler.evaluateTrigger('pull_request', { ...payload(id), repositoryId: 777 });
    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload).not.toHaveProperty('repositoryId');
  });
});
