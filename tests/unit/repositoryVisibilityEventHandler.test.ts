import { describe, it, expect } from 'vitest';
import { GitHubEventHandler } from '../../src/github/eventHandler';

// ct-meta#2884: the webhook `repository` object already carries `private`
// (boolean, always present) and sometimes `visibility` ('public' | 'private' |
// 'internal'). These tests prove GitHubEventHandler.evaluateTrigger extracts that
// fact onto `parsedPayload.repositoryVisibility` for every trigger source this
// handler parses, and degrades to 'UNKNOWN' -- never a guessed PUBLIC or PRIVATE
// -- when the webhook payload carries neither field.

describe('eventHandler.ts — repository visibility extraction', () => {
  it('extracts PRIVATE from repository.private=true on a pull_request event', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'opened',
      pull_request: { number: 1, head: { sha: 'h' }, base: { sha: 'b' }, title: 't', body: '', draft: false },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-meta', private: true },
      sender: { login: 'user' },
    };
    const result = handler.evaluateTrigger('pull_request', payload);
    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload?.repositoryVisibility).toBe('PRIVATE');
  });

  it('extracts PUBLIC from repository.private=false on a pull_request event', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'opened',
      pull_request: { number: 1, head: { sha: 'h' }, base: { sha: 'b' }, title: 't', body: '', draft: false },
      repository: { owner: { login: 'calltelemetry' }, name: 'calltelemetry', private: false },
      sender: { login: 'user' },
    };
    const result = handler.evaluateTrigger('pull_request', payload);
    expect(result.parsedPayload?.repositoryVisibility).toBe('PUBLIC');
  });

  it('prefers the string visibility field ("internal" -> PRIVATE) over the private boolean', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'opened',
      pull_request: { number: 1, head: { sha: 'h' }, base: { sha: 'b' }, title: 't', body: '', draft: false },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-meta', private: false, visibility: 'internal' },
      sender: { login: 'user' },
    };
    const result = handler.evaluateTrigger('pull_request', payload);
    expect(result.parsedPayload?.repositoryVisibility).toBe('PRIVATE');
  });

  it('degrades to UNKNOWN when the repository object carries neither field', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'opened',
      pull_request: { number: 1, head: { sha: 'h' }, base: { sha: 'b' }, title: 't', body: '', draft: false },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-meta' },
      sender: { login: 'user' },
    };
    const result = handler.evaluateTrigger('pull_request', payload);
    expect(result.parsedPayload?.repositoryVisibility).toBe('UNKNOWN');
  });

  it('degrades to UNKNOWN, and does not throw, when repository is entirely absent', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'opened',
      pull_request: { number: 1, head: { sha: 'h' }, base: { sha: 'b' }, title: 't', body: '', draft: false },
      // An explicit owner/repo keeps this test isolated from ambient
      // GITHUB_REPOSITORY* env vars; the only thing under test is that a missing
      // `repository` object degrades visibility to UNKNOWN without throwing.
      owner: 'calltelemetry',
      repo: 'ct-meta',
      sender: { login: 'user' },
    };
    expect(() => handler.evaluateTrigger('pull_request', payload)).not.toThrow();
    const result = handler.evaluateTrigger('pull_request', payload);
    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload?.repositoryVisibility).toBe('UNKNOWN');
  });

  it('extracts visibility on a pr_close_event (merged PR) payload', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'closed',
      pull_request: { number: 1, merged: true, head: { sha: 'h' }, base: { sha: 'b', ref: 'main' }, title: 't', body: '' },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-meta', private: true },
      sender: { login: 'user' },
    };
    const result = handler.evaluateTrigger('pull_request', payload);
    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload?.repositoryVisibility).toBe('PRIVATE');
  });

  it('extracts visibility on an issue_comment (bot mention) payload', () => {
    const handler = new GitHubEventHandler();
    const payload = {
      action: 'created',
      issue: { number: 1, head: { sha: 'h' }, base: { sha: 'b' }, title: 't', body: '' },
      comment: { id: 5, body: '@review-yeti please look again' },
      repository: { owner: { login: 'calltelemetry' }, name: 'ct-meta', private: true },
      sender: { login: 'user' },
    };
    const result = handler.evaluateTrigger('issue_comment', payload);
    expect(result.shouldTrigger).toBe(true);
    expect(result.parsedPayload?.repositoryVisibility).toBe('PRIVATE');
  });
});
