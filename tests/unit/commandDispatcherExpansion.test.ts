import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CommandDispatcher,
  parseCommand,
  dispatchCommand,
} from '../../src/chat/commandDispatcher';

describe('commandDispatcher.ts — Comprehensive Unit Expansion Tests', () => {
  let mockGithub: any;

  beforeEach(() => {
    mockGithub = {
      getReviewCommentThread: vi.fn().mockResolvedValue([]),
      getChangedFiles: vi.fn().mockResolvedValue([{ path: 'src/app.ts', patch: '+ const a = 1;' }]),
      postIssueComment: vi.fn().mockResolvedValue(undefined),
      replyToReviewComment: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('parseCommand correctly parses valid command strings', () => {
    expect(parseCommand('@ct-review review')).toEqual({ command: 'review', args: '', rawText: '@ct-review review' });
    expect(parseCommand('@ct-review explain how this works')).toEqual({ command: 'explain', args: 'how this works', rawText: '@ct-review explain how this works' });
    expect(parseCommand('@ct-review-bot refactor simplify function')).toEqual({ command: 'refactor', args: 'simplify function', rawText: '@ct-review-bot refactor simplify function' });
    expect(parseCommand('@bot summarize')).toEqual({ command: 'summarize', args: '', rawText: '@bot summarize' });
    expect(parseCommand('@ct-review ask what is the coverage?')).toEqual({ command: 'ask', args: 'what is the coverage?', rawText: '@ct-review ask what is the coverage?' });
  });

  it('parseCommand returns null for non-matching or null inputs', () => {
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(null as any)).toBeNull();
    expect(parseCommand('hello world')).toBeNull();
    expect(parseCommand('@ct-review invalidCommand')).toBeNull();
  });

  it('dispatchCommand throws error for unrecognized command string', async () => {
    const dispatcher = new CommandDispatcher();
    await expect(
      dispatcher.dispatchCommand('@ct-review invalid', {
        owner: 'owner',
        repo: 'repo',
        prNumber: 1,
        github: mockGithub,
      })
    ).rejects.toThrow('Unrecognized command format');
  });

  it('handleReview invokes onRunReviewPipeline when provided', async () => {
    const dispatcher = new CommandDispatcher();
    const mockRunPipeline = vi.fn().mockResolvedValue({ status: 'processed' });

    const result = await dispatcher.dispatchCommand('@ct-review review', {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 15,
      github: mockGithub,
      onRunReviewPipeline: mockRunPipeline,
      payload: { owner: 'calltelemetry', repo: 'ct-review-bot', prNumber: 15 },
    });

    expect(result.command).toBe('review');
    expect(result.success).toBe(true);
    expect(mockRunPipeline).toHaveBeenCalledWith({ owner: 'calltelemetry', repo: 'ct-review-bot', prNumber: 15 });
  });

  it('handleExplain posts explanation comment as issue comment when commentId omitted', async () => {
    const dispatcher = new CommandDispatcher();

    const result = await dispatcher.dispatchCommand('@ct-review explain this diff', {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 20,
      github: mockGithub,
    });

    expect(result.command).toBe('explain');
    expect(result.success).toBe(true);
    expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
      'calltelemetry',
      'ct-review-bot',
      20,
      expect.stringContaining('### Code Explanation')
    );
  });

  it('handleExplain replies to review comment thread when commentId is present', async () => {
    const dispatcher = new CommandDispatcher();
    mockGithub.getReviewCommentThread.mockResolvedValue([
      { user: { login: 'user1' }, body: 'What does this line do?', diff_hunk: '@@ -1,1 +1,1 @@\n+ const x = 5;' },
    ]);

    const result = await dispatcher.dispatchCommand('@ct-review explain', {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 20,
      commentId: 999,
      github: mockGithub,
    });

    expect(result.command).toBe('explain');
    expect(result.success).toBe(true);
    expect(mockGithub.replyToReviewComment).toHaveBeenCalledWith(
      'calltelemetry',
      'ct-review-bot',
      20,
      999,
      expect.stringContaining('### Code Explanation')
    );
  });

  it('handleRefactor appends suggestion block if missing in response output', async () => {
    const dispatcher = new CommandDispatcher();

    const result = await dispatcher.dispatchCommand('@ct-review refactor', {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 25,
      github: mockGithub,
    });

    expect(result.command).toBe('refactor');
    expect(result.success).toBe(true);
    expect(result.output).toContain('```suggestion');
  });

  it('handleSummarize posts PR summary with Mermaid diagram', async () => {
    const dispatcher = new CommandDispatcher();

    const result = await dispatcher.dispatchCommand('@ct-review summarize', {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 30,
      github: mockGithub,
    });

    expect(result.command).toBe('summarize');
    expect(result.success).toBe(true);
    expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
      'calltelemetry',
      'ct-review-bot',
      30,
      expect.stringContaining('## Updated PR Summary')
    );
  });

  it('handleAsk returns failure output when question argument is missing', async () => {
    const dispatcher = new CommandDispatcher();

    const result = await dispatcher.dispatchCommand('@ct-review ask', {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 35,
      github: mockGithub,
    });

    expect(result.command).toBe('ask');
    expect(result.success).toBe(false);
    expect(result.output).toContain('Please provide a question');
  });

  it('handleAsk answers developer question and posts comment', async () => {
    const dispatcher = new CommandDispatcher();

    const result = await dispatcher.dispatchCommand('@ct-review ask how does caching work?', {
      owner: 'calltelemetry',
      repo: 'ct-review-bot',
      prNumber: 35,
      github: mockGithub,
    });

    expect(result.command).toBe('ask');
    expect(result.success).toBe(true);
    expect(mockGithub.postIssueComment).toHaveBeenCalledWith(
      'calltelemetry',
      'ct-review-bot',
      35,
      expect.stringContaining('how does caching work?')
    );
  });
});
