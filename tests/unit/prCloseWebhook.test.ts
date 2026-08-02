import { describe, it, expect } from 'vitest';
import { GitHubEventHandler } from '../../src/github/eventHandler';

describe('PR Close Webhook Handling (pull_request.closed merged events)', () => {
  const handler = new GitHubEventHandler();

  it('evaluates pull_request.closed with merged: true as shouldTrigger true', () => {
    const payload = {
      action: 'closed',
      pull_request: {
        number: 42,
        title: 'feat: new awesome feature',
        body: 'Closes #10',
        merged: true,
        merged_at: '2026-07-25T12:00:00Z',
        head: { sha: 'head-sha-123' },
        base: { sha: 'base-sha-456', ref: 'main' },
      },
      repository: {
        owner: { login: 'calltelemetry' },
        name: 'ct-review-bot',
      },
      sender: { login: 'alice' },
      installation: { id: 12345 },
    };

    const result = handler.evaluateTrigger('pull_request', payload, 'deliv-abc-123');

    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toContain('PR closed and merged event');
    expect(result.parsedPayload).toBeDefined();
    expect(result.parsedPayload?.triggerSource).toBe('pr_close_event');
    expect(result.parsedPayload?.isMerged).toBe(true);
    expect(result.parsedPayload?.prNumber).toBe(42);
    expect(result.parsedPayload?.targetBranch).toBe('main');
  });

  it('evaluates pull_request.closed with merged: false as shouldTrigger false', () => {
    const payload = {
      action: 'closed',
      pull_request: {
        number: 43,
        title: 'wip: abandoned feature',
        merged: false,
        head: { sha: 'head-sha-123' },
        base: { sha: 'base-sha-456' },
      },
      repository: {
        owner: { login: 'calltelemetry' },
        name: 'ct-review-bot',
      },
      sender: { login: 'bob' },
    };

    const result = handler.evaluateTrigger('pull_request', payload, 'deliv-xyz-456');

    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toContain('PR is closed without being merged');
    expect(result.parsedPayload).toBeUndefined();
  });

  it('parses deliveryId and mergeCommitSha correctly', () => {
    const deliveryId = 'deliv-999-unique';
    const payload = {
      action: 'closed',
      pull_request: {
        number: 99,
        title: 'fix: critical patch',
        merged: true,
        head: { sha: 'commit-head-99' },
        base: { sha: 'commit-base-99', ref: 'production' },
      },
      repository: {
        owner: { login: 'calltelemetry' },
        name: 'ct-review-bot',
      },
      sender: { login: 'charlie' },
    };

    const result = handler.evaluateTrigger('pull_request', payload, deliveryId);

    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload?.deliveryId).toBe(deliveryId);
    expect(result.parsedPayload?.headSha).toBe('commit-head-99');
    expect(result.parsedPayload?.baseSha).toBe('commit-base-99');
  });

  it('filters out bot actions on PR close', () => {
    const payloadBot = {
      action: 'closed',
      pull_request: {
        number: 50,
        merged: true,
      },
      sender: { login: 'ct-review-bot' },
    };

    const resultBot = handler.evaluateTrigger('pull_request', payloadBot, 'deliv-bot-1');
    expect(resultBot.shouldTrigger).toBe(false);
    expect(resultBot.reason).toContain('Ignored bot action from sender: ct-review-bot');

    const payloadGithubBot = {
      action: 'closed',
      pull_request: {
        number: 51,
        merged: true,
      },
      sender: { login: 'dependabot[bot]' },
    };

    const resultGithubBot = handler.evaluateTrigger('pull_request', payloadGithubBot, 'deliv-bot-2');
    expect(resultGithubBot.shouldTrigger).toBe(false);
    expect(resultGithubBot.reason).toContain('Ignored bot action from sender: dependabot[bot]');
  });

  it('differentiates PR close from PR opened/synchronize triggers', () => {
    const openedPayload = {
      action: 'opened',
      pull_request: {
        number: 60,
        state: 'open',
        head: { sha: 'sha-opened-1' },
        base: { sha: 'sha-opened-0' },
      },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      sender: { login: 'dev1' },
    };

    const closedPayload = {
      action: 'closed',
      pull_request: {
        number: 60,
        state: 'closed',
        merged: true,
        head: { sha: 'sha-opened-1' },
        base: { sha: 'sha-opened-0' },
      },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      sender: { login: 'dev1' },
    };

    const resOpened = handler.evaluateTrigger('pull_request', openedPayload, 'd1');
    const resClosed = handler.evaluateTrigger('pull_request', closedPayload, 'd2');

    expect(resOpened.shouldTrigger).toBe(true);
    expect(resOpened.parsedPayload?.triggerSource).toBe('pr_event');

    expect(resClosed.shouldTrigger).toBe(true);
    expect(resClosed.parsedPayload?.triggerSource).toBe('pr_close_event');
  });

  it('handles missing repository or payload fields gracefully on close', () => {
    const minimalPayload = {
      action: 'closed',
      pull_request: {
        merged: true,
      },
    };

    const result = handler.evaluateTrigger('pull_request', minimalPayload, 'deliv-minimal');

    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toContain('Missing owner or repo');
    expect(result.parsedPayload).toBeUndefined();
  });
});
