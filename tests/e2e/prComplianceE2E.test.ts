import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GitHubEventHandler } from '../../src/github/eventHandler';
import { ReviewRunStore } from '../../src/persistence/reviewRunStore';

describe('End-to-End PR Compliance Checks & Webhook Pipeline Lifecycle', () => {
  let eventHandler: GitHubEventHandler;
  let store: ReviewRunStore;

  beforeAll(() => {
    process.env.WEBHOOK_SECRET = 'test-secret';
  });

  beforeEach(() => {
    eventHandler = new GitHubEventHandler();
    const cacheDir = path.resolve(__dirname, '../../node_modules/.cache/e2e-tests');
    fs.mkdirSync(cacheDir, { recursive: true });
    store = new ReviewRunStore(path.join(cacheDir, `e2e-store-${Date.now()}-${Math.random().toString(36).slice(2)}.json`));
  });

  it('evaluates pull_request.opened event and parses valid PR payload', () => {
    const payload = {
      action: 'opened',
      number: 101,
      installation: { id: 98765 },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      pull_request: {
        number: 101,
        head: { sha: 'head-sha-101' },
        base: { sha: 'base-sha-101' },
        title: 'Feature: Add live model router',
        body: 'Implements dynamic provider registration.',
        draft: false,
        labels: [],
      },
      sender: { login: 'developer-jane' },
    };

    const result = eventHandler.evaluateTrigger('pull_request', payload, 'delivery-uuid-101');

    expect(result.shouldTrigger).toBe(true);
    expect(result.reason).toContain('PR opened event triggered review');
    expect(result.parsedPayload).toBeDefined();
    expect(result.parsedPayload?.installationId).toBe('98765');
    expect(result.parsedPayload?.owner).toBe('calltelemetry');
    expect(result.parsedPayload?.repo).toBe('ct-review-bot');
    expect(result.parsedPayload?.prNumber).toBe(101);
    expect(result.parsedPayload?.headSha).toBe('head-sha-101');
    expect(result.parsedPayload?.baseSha).toBe('base-sha-101');
    expect(result.parsedPayload?.triggerSource).toBe('pr_event');
    expect(result.parsedPayload?.deliveryId).toBe('delivery-uuid-101');
  });

  it('evaluates pull_request.synchronize event for push to existing PR', () => {
    const payload = {
      action: 'synchronize',
      number: 102,
      installation: { id: 98765 },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      pull_request: {
        number: 102,
        head: { sha: 'head-sha-102-v2' },
        base: { sha: 'base-sha-102' },
        title: 'Refactor: Update provider pool',
        body: 'Updated pool implementation.',
        draft: false,
        labels: [],
      },
      sender: { login: 'developer-john' },
    };

    const result = eventHandler.evaluateTrigger('pull_request', payload, 'delivery-uuid-102');

    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload?.triggerAction).toBe('synchronize');
    expect(result.parsedPayload?.headSha).toBe('head-sha-102-v2');
  });

  it('handles draft PR precheck evaluation', () => {
    const payload = {
      action: 'opened',
      number: 103,
      installation: { id: 98765 },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      pull_request: {
        number: 103,
        head: { sha: 'head-sha-103' },
        base: { sha: 'base-sha-103' },
        title: 'WIP: Draft PR',
        body: 'Work in progress',
        draft: true,
        labels: [],
      },
      sender: { login: 'developer-jane' },
    };

    const result = eventHandler.evaluateTrigger('pull_request', payload, 'delivery-uuid-103');

    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload?.triggerSource).toBe('draft_precheck');
    expect(result.parsedPayload?.isDraft).toBe(true);
  });

  it('ignores closed PR events', () => {
    const payload = {
      action: 'closed',
      number: 104,
      pull_request: { state: 'closed' },
      sender: { login: 'developer-jane' },
    };

    const result = eventHandler.evaluateTrigger('pull_request', payload, 'delivery-uuid-104');

    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toContain('PR is closed');
  });

  it('ignores actions triggered by bot senders to prevent infinite loops', () => {
    const payload = {
      action: 'opened',
      number: 105,
      pull_request: { number: 105, head: { sha: 'sha' } },
      sender: { login: 'ct-review-bot[bot]' },
    };

    const result = eventHandler.evaluateTrigger('pull_request', payload, 'delivery-uuid-105');

    expect(result.shouldTrigger).toBe(false);
    expect(result.reason).toContain('Ignored bot action');
  });

  it('evaluates issue_comment.created event with @ct-review command', () => {
    const payload = {
      action: 'created',
      installation: { id: 98765 },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-review-bot' },
      issue: {
        number: 201,
        title: 'PR Title',
        head: { sha: 'head-201' },
        base: { sha: 'base-201' },
      },
      comment: {
        id: 555123,
        body: '@ct-review review please check security boundaries',
      },
      sender: { login: 'reviewer-alice' },
    };

    const result = eventHandler.evaluateTrigger('issue_comment', payload, 'delivery-comment-201');

    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload?.triggerSource).toBe('comment_command');
    expect(result.parsedPayload?.commandText).toContain('@ct-review review');
    expect(result.parsedPayload?.commentId).toBe(555123);
  });

  it('deduplicates webhook deliveries using ReviewRunStore.claimDelivery', () => {
    const deliveryId = 'unique-delivery-uuid-999';

    const firstClaim = store.claimDelivery(deliveryId);
    expect(firstClaim).toBe(true);

    const secondClaim = store.claimDelivery(deliveryId);
    expect(secondClaim).toBe(false);
  });

  it('tracks head SHA updates and detects current vs stale head in ReviewRunStore', () => {
    const owner = 'calltelemetry';
    const repo = 'ct-review-bot';
    const prNumber = 301;

    store.markHead(owner, repo, prNumber, 'sha-v1');
    expect(store.isCurrentHead(owner, repo, prNumber, 'sha-v1')).toBe(true);
    expect(store.isCurrentHead(owner, repo, prNumber, 'sha-v2')).toBe(false);

    store.markHead(owner, repo, prNumber, 'sha-v2');
    expect(store.isCurrentHead(owner, repo, prNumber, 'sha-v2')).toBe(true);
    expect(store.getPreviousHead(owner, repo, prNumber)).toBe('sha-v1');
  });

  it('filters resolved nit comments so resolved threads are not re-posted', () => {
    const prNumber = 401;
    const findings = [
      { filePath: 'src/app.ts', lineNumber: 25, title: 'Typo in variable name' },
      { filePath: 'src/config.ts', lineNumber: 10, title: 'Missing explicit return type' },
    ];

    // Record threads and mark one resolved
    store.recordThread(prNumber, 'src/app.ts', 25, 'Typo in variable name', 'RESOLVED');

    const filtered = store.filterResolvedNits(prNumber, findings);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].filePath).toBe('src/config.ts');
  });
});
