import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandDispatcher, parseCommand, ChatContext } from '../../src/chat/commandDispatcher';
import { PRMemoryStore } from '../../src/memory/prMemoryStore';

describe('commandDispatcher: @review-yeti remember & forget commands', () => {
  let dispatcher: CommandDispatcher;
  let mockGithub: any;
  let memoryStore: PRMemoryStore;
  let context: ChatContext;

  beforeEach(() => {
    dispatcher = new CommandDispatcher('openrouter/auto');
    memoryStore = new PRMemoryStore(':memory:');

    mockGithub = {
      replyToReviewComment: vi.fn().mockResolvedValue({ id: 103 }),
      postIssueComment: vi.fn().mockResolvedValue({ id: 201 }),
    };

    context = {
      owner: 'acme',
      repo: 'core-repo',
      prNumber: 42,
      github: mockGithub,
      memoryStore,
    };
  });

  it('parses remember and forget commands correctly', () => {
    const rememberCmd = parseCommand('@review-yeti remember convention: Wrap Membrane - Always use DynamicSupervisor');
    expect(rememberCmd).not.toBeNull();
    expect(rememberCmd?.command).toBe('remember');
    expect(rememberCmd?.args).toBe('convention: Wrap Membrane - Always use DynamicSupervisor');

    const forgetCmd = parseCommand('@review-yeti forget wrap membrane');
    expect(forgetCmd).not.toBeNull();
    expect(forgetCmd?.command).toBe('forget');
    expect(forgetCmd?.args).toBe('wrap membrane');
  });

  it('executes remember command and writes to memory store', async () => {
    const result = await dispatcher.dispatchCommand(
      '@review-yeti remember convention: Supervisor Rule - Supervise all gen servers',
      context
    );

    expect(result.success).toBe(true);
    expect(result.command).toBe('remember');
    expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
      'acme',
      'core-repo',
      42,
      expect.stringContaining('Team Memory Updated')
    );

    const learnings = await memoryStore.getLearnings('acme/core-repo');
    expect(learnings).toHaveLength(1);
    expect(learnings[0].title).toBe('Supervisor Rule');
  });

  it('executes forget command and removes matching pattern from memory store', async () => {
    await memoryStore.recordResolvedNit('acme/core-repo', 42, {
      pattern: 'avoid console.log in test scripts',
      filePath: '**',
      reason: 'Rule',
    });

    let nits = await memoryStore.getResolvedNits('acme/core-repo');
    expect(nits).toHaveLength(1);

    const result = await dispatcher.dispatchCommand(
      '@review-yeti forget console.log',
      context
    );

    expect(result.success).toBe(true);
    expect(result.command).toBe('forget');
    expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
      'acme',
      'core-repo',
      42,
      expect.stringContaining('Memory Removed')
    );

    nits = await memoryStore.getResolvedNits('acme/core-repo');
    expect(nits).toHaveLength(0);
  });
});
